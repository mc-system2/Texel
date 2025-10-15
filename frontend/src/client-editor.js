// ======================= 設定 =======================
const DEV_API_BASE  = "https://func-texel-api-dev-jpe-001-b2f6fec8fzcbdrc3.japaneast-01.azurewebsites.net/api/";
const PROD_API_BASE = "https://func-texel-api-prod-jpe-001-dsgfhtafbfbxawdz.japaneast-01.azurewebsites.net/api/";
const CATALOG_FILE  = "texel-client-catalog.json";  // BLOB のマスター名

// ===================== DOM 参照 ======================
const $ = (id)=>document.getElementById(id);
const gridBody = $("gridBody");
const rowTmpl  = $("rowTmpl");
const versionSpan = $("version");
const updatedAtSpan = $("updatedAt");
const countSpan = $("count");

// 状態
let currentEtag = "";
let currentData = { version:1, updatedAt:"", clients:[] };

// ============== ユーティリティ ==============
function getApiBase(){
  let v = $("apiBase").value.trim();
  if (!v.endsWith("/")) v += "/";
  return v;
}
function setStatus(text){ $("status").textContent = text || ""; }
function behaviorValueToLabel(v){
  if (v === "R") return "TYPE-R";
  if (v === "S") return "TYPE-S";
  return "BASE";
}
function behaviorLabelToValue(label){
  const t = (label || "").toUpperCase();
  if (t.includes("TYPE-R") || t === "R") return "R";
  if (t.includes("TYPE-S") || t === "S") return "S";
  return "";
}
function extractSheetId(input){
  const v = (input||"").trim();
  if (!v) return "";
  const m = v.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]{10,})/);
  if (m) return m[1];
  const m2 = v.match(/[?&]id=([a-zA-Z0-9-_]{10,})/);
  if (m2) return m2[1];
  return /^[a-zA-Z0-9-_]{10,}$/.test(v) ? v : v; // 保存時に ID 正規化
}
function todayStr(){
  const d=new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function saveLocal(key,val){ try{ localStorage.setItem(key,val);}catch{} }
function loadLocal(key,def=""){ try{ return localStorage.getItem(key) ?? def; }catch{ return def; } }

// ============== 行追加 / 複製 / 削除 ==============
function addRow(item={}){
  const tr = rowTmpl.content.firstElementChild.cloneNode(true);
  const $code = tr.querySelector(".code");
  const $name = tr.querySelector(".name");
  const $behavior = tr.querySelector(".behavior");
  const $sheet = tr.querySelector(".sheet");
  const $created = tr.querySelector(".created");

  $code.value = item.code || "";
  $name.value = item.name || "";
  $behavior.value = (item.behavior || "");
  $sheet.value = item.spreadsheetId || item.sheet || "";
  $created.value = item.createdAt || "";

  tr.querySelector(".delBtn").addEventListener("click", ()=>{ tr.remove(); updateCounter(); highlightDuplicates(); });
  tr.querySelector(".dupBtn").addEventListener("click", ()=>{
    const clone = {
      ...itemFromRow(tr),
      code: issueNewClientCode(itemFromRow(tr).code)
    };
    addRow(clone);
    updateCounter();
    highlightDuplicates(); // 念のため
  });

  // 入力イベントで重複チェック
  tr.querySelectorAll("input,select").forEach(el=>{
    el.addEventListener("input", ()=>{ highlightDuplicates(); });
  });

  gridBody.appendChild(tr);
}

// 現行行からオブジェクト化
function itemFromRow(tr){
  return {
    code: tr.querySelector(".code").value.trim().toUpperCase(),
    name: tr.querySelector(".name").value.trim(),
    behavior: behaviorLabelToValue(tr.querySelector(".behavior").value),
    spreadsheetId: extractSheetId(tr.querySelector(".sheet").value.trim()),
    createdAt: tr.querySelector(".created").value.trim()
  };
}

// 新たなクライアントコードを発番（複製時）
function issueNewClientCode(base="B001"){
  const used = new Set([...gridBody.querySelectorAll(".code")].map(i => i.value.trim().toUpperCase()).filter(Boolean));
  const head = /^[A-Z]/.test(base) ? base[0] : "B";
  // 末尾の数字を拾って+1、重複する限り進める
  let n = Number((base.match(/(\d{1,3})$/)||[,"0"])[1]);
  for (let step=0; step<2000; step++){
    n++;
    const code = `${head}${String(n).padStart(3,"0")}`;
    if (!used.has(code)) return code;
  }
  // フォールバック：乱数
  const rand = ()=> "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[Math.floor(Math.random()*36)];
  for (let k=0;k<1000;k++){
    const c = head + rand()+rand()+rand();
    if (!used.has(c)) return c;
  }
  return `${head}${crypto.getRandomValues(new Uint32Array(1))[0]%900+100}`;
}

// ============== 重複チェック ==============
function highlightDuplicates(){
  const inputs = [...gridBody.querySelectorAll(".code")];
  const map = new Map();
  inputs.forEach(i=>{
    const v = i.value.trim().toUpperCase();
    if (!v) return;
    map.set(v, (map.get(v)||0) + 1);
  });
  let hasDup = false;
  inputs.forEach(i=>{
    const v = i.value.trim().toUpperCase();
    i.classList.toggle("error", !!v && map.get(v) > 1);
    if (!!v && map.get(v) > 1) hasDup = true;
  });
  return hasDup;
}

// ============== 表示更新 ==============
function updateHeader(meta){
  versionSpan.textContent = meta?.version ?? "-";
  updatedAtSpan.textContent = meta?.updatedAt ?? "-";
}
function updateCounter(){
  const rows = gridBody.querySelectorAll("tr").length;
  countSpan.textContent = String(rows);
}

// ============== JSON ⇄ Grid ==============
function fillGrid(json){
  currentData = json || { version:1, updatedAt:"", clients:[] };
  gridBody.innerHTML = "";
  const list = Array.isArray(json?.clients) ? json.clients : [];
  list.forEach(addRow);
  updateHeader(json);
  updateCounter();
  setStatus("読込完了");
  highlightDuplicates();
}

function gridToJson(){
  const today = todayStr();
  const rows = [...gridBody.querySelectorAll("tr")];
  const clients = rows.map(tr => {
    const code = tr.querySelector(".code").value.trim().toUpperCase();
    if (!code) return null;
    let behavior = behaviorLabelToValue(tr.querySelector(".behavior").value.trim());
    if (!["","R","S"].includes(behavior)) behavior = "";
    const created = tr.querySelector(".created").value.trim() || today;
    return {
      code,
      name: tr.querySelector(".name").value.trim(),
      behavior,
      spreadsheetId: extractSheetId(tr.querySelector(".sheet").value.trim()),
      createdAt: created
    };
  }).filter(Boolean);

  return {
    version: Number(versionSpan.textContent || 1),
    updatedAt: new Date().toISOString(),
    clients
  };
}

// ============== API 呼び出し ==============
async function apiPing(){
  try{
    // Load 側に filename を付けて 200/404 を見る
    const url = `${getApiBase()}LoadClientCatalog?filename=${encodeURIComponent(CATALOG_FILE)}`;
    const res = await fetch(url, { method:"GET", cache:"no-cache" });
    $("pingState").textContent = res.ok ? "OK" : `NG ${res.status}`;
  }catch(e){
    $("pingState").textContent = "NG";
  }
}

async function apiLoad(){
  setStatus("読込中…");
  $("alert").hidden = true;
  try{
    const url = `${getApiBase()}LoadClientCatalog?filename=${encodeURIComponent(CATALOG_FILE)}`;
    const res = await fetch(url, { method:"GET", cache:"no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    // 旧形式（{prompt:{version,clients…}}）にも耐性
    const payload = Array.isArray(json?.clients) ? json
                  : Array.isArray(json?.prompt?.clients) ? json.prompt
                  : json;
    // ETag 表示
    currentEtag = res.headers.get("ETag") || "";
    $("etagBadge").textContent = currentEtag ? `ETag ${currentEtag}` : "";
    fillGrid(payload);
  }catch(e){
    $("alert").hidden = false;
    $("alert").textContent = `読込に失敗しました: ${e.message || e}`;
    setStatus("読込失敗");
  }
}

async function apiSave(){
  // 1) バリデーション
  const empties = [...gridBody.querySelectorAll(".code")].filter(i => !i.value.trim());
  if (empties.length){
    empties.forEach(i => i.classList.add("error"));
    alert("コードが空の行があります。入力してください。");
    return;
  }
  if (highlightDuplicates()){
    alert("クライアントコードが重複しています。赤枠のセルを修正してください。");
    return;
  }

  // 2) 本体データ
  const payload = gridToJson();
  const url = `${getApiBase()}SaveClientCatalog`;
  setStatus("保存中…");

  // 共通送信ヘルパ
  const post = async (body, headers) => {
    const res = await fetch(url, { method:"POST", headers, body });
    const text = await res.text().catch(()=> "");
    let json = null; try{ json = JSON.parse(text); }catch{}
    return { ok: res.ok, status: res.status, text, json, headers: res.headers };
  };

  // 3) フォールバック順序
  // A) 想定実装: { filename, json }
  const variantA = await post(
    JSON.stringify({ filename: CATALOG_FILE, json: payload }),
    { "Content-Type":"application/json" }
  );
  if (variantA.ok){
    currentEtag = (variantA.json?.etag) || currentEtag || "";
    $("etagBadge").textContent = currentEtag ? `ETag ${currentEtag}` : "";
    setStatus("保存しました");
    return;
  }

  // B) SavePromptText 互換: { filename, prompt: <obj>, params:{} }
  const variantB = await post(
    JSON.stringify({ filename: CATALOG_FILE, prompt: payload, params: {} }),
    { "Content-Type":"application/json" }
  );
  if (variantB.ok){
    currentEtag = (variantB.json?.etag) || currentEtag || "";
    $("etagBadge").textContent = currentEtag ? `ETag ${currentEtag}` : "";
    setStatus("保存しました");
    return;
  }

  // C) 本体を文字列化して送る
  const variantC = await post(
    JSON.stringify({ filename: CATALOG_FILE, prompt: JSON.stringify(payload), params: {} }),
    { "Content-Type":"application/json" }
  );
  if (variantC.ok){
    currentEtag = (variantC.json?.etag) || currentEtag || "";
    $("etagBadge").textContent = currentEtag ? `ETag ${currentEtag}` : "";
    setStatus("保存しました");
    return;
  }

  // D) no-cors（最終手段）
  try{
    await fetch(url, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type":"text/plain;charset=utf-8" },
      body: JSON.stringify({ filename: CATALOG_FILE, prompt: payload, params:{} })
    });
    setStatus("保存（no-cors）送信");
  }catch(e){
    console.error("Save failed:", { A:variantA, B:variantB, C:variantC }, e);
    setStatus("保存失敗");
    alert(`保存に失敗しました。\nA:${variantA.status} B:${variantB.status} C:${variantC.status}`);
  }
}

// ============== JSON 出入 ==============
function exportJson(){
  const blob = new Blob([JSON.stringify(gridToJson(), null, 2)], { type:"application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = CATALOG_FILE;
  a.click();
  URL.revokeObjectURL(a.href);
}
function importJson(file){
  const r = new FileReader();
  r.onload = ()=> {
    try{
      const json = JSON.parse(r.result);
      fillGrid(json);
    }catch(e){
      alert("JSONの読み込みに失敗しました。");
    }
  };
  r.readAsText(file, "utf-8");
}

// ============== イベント登録 ==============
function bindHeader(){
  $("devPreset").addEventListener("click", ()=>{
    $("apiBase").value = DEV_API_BASE;
    saveLocal("cc.apiBase", DEV_API_BASE);
    updatePresetButtons();
    apiLoad();
  });
  $("prodPreset").addEventListener("click", ()=>{
    $("apiBase").value = PROD_API_BASE;
    saveLocal("cc.apiBase", PROD_API_BASE);
    updatePresetButtons();
    apiLoad();
  });
  $("pingBtn").addEventListener("click", apiPing);
  $("loadBtn").addEventListener("click", apiLoad);
  $("saveBtn").addEventListener("click", apiSave);
  $("addRowBtn").addEventListener("click", ()=>{ addRow({ createdAt: todayStr() }); updateCounter(); });
  $("exportBtn").addEventListener("click", exportJson);
  $("importFile").addEventListener("change", (e)=>{ if (e.target.files?.[0]) importJson(e.target.files[0]); });
  $("apiBase").addEventListener("change", ()=>{ saveLocal("cc.apiBase", $("apiBase").value.trim()); updatePresetButtons(); });
}

function updatePresetButtons(){
  const v = $("apiBase").value.trim().replace(/\/?$/,"/");
  $("devPreset").classList.toggle("active", v === DEV_API_BASE);
  $("prodPreset").classList.toggle("active", v === PROD_API_BASE);
}

// ============== 初期化 ==============
document.addEventListener("DOMContentLoaded", ()=>{
  bindHeader();

  // API Base 初期値（保存済み or DEV）
  const saved = loadLocal("cc.apiBase", DEV_API_BASE);
  $("apiBase").value = saved;
  updatePresetButtons();

  // 起動時に自動ロード（ファイルは BLOB にしかない前提）
  apiLoad();
});
