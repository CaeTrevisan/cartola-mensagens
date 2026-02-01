/**
 * server.js (CommonJS)
 * Requer: express, cors, axios
 *
 * ENV:
 *  - PORT
 *  - TZ (ex: America/Sao_Paulo)
 *  - LEAGUE_SLUG (ex: show-de-bola-araca-f-c)
 *  - CARTOLA_CLIENT_ID (ex: cartola-web@apps.globoid)
 *  - CARTOLA_REFRESH_TOKEN (refresh_token do GOIDC)
 *
 * Observação:
 * - Access token é renovado automaticamente via refresh_token.
 * - Liga privada: usa /auth/liga/... com Bearer token.
 */

const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ========== CONFIG ==========
const PORT = process.env.PORT || 3000;
const TZ = process.env.TZ || "America/Sao_Paulo";
const LEAGUE_SLUG = process.env.LEAGUE_SLUG || "show-de-bola-araca-f-c";

const CARTOLA_CLIENT_ID = process.env.CARTOLA_CLIENT_ID || "";
const CARTOLA_REFRESH_TOKEN = process.env.CARTOLA_REFRESH_TOKEN || "";

// Endpoints
const CARTOLA_API = "https://api.cartola.globo.com";
const GOIDC_TOKEN_URL =
  "https://goidc.globo.com/auth/realms/globo.com/protocol/openid-connect/token";

// Cache em memória (Render free reinicia às vezes, mas está ok)
let accessTokenCache = null;
let accessTokenExpMs = null; // epoch ms

// ========== HELPERS ==========

function nowIso() {
  return new Date().toISOString();
}

function nowBR() {
  try {
    return new Date().toLocaleString("pt-BR", { timeZone: TZ });
  } catch {
    return new Date().toLocaleString("pt-BR");
  }
}

function isConfigured() {
  return {
    refreshTokenConfigured: Boolean(CARTOLA_REFRESH_TOKEN),
    clientIdConfigured: Boolean(CARTOLA_CLIENT_ID),
  };
}

function decodeJwtPayload(token) {
  // JWT payload é a parte do meio
  const parts = (token || "").split(".");
  if (parts.length < 2) return null;
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const json = Buffer.from(b64 + pad, "base64").toString("utf8");
  return JSON.parse(json);
}

function setAccessToken(token) {
  accessTokenCache = token;

  // Tenta exp do JWT
  try {
    const payload = decodeJwtPayload(token);
    if (payload && payload.exp) {
      accessTokenExpMs = payload.exp * 1000;
      return;
    }
  } catch {}

  // Fallback: 4 min
  accessTokenExpMs = Date.now() + 4 * 60 * 1000;
}

function accessTokenValid() {
  if (!accessTokenCache || !accessTokenExpMs) return false;
  // margem de 30s
  return Date.now() < accessTokenExpMs - 30 * 1000;
}

async function refreshAccessToken() {
  const { refreshTokenConfigured, clientIdConfigured } = isConfigured();
  if (!refreshTokenConfigured || !clientIdConfigured) {
    throw new Error(
      "Refresh token ou client_id não configurados (CARTOLA_REFRESH_TOKEN / CARTOLA_CLIENT_ID)."
    );
  }

  // Form-url-encoded (padrão do OpenID token endpoint)
  const body = new URLSearchParams();
  body.append("grant_type", "refresh_token");
  body.append("client_id", CARTOLA_CLIENT_ID);
  body.append("refresh_token", CARTOLA_REFRESH_TOKEN);

  try {
    const resp = await axios.post(GOIDC_TOKEN_URL, body.toString(), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      timeout: 15000,
      validateStatus: () => true,
    });

    if (resp.status < 200 || resp.status >= 300) {
      const msg =
        resp.data?.error_description ||
        resp.data?.error ||
        JSON.stringify(resp.data || {});
      throw new Error(`HTTP ${resp.status} — ${msg}`);
    }

    const { access_token } = resp.data || {};
    if (!access_token) {
      throw new Error("Resposta sem access_token (inesperado).");
    }

    setAccessToken(access_token);
    return {
      ok: true,
      accessTokenExp: accessTokenExpMs ? new Date(accessTokenExpMs).toISOString() : null,
    };
  } catch (err) {
    // padroniza mensagem
    const m = err?.message || String(err);
    throw new Error(`Falha ao renovar token: ${m}`);
  }
}

async function ensureAccessToken() {
  if (accessTokenValid()) return accessTokenCache;
  await refreshAccessToken();
  return accessTokenCache;
}

async function cartolaGet(path, params = {}) {
  const token = await ensureAccessToken();

  const url = `${CARTOLA_API}${path}`;
  const resp = await axios.get(url, {
    params,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    timeout: 20000,
    validateStatus: () => true,
  });

  if (resp.status === 401) {
    // token expirou/invalidou no meio — tenta 1 refresh e repete
    await refreshAccessToken();
    const token2 = accessTokenCache;

    const resp2 = await axios.get(url, {
      params,
      headers: {
        Authorization: `Bearer ${token2}`,
        Accept: "application/json",
      },
      timeout: 20000,
      validateStatus: () => true,
    });

    return resp2;
  }

  return resp;
}

function safeNum(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : 0;
}

function formatPts(n) {
  // Cartola normalmente usa 2 casas
  return safeNum(n).toFixed(2).replace(".", ",");
}

function monthRanges() {
  // ranking mensal (personalizado) conforme você definiu
  return [
    { label: "jan/fev", start: 1, end: 4 },
    { label: "mar", start: 5, end: 8 },
    { label: "abr", start: 9, end: 13 },
    { label: "mai", start: 14, end: 18 },
    { label: "jul", start: 19, end: 21 },
    { label: "ago", start: 22, end: 25 },
    { label: "set", start: 26, end: 28 },
    { label: "out", start: 29, end: 33 },
    { label: "nov/dez", start: 34, end: 38 },
  ];
}

function currentMonthRange(rodadaAtual) {
  const ranges = monthRanges();
  return ranges.find((r) => rodadaAtual >= r.start && rodadaAtual <= r.end) || null;
}

// ========== ROUTES ==========

let lastWebhookAt = null;
let lastWebhookMethod = null;
let lastWebhookQuery = null;
let lastWebhookBody = null;

app.get("/", (req, res) => {
  res.json({ ok: true, now: nowIso(), nowBR: nowBR() });
});

app.get("/debug", (req, res) => {
  const conf = isConfigured();
  res.json({
    ok: true,
    now: nowIso(),
    nowBR: nowBR(),
    leagueSlug: LEAGUE_SLUG,
    accessTokenConfigured: Boolean(accessTokenCache),
    accessTokenExp: accessTokenExpMs ? new Date(accessTokenExpMs).toISOString() : null,
    refreshTokenConfigured: conf.refreshTokenConfigured,
    clientIdConfigured: conf.clientIdConfigured,
    clientIdValue: CARTOLA_CLIENT_ID || null,
    lastWebhookAt,
    lastWebhookMethod,
    lastWebhookQuery,
    lastWebhookBody,
  });
});

app.get("/refresh-test", async (req, res) => {
  try {
    const result = await refreshAccessToken();
    res.json({ ok: true, now: nowIso(), ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Captura o status do jogo (rodada atual etc) — sem auth normalmente
app.get("/status", async (req, res) => {
  try {
    const url = `${CARTOLA_API}/mercado/status`;
    const resp = await axios.get(url, { timeout: 20000, validateStatus: () => true });
    res.status(resp.status).json(resp.data);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Geral (campeonato)
app.get("/geral", async (req, res) => {
  try {
    const resp = await cartolaGet(`/auth/liga/${LEAGUE_SLUG}`, {
      orderBy: "campeonato",
      page: 1,
    });

    if (resp.status < 200 || resp.status >= 300) {
      return res.status(500).json({
        ok: false,
        error: `HTTP ${resp.status}`,
        data: resp.data,
      });
    }

    const data = resp.data || {};
    const times = Array.isArray(data.times) ? data.times : [];

    // ordena por pontos.campeonato (quando existir)
    const sorted = [...times].sort(
      (a, b) => safeNum(b?.pontos?.campeonato) - safeNum(a?.pontos?.campeonato)
    );

    // monta texto
    let txt = `🏆 *GERAL — ${data?.liga?.nome || "Liga"}*\n`;
    txt += `(${nowBR()})\n\n`;

    if (!sorted.length || sorted.every((t) => t?.pontos?.campeonato == null)) {
      txt += `Ainda sem pontuação no campeonato (aguardando início/fechamento da rodada).`;
      return res.type("text/plain").send(txt);
    }

    sorted.forEach((t, idx) => {
      const pos = idx + 1;
      const nome = t?.nome || t?.slug || "Time";
      const cartoleiro = t?.nome_cartola ? ` — ${t.nome_cartola}` : "";
      const pts = formatPts(t?.pontos?.campeonato);
      txt += `${pos}. ${nome}${cartoleiro} — ${pts}\n`;
    });

    return res.type("text/plain").send(txt);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// Rodada (ranking da rodada atual — depende do Cartola fornecer pontos.rodada)
app.get("/rodada", async (req, res) => {
  try {
    const statusUrl = `${CARTOLA_API}/mercado/status`;
    const st = await axios.get(statusUrl, { timeout: 20000, validateStatus: () => true });
    const rodadaAtual = st?.data?.rodada_atual;

    const resp = await cartolaGet(`/auth/liga/${LEAGUE_SLUG}`, {
      orderBy: "rodada",
      page: 1,
    });

    if (resp.status < 200 || resp.status >= 300) {
      return res.status(500).json({
        ok: false,
        error: `HTTP ${resp.status}`,
        data: resp.data,
      });
    }

    const data = resp.data || {};
    const times = Array.isArray(data.times) ? data.times : [];
    const sorted = [...times].sort(
      (a, b) => safeNum(b?.pontos?.rodada) - safeNum(a?.pontos?.rodada)
    );

    let txt = `⚽ *RODADA ${rodadaAtual ?? ""} — ${data?.liga?.nome || "Liga"}*\n`;
    txt += `(${nowBR()})\n\n`;

    if (!sorted.length || sorted.every((t) => t?.pontos?.rodada == null)) {
      txt += `Ainda sem pontuação da rodada (pode estar antes do fechamento, ou a API ainda não liberou ranking da rodada).`;
      return res.type("text/plain").send(txt);
    }

    sorted.forEach((t, idx) => {
      const pos = idx + 1;
      const nome = t?.nome || t?.slug || "Time";
      const cartoleiro = t?.nome_cartola ? ` — ${t.nome_cartola}` : "";
      const pts = formatPts(t?.pontos?.rodada);
      txt += `${pos}. ${nome}${cartoleiro} — ${pts}\n`;
    });

    return res.type("text/plain").send(txt);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// Mensal personalizado (Top 4 do “mês” e lista completa de participantes + geral)
app.get("/mensal", async (req, res) => {
  try {
    const st = await axios.get(`${CARTOLA_API}/mercado/status`, {
      timeout: 20000,
      validateStatus: () => true,
    });

    const rodadaAtual = st?.data?.rodada_atual || null;
    const faixa = rodadaAtual ? currentMonthRange(rodadaAtual) : null;

    // Geral (campeonato) pra exibir “classificação atual do geral”
    const respGeral = await cartolaGet(`/auth/liga/${LEAGUE_SLUG}`, {
      orderBy: "campeonato",
      page: 1,
    });

    if (respGeral.status < 200 || respGeral.status >= 300) {
      return res.status(500).json({
        ok: false,
        error: `HTTP ${respGeral.status}`,
        data: respGeral.data,
      });
    }

    const data = respGeral.data || {};
    const times = Array.isArray(data.times) ? data.times : [];

    // Enquanto a temporada não tiver pontos, avisa
    const hasChampPoints = times.some((t) => t?.pontos?.campeonato != null);

    let txt = `📅 *MENSAL (personalizado) — ${data?.liga?.nome || "Liga"}*\n`;
    txt += `(${nowBR()})\n\n`;

    if (!rodadaAtual) {
      txt += `Status da rodada não disponível agora.\n`;
    } else if (faixa) {
      txt += `Faixa vigente: *Rodadas ${faixa.start}–${faixa.end} (${faixa.label})*\n`;
    } else {
      txt += `Faixa vigente: (não identificada)\n`;
    }

    txt += `\n🏅 *Premiação do mês: TOP 4*\n`;

    // IMPORTANTE:
    // A API do Cartola não entrega diretamente "soma por intervalo personalizado" de rodadas.
    // Então, por enquanto, usamos o que existe com consistência:
    // - quando a API começar a preencher pontos.mes (mês oficial do Cartola), usamos isso como base.
    // - Se vier nulo, mostramos mensagem e seguimos com o geral.
    const sortedMensal = [...times].sort(
      (a, b) => safeNum(b?.pontos?.mes) - safeNum(a?.pontos?.mes)
    );

    const hasMonthPoints = sortedMensal.some((t) => t?.pontos?.mes != null);

    if (!hasMonthPoints) {
      txt += `Ainda sem pontuação “mês” disponível na API (isso deve aparecer após fechamento de rodadas).\n`;
    } else {
      sortedMensal.slice(0, 4).forEach((t, idx) => {
        const medal = ["🥇", "🥈", "🥉", "🎖"][idx] || "🏅";
        const nome = t?.nome || t?.slug || "Time";
        const cartoleiro = t?.nome_cartola ? ` — ${t.nome_cartola}` : "";
        const pts = formatPts(t?.pontos?.mes);
        txt += `${medal} ${idx + 1}. ${nome}${cartoleiro} — ${pts}\n`;
      });
    }

    // Lista de participantes
    txt += `\n👥 *Participantes (${times.length})*\n`;
    times.forEach((t) => {
      const nome = t?.nome || t?.slug || "Time";
      const cartoleiro = t?.nome_cartola ? ` — ${t.nome_cartola}` : "";
      txt += `• ${nome}${cartoleiro}\n`;
    });

    // Geral atual (do 1º ao último)
    txt += `\n🏆 *Geral (campeonato — do 1º ao último)*\n`;

    if (!hasChampPoints) {
      txt += `Ainda sem pontuação no geral (aguardando fechamento das rodadas iniciais).\n`;
      return res.type("text/plain").send(txt);
    }

    const sortedGeral = [...times].sort(
      (a, b) => safeNum(b?.pontos?.campeonato) - safeNum(a?.pontos?.campeonato)
    );

    sortedGeral.forEach((t, idx) => {
      const pos = idx + 1;
      const nome = t?.nome || t?.slug || "Time";
      const pts = formatPts(t?.pontos?.campeonato);
      txt += `${pos}. ${nome} — ${pts}\n`;
    });

    return res.type("text/plain").send(txt);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// Webhook “dummy” (mantive pra debug de POSTs, se precisar no futuro)
app.all("/webhook", (req, res) => {
  lastWebhookAt = nowIso();
  lastWebhookMethod = req.method;
  lastWebhookQuery = req.query || null;
  lastWebhookBody = req.body || null;
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
