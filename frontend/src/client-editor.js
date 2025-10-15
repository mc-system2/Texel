// ======================= 固定設定（ローカル保存なし） =======================
const DEV_API_BASE  = "https://func-texel-api-dev-jpe-001-b2f6fec8fzcbdrc3.japaneast-01.azurewebsites.net/api/";
const PROD_API_BASE = "https://func-texel-api-prod-jpe-001-dsgfhtafbfbxawdz.japaneast-01.azurewebsites.net/api/";
const CATALOG_FILE  = "texel-client-catalog.json";  // BLOB にのみ存在するマスター

// ===================== DOM 参照 ======================
const $ = (id)=>document.getElementById(id);
const gridBody = $("gridBody");
const rowTmpl  = $("rowTmpl");
const versionSpan = $("version");
const updatedAtSpan = $("updatedAt");
const countSpan = $("count");

// 状態（ETag はあれば表示のみ）
let currentEtag = "";

// ============== ユーティリティ ==============
function getApiBase(){
  let v = $("apiBase").value.trim();
  if (!v.endsWith("/")) v += "/";
  return v;
}
function setStatus(text){ $("status").textContent = text || ""; }
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
  return /^[a-zA-Z0-9-_]{10,}$/.test(v) ? v : v;
}
function todayStr(){
  const d=new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

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
    const src = itemFromRow(tr);
    const clone = { ...src, code: issueNewClientCode(src.code), createdAt: todayStr() };
    addRow(clone);
    updateCounter();
    highlightDuplicates();
  });

  tr.querySelectorAll("input,select").forEach(el=>{
    el.addEventListener("input", ()=>{ highlightDuplicates(); });
  });

  gridBody.appendChild(tr);
}
function itemFromRow(tr){
  return {
    code: tr.querySelector(".code").value.trim().toUpperCase(),
    name: tr.querySelector(".name").value.trim(),
    behavior: behaviorLabelToValue(tr.querySelector(".behavior").value),
    spreadsheetId: extractSheetId(tr.querySelector(".sheet").value.trim()),
    createdAt: tr.querySelector(".created").value.trim()
  };
}
function issueNewClientCode(base="B001"){
  const used = new Set([...gridBody.querySelectorAll(".code")].map(i => i.value.trim().toUpperCase()).filter(Boolean));
  const head = /^[A-Z]/.test(base) ? base[0] : "B";
  let n = Number((base.match(/(\d{1,3})$/)||[,"0"])[1]);
  for (let step=0; step<2000; step++){
    n++;
    const code = `${head}${String(n).padStart(3,"0")}`;
    if (!used.has(code)) return code;
  }
  const rand = ()=> "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[Math.floor(Math.random()*36)];
  for (let k=0;k<1000;k++){
    const c = head + rand()+rand()+rand();
    if (!used.has(c)) return c;
  }
  return `${head}${Math.floor(Math.random()*900+100)}`;
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

// ============== API 呼び出し（BLOBのみ） ==============
async function apiPing(){
  try{
    const url = `${getApiBase()}LoadClientCatalog?filename=${encodeURIComponent(CATALOG_FILE)}`;
    const res = await fetch(url, { method:"GET", cache:"no-cache" });
    $("pingState").textContent = res.ok ? "OK" : `NG ${res.status}`;
  }catch{
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
    const payload = await res.json();
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
  // バリデーション
  const emptyCodes = [...gridBody.querySelectorAll(".code")].filter(i => !i.value.trim());
  if (emptyCodes.length){
    emptyCodes.forEach(i => i.classList.add("error"));
    alert("コードが空の行があります。入力してください。");
    return;
  }
  if (highlightDuplicates()){
    alert("クライアントコードが重複しています。赤枠のセルを修正してください。");
    return;
  }

  const body = {
    filename: CATALOG_FILE,
    json: gridToJson()
  };

  setStatus("保存中…");
  $("alert").hidden = true;

  try{
    const url = `${getApiBase()}SaveClientCatalog`;
    const res = await fetch(url, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify(body)
    });
    const text = await res.text().catch(()=> "");
    let json = null; try{ json = JSON.parse(text); }catch{}
    if (!res.ok) {
      const msg = json?.error || text || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    currentEtag = (json?.etag) || currentEtag || "";
    $("etagBadge").textContent = currentEtag ? `ETag ${currentEtag}` : "";
    setStatus("保存しました");
  }catch(e){
    $("alert").hidden = false;
    $("alert").textContent = `保存に失敗しました: ${e.message || e}`;
    setStatus("保存失敗");
  }
}

// ============== JSON 出入（手動ユーティリティ） ==============
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
    }catch{
      alert("JSONの読み込みに失敗しました。");
    }
  };
  r.readAsText(file, "utf-8");
}

// ============== イベント登録 ==============
function bindHeader(){
  $("devPreset").addEventListener("click", ()=>{
    $("apiBase").value = DEV_API_BASE;
    updatePresetButtons();
    apiLoad();
  });
  $("prodPreset").addEventListener("click", ()=>{
    $("apiBase").value = PROD_API_BASE;
    updatePresetButtons();
    apiLoad();
  });
  $("pingBtn").addEventListener("click", apiPing);
  $("loadBtn").addEventListener("click", apiLoad);
  $("saveBtn").addEventListener("click", apiSave);
  $("addRowBtn").addEventListener("click", ()=>{ addRow({ createdAt: todayStr() }); updateCounter(); });
  $("exportBtn").addEventListener("click", exportJson);
  $("importFile").addEventListener("change", (e)=>{ if (e.target.files?.[0]) importJson(e.target.files[0]); });
}
function updatePresetButtons(){
  const v = $("apiBase").value.trim().replace(/\/?$/,"/");
  $("devPreset").classList.toggle("active", v === DEV_API_BASE);
  $("prodPreset").classList.toggle("active", v === PROD_API_BASE);
}

// ============== 初期化 ==============
document.addEventListener("DOMContentLoaded", ()=>{
  bindHeader();
  // 既定は DEV
  $("apiBase").value = DEV_API_BASE;
  updatePresetButtons();
  // 起動時に自動読込（BLOB マスターのみ）
  apiLoad();
});
