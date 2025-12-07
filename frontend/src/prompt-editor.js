﻿/* prompt-editor.js — file直指定 & 規約解決（マップ撤廃） + フルスクリーンUI対応
   - ?file= / ?filename= を最優先。/を含まないベース名 + ?client= なら client/<ID>/ を自動付与
   - ?type= は `${type}.json` に自動解決。`texel-s-*` / `texel-r-*` に加えて旧式 `texel-*` も許容
   - APIは ?api= / #?api= で上書き可。未指定時はホスト名から DEV/PROD を自動判定
   - ETagで保存競合を検知
*/

const DEV_API = "https://func-texel-api-dev-jpe-001-b2f6fec8fzcbdrc3.japaneast-01.azurewebsites.net/api/";
const PROD_API = "https://func-texel-api-prod-jpe-001-dsgfhtafbfbxawdz.japaneast-01.azurewebsites.net/api/";

/**
 * API_BASE の決定ロジック
 * 1) ?api= または hash 内 #?api= があればそれを最優先
 * 2) なければホスト名から DEV / PROD を判定（client-editor と同じ規則）
 *    - 本番SWA: hostname に "lemon-beach" または "texel-prod" を含む
 *    - localhost/127.0.0.1 は常に DEV
 * 3) 上記にも当てはまらなければ DEV を既定値とする
 */
function resolveApiBase() {
  const search = new URLSearchParams(location.search || "");
  const hash = new URLSearchParams((location.hash || "").replace(/^#\??/, ""));
  const override = (search.get("api") || hash.get("api") || "").trim();
  if (override) {
    return override.replace(/\/+$/, "") + "/";
  }

  const host = (location.hostname || "").toLowerCase();

  // ローカル開発は常に DEV
  if (host === "localhost" || host === "127.0.0.1") {
    return DEV_API;
  }

  // client-editor.js と同じ本番判定
  const isProdHost =
    host.includes("lemon-beach") ||   // Texel の PROD 静的 Web Apps
    host.includes("texel-prod");      // 予備: 将来名称を変更した場合など

  return isProdHost ? PROD_API : DEV_API;
}

// ---- DOM ----
const el = {
  ta:        document.getElementById("promptEditor"),
  status:    document.getElementById("statusMessage"),
  fileLabel: document.getElementById("filename"),
  btnLoad:   document.getElementById("loadButton"),
  btnSave:   document.getElementById("saveButton"),
  tabPrompt: document.getElementById("tabPromptBtn"),
  tabParams: document.getElementById("tabParamsBtn"),
  panelPrompt: document.getElementById("promptTab"),
  panelParams: document.getElementById("paramsTab"),
  // params
  p_max_tokens: document.getElementById("param_max_tokens"),
  p_temperature: document.getElementById("param_temperature"),
  p_top_p: document.getElementById("param_top_p"),
  p_freq: document.getElementById("param_frequency_penalty"),
  p_pres: document.getElementById("param_presence_penalty"),
  p_n: document.getElementById("param_n"),
  v_max_tokens: document.getElementById("val_max_tokens"),
  v_temperature: document.getElementById("val_temperature"),
  v_top_p: document.getElementById("val_top_p"),
  v_freq: document.getElementById("val_frequency_penalty"),
  v_pres: document.getElementById("val_presence_penalty"),
  v_n: document.getElementById("val_n"),
};

let API_BASE = resolveApiBase();
let currentFilename = null;
let currentEtag = null;
let dirty = false;
let loadedParams = {};

init().catch(e=>setStatus("初期化エラー: "+e.message, "red"));

async function init(){
  const qs = new URLSearchParams(location.search);

  // タブ切替
  el.tabPrompt.addEventListener("click", ()=>toggleTab(true));
  el.tabParams.addEventListener("click", ()=>toggleTab(false));
  function toggleTab(isPrompt){
    el.tabPrompt.classList.toggle("active", isPrompt);
    el.tabParams.classList.toggle("active", !isPrompt);
    el.panelPrompt.classList.toggle("active", isPrompt);
    el.panelParams.classList.toggle("active", !isPrompt);
  }

  // パラメータUIの値表示
  const bind = (range, view, digits=2)=> range && view && range.addEventListener("input", ()=>{
    view.textContent = (+range.value).toFixed(digits);
    dirty = true;
  });
  bind(el.p_max_tokens, el.v_max_tokens, 0);
  bind(el.p_temperature, el.v_temperature, 2);
  bind(el.p_top_p, el.v_top_p, 2);
  bind(el.p_freq, el.v_freq, 2);
  bind(el.p_pres, el.v_pres, 2);
  bind(el.p_n, el.v_n, 0);

  // 入力/ショートカット
  el.ta.addEventListener("input", ()=>{ dirty = true; });
  el.btnSave.addEventListener("click", save);
  el.btnLoad.addEventListener("click", async ()=>{
    const client = (qs.get("client") || "").trim();
    const manual = prompt("読み込むファイル名（client/.. から or ベース名のみ）を入力", currentFilename || "");
    if (!manual) return;
    await openFile(attachClientDirIfNeeded(manual.trim(), client));
  });
  window.addEventListener("keydown",(e)=>{
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="s"){
      e.preventDefault();
      save();
    }
  });
  window.addEventListener("beforeunload",(e)=>{
    if(!dirty) return;
    e.preventDefault();
    e.returnValue="";
  });

  // ファイル解決
  const filename = resolveFilenameFromQuery(qs);
  if (filename) {
    await openFile(filename);
  } else {
    setStatus("ファイル未指定です。?file= または ?type= を付けてアクセスしてください。","#0AA0A6");
  }
}

/* ===== 解決ロジック ===== */
function resolveFilenameFromQuery(qs){
  const client = (qs.get("client") || "").trim();
  // 1) ?file / ?filename
  let f = qs.get("file") || qs.get("filename");
  if (f) return attachClientDirIfNeeded(f.trim(), client);

  // 2) ?type -> `${type}.json`（規約: texel-(s|r)-* か texel-* を許容）
  const type = (qs.get("type") || "").trim();
  if (!type) return null;

  const ok =
    /^texel-(s|r)-[a-z0-9-]+$/i.test(type) ||   // 新: texel-s-..., texel-r-...
    /^texel-[a-z0-9-]+$/i.test(type);          // 旧: texel-...（互換）
  if (!ok){
    setStatus(`不正なtypeです: ${type}`, "red");
    return null;
  }

  return attachClientDirIfNeeded(`${type}.json`, client);
}

function attachClientDirIfNeeded(file, client){
  if (!file) return file;
  // すでにサブパスつきならそのまま
  if (file.includes("/")) return file;
  // ベース名 + client= なら client/<id>/ を付与
  return client ? `client/${client}/${file}` : file;
}

function validateFilename(name){
  if (!name || name.startsWith("/") || name.includes("..")) return false;
  if (!/^[A-Za-z0-9/_\-.]+\.json$/.test(name)) return false;
  if (name.includes("//")) return false;
  return true;
}

/* ===== I/O ===== */
async function openFile(filename){
  if (!validateFilename(filename)){
    setStatus(`不正なファイル名です: ${filename}`, "red");
    return;
  }
  if (dirty && !confirm("未保存の変更があります。読み込みますか？")) return;

  setStatus("読み込み中…","orange");
  try{
    const { data, etag } = await loadPrompt(filename);
    currentFilename = filename;
    currentEtag = etag || null;
    if (el.fileLabel) el.fileLabel.textContent = filename;

    // promptテキスト抽出
    const text = extractPromptText(data);
    el.ta.value = text;

    // params（あれば反映）
    loadedParams = data?.params || {};
    writeParamsUI(loadedParams);

    dirty = false;
    setStatus("読み込み完了","green");
  }catch(err){
    setStatus("読み込み失敗: "+err.message,"red");
  }
}

async function loadPrompt(filename){
  const url = API_BASE + "LoadPromptText?filename=" + encodeURIComponent(filename);
  const res = await fetch(url, { cache:"no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const etag = res.headers.get("etag");
  let json = {};
  try { json = await res.json(); } catch {}
  return { data: json, etag };
}

function extractPromptText(data){
  if (!data) return "";
  if (typeof data === "string") return data;
  if (typeof data.prompt === "string") return data.prompt;
  if (data.prompt && typeof data.prompt.text === "string") return data.prompt.text;
  return JSON.stringify(data, null, 2);
}

function readParamsUI(){
  return {
    max_tokens:         Number(el.p_max_tokens.value),
    temperature:        Number(el.p_temperature.value),
    top_p:              Number(el.p_top_p.value),
    frequency_penalty:  Number(el.p_freq.value),
    presence_penalty:   Number(el.p_pres.value),
    n:                  Number(el.p_n.value),
  };
}
function writeParamsUI(p){
  if (!p) return;
  if (p.max_tokens!=null){
    el.p_max_tokens.value=p.max_tokens;
    el.v_max_tokens.textContent=p.max_tokens.toFixed(0);
  }
  if (p.temperature!=null){
    el.p_temperature.value=p.temperature;
    el.v_temperature.textContent=p.temperature.toFixed(2);
  }
  if (p.top_p!=null){
    el.p_top_p.value=p.top_p;
    el.v_top_p.textContent=p.top_p.toFixed(2);
  }
  if (p.frequency_penalty!=null){
    el.p_freq.value=p.frequency_penalty;
    el.v_freq.textContent=p.frequency_penalty.toFixed(2);
  }
  if (p.presence_penalty!=null){
    el.p_pres.value=p.presence_penalty;
    el.v_pres.textContent=p.presence_penalty.toFixed(2);
  }
  if (p.n!=null){
    el.p_n.value=p.n;
    el.v_n.textContent=p.n.toFixed(0);
  }
}

/* ===== 保存 ===== */
async function save(){
  if (!currentFilename){
    setStatus("保存先ファイルが未選択です。","red");
    return;
  }
  if (!validateFilename(currentFilename)){
    setStatus("不正なファイル名です。","red");
    return;
  }

  const body = {
    filename: currentFilename,
    prompt: el.ta.value,
    params: readParamsUI(),      // JSONカタログの場合はサーバ側で無視される想定
    etag: currentEtag || undefined
  };

  setStatus("保存中…","orange");
  try{
    const res = await fetch(API_BASE+"SavePromptText", {
      method:"POST",
      headers:{ "Content-Type":"application/json; charset=utf-8" },
      body: JSON.stringify(body)
    });
    const raw = await res.text();
    let json={};
    try{
      json = raw?JSON.parse(raw):{};
    }catch{}
    if (!res.ok) throw new Error(json?.error || raw || `HTTP ${res.status}`);
    currentEtag = json?.etag || currentEtag || null;
    dirty = false;
    setStatus("保存完了","green");
  }catch(err){
    setStatus("保存失敗: "+err.message,"red");
    if (String(err).includes("412")){
      alert("他の人が更新しました。再読み込みしてから保存してください。");
    }
  }
}

/* ===== util ===== */
function setStatus(msg, color){
  el.status.textContent = msg;
  el.status.style.color = color || "#0AA0A6";
}
