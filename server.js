'use strict';

const express = require('express');

const app = express();
app.use(express.json({ limit: '1mb' }));

// ===== Config =====
const LEAGUE_SLUG = process.env.CARTOLA_LEAGUE_SLUG || 'show-de-bola-araca-f-c';
const LIGA_ID = Number(process.env.CARTOLA_LIGA_ID || '0') || 0;

const BEARER = (process.env.CARTOLA_BEARER || '').trim(); // SEM "Bearer "
const GLB_TAG = (process.env.CARTOLA_GLB_TAG || '').trim();
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

// Tenta público -> se falhar por 401/403, tenta com Bearer
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

function line(pos, timeNome, cartoleiro, pontos) {
  return `${String(pos).padStart(2, '0')}) ${timeNome} (${cartoleiro}) — ${fmt(pontos)} pts`;
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
    return av - bv; // menor ranking = melhor
  });
}

function header(ligaNome) {
  return `🏆 ${ligaNome}\n🕒 ${nowBR()}\n`;
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

/**
 * Mensal personalizado (por bloco de rodadas)
 * Versão 1: enquanto a API não traz pontos por rodada para o "mês" do jeito que você quer,
 * vamos usar (se existir) pontos.mes como base.
 * Próxima evolução (fase 2): somar rodada a rodada via endpoint /time/id/{time_id}/{rodada}.
 */
function buildMensalMsg(ligaNome, rodadaAtual, monthBlock, times) {
  const list = sortByRank(times, t => t?.ranking?.mes);
  let out = `${header(ligaNome)}\n📅 MENSAL PERSONALIZADO: ${monthBlock.label}\n\n`;

  if (list.every(t => t?.pontos?.mes == null)) {
    out += `Ainda sem pontos do mês no Cartola (normal antes do início/apuração).\n\n`;
    out += `🏅 Premiação prevista: TOP ${PREMIADOS_TOP}\n\n`;
    out += listParticipants(times);
    return out.trim();
  }

  out += `🏅 Premiados do período (TOP ${PREMIADOS_TOP})\n`;
  list.slice(0, PREMIADOS_TOP).forEach((t, i) => {
    out += `${i + 1}. ${String(t.nome).trim()} — ${fmt(t.pontos.mes)} pts\n`;
  });

  out += `\n📊 Classificação mensal (todos)\n`;
  list.forEach((t, i) => {
    out += line(i + 1, String(t.nome).trim(), String(t.nome_cartola).trim(), t.pontos.mes) + '\n';
  });

  out += `\n🏁 Geral (1 até ${rodadaAtual})\n`;
  const geral = sortByRank(times, t => t?.ranking?.campeonato);
  if (geral.every(t => t?.pontos?.campeonato == null)) {
    out += `Ainda sem ranking geral.\n`;
  } else {
    geral.forEach((t, i) => {
      out += `${i + 1}. ${String(t.nome).trim()} — ${fmt(t.pontos.campeonato)} pts\n`;
    });
  }

  return out.trim();
}

// ===== Rotas =====
app.get('/', (req, res) => res.status(200).send('OK'));

app.get('/debug', async (req, res) => {
  try {
    const status = await fetchSmart('https://api.cartola.globo.com/mercado/status');
    res.json({
      ok: true,
      now: new Date().toISOString(),
      nowBR: nowBR(),
      rodada_atual: status.rodada_atual,
      status_mercado: status.status_mercado,
      fechamento: status.fechamento,
      tokenConfigured: Boolean(BEARER),
      glbTagConfigured: Boolean(GLB_TAG),
      league: { slug: LEAGUE_SLUG, ligaId: LIGA_ID, premiadosTop: PREMIADOS_TOP }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/rodada', async (req, res) => {
  try {
    const status = await fetchSmart('https://api.cartola.globo.com/mercado/status');
    const rodadaAtual = status.rodada_atual || 1;

    const ligaData = await fetchSmart(`https://api.cartola.globo.com/auth/liga/${LEAGUE_SLUG}?orderBy=rodada&page=1`);
    const ligaNome = ligaData?.liga?.nome || 'Liga';
    const times = ligaData?.times || [];

    res.type('text/plain').send(buildRodadaMsg(ligaNome, rodadaAtual, times));
  } catch (e) {
    res.status(500).type('text/plain').send(`ERRO: ${e.message}`);
  }
});

app.get('/geral', async (req, res) => {
  try {
    const status = await fetchSmart('https://api.cartola.globo.com/mercado/status');
    const rodadaAtual = status.rodada_atual || 1;

    const ligaData = await fetchSmart(`https://api.cartola.globo.com/auth/liga/${LEAGUE_SLUG}?orderBy=campeonato&page=1`);
    const ligaNome = ligaData?.liga?.nome || 'Liga';
    const times = ligaData?.times || [];

    res.type('text/plain').send(buildGeralMsg(ligaNome, rodadaAtual, times));
  } catch (e) {
    res.status(500).type('text/plain').send(`ERRO: ${e.message}`);
  }
});

app.get('/mensal', async (req, res) => {
  try {
    const status = await fetchSmart('https://api.cartola.globo.com/mercado/status');
    const rodadaAtual = status.rodada_atual || 1;
    const monthBlock = getMonthBlock(rodadaAtual);

    const ligaData = await fetchSmart(`https://api.cartola.globo.com/auth/liga/${LEAGUE_SLUG}?orderBy=mes&page=1`);
    const ligaNome = ligaData?.liga?.nome || 'Liga';
    const times = ligaData?.times || [];

    res.type('text/plain').send(buildMensalMsg(ligaNome, rodadaAtual, monthBlock, times));
  } catch (e) {
    res.status(500).type('text/plain').send(`ERRO: ${e.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`Server online na porta ${PORT}`);
});
