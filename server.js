// server.js
import express from "express";
import axios from "axios";

const app = express();

// ============ CONFIG ============
const PORT = process.env.PORT || 3000;
const LEAGUE_SLUG = process.env.CARTOLA_LEAGUE_SLUG || "show-de-bola-araca-f-c";
const ACCESS_TOKEN = process.env.CARTOLA_ACCESS_TOKEN || ""; // access_token (Bearer)

// Base API
const CARTOLA_API = "https://api.cartola.globo.com";

// Segmentos mensais personalizados (TOP 4)
const MONTH_SEGMENTS = [
  { key: "jan-fev", label: "Rodadas 1 a 4 (jan/fev)", start: 1, end: 4 },
  { key: "mar", label: "Rodadas 5 a 8 (mar)", start: 5, end: 8 },
  { key: "abr", label: "Rodadas 9 a 13 (abr)", start: 9, end: 13 },
  { key: "mai", label: "Rodadas 14 a 18 (mai)", start: 14, end: 18 },
  { key: "jul", label: "Rodadas 19 a 21 (jul)", start: 19, end: 21 },
  { key: "ago", label: "Rodadas 22 a 25 (ago)", start: 22, end: 25 },
  { key: "set", label: "Rodadas 26 a 28 (set)", start: 26, end: 28 },
  { key: "out", label: "Rodadas 29 a 33 (out)", start: 29, end: 33 },
  { key: "nov-dez", label: "Rodadas 34 a 38 (nov/dez)", start: 34, end: 38 },
];

// ============ HELPERS ============
function authHeaders() {
  if (!ACCESS_TOKEN) return {};
  return { Authorization: `Bearer ${ACCESS_TOKEN}` };
}

function isLikelyExpired(err) {
  const status = err?.response?.status;
  const data = err?.response?.data;
  // Cartola costuma responder 401 com {"mensagem":"Expired"} quando token expira
  return status === 401 && (data?.mensagem === "Expired" || String(data).includes("Expired"));
}

function friendlyAuthHint() {
  return (
    "Token expirado. Pegue um NOVO access token no Cartola Web:\n" +
    "DevTools > Network > filtro 'token' > request 'token' ou 'refresh-token' > Response > access_token.\n" +
    "Depois atualize CARTOLA_ACCESS_TOKEN no Render e faça redeploy."
  );
}

async function getMarketStatus() {
  // Endpoint público (normalmente): /mercado/status
  const url = `${CARTOLA_API}/mercado/status`;
  const { data } = await axios.get(url, { timeout: 15000 });
  return data;
}

async function getLeague(orderBy = "campeonato", page = 1) {
  // Liga privada geralmente exige /auth/liga/...
  const url = `${CARTOLA_API}/auth/liga/${LEAGUE_SLUG}?orderBy=${encodeURIComponent(
    orderBy
  )}&page=${page}`;
  const { data } = await axios.get(url, { headers: authHeaders(), timeout: 20000 });
  return data;
}

/**
 * Tentativa de buscar pontuação por rodada do time.
 * Observação: este endpoint pode variar/bloquear conforme a temporada/ambiente.
 * Se falhar, a rota /mensal retorna uma mensagem amigável.
 */
async function getTeamPointsByRound(timeId) {
  const url = `${CARTOLA_API}/time/id/${timeId}/pontuacao`;
  const { data } = await axios.get(url, { headers: authHeaders(), timeout: 20000 });
  return data; // esperado: objeto com rodadas/pontuacoes
}

function formatRow(pos, teamName, coachName, points, highlight = false) {
  const medal =
    pos === 1 ? "🥇" : pos === 2 ? "🥈" : pos === 3 ? "🥉" : pos === 4 ? "🏅" : "•";
  const p = points == null ? "-" : Number(points).toFixed(2).replace(".", ",");
  const base = `${medal} ${pos}º ${teamName} — ${p}`;
  return highlight ? `⭐ ${base}` : base;
}

function nowBR() {
  return new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

function pickMonthlySegment(rodadaAtual) {
  return (
    MONTH_SEGMENTS.find((s) => rodadaAtual >= s.start && rodadaAtual <= s.end) ||
    MONTH_SEGMENTS[0]
  );
}

// ============ ROUTES ============
app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "Cartola Mensagens (Opção A / Sem refresh)",
    routes: ["/debug", "/participantes", "/rodada", "/geral", "/mensal"],
  });
});

app.get("/debug", async (req, res) => {
  let mercado = null;
  try {
    mercado = await getMarketStatus();
  } catch (e) {
    mercado = { error: "Falha ao consultar /mercado/status", detail: e?.message };
  }

  res.json({
    ok: true,
    now: new Date().toISOString(),
    nowBR: nowBR(),
    leagueSlug: LEAGUE_SLUG,
    accessTokenConfigured: Boolean(ACCESS_TOKEN),
    market: mercado,
    hint:
      "Se /rodada ou /geral der 401 Expired, atualize CARTOLA_ACCESS_TOKEN no Render. (Sem refresh token).",
  });
});

app.get("/participantes", async (req, res) => {
  try {
    const league = await getLeague("campeonato", 1);
    const times = Array.isArray(league?.times) ? league.times : [];

    const lista = times.map((t) => ({
      time: t?.nome?.trim(),
      cartoleiro: t?.nome_cartola?.trim(),
      time_id: t?.time_id,
      assinante: Boolean(t?.assinante),
    }));

    res.json({
      ok: true,
      liga: league?.liga?.nome,
      total: lista.length,
      participantes: lista,
    });
  } catch (err) {
    if (isLikelyExpired(err)) {
      return res.status(401).json({ ok: false, error: "Expired", messageFriendly: friendlyAuthHint() });
    }
    res.status(err?.response?.status || 500).json({
      ok: false,
      error: err?.message || "Erro",
      data: err?.response?.data || null,
    });
  }
});

app.get("/rodada", async (req, res) => {
  try {
    const mercado = await getMarketStatus();
    const rodadaAtual = mercado?.rodada_atual ?? null;

    const league = await getLeague("rodada", 1);
    const times = Array.isArray(league?.times) ? league.times : [];

    // pontos.rodada pode ser null antes de começar
    const sorted = [...times].sort((a, b) => (b?.pontos?.rodada ?? -999999) - (a?.pontos?.rodada ?? -999999));

    const top = sorted
      .filter((t) => t?.pontos?.rodada != null)
      .slice(0, 10)
      .map((t, idx) => ({
        pos: idx + 1,
        time: t?.nome?.trim(),
        cartoleiro: t?.nome_cartola?.trim(),
        pontos: t?.pontos?.rodada,
      }));

    // Texto pronto para colar
    let texto = `🏟️ *${league?.liga?.nome || "Liga"}*\n`;
    texto += `📅 *Rodada:* ${mercado?.nome_rodada || (rodadaAtual ? `Rodada ${rodadaAtual}` : "-")}\n`;
    texto += `🕒 *Gerado em:* ${nowBR()}\n\n`;

    if (!top.length) {
      texto += `⚠️ Ainda sem pontuação de rodada (campeonato não começou ou rodada não pontuou ainda).\n`;
    } else {
      texto += `📌 *TOP ${top.length} da Rodada*\n`;
      top.forEach((r) => {
        texto += `${formatRow(r.pos, r.time, r.cartoleiro, r.pontos)}\n`;
      });
    }

    res.json({ ok: true, rodadaAtual, texto, top });
  } catch (err) {
    if (isLikelyExpired(err)) {
      return res.status(401).json({ ok: false, error: "Expired", messageFriendly: friendlyAuthHint() });
    }
    res.status(err?.response?.status || 500).json({
      ok: false,
      error: err?.message || "Erro",
      data: err?.response?.data || null,
    });
  }
});

app.get("/geral", async (req, res) => {
  try {
    const mercado = await getMarketStatus();
    const rodadaAtual = mercado?.rodada_atual ?? null;

    const league = await getLeague("campeonato", 1);
    const times = Array.isArray(league?.times) ? league.times : [];

    // ranking.campeonato e pontos.campeonato geralmente aparecem após começar
    const sorted = [...times].sort((a, b) => (b?.pontos?.campeonato ?? -999999) - (a?.pontos?.campeonato ?? -999999));

    const lista = sorted.map((t, idx) => ({
      pos: idx + 1,
      time: t?.nome?.trim(),
      cartoleiro: t?.nome_cartola?.trim(),
      pontos: t?.pontos?.campeonato,
    }));

    // Texto pronto para colar: todos participantes + destaque top 4
    let texto = `🏆 *${league?.liga?.nome || "Liga"}*\n`;
    texto += `📊 *Classificação Geral*\n`;
    texto += `📅 *Rodada atual:* ${mercado?.nome_rodada || (rodadaAtual ? `Rodada ${rodadaAtual}` : "-")}\n`;
    texto += `🕒 *Gerado em:* ${nowBR()}\n\n`;

    if (!lista.some((x) => x.pontos != null)) {
      texto += `⚠️ Ainda sem pontuação geral (campeonato não começou ou não pontuou ainda).\n`;
    } else {
      texto += `⭐ *Destaques (TOP 4)*\n`;
      lista.slice(0, 4).forEach((r) => (texto += `${formatRow(r.pos, r.time, r.cartoleiro, r.pontos, true)}\n`));
      texto += `\n📋 *Todos os participantes*\n`;
      lista.forEach((r) => (texto += `${formatRow(r.pos, r.time, r.cartoleiro, r.pontos)}\n`));
    }

    res.json({ ok: true, rodadaAtual, texto, ranking: lista });
  } catch (err) {
    if (isLikelyExpired(err)) {
      return res.status(401).json({ ok: false, error: "Expired", messageFriendly: friendlyAuthHint() });
    }
    res.status(err?.response?.status || 500).json({
      ok: false,
      error: err?.message || "Erro",
      data: err?.response?.data || null,
    });
  }
});

app.get("/mensal", async (req, res) => {
  try {
    const mercado = await getMarketStatus();
    const rodadaAtual = mercado?.rodada_atual ?? 1;
    const segment = pickMonthlySegment(rodadaAtual);

    const league = await getLeague("campeonato", 1);
    const times = Array.isArray(league?.times) ? league.times : [];

    // Se ainda não começou (pontos tudo null), devolve mensagem pronta
    const hasAnyPoints = times.some((t) => t?.pontos?.campeonato != null || t?.pontos?.rodada != null);
    if (!hasAnyPoints) {
      const texto =
        `🗓️ *Mensal (personalizado) — ${segment.label}*\n` +
        `🏟️ *${league?.liga?.nome || "Liga"}*\n` +
        `🕒 *Gerado em:* ${nowBR()}\n\n` +
        `⚠️ Ainda sem pontuação (campeonato não começou / sem rodada pontuada).\n`;
      return res.json({ ok: true, segment, texto, ranking: [] });
    }

    // Tenta calcular "mensal personalizado" somando pontuações por rodada dentro do segmento
    // Se o endpoint de pontuação por rodada falhar, retornamos orientação simples.
    const calc = [];
    for (const t of times) {
      const timeId = t?.time_id;
      const nome = t?.nome?.trim();
      const cartoleiro = t?.nome_cartola?.trim();

      let total = null;

      try {
        const hist = await getTeamPointsByRound(timeId);

        // Possíveis formatos. Tentamos cobrir:
        // 1) hist é array: [{ rodada: 1, pontos: 123.45 }, ...]
        // 2) hist.pontuacao é objeto: { "1": 123.45, "2": 98.76, ... }
        if (Array.isArray(hist)) {
          total = hist
            .filter((x) => x?.rodada >= segment.start && x?.rodada <= segment.end)
            .reduce((sum, x) => sum + (Number(x?.pontos) || 0), 0);
        } else if (hist && typeof hist === "object" && hist.pontuacao && typeof hist.pontuacao === "object") {
          total = 0;
          for (let r = segment.start; r <= segment.end; r++) {
            total += Number(hist.pontuacao[String(r)] || 0);
          }
        } else {
          // formato desconhecido
          total = null;
        }
      } catch (e) {
        // Se falhar, deixamos null e seguimos
        total = null;
      }

      calc.push({ time_id: timeId, time: nome, cartoleiro, pontos: total });
    }

    const okToRank = calc.some((x) => x.pontos != null);
    if (!okToRank) {
      const texto =
        `🗓️ *Mensal (personalizado) — ${segment.label}*\n` +
        `🏟️ *${league?.liga?.nome || "Liga"}*\n` +
        `🕒 *Gerado em:* ${nowBR()}\n\n` +
        `⚠️ Não consegui calcular o “mensal personalizado” automaticamente (endpoint de pontuação por rodada não respondeu no servidor).\n` +
        `✅ Você ainda pode usar /geral e /rodada normalmente.\n`;
      return res.json({ ok: true, segment, texto, ranking: [] });
    }

    const ranking = calc
      .filter((x) => x.pontos != null)
      .sort((a, b) => b.pontos - a.pontos)
      .map((x, idx) => ({ ...x, pos: idx + 1 }));

    // Texto pronto para colar (TOP 4 + todos)
    let texto = `🗓️ *Mensal (personalizado) — ${segment.label}*\n`;
    texto += `🏟️ *${league?.liga?.nome || "Liga"}*\n`;
    texto += `🕒 *Gerado em:* ${nowBR()}\n\n`;

    texto += `⭐ *Premiados do mês (TOP 4)*\n`;
    ranking.slice(0, 4).forEach((r) => {
      texto += `${formatRow(r.pos, r.time, r.cartoleiro, r.pontos, true)}\n`;
    });

    texto += `\n📋 *Todos os participantes (mensal)*\n`;
    ranking.forEach((r) => {
      texto += `${formatRow(r.pos, r.time, r.cartoleiro, r.pontos)}\n`;
    });

    res.json({ ok: true, segment, texto, ranking });
  } catch (err) {
    if (isLikelyExpired(err)) {
      return res.status(401).json({ ok: false, error: "Expired", messageFriendly: friendlyAuthHint() });
    }
    res.status(err?.response?.status || 500).json({
      ok: false,
      error: err?.message || "Erro",
      data: err?.response?.data || null,
    });
  }
});

// Health
app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`✅ Server on port ${PORT}`);
  console.log(`✅ League: ${LEAGUE_SLUG}`);
  console.log(`✅ Token configured: ${Boolean(ACCESS_TOKEN)}`);
});
