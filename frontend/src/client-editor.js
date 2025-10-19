/* =========================================================
 * Client Catalog Editor – save後にクライアント別プロンプト同期（堅牢化）
 * ========================================================= */
const DEV_API  = "https://func-texel-api-dev-jpe-001-b2f6fec8fzcbdrc3.japaneast-01.azurewebsites.net/api/";
const PROD_API = "https://func-texel-api-prod-jpe-001-dsgfhtafbfbxawdz.japaneast-01.azurewebsites.net/api/";
const FILENAME = "texel-client-catalog.json";

const els = {
  apiBase:   document.getElementById("apiBase"),
  load:      document.getElementById("loadBtn"),
  save:      document.getElementById("saveBtn"),
  addRow:    document.getElementById("addRowBtn"),
  export:    document.getElementById("exportBtn"),
  import:    document.getElementById("importFile"),
  gridBody:  document.getElementById("gridBody"),
  etag:      document.getElementById("etagBadge"),
  status:    document.getElementById("status"),
  alert:     document.getElementById("alert"),
  dev:       document.getElementById("devPreset"),
  prod:      document.getElementById("prodPreset"),
  version:   document.getElementById("version"),
  updatedAt: document.getElementById("updatedAt"),
  count:     document.getElementById("count"),
};

const rowTmpl = document.getElementById("rowTmpl");

// 直前ロード時点のスナップショット（code -> behaviorView）
let previousCatalogCodes = new Map();

/* ---------- helpers ---------- */
function updateEnvActive(which){
  els.dev.classList.toggle("is-active", which === "dev");
  els.prod.classList.toggle("is-active", which === "prod");
}
const showAlert = (msg, type="ok")=>{
  els.alert.hidden = false;
  els.alert.textContent = msg;
  els.alert.style.background = type==="error" ? "var(--danger-weak)" : "var(--primary-weak)";
  els.alert.style.color = type==="error" ? "var(--danger)" : "#0d5f3a";
  clearTimeout(showAlert._t);
  showAlert._t = setTimeout(()=>{ els.alert.hidden = true; }, 1800);
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
  tr.querySelector(".code").value  = item.code || "";
  tr.querySelector(".name").value  = item.name || "";
  tr.querySelector(".behavior").value = normalizeBehavior(item.behavior);
  tr.querySelector(".sheet").value = item.spreadsheetId || "";
  tr.querySelector(".created").value = item.createdAt || "";
  return tr;
}

// behavior 表示 ⇄ 保存ペイロード変換
const normalizeBehavior = (b)=>{
  const v = String(b||"").toUpperCase();
  return v==="R" ? "TYPE-R" : v==="S" ? "TYPE-S" : v==="TYPE-R" ? "TYPE-R" : v==="TYPE-S" ? "TYPE-S" : "BASE";
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
    els.version.textContent   = String(raw?.version ?? 1);
    els.updatedAt.textContent = raw?.updatedAt || "-";
    els.count.textContent     = String(clients.length);
    els.etag.dataset.etag     = raw?.etag || "";
    els.etag.textContent      = raw?.etag ? `ETag: ${raw.etag}` : "";

    // ▼ スナップショット更新（保存前の比較用）
    previousCatalogCodes = new Map();
    for (const c of clients) {
      const code = String(c.code||"").toUpperCase();
      if (!code) continue;
      previousCatalogCodes.set(code, normalizeBehavior(c.behavior||""));
    }

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
    clients.push({ code, name, behavior: behaviorToPayload(behaviorView), spreadsheetId, createdAt });
  }

  const catalog = { version:1, updatedAt:new Date().toISOString(), clients };
  const body = { filename: FILENAME, catalog, etag: els.etag.dataset.etag || undefined };

  setStatus("保存中…");
  try{
    const url = join(els.apiBase.value, "SaveClientCatalog");
    const res = await fetch(url, {
      method:"POST",
      headers:{ "Content-Type":"application/json; charset=utf-8" },
      body: JSON.stringify(body)
    });
    const rawText = await res.text();
    let json = {};
    try {
      json = rawText ? JSON.parse(rawText) : {};
    } catch {
      // Save は通常 JSON を返しますが、万一テキストなら json は空のまま
    }

    if (!res.ok) throw new Error(json?.error || rawText || `HTTP ${res.status}`);

    els.updatedAt.textContent = catalog.updatedAt;
    els.count.textContent     = String(clients.length);
    if (json?.etag){ els.etag.dataset.etag = json.etag; els.etag.textContent = `ETag: ${json.etag}`; }
    showAlert("保存完了", "ok");

    // ▼ 保存成功後：クライアント別プロンプトの初期コピー／削除を同期
    await syncClientPromptsAfterSave(clients);

    // ▼ 同期後、スナップショットを最新に更新
    previousCatalogCodes = new Map();
    for (const c of clients) previousCatalogCodes.set(c.code, normalizeBehavior(c.behavior||""));

  }catch(e){
    showAlert(`保存に失敗しました： ${e.message||e}`, "error");
  }finally{
    setStatus("");
  }
}

/* ---------- duplicate / delete ---------- */
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
  return "A001";
}

/* ---------- presets ---------- */
els.dev.addEventListener("click", ()=>{
  els.apiBase.value = DEV_API;
  updateEnvActive("dev");
  showAlert("DEVに切替","ok");
});
els.prod.addEventListener("click", ()=>{
  els.apiBase.value = PROD_API;
  updateEnvActive("prod");
  showAlert("PRODに切替","ok");
});

els.load.addEventListener("click", loadCatalog);
els.save.addEventListener("click", saveCatalog);
els.addRow.addEventListener("click", addRow);

/* ---------- utilities ---------- */
function join(base, path){
  return (base||"").replace(/\/+$/,"") + "/" + String(path||"").replace(/^\/+/,"");
}

/* ===== プロンプト同期（保存後） ===== */
async function syncClientPromptsAfterSave(currentClients){
  // nowMap: 現在（保存送信した）catalogの code -> behaviorView
  const nowMap = new Map(
    currentClients.map(c => [c.code, normalizeBehavior(c.behavior||"")])
  );

  // 削除検出：前回にあって今回ないコード
  const deletes = [];
  for (const code of previousCatalogCodes.keys()) {
    if (!nowMap.has(code)) deletes.push(code);
  }

  // 追加（初期コピー）対象：現在の全クライアント（BASE/TYPE-R/TYPE-Sすべて）
  const adds = [];
  for (const [code, behavior] of nowMap.entries()) {
    adds.push({ code, behavior }); // API側で存在チェックし、初回のみコピー
  }

  if (adds.length === 0 && deletes.length === 0) return;

  setStatus("プロンプト同期中…");
  const url = join(els.apiBase.value, "SyncClientPrompts");
  const payload = { adds, deletes };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type":"application/json; charset=utf-8" },
      body: JSON.stringify(payload)
    });

    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    let result = {};
    let rawText = "";
    try {
      if (ctype.includes("application/json")) {
        result = await res.json();
      } else {
        rawText = await res.text();               // たとえば "[object Object]" など
        try { result = JSON.parse(rawText); }     // JSON なら取り込む
        catch { /* テキストのまま扱う */ }
      }
    } catch { /* 何も取れない場合は result = {} のまま */ }

    if (!res.ok) {
      // Functions 側が text/plain を返した場合にも内容をそのまま表示
      const reason = result?.error || rawText || `HTTP ${res.status}`;
      throw new Error(reason);
    }

    const created = Array.isArray(result.created) ? result.created.length : 0;
    const skipped = Array.isArray(result.skipped) ? result.skipped.length : 0;
    const deleted = Array.isArray(result.deleted) ? result.deleted.length : 0;
    showAlert(`プロンプト同期 完了（新規${created} / 既存${skipped} / 削除${deleted}）`, "ok");
  } catch (err) {
    showAlert(`プロンプト同期 失敗：${err.message||err}`, "error");
  } finally {
    setStatus("");
  }
}

/* ===== 起動時の自動読込 ===== */
window.addEventListener("DOMContentLoaded", async ()=>{
  if (!els.apiBase.value) els.apiBase.value = DEV_API;
  updateEnvActive(els.apiBase.value.includes("-dev-") ? "dev" : "prod");
  try { await loadCatalog(); } catch {}
});
