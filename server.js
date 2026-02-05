/**
 * server.js — Cartola Mensagens (sem WhatsApp)
 * - Não usa axios (usa fetch nativo do Node 18+)
 * - Faz refresh automático do token via goidc.globo.com (OIDC)
 * - Endpoints:
 *   GET /debug
 *   GET /rodada
 *   GET /geral
 *   GET /mensal   (mensal personalizado)
 */

const http = require("http");
const { URL } = require("url");

// ====== ENV ======
const PORT = process.env.PORT || 3000;

const LEAGUE_SLUG = process.env.CARTOLA_LEAGUE_SLUG || "show-de-bola-araca-f-c";
const CLIENT_ID = process.env.CARTOLA_CLIENT_ID || "cartola-web@apps.globoid";
const REFRESH_TOKEN_ENV = process.env.CARTOLA_REFRESH_TOKEN;

// OIDC token endpoint (Globo ID)
const OIDC_TOKEN_URL =
  "https://goidc.globo.com/auth/realms/globo.com/protocol/openid-connect/token";

// Cartola API base
const CARTOLA_API = "https://api.cartola.globo.com";

// ====== Token cache (em memória) ======
let accessToken = null;
let accessTokenExpEpoch = null; // segundos UNIX
let refreshToken = REFRESH_TOKEN_ENV || null;

let lastRefreshAt = null;
let lastRefreshError = null;

// ====== Helpers ======
function json(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function text(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function nowEpochSec() {
  return Math.floor(Date.now() / 1000);
}

function safeBool(v) {
  return !!(v && String(v).trim().length > 0);
}

function decodeJwtPayload(token) {
  // retorna payload do JWT (sem validar assinatura)
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = parts[1];
    const padded = payload.replace(/-/g, "+").replace(/_/g, "/");
    const buff = Buffer.from(padded, "base64");
    return JSON.parse(buff.toString("utf8"));
  } catch {
    return null;
  }
}

function buildFormUrlEncoded(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    usp.set(k, v);
  }
  return usp.toString();
}

// ====== OIDC Refresh ======
async function refreshAccessToken() {
  if (!safeBool(refreshToken)) {
    throw new Error("refresh_token não configurado (CARTOLA_REFRESH_TOKEN).");
  }
  if (!safeBool(CLIENT_ID)) {
    throw new Error("client_id não configurado (CARTOLA_CLIENT_ID).");
  }

  const body = buildFormUrlEncoded({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  });

  const resp = await fetch(OIDC_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    },
    body,
  });

  const raw = await resp.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    data = { raw };
  }

  if (!resp.ok) {
    // Guardar para debug
    lastRefreshAt = new Date().toISOString();
    lastRefreshError = {
      status: resp.status,
      data,
    };
    throw new Error(
      `Falha ao renovar token: HTTP ${resp.status} — ${typeof data === "object" ? JSON.stringify(data) : String(data)}`
    );
  }

  // Esperado: access_token, expires_in, refresh_token (às vezes)
  accessToken = data.access_token;
  lastRefreshAt = new Date().toISOString();
  lastRefreshError = null;

  // Expiração: preferir "exp" do JWT; senão usar expires_in
  const payload = decodeJwtPayload(accessToken);
  if (payload && payload.exp) {
    accessTokenExpEpoch = payload.exp;
  } else if (data.expires_in) {
    accessTokenExpEpoch = nowEpochSec() + Number(data.expires_in);
  } else {
    accessTokenExpEpoch = nowEpochSec() + 300; // fallback 5 min
  }

  // Se vier refresh_token novo, guardamos em memória (não expomos em endpoints)
  if (data.refresh_token && String(data.refresh_token).startsWith("eyJ")) {
    refreshToken = data.refresh_token;
  }

  return { ok: true };
}

async function ensureAccessToken() {
  // Renova se não tem token ou se está para expirar (<60s)
  const now = nowEpochSec();
  if (!accessToken || !accessTokenExpEpoch || accessTokenExpEpoch < now + 60) {
    await refreshAccessToken();
  }
  return accessToken;
}

// ====== Cartola request (com retry automático) ======
async function cartolaFetchJson(path, { auth = true } = {}) {
  const url = `${CARTOLA_API}${path}`;

  // 1ª tentativa
  let token = null;
  if (auth) token = await ensureAccessToken();

  let resp = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      ...(auth
        ? {
            "Authorization": `Bearer ${token}`,
            "x-glb-app": "cartola_web",
            "x-glb-auth": "oidc",
          }
        : {}),
    },
  });

  // Se 401/Expired, tenta refresh + retry 1x
  if (resp.status === 401 && auth) {
    // força refresh
    await refreshAccessToken();

    token = await ensureAccessToken();
    resp = await fetch(url, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "Authorization": `Bearer ${token}`,
        "x-glb-app": "cartola_web",
        "x-glb-auth": "oidc",
      },
    });
  }

  const raw = await resp.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    data = { raw };
  }

  if (!resp.ok) {
    const msg =
      data && data.mensagem
        ? data.mensagem
        : `HTTP note ok (${resp.status})`;

    const err = new Error(`ERRO: HTTP ${resp.status} em ${url}\n${JSON.stringify(data)}`);
    err.status = resp.status;
    err.data = data;
    err.messageFriendly = msg;
    throw err;
  }

  return data;
}

// ====== Regras do mensal personalizado ======
const MONTH_BLOCKS = [
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

function getMonthBlockForRound(rodada) {
  return (
    MONTH_BLOCKS.find((b) => rodada >= b.start && rodada <= b.end) ||
    MONTH_BLOCKS[0]
  );
}

// Busca rodada atual no endpoint público
async function getMercadoStatus() {
  return await cartolaFetchJson("/mercado/status", { auth: false });
}

// Liga (privada) via /auth/liga/...
async function getLeague(orderBy) {
  return await cartolaFetchJson(
    `/auth/liga/${encodeURIComponent(LEAGUE_SLUG)}?orderBy=${encodeURIComponent(
      orderBy
    )}&page=1`,
    { auth: true }
  );
}

// Pontos do time em uma rodada (para somar mensal personalizado)
async function getTeamRoundPoints(timeId, rodada) {
  // Endpoint mais comum: /auth/time/id/{time_id}/{rodada}
  const data = await cartolaFetchJson(`/auth/time/id/${timeId}/${rodada}`, {
    auth: true,
  });

  // Variantes possíveis no retorno (defensivo)
  // Tenta capturar "pontos" ou "pontos_rodada"
  if (typeof data.pontos === "number") return data.pontos;
  if (typeof data.pontos_rodada_note === "number") return data.pontos_rodada_note;
  if (typeof data.pontos_rodada === "number") return data.pontos_rodada;

  // Às vezes vem em "time" ou "parciais"
  if (data && data.time && typeof data.time.pontos === "number") return data.time.pontos;

  // Fallback: se não achar, retorna 0
  return 0;
}

// ====== Formatação de mensagens ======
function fmtPoints(x) {
  if (x === null || x === undefined) return "-";
  if (typeof x !== "number") return String(x);
  return x.toFixed(2).replace(".", ",");
}

function buildRankingLines(items, pointsKey, title, highlightTopN = 0) {
  // items: [{nome, nome_cartola, pontos:{...}, ranking:{...}}]
  const lines = [];
  lines.push(title);

  items.forEach((t, idx) => {
    const pos = idx + 1;

    const medal =
      pos === 1 ? "🥇" : pos === 2 ? "🥈" : pos === 3 ? "🥉" : pos <= highlightTopN ? "🏅" : "•";

    const points =
      t.pontos && Object.prototype.hasOwnProperty.call(t.pontos, pointsKey)
        ? t.pontos[pointsKey]
        : null;

    lines.push(
      `${medal} ${pos}º — ${t.nome?.trim() || "Time"} (${t.nome_cartola || "-"}) — ${fmtPoints(points)} pts`
    );
  });

  return lines.join("\n");
}

async function handlerRodada() {
  const mercado = await getMercadoStatus();
  const rodadaAtual = mercado?.rodada_atual;

  const league = await getLeague("rodada");
  const times = Array.isArray(league?.times) ? league.times.slice() : [];

  // Ordena por ranking.rodada se existir; senão por pontos.rodada desc
  times.sort((a, b) => {
    const ra = a?.ranking?.rodada ?? 999999;
    const rb = b?.ranking?.rodada ?? 999999;
    if (ra !== rb) return ra - rb;
    const pa = a?.pontos?.rodada ?? -999999;
    const pb = b?.pontos?.rodada ?? -999999;
    return pb - pa;
  });

  const header = `📊 Cartola — ${mercado?.nome_rodada || `Rodada ${rodadaAtual}`}\n`;
  const body = buildRankingLines(times, "rodada", "🏁 Ranking da rodada", 0);

  return `${header}\n${body}`;
}

async function handlerGeral() {
  const mercado = await getMercadoStatus();
  const rodadaAtual = mercado?.rodada_atual;

  const league = await getLeague("campeonato");
  const times = Array.isArray(league?.times) ? league.times.slice() : [];

  // Ordena por ranking.campeonato ou pontos.campeonato
  times.sort((a, b) => {
    const ra = a?.ranking?.campeonato ?? 999999;
    const rb = b?.ranking?.campeonato ?? 999999;
    if (ra !== rb) return ra - rb;
    const pa = a?.pontos?.campeonato ?? -999999;
    const pb = b?.pontos?.campeonato ?? -999999;
    return pb - pa;
  });

  const header = `📈 Cartola — Geral até agora (Rodada ${rodadaAtual})\n`;
  const body = buildRankingLines(times, "campeonato", "🏆 Ranking geral", 0);

  return `${header}\n${body}`;
}

async function handlerMensalPersonalizado() {
  const mercado = await getMercadoStatus();
  const rodadaAtual = mercado?.rodada_atual;

  const block = getMonthBlockForRound(rodadaAtual || 1);

  const league = await getLeague("campeonato");
  const times = Array.isArray(league?.times) ? league.times.slice() : [];

  // Para mensal personalizado: soma pontos das rodadas do bloco
  // (somente até a rodadaAtual se estiver no meio do bloco)
  const endRound = Math.min(block.end, rodadaAtual || block.start);

  const results = [];
  for (const t of times) {
    const timeId = t.time_id;
    let sum = 0;

    for (let r = block.start; r <= endRound; r++) {
      try {
        const pts = await getTeamRoundPoints(timeId, r);
        if (typeof pts === "number") sum += pts;
      } catch {
        // Se falhar em alguma rodada, conta 0
      }
    }

    results.push({
      time_id: timeId,
      nome: t.nome,
      nome_cartola: t.nome_cartola,
      pontos_mes_custom: sum,
    });
  }

  // Ordena desc por soma
  results.sort((a, b) => b.pontos_mes_custom - a.pontos_mes_custom);

  const lines = [];
  lines.push(
    `🗓️ Mensal personalizado — ${block.label} (Rodadas ${block.start} a ${block.end})`
  );
  lines.push(`📌 Parcial até a Rodada ${endRound}`);
  lines.push("");

  // Top 4 premiados
  lines.push("💰 Premiados do mês (TOP 4):");
  results.slice(0, 4).forEach((t, idx) => {
    const medal = idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : "🏅";
    lines.push(
      `${medal} ${idx + 1}º — ${t.nome?.trim() || "Time"} (${t.nome_cartola || "-"}) — ${fmtPoints(
        t.pontos_mes_custom
      )} pts`
    );
  });

  lines.push("");
  lines.push("📋 Classificação completa do mês:");
  results.forEach((t, idx) => {
    const pos = idx + 1;
    const star = pos <= 4 ? "⭐" : "•";
    lines.push(
      `${star} ${pos}º — ${t.nome?.trim() || "Time"} (${t.nome_cartola || "-"}) — ${fmtPoints(
        t.pontos_mes_custom
      )} pts`
    );
  });

  return lines.join("\n");
}

// ====== Server ======
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const path = u.pathname;

  try {
    if (path === "/" || path === "/health") {
      return json(res, 200, {
        ok: true,
        service: "cartola-mensagens",
        now: new Date().toISOString(),
      });
    }

    if (path === "/debug") {
      // NÃO expor tokens completos por segurança
      return json(res, 200, {
        ok: true,
        now: new Date().toISOString(),
        leagueSlug: LEAGUE_SLUG,
        clientIdConfigured: safeBool(CLIENT_ID),
        clientIdValue: CLIENT_ID || null,
        refreshTokenConfigured: safeBool(refreshToken),
        accessTokenConfigured: safeBool(accessToken),
        accessTokenExp: accessTokenExpEpoch,
        accessTokenExpISO:
          accessTokenExpEpoch ? new Date(accessTokenExpEpoch * 1000).toISOString() : null,
        lastRefreshAt,
        lastRefreshError,
        hint:
          "Se /rodada ou /geral der erro de refresh, o problema está no refresh_token ou client_id.",
      });
    }

    if (path === "/rodada") {
      const msg = await handlerRodada();
      return text(res, 200, msg);
    }

    if (path === "/geral") {
      const msg = await handlerGeral();
      return text(res, 200, msg);
    }

    if (path === "/mensal") {
      const msg = await handlerMensalPersonalizado();
      return text(res, 200, msg);
    }

    // rota desconhecida
    return text(res, 404, "Not found");
  } catch (err) {
    // Padroniza erro (útil no Render)
    const status = err && err.status ? err.status : 500;
    return json(res, status, {
      ok: false,
      error: err?.message || String(err),
      messageFriendly: err?.messageFriendly || null,
      lastRefreshAt,
      lastRefreshError,
    });
  }
});

server.listen(PORT, () => {
  console.log(`✅ cartola-mensagens rodando na porta ${PORT}`);
  console.log(`➡️ League: ${LEAGUE_SLUG}`);
});
