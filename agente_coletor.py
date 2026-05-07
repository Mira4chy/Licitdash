"""Coletor diário do LiciDash.

Roda via GitHub Actions todo dia às 06:00 UTC. Busca os acórdãos do TCU
publicados no dia anterior, processa com Gemini (resumo + embedding) e
insere no Supabase. É idempotente: acórdãos já presentes são pulados.
"""
import json
import os
import re
import time
from datetime import datetime

from dotenv import load_dotenv
from google import genai
from supabase import Client, create_client

from tcu_client import (
    acordao_ja_existe,
    buscar_acordaos_tcu,
    data_ontem_brasilia,
    filtrar_por_data,
    formatar_data,
)

# ==========================================
# CONFIGURAÇÕES
# ==========================================
# A API do TCU não filtra por data — pegamos um lote suficiente para cobrir
# todas as decisões de ontem (TCU costuma publicar < 100 por dia).
TCU_LOOKBACK_BATCH = 300
DELAY_ENTRE_REQUISICOES_SEGUNDOS = 4
MAX_REQUISICOES_POR_EXECUCAO = 50  # margem do free tier Gemini (1500 RPD)

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

supabase: Client = (
    create_client(SUPABASE_URL, SUPABASE_KEY) if SUPABASE_URL and SUPABASE_KEY else None
)
client = genai.Client(api_key=GEMINI_API_KEY) if GEMINI_API_KEY else None

TEMAS_PERMITIDOS = [
    "Lei 14.133/2021", "pregão", "dispensa", "inexigibilidade", "habilitação",
    "qualificação técnica", "pesquisa de preços", "orçamento estimativo",
    "sobrepreço", "superfaturamento", "execução contratual", "aditivos",
    "sanções", "SRP", "matriz de riscos", "ETP", "termo de referência",
]


def processar_com_gemini(ementa_bruta, max_tentativas_rpm=3):
    """Gera resumo + embedding 768D para uma ementa.

    Retorna tupla (resumo, subtema, tags, tema, embedding) ou None se falhar.
    """
    if not client:
        return None

    temas_str = ", ".join(f"'{t}'" for t in TEMAS_PERMITIDOS)
    prompt = f"""
    Como advogado especialista em Licitações, leia a ementa abaixo e retorne APENAS um JSON válido.
    1. 'tema': Escolha ESTRITAMENTE uma opção desta lista: [{temas_str}]. Se não encaixar, escolha a mais próxima.
    2. 'subtema': Subtema específico, string curta (ou null).
    3. 'resumo_pratico': Resumo de 3 linhas com a aplicação no dia a dia.
    4. 'palavras_chave': 2 a 4 tags temáticas (array de strings).
    Ementa: "{ementa_bruta}"
    """

    for tentativa in range(1, max_tentativas_rpm + 1):
        try:
            response = client.models.generate_content(
                model="gemini-2.5-flash-lite",
                contents=prompt,
            )
            if not response.text:
                raise ValueError("Resposta vazia da IA")
            clean_text = response.text.replace("```json", "").replace("```", "").strip()
            data = json.loads(clean_text)

            resumo = data.get("resumo_pratico", "Resumo não gerado.")
            subtema = data.get("subtema")
            tags = data.get("palavras_chave", [])
            tema = data.get("tema", TEMAS_PERMITIDOS[0])

            embed = client.models.embed_content(
                model="gemini-embedding-2",
                contents=resumo + " " + ementa_bruta,
                config={"output_dimensionality": 768},
            )
            embedding = embed.embeddings[0].values
            return resumo, subtema, tags, tema, embedding

        except Exception as e:
            error_str = str(e)
            if "429" in error_str:
                if "PerDay" in error_str:
                    print("    -> Quota diária Gemini esgotada. Encerrando run.")
                    return "QUOTA_DIARIA_ESGOTADA"
                match = re.search(r"retryDelay':\s*'([\d.]+)s", error_str)
                espera = int(float(match.group(1))) + 5 if match else 30
                if tentativa < max_tentativas_rpm:
                    print(f"    -> Rate limit RPM. Aguardando {espera}s...")
                    time.sleep(espera)
                    continue
            print(f"    -> Erro IA: {e}")
            return None
    return None


def salvar_no_supabase(decisao):
    if not supabase:
        return False
    try:
        supabase.table("acordaos").insert(decisao).execute()
        return True
    except Exception as e:
        if "duplicate key" in str(e).lower() or "23505" in str(e):
            return "DUPLICADO"
        print(f"    -> Erro Supabase: {e}")
        return False


def main():
    data_alvo = data_ontem_brasilia()
    print("========================================")
    print(" LiciDash - Coletor Diário")
    print(f" Data alvo (DD/MM/YYYY): {data_alvo}")
    print(f" Buscando últimos {TCU_LOOKBACK_BATCH} acórdãos da API TCU...")
    print("========================================")

    if not (supabase and client):
        print("[!] Variáveis de ambiente faltando. Configure SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY.")
        return

    acordaos_brutos = buscar_acordaos_tcu(0, TCU_LOOKBACK_BATCH)
    if not acordaos_brutos:
        print("[!] Falha ao buscar acórdãos do TCU.")
        return

    acordaos_dia = filtrar_por_data(acordaos_brutos, data_alvo)
    print(f"[*] {len(acordaos_brutos)} recebidos | {len(acordaos_dia)} são de {data_alvo}")

    if not acordaos_dia:
        print("[*] Nenhum acórdão novo para esta data. Encerrando.")
        return

    inseridos = 0
    pulados = 0
    requisicoes = 0

    for dec in acordaos_dia:
        if requisicoes >= MAX_REQUISICOES_POR_EXECUCAO:
            print(f"[!] Limite por execução ({MAX_REQUISICOES_POR_EXECUCAO}) atingido.")
            break

        numero = str(dec.get("numeroAcordao", ""))
        ano = dec.get("anoAcordao")
        identificador = f"TCU-AC-{numero}-{ano}"

        if acordao_ja_existe(supabase, numero, ano):
            pulados += 1
            print(f"    -> {identificador} já existe. Pulando.")
            continue

        ementa = (dec.get("sumario") or "").strip()
        data_formatada = formatar_data(dec.get("dataSessao", ""))
        if not ementa or not data_formatada:
            print(f"    -> Dados incompletos para {identificador}. Pulando.")
            continue

        print(f"\n[*] Processando: {identificador}")
        resultado = processar_com_gemini(ementa)
        requisicoes += 1

        if resultado == "QUOTA_DIARIA_ESGOTADA":
            break
        if not resultado:
            continue

        resumo, subtema, tags, tema, embedding = resultado
        if not embedding:
            continue

        link_oficial = (
            dec.get("urlAcordao") or "https://pesquisa.apps.tcu.gov.br/resultado/acordao-completo"
        )

        decisao = {
            "identificador_unico": identificador,
            "tribunal": "TCU",
            "numero_acordao": numero,
            "ano": int(ano),
            "data_sessao": data_formatada,
            "tema": tema,
            "subtema": subtema,
            "resumo_pratico": resumo,
            "palavras_chave": tags,
            "link_oficial": link_oficial,
            "link_pdf": dec.get("urlArquivoPdf"),
            "embedding": embedding,
        }

        status = salvar_no_supabase(decisao)
        if status is True:
            inseridos += 1
            print(f"    -> [+] Salvo.")
        elif status == "DUPLICADO":
            pulados += 1

        time.sleep(DELAY_ENTRE_REQUISICOES_SEGUNDOS)

    print("\n========================================")
    print(f" Resumo:")
    print(f"   Processados: {requisicoes}")
    print(f"   Inseridos:   {inseridos}")
    print(f"   Já existiam: {pulados}")
    print("========================================")


if __name__ == "__main__":
    main()
