/* Texel Prompt Editor (Texel only, no hashtags)
 * - LoadPromptText / SavePromptText
 * - dev / prod の Function App 自動切替（?env=dev|prod / SWAホスト名 / localStorage）
 * - ★ texel-client-catalog.json は「純JSON（params無し）」として編集・保存
 * - 2025-10-14 fix: removeClass → remove / + QoL (Cmd/Ctrl+S, dirty guard, URL reflect)
 */

/* ============ 1) Function App Base ============ */
const ENV_BASES = {
  dev : "https://func-texel-api-dev-jpe-001-b2f6fec8fzcbdrc3.japaneast-01.azurewebsites.net/api",
  prod: "https://func-texel-api-prod-jpe-001-dsgfhtafbfbxawdz.japaneast-01.azurewebsites.net/api"
};

function resolveEnv(){
  // 1) 明示クエリ
  const urlEnv = new URLSearchParams(location.search).get("env");
  if (urlEnv === "dev" || urlEnv === "prod") return urlEnv;

  // 2) SWAホスト名で自動判定
  const h = location.host;
  if (h.includes("lively-tree-019937900.2.azurestaticapps.net")) return "dev";   // 開発
  if (h.includes("lemon-beach-0ae87bc00.2.azurestaticapps.net"))  return "prod"; // 本番

  // 3) localStorage
  try{
    const st = localStorage.getItem("texel_env");
    if (st === "dev" || st === "prod") return st;
  }catch{}

  // 4) 既定は prod
  return "prod";
}
function API_BASE(){ return ENV_BASES[resolveEnv()] || ENV_BASES.prod; }

/* ============ 2) 種別 → ファイル名マップ（Texel専用） ============ */
const typeParamRaw = new URLSearchParams(location.search).get("type") || "";
const typeParam    = typeParamRaw.startsWith("texel-") ? typeParamRaw : `texel-${typeParamRaw}`;

const promptMeta = {
  "texel-pdf-image"        : { file:"texel-pdf-image.json"        , label:"PDF画像メモ生成" },
  "texel-floorplan"        : { file:"texel-floorplan.json"        , label:"間取図分析"       },
  "texel-roomphoto"        : { file:"texel-roomphoto.json"        , label:"部屋写真分析"    },
  "texel-suggestion"       : { file:"texel-suggestion.json"       , label:"おすすめポイント"},
  "texel-commitment-master": { file:"texel-commitment-master.json", label:"こだわりマスター"},
  "texel-suumo-catch"      : { file:"texel-suumo-catch.json"      , label:"SUUMOメインキャッチ"},
  "texel-suumo-comment"    : { file:"texel-suumo-comment.json"    , label:"SUUMOネット用コメント"},
  "texel-athome-comment"   : { file:"texel-athome-comment.json"   , label:"athomeスタッフコメント"},
  "texel-athome-appeal"    : { file:"texel-athome-appeal.json"    , label:"athomeエンド向けアピール"},
  // ▼ 純JSON（params を使わない）
  "texel-client-catalog"   : { file:"texel-client-catalog.json"   , label:"クライアントカタログ（JSON）", pureJson:true }
};

const META      = promptMeta[typeParam] || {};
const FILENAME  = META.file;
const LABEL     = META.label || FILENAME || "(unknown prompt)";
const IS_PURE   = !!META.pureJson;

document.getElementById("label").textContent = LABEL;
document.getElementById("filename").textContent = FILENAME || "-";

/* ============ 3) ステータス表示 ============ */
const $status = document.getElementById("statusMessage");
function setStatus(msg, color = "#0AA0A6"){
  $status.style.opacity = "1";
  $status.textContent = msg;
  $status.style.color = color;
  clearTimeout(window.__statusTimer);
  if (color !== "red" && color !== "orange") {
    window.__statusTimer = setTimeout(() => {
      $status.style.opacity = "0";
      setTimeout(() => ($status.textContent = ""), 300);
    }, 2800);
  }
}

/* ============ 4) パラメータ UI（通常プロンプトのみ） ============ */
const paramKeys = [
  ["max_tokens",         800],
  ["temperature",       1.00],
  ["top_p",             1.00],
  ["frequency_penalty", 0.00],
  ["presence_penalty",  0.00],
  ["n",                 1   ]
];

function updateParamUI(params){
  paramKeys.forEach(([k, def])=>{
    const input = document.getElementById("param_" + k);
    const span  = document.getElementById("val_" + k);
    if (input && span){
      input.value = params?.[k] ?? def;
      span.textContent = input.value.indexOf(".")>-1 ? parseFloat(input.value).toFixed(2) : input.value;
    }
  });
}
function readParamUI(){
  const params = {};
  paramKeys.forEach(([k])=>{
    const v = document.getElementById("param_" + k).value;
    params[k] = v.indexOf(".")>-1 ? parseFloat(v) : parseInt(v,10);
  });
  return params;
}
paramKeys.forEach(([k])=>{
  const input = document.getElementById("param_" + k);
  const span  = document.getElementById("val_" + k);
  if (input && span){
    input.addEventListener("input", ()=>{
      span.textContent = input.value.indexOf(".")>-1 ? parseFloat(input.value).toFixed(2) : input.value;
      markDirty();
    });
  }
});

/* --- 純JSONファイルでは Params タブを隠す --- */
if (IS_PURE) {
  document.getElementById("tabParamsBtn").style.display = "none";
  document.getElementById("paramsTab").style.display = "none";
}

/* ============ 5) タブ切替（bugfix） ============ */
function showTab(which){
  if (which === "prompt"){
    document.getElementById("tabPromptBtn").classList.add("active");
    document.getElementById("tabParamsBtn").classList.remove("active");
    document.getElementById("promptTab").classList.add("active");
    document.getElementById("paramsTab").classList.remove("active");
  }else{
    document.getElementById("tabPromptBtn").classList.remove("active");
    document.getElementById("tabParamsBtn").classList.add("active");
    document.getElementById("promptTab").classList.remove("active"); // ← fix
    document.getElementById("paramsTab").classList.add("active");
  }
}
document.getElementById("tabPromptBtn").addEventListener("click", ()=>showTab("prompt"));
if (!IS_PURE) {
  document.getElementById("tabParamsBtn").addEventListener("click", ()=>showTab("params"));
}

/* ============ 6) 変更検知（未保存ガード & ショートカット） ============ */
let __dirty = false;
function markDirty(){ __dirty = true; }
function clearDirty(){ __dirty = false; }
window.addEventListener("beforeunload", (e)=>{
  if (!__dirty) return;
  e.preventDefault(); e.returnValue = "";
});
document.getElementById("promptEditor").addEventListener("input", markDirty);
window.addEventListener("keydown", (e)=>{
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s"){
    e.preventDefault();
    savePrompt();
  }
});

/* ============ 7) 読み込み / 保存 ============ */
async function loadPrompt(){
  if (!FILENAME){ setStatus("❌ 無効な type パラメータ","red"); return; }
  setStatus("⏳ サーバーから取得中...","orange");
  try{
    const url = `${API_BASE()}/LoadPromptText?filename=${encodeURIComponent(FILENAME)}`;
    const r   = await fetch(url, { method: "GET", credentials: "omit" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = await r.json();

    let editorText = "";
    if (IS_PURE) {
      // A) 純JSONそのもの or B) ラッパ（{ prompt:{...} }）
      const catalogObj =
        (data && typeof data.prompt === "object")
          ? data.prompt
          : (data && typeof data === "object")
            ? data
            : {};
      editorText = JSON.stringify(catalogObj, null, 2);
    } else {
      // 通常プロンプト
      if (typeof data.prompt === "string") {
        editorText = data.prompt;
      } else if (data.prompt && typeof data.prompt.text === "string") {
        editorText = data.prompt.text;
      } else if (typeof data === "string") {
        editorText = data;
      } else {
        editorText = JSON.stringify(data, null, 2);
      }
      updateParamUI(data.params);
    }

    document.getElementById("promptEditor").value = editorText;
    clearDirty();
    // URLに現在のtype/envを反映（ブクマ用）
    const usp = new URLSearchParams(location.search);
    usp.set("type", typeParam);
    usp.set("env", resolveEnv());
    history.replaceState(null, "", `${location.pathname}?${usp.toString()}`);

    setStatus(`✅ ${LABEL} を読み込みました`,"green");
  }catch(e){
    setStatus("❌ 読み込み失敗: " + e.message,"red");
  }
}

async function savePrompt(){
  if (!FILENAME){ setStatus("❌ 無効な type パラメータ","red"); return; }
  const raw = document.getElementById("promptEditor").value;

  let body;
  if (IS_PURE) {
    // JSON 検証（params は送らない）
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch(e){
      setStatus("❌ JSONの形式が不正です: " + e.message, "red");
      return;
    }
    // 保存時に整形しておく
    document.getElementById("promptEditor").value = JSON.stringify(parsed, null, 2);
    body = { filename: FILENAME, prompt: parsed };
  } else {
    body = { filename: FILENAME, prompt: raw, params: readParamUI() };
  }

  try{
    const r = await fetch(`${API_BASE()}/SavePromptText`, {
      method :"POST",
      headers:{"Content-Type":"application/json"},
      body   : JSON.stringify(body),
      credentials: "omit"
    });
    if (!r.ok) throw new Error(await r.text());
    clearDirty();
    setStatus(`✅ ${LABEL} を保存しました`,"green");
  }catch(e){
    setStatus("❌ 保存失敗: " + e.message,"red");
  }
}

document.getElementById("loadButton").addEventListener("click", loadPrompt);
document.getElementById("saveButton").addEventListener("click", savePrompt);
window.addEventListener("DOMContentLoaded", loadPrompt);
