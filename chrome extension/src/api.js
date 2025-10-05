/* ------------------------------------------------------------------
 *  api.js – Texel shared utilities (clean, no modes / GPTProxy only)
 *  - SnapVoice依存を撤廃（キーは Texel に統一）
 *  - 社内/社外・gptmode・IP取得の残骸なし
 *  - LoadPromptText / SavePromptText に統一
 *  - dev / prod 切替（localStorage で上書き可）
 *  - GPT 呼び出しは GPTProxy のみ（Switcher フォールバック無し）
 * ------------------------------------------------------------------ */

/* ===================== 0) ENV/bootstrap ===================== */
const ENV_KEY = 'texel_env';                  // 'dev' | 'prod'
const API_BASE_OVERRIDE_KEY = 'texel_api_base';
const SHEET_API_OVERRIDE_KEY = 'texel_sheet_api';
const GAS_LOG_API_OVERRIDE_KEY = 'texel_log_api';

const fromLS = (k, fb) => { try { return localStorage.getItem(k) ?? fb; } catch { return fb; } };
const toLS   = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const trimSlash = (s) => (s || '').replace(/\/+$/,'');
const hasProto  = (s) => /^https?:\/\//i.test(s || '');
const addProto  = (s) => (hasProto(s) ? s : `https://${s}`);
const normalizeApiBase = (b) => {
  if (!b) return '';
  const base = trimSlash(addProto(b));
  return /\/api$/i.test(base) ? base : `${base}/api`;
};

// ★ Texel Functions base
const ENV_BASES = {
  dev : "https://func-texel-api-dev-jpe-001-b2f6fec8fzcbdrc3.japaneast-01.azurewebsites.net/api",
  prod: "https://func-texel-api-prod-jpe-001-dsgfhtafbfbxawdz.japaneast-01.azurewebsites.net/api"
};

const CURRENT_ENV = (() => {
  const v = (fromLS(ENV_KEY, 'prod') || '').toLowerCase();
  return (v === 'dev' || v === 'prod') ? v : 'prod';
})();

export function toggleEnv(force) {
  const next = force ?? (CURRENT_ENV === 'dev' ? 'prod' : 'dev');
  toLS(ENV_KEY, next);
  location.reload();
}

const OVERRIDE_BASE = normalizeApiBase(fromLS(API_BASE_OVERRIDE_KEY, ''));
export const FUNCTION_BASE = OVERRIDE_BASE || (ENV_BASES[CURRENT_ENV] || ENV_BASES.prod);
if (!FUNCTION_BASE) {
  console.warn('⚠️ FUNCTION_BASE 未設定です。localStorage "texel_api_base" で上書きできます。');
}

/* ===================== 1) GAS / SHEET ===================== */
export const SHEET_API = fromLS(
  SHEET_API_OVERRIDE_KEY,
  "https://script.google.com/macros/s/AKfycbwf2jRmUs040bRZ4QqD7oC08eFwp001ASvu2Cpd6KoN6Lqklr1d1fjsHSSdsvD2rVU6Ig/exec"
);
export const GAS_LOG_ENDPOINT = fromLS(
  GAS_LOG_API_OVERRIDE_KEY,
  "https://script.google.com/macros/s/AKfycbwf2jRmUs040bRZ4QqD7oC08eFwp001ASvu2Cpd6KoN6Lqklr1d1fjsHSSdsvD2rVU6Ig/exec"
);

/* ===================== 2) REST エンドポイント ===================== */
export const API = {
  // Prompt
  loadPromptText   : (filename) => `${FUNCTION_BASE}/LoadPromptText?filename=${encodeURIComponent(filename)}`,
  savePromptText   : `${FUNCTION_BASE}/SavePromptText`,

  // Floor-plan JSON
  saveFloorPlan    : `${FUNCTION_BASE}/SaveFloorPlanJson`,
  getFloorPlan     : `${FUNCTION_BASE}/GetFloorPlanJson`,

  // Blob JSON
  savePropertyIndex: `${FUNCTION_BASE}/SavePropertyIndexJson`,
  getPropertyIndex : `${FUNCTION_BASE}/GetPropertyIndexJson`,

  // 画像→Base64
  image2base64     : `${FUNCTION_BASE}/ImageUrlToBase64`,

  // GPT ルーター（一本化）
  gptProxy         : `${FUNCTION_BASE}/GPTProxy`
};

/* ===================== 3) fetch ラッパ ===================== */
export const delay = (ms) => new Promise(r => setTimeout(r, ms));
export async function fetchWithRetry(url, options = {}, retries = 3, wait = 3000) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.status !== 429) return res;
      console.warn(`⚠️429 Too Many Requests → retry ${i + 1}/${retries}`);
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
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
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

  const res = await postJson(API.gptProxy, body, { 'X-App': 'Texel' });
  // JSON化（失敗時は空オブジェクト）
  const json = await res.json().catch(() => ({}));

  // 明確な失敗はスニペット付きで通知
  if (!res.ok || json?.error) {
    const snippet = JSON.stringify(json).slice(0, 200);
    throw new Error(`GPT応答が空または不正（status=${res.status} snippet=${snippet}）`);
  }

  // GAS ログ（失敗は握りつぶし）
  fetch(GAS_LOG_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({
      logType           : 'gptAnalysis',
      timestamp         : new Date().toISOString(),
      propertyCode,
      userId,
      spreadsheetId,
      purpose,
      model             : json.model || '',
      prompt_tokens     : json.usage?.prompt_tokens      ?? 0,
      completion_tokens : json.usage?.completion_tokens ?? 0,
      total_tokens      : json.usage?.total_tokens       ?? 0
    })
    , mode: 'no-cors'
  }).catch(() => {});

  return json;
}

/* ===================== 5) 参照用（現在有効なURL群） ===================== */
export const EFFECTIVE_URLS = {
  env          : CURRENT_ENV,
  functionBase : FUNCTION_BASE,
  sheetApi     : SHEET_API,
  gasLogApi    : GAS_LOG_ENDPOINT
};
