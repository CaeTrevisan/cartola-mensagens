'use strict';

const express = require('express');
const app = express();
app.use(express.json({ limit: '1mb' }));

const LEAGUE_SLUG = process.env.CARTOLA_LEAGUE_SLUG || 'show-de-bola-araca-f-c';
const PREMIADOS_TOP = Number(process.env.PREMIADOS_TOP || '4');
const PORT = Number(process.env.PORT || '3000');

const GLB_TAG = (process.env.CARTOLA_GLB_TAG || '').trim();

let accessToken = (process.env.CARTOLA_BEARER || '').trim(); // sem "Bearer "
const REFRESH_TOKEN = (process.env.CARTOLA_REFRESH_TOKEN || '').trim();
const CLIENT_ID = (process.env.CARTOLA_CLIENT_ID || '').trim(); // AGORA: obrigatório idealmente

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

// ===== JWT exp check =====
function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(b64, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}
function tokenExpSeconds(token) {
  const p = decodeJwtPayload(token);
  return p?.exp ?? null;
}
function isTokenValid(token) {
  if (!token) return false;
  const exp = tokenExpSeconds(token);
  if (!exp) return false;
  const now = Math.floor(Date.now() / 1000);
  return exp > (now + 60);
}

// ===== Refresh =====
async function refreshWithClientId(clientId) {
  const tokenUrl = 'https://goidc.globo.com/auth/realms/globo.com/protocol/openid-connect/token';

  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('client_id', clientId);
  body.set('refresh_token', REFRESH_TOKEN);

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0'
    },
    body
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok) {
    const msg = data?.error_description || data?.error || data?.raw || text;
    const err = new Error(`HTTP ${res.status} — ${msg}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  if (!data?.access_token) {
    throw new Error(`Refresh ok mas sem access_token. Resposta: ${text.slice(0, 300)}`);
  }

  accessToken = String(data.access_token).trim();
  return { ok: true, client_id: clientId, exp: tokenExpSeconds(accessToken) };
}

async function refreshAccessTokenIfNeeded() {
  if (isTokenValid(accessToken)) return { refreshed: false };

  if (!REFRESH_TOKEN) {
    return { refreshed: false, error: 'Sem CARTOLA_REFRESH_TOKEN no Render.' };
  }

  // tenta primeiro o CLIENT_ID do Render; se vazio, pula pro fallback
  const candidates = [];
  if (CLIENT_ID) candidates.push(CLIENT_ID);
  // fallback comum (muitos fluxos usam assim)
  candidates.push('cartola-web');

  let lastErr = null;
  for (const cid of candidates) {
    try {
      const r = await refreshWithClientId(cid);
      return { refreshed: true, ...r };
    } catch (e) {
      lastErr = e;
    }
  }

  return {
    refreshed: false,
    error:
      `Falha ao renovar token. Provável client_id errado ou refresh_token inválido.\n` +
      `Último erro: ${lastErr?.message || 'desconhecido'}`
  };
}

// ===== HTTP cartola =====
function baseHeaders(useAuth) {
  const h = {
    accept: '*/*',
    origin: 'https://cartola.globo.com',
    referer: 'https://cartola.globo.com/',
    'user-agent': 'Mozilla/5.0',
    'x-glb-app': 'cartola_web',
    'x-glb-auth': 'oidc'
  };
  if (GLB_TAG) h['x-glb-tag'] = GLB_TAG;
  if (useAuth && accessToken) h.authorization = `Bearer ${accessToken}`;
  return h;
}

async function fetchJson(url, useAuth = false) {
  if (useAuth) {
    const r = await refreshAccessTokenIfNeeded();
    if (r?.error) throw new Error(r.error);
  }

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
    throw new Error(`Resposta não-JSON em ${url}: ${text.slice(0, 200)}`);
  }
}

async function fetchSmart(url) {
  try {
    return await fetchJson(url, false);
  } catch (e) {
    if ((e.status === 401 || e.status === 403) && (accessToken || REFRESH_TOKEN)) {
      return await fetchJson(url, true);
    }
    throw e;
  }
}

async function fetchMercadoStatus() {
  return await fetchJson('https://api.cartola.globo.com/mercado/status', false);
}

async function fetchLiga(orderBy = 'campeonato') {
  // pública primeiro
  const publicUrl = `https://api.cartola.globo.com/liga/${LEAGUE_SLUG}?orderBy=${encodeURIComponent(orderBy)}&page=1`;
  try {
    return await fetchJson(publicUrl, false);
  } catch {
    // auth com refresh
    const authUrl = `https://api.cartola.globo.com/auth/liga/${LEAGUE_SLUG}?orderBy=${encodeURIComponent(orderBy)}&page=1`;
    return await fetchJson(authUrl, true);
  }
}

// ===== Cache e cálculo mensal =====
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();
function cacheGet(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
  return item.value;
}
function cacheSet(key, value) { cache.set(key, { ts: Date.now(), value }); }

function extractRoundPoints(timeRoundJson) {
  if (typeof timeRoundJson === 'number') return timeRoundJson;
  if (!timeRoundJson || typeof timeRoundJson !== 'object') return null;
  if (typeof timeRoundJson.pontos === 'number') return timeRoundJson.pontos;
  if (typeof timeRoundJson.pontos_rodada === 'number') return timeRoundJson.pontos_rodada;
  if (timeRoundJson.pontos && typeof timeRoundJson.pontos.rodada === 'number') return timeRoundJson.pontos.rodada;
  if (timeRoundJson.time && typeof timeRoundJson.time.pontos === 'number') return timeRoundJson.time.pontos;
  return null;
}

async function fetchTimeRound(timeId, rodada) {
  const key = `time:${timeId}:rodada:${rodada}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const url = `https://api.cartola.globo.com/time/id/${timeId}/${rodada}`;
  const data = await fetchSmart(url);
  cacheSet(key, data);
  return data;
}

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
  for (const t of times) out += `• ${String(t.nome || '').trim()} — ${String(t.nome_cartola || '').trim()}\n`;
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
      } catch {}
    }

    results.push({
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

  out += `\n🧾 Observação: somatório calculado rodada a rodada.\n`;
  return out.trim();
}

// ===== Routes =====
app.get('/', (req, res) => res.status(200).send('OK'));

app.get('/debug', (req, res) => {
  res.json({
    ok: true,
    now: new Date().toISOString(),
    nowBR: nowBR(),
    leagueSlug: LEAGUE_SLUG,
    accessTokenConfigured: Boolean(accessToken),
    accessTokenExp: accessToken ? tokenExpSeconds(accessToken) : null,
    refreshTokenConfigured: Boolean(REFRESH_TOKEN),
    clientIdConfigured: Boolean(CLIENT_ID),
    clientIdValue: CLIENT_ID || null
  });
});

// ✅ novo: testa só o refresh
app.get('/refresh-test', async (req, res) => {
  const r = await refreshAccessTokenIfNeeded();
  if (r?.error) return res.status(500).json({ ok: false, error: r.error });
  return res.json({ ok: true, result: r, accessTokenExp: accessToken ? tokenExpSeconds(accessToken) : null });
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

app.listen(PORT, () => console.log(`Server online na porta ${PORT}`));
