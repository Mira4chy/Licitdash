import { useState, useEffect } from 'react'
import { supabase } from './supabaseClient'
import { GoogleGenAI } from '@google/genai'
import './index.css'

const geminiApiKey = import.meta.env.VITE_GEMINI_API_KEY
const ai = geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : null

function BrandMark({ size = 28 }) {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="bmg" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#6366F1" />
          <stop offset="1" stopColor="#8B5CF6" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="7.5" fill="url(#bmg)" />
      <path d="M16 7v18" stroke="white" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M7.5 11h17" stroke="white" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M5 13.5h5l-2.5 4z" fill="white" fillOpacity="0.95" />
      <path d="M22 13.5h5l-2.5 4z" fill="white" fillOpacity="0.95" />
      <path d="M11.5 25.5h9" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="24.5" cy="7.5" r="1.6" fill="#FCD34D" />
      <circle cx="24.5" cy="7.5" r="3" fill="#FCD34D" fillOpacity="0.25" />
    </svg>
  )
}

function Icon({ name, className = 'nav-icon' }) {
  const props = {
    className,
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  }
  if (name === 'feed') {
    return (
      <svg {...props}>
        <path d="M3 6h18M3 12h18M3 18h12" />
      </svg>
    )
  }
  if (name === 'search') {
    return (
      <svg {...props}>
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.35-4.35" />
        <circle cx="18" cy="6" r="1.2" fill="currentColor" />
      </svg>
    )
  }
  if (name === 'external') {
    return (
      <svg {...props}>
        <path d="M15 3h6v6" />
        <path d="M10 14 21 3" />
        <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
      </svg>
    )
  }
  if (name === 'pdf') {
    return (
      <svg {...props}>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6" />
        <path d="M9 13h6M9 17h4" />
      </svg>
    )
  }
  if (name === 'sparkle') {
    return (
      <svg {...props}>
        <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
        <circle cx="12" cy="12" r="2.5" fill="currentColor" />
      </svg>
    )
  }
  if (name === 'empty') {
    return (
      <svg {...props} width="36" height="36">
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      </svg>
    )
  }
  return null
}

function App() {
  const [decisions, setDecisions] = useState([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [lastQuery, setLastQuery] = useState('')
  const [isSearching, setIsSearching] = useState(false)
  const [activeTab, setActiveTab] = useState('feed')
  const [analises, setAnalises] = useState({})
  const [analisandoId, setAnalisandoId] = useState(null)
  const [erroAnalise, setErroAnalise] = useState({})

  useEffect(() => {
    if (activeTab === 'feed') {
      fetchAllDecisions()
    } else {
      setDecisions([])
      setLastQuery('')
    }
  }, [activeTab])

  async function fetchAllDecisions() {
    if (!supabase) return
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('acordaos')
        .select('*')
        .order('data_sessao', { ascending: false })
      if (error) throw error
      if (data) setDecisions(data)
    } catch (err) {
      console.error('Erro ao buscar acervo:', err)
    } finally {
      setLoading(false)
    }
  }

  async function handleSearch(e) {
    e.preventDefault()
    if (!query.trim() || !supabase || !ai) return
    setIsSearching(true)
    setLoading(true)
    try {
      const result = await ai.models.embedContent({
        model: 'gemini-embedding-2',
        contents: query,
        config: { outputDimensionality: 768 },
      })
      const embedding = result.embeddings[0].values
      const { data, error } = await supabase.rpc('match_acordaos', {
        query_embedding: embedding,
        match_threshold: 0.5,
        match_count: 20,
      })
      if (error) throw error
      if (data) setDecisions(data)
      setLastQuery(query)
      setAnalises({})
      setErroAnalise({})
    } catch (err) {
      console.error('Erro na busca semântica:', err)
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
      if (!resp.ok) throw new Error(data.error || `Erro ${resp.status}`)
      setAnalises(prev => ({ ...prev, [acordao.id]: data }))
    } catch (err) {
      setErroAnalise(prev => ({ ...prev, [acordao.id]: err.message }))
    } finally {
      setAnalisandoId(null)
    }
  }

  function formatDate(d) {
    if (!d) return ''
    try {
      return new Date(d).toLocaleDateString('pt-BR', {
        day: '2-digit', month: 'short', year: 'numeric',
      })
    } catch {
      return d
    }
  }

  const tabs = [
    { id: 'feed', label: 'Acervo', icon: 'feed' },
    { id: 'pesquisa', label: 'Busca por contexto', icon: 'search' },
  ]

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <BrandMark />
          <span className="brand-name">
            Licit<span className="dot">Dash</span>
          </span>
        </div>

        <nav className="nav">
          {tabs.map(t => (
            <button
              key={t.id}
              className={`nav-item ${activeTab === t.id ? 'active' : ''}`}
              onClick={() => setActiveTab(t.id)}
            >
              <Icon name={t.icon} />
              {t.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <span className="badge">Atualizado diariamente</span>
          <div>
            Acórdãos do TCU em licitações.<br />
            Coleta automática às 06h&nbsp;UTC.
          </div>
        </div>
      </aside>

      <main className="main">
        {activeTab === 'feed' && (
          <header className="page-header">
            <h1>Acervo de jurisprudência</h1>
            <p className="subtitle">
              Decisões do TCU em licitações, com resumo prático gerado por IA e link para a fonte oficial.
            </p>
          </header>
        )}

        {activeTab === 'pesquisa' && (
          <>
            <header className="page-header">
              <h1>Busca semântica de jurisprudência</h1>
              <p className="subtitle">
                Não sabe quais palavras usar? <strong>Cole um trecho da sua peça</strong> abaixo — encontramos os acórdãos com sentido jurídico mais próximo, mesmo sem termos idênticos.
              </p>
            </header>

            <form onSubmit={handleSearch} className="search-panel">
              <textarea
                className="search-textarea"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Ex.: A empresa inabilitada alega que apresentou atestado de capacidade técnica equivalente a 30% da complexidade do objeto e que exigências superiores configurariam restrição à competitividade..."
              />
              <div className="search-actions">
                <span className="search-hint">
                  Recomendado colar 2-4 frases do contexto que você quer pesquisar.
                </span>
                <div style={{ display: 'flex', gap: 8 }}>
                  {query && (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => { setQuery(''); setDecisions([]); setLastQuery('') }}
                    >
                      Limpar
                    </button>
                  )}
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={isSearching || !query.trim()}
                  >
                    <Icon name="search" className="" />
                    {isSearching ? 'Analisando contexto…' : 'Buscar'}
                  </button>
                </div>
              </div>
            </form>
          </>
        )}

        <div className="results">
          {loading ? (
            <>
              <div className="skeleton skeleton-card" />
              <div className="skeleton skeleton-card" />
              <div className="skeleton skeleton-card" />
            </>
          ) : decisions.length === 0 ? (
            <div className="state">
              <Icon name="empty" className="state-icon" />
              <h3>
                {activeTab === 'pesquisa'
                  ? 'Cole um trecho da sua peça para começar'
                  : 'Nenhum acórdão no acervo'}
              </h3>
              <p>
                {activeTab === 'pesquisa'
                  ? 'A busca usa similaridade semântica em embeddings vetoriais.'
                  : 'A primeira coleta automática roda no próximo ciclo das 06h UTC.'}
              </p>
            </div>
          ) : (
            decisions.map((dec, i) => (
              <article
                key={dec.id}
                className="card fade-in"
                style={{ animationDelay: `${Math.min(i, 8) * 50}ms` }}
              >
                <div className="card-meta">
                  <div className="card-meta-left">
                    <span className="tag-tribunal">{dec.tribunal}</span>
                    <span className="card-id">
                      AC&nbsp;{dec.numero_acordao}/{dec.ano} · {formatDate(dec.data_sessao)}
                    </span>
                  </div>
                  {dec.similarity != null && (
                    <span className="similarity-badge">
                      {Math.round(dec.similarity * 100)}% relevância
                    </span>
                  )}
                </div>

                <h3>{dec.tema}</h3>
                {dec.subtema && <div className="subtema">→ {dec.subtema}</div>}

                <div className="summary-box">{dec.resumo_pratico}</div>

                <div className="card-footer">
                  <div className="tags">
                    {(dec.palavras_chave || []).slice(0, 5).map(tag => (
                      <span key={tag} className="tag">#{tag}</span>
                    ))}
                  </div>
                  <div className="actions">
                    {dec.similarity != null && lastQuery && (
                      <button
                        className="btn btn-accent-soft"
                        onClick={() => handleAnalisar(dec)}
                        disabled={analisandoId === dec.id || !!analises[dec.id]}
                      >
                        <Icon name="sparkle" className="" />
                        {analisandoId === dec.id
                          ? 'Analisando…'
                          : analises[dec.id]
                            ? 'Analisado'
                            : 'Análise jurídica'}
                      </button>
                    )}
                    {dec.link_oficial && (
                      <a
                        href={dec.link_oficial}
                        target="_blank"
                        rel="noreferrer"
                        className="btn btn-secondary"
                      >
                        <Icon name="external" className="" />
                        Fonte
                      </a>
                    )}
                    {dec.link_pdf && (
                      <a
                        href={dec.link_pdf}
                        target="_blank"
                        rel="noreferrer"
                        className="btn btn-secondary"
                      >
                        <Icon name="pdf" className="" />
                        PDF
                      </a>
                    )}
                  </div>
                </div>

                {erroAnalise[dec.id] && (
                  <div className="error-inline">⚠ {erroAnalise[dec.id]}</div>
                )}

                {analises[dec.id] && (
                  <div className="analysis">
                    <div className="analysis-header">
                      <span className="analysis-title">
                        <Icon name="sparkle" className="" />
                        Análise jurídica · Nemotron
                      </span>
                      <span className="analysis-source">
                        {analises[dec.id].cached ? 'cached' : 'live'}
                      </span>
                    </div>

                    <div className="metric">
                      <div className="metric-label">
                        <span>Aderência ao seu trecho</span>
                        <strong>{analises[dec.id].aderencia_pct}%</strong>
                      </div>
                      <div className="metric-bar">
                        <div
                          className="metric-fill"
                          style={{ width: `${analises[dec.id].aderencia_pct}%` }}
                        />
                      </div>
                    </div>

                    <p>{analises[dec.id].justificativa}</p>

                    {analises[dec.id].pontos_chave?.length > 0 && (
                      <ul>
                        {analises[dec.id].pontos_chave.map((pt, idx) => (
                          <li key={idx}>{pt}</li>
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
