// local-prompt-editor.js ─────────────────────────────────────
// Texel 仕様版：SnapVoice依存を全撤去 / LoadPromptText に対応
// - type=xxx を texel-xxx に正規化
// - プロンプトファイルは texel-* に統一
// - FUNCTION_BASE を簡易リゾルブ（localStorage: texel_api_base / texel_env）
// - /LoadPromptText?filename=... で取得（旧 GetPromptText は未使用）

// ------------------------------------------------------------
// 0. ENV / 関数ベースURL解決（簡易版）
// ------------------------------------------------------------
const ENV_KEY = "texel_env";               // 'dev' | 'prod'
const API_BASE_OVERRIDE_KEY = "texel_api_base"; // https://.../api を直接指定可能

const ENV_BASES = {
  dev : "https://func-texel-api-dev-jpe-001-b2f6fec8fzcbdrc3.japaneast-01.azurewebsites.net/api",
  prod: "https://func-texel-api-prod-jpe-001-dsgfhtafbfbxawdz.japaneast-01.azurewebsites.net/api",
};
const fromLS = (k, fb) => { try { return localStorage.getItem(k) ?? fb; } catch { return fb; } };
const trimSlash = (s) => (s || "").replace(/\/+$/,"");
const hasProto  = (s) => /^https?:\/\//i.test(s || "");
const addProto  = (s) => (hasProto(s) ? s : `https://${s}`);
const normalizeApiBase = (b) => {
  if (!b) return "";
  const base = trimSlash(addProto(b));
  return /\/api$/i.test(base) ? base : `${base}/api`;
};

const CURRENT_ENV = (() => {
  const v = (fromLS(ENV_KEY, "prod") || "").toLowerCase();
  return (v === "dev" || v === "prod") ? v : "prod";
})();
const OVERRIDE_BASE = normalizeApiBase(fromLS(API_BASE_OVERRIDE_KEY, ""));
const FUNCTION_BASE = OVERRIDE_BASE || (ENV_BASES[CURRENT_ENV] || ENV_BASES.prod);

// ------------------------------------------------------------
// 1. 定数・要素参照
// ------------------------------------------------------------
const typeParamRaw = new URLSearchParams(location.search).get("type") || "";
const typeParam    = typeParamRaw.startsWith("texel-")
                   ? typeParamRaw
                   : `texel-${typeParamRaw}`;

// Texel のファイル命名
const promptFileMap = {
  "texel-pdf-image"        : "texel-pdf-image.json",
  "texel-floorplan"        : "texel-floorplan.json",
  "texel-roomphoto"        : "texel-roomphoto.json",
  "texel-suggestion"       : "texel-suggestion.json",
  "texel-summary"          : "texel-summary.json",
  "texel-commitment-master": "texel-commitment-master.json",
  "texel-suumo-catch"      : "texel-suumo-catch.json",
  "texel-suumo-comment"    : "texel-suumo-comment.json",
  "texel-athome-comment"   : "texel-athome-comment.json",
  "texel-athome-appeal"    : "texel-athome-appeal.json",
};

const PROMPT_FILENAME = promptFileMap[typeParam];
const STORAGE_KEY     = `prompt_${typeParam}`;

const editor   = document.getElementById("promptEditor");
const btnLoad  = document.getElementById("loadLocal");
const btnSave  = document.getElementById("saveLocal");
const btnReset = document.getElementById("resetOriginal");

// ==== 新: パラメータ6種 ====
const paramFields = [
  { key: "temperature",        min: 0,    max: 2,    step: 0.01, default: 1.0 },
  { key: "top_p",              min: 0,    max: 1,    step: 0.01, default: 1.0 },
  { key: "presence_penalty",   min: -2,   max: 2,    step: 0.01, default: 0 },
  { key: "frequency_penalty",  min: -2,   max: 2,    step: 0.01, default: 0 },
  { key: "max_tokens",         min: 256,  max: 4096, step: 1,    default: 2048 },
  { key: "n",                  min: 1,    max: 4,    step: 1,    default: 1 }
];

// タブ
const tabPrompt = document.getElementById("tabPrompt");
const tabParams = document.getElementById("tabParams");
const promptTab = document.getElementById("promptTab");
const paramsTab = document.getElementById("paramsTab");

// ------------------------------------------------------------
function setStatus(msg, color = "black") {
  let box = document.getElementById("statusMessage");
  if (!box) {
    box = document.createElement("div");
    box.id = "statusMessage";
    box.style.cssText = `
      margin-top: 6px;
      font-size: 13px;
      transition: opacity .3s ease;
    `;
    (btnSave?.parentNode || document.body).appendChild(box);
  }
  clearTimeout(window.__statusTimer);
  box.style.opacity = "1";
  box.textContent   = msg;
  box.style.color   = color;
  if (color !== "red" && color !== "orange") {
    window.__statusTimer = setTimeout(() => {
      box.style.opacity = "0";
      setTimeout(() => (box.textContent = ""), 300);
    }, 3000);
  }
}

const decodeNewLines = s =>
  typeof s === "string" ? s.replace(/\\r?\\n/g, "\n") : s;

function normalizePrompt(src) {
  if (typeof src === "string") {
    try { return normalizePrompt(JSON.parse(src)); }
    catch { return decodeNewLines(src); }
  }
  try {
    if (typeof src?.prompt === "string")       return decodeNewLines(src.prompt);
    if (typeof src?.prompt?.text === "string") return decodeNewLines(src.prompt.text);
    if (src?.prompt)                           return JSON.stringify(src.prompt, null, 2);
    return JSON.stringify(src, null, 2);
  } catch {
    return JSON.stringify(src, null, 2);
  }
}

// Texel: LoadPromptText
async function fetchBlobText() {
  const res = await fetch(`${FUNCTION_BASE}/LoadPromptText?filename=${encodeURIComponent(PROMPT_FILENAME)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ctype = res.headers.get("content-type") || "";
  if (ctype.includes("application/json")) {
    return normalizePrompt(await res.json());
  }
  return normalizePrompt(await res.text());
}

// 値セット
function updateParamUI(params) {
  [
    ["max_tokens", 800],
    ["temperature", 1.0],
    ["top_p", 1.0],
    ["frequency_penalty", 0.0],
    ["presence_penalty", 0.0],
    ["n", 1],
  ].forEach(([k, def]) => {
    let input = document.getElementById("param_" + k);
    let span = document.getElementById("val_" + k);
    if (input && span) {
      input.value = params?.[k] ?? def;
      span.textContent = input.value.indexOf(".") > -1 ? parseFloat(input.value).toFixed(2) : input.value;
    }
  });
}
function readParamUI() {
  let params = {};
  ["max_tokens", "temperature", "top_p", "frequency_penalty", "presence_penalty", "n"].forEach(k => {
    let v = document.getElementById("param_" + k).value;
    params[k] = v.indexOf(".") > -1 ? parseFloat(v) : parseInt(v, 10);
  });
  return params;
}
["max_tokens", "temperature", "top_p", "frequency_penalty", "presence_penalty", "n"].forEach(k => {
  let input = document.getElementById("param_" + k);
  let span = document.getElementById("val_" + k);
  if (input && span) {
    input.addEventListener("input", () => {
      span.textContent = input.value.indexOf(".") > -1 ? parseFloat(input.value).toFixed(2) : input.value;
    });
  }
});

// ==== タブ切替 ====
function showTab(which) {
  if (which === "prompt") {
    tabPrompt.classList.add("active");
    tabParams.classList.remove("active");
    promptTab.classList.add("active");
    paramsTab.classList.remove("active");
  } else {
    tabPrompt.classList.remove("active");
    tabParams.classList.add("active");
    promptTab.classList.remove("active");
    paramsTab.classList.add("active");
  }
}

// 旧仕様互換
function parseStored(value) {
  if (!value) return { prompt: "", params: {} };
  try {
    const obj = JSON.parse(value);
    if (typeof obj === "object" && obj.prompt !== undefined) {
      return { prompt: obj.prompt, params: obj.params ?? {} };
    }
  } catch {}
  return { prompt: value, params: {} };
}

// ------------------------------------------------------------
// 2. 読み込み（ローカル優先・無ければサーバー取得→ローカルへ保存）
// ------------------------------------------------------------
async function loadPrompt () {
  const local = localStorage.getItem(STORAGE_KEY);
  if (local !== null) {
    const {prompt, params} = parseStored(local);
    editor.value = decodeNewLines(prompt);
    updateParamUI(params);
    setStatus("✅ localStorage から読み込みました", "green");
    return;
  }

  const chromeLocal = await new Promise(resolve =>
    chrome.storage?.local?.get([STORAGE_KEY], r => resolve(r?.[STORAGE_KEY] ?? null))
  );
  if (chromeLocal !== null) {
    const {prompt, params} = parseStored(chromeLocal);
    editor.value = decodeNewLines(prompt);
    updateParamUI(params);
    setStatus("✅ chrome.storage.local から読み込みました", "green");
    try { localStorage.setItem(STORAGE_KEY, chromeLocal); } catch (_) {}
    return;
  }

  setStatus("⏳ サーバーから取得中...", "orange");
  try {
    const {prompt, params} = await fetchBlobTextFull();
    editor.value = prompt;
    updateParamUI(params);

    const saveObj = JSON.stringify({prompt, params});
    try { localStorage.setItem(STORAGE_KEY, saveObj); } catch (_) {}
    if (chrome.storage?.local) chrome.storage.local.set({ [STORAGE_KEY]: saveObj });
    setStatus("✅ サーバーから読み込み、ローカルへコピーしました", "blue");
  } catch (err) {
    setStatus(`❌ サーバー取得失敗：${err.message}`, "red");
  }
}

// ------------------------------------------------------------
// 3. 手動保存（両ストレージへ書き込み）
// ------------------------------------------------------------
function saveToLocal () {
  const normalized = { prompt: editor.value, params: readParamUI() };
  const saveString = JSON.stringify(normalized);

  let lsError = false;
  try { localStorage.setItem(STORAGE_KEY, saveString); } catch (e) { lsError = e; }

  if (chrome.storage?.local) {
    chrome.storage.local.set({ [STORAGE_KEY]: saveString }, () => {
      const chromeErr = chrome.runtime.lastError;
      if (lsError || chromeErr) {
        setStatus(`❌ 保存エラー: ${(lsError?.message ?? "")} ${(chromeErr?.message ?? "")}`, "red");
      } else {
        setStatus("✅ ローカルストレージに保存しました", "green");
      }
    });
  } else {
    setStatus(lsError ? `❌ 保存エラー: ${lsError.message}` : "✅ ローカルストレージに保存しました", lsError ? "red" : "green");
  }
}

// ==== パラメータスライダーのリアルタイム表示 ====
paramFields.forEach(f => {
  const input = document.getElementById("param_" + f.key);
  const span  = document.getElementById("val_" + f.key);
  if (input && span) {
    input.addEventListener("input", () => {
      span.textContent = input.value;
    });
  }
});

// ------------------------------------------------------------
// 4. 初期チェック & イベントバインド
// ------------------------------------------------------------
if (!typeParamRaw) {
  setStatus("❌ URL に type パラメータがありません", "red");
} else if (!PROMPT_FILENAME) {
  setStatus(`❌ 無効な type 指定: ${typeParamRaw}`, "red");
} else {
  loadPrompt();
}

tabPrompt?.addEventListener("click", () => showTab("prompt"));
tabParams?.addEventListener("click", () => showTab("params"));

btnLoad ?.addEventListener("click", loadPrompt);
btnSave ?.addEventListener("click", saveToLocal);
btnReset?.addEventListener("click", async () => {
  setStatus("⏳ サーバーから再読み込み中...", "orange");
  try {
    const {prompt, params} = await fetchBlobTextFull();
    editor.value = prompt;
    updateParamUI(params);
    setStatus("✅ サーバーから再読み込みました", "blue");
  } catch (err) {
    setStatus(`❌ サーバー再読み込みに失敗しました：${err.message}`, "red");
  }
});

// Texel: LoadPromptText の完全版（{prompt, params} を返す）
async function fetchBlobTextFull() {
  const url = `${FUNCTION_BASE}/LoadPromptText?filename=${encodeURIComponent(PROMPT_FILENAME)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ctype = res.headers.get("content-type") || "";
  if (ctype.includes("application/json")) {
    const data = await res.json();
    let promptText;
    if (typeof data.prompt === "string") {
      promptText = data.prompt;
    } else if (data.prompt && typeof data.prompt.text === "string") {
      promptText = data.prompt.text;
    } else {
      promptText = JSON.stringify(data.prompt ?? data, null, 2);
    }
    return { prompt: promptText, params: data.params || {} };
  }
  const text = await res.text();
  return { prompt: text, params: {} };
}
