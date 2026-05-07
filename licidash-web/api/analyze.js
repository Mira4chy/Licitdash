// Vercel Serverless Function — proxy para o OpenRouter (Nemotron).
// Esconde a OPENROUTER_API_KEY do browser e cacheia o resultado no Supabase
// para não estourar os 200 req/dia do free tier.

import { createClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL ||
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free';
const SITE_URL = process.env.SITE_URL || 'https://licidash.vercel.app';

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

function hashTrecho(trecho) {
  return createHash('sha256').update(trecho.trim()).digest('hex');
}

function extrairJSON(texto) {
  // Nemotron pode retornar com cercas de markdown. Tira e parseia.
  const limpo = texto
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
  // Pega o primeiro objeto JSON balanceado.
  const inicio = limpo.indexOf('{');
  const fim = limpo.lastIndexOf('}');
  if (inicio === -1 || fim === -1) throw new Error('Sem JSON na resposta');
  return JSON.parse(limpo.slice(inicio, fim + 1));
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
              'Você é analista jurídico especialista em licitações. Avalie em PT-BR a aderência (0-100) entre o trecho da peça e o acórdão do TCU, justificando juridicamente.',
          },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
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

  const registro = {
    aderencia_pct: Math.max(0, Math.min(100, parseInt(analise.aderencia_pct, 10) || 0)),
    justificativa: String(analise.justificativa || '').slice(0, 2000),
    pontos_chave: Array.isArray(analise.pontos_chave)
      ? analise.pontos_chave.map(String).slice(0, 10)
      : [],
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
