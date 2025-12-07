/* ------------------------------------------------------------------
 *  api.js – Texel shared utilities (clean, GPTProxy only)
 *  - dev / prod 自動判定（localStorage で上書き可）
 *  - API ベースURLを 1 箇所で統一（Functions / GPTProxy / 画像Base64 等）
 *  - SnapVoice 残骸なし、gptmode なし、IP 取得なし
 *  - LoadPromptText / SavePromptText に統一
 *  - fetchWithRetry（429 リトライ）
 * ------------------------------------------------------------------ */

/* ===================== 0) ENV/bootstrap ===================== */
const ENV_KEY                 = "texel_env";         // 'dev' | 'prod'
const API_BASE_OVERRIDE_KEY   = "texel_api_base";    // "https://.../api" or host
const SHEET_API_OVERRIDE_KEY  = "texel_sheet_api";
const GAS_LOG_API_OVERRIDE_KEY= "texel_log_api";

const fromLS = (k, fb) => { try { return localStorage.getItem(k) ?? fb; } catch { return fb; } };
const toLS   = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const trimSlash = (s) => (s || "").replace(/\/+$/,"");
const hasProto  = (s) => /^https?:\/\//i.test(s || "");
const addProto  = (s) => (hasProto(s) ? s : `https://${s}`);

/** "xxx.azurewebsites.net" / "example.com" / "https://..." を
 *  必ず ".../api" で終わるベースに正規化 */
const normalizeApiBase = (b) => {
  if (!b) return "";
  const base = trimSlash(addProto(b));
  return /\/api$/i.test(base) ? base : `${base}/api`;
};

// Functions base (公式)
const ENV_BASES = {
  dev : "https://func-texel-api-dev-jpe-001-b2f6fec8fzcbdrc3.japaneast-01.azurewebsites.net/api",
  prod: "https://func-texel-api-prod-jpe-001-dsgfhtafbfbxawdz.japaneast-01.azurewebsites.net/api"
};

/** ホスト名から dev/prod 推定（拡張/ローカルは dev 扱い） */
function inferEnvFromHost() {
  try {
    const h = (typeof location?.host === "string" ? location.host : "");
    const proto = (typeof location?.protocol === "string" ? location.protocol : "");

    // SWA（例）
    if (h.includes("lively-tree-019937900.2.azurestaticapps.net")) return "dev";
    if (h.includes("lemon-beach-0ae87bc00.2.azurestaticapps.net")) return "prod";

    // Chrome拡張やローカルは dev
    if (proto === "chrome-extension:") return "dev";
    if (/localhost|127\.0\.0\.1/i.test(h)) return "dev";
  } catch {}
  return ""; // 不明
}

/** 実効 ENV の決定：
 *  1) localStorage(texel_env) が dev/prod なら最優先
 *  2) そうでなければ host 推定
 *  3) それも無ければ dev にフォールバック（開発の安全側）
 */
const CURRENT_ENV = (() => {
  const val = (fromLS(ENV_KEY, "") || "").toLowerCase();
  if (val === "dev" || val === "prod") return val;
  const inferred = inferEnvFromHost();
  return inferred || "dev";
})();

/** Functions ベースURLの決定：
 *  1) localStorage(texel_api_base) で上書き（ホストでもフルURLでも可）
 *  2) なければ ENV に応じた既定
 */
const OVERRIDE_BASE_RAW = fromLS(API_BASE_OVERRIDE_KEY, "");
export const FUNCTION_BASE = normalizeApiBase(OVERRIDE_BASE_RAW) || (ENV_BASES[CURRENT_ENV] || ENV_BASES.dev);
if (!FUNCTION_BASE) {
  console.warn("⚠️ FUNCTION_BASE 未設定です。localStorage \"texel_api_base\" で上書きできます。");
}

/* ===== 操作用ユーティリティ（任意で使えるよう公開） ===== */
export function setEnv(env /* 'dev' | 'prod' */, { reload = true } = {}) {
  if (env !== "dev" && env !== "prod") return;
  toLS(ENV_KEY, env);
  if (reload) location.reload();
}
export function toggleEnv({ reload = true } = {}) {
  setEnv(CURRENT_ENV === "dev" ? "prod" : "dev", { reload });
}
export function overrideFunctionBase(base /* host or URL */, { reload = true } = {}) {
  if (!base) {
    // クリア
    try { localStorage.removeItem(API_BASE_OVERRIDE_KEY); } catch {}
  } else {
    toLS(API_BASE_OVERRIDE_KEY, base);
  }
  if (reload) location.reload();
}
export function overrideSheetApi(url, { reload = false } = {}) {
  if (!url) { try { localStorage.removeItem(SHEET_API_OVERRIDE_KEY); } catch {} }
  else      { toLS(SHEET_API_OVERRIDE_KEY, url); }
  if (reload) location.reload();
}
export function overrideLogApi(url, { reload = false } = {}) {
  if (!url) { try { localStorage.removeItem(GAS_LOG_API_OVERRIDE_KEY); } catch {} }
  else      { toLS(GAS_LOG_API_OVERRIDE_KEY, url); }
  if (reload) location.reload();
}

/* ===================== 1) GAS / SHEET ===================== */
export const SHEET_API = fromLS(
  SHEET_API_OVERRIDE_KEY,
  // 既定：Logs/保存用の既存 GAS
  "https://script.google.com/macros/s/AKfycbwf2jRmUs040bRZ4QqD7oC08eFwp001ASvu2Cpd6KoN6Lqklr1d1fjsHSSdsvD2rVU6Ig/exec"
);
export const GAS_LOG_ENDPOINT = fromLS(
  GAS_LOG_API_OVERRIDE_KEY,
  "https://script.google.com/macros/s/AKfycbwf2jRmUs040bRZ4QqD7oC08eFwp001ASvu2Cpd6KoN6Lqklr1d1fjsHSSdsvD2rVU6Ig/exec"
);

/* ===================== 2) REST エンドポイント ===================== */
export const API = {
  // Prompt
  loadPromptText    : (filename) => `${FUNCTION_BASE}/LoadPromptText?filename=${encodeURIComponent(filename)}`,
  savePromptText    : `${FUNCTION_BASE}/SavePromptText`,

  // Floor-plan JSON
  saveFloorPlan     : `${FUNCTION_BASE}/SaveFloorPlanJson`,
  getFloorPlan      : `${FUNCTION_BASE}/GetFloorPlanJson`,

  // Blob JSON
  savePropertyIndex : `${FUNCTION_BASE}/SavePropertyIndexJson`,
  getPropertyIndex  : `${FUNCTION_BASE}/GetPropertyIndexJson`,

  // 画像→Base64
  image2base64      : `${FUNCTION_BASE}/ImageUrlToBase64`,

  // GPT ルーター（一本化）
  gptProxy          : `${FUNCTION_BASE}/GPTProxy`
};

/* ===================== 3) fetch ラッパ ===================== */
export const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchWithRetry(url, options = {}, retries = 3, wait = 3000) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.status !== 429) return res;           // 429 以外は即返す
      console.warn(`⚠️ 429 Too Many Requests → retry ${i + 1}/${retries}`);
    } catch (e) {
      lastErr = e;
      console.warn(`⚠️ fetch error → retry ${i + 1}/${retries}`, e);
    }
    await delay(wait);
  }
  throw lastErr || new Error("Retry limit exceeded");
}

async function postJson(url, body, headers = {}) {
  return fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

/* ===================== 4) GPT 呼び出し（Texel仕様 / GPTProxy only） ===================== */
export async function chatGPT({
  messages,
  propertyCode = "",
  userId = "",
  spreadsheetId = "",
  temperature = 0.3,
  max_tokens = 4000,
  purpose = "image",
  ...extra
} = {}) {
  const body = {
    messages,
    purpose,
    propertyCode,
    userId,
    spreadsheetId,
    temperature,
    max_tokens: extra.max_tokens ?? max_tokens,
    ...extra
  };

  const res = await postJson(API.gptProxy, body, { "X-App": "Texel" });
  const json = await res.json().catch(() => ({})); // JSON 化に失敗したら空で続行

  if (!res.ok || json?.error) {
    const snippet = JSON.stringify(json).slice(0, 200);
    throw new Error(`GPT応答が空または不正（status=${res.status} snippet=${snippet}）`);
  }

  // GAS ログ（失敗は握りつぶす）
  try {
    fetch(GAS_LOG_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        logType           : "gptAnalysis",
        timestamp         : new Date().toISOString(),
        propertyCode,
        userId,
        spreadsheetId,
        purpose,
        model             : json.model || "",
        prompt_tokens     : json.usage?.prompt_tokens      ?? 0,
        completion_tokens : json.usage?.completion_tokens ?? 0,
        total_tokens      : json.usage?.total_tokens       ?? 0
      }),
      mode: "no-cors"
    }).catch(() => {});
  } catch {}

  return json;
}

/* ===================== 5) 参照用（現在有効なURL群） ===================== */
export const EFFECTIVE_URLS = {
  env          : CURRENT_ENV,
  functionBase : FUNCTION_BASE,
  sheetApi     : SHEET_API,
  gasLogApi    : GAS_LOG_ENDPOINT,
  overrideBase : OVERRIDE_BASE_RAW || ""
};
