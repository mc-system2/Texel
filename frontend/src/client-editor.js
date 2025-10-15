// ============ 設定 ============
// DEV / PROD API Base
const DEV_BASE  = "https://func-texel-api-dev-jpe-001-b2f6fec8fzcbdrc3.japaneast-01.azurewebsites.net/api/";
const PROD_BASE = "https://func-texel-api-prod-jpe-001-dsgfhtafbfbxawdz.japaneast-01.azurewebsites.net/api/";

// 固定の BLOB ファイル名
const CATALOG_FILE = "texel-client-catalog.json";

// DOM ヘルパ
const $ = (id) => document.getElementById(id);
const gridBody = $("gridBody");
const versionSpan = $("version");
const updatedAtSpan = $("updatedAt");
const countSpan = $("count");
const statusSpan = $("status");

// ============ 状態 ============
let currentEtag = "";
let catalog = { version:1, updatedAt:"", clients: [] };

// ============ ユーティリティ ============
const ensureSlash = (s) => s.endsWith("/") ? s : s + "/";
const getApiBase = () => ensureSlash($("apiBase").value.trim());
function setStatus(t){ statusSpan.textContent = t || ""; }
function extractSheetId(v){
  const s = (v||"").trim();
  if (!s) return "";
  const m1 = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]{10,})/);
  if (m1) return m1[1];
  const m2 = s.match(/[?&]id=([a-zA-Z0-9-_]{10,})/);
  if (m2) return m2[1];
  return /^[a-zA-Z0-9-_]{10,}$/.test(s) ? s : s; // URLのままでもOKに
}
function behaviorLabelToValue(v){
  // UI表示の「TYPE-R/TYPE-S」を念のため吸収
  if (v === "TYPE-R") return "R";
  if (v === "TYPE-S") return "S";
  return (v||"").toUpperCase();
}

// ============ レンダリング ============
function clearGrid(){ gridBody.innerHTML = ""; }

function addRow(rec = {code:"",name:"",behavior:"",spreadsheetId:"",createdAt:""}){
  const tmpl = $("rowTmpl");
  const tr = tmpl.content.firstElementChild.cloneNode(true);

  tr.querySelector(".code").value = rec.code || "";
  tr.querySelector(".name").value = rec.name || "";
  tr.querySelector(".behavior").value = (rec.behavior || "").toUpperCase();
  tr.querySelector(".sheet").value = rec.spreadsheetId || "";
  tr.querySelector(".created").value = rec.createdAt || "";

  // 削除
  tr.querySelector(".delBtn").addEventListener("click", () => {
    tr.remove();
    refreshCount();
  });

  // 複製
  tr.querySelector(".dupBtn").addEventListener("click", () => {
    const copy = {
      code: "", // コードは空で複製
      name: tr.querySelector(".name").value,
      behavior: behaviorLabelToValue(tr.querySelector(".behavior").value),
      spreadsheetId: tr.querySelector(".sheet").value,
      createdAt: tr.querySelector(".created").value
    };
    const newTr = addRow(copy);
    gridBody.insertBefore(newTr, tr.nextSibling);
    refreshCount();
  });

  gridBody.appendChild(tr);
  return tr;
}

function render(json){
  const list = Array.isArray(json?.clients) ? json.clients : [];
  catalog = {
    version: Number(json?.version || 1),
    updatedAt: json?.updatedAt || "",
    clients: list
  };

  versionSpan.textContent = String(catalog.version);
  updatedAtSpan.textContent = catalog.updatedAt || "-";
  clearGrid();
  list.forEach(c => addRow({
    code: (c.code||"").toUpperCase(),
    name: c.name || "",
    behavior: (c.behavior||"").toUpperCase(), // 保存は R/S、UIは TYPE-R/S 表示
    spreadsheetId: c.spreadsheetId || c.sheetId || "",
    createdAt: c.createdAt || ""
  }));
  refreshCount();
}

function refreshCount(){
  countSpan.textContent = String(gridBody.querySelectorAll("tr").length);
}

// ============ JSON入出力 ============
function gridToJson(){
  const rows = [...gridBody.querySelectorAll("tr")];
  const clients = rows.map(tr => {
    const code = tr.querySelector(".code").value.trim().toUpperCase();
    if (!code) return null;
    let behavior = behaviorLabelToValue(tr.querySelector(".behavior").value.trim());
    if (!["","R","S"].includes(behavior)) behavior = ""; // 安全側
    return {
      code,
      name: tr.querySelector(".name").value.trim(),
      behavior,
      spreadsheetId: extractSheetId(tr.querySelector(".sheet").value.trim()),
      createdAt: tr.querySelector(".created").value.trim()
    };
  }).filter(Boolean);

  return {
    version: Number(versionSpan.textContent || 1),
    updatedAt: new Date().toISOString(),
    clients
  };
}

function downloadJson(obj, filename){
  const blob = new Blob([JSON.stringify(obj,null,2)], {type:"application/json;charset=utf-8"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ============ API 呼び出し ============
async function apiLoad(){
  setStatus("読込中…");
  const url = `${getApiBase()}LoadClientCatalog?filename=${encodeURIComponent(CATALOG_FILE)}`;
  const res = await fetch(url, { cache:"no-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  currentEtag = res.headers.get("etag") || "";
  $("etagBadge").textContent = currentEtag ? `ETag ${currentEtag}` : "";
  const json = await res.json();
  render(json);
  setStatus("OK");
}
async function apiSave(){
  setStatus("保存中…");
  const url = `${getApiBase()}SaveClientCatalog`;
  const body = {
    filename: CATALOG_FILE,
    json: gridToJson()
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json().catch(()=> ({}));
  currentEtag = j?.etag || currentEtag || "";
  $("etagBadge").textContent = currentEtag ? `ETag ${currentEtag}` : "";
  setStatus("保存しました");
}

// 疎通（ヘルスチェック代わり）
async function ping(){
  try{
    const u = `${getApiBase()}LoadClientCatalog?filename=${encodeURIComponent(CATALOG_FILE)}`;
    const r = await fetch(u, { method:"HEAD" });
    $("pingState").textContent = r.ok ? "OK" : `NG (${r.status})`;
  }catch(e){
    $("pingState").textContent = "NG";
  }
}

// ============ イベント ============
$("devPreset").addEventListener("click", () => {
  $("apiBase").value = DEV_BASE;
  localStorage.setItem("clientCatalogApiBase", DEV_BASE);
  apiLoad().catch(err => { console.error(err); setStatus("読込失敗"); });
});
$("prodPreset").addEventListener("click", () => {
  $("apiBase").value = PROD_BASE;
  localStorage.setItem("clientCatalogApiBase", PROD_BASE);
  apiLoad().catch(err => { console.error(err); setStatus("読込失敗"); });
});

$("pingBtn").addEventListener("click", ping);
$("loadBtn").addEventListener("click", () => apiLoad().catch(err => { console.error(err); setStatus("読込失敗"); }));
$("saveBtn").addEventListener("click", () => apiSave().catch(err => { console.error(err); setStatus("保存失敗"); alert("保存に失敗しました"); }));
$("addRowBtn").addEventListener("click", () => { addRow(); refreshCount(); });

$("exportBtn").addEventListener("click", () => {
  const j = gridToJson();
  downloadJson(j, "client-catalog.export.json");
});

$("importBtn").addEventListener("click", () => $("importFile").click());
$("importFile").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try{
    setStatus("JSON取込中…");
    const text = await f.text();
    const json = JSON.parse(text);
    render(json);
    setStatus("OK");
  }catch(err){
    console.error(err);
    setStatus("取込失敗");
    alert("JSONの読み込みに失敗しました。");
  }finally{
    e.target.value = "";
  }
});

// ============ 初期化：起動時に自動ロード ============
document.addEventListener("DOMContentLoaded", () => {
  // API Base を復元（なければ DEV）
  const saved = localStorage.getItem("clientCatalogApiBase");
  $("apiBase").value = saved || DEV_BASE;

  // 画面を開いたら即ロード（BLOBがマスター）
  apiLoad().catch(err => {
    console.error(err);
    setStatus("読込失敗");
  });
});
