-- 1. Habilitar a extensão pgvector para permitir Busca Semântica
create extension if not exists vector;

-- 2. Recriar a tabela com o novo modelo unificado
drop table if exists acordaos;

create table acordaos (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  identificador_unico text NOT NULL UNIQUE, -- Ex: "TCU-AC-1234-2023"
  tribunal text NOT NULL,
  numero_acordao text NOT NULL,
  ano integer NOT NULL,
  data_sessao date NOT NULL,
  tema text NOT NULL, -- Restrito aos temas definidos no prompt
  subtema text,
  resumo_pratico text NOT NULL, -- Ementa ou trecho resumido gerado
  palavras_chave text[] DEFAULT '{}',
  link_oficial text NOT NULL,
  link_pdf text,
  
  -- Coluna mágica: Armazena a representação matemática do resumo (768 dimensões do Gemini)
  embedding vector(768),

  -- Cache da análise jurídica do Nemotron por trecho consultado.
  -- Estrutura: { "<sha256(trecho)>": {"aderencia_pct": int, "justificativa": str, "pontos_chave": [str], "gerado_em": iso8601} }
  analise_cache jsonb DEFAULT '{}'::jsonb,

  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Migração não-destrutiva (caso a tabela já exista de uma execução anterior do schema)
alter table acordaos add column if not exists analise_cache jsonb default '{}'::jsonb;

-- 3. Habilitar Segurança de Leitura
alter table acordaos enable row level security;
create policy "Permitir leitura pública" on acordaos for select using (true);

-- 4. Função de Busca por Contexto (RPC)
-- Esta função recebe um vetor (da busca do usuário) e calcula a Similaridade de Cosseno (<=>)
create or replace function match_acordaos (
  query_embedding vector(768),
  match_threshold float,
  match_count int
)
returns table (
  id uuid,
  identificador_unico text,
  tribunal text,
  numero_acordao text,
  ano integer,
  data_sessao date,
  tema text,
  subtema text,
  resumo_pratico text,
  palavras_chave text[],
  link_oficial text,
  link_pdf text,
  similarity float
)
language sql stable
as $$
  select
    acordaos.id,
    acordaos.identificador_unico,
    acordaos.tribunal,
    acordaos.numero_acordao,
    acordaos.ano,
    acordaos.data_sessao,
    acordaos.tema,
    acordaos.subtema,
    acordaos.resumo_pratico,
    acordaos.palavras_chave,
    acordaos.link_oficial,
    acordaos.link_pdf,
    1 - (acordaos.embedding <=> query_embedding) as similarity
  from acordaos
  where 1 - (acordaos.embedding <=> query_embedding) > match_threshold
  order by similarity desc
  limit match_count;
$$;
