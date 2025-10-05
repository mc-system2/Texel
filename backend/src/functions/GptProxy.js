// functions/GPTProxy.js  — Minimal & Robust + sanitize (whitelist)
const { app } = require("@azure/functions");

const AOAI_ENDPOINT    = process.env.AZURE_OPENAI_ENDPOINT;
const AOAI_DEPLOYMENT  = process.env.AZURE_OPENAI_DEPLOYMENT;   // デプロイ名
const AOAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || "2025-01-01-preview";
const AOAI_API_KEY     = process.env.AZURE_OPENAI_KEY;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};
const jsonResp = (status, obj) => ({
  status,
  headers: { "Content-Type": "application/json", ...CORS },
  body: JSON.stringify(obj ?? {})
});

// Chat Completions API で許可するキー（2025-01-01-preview ベース）
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
  "response_format",      // { type: "json_object" } 等
  "tools",                // function/tool calls を使う場合
  "tool_choice",
  "seed"
  // 必要になったらここに追加
]);

function sanitizePayload(src) {
  if (!src || typeof src !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (ALLOWED_KEYS.has(k)) out[k] = v;
  }
  // 念のため stream は強制オフ（ブラウザでは扱わない）
  out.stream = false;
  return out;
}

app.http("GPTProxy", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req) => {
    if (req.method === "OPTIONS") return { status: 204, headers: CORS };

    if (!AOAI_ENDPOINT || !AOAI_DEPLOYMENT || !AOAI_API_KEY) {
      return jsonResp(500, { error: "SERVER_MISCONFIG", message: "AZURE_OPENAI_* が未設定です" });
    }

    let body;
    try { body = await req.json(); }
    catch { return jsonResp(400, { error: "BAD_REQUEST", message: "JSON ボディが必要です" }); }

    if (!Array.isArray(body?.messages) || body.messages.length === 0) {
      return jsonResp(400, { error: "BAD_REQUEST", message: "messages 配列が必要です" });
    }

    // ★ ここで Texel のメタ項目を排除
    const forward = sanitizePayload(body);

    const base = AOAI_ENDPOINT.replace(/\/+$/, "");
    const url  = `${base}/openai/deployments/${encodeURIComponent(AOAI_DEPLOYMENT)}/chat/completions?api-version=${encodeURIComponent(AOAI_API_VERSION)}`;

    try {
      const upstream = await fetch(url, {
        method : "POST",
        headers: { "Content-Type": "application/json", "api-key": AOAI_API_KEY },
        body   : JSON.stringify(forward),
        signal : (AbortSignal.timeout ? AbortSignal.timeout(Number(process.env.TIMEOUT_MS || 60000)) : undefined)
      });

      const text = await upstream.text();

      if (!upstream.ok) {
        return jsonResp(upstream.status, {
          error  : "UPSTREAM_ERROR",
          status : upstream.status,
          snippet: (text || "").slice(0, 800)
        });
      }

      try { return jsonResp(upstream.status, JSON.parse(text)); }
      catch { return jsonResp(upstream.status, { raw: text }); }
    } catch (e) {
      return jsonResp(500, { error: "SERVER_EXCEPTION", message: String(e?.message || e) });
    }
  }
});
