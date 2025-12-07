// functions/GPTProxy.js — Minimal & Robust + Logs (safe, whitelisted)
const { app } = require("@azure/functions");

/* ===== Env ===== */
const AOAI_ENDPOINT    = process.env.AZURE_OPENAI_ENDPOINT;      // e.g. https://aoai-xxx.openai.azure.com
const AOAI_DEPLOYMENT  = process.env.AZURE_OPENAI_DEPLOYMENT;    // e.g. gpt-4.1
const AOAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || "2025-01-01-preview";
const AOAI_API_KEY     = process.env.AZURE_OPENAI_KEY;
const GAS_LOG_ENDPOINT = process.env.GAS_LOG_ENDPOINT || "";     // Google Apps Script WebApp URL（任意）

/* ===== CORS & helpers ===== */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-App, X-Client-IP",
  "Access-Control-Max-Age": "86400",
};
const jsonResp = (status, obj) => ({
  status,
  headers: { "Content-Type": "application/json", ...CORS },
  body: JSON.stringify(obj ?? {}),
});

/* Chat Completions: allow-list keys (2025-01-01-preview) */
const ALLOWED_KEYS = new Set([
  "messages",
  "temperature",
  "top_p",
  "max_tokens",
  "n",
  "stop",
  "presence_penalty",
  "frequency_penalty",
  "logprobs",
  "top_logprobs",
  "response_format",   // { type: "json_object" } etc.
  "tools",
  "tool_choice",
  "seed",
  // ※ 使うときに必要に応じて追加
]);

function sanitizePayload(src) {
  if (!src || typeof src !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (ALLOWED_KEYS.has(k)) out[k] = v;
  }
  // ブラウザ直呼びは stream オフ
  out.stream = false;
  return out;
}

/* x-forwarded-for などから IP を抽出（ポート除去・先頭だけ） */
function getClientIp(req) {
  const xf = req.headers.get("x-forwarded-for") || "";
  const cand = xf.split(",")[0].trim() || req.headers.get("x-client-ip") || "";
  if (!cand) return "";
  // "ip:port" → "ip"
  const withoutPort = cand.includes(":") ? cand.split(":")[0] : cand;
  // IPv6 with port "[::ffff:1.2.3.4]:12345" の簡易処理
  return withoutPort.replace(/^\[|\]$/g, "");
}

/* fire-and-forget だが最大 1 秒だけ待ってみる（失敗は握りつぶす） */
async function postLogSafely(payload) {
  if (!GAS_LOG_ENDPOINT) return;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 1000);

  try {
    await fetch(GAS_LOG_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }).catch(() => {}); // fetch 内部エラーも無視
  } catch (_) {
    // timeout/abort 等は無視
  } finally {
    clearTimeout(t);
  }
}

/* ===== Function ===== */
app.http("GPTProxy", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    if (req.method === "OPTIONS") return { status: 204, headers: CORS };

    // Server config check
    if (!AOAI_ENDPOINT || !AOAI_DEPLOYMENT || !AOAI_API_KEY) {
      return jsonResp(500, {
        error: "SERVER_MISCONFIG",
        message: "AZURE_OPENAI_ENDPOINT / DEPLOYMENT / KEY が未設定です",
      });
    }

    // Parse input
    let raw;
    try {
      raw = await req.json();
    } catch {
      return jsonResp(400, { error: "BAD_REQUEST", message: "JSON ボディが必要です" });
    }
    if (!Array.isArray(raw?.messages) || raw.messages.length === 0) {
      return jsonResp(400, { error: "BAD_REQUEST", message: "messages 配列が必要です" });
    }

    // Texel メタ（ログ用に保持。AOAIへは送らない）
    const propertyCode   = String(raw.propertyCode ?? "");
    const spreadsheetId  = String(raw.spreadsheetId ?? "");
    const userId         = String(raw.userId ?? "");
    const purpose        = String(raw.purpose ?? "");
    const clientIp       = getClientIp(req);
    const xApp           = req.headers.get("x-app") || "Texel";

    // 旧時代のフィールドは無視
    delete raw.gptmode;
    delete raw.__compat;
    delete raw.clientIp;

    // AOAI へ転送するペイロード
    const forward = sanitizePayload(raw);

    const base = AOAI_ENDPOINT.replace(/\/+$/, "");
    const url  = `${base}/openai/deployments/${encodeURIComponent(AOAI_DEPLOYMENT)}/chat/completions?api-version=${encodeURIComponent(AOAI_API_VERSION)}`;

    // Upstream call
    let upstream, text;
    try {
      upstream = await fetch(url, {
        method : "POST",
        headers: { "Content-Type": "application/json", "api-key": AOAI_API_KEY },
        body   : JSON.stringify(forward),
        signal : (AbortSignal.timeout
          ? AbortSignal.timeout(Number(process.env.TIMEOUT_MS || 60000))
          : undefined),
      });

      text = await upstream.text();
    } catch (e) {
      return jsonResp(500, { error: "SERVER_EXCEPTION", message: String(e?.message || e) });
    }

    // Error from AOAI
    if (!upstream.ok) {
      // 可能なら snippet を少し返す
      return jsonResp(upstream.status, {
        error  : "UPSTREAM_ERROR",
        status : upstream.status,
        snippet: (text || "").slice(0, 800),
      });
    }

    // Try parse JSON
    let data = null;
    try { data = JSON.parse(text); }
    catch { data = { raw: text }; }

    // ===== Logs: 最大 1 秒だけ送信を試みる（GPT 応答はブロックしない） =====
    try {
      const usage = data?.usage || {};
      const model = data?.model || "";

      const logPayload = {
        logType          : "gptAnalysis",
        timestamp        : new Date().toISOString(),
        propertyCode,
        userId,
        spreadsheetId,
        purpose,
        model,
        prompt_tokens    : usage.prompt_tokens ?? 0,
        completion_tokens: usage?.completion_tokens ?? 0,
        total_tokens     : usage?.total_tokens ?? (
          (usage.prompt_tokens || 0) + (usage.completion_tokens || 0)
        ),
        clientIp,      // 210.157.xxx.xxx（ポートなし）
        appTag : xApp, // X-App の識別
      };

      // 失敗しても GPT の返却を妨げない
      await postLogSafely(logPayload);
    } catch (_) {
      // ログ失敗は握りつぶす
    }

    // Return AOAI response as-is
    return jsonResp(upstream.status, data);
  },
});
