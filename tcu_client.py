"""Cliente compartilhado para a API pública de Acórdãos do TCU.

Usado tanto pela carga histórica quanto pelo coletor diário.
"""
import time
from datetime import datetime, timedelta

import requests

TCU_API_URL = (
    "https://dados-abertos.apps.tcu.gov.br/api/acordao/recupera-acordaos"
)


def buscar_acordaos_tcu(inicio, quantidade, max_tentativas=3):
    url = f"{TCU_API_URL}?inicio={inicio}&quantidade={quantidade}"
    for tentativa in range(1, max_tentativas + 1):
        try:
            resp = requests.get(url, timeout=60)
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            print(f"[-] Erro TCU (offset={inicio}, tentativa {tentativa}/{max_tentativas}): {e}")
            if tentativa < max_tentativas:
                time.sleep(10)
    return None


def formatar_data(data_str):
    """Converte DD/MM/YYYY para YYYY-MM-DD."""
    try:
        return datetime.strptime(data_str, "%d/%m/%Y").strftime("%Y-%m-%d")
    except Exception:
        return None


def data_ontem_brasilia():
    """Retorna a data de ontem no formato DD/MM/YYYY (padrão da API TCU)."""
    return (datetime.utcnow() - timedelta(days=1)).strftime("%d/%m/%Y")


def filtrar_por_data(acordaos, data_alvo_ddmmyyyy):
    """Filtra a lista mantendo só acórdãos com dataSessao == data alvo (DD/MM/YYYY)."""
    return [a for a in acordaos if (a.get("dataSessao") or "").strip() == data_alvo_ddmmyyyy]


def acordao_ja_existe(supabase, numero, ano):
    """True se já há um acórdão com esse identificador no banco."""
    if not supabase:
        return False
    identificador = f"TCU-AC-{numero}-{ano}"
    try:
        resp = (
            supabase.table("acordaos")
            .select("id", count="exact")
            .eq("identificador_unico", identificador)
            .limit(1)
            .execute()
        )
        return bool(resp.data)
    except Exception as e:
        print(f"[-] Erro ao checar duplicidade de {identificador}: {e}")
        return False
