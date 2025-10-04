/* ------------------------------------------------------------------
 *  api.js – Texel shared utilities  (rev: 2025-10-05)
 *  - SnapVoice→Texel 名称統一
 *  - 常に external モード（社内/社外の分岐を廃止）
 *  - GetPromptText → LoadPromptText に追従
 *  - dev / prod の Functions を切替可能
 * ------------------------------------------------------------------ */

/* ================================================================
 *  1. 環境切替（dev / prod）
 *     - 既定は "prod"
 *     - 一時的に dev を使いたい場合は localStorage.setItem('texel_env','dev')
 *       or chrome.storage.local.set({texel_env:'dev'})
 * ================================================================ */
const ENV_BASES = {
  dev : "https://func-texel-api-dev-jpe-001-b2f6fec8fzcbdrc3.japaneast-01.azurewebsites.net/api",
  prod: "https://func-texel-api-prod-jpe-001-dsgfhtafbfbxawdz.japaneast-01.azurewebsites.net/api"
};

async function getEnv() {
  // chrome.storage.local > localStorage > default
  try {
    const p = new Promise(res => chrome?.storage?.local?.get?.(['texel_env'], v => res(v?.texel_env)));
    const v = await p;
    if (v === 'dev' || v === 'prod') return v;
  } catch {}
  try {
    const v = localStorage.getItem('texel_env');
    if (v === 'dev' || v === 'prod') return v;
  } catch {}
  return 'prod';
}

export async function getFunctionBase() {
  const env = await getEnv();
  return ENV_BASES[env] || ENV_BASES.prod;
}

/* Google Apps Script（Spreadsheet保存 & ログ） */
export const SHEET_API =
  "https://script.google.com/a/macros/machicre.jp/s/AKfycbwf2jRmUs040bRZ4QqD7oC08eFwp001ASvu2Cpd6KoN6Lqklr1d1fjsHSSdsvD2rVU6Ig/exec";
export const GAS_LOG_ENDPOINT = SHEET_API;

/* ================================================================
 *  2. REST エンドポイント（非同期でベース組み立て）
 * ================================================================ */
async function buildAPI() {
  const BASE = await getFunctionBase();
  return {
    /* Prompt / フォーマット */
    loadPromptText : (filename) => `${BASE}/LoadPromptText?filename=${filename}`,
    savePromptText : `${BASE}/SavePromptText`,

    /* Floor-plan JSON */
    saveFloorPlan  : `${BASE}/SaveFloorPlanJson`,
    getFloorPlan   : `${BASE}/LoadFloorPlanJson`,

    /* Blob Storage JSON */
    savePropertyIndex : `${BASE}/SavePropertyIndexJson`,
    getPropertyIndex  : `${BASE}/LoadPropertyIndexJson`,

    /* 画像→Base64 変換 */
    image2base64   : `${BASE}/ImageUrlToBase64`,

    /* GPT ルーター */
    gptProxy       : `${BASE}/GPTProxySwitcher`
  };
}

/* 利便性のため：await不要で使いたい場面向けの薄いラッパ */
export const API = new Proxy({}, {
  get(_, key) {
    return async (...args) => {
      const api = await buildAPI();
      const val = api[key];
      return (typeof val === 'function') ? val(...args) : val;
    };
  }
});

/* ================================================================
 *  3. fetch リトライ
 * ================================================================ */
export const delay = (ms) => new Promise(r => setTimeout(r, ms));

export async function fetchWithRetry(url, options = {}, retries = 3, wait = 3_000) {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url, options);
    if (res.status !== 429) return res;
    console.warn(`⚠️ 429 Too Many Requests → retry ${i + 1}/${retries}`);
    await delay(wait);
  }
  throw new Error("Retry limit exceeded (429)");
}

/* ================================================================
 *  4. Client IP（ログ用）
 * ================================================================ */
let _cachedIp = "";
async function getClientIp() {
  if (_cachedIp) return _cachedIp;
  try {
    const { ip } = await (await fetch("https://api.ipify.org?format=json")).json();
    return (_cachedIp = ip || "");
  } catch {
    return "";
  }
}

/* ================================================================
 *  5. GPT 呼び出し（常に external）
 * ================================================================ */
export async function chatGPT({
  messages,
  propertyCode = "",
  userId = "",
  spreadsheetId = "",
  temperature = 0.3,
  max_tokens = 4_000,
  purpose = "image",
  ...extra
} = {}) {
  const clientIp  = await getClientIp();
  const api = await API; // ensure base built

  const body = {
    messages,
    gptmode      : "external",   // ← 固定
    purpose,
    propertyCode,
    userId,
    spreadsheetId,
    temperature,
    max_tokens   : extra.max_tokens ?? max_tokens,
    ...extra
  };

  const res  = await fetchWithRetry(await api.gptProxy, {
    method  : 'POST',
    headers : {
      'Content-Type' : 'application/json',
      'X-Client-IP'  : clientIp || ""
    },
    body    : JSON.stringify(body)
  });

  const json = await res.json();

  // 非同期ログ（失敗しても本処理に影響なし）
  fetch(GAS_LOG_ENDPOINT, {
    method  : 'POST',
    headers : { 'Content-Type':'application/json' },
    body    : JSON.stringify({
      logType          : 'gptAnalysis',
      timestamp        : new Date().toISOString(),
      propertyCode,
      userId,
      clientIp,
      spreadsheetId,
      purpose,
      model            : json.model || '',
      prompt_tokens    : json.usage?.prompt_tokens      ?? 0,
      completion_tokens: json.usage?.completion_tokens ?? 0,
      total_tokens     : json.usage?.total_tokens       ?? 0
    })
  }).catch(console.warn);

  return json;
}
