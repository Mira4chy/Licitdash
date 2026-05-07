import os
import re
import json
import time
from datetime import datetime
from dotenv import load_dotenv
from supabase import create_client, Client
from google import genai

from tcu_client import buscar_acordaos_tcu, formatar_data

# ==========================================
# CONFIGURAÇÕES DE CARGA HISTÓRICA
# ==========================================
# GEMINI_API_KEYS no .env aceita múltiplas chaves separadas por vírgula.
# Cada chave tem ~20 RPD no free tier → N chaves = N×18 decisões/dia.
# Ex: GEMINI_API_KEYS=chave1,chave2,chave3
DELAY_ENTRE_REQUISICOES_SEGUNDOS = 4  # Pausa entre chamadas para evitar erros de RPM
ANOS_ALVO = set(range(2022, 2027))    # 2022 a 2026 inclusive
TCU_BATCH_SIZE = 50                   # Decisões buscadas por chamada à API do TCU
STATE_FILE = 'carga_estado.json'

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

# Carrega múltiplas chaves: GEMINI_API_KEYS tem prioridade; GEMINI_API_KEY como fallback
_keys_raw = os.getenv("GEMINI_API_KEYS") or os.getenv("GEMINI_API_KEY", "")
API_KEYS = [k.strip() for k in _keys_raw.split(",") if k.strip()]
CLIENTS = [genai.Client(api_key=k) for k in API_KEYS]
MAX_REQUISICOES_POR_EXECUCAO = 18 * len(CLIENTS)  # 18 por chave (margem abaixo do limite de 20 RPD)

# Índice da chave ativa — avança automaticamente quando a quota diária é atingida
_chave_idx = 0

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY) if SUPABASE_URL and SUPABASE_KEY else None


def get_client():
    return CLIENTS[_chave_idx] if _chave_idx < len(CLIENTS) else None


def girar_chave():
    global _chave_idx
    _chave_idx += 1
    if _chave_idx < len(CLIENTS):
        print(f"\n[*] Chave {_chave_idx} esgotada -> trocando para chave {_chave_idx + 1}/{len(CLIENTS)}...")
        return True
    print(f"\n[-] Todas as {len(CLIENTS)} chave(s) esgotaram a quota diária.")
    return False

TEMAS_PERMITIDOS = [
    "Lei 14.133/2021", "pregão", "dispensa", "inexigibilidade", "habilitação",
    "qualificação técnica", "pesquisa de preços", "orçamento estimativo",
    "sobrepreço", "superfaturamento", "execução contratual", "aditivos",
    "sanções", "SRP", "matriz de riscos", "ETP", "termo de referência"
]


def carregar_estado():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE, 'r') as f:
            return json.load(f)
    return {'proximo_inicio': 0, 'concluido': False}


def salvar_estado(estado):
    with open(STATE_FILE, 'w') as f:
        json.dump(estado, f, indent=2)


def processo_gemini(ementa_bruta, max_tentativas_rpm=3):
    if not get_client():
        return "Configure GEMINI_API_KEYS no .env.", None, ["Sem_IA"], None, None

    temas_str = ", ".join(f"'{t}'" for t in TEMAS_PERMITIDOS)

    prompt = f"""
    Como advogado especialista em Licitações, leia a ementa abaixo e retorne APENAS um JSON válido.
    1. 'tema': Escolha ESTRITAMENTE uma opção desta lista: [{temas_str}]. Se não encaixar, escolha a mais próxima.
    2. 'subtema': Subtema específico, string curta (ou null).
    3. 'resumo_pratico': Resumo de 3 linhas com a aplicação no dia a dia.
    4. 'palavras_chave': 2 a 4 tags temáticas (array de strings).
    Ementa: "{ementa_bruta}"
    """

    # Loop externo: repete ao trocar de chave
    while get_client() is not None:
        rotacionar = False
        for tentativa in range(1, max_tentativas_rpm + 1):
            c = get_client()
            try:
                response = c.models.generate_content(
                    model='gemini-2.5-flash-lite',
                    contents=prompt,
                )
                if not response.text:
                    raise ValueError("Resposta vazia da IA")
                clean_text = response.text.replace('```json', '').replace('```', '').strip()
                data = json.loads(clean_text)

                resumo = data.get("resumo_pratico", "Resumo não gerado.")
                subtema = data.get("subtema")
                tags = data.get("palavras_chave", [])
                tema = data.get("tema", TEMAS_PERMITIDOS[0])

                embed_response = c.models.embed_content(
                    model='gemini-embedding-2',
                    contents=resumo + " " + ementa_bruta,
                    config={'output_dimensionality': 768}
                )
                embedding = embed_response.embeddings[0].values

                return resumo, subtema, tags, tema, embedding

            except Exception as e:
                error_str = str(e)
                if '429' in error_str:
                    if 'PerDay' in error_str or 'GenerateRequestsPerDay' in error_str:
                        print(f"    -> Quota diária da chave {_chave_idx + 1} esgotada.")
                        rotacionar = True
                        break  # sai do loop de tentativas, gira a chave
                    match = re.search(r"retryDelay':\s*'([\d.]+)s", error_str)
                    espera = int(float(match.group(1))) + 5 if match else 30
                    if tentativa < max_tentativas_rpm:
                        print(f"    -> Rate limit RPM. Aguardando {espera}s (tentativa {tentativa}/{max_tentativas_rpm})...")
                        time.sleep(espera)
                        continue
            print(f"    -> Erro IA: {e}")
            return "Erro IA.", None, ["Erro"], TEMAS_PERMITIDOS[0], None

        # Sai do for: ou rotacionar=True (PerDay) ou todos os RPM retries esgotados
        if rotacionar:
            if not girar_chave():
                return "QUOTA_DIARIA_ESGOTADA", None, [], None, None
            # Continua o while com o novo cliente

    # Chegou aqui: todos os clientes esgotados
    return "QUOTA_DIARIA_ESGOTADA", None, [], None, None


def salvar_supabase(decisao):
    if not supabase:
        return False
    try:
        supabase.table('acordaos').insert(decisao).execute()
        return True
    except Exception as e:
        if 'duplicate key' in str(e).lower() or '23505' in str(e):
            return "DUPLICADO"
        print(f"    -> Erro ao salvar: {e}")
        return False


def main():
    estado = carregar_estado()

    if estado.get('concluido'):
        print("========================================")
        print(" Carga histórica já concluída!")
        print(f" Delete '{STATE_FILE}' para reiniciar do zero.")
        print("========================================")
        return

    print("========================================")
    print(" LiciDash - Módulo de CARGA HISTÓRICA")
    print(f" Anos alvo: {min(ANOS_ALVO)} a {max(ANOS_ALVO)}")
    print(f" Limite deste lote: {MAX_REQUISICOES_POR_EXECUCAO} decisões com IA")
    print(f" Retomando do offset TCU: {estado['proximo_inicio']}")
    print("========================================")

    proximo_inicio = estado['proximo_inicio']
    requisicoes_feitas = 0
    inseridos = 0
    pulados = 0
    quota_diaria_esgotada = False

    while requisicoes_feitas < MAX_REQUISICOES_POR_EXECUCAO and not quota_diaria_esgotada:
        print(f"\n[*] Buscando do TCU (offset={proximo_inicio}, lote={TCU_BATCH_SIZE})...")
        acordaos_brutos = buscar_acordaos_tcu(proximo_inicio, TCU_BATCH_SIZE)

        if acordaos_brutos is None:
            print("[!] Falha de rede ao acessar TCU. Progresso salvo — rode novamente para continuar.")
            break

        if len(acordaos_brutos) == 0:
            print("[!] API do TCU não retornou mais resultados. Carga concluída!")
            estado['concluido'] = True
            break

        # A API retorna do mais recente ao mais antigo.
        # Se todos os acórdãos do lote forem anteriores ao ano mínimo, encerramos.
        anos_no_lote = [int(a.get('anoAcordao', 0)) for a in acordaos_brutos]
        if max(anos_no_lote) < min(ANOS_ALVO):
            print(f"[!] Lote contém apenas acórdãos anteriores a {min(ANOS_ALVO)}. Carga concluída!")
            estado['concluido'] = True
            break

        acordaos_alvo = [a for a in acordaos_brutos if int(a.get('anoAcordao', 0)) in ANOS_ALVO]
        print(f"    -> {len(acordaos_brutos)} recebidos | {len(acordaos_alvo)} dentro dos anos {min(ANOS_ALVO)}-{max(ANOS_ALVO)}")

        for dec in acordaos_alvo:
            if requisicoes_feitas >= MAX_REQUISICOES_POR_EXECUCAO:
                print(f"\n[!] LOTE DIÁRIO CONCLUÍDO ({MAX_REQUISICOES_POR_EXECUCAO} processados). Rode amanhã para continuar.")
                break

            identificador = f"TCU-AC-{dec['numeroAcordao']}-{dec['anoAcordao']}"
            data_formatada = formatar_data(dec.get('dataSessao', ''))
            ementa_bruta = (dec.get('sumario') or '').strip()

            if not data_formatada or not ementa_bruta:
                print(f"    -> Dados incompletos para {identificador}. Pulando.")
                continue

            print(f"\n[*] Processando: {identificador} ({dec.get('dataSessao', '?')})...")

            resumo, subtema, tags, tema, embedding = processo_gemini(ementa_bruta)
            requisicoes_feitas += 1

            if resumo == "QUOTA_DIARIA_ESGOTADA":
                print(f"[!] Quota diária de IA esgotada. Progresso salvo — rode amanhã para continuar.")
                quota_diaria_esgotada = True
                break

            if not embedding:
                print(f"    -> Sem embedding gerado. Pulando salvamento.")
                continue

            link_oficial = dec.get('urlAcordao') or "https://pesquisa.apps.tcu.gov.br/resultado/acordao-completo"

            decisao_pronta = {
                "identificador_unico": identificador,
                "tribunal": "TCU",
                "numero_acordao": str(dec['numeroAcordao']),
                "ano": int(dec['anoAcordao']),
                "data_sessao": data_formatada,
                "tema": tema,
                "subtema": subtema,
                "resumo_pratico": resumo,
                "palavras_chave": tags,
                "link_oficial": link_oficial,
                "link_pdf": dec.get('urlArquivoPdf'),
                "embedding": embedding
            }

            status = salvar_supabase(decisao_pronta)
            if status is True:
                inseridos += 1
                print(f"    -> [+] Salvo no banco.")
            elif status == "DUPLICADO":
                pulados += 1
                print(f"    -> Já processado anteriormente. Ignorando.")

            if requisicoes_feitas < MAX_REQUISICOES_POR_EXECUCAO:
                time.sleep(DELAY_ENTRE_REQUISICOES_SEGUNDOS)

        proximo_inicio += TCU_BATCH_SIZE
        estado['proximo_inicio'] = proximo_inicio
        salvar_estado(estado)

    salvar_estado(estado)

    print("\n========================================")
    print(f" Resumo do Lote:")
    print(f" Processados neste lote: {requisicoes_feitas}")
    print(f" Inseridos com sucesso:  {inseridos}")
    print(f" Ignorados (já existiam): {pulados}")
    if not estado.get('concluido'):
        print(f" Próximo offset salvo: {estado['proximo_inicio']} (rode novamente amanhã para continuar)")
    else:
        print(f" Status: CARGA CONCLUÍDA")
    print("========================================")


if __name__ == "__main__":
    main()
