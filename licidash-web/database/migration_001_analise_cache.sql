-- Migration 001: cache de análise jurídica do Nemotron por acórdão.
--
-- Aplicar UMA vez no Supabase SQL editor.
-- Seguro: usa "if not exists", não derruba a tabela nem afeta os dados existentes.
--
-- Estrutura do JSONB:
--   { "<sha256(trecho_usuario)>": {
--       "aderencia_pct": int (0-100),
--       "justificativa": text,
--       "pontos_chave": [text],
--       "gerado_em": ISO 8601 timestamp
--     }
--   }

alter table acordaos
  add column if not exists analise_cache jsonb default '{}'::jsonb;
