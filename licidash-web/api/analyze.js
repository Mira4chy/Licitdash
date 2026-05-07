// Vercel Serverless Function — proxy para o OpenRouter (Nemotron).
// Esconde a OPENROUTER_API_KEY do browser e cacheia o resultado no Supabase
// para não estourar os 200 req/dia do free tier.

import { createClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';

// Limpa espaços/aspas/quebras que podem vir de paste sujo no Vercel UI
const cleanEnv = (v) => (v || '').trim().replace(/^["']|["']$/g, '');

const SUPABASE_URL = cleanEnv(process.env.SUPABASE_URL);
const SUPABASE_SERVICE_ROLE_KEY = cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY);
const OPENROUTER_API_KEY = cleanEnv(process.env.OPENROUTER_API_KEY);
const OPENROUTER_MODEL =
  cleanEnv(process.env.OPENROUTER_MODEL) ||
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free';
const SITE_URL = cleanEnv(process.env.SITE_URL) || 'https://licidash.vercel.app';

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

function hashTrecho(trecho) {
  return createHash('sha256').update(trecho.trim()).digest('hex');
}

function extrairJSON(texto) {
  // Nemotron é reasoning model: pode vir com <think>...</think> antes do JSON,
  // cercas markdown ```json, ou texto livre seguido do objeto.
  let limpo = texto
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\|.*?\|>/g, '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  // Tenta parse direto primeiro
  try {
    return JSON.parse(limpo);
  } catch {}

  // Varredura: encontra blocos {...} balanceados e tenta cada um
  const candidatos = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < limpo.length; i++) {
    if (limpo[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (limpo[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        candidatos.push(limpo.slice(start, i + 1));
        start = -1;
      }
    }
  }
  // Tenta do mais longo pro mais curto (provavelmente o resultado final)
  candidatos.sort((a, b) => b.length - a.length);
  for (const c of candidatos) {
    try {
      return JSON.parse(c);
    } catch {}
  }
  throw new Error('Sem JSON válido na resposta');
}

// Aceita aderência em vários formatos: int, string numérica, "85%", "alta"/"média"/"baixa"
function normalizarAderencia(valor) {
  if (typeof valor === 'number' && !isNaN(valor)) {
    return Math.max(0, Math.min(100, Math.round(valor)));
  }
  const s = String(valor || '').toLowerCase().trim();
  const m = s.match(/(\d{1,3})/);
  if (m) {
    return Math.max(0, Math.min(100, parseInt(m[1], 10)));
  }
  if (/(muito alta|altíssima)/.test(s)) return 90;
  if (/alta/.test(s)) return 75;
  if (/(média|media|moderada)/.test(s)) return 55;
  if (/baixa/.test(s)) return 30;
  if (/(nenhuma|não|nao se aplica)/.test(s)) return 5;
  return null; // sinaliza que não conseguiu extrair
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!OPENROUTER_API_KEY) {
    return res.status(500).json({ error: 'OPENROUTER_API_KEY não configurada' });
  }

  const { acordao_id, trecho_usuario, sumario_acordao, numero, ano } = req.body || {};
  if (!trecho_usuario || !sumario_acordao) {
    return res.status(400).json({ error: 'trecho_usuario e sumario_acordao são obrigatórios' });
  }

  const chave = hashTrecho(trecho_usuario);

  // 1. Tenta cache do Supabase
  if (supabase && acordao_id) {
    try {
      const { data } = await supabase
        .from('acordaos')
        .select('analise_cache')
        .eq('id', acordao_id)
        .single();
      const hit = data?.analise_cache?.[chave];
      if (hit) {
        return res.status(200).json({ ...hit, cached: true });
      }
    } catch (e) {
      console.warn('Cache lookup falhou:', e.message);
    }
  }

  // 2. Chama OpenRouter
  const prompt = `TRECHO DO USUÁRIO:\n${trecho_usuario}\n\nACÓRDÃO ${numero}/${ano}:\n${sumario_acordao}\n\nResponda APENAS um JSON válido com a estrutura:\n{"aderencia_pct": <int 0-100>, "justificativa": "<texto curto>", "pontos_chave": ["<str>", "<str>"]}`;

  let openrouterResp;
  try {
    openrouterResp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': SITE_URL,
        'X-Title': 'LiciDash',
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'Você é analista jurídico especialista em licitações. Avalie em PT-BR a aderência (0-100) entre o trecho da peça e o acórdão do TCU, justificando juridicamente. Responda DIRETO em JSON, sem explicar o raciocínio antes.',
          },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        // Limita o tempo: free tier do Vercel Hobby aborta em 60s
        max_tokens: 800,
        reasoning: { effort: 'low' },
        temperature: 0.2,
      }),
    });
  } catch (e) {
    return res.status(502).json({ error: `Falha ao contatar OpenRouter: ${e.message}` });
  }

  if (!openrouterResp.ok) {
    const txt = await openrouterResp.text();
    if (openrouterResp.status === 429) {
      return res.status(429).json({
        error: 'Limite diário do Nemotron atingido. Tente em algumas horas.',
      });
    }
    return res.status(openrouterResp.status).json({
      error: `OpenRouter ${openrouterResp.status}: ${txt.slice(0, 300)}`,
    });
  }

  let analise;
  try {
    const data = await openrouterResp.json();
    const conteudo = data.choices?.[0]?.message?.content;
    if (!conteudo) throw new Error('Resposta sem conteúdo');
    analise = extrairJSON(conteudo);
  } catch (e) {
    return res.status(500).json({ error: `Resposta inválida do Nemotron: ${e.message}` });
  }

  // Aceita variações de nome de chave que o Nemotron costuma improvisar
  const aderenciaRaw =
    analise.aderencia_pct ??
    analise.aderencia ??
    analise.aderência_pct ??
    analise.aderência ??
    analise.score ??
    analise.match_pct ??
    analise.match;
  const aderenciaNorm = normalizarAderencia(aderenciaRaw);

  const justificativa =
    analise.justificativa ||
    analise.justificacao ||
    analise.fundamentacao ||
    analise.analise ||
    '';

  const pontos =
    analise.pontos_chave ||
    analise.pontos ||
    analise.principais_pontos ||
    analise.key_points ||
    [];

  const registro = {
    aderencia_pct: aderenciaNorm ?? 0,
    justificativa: String(justificativa).slice(0, 2000),
    pontos_chave: Array.isArray(pontos) ? pontos.map(String).slice(0, 10) : [],
    gerado_em: new Date().toISOString(),
  };

  // 3. Persiste cache (best-effort, não bloqueia a resposta se falhar)
  if (supabase && acordao_id) {
    try {
      const { data: row } = await supabase
        .from('acordaos')
        .select('analise_cache')
        .eq('id', acordao_id)
        .single();
      const cacheAtual = row?.analise_cache || {};
      cacheAtual[chave] = registro;
      await supabase
        .from('acordaos')
        .update({ analise_cache: cacheAtual })
        .eq('id', acordao_id);
    } catch (e) {
      console.warn('Cache write falhou:', e.message);
    }
  }

  return res.status(200).json({ ...registro, cached: false });
}
