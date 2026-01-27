'use strict';

const express = require('express');

const app = express();
app.use(express.json({ limit: '1mb' }));

// ===== ENV =====
const LEAGUE_SLUG = (process.env.CARTOLA_LEAGUE_SLUG || 'show-de-bola-araca-f-c').trim();
const PREMIADOS_TOP = Number(process.env.PREMIADOS_TOP || '4');
const PORT = Number(process.env.PORT || '3000');

const BEARER = (process.env.CARTOLA_BEARER || '').trim(); // SEM "Bearer "
const GLB_TAG = (process.env.CARTOLA_GLB_TAG || '').trim(); // opcional
const TZ = (process.env.TZ || 'America/Sao_Paulo').trim();

// ===== Mensal personalizado por blocos (SEU calendário) =====
const MONTH_BLOCKS = [
  { label: 'Rodadas 1 a 4 (jan/fev)', start: 1, end: 4 },
  { label: 'Rodadas 5 a 8 (mar)', start: 5, end: 8 },
  { label: 'Rodadas 9 a 13 (abr)', start: 9, end: 13 },
  { label: 'Rodadas 14 a 18 (mai)', start: 14, end: 18 },
  { label: 'Rodadas 19 a 21 (jul)', start: 19, end: 21 },
  { label: 'Rodadas 22 a 25 (ago)', start: 22, end: 25 },
  { label: 'Rodadas 26 a 28 (set)', start: 26, end: 28 },
  { label: 'Rodadas 29 a 33 (out)', start: 29, end: 33 },
  { label: 'Rodadas 34 a 38 (nov/dez)', start: 34, end: 38 },
];

function nowBR() {
  return new Date().toLocaleString('pt-BR', { timeZone: TZ });
}

function fmt(n) {
  if (n === null || n === undefined) return '-';
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n);
  return num.toFixed(2).replace('.', ',');
}

function getMonthBlock(rodadaAtual) {
  return MONTH_BLOCKS.find(b => rodadaAtual >= b.start && rodadaAtual <= b.end) || MONTH_BLOCKS[0];
}

// ===== HTTP helpers =====
function baseHeaders(useAuth) {
  const h = {
    'accept': 'application/json, text/plain, */*',
    'origin': 'https://cartola.globo.com',
    'referer': 'https://cartola.globo.com/',
    'user-agent': 'Mozilla/5.0',
    'x-glb-app': 'cartola_web',
    'x-glb-auth': 'oidc',
  };
  if (GLB_TAG) h['x-glb-tag'] = GLB_TAG;
  if (useAuth && BEARER) h['authorization'] = `Bearer ${BEARER}`;
  return h;
}

async function fetchJson(url, useAuth = false) {
  const res = await fetch(url, { headers: baseHeaders(useAuth) });
  const text = await res.text();

  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} em ${url}\n${text.slice(0, 400)}`);
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

// Tenta público -> se 401/403, tenta com Bearer
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

// ===== Cache simples para não martelar a API =====
const cache = new Map(); // key => { value, at }
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

function cacheGet(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return item.value;
}
function cacheSet(key, value) {
  cache.set(key, { value, at: Date.now() });
}

// ===== Cartola data =====
async function getMercadoStatus() {
  return await fetchSmart('https://api.cartola.globo.com/mercado/status');
}

async function getLeagueData() {
  // Esse endpoint é o que você já validou
  const url = `https://api.cartola.globo.com/auth/liga/${LEAGUE_SLUG}?orderBy=campeonato&page=1`;
  return await fetchSmart(url);
}

async function getTeamsList() {
  const ligaData = await getLeagueData();
  const ligaNome = ligaData?.liga?.nome || 'Liga';
  const times = (ligaData?.times || []).map(t => ({
    time_id: t.time_id,
    nome: String(t.nome || '').trim(),
    nome_cartola: String(t.nome_cartola || '').trim(),
    slug: t.slug,
  }));
  return { ligaNome, times };
}

// Endpoint por time/rodada (usado para somatórios do mensal e geral)
async function getTimeRoundRaw(timeId, rodada) {
  const key = `timeRaw:${timeId}:${rodada}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const url = `https://api.cartola.globo.com/time/id/${timeId}/${rodada}`;
  const data = await fetchSmart(url);
  cacheSet(key, data);
  return data;
}

// Extrair pontos da rodada a partir do payload do time
function extractRoundPoints(timeRoundJson) {
  // Tentamos várias chaves comuns (robusto)
  const candidates = [
    timeRoundJson?.pontos,
    timeRoundJson?.pontuacao,
    timeRoundJson?.pontos_rodada,
    timeRoundJson?.pontosRodada,
    timeRoundJson?.time?.pontos,
    timeRoundJson?.time?.pontuacao,
  ];

  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n)) return n;
  }

  // Algumas respostas podem trazer algo tipo: time.pontos.rodada
  const nested = timeRoundJson?.time?.pontos?.rodada;
  if (nested !== undefined && nested !== null && Number.isFinite(Number(nested))) return Number(nested);

  // Sem pontos (normal antes de apurar)
  return null;
}

async function getRoundPointsForTeam(timeId, rodada) {
  const key = `pts:${timeId}:${rodada}`;
  const cached = cacheGet(key);
  if (cached !== null) return cached; // pode ser número OU null cacheado

  const raw = await getTimeRoundRaw(timeId, rodada);
  const pts = extractRoundPoints(raw);
  cacheSet(key, pts);
  return pts;
}

async function sumPoints(timeId, startRodada, endRodada) {
  // endRodada inclusivo
  let sum = 0;
  let hasAny = false;

  for (let r = startRodada; r <= endRodada; r++) {
    const pts = await getRoundPointsForTeam(timeId, r);
    if (pts === null) continue;
    hasAny = true;
    sum += pts;
  }
  return hasAny ? sum : null;
}

function buildRankingRows(entries) {
  // entries: [{name, cartoleiro, pts}]
  // Ordena por pts desc (maior melhor); null vai pro fim
  const sorted = [...entries].sort((a, b) => {
    const an = a.pts;
    const bn = b.pts;
    const aNull = (an === null || an === undefined);
    const bNull = (bn === null || bn === undefined);
    if (aNull && bNull) return 0;
    if (aNull) return 1;
    if (bNull) return -1;
    return bn - an;
  });

  return sorted.map((e, idx) => ({
    pos: idx + 1,
    ...e,
  }));
}

function diffPositions(currRanked, prevRanked) {
  // retorna map time_id/name -> delta (subiu/ desceu)
  const prevPosById = new Map();
  prevRanked.forEach((x, i) => prevPosById.set(x.time_id, i + 1));

  const out = new Map();
  currRanked.forEach((x, i) => {
    const currPos = i + 1;
    const prevPos = prevPosById.get(x.time_id);
    if (!prevPos) {
      out.set(x.time_id, null);
      return;
    }
    out.set(x.time_id, prevPos - currPos); // positivo = subiu
  });
  return out;
}

function emojiMove(delta) {
  if (delta === null || delta === undefined) return '';
  if (delta > 0) return ` 🔼${delta}`;
  if (delta < 0) return ` 🔽${Math.abs(delta)}`;
  return ' ➖0';
}

function header(ligaNome) {
  return `🏆 ${ligaNome}\n🕒 ${nowBR()}\n`;
}

function participantsBlock(times) {
  let out = `👥 Participantes (${times.length})\n`;
  times.forEach(t => {
    out += `• ${t.nome} — ${t.nome_cartola}\n`;
  });
  return out.trim();
}

// ===== Builders: Rodada / Geral / Mensal Personalizado =====
async function buildRodada(ligaNome, times, rodadaAtual) {
  // Ranking da rodada atual (pontos da rodadaAtual)
  const entries = [];
  for (const t of times) {
    const pts = await getRoundPointsForTeam(t.time_id, rodadaAtual);
    entries.push({ time_id: t.time_id, name: t.nome, cartoleiro: t.nome_cartola, pts });
  }

  const ranked = buildRankingRows(entries);

  let out = `${header(ligaNome)}\n📊 RANKING DA RODADA ${rodadaAtual}\n\n`;

  if (ranked.every(x => x.pts === null)) {
    out += `Ainda sem pontuação da rodada (normal antes do fechamento/apuração).\n\n`;
    out += participantsBlock(times);
    return out.trim();
  }

  ranked.forEach(x => {
    out += `${String(x.pos).padStart(2, '0')}) ${x.name} (${x.cartoleiro}) — ${fmt(x.pts)} pts\n`;
  });

  return out.trim();
}

async function buildGeral(ligaNome, times, rodadaAtual) {
  // Soma 1..rodadaAtual (se não tiver nada ainda, fica null)
  const entries = [];
  for (const t of times) {
    const pts = await sumPoints(t.time_id, 1, rodadaAtual);
    entries.push({ time_id: t.time_id, name: t.nome, cartoleiro: t.nome_cartola, pts });
  }

  const ranked = buildRankingRows(entries);

  // Para “subiu/desceu” no geral: compara com (1..rodadaAtual-1)
  let prevRanked = null;
  if (rodadaAtual > 1) {
    const prevEntries = [];
    for (const t of times) {
      const ptsPrev = await sumPoints(t.time_id, 1, rodadaAtual - 1);
      prevEntries.push({ time_id: t.time_id, name: t.nome, cartoleiro: t.nome_cartola, pts: ptsPrev });
    }
    prevRanked = buildRankingRows(prevEntries);
  }

  const deltaMap = prevRanked ? diffPositions(
    ranked.map(x => ({ time_id: x.time_id })),
    prevRanked.map(x => ({ time_id: x.time_id }))
  ) : null;

  let out = `${header(ligaNome)}\n🏁 RANKING GERAL (Rodadas 1 até ${rodadaAtual})\n\n`;

  if (ranked.every(x => x.pts === null)) {
    out += `Ainda sem ranking geral (vai aparecer após fechar rodadas).\n\n`;
    out += participantsBlock(times);
    return out.trim();
  }

  ranked.forEach(x => {
    const d = deltaMap ? deltaMap.get(x.time_id) : null;
    out += `${String(x.pos).padStart(2, '0')}) ${x.name} (${x.cartoleiro}) — ${fmt(x.pts)} pts${emojiMove(d)}\n`;
  });

  return out.trim();
}

async function buildMensalPersonalizado(ligaNome, times, rodadaAtual) {
  const block = getMonthBlock(rodadaAtual);
  const end = Math.min(block.end, rodadaAtual);

  // Mensal: soma block.start..end
  const entries = [];
  for (const t of times) {
    const pts = await sumPoints(t.time_id, block.start, end);
    entries.push({ time_id: t.time_id, name: t.nome, cartoleiro: t.nome_cartola, pts });
  }
  const ranked = buildRankingRows(entries);

  // “Subiu/desceu” no mensal: compara com (block.start..end-1) se end > start
  let prevRanked = null;
  if (end > block.start) {
    const prevEntries = [];
    for (const t of times) {
      const ptsPrev = await sumPoints(t.time_id, block.start, end - 1);
      prevEntries.push({ time_id: t.time_id, name: t.nome, cartoleiro: t.nome_cartola, pts: ptsPrev });
    }
    prevRanked = buildRankingRows(prevEntries);
  }

  const deltaMap = prevRanked ? diffPositions(
    ranked.map(x => ({ time_id: x.time_id })),
    prevRanked.map(x => ({ time_id: x.time_id }))
  ) : null;

  let out = `${header(ligaNome)}\n📅 MENSAL PERSONALIZADO: ${block.label}\n`;
  out += `📌 Considerado: Rodadas ${block.start} a ${end}\n\n`;

  if (ranked.every(x => x.pts === null)) {
    out += `Ainda sem pontuação no período (normal antes do fechamento/apuração).\n\n`;
    out += `🏅 Premiação prevista: TOP ${PREMIADOS_TOP}\n\n`;
    out += participantsBlock(times);
    return out.trim();
  }

  out += `🏅 Premiados do período (TOP ${PREMIADOS_TOP})\n`;
  ranked.slice(0, PREMIADOS_TOP).forEach((x, i) => {
    out += `${i + 1}. ${x.name} — ${fmt(x.pts)} pts\n`;
  });

  out += `\n📊 Classificação mensal (todos)\n`;
  ranked.forEach(x => {
    const d = deltaMap ? deltaMap.get(x.time_id) : null;
    out += `${String(x.pos).padStart(2, '0')}) ${x.name} (${x.cartoleiro}) — ${fmt(x.pts)} pts${emojiMove(d)}\n`;
  });

  // Destaques (simples e útil)
  const best = ranked.find(x => x.pts !== null);
  const worst = [...ranked].reverse().find(x => x.pts !== null);
  if (best && worst) {
    out += `\n⭐ Destaque positivo: ${best.name} (${fmt(best.pts)} pts)\n`;
    out += `💀 Destaque negativo: ${worst.name} (${fmt(worst.pts)} pts)\n`;
  }

  // Inclui o geral junto (como você pediu “classificação atual do geral”)
  out += `\n🏁 Geral (Rodadas 1 até ${rodadaAtual})\n`;
  const geralText = await buildGeral(ligaNome, times, rodadaAtual);
  out += geralText.split('\n').slice(3).join('\n'); // remove cabeçalho duplicado

  return out.trim();
}

// ===== Routes =====
app.get('/', (req, res) => res.status(200).send('OK'));

app.get('/debug', async (req, res) => {
  try {
    const status = await getMercadoStatus();
    const { ligaNome, times } = await getTeamsList();

    res.json({
      ok: true,
      now: new Date().toISOString(),
      nowBR: nowBR(),
      tokenConfigured: Boolean(BEARER),
      glbTagConfigured: Boolean(GLB_TAG),
      league: { slug: LEAGUE_SLUG, nome: ligaNome, totalTimes: times.length },
      rodada_atual: status.rodada_atual,
      status_mercado: status.status_mercado,
      fechamento: status.fechamento,
      mensalAtual: getMonthBlock(status.rodada_atual || 1),
      cacheSize: cache.size,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Texto: ranking da rodada
app.get('/rodada', async (req, res) => {
  try {
    const status = await getMercadoStatus();
    const rodadaAtual = status.rodada_atual || 1;

    const { ligaNome, times } = await getTeamsList();
    const msg = await buildRodada(ligaNome, times, rodadaAtual);

    res.type('text/plain').send(msg);
  } catch (e) {
    res.status(500).type('text/plain').send(`ERRO: ${e.message}`);
  }
});

// Texto: ranking geral (soma 1..rodadaAtual)
app.get('/geral', async (req, res) => {
  try {
    const status = await getMercadoStatus();
    const rodadaAtual = status.rodada_atual || 1;

    const { ligaNome, times } = await getTeamsList();
    const msg = await buildGeral(ligaNome, times, rodadaAtual);

    res.type('text/plain').send(msg);
  } catch (e) {
    res.status(500).type('text/plain').send(`ERRO: ${e.message}`);
  }
});

// Texto: mensal personalizado (seu calendário) + geral junto
app.get('/mensal', async (req, res) => {
  try {
    const status = await getMercadoStatus();
    const rodadaAtual = status.rodada_atual || 1;

    const { ligaNome, times } = await getTeamsList();
    const msg = await buildMensalPersonalizado(ligaNome, times, rodadaAtual);

    res.type('text/plain').send(msg);
  } catch (e) {
    res.status(500).type('text/plain').send(`ERRO: ${e.message}`);
  }
});

// (Opcional) endpoint para diagnóstico: ver o JSON cru de um time/rodada
app.get('/raw/time/:timeId/:rodada', async (req, res) => {
  try {
    const timeId = Number(req.params.timeId);
    const rodada = Number(req.params.rodada);
    const raw = await getTimeRoundRaw(timeId, rodada);
    res.json(raw);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server online na porta ${PORT}`);
});
