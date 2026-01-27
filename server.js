'use strict';

const express = require('express');
const app = express();
app.use(express.json({ limit: '1mb' }));

// =====================
// Config via ENV (Render)
// =====================
const LEAGUE_SLUG = process.env.CARTOLA_LEAGUE_SLUG || 'show-de-bola-araca-f-c';
const LIGA_ID = Number(process.env.CARTOLA_LIGA_ID || '0') || 0;

const BEARER = (process.env.CARTOLA_BEARER || '').trim(); // SEM "Bearer " (pode ser vazio)
const GLB_TAG = (process.env.CARTOLA_GLB_TAG || '').trim(); // opcional
const PREMIADOS_TOP = Number(process.env.PREMIADOS_TOP || '4');
const PORT = Number(process.env.PORT || '3000');

const MONTH_BLOCKS = [
  { label: 'Rodadas 1 a 4 (jan/fev)', start: 1, end: 4 },
  { label: 'Rodadas 5 a 8 (mar)', start: 5, end: 8 },
  { label: 'Rodadas 9 a 13 (abr)', start: 9, end: 13 },
  { label: 'Rodadas 14 a 18 (mai)', start: 14, end: 18 },
  { label: 'Rodadas 19 a 21 (jul)', start: 19, end: 21 },
  { label: 'Rodadas 22 a 25 (ago)', start: 22, end: 25 },
  { label: 'Rodadas 26 a 28 (set)', start: 26, end: 28 },
  { label: 'Rodadas 29 a 33 (out)', start: 29, end: 33 },
  { label: 'Rodadas 34 a 38 (nov/dez)', start: 34, end: 38 }
];

function nowBR() {
  return new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}
function getMonthBlock(rodadaAtual) {
  return MONTH_BLOCKS.find(b => rodadaAtual >= b.start && rodadaAtual <= b.end) || MONTH_BLOCKS[0];
}
function fmt(n) {
  if (n === null || n === undefined) return '-';
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n);
  return num.toFixed(2).replace('.', ',');
}
function header(ligaNome) {
  return `🏆 ${ligaNome}\n🕒 ${nowBR()}\n`;
}

// =====================
// HTTP helpers (Cartola)
// =====================
function baseHeaders(useAuth) {
  const h = {
    'accept': '*/*',
    'origin': 'https://cartola.globo.com',
    'referer': 'https://cartola.globo.com/',
    'user-agent': 'Mozilla/5.0',
    'x-glb-app': 'cartola_web',
    'x-glb-auth': 'oidc'
  };
  if (GLB_TAG) h['x-glb-tag'] = GLB_TAG;
  if (useAuth && BEARER) h['authorization'] = `Bearer ${BEARER}`;
  return h;
}

async function fetchJson(url, useAuth = false) {
  const res = await fetch(url, { headers: baseHeaders(useAuth) });
  const text = await res.text();

  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} em ${url}\n${text.slice(0, 500)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }

  try {
    return JSON.parse(text);
  } catch {
    const err = new Error(`Resposta não-JSON em ${url}: ${text.slice(0, 200)}`);
    err.status = 200;
    err.body = text;
    throw err;
  }
}

// tenta sem auth -> se 401/403, tenta com auth (se houver token)
async function fetchSmart(url) {
  try {
    return await fetchJson(url, false);
  } catch (e) {
    if ((e.status === 401 || e.status === 403) && BEARER) {
      return await fetchJson(url, true);
    }
    throw e;
  }
}

// =====================
// Cache simples em memória
// =====================
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min
const cache = new Map();

function cacheGet(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return item.value;
}
function cacheSet(key, value) {
  cache.set(key, { ts: Date.now(), value });
}

// =====================
// Cartola data
// =====================
async function fetchMercadoStatus() {
  return await fetchJson('https://api.cartola.globo.com/mercado/status', false);
}

/**
 * ✅ Busca da liga com fallback:
 * 1) /liga (público)
 * 2) /auth/liga (precisa token)
 */
async function fetchLiga(orderBy = 'campeonato') {
  const publicUrl = `https://api.cartola.globo.com/liga/${LEAGUE_SLUG}?orderBy=${encodeURIComponent(orderBy)}&page=1`;

  try {
    return await fetchJson(publicUrl, false);
  } catch (e) {
    // Se a liga não puder ser obtida publicamente, cai pro /auth
    if (!BEARER) {
      throw new Error(
        `A liga não está acessível via endpoint público e CARTOLA_BEARER não está configurado.\n` +
        `Detalhe do público: ${e.message}`
      );
    }

    const authUrl = `https://api.cartola.globo.com/auth/liga/${LEAGUE_SLUG}?orderBy=${encodeURIComponent(orderBy)}&page=1`;
    return await fetchJson(authUrl, true);
  }
}

function extractRoundPoints(timeRoundJson) {
  if (typeof timeRoundJson === 'number') return timeRoundJson;
  if (timeRoundJson == null || typeof timeRoundJson !== 'object') return null;

  if (typeof timeRoundJson.pontos === 'number') return timeRoundJson.pontos;
  if (typeof timeRoundJson.pontos_rodada === 'number') return timeRoundJson.pontos_rodada;

  if (timeRoundJson.pontos && typeof timeRoundJson.pontos.rodada === 'number') return timeRoundJson.pontos.rodada;
  if (timeRoundJson.pontos && typeof timeRoundJson.pontos.campeonato === 'number') return timeRoundJson.pontos.campeonato;

  if (timeRoundJson.time && typeof timeRoundJson.time.pontos === 'number') return timeRoundJson.time.pontos;

  return null;
}

async function fetchTimeRound(timeId, rodada) {
  const key = `time:${timeId}:rodada:${rodada}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const url = `https://api.cartola.globo.com/time/id/${timeId}/${rodada}`;
  const data = await fetchSmart(url); // sem token; se pedir, usa token

  cacheSet(key, data);
  return data;
}

// =====================
// Business logic
// =====================
function lastClosedRound(status) {
  const rodadaAtual = Number(status.rodada_atual || 1);
  const mercado = Number(status.status_mercado ?? 1);
  const bolaRolando = Boolean(status.bola_rolando);

  if (rodadaAtual <= 1) return 0;
  if (mercado === 1) return rodadaAtual - 1;
  if (bolaRolando) return rodadaAtual - 1;
  return rodadaAtual - 1;
}

function listParticipants(times) {
  let out = `👥 Participantes (${times.length})\n`;
  times.forEach(t => {
    out += `• ${String(t.nome || '').trim()} — ${String(t.nome_cartola || '').trim()}\n`;
  });
  return out.trim();
}

function sortByRank(times, rankGetter) {
  return [...times].sort((a, b) => {
    const av = rankGetter(a);
    const bv = rankGetter(b);
    const aNull = (av === null || av === undefined);
    const bNull = (bv === null || bv === undefined);
    if (aNull && bNull) return 0;
    if (aNull) return 1;
    if (bNull) return -1;
    return av - bv;
  });
}

function line(pos, timeNome, cartoleiro, pontos) {
  return `${String(pos).padStart(2, '0')}) ${timeNome} (${cartoleiro}) — ${fmt(pontos)} pts`;
}

function buildRodadaMsg(ligaNome, rodadaAtual, times) {
  const list = sortByRank(times, t => t?.ranking?.rodada);
  let out = `${header(ligaNome)}\n📊 RANKING DA RODADA ${rodadaAtual}\n\n`;

  if (list.every(t => t?.pontos?.rodada == null)) {
    out += `Ainda sem pontuação de rodada (normal antes do fechamento/apuração).\n\n`;
    out += listParticipants(times);
    return out.trim();
  }

  list.forEach((t, i) => {
    out += line(i + 1, String(t.nome).trim(), String(t.nome_cartola).trim(), t.pontos.rodada) + '\n';
  });

  out += `\n` + listParticipants(times);
  return out.trim();
}

function buildGeralMsg(ligaNome, rodadaAtual, times) {
  const list = sortByRank(times, t => t?.ranking?.campeonato);
  let out = `${header(ligaNome)}\n🏁 RANKING GERAL (Rodadas 1 até ${rodadaAtual})\n\n`;

  if (list.every(t => t?.pontos?.campeonato == null)) {
    out += `Ainda sem ranking geral (vai aparecer após fechar rodadas).\n\n`;
    out += listParticipants(times);
    return out.trim();
  }

  list.forEach((t, i) => {
    out += line(i + 1, String(t.nome).trim(), String(t.nome_cartola).trim(), t.pontos.campeonato) + '\n';
  });

  return out.trim();
}

async function buildMensalPersonalizadoMsg(ligaNome, status, ligaTimes) {
  const rodadaAtual = Number(status.rodada_atual || 1);
  const monthBlock = getMonthBlock(rodadaAtual);

  const lastClosed = lastClosedRound(status);
  const start = monthBlock.start;
  const end = Math.min(monthBlock.end, lastClosed);

  let out = `${header(ligaNome)}\n📅 MENSAL PERSONALIZADO: ${monthBlock.label}\n🏅 Premiados do período: TOP ${PREMIADOS_TOP}\n\n`;

  if (end < start) {
    out += `Ainda não há rodada fechada dentro deste período.\n`;
    out += `Rodada atual: ${rodadaAtual}. Última rodada fechada: ${lastClosed || 0}.\n\n`;
    out += listParticipants(ligaTimes);
    return out.trim();
  }

  const results = [];
  for (const t of ligaTimes) {
    const timeId = t.time_id;
    let soma = 0;

    for (let r = start; r <= end; r++) {
      try {
        const data = await fetchTimeRound(timeId, r);
        const pts = extractRoundPoints(data);
        if (typeof pts === 'number' && Number.isFinite(pts)) soma += pts;
      } catch {
        // ignora falha pontual
      }
    }

    results.push({
      time_id: timeId,
      nome: String(t.nome || '').trim(),
      nome_cartola: String(t.nome_cartola || '').trim(),
      soma
    });
  }

  results.sort((a, b) => b.soma - a.soma);

  out += `🏆 TOP ${PREMIADOS_TOP} (Rodadas ${start}–${end})\n`;
  results.slice(0, PREMIADOS_TOP).forEach((x, idx) => {
    out += `${idx + 1}. ${x.nome} — ${fmt(x.soma)} pts\n`;
  });

  out += `\n📊 Classificação completa (Rodadas ${start}–${end})\n`;
  results.forEach((x, idx) => {
    out += `${String(idx + 1).padStart(2, '0')}) ${x.nome} (${x.nome_cartola}) — ${fmt(x.soma)} pts\n`;
  });

  out += `\n🧾 Observação: somatório calculado rodada a rodada (seu calendário mensal personalizado).\n`;
  return out.trim();
}

// =====================
// Routes
// =====================
app.get('/', (req, res) => res.status(200).send('OK'));

app.get('/debug', async (req, res) => {
  try {
    const status = await fetchMercadoStatus();
    res.json({
      ok: true,
      now: new Date().toISOString(),
      nowBR: nowBR(),
      rodada_atual: status.rodada_atual,
      status_mercado: status.status_mercado,
      bola_rolando: status.bola_rolando,
      fechamento: status.fechamento,
      tokenConfigured: Boolean(BEARER),
      glbTagConfigured: Boolean(GLB_TAG),
      league: { slug: LEAGUE_SLUG, ligaId: LIGA_ID, premiadosTop: PREMIADOS_TOP },
      lastClosedRound: lastClosedRound(status)
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/rodada', async (req, res) => {
  try {
    const status = await fetchMercadoStatus();
    const rodadaAtual = Number(status.rodada_atual || 1);

    const ligaData = await fetchLiga('rodada');
    const ligaNome = ligaData?.liga?.nome || 'Liga';
    const times = ligaData?.times || [];

    res.type('text/plain').send(buildRodadaMsg(ligaNome, rodadaAtual, times));
  } catch (e) {
    res.status(500).type('text/plain').send(`ERRO: ${e.message}`);
  }
});

app.get('/geral', async (req, res) => {
  try {
    const status = await fetchMercadoStatus();
    const rodadaAtual = Number(status.rodada_atual || 1);

    const ligaData = await fetchLiga('campeonato');
    const ligaNome = ligaData?.liga?.nome || 'Liga';
    const times = ligaData?.times || [];

    res.type('text/plain').send(buildGeralMsg(ligaNome, rodadaAtual, times));
  } catch (e) {
    res.status(500).type('text/plain').send(`ERRO: ${e.message}`);
  }
});

app.get('/mensal', async (req, res) => {
  try {
    const status = await fetchMercadoStatus();

    const ligaData = await fetchLiga('campeonato');
    const ligaNome = ligaData?.liga?.nome || 'Liga';
    const times = ligaData?.times || [];

    const msg = await buildMensalPersonalizadoMsg(ligaNome, status, times);
    res.type('text/plain').send(msg);
  } catch (e) {
    res.status(500).type('text/plain').send(`ERRO: ${e.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`Server online na porta ${PORT}`);
});
