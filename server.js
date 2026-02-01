// server.js (CommonJS) - Cartola Mensagens (sem WhatsApp)
// Requisitos: npm i express axios
// Env: LEAGUE_SLUG, CARTOLA_CLIENT_ID, CARTOLA_REFRESH_TOKEN, PORT, TZ

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;
const TZ = process.env.TZ || "America/Sao_Paulo";

const LEAGUE_SLUG = process.env.LEAGUE_SLUG || "show-de-bola-araca-f-c";
const CARTOLA_CLIENT_ID = process.env.CARTOLA_CLIENT_ID || "cartola-web@apps.globoid";
const CARTOLA_REFRESH_TOKEN = process.env.CARTOLA_REFRESH_TOKEN || "";

let accessToken = null;
let accessTokenExpMs = null;
let lastRefreshAt = null;
let lastRefreshError = null;

function nowIso() {
  return new Date().toISOString();
}

function tokenConfigured() {
  return !!(CARTOLA_REFRESH_TOKEN && CARTOLA_REFRESH_TOKEN.trim().length > 20);
}

function decodeJwtPayload(token) {
  // Sem dependência externa: decodifica base64url do payload do JWT
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const json = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function isAccessTokenValid() {
  if (!accessToken || !accessTokenExpMs) return false;
  // margem de 60s
  return Date.now() < (accessTokenExpMs - 60_000);
}

async function refreshAccessToken() {
  if (!tokenConfigured()) {
    throw new Error("CARTOLA_REFRESH_TOKEN não configurado no ambiente.");
  }

  // Endpoint OIDC padrão (Globo ID)
  const url = "https://goidc.globo.com/auth/realms/globo.com/protocol/openid-connect/token";

  const form = new URLSearchParams();
  form.append("grant_type", "refresh_token");
  form.append("client_id", CARTOLA_CLIENT_ID);
  form.append("refresh_token", CARTOLA_REFRESH_TOKEN);

  try {
    const resp = await axios.post(url, form.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 20000,
      validateStatus: () => true,
    });

    if (resp.status < 200 || resp.status >= 300) {
      const dataStr = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data);
      throw new Error(`HTTP ${resp.status} — ${dataStr}`);
    }

    const data = resp.data || {};
    if (!data.access_token) {
      throw new Error("Resposta não trouxe access_token.");
    }

    accessToken = data.access_token;

    // Preferir exp vindo do JWT; fallback em expires_in
    const payload = decodeJwtPayload(accessToken);
    if (payload && payload.exp) {
      accessTokenExpMs = payload.exp * 1000;
    } else if (data.expires_in) {
      accessTokenExpMs = Date.now() + (Number(data.expires_in) * 1000);
    } else {
      accessTokenExpMs = Date.now() + (10 * 60 * 1000);
    }

    lastRefreshAt = nowIso();
    lastRefreshError = null;

    return {
      ok: true,
      lastRefreshAt,
      exp: accessTokenExpMs ? new Date(accessTokenExpMs).toISOString() : null,
    };
  } catch (err) {
    lastRefreshAt = nowIso();
    lastRefreshError = err?.message || String(err);
    throw new Error(`Falha ao renovar token: ${lastRefreshError}`);
  }
}

async function getValidAccessToken() {
  if (isAccessTokenValid()) return accessToken;
  await refreshAccessToken();
  return accessToken;
}

async function cartolaGet(path) {
  const token = await getValidAccessToken();

  const url = `https://api.cartola.globo.com${path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "x-glb-app": "cartola_web",
    "x-glb-auth": "oidc",
  };

  // 1ª tentativa
  let resp = await axios.get(url, { headers, timeout: 20000, validateStatus: () => true });

  // Se expirou (401), renova e tenta uma vez de novo
  if (resp.status === 401) {
    await refreshAccessToken();
    const token2 = await getValidAccessToken();
    headers.Authorization = `Bearer ${token2}`;
    resp = await axios.get(url, { headers, timeout: 20000, validateStatus: () => true });
  }

  if (resp.status < 200 || resp.status >= 300) {
    const dataStr = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data);
    throw new Error(`HTTP ${resp.status} em ${url}\n${dataStr}`);
  }

  return resp.data;
}

// ---- Regras do "mensal personalizado"
const MONTH_WINDOWS = [
  { label: "Rodadas 1 a 4 (jan/fev)", start: 1, end: 4 },
  { label: "Rodadas 5 a 8 (mar)", start: 5, end: 8 },
  { label: "Rodadas 9 a 13 (abr)", start: 9, end: 13 },
  { label: "Rodadas 14 a 18 (mai)", start: 14, end: 18 },
  { label: "Rodadas 19 a 21 (jul)", start: 19, end: 21 },
  { label: "Rodadas 22 a 25 (ago)", start: 22, end: 25 },
  { label: "Rodadas 26 a 28 (set)", start: 26, end: 28 },
  { label: "Rodadas 29 a 33 (out)", start: 29, end: 33 },
  { label: "Rodadas 34 a 38 (nov/dez)", start: 34, end: 38 },
];

function windowForRound(round) {
  return MONTH_WINDOWS.find(w => round >= w.start && round <= w.end) || MONTH_WINDOWS[0];
}

function fmtPos(i) {
  const n = i + 1;
  if (n === 1) return "🥇";
  if (n === 2) return "🥈";
  if (n === 3) return "🥉";
  return `${n}º`;
}

function normalizeTeam(t) {
  return {
    time_id: t.time_id,
    nome: (t.nome || "").trim(),
    cartola: (t.nome_cartola || "").trim(),
    pontos_rodada: t?.pontos?.rodada ?? null,
    pontos_mes: t?.pontos?.mes ?? null,
    pontos_camp: t?.pontos?.campeonato ?? null,
    rank_rodada: t?.ranking?.rodada ?? null,
    rank_mes: t?.ranking?.mes ?? null,
    rank_camp: t?.ranking?.campeonato ?? null,
  };
}

function sortByNumberAscNullLast(getter) {
  return (a, b) => {
    const va = getter(a);
    const vb = getter(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return va - vb;
  };
}

// ---- Rotas
app.get("/", (req, res) => res.json({ ok: true }));

app.get("/debug", (req, res) => {
  const expIso = accessTokenExpMs ? new Date(accessTokenExpMs).toISOString() : null;
  res.json({
    ok: true,
    now: nowIso(),
    tz: TZ,
    leagueSlug: LEAGUE_SLUG,
    refreshTokenConfigured: tokenConfigured(),
    clientIdConfigured: !!CARTOLA_CLIENT_ID,
    clientIdValue: CARTOLA_CLIENT_ID,
    accessTokenInMemory: !!accessToken,
    accessTokenExp: expIso,
    lastRefreshAt,
    lastRefreshError,
  });
});

app.get("/refresh-test", async (req, res) => {
  try {
    const info = await refreshAccessToken();
    res.json({ ok: true, ...info });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// Busca dados da liga (privada -> /auth/liga)
async function fetchLeague(orderBy) {
  // Exemplo seu: /auth/liga/show-de-bola-araca-f-c?orderBy=campeonato&page=1
  const data = await cartolaGet(`/auth/liga/${encodeURIComponent(LEAGUE_SLUG)}?orderBy=${encodeURIComponent(orderBy)}&page=1`);
  return data;
}

app.get("/rodada", async (req, res) => {
  try {
    const data = await fetchLeague("rodada");
    const times = (data.times || []).map(normalizeTeam);

    // Se ainda não tem ranking/pontos, avisa
    const anyScore = times.some(t => t.pontos_rodada != null || t.rank_rodada != null);

    let msg = `🏁 ${data?.liga?.nome || "Liga"} — Rodada\n`;
    msg += `📅 ${nowIso()}\n\n`;

    if (!anyScore) {
      msg += "Ainda sem pontuação/ranking da rodada (provavelmente mercado aberto ou rodada não pontuada).\n";
      return res.type("text/plain").send(msg);
    }

    // Ordena por rank_rodada (1..n)
    const ordered = [...times].sort(sortByNumberAscNullLast(t => t.rank_rodada));

    msg += "📌 Ranking da Rodada\n";
    ordered.forEach((t, i) => {
      const pts = (t.pontos_rodada == null) ? "-" : t.pontos_rodada.toFixed(2);
      msg += `${fmtPos(i)} ${t.nome} (${t.cartola}) — ${pts} pts\n`;
    });

    res.type("text/plain").send(msg);
  } catch (err) {
    res.status(500).type("text/plain").send(`ERRO: ${err?.message || String(err)}`);
  }
});

app.get("/geral", async (req, res) => {
  try {
    const data = await fetchLeague("campeonato");
    const times = (data.times || []).map(normalizeTeam);

    const anyScore = times.some(t => t.pontos_camp != null || t.rank_camp != null);

    let msg = `🏆 ${data?.liga?.nome || "Liga"} — Ranking Geral\n`;
    msg += `📅 ${nowIso()}\n\n`;

    if (!anyScore) {
      msg += "Ainda sem pontuação/ranking geral (temporada recém-iniciada).\n";
      return res.type("text/plain").send(msg);
    }

    const ordered = [...times].sort(sortByNumberAscNullLast(t => t.rank_camp));

    msg += "📌 Classificação Geral (1ª até a última rodada)\n";
    ordered.forEach((t, i) => {
      const pts = (t.pontos_camp == null) ? "-" : t.pontos_camp.toFixed(2);
      msg += `${fmtPos(i)} ${t.nome} (${t.cartola}) — ${pts} pts\n`;
    });

    res.type("text/plain").send(msg);
  } catch (err) {
    res.status(500).type("text/plain").send(`ERRO: ${err?.message || String(err)}`);
  }
});

app.get("/mensal", async (req, res) => {
  try {
    // Pega rodada atual (público)
    const status = await axios.get("https://api.cartola.globo.com/status", {
      timeout: 15000,
      validateStatus: () => true
    });
    const rodadaAtual = status?.data?.rodada_atual || 1;
    const w = windowForRound(rodadaAtual);

    const data = await fetchLeague("mes");
    const times = (data.times || []).map(normalizeTeam);

    const anyMonthly = times.some(t => t.pontos_mes != null || t.rank_mes != null);

    let msg = `📆 ${data?.liga?.nome || "Liga"} — Mensal Personalizado\n`;
    msg += `🧩 Janela: ${w.label}\n`;
    msg += `📅 ${nowIso()}\n\n`;

    if (!anyMonthly) {
      msg += "Ainda sem pontuação/ranking mensal (vai aparecer conforme as rodadas começarem a pontuar).\n";
      return res.type("text/plain").send(msg);
    }

    // Ranking do mês
    const ordered = [...times].sort(sortByNumberAscNullLast(t => t.rank_mes));

    msg += "🏅 TOP 4 do mês (premiados)\n";
    ordered.slice(0, 4).forEach((t, i) => {
      const pts = (t.pontos_mes == null) ? "-" : t.pontos_mes.toFixed(2);
      msg += `${fmtPos(i)} ${t.nome} — ${pts} pts\n`;
    });

    msg += "\n📋 Participantes (todos)\n";
    ordered.forEach((t, i) => {
      const pts = (t.pontos_mes == null) ? "-" : t.pontos_mes.toFixed(2);
      msg += `${fmtPos(i)} ${t.nome} (${t.cartola}) — ${pts} pts\n`;
    });

    res.type("text/plain").send(msg);
  } catch (err) {
    res.status(500).type("text/plain").send(`ERRO: ${err?.message || String(err)}`);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
