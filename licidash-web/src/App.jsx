import { useState, useEffect } from 'react'
import { supabase } from './supabaseClient'
import { GoogleGenAI } from '@google/genai'
import './index.css'

// Inicializa a IA no frontend para gerar o embedding da pesquisa do usuário
const geminiApiKey = import.meta.env.VITE_GEMINI_API_KEY;
const ai = geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : null;

function App() {
  const [decisions, setDecisions] = useState([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [lastQuery, setLastQuery] = useState('') // trecho que gerou a busca atual
  const [isSearching, setIsSearching] = useState(false)
  const [activeTab, setActiveTab] = useState('feed') // 'feed' ou 'pesquisa'
  const [analises, setAnalises] = useState({}) // { [acordaoId]: { aderencia_pct, justificativa, pontos_chave, cached } }
  const [analisandoId, setAnalisandoId] = useState(null)
  const [erroAnalise, setErroAnalise] = useState({}) // { [acordaoId]: 'mensagem' }

  // Carrega as decisões de acordo com a aba ativa
  useEffect(() => {
    if (activeTab === 'feed') {
      fetchAllDecisions()
    } else {
      setDecisions([]) // limpa as decisões ao ir para pesquisa
    }
  }, [activeTab])

  async function fetchAllDecisions() {
    if (!supabase) return;
    setLoading(true)
    try {
      // Traz todo o acervo ordenado pelos mais recentes
      const { data, error } = await supabase
        .from('acordaos')
        .select('*')
        .order('data_sessao', { ascending: false })

      if (error) throw error
      if (data) setDecisions(data)
    } catch (error) {
      console.error('Erro ao buscar o acervo:', error)
    } finally {
      setLoading(false)
    }
  }

  // A Mágica: Busca Semântica
  async function handleSearch(e) {
    e.preventDefault();
    if (!query.trim() || !supabase || !ai) return;

    setIsSearching(true)
    setLoading(true)

    try {
      // 1. Transforma a peça colada em vetor de 768 dimensões (mesmo modelo usado no backend)
      const result = await ai.models.embedContent({
        model: 'gemini-embedding-2',
        contents: query,
        config: { outputDimensionality: 768 }
      });
      const embedding = result.embeddings[0].values;

      // 2. Com o vetor na mão, o site aciona a função secreta (RPC) do Supabase para achar similaridade matemática
      const { data, error } = await supabase.rpc('match_acordaos', {
        query_embedding: embedding,
        match_threshold: 0.5, // Quão rígida é a similaridade
        match_count: 20 // Quantos resultados trazer
      })

      if (error) throw error
      if (data) setDecisions(data)
      setLastQuery(query)
      setAnalises({})
      setErroAnalise({})

    } catch (error) {
      console.error("Erro na busca semântica:", error);
    } finally {
      setIsSearching(false)
      setLoading(false)
    }
  }

  async function handleAnalisar(acordao) {
    if (!lastQuery.trim() || analisandoId) return
    setAnalisandoId(acordao.id)
    setErroAnalise(prev => ({ ...prev, [acordao.id]: null }))
    try {
      const resp = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          acordao_id: acordao.id,
          trecho_usuario: lastQuery,
          sumario_acordao: acordao.resumo_pratico,
          numero: acordao.numero_acordao,
          ano: acordao.ano,
        }),
      })
      const data = await resp.json()
      if (!resp.ok) {
        throw new Error(data.error || `Erro ${resp.status}`)
      }
      setAnalises(prev => ({ ...prev, [acordao.id]: data }))
    } catch (e) {
      setErroAnalise(prev => ({ ...prev, [acordao.id]: e.message }))
    } finally {
      setAnalisandoId(null)
    }
  }

  return (
    <div className="app-container">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="brand" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ width: '32px', height: '32px', borderRadius: '8px', background: 'var(--accent-primary)', boxShadow: '0 0 15px rgba(102, 252, 241, 0.4)' }}></div>
          <h1 style={{ fontSize: '1.5rem', margin: 0, fontWeight: 700 }}>Lici<span style={{ color: 'var(--accent-primary)' }}>Dash</span></h1>
        </div>

        <nav style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '2rem' }}>
          <button 
            onClick={() => setActiveTab('feed')}
            style={{ 
              textAlign: 'left',
              color: activeTab === 'feed' ? 'var(--text-primary)' : 'var(--text-muted)', 
              textDecoration: 'none', 
              padding: '10px 16px', 
              borderRadius: '8px', 
              background: activeTab === 'feed' ? 'var(--border-light)' : 'transparent', 
              fontWeight: activeTab === 'feed' ? 500 : 400,
              border: 'none',
              cursor: 'pointer',
              transition: 'all 0.2s',
              fontSize: '1rem',
              fontFamily: 'inherit'
            }}>
            Feed de Decisões
          </button>
          <button 
            onClick={() => setActiveTab('pesquisa')}
            style={{ 
              textAlign: 'left',
              color: activeTab === 'pesquisa' ? 'var(--text-primary)' : 'var(--text-muted)', 
              textDecoration: 'none', 
              padding: '10px 16px', 
              borderRadius: '8px', 
              background: activeTab === 'pesquisa' ? 'var(--border-light)' : 'transparent', 
              fontWeight: activeTab === 'pesquisa' ? 500 : 400,
              border: 'none',
              cursor: 'pointer',
              transition: 'all 0.2s',
              fontSize: '1rem',
              fontFamily: 'inherit'
            }}>
            Pesquisa por Contexto
          </button>
        </nav>
      </aside>

      {/* Main Content */}
      <main className="main-content">
        {activeTab === 'feed' && (
          <header style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '2rem', marginBottom: '8px' }}>Todo o Acervo</h2>
            <p style={{ color: 'var(--text-secondary)' }}>
              Explore todas as decisões e jurisprudências coletadas.
            </p>
          </header>
        )}

        {activeTab === 'pesquisa' && (
          <>
            <header style={{ marginBottom: '2rem' }}>
              <h2 style={{ fontSize: '2rem', marginBottom: '8px' }}>Pesquisa Semântica de Jurisprudência</h2>
              <p style={{ color: 'var(--text-secondary)' }}>
                Não sabe quais palavras usar? Tudo bem. <strong>Cole um trecho da sua petição ou parecer abaixo</strong> e nós acharemos o entendimento mais adequado pelo contexto.
              </p>
            </header>

            {/* Barra de Pesquisa Gigante */}
            <div className="glass-panel" style={{ padding: '24px', marginBottom: '3rem' }}>
              <form onSubmit={handleSearch} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <textarea 
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Ex: A empresa inabilitada alega que apresentou atestado de capacidade técnica equivalente a 30% da complexidade do objeto e que exigências superiores seriam restrição à competitividade..."
                  style={{ 
                    width: '100%', minHeight: '120px', padding: '16px', borderRadius: '12px', 
                    background: 'rgba(0,0,0,0.3)', color: 'var(--text-primary)', border: '1px solid var(--border-light)', 
                    fontFamily: 'inherit', fontSize: '15px', resize: 'vertical'
                  }}
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                  {query && (
                    <button 
                      type="button" 
                      onClick={() => { setQuery(''); setDecisions([]); }}
                      style={{ background: 'transparent', color: 'var(--text-muted)', border: 'none', cursor: 'pointer', padding: '10px 20px' }}>
                      Limpar Busca
                    </button>
                  )}
                  <button 
                    type="submit" 
                    disabled={isSearching || !query.trim()}
                    style={{ 
                      background: 'var(--accent-primary)', color: '#000', border: 'none', padding: '12px 32px', 
                      borderRadius: '30px', fontWeight: 600, cursor: 'pointer', opacity: isSearching ? 0.7 : 1, transition: 'all 0.2s'
                    }}>
                    {isSearching ? 'Analisando Contexto...' : 'Pesquisar por Contexto'}
                  </button>
                </div>
              </form>
            </div>
          </>
        )}

        {/* Dashboard Cards Grid */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {loading ? (
            <p style={{ color: 'var(--accent-primary)', textAlign: 'center', padding: '2rem' }}>
              {isSearching ? 'Calculando vetores matemáticos e buscando similaridade...' : 'Carregando acórdãos...'}
            </p>
          ) : decisions.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>Nenhum resultado encontrado.</p>
          ) : (
            decisions.map((dec, index) => (
              <article 
                key={dec.id} 
                className="glass-panel animate-fade-in" 
                style={{ padding: '24px', animationDelay: `${Math.min(index, 10) * 0.1}s`, position: 'relative' }}
              >
                {/* Indicador de Similaridade (Aparece só na busca semântica) */}
                {dec.similarity && (
                  <div style={{ position: 'absolute', top: '-12px', right: '24px', background: 'var(--accent-primary)', color: '#000', padding: '4px 12px', borderRadius: '20px', fontSize: '12px', fontWeight: 700, boxShadow: '0 4px 10px rgba(102, 252, 241, 0.3)' }}>
                    {Math.round(dec.similarity * 100)}% Relevância
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '16px' }}>
                  <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                    <span style={{ background: 'rgba(102, 252, 241, 0.1)', color: 'var(--accent-primary)', padding: '4px 10px', borderRadius: '6px', fontSize: '12px', fontWeight: 600 }}>{dec.tribunal}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: '14px', fontWeight: 500 }}>AC-{dec.numero_acordao}-{dec.ano} • {new Date(dec.data_sessao).toLocaleDateString('pt-BR')}</span>
                  </div>
                </div>
                
                <h3 style={{ fontSize: '1.25rem', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {dec.tema} 
                  {dec.subtema && <span style={{ fontSize: '14px', color: 'var(--text-secondary)', fontWeight: 400 }}>→ {dec.subtema}</span>}
                </h3>
                
                <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '8px', borderLeft: '4px solid var(--accent-primary)', marginBottom: '20px' }}>
                  <p style={{ margin: 0, color: 'var(--text-primary)', fontSize: '15px' }}>{dec.resumo_pratico}</p>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  {/* Tags */}
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    {(dec.palavras_chave || []).map(tag => (
                      <span key={tag} style={{ border: '1px solid var(--border-light)', padding: '4px 12px', borderRadius: '20px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                        #{tag}
                      </span>
                    ))}
                  </div>

                  {/* Ações / Links Fonte */}
                  <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                    {dec.similarity && lastQuery && (
                      <button
                        onClick={() => handleAnalisar(dec)}
                        disabled={analisandoId === dec.id || !!analises[dec.id]}
                        style={{
                          display: 'flex', alignItems: 'center', gap: '6px',
                          color: '#000', background: 'var(--accent-primary)', border: 'none',
                          fontSize: '14px', padding: '8px 16px', borderRadius: '6px',
                          fontWeight: 600, cursor: analisandoId === dec.id ? 'wait' : 'pointer',
                          opacity: analises[dec.id] ? 0.5 : 1,
                        }}
                      >
                        <span>🧠</span>
                        {analisandoId === dec.id
                          ? 'Analisando…'
                          : analises[dec.id]
                            ? 'Analisado'
                            : 'Analisar match'}
                      </button>
                    )}
                    {dec.link_oficial && (
                      <a href={dec.link_oficial} target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-primary)', textDecoration: 'none', fontSize: '14px', padding: '8px 16px', background: 'rgba(255,255,255,0.05)', borderRadius: '6px', transition: 'all 0.2s' }} onMouseOver={e => e.currentTarget.style.background='rgba(255,255,255,0.1)'} onMouseOut={e => e.currentTarget.style.background='rgba(255,255,255,0.05)'}>
                        <span>🔗</span> Ver Fonte Oficial
                      </a>
                    )}
                    {dec.link_pdf && (
                      <a href={dec.link_pdf} target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--accent-primary)', textDecoration: 'none', fontSize: '14px', padding: '8px 16px', background: 'rgba(102, 252, 241, 0.1)', borderRadius: '6px', transition: 'all 0.2s' }} onMouseOver={e => e.currentTarget.style.background='rgba(102, 252, 241, 0.2)'} onMouseOut={e => e.currentTarget.style.background='rgba(102, 252, 241, 0.1)'}>
                        <span>📄</span> Abrir PDF
                      </a>
                    )}
                  </div>
                </div>

                {erroAnalise[dec.id] && (
                  <div style={{ marginTop: '16px', padding: '12px 16px', background: 'rgba(255, 107, 107, 0.12)', border: '1px solid rgba(255, 107, 107, 0.4)', borderRadius: '8px', color: '#ff8a8a', fontSize: '14px' }}>
                    ⚠️ {erroAnalise[dec.id]}
                  </div>
                )}

                {analises[dec.id] && (
                  <div style={{ marginTop: '20px', padding: '20px', background: 'rgba(102, 252, 241, 0.06)', borderRadius: '10px', border: '1px solid rgba(102, 252, 241, 0.25)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                      <strong style={{ color: 'var(--accent-primary)', fontSize: '14px', letterSpacing: '0.5px', textTransform: 'uppercase' }}>
                        🧠 Análise jurídica (Nemotron)
                      </strong>
                      <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                        {analises[dec.id].cached ? 'cache' : 'gerada agora'}
                      </span>
                    </div>

                    <div style={{ marginBottom: '16px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '6px' }}>
                        <span>Aderência ao seu trecho</span>
                        <strong style={{ color: 'var(--text-primary)' }}>{analises[dec.id].aderencia_pct}%</strong>
                      </div>
                      <div style={{ height: '8px', background: 'rgba(255,255,255,0.08)', borderRadius: '4px', overflow: 'hidden' }}>
                        <div style={{ width: `${analises[dec.id].aderencia_pct}%`, height: '100%', background: 'linear-gradient(90deg, var(--accent-primary), #b6fcf4)', transition: 'width 0.6s ease' }} />
                      </div>
                    </div>

                    <p style={{ margin: '0 0 12px 0', fontSize: '14px', lineHeight: 1.55, color: 'var(--text-primary)' }}>
                      {analises[dec.id].justificativa}
                    </p>

                    {analises[dec.id].pontos_chave?.length > 0 && (
                      <ul style={{ margin: 0, paddingLeft: '20px', color: 'var(--text-secondary)', fontSize: '14px', lineHeight: 1.6 }}>
                        {analises[dec.id].pontos_chave.map((p, i) => (
                          <li key={i}>{p}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

              </article>
            ))
          )}
        </div>
      </main>
    </div>
  )
}

export default App
