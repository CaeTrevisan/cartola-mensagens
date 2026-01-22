'use strict';

const fs = require('fs');
const path = require('path');

const LEAGUE_SLUG = process.env.CARTOLA_LEAGUE_SLUG || 'show-de-bola-araca-f-c';
const PREMIADOS_TOP = Number(process.env.PREMIADOS_TOP || '4');

// Opcional (contingência): Bearer do DevTools (expira)
const CARTOLA_BEARER = process.env.CARTOLA_BEARER || '';

// Headers “fixos” que você mostrou
const BASE_HEADERS = {
  'accept': '*/*',
  'origin': 'https://cartola.globo.com',
  'referer': 'https://cartola.globo.com/',
  'user-agent': process.env.CARTOLA_UA || 'Mozilla/5.0',
  'x-glb-app': 'cartola_web',
  'x-glb-auth': 'oidc',
  // este x-glb-tag pode mudar; se falhar, você pode remover ou atualizar
  'x-glb-tag': process.env.CARTOLA_GLB_TAG || ''
};

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
  return Number(n).toFixed(2).replace('.', ',');
}

async function fetchJson(url, { useAuth = false } = {}) {
  const headers = { ...BASE_HEADERS };
  // só adiciona tag se existir
  if (!headers['x-glb-tag']) delete headers['x-glb-tag'];

  if (useAuth && CARTOLA_BEARER) {
    headers['authorization'] = `Bearer ${CARTOLA_BEARER}`;
  }

  const res = await fetch(url, { headers });
  const text = await res.text();

  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} em ${url}\n${text.slice(0, 300)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return JSON.parse(text);
}

// tenta público -> se falhar, tenta autenticado
async function fetchSmart(url) {
  try {
    return await fetchJson(url, { useAuth: false });
  } catch (e) {
    // 401/403 costuma indicar que exigiu auth
    if ((e.status === 401 || e.status === 403) && CARTOLA_BEARER) {
      return await fetchJson(url, { useAuth: true });
    }
    throw e;
  }
}

function line(pos, timeNome, cartoleiro, pontos) {
  return `${String(pos).padStart(2, '0')}) ${timeNome} (${cartoleiro}) — ${fmt(pontos)} pts`;
}

function textHeader(ligaNome) {
  return `🏆 ${ligaNome}\n🕒 Gerado em ${nowBR()}\n`;
}

function buildRodadaMsg(ligaNome, rodadaAtual, times) {
  // se ainda sem pontos, vai tudo null
  const list = [...times].sort((a, b) => {
    const av = a?.ranking?.rodada ?? 999999;
    const bv = b?.ranking?.rodada ?? 999999;
    return av - bv;
  });

  let out = `${textHeader(ligaNome)}\n📊 RANKING DA RODADA ${rodadaAtual}\n\n`;

  if (list.every(t => t?.pontos?.rodada == null)) {
    out += `Ainda sem pontuação de rodada (normal antes do fechamento/apuração).\n`;
  } else {
    list.forEach((t, i) => {
      out += line(i + 1, t.nome.trim(), t.nome_cartola.trim(), t.pontos.rodada) + '\n';
    });
  }

  out += `\n👥 Participantes (${times.length})\n`;
  times.forEach(t => {
    out += `• ${t.nome.trim()} — ${t.nome_cartola.trim()}\n`;
  });

  return out.trim();
}

function buildGeralMsg(ligaNome, rodadaAtual, times) {
  const list = [...times].sort((a, b) => {
    const av = a?.ranking?.campeonato ?? 999999;
    const bv = b?.ranking?.campeonato ?? 999999;
    return av - bv;
  });

  let out = `${textHeader(ligaNome)}\n🏁 RANKING GERAL (Rodadas 1 até ${rodadaAtual})\n\n`;

  if (list.every(t => t?.pontos?.campeonato == null)) {
    out += `Ainda sem ranking geral (vai aparecer após fechar rodadas).\n`;
  } else {
    list.forEach((t, i) => {
      out += line(i + 1, t.nome.trim(), t.nome_cartola.trim(), t.pontos.campeonato) + '\n';
    });
  }

  return out.trim();
}

function buildMensalMsg(ligaNome, rodadaAtual, monthBlock, times) {
  // OBS: O JSON atual vem com pontos.mes/ranking.mes (pode ou não refletir seu “mensal personalizado”).
  // Então: enquanto o Cartola não der “mes” alinhado ao seu calendário, aqui vamos:
  // 1) Exibir o “mensal oficial” se existir (pontos.mes)
  // 2) E manter pronto para “mensal personalizado por somatório” (fase 2, usando time/id/{id}/{rodada})

  const listMes = [...times].sort((a, b) => {
    const av = a?.ranking?.mes ?? 999999;
    const bv = b?.ranking?.mes ?? 999999;
    return av - bv;
  });

  let out = `${textHeader(ligaNome)}\n📅 MENSAL PERSONALIZADO: ${monthBlock.label}\n🏅 Premiados (TOP ${PREMIADOS_TOP})\n\n`;

  if (listMes.every(t => t?.pontos?.mes == null)) {
    out += `Ainda sem pontos do mês no Cartola (normal antes do início/apuração).\n\n`;
    out += `✅ Assim que houver pontuação, eu gero TOP ${PREMIADOS_TOP} e o ranking completo.\n`;
  } else {
    const top = listMes.slice(0, PREMIADOS_TOP);
    top.forEach((t, i) => {
      out += `${i + 1}. ${t.nome.trim()} — ${fmt(t.pontos.mes)} pts\n`;
    });

    out += `\n📊 Classificação mensal (todos)\n`;
    listMes.forEach((t, i) => {
      out += line(i + 1, t.nome.trim(), t.nome_cartola.trim(), t.pontos.mes) + '\n';
    });
  }

  out += `\n\n🏁 Geral (1 até ${rodadaAtual})\n`;
  out += buildGeralMsg(ligaNome, rodadaAtual, times).split('\n').slice(3).join('\n'); // reaproveita sem cabeçalho

  return out.trim();
}

function writeDocs(files) {
  const docsDir = path.join(process.cwd(), 'docs');
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir);

  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(docsDir, name), content, 'utf8');
  }
}

function htmlIndex() {
  return `<!doctype html>
<html lang="pt-br">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Cartola — Mensagens</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;padding:18px;max-width:900px;margin:0 auto}
    a{display:block;margin:10px 0;font-size:16px}
    small{opacity:.7}
  </style>
</head>
<body>
  <h2>Cartola — Mensagens prontas</h2>
  <a href="./rodada.txt">📊 Rodada (texto)</a>
  <a href="./mensal.txt">📅 Mensal (texto)</a>
  <a href="./geral.txt">🏁 Geral (texto)</a>
  <a href="./status.json">🔧 Status (JSON)</a>
  <small>Abra um arquivo .txt, copie e cole no grupo.</small>
</body>
</html>`;
}

(async () => {
  // 1) status do mercado (rodada atual)
  const status = await fetchSmart('https://api.cartola.globo.com/mercado/status');
  const rodadaAtual = status.rodada_atual || 1;

  // 2) liga (com times + rankings/pontos quando existirem)
  // preferimos /auth/liga (igual ao seu)
  const ligaData = await fetchSmart(`https://api.cartola.globo.com/auth/liga/${LEAGUE_SLUG}?orderBy=campeonato&page=1`);

  const ligaNome = ligaData?.liga?.nome || 'Liga';
  const times = ligaData?.times || [];
  const monthBlock = getMonthBlock(rodadaAtual);

  const rodadaMsg = buildRodadaMsg(ligaNome, rodadaAtual, times);
  const geralMsg = buildGeralMsg(ligaNome, rodadaAtual, times);
  const mensalMsg = buildMensalMsg(ligaNome, rodadaAtual, monthBlock, times);

  writeDocs({
    'index.html': htmlIndex(),
    'rodada.txt': rodadaMsg,
    'geral.txt': geralMsg,
    'mensal.txt': mensalMsg,
    'status.json': JSON.stringify({
      generatedAt: new Date().toISOString(),
      generatedAtBR: nowBR(),
      rodadaAtual,
      status_mercado: status.status_mercado,
      fechamento: status.fechamento,
      liga: { slug: LEAGUE_SLUG, nome: ligaNome, totalTimes: times.length },
      mensalAtual: monthBlock,
      premiadosTop: PREMIADOS_TOP,
      usedAuth: Boolean(CARTOLA_BEARER)
    }, null, 2)
  });

  console.log('OK: docs gerados.');
})().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
