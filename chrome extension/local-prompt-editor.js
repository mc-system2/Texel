// local-prompt-editor.js (Texel) ─────────────────────────────

// ------------------------------------------------------------
// 0. 定数・要素参照（Texel専用）
// ------------------------------------------------------------
const typeParamRaw = new URLSearchParams(location.search).get("type") || "";
const typeParam    = typeParamRaw.startsWith("texel-") ? typeParamRaw : `texel-${typeParamRaw}`;

const promptFileMap = {
  "texel-pdf-image"         : "texel-pdf-image.json",
  "texel-floorplan"         : "texel-floorplan.json",
  "texel-roomphoto"         : "texel-roomphoto.json",
  "texel-suggestion"        : "texel-suggestion.json",
  "texel-hashtags"          : "texel-hashtags.json",
  "texel-commitment-master" : "texel-commitment-master.json",
  "texel-export-format"     : "texel-export-format.json",
  "texel-suumo-catch"       : "texel-suumo-catch.json",
  "texel-suumo-comment"     : "texel-suumo-comment.json",
  "texel-athome-comment"    : "texel-athome-comment.json",
  "texel-athome-appeal"     : "texel-athome-appeal.json"
};

const PROMPT_FILENAME = promptFileMap[typeParam];
const STORAGE_KEY     = `prompt_${typeParam}`;

// 既定テンプレート取得用（Texel Functions 同オリジン想定）
// 必要なら "https://<texel-functions>.azurewebsites.net/api" に変更
const BASE_URL        = "/api";

const editor   = document.getElementById("promptEditor");
const btnLoad  = document.getElementById("loadLocal");
const btnSave  = document.getElementById("saveLocal");
const btnReset = document.getElementById("resetOriginal");

// タブ
const tabPrompt = document.getElementById("tabPrompt");
const tabParams = document.getElementById("tabParams");
const promptTab = document.getElementById("promptTab");
const paramsTab = document.getElementById("paramsTab");

// ------------------------------------------------------------
// 1. 共通ユーティリティ
// ------------------------------------------------------------
function setStatus(msg, color = "var(--tx-primary)") {
  let box = document.getElementById("statusMessage");
  if (!box) {
    box = document.createElement("div");
    box.id = "statusMessage";
    box.style.cssText = "margin-top:6px;font-size:13px;transition:opacity .3s ease;";
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

const decodeNewLines = s => (typeof s === "string" ? s.replace(/\\r?\\n/g, "\n") : s);

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

async function fetchBlobTextFull() {
  const res = await fetch(`${BASE_URL}/GetPromptText?filename=${encodeURIComponent(PROMPT_FILENAME)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ctype = res.headers.get("content-type") || "";
  if (ctype.includes("application/json")) {
    const data = await res.json();
    // "prompt"はテキスト or {text: ...}
    const promptText =
      typeof data.prompt === "string" ? data.prompt
      : (data.prompt && typeof data.prompt.text === "string") ? data.prompt.text
      : JSON.stringify(data.prompt ?? data, null, 2);
    return { prompt: promptText, params: data.params || {} };
  }
  const text = await res.text();
  return { prompt: text, params: {} };
}

function updateParamUI(params) {
  [
    ["max_tokens", 800],
    ["temperature", 1.0],
    ["top_p", 1.0],
    ["frequency_penalty", 0.0],
    ["presence_penalty", 0.0],
    ["n", 1],
  ].forEach(([k, def]) => {
    const input = document.getElementById("param_" + k);
    const span  = document.getElementById("val_" + k);
    if (input && span) {
      input.value = params?.[k] ?? def;
      span.textContent = input.value.indexOf(".") > -1
        ? parseFloat(input.value).toFixed(2)
        : input.value;
    }
  });
}
function readParamUI() {
  const params = {};
  ["max_tokens","temperature","top_p","frequency_penalty","presence_penalty","n"].forEach(k=>{
    const v = document.getElementById("param_" + k).value;
    params[k] = v.indexOf(".") > -1 ? parseFloat(v) : parseInt(v, 10);
  });
  return params;
}
["max_tokens","temperature","top_p","frequency_penalty","presence_penalty","n"].forEach(k=>{
  const input = document.getElementById("param_" + k);
  const span  = document.getElementById("val_" + k);
  if (input && span) {
    input.addEventListener("input", () => {
      span.textContent = input.value.indexOf(".") > -1
        ? parseFloat(input.value).toFixed(2)
        : input.value;
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

// ==== 旧保存データの互換（テキスト or {prompt,params}）====
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
// 2. 読み込み（localStorage → chrome.storage.local → サーバー）
// ------------------------------------------------------------
async function loadPrompt () {
  // ① localStorage
  const local = localStorage.getItem(STORAGE_KEY);
  if (local !== null) {
    const {prompt, params} = parseStored(local);
    editor.value = decodeNewLines(prompt);
    updateParamUI(params);
    setStatus("✅ localStorage から読み込みました", "green");
    return;
  }

  // ② chrome.storage.local
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

  // ③ サーバーから取得 → 両方へ反映
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
// 3. 手動保存（両ストレージへ）
// ------------------------------------------------------------
function saveToLocal () {
  const normalized = { prompt: editor.value, params: readParamUI() };
  const saveString = JSON.stringify(normalized);

  let lsError = null;
  try { localStorage.setItem(STORAGE_KEY, saveString); } catch (e) { lsError = e; }

  chrome.storage?.local?.set({ [STORAGE_KEY]: saveString }, () => {
    const chromeErr = chrome.runtime?.lastError;
    if (lsError || chromeErr) {
      setStatus(`❌ 保存エラー: ${(lsError?.message ?? "")} ${(chromeErr?.message ?? "")}`, "red");
    } else {
      setStatus("✅ ローカルストレージに保存しました", "green");
    }
  });
}

// ------------------------------------------------------------
// 4. 初期化 & イベント
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
