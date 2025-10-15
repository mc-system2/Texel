/* =========================================================
 * Client Catalog Editor – buttons balanced version
 * ========================================================= */
const DEV_API = "https://func-texel-api-dev-jpe-001-b2f6fec8fzcbdrc3.japaneast-01.azurewebsites.net/api/";
const PROD_API = "https://func-texel-api-prod-jpe-001-dsgfhtafbfbxawdz.japaneast-01.azurewebsites.net/api/";
const FILENAME = "texel-client-catalog.json";

const els = {
  apiBase: document.getElementById("apiBase"),
  load: document.getElementById("loadBtn"),
  save: document.getElementById("saveBtn"),
  addRow: document.getElementById("addRowBtn"),
  export: document.getElementById("exportBtn"),
  import: document.getElementById("importFile"),
  gridBody: document.getElementById("gridBody"),
  etag: document.getElementById("etagBadge"),
  status: document.getElementById("status"),
  alert: document.getElementById("alert"),
  dev: document.getElementById("devPreset"),
  prod: document.getElementById("prodPreset"),
  pingBtn: document.getElementById("pingBtn"),
  pingState: document.getElementById("pingState"),
  version: document.getElementById("version"),
  updatedAt: document.getElementById("updatedAt"),
  count: document.getElementById("count"),
};

const rowTmpl = document.getElementById("rowTmpl");

/* ---------- helpers ---------- */
const showAlert = (msg, type="ok")=>{
  els.alert.hidden = false;
  els.alert.textContent = msg;
  els.alert.style.background = type==="error" ? "var(--danger-weak)" : "var(--primary-weak)";
  els.alert.style.color = type==="error" ? "var(--danger)" : "#0d5f3a";
  clearTimeout(showAlert._t);
  showAlert._t = setTimeout(()=>{ els.alert.hidden = true; }, 3000);
};
const setStatus = (txt="")=>{ els.status.textContent = txt; };

const extractSheetId = (input)=>{
  const v = (input||"").trim();
  if (!v) return "";
  let m = v.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]{10,})/);
  if (m) return m[1];
  m = v.match(/[?&]id=([a-zA-Z0-9-_]{10,})/);
  if (m) return m[1];
  return /^[a-zA-Z0-9-_]{10,}$/.test(v) ? v : "";
};

function makeRow(item = {code:"",name:"",behavior:"BASE",spreadsheetId:"",createdAt:""}) {
  const tr = rowTmpl.content.firstElementChild.cloneNode(true);
  tr.querySelector(".code").value = item.code || "";
  tr.querySelector(".name").value = item.name || "";
  tr.querySelector(".behavior").value = normalizeBehavior(item.behavior);
  tr.querySelector(".sheet").value = item.spreadsheetId || "";
  tr.querySelector(".created").value = item.createdAt || "";
  return tr;
}
const normalizeBehavior = (b)=>{
  const v = String(b||"").toUpperCase();
  return v==="R" ? "TYPE-R" : v==="S" ? "TYPE-S" : "BASE";
};
const behaviorToPayload = (v)=> v==="TYPE-R" ? "R" : v==="TYPE-S" ? "S" : "";

/* ---------- load / render ---------- */
async function loadCatalog() {
  clearTable();
  setStatus("読込中…");
  try{
    const url = join(els.apiBase.value, "LoadClientCatalog") + `?filename=${encodeURIComponent(FILENAME)}`;
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // 返却は JSON そのもの or JSON.stringify済の両対応
    const ctype = (res.headers.get("content-type")||"").toLowerCase();
    const raw = ctype.includes("application/json") ? await res.json() : JSON.parse(await res.text());
    const clients = Array.isArray(raw?.clients) ? raw.clients : [];

    for (const c of clients) {
      els.gridBody.appendChild(makeRow({
        code: (c.code||"").toUpperCase(),
        name: c.name||"",
        behavior: c.behavior||"",
        spreadsheetId: c.spreadsheetId || c.sheetId || "",
        createdAt: c.createdAt || ""
      }));
    }
    els.version.textContent = String(raw?.version ?? 1);
    els.updatedAt.textContent = raw?.updatedAt || "-";
    els.count.textContent = String(clients.length);
    els.etag.dataset.etag = raw?.etag || "";
    els.etag.textContent = raw?.etag ? `ETag: ${raw.etag}` : "";

    showAlert("読み込み完了", "ok");
  }catch(e){
    showAlert(`読み込み失敗：${e.message||e}`, "error");
  }finally{
    setStatus("");
  }
}

function clearTable(){ els.gridBody.innerHTML = ""; }
function addRow(){ els.gridBody.appendChild(makeRow()); }

/* ---------- save ---------- */
async function saveCatalog(){
  // 収集
  const rows = [...els.gridBody.querySelectorAll("tr")];
  const seen = new Set();
  const clients = [];

  for (const tr of rows){
    const code = tr.querySelector(".code").value.trim().toUpperCase();
    const name = tr.querySelector(".name").value.trim();
    const behaviorView = tr.querySelector(".behavior").value;
    const sheetInput = tr.querySelector(".sheet").value.trim();
    const createdAt = tr.querySelector(".created").value.trim();

    if (!/^[A-Z0-9]{4}$/.test(code)){ showAlert(`コードが不正です: ${code}`, "error"); return; }
    if (seen.has(code)){ showAlert(`コードが重複しています: ${code}`, "error"); return; }
    const spreadsheetId = extractSheetId(sheetInput);
    if (!spreadsheetId){ showAlert(`Spreadsheet ID が空です（${code}）`, "error"); return; }

    seen.add(code);
    clients.push({
      code, name,
      behavior: behaviorToPayload(behaviorView),
      spreadsheetId, createdAt
    });
  }

  const catalog = { version:1, updatedAt:new Date().toISOString(), clients };
  const body = { filename: FILENAME, catalog, etag: els.etag.dataset.etag || undefined };

  setStatus("保存中…");
  try{
    const url = join(els.apiBase.value, "SaveClientCatalog");
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type":"application/json; charset=utf-8" },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    let json = {};
    try{ json = text ? JSON.parse(text) : {}; }catch{ /* noop */ }

    if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);

    els.updatedAt.textContent = catalog.updatedAt;
    els.count.textContent = String(clients.length);
    if (json?.etag){ els.etag.dataset.etag = json.etag; els.etag.textContent = `ETag: ${json.etag}`; }
    showAlert("保存完了", "ok");
  }catch(e){
    showAlert(`保存に失敗しました： ${e.message||e}`, "error");
  }finally{
    setStatus("");
  }
}

/* ---------- duplicate / delete (event delegation) ---------- */
els.gridBody.addEventListener("click", (e)=>{
  const tr = e.target.closest("tr");
  if (!tr) return;

  if (e.target.classList.contains("btn-del")) {
    tr.remove();
    els.count.textContent = String(els.gridBody.querySelectorAll("tr").length);
    return;
  }
  if (e.target.classList.contains("btn-dup")) {
    const copy = tr.cloneNode(true);
    // 新しいコードを発番（A000〜Z999のランダム）
    copy.querySelector(".code").value = issueNewCode();
    els.gridBody.insertBefore(copy, tr.nextSibling);
    els.count.textContent = String(els.gridBody.querySelectorAll("tr").length);
  }
});

function issueNewCode(){
  const used = new Set([...els.gridBody.querySelectorAll(".code")].map(i=>i.value.trim().toUpperCase()));
  const alph = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (let i=0;i<9999;i++){
    const code = alph[Math.floor(Math.random()*alph.length)] + String(Math.floor(Math.random()*1000)).padStart(3,"0");
    if (!used.has(code)) return code;
  }
  // フォールバック
  return "A001";
}

/* ---------- presets / ping ---------- */
els.dev.addEventListener("click", ()=>{ els.apiBase.value = DEV_API; showAlert("DEVに切替", "ok"); });
els.prod.addEventListener("click", ()=>{ els.apiBase.value = PROD_API; showAlert("PRODに切替", "ok"); });

document.getElementById("loadBtn").addEventListener("click", loadCatalog);
document.getElementById("saveBtn").addEventListener("click", saveCatalog);
document.getElementById("addRowBtn").addEventListener("click", addRow);

els.pingBtn.addEventListener("click", async ()=>{
  els.pingState.textContent = "…";
  try{
    const res = await fetch(join(els.apiBase.value, "ping"), { cache:"no-cache" }).catch(()=>null);
    els.pingState.textContent = res && res.ok ? "OK" : "NG";
  }catch{ els.pingState.textContent = "NG"; }
});

/* ---------- utilities ---------- */
function join(base, path){
  return (base||"").replace(/\/+$/,"") + "/" + String(path||"").replace(/^\/+/,"");
}

/* 初期値 */
window.addEventListener("DOMContentLoaded", ()=>{
  if (!els.apiBase.value) els.apiBase.value = DEV_API;
});
