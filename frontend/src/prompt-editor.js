/* Texel Prompt Editor
 * - GetPromptText → LoadPromptText に対応
 * - dev / prod の Function App 切替対応（クエリ or localStorage）
 *   ?env=dev で dev、?env=prod で prod。未指定は localStorage('texel_env')、なければ prod。
 */

/* ============ 1) Function App Base ============ */
const ENV_BASES = {
  dev : "https://func-texel-api-dev-jpe-001-26h6h6zfb6e4cfd4cf.japaneast-01.azurewebsites.net/api",
  prod: "https://func-texel-api-prod-jpe-001-td9y6thafubfzuvrd.japaneast-01.azurewebsites.net/api"
};

function resolveEnv(){
  const urlEnv = new URLSearchParams(location.search).get("env");
  if (urlEnv === "dev" || urlEnv === "prod") return urlEnv;
  try{
    const st = localStorage.getItem("texel_env");
    if (st === "dev" || st === "prod") return st;
  }catch{}
  return "prod";
}

function API_BASE(){ return ENV_BASES[resolveEnv()] || ENV_BASES.prod; }

/* ============ 2) 種別 → ファイル名マップ ============ */
/* どちらの接頭辞でも受け付ける（texel-* / snapvoice-*） */
const typeParamRaw = new URLSearchParams(location.search).get("type") || "";
const typeParam =
  typeParamRaw.startsWith("texel-") || typeParamRaw.startsWith("snapvoice-")
    ? typeParamRaw
    : `texel-${typeParamRaw}`;

const promptMeta = {
  // Texel推奨のキー
  "texel-pdf-image" : { file:"texel-pdf-image.json" , label:"PDF画像メモ生成" },
  "texel-floorplan" : { file:"texel-floorplan.json" , label:"間取図分析"       },
  "texel-roomphoto" : { file:"texel-roomphoto.json" , label:"部屋写真分析"    },
  "texel-suggestion": { file:"texel-suggestion.json", label:"おすすめポイント"},
  "texel-hashtags"  : { file:"texel-hashtags.json"  , label:"ハッシュタグ抽出" },
  "texel-commitment-master":{file:"texel-commitment-master.json",label:"こだわりマスター"},
  "texel-export-format"    :{file:"texel-export-format.json"    ,label:"物件出力フォーマット"},
  "texel-suumo-catch"      :{file:"texel-suumo-catch.json"      ,label:"SUUMOメインキャッチ"},
  "texel-suumo-comment"    :{file:"texel-suumo-comment.json"    ,label:"SUUMOネット用コメント"},
  "texel-athome-comment"   :{file:"texel-athome-comment.json"   ,label:"athomeスタッフコメント"},
  "texel-athome-appeal"    :{file:"texel-athome-appeal.json"    ,label:"athomeエンド向けアピール"},

  // 互換（既存BLOBを流用する場合）
  "snapvoice-pdf-image" : { file:"snapvoice-pdf-image.json" , label:"PDF画像メモ生成" },
  "snapvoice-floorplan" : { file:"snapvoice-floorplan.json" , label:"間取図分析"       },
  "snapvoice-roomphoto" : { file:"snapvoice-roomphoto.json" , label:"部屋写真分析"    },
  "snapvoice-suggestion": { file:"snapvoice-suggestion.json", label:"おすすめポイント"},
  "snapvoice-hashtags"  : { file:"snapvoice-hashtags.json"  , label:"ハッシュタグ抽出" },
  "snapvoice-commitment-master":{file:"snapvoice-commitment-master.json",label:"こだわりマスター"},
  "snapvoice-export-format"    :{file:"snapvoice-export-format.json"    ,label:"物件出力フォーマット"},
  "snapvoice-suumo-catch"      :{file:"snapvoice-suumo-catch.json"      ,label:"SUUMOメインキャッチ"},
  "snapvoice-suumo-comment"    :{file:"snapvoice-suumo-comment.json"    ,label:"SUUMOネット用コメント"},
  "snapvoice-athome-comment"   :{file:"snapvoice-athome-comment.json"   ,label:"athomeスタッフコメント"},
  "snapvoice-athome-appeal"    :{file:"snapvoice-athome-appeal.json"    ,label:"athomeエンド向けアピール"}
};

const META     = promptMeta[typeParam] || {};
const FILENAME = META.file;
const LABEL    = META.label || FILENAME || "(unknown prompt)";
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

/* ============ 4) パラメータ UI ============ */
const paramKeys = [
  ["max_tokens",        800],
  ["temperature",      1.0 ],
  ["top_p",            1.0 ],
  ["frequency_penalty",0.0 ],
  ["presence_penalty", 0.0 ],
  ["n",                1   ]
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
    });
  }
});

/* ============ 5) タブ切替 ============ */
function showTab(which){
  if (which === "prompt"){
    document.getElementById("tabPromptBtn").classList.add("active");
    document.getElementById("tabParamsBtn").classList.remove("active");
    document.getElementById("promptTab").classList.add("active");
    document.getElementById("paramsTab").classList.remove("active");
  }else{
    document.getElementById("tabPromptBtn").classList.remove("active");
    document.getElementById("tabParamsBtn").classList.add("active");
    document.getElementById("promptTab").classList.remove("active");
    document.getElementById("paramsTab").classList.add("active");
  }
}
document.getElementById("tabPromptBtn").addEventListener("click", ()=>showTab("prompt"));
document.getElementById("tabParamsBtn").addEventListener("click", ()=>showTab("params"));

/* ============ 6) 読み込み / 保存 ============ */
async function loadPrompt(){
  if (!FILENAME){ setStatus("❌ 無効な type パラメータ","red"); return; }
  setStatus("⏳ サーバーから取得中...","orange");
  try{
    const url = `${API_BASE()}/LoadPromptText?filename=${encodeURIComponent(FILENAME)}`;
    const r   = await fetch(url);
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = await r.json();

    let prompt = "";
    if (typeof data.prompt === "string") {
      prompt = data.prompt;
    } else if (data.prompt && typeof data.prompt.text === "string") {
      prompt = data.prompt.text;
    } else if (typeof data === "string") {
      prompt = data;
    } else {
      prompt = JSON.stringify(data, null, 2);
    }

    document.getElementById("promptEditor").value = prompt;
    updateParamUI(data.params);
    setStatus(`✅ ${LABEL} を読み込みました`,"green");
  }catch(e){
    setStatus("❌ 読み込み失敗: " + e.message,"red");
  }
}

async function savePrompt(){
  if (!FILENAME){ setStatus("❌ 無効な type パラメータ","red"); return; }
  const raw    = document.getElementById("promptEditor").value;
  const params = readParamUI();
  const body   = { filename:FILENAME, prompt:raw, params };

  try{
    const r = await fetch(`${API_BASE()}/SavePromptText`, {
      method :"POST",
      headers:{"Content-Type":"application/json"},
      body   : JSON.stringify(body)
    });
    if (!r.ok) throw new Error(await r.text());
    setStatus(`✅ ${LABEL} を保存しました`,"green");
  }catch(e){
    setStatus("❌ 保存失敗: " + e.message,"red");
  }
}

document.getElementById("loadButton").addEventListener("click", loadPrompt);
document.getElementById("saveButton").addEventListener("click", savePrompt);
window.addEventListener("DOMContentLoaded", loadPrompt);
