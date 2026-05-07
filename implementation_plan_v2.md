# Refatoração: Pesquisa Semântica (Contextual) e Novo Modelo de Dados

O objetivo desta refatoração é transformar o LiciDash de um simples "feed" para um verdadeiro **Buscador Semântico Avançado**. O usuário poderá colar a peça jurídica dele, e o sistema entenderá o *contexto* e buscará decisões análogas, além de adequar todo o modelo de dados para o padrão exigido.

## User Review Required

> [!WARNING]
> **Arquitetura de Pesquisa Semântica (Embeddings)**
> Para que a pesquisa entenda "contexto", precisamos transformar os textos em "Vetores Matemáticos" usando a API do Gemini e o **pgvector** do Supabase. 
> Como o frontend (Vite/React) vai precisar transformar o texto da busca do usuário em um vetor antes de pesquisar no banco, precisaremos colocar a sua **Chave do Gemini no Frontend**.
> Se o aplicativo for de **uso interno/privado**, isso não tem problema. Se for público, a chave pode vazar. Concorda em usar a chave no frontend por enquanto para manter o custo zero e simplicidade, ou prefere que eu desenhe uma *Edge Function* no Supabase? (Recomendo uso direto no frontend para começar rápido).

## Proposed Changes

### 1. Novo Schema do Banco de Dados (Supabase)
Precisaremos habilitar a extensão de Inteligência Artificial no Supabase e refazer a tabela:
- Ativar a extensão `pgvector`.
- Recriar a tabela `acordaos` com os novos campos exatos: `identificador_unico`, `tribunal`, `numero_acordao`, `ano`, `data_sessao`, `tema` (restrito à lista oficial), `subtema`, `resumo_pratico`, `palavras_chave`, `link_oficial`, `link_pdf`.
- Adicionar uma coluna `embedding vector(768)` (A representação matemática da decisão).
- Criar a função SQL `match_acordaos` que fará a mágica de calcular a similaridade de contexto.

### 2. Refatoração do Agente Coletor (Python)
- Atualizar o prompt da IA para que ela categorize a decisão **estritamente** dentro da sua lista de temas (Lei 14.133/2021, pregão, dispensa, execução contratual, etc.).
- Após gerar o resumo e extrair os dados, o script fará uma segunda chamada à API do Gemini para gerar o `embedding` (vetor de 768 dimensões) do texto e enviar junto para o Supabase.

### 3. Refatoração do Web App (React)
- **Barra de Pesquisa Inteligente:** Um campo grande onde o usuário pode colar trechos inteiros (ex: "A empresa apresentou atestado de capacidade técnica inferior a 50%...").
- Ao clicar em pesquisar, o site gerará um vetor dessa busca no Gemini e consultará os acórdãos com maior similaridade matemática no Supabase.
- **Visualização do Cartão:** Remoção do conceito de "baixar" arquivos. A interface focará em exibir o link oficial e o link do PDF diretamente na fonte do tribunal.

## Verification Plan
1. Recriar o banco e aplicar o novo `schema.sql`.
2. Atualizar o `agente_coletor.py` e rodá-lo com dados mockados para gerar os primeiros vetores.
3. Refatorar o `App.jsx` para incluir a API de busca vetorial e testar a pesquisa colando um parágrafo complexo.
