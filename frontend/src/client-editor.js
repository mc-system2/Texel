// ===== Utility: API POST =====
async function apiPost(fn, body){
  const base = (typeof getApiBase === 'function') ? getApiBase() : (apiBaseInput ? apiBaseInput.value.trim() : '');
  if(!base){ throw new Error('API Base 未設定'); }
  const url = base.replace(/\/+$/,'') + '/' + fn.replace(/^\/+/,''); // ensure single slash
  const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body||{}) });
  if(!res.ok){
    const t = await res.text().catch(()=>''); throw new Error(fn+' '+res.status+' '+res.statusText+(t?(' :: '+t):''));
  }
  const type = res.headers.get('content-type')||'';
  return type.includes('application/json') ? res.json() : res.text();
}

// ---- API Base persistence (no design change) ----
const apiBaseInput = document.getElementById('apiBase');
function getApiBase(){
  const url = new URL(location.href);
  const fromHash = (url.searchParams.get('api')||'').trim();
  if(fromHash){ localStorage.setItem('clientEditor.apiBase', fromHash); return fromHash; }
  const saved = localStorage.getItem('clientEditor.apiBase');
  return saved || (apiBaseInput ? apiBaseInput.value.trim() : '');
}
function setApiBase(v){
  if(apiBaseInput){ apiBaseInput.value = v || ''; }
  if(v){ localStorage.setItem('clientEditor.apiBase', v); }
}
if(apiBaseInput){ setApiBase(getApiBase()); apiBaseInput.addEventListener('change', e=>setApiBase(e.target.value.trim())); }

/* =========================================================
 * Client Catalog Editor
 * ========================================================= */
const DEV_API  = "https://func-texel-api-dev-jpe-001-b2f6fec8fzcbdrc3.japaneast-01.azurewebsites.net/api/";
const PROD_API = "https://func-texel-api-prod-jpe-001-dsgfhtafbfbxawdz.japaneast-01.azurewebsites.net/api/";
const FILENAME = "texel-client-catalog.json";

const els = {
  apiBase:   document.getElementById("apiBase"),
  load:      document.getElementById("loadBtn"),
  save:      document.getElementById("saveBtn"),
  addRow:    document.getElementById("addRowBtn"),
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
let previousCatalogCodes = new Map();

// ---- helpers ----
function updateEnvActive(which){
  els.dev.classList.toggle("is-active", which === "dev");
  els.prod.classList.toggle("is-active", which === "prod");
}
const showAlert = (msg, type="ok")=>{
  els.alert.hidden = false; els.alert.textContent = msg;
  els.alert.style.background = type==="error" ? "var(--danger-weak)" : "var(--primary-weak)";
  els.alert.style.color = type==="error" ? "var(--danger)" : "#0d5f3a";
  clearTimeout(showAlert._t); showAlert._t = setTimeout(()=>{ els.alert.hidden = true; }, 1800);
};
const setStatus = (txt="")=>{ els.status.textContent = txt; };
const extractSheetId = (input)=>{
  const v = (input||"").trim(); if (!v) return "";
  let m = v.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]{10,})/); if (m) return m[1];
  m = v.match(/[?&]id=([a-zA-Z0-9-_]{10,})/); if (m) return m[1];
  return /^[a-zA-Z0-9-_]{10,}$/.test(v) ? v : "";
};
const normalizeBehavior = (b)=>{
  const v = String(b||"").toUpperCase();
  return v==="R" ? "TYPE-R" : v==="S" ? "TYPE-S" : v==="TYPE-R" ? "TYPE-R" : v==="TYPE-S" ? "TYPE-S" : "BASE";
};
const behaviorToPayload = (v)=> v==="TYPE-R" ? "R" : v==="TYPE-S" ? "S" : "";

// ---- 行生成 & 監視 ----
function makeRow(item = {code:"",name:"",behavior:"BASE",spreadsheetId:"",createdAt:""}){
  const tr = rowTmpl.content.firstElementChild.cloneNode(true);
  tr.querySelector(".code").value  = item.code || "";
  tr.querySelector(".name").value  = item.name || "";
  tr.querySelector(".behavior").value = normalizeBehavior(item.behavior);
  tr.querySelector(".sheet").value = item.spreadsheetId || item.sheetId || "";
  tr.querySelector(".created").value = item.createdAt || "";
  attachCodeWatcher(tr);
  return tr;
}
function attachCodeWatcher(tr){
  const codeInput = tr.querySelector(".code"); if (!codeInput) return;
  let hint = tr.querySelector(".code-hint");
  if (!hint) { hint = document.createElement("div"); hint.className = "hint bad code-hint"; hint.style.display="none"; codeInput.parentElement.appendChild(hint); }
  codeInput.addEventListener("input", ()=>{
    const raw = codeInput.value; const norm = raw.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,4);
    if (raw !== norm) codeInput.value = norm; validateGrid();
  });
}

// ---- 読込 ----
async function loadCatalog(){
  clearTable(); setStatus("読込中…");
  try{
    const url = join(els.apiBase.value, "LoadClientCatalog") + `?filename=${encodeURIComponent(FILENAME)}`;
    const res = await fetch(url, { cache:"no-cache" });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const ctype = (res.headers.get("content-type")||"").toLowerCase();
    const raw = ctype.includes("application/json") ? await res.json() : JSON.parse(await res.text());
    const clients = Array.isArray(raw?.clients) ? raw.clients : [];
    for (const c of clients){
      els.gridBody.appendChild(makeRow({ code:(c.code||"").toUpperCase(), name:c.name||"", behavior:c.behavior||"", spreadsheetId:c.spreadsheetId||c.sheetId||"", createdAt:c.createdAt||"" }));
    }
    els.version.textContent   = String(raw?.version ?? 1);
    els.updatedAt.textContent = raw?.updatedAt || "-";
    els.count.textContent     = String(clients.length);
    els.etag.dataset.etag     = raw?.etag || ""; els.etag.textContent = raw?.etag ? `ETag: ${raw.etag}` : "";
    previousCatalogCodes = new Map();
    for (const c of clients){ const code = String(c.code||"").toUpperCase(); if(code) previousCatalogCodes.set(code, normalizeBehavior(c.behavior||"")); }
    validateGrid(); showAlert("読み込み完了","ok");
  }catch(e){ showAlert(`読み込み失敗：${e.message||e}`,"error"); }
  finally{ setStatus(""); }
}
function clearTable(){ els.gridBody.innerHTML = ""; }
function addRow(){ els.gridBody.appendChild(makeRow()); els.count.textContent = String(els.gridBody.querySelectorAll("tr").length); validateGrid(); }

// ---- 保存 ----
async function saveCatalog(){
  const v = validateGrid(); if(!v.ok){ showAlert(v.message||"入力エラーがあります。","error"); return; }
  const rows = [...els.gridBody.querySelectorAll("tr")]; const clients = [];
  for(const tr of rows){
    const code = tr.querySelector(".code").value.trim().toUpperCase();
    const name = tr.querySelector(".name").value.trim();
    const behaviorView = tr.querySelector(".behavior").value;
    const sheetInput = tr.querySelector(".sheet").value.trim();
    const createdAt = tr.querySelector(".created").value.trim();
    const spreadsheetId = extractSheetId(sheetInput);
    clients.push({ code, name, behavior: behaviorToPayload(behaviorView), spreadsheetId, createdAt });
  }
  const catalog = { version:1, updatedAt:new Date().toISOString(), clients };
  const body = { filename: FILENAME, catalog, etag: els.etag.dataset.etag || undefined };
  setStatus("保存中…");
  try{
    const url = join(els.apiBase.value, "SaveClientCatalog");
    const res = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json; charset=utf-8" }, body: JSON.stringify(body) });
    const rawText = await res.text(); let json = {}; try{ json = rawText ? JSON.parse(rawText) : {}; }catch{}
    if(!res.ok) throw new Error(json?.error || rawText || `HTTP ${res.status}`);
    els.updatedAt.textContent = catalog.updatedAt; els.count.textContent = String(clients.length);
    if (json?.etag){ els.etag.dataset.etag = json.etag; els.etag.textContent = `ETag: ${json.etag}`; }
    showAlert("保存完了","ok");
    await syncClientPromptsAfterSave(clients);
    previousCatalogCodes = new Map(); for (const c of clients) previousCatalogCodes.set(c.code, normalizeBehavior(c.behavior||""));
  }catch(e){ showAlert(`保存に失敗しました： ${e.message||e}`,"error"); }
  finally{ setStatus(""); }
}

// ---- 検証 ----
function validateGrid(){
  const inputs = [...els.gridBody.querySelectorAll("input.code")];
  const codes = inputs.map(i => i.value.trim().toUpperCase());
  const counts = new Map(); let hasError = false; let duplicateList = [];
  for (const c of codes) counts.set(c, (counts.get(c)||0) + 1);
  inputs.forEach((inp)=>{
    const v = inp.value.trim().toUpperCase(); const isFormatOk = /^[A-Z0-9]{4}$/.test(v); const isDup = v && (counts.get(v)>1);
    let hint = inp.parentElement.querySelector(".code-hint");
    if(!hint){ hint = document.createElement("div"); hint.className="hint bad code-hint"; hint.style.display="none"; inp.parentElement.appendChild(hint); }
    inp.classList.toggle("is-invalid", !isFormatOk || isDup);
    if(!isFormatOk){ hint.textContent="A〜Z/0〜9の4桁で入力してください"; hint.style.display="block"; hasError = true; }
    else if(isDup){ hint.textContent="このコードは重複しています"; hint.style.display="block"; hasError = true; if(!duplicateList.includes(v)) duplicateList.push(v); }
    else { hint.textContent=""; hint.style.display="none"; }
  });
  let sheetMissing = false;
  for(const tr of els.gridBody.querySelectorAll("tr")){ const sid = extractSheetId(tr.querySelector(".sheet").value); if(!sid){ sheetMissing = true; } }
  els.save.disabled = hasError || sheetMissing;
  let message = ""; if(hasError){ if(duplicateList.length) message += `重複: ${duplicateList.join(", ")} `; }
  if(sheetMissing) message += (message ? "/ " : "") + "Spreadsheet ID が未入力の行があります";
  setStatus(message);
  return { ok: !(hasError || sheetMissing), message };
}

// ---- 行内操作 + Studio 起動 ----
els.gridBody.addEventListener("click",(e)=>{
  const tr = e.target.closest("tr"); if(!tr) return;
if (e.target.classList.contains("btn-del")) {
    const code = tr.querySelector(".code").value.trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(code)) {
        showAlert("コードが不正です","error");
        return;
    }

    if (!confirm(`クライアント「${code}」を削除しますか？\n\nBlob上のフォルダも物理削除されます。`)) {
        return;
    }

    const prefix = `client/${code}/`;
    const apiBase = els.apiBase.value.trim();

    (async () => {
        setStatus("削除中…");
        try {
            const url = apiBase.replace(/\/+$/,"") + "/DeleteClientFolder";
            const body = { prefix };

            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            });

            if (!res.ok) {
                const t = await res.text().catch(()=>"");
                throw new Error(`DeleteClientFolder 失敗: ${t}`);
            }

            // 成功：UI から行削除
            tr.remove();
            els.count.textContent = String(els.gridBody.querySelectorAll("tr").length);
            validateGrid();
            showAlert(`削除完了（${code}）`, "ok");

        } catch (err) {
            showAlert(err.message || "削除に失敗しました", "error");
        } finally {
            setStatus("");
        }
    })();

    return;
}
  if(e.target.classList.contains("btn-dup")){ const copy = tr.cloneNode(true); copy.querySelectorAll(".code-hint").forEach(h=>h.remove()); els.gridBody.insertBefore(copy, tr.nextSibling); attachCodeWatcher(copy); copy.querySelector(".code").value = issueNewCode(); els.count.textContent = String(els.gridBody.querySelectorAll("tr").length); validateGrid(); return; }
  if(e.target.classList.contains("studio-link")){ openPromptStudioForRow(tr); return; }
});
els.gridBody.addEventListener("dblclick",(e)=>{ const tr = e.target.closest("tr"); if(!tr) return; if(e.target.matches('input, select, textarea')) return; openPromptStudioForRow(tr); });
function openPromptStudioForRow(tr){
  const code = tr.querySelector(".code").value.trim().toUpperCase(); if(!/^[A-Z0-9]{4}$/.test(code)){ showAlert("コードが不正です","error"); return; }
  const behavior = tr.querySelector(".behavior").value;
  const api = (document.getElementById("apiBase").value || DEV_API).trim();
  const url = `./prompt-studio.html#?client=${encodeURIComponent(code)}&behavior=${encodeURIComponent(behavior)}&api=${encodeURIComponent(api)}`;
  window.open(url, "_blank");
}

// ---- ユニーク発番 ----
function issueNewCode(){
  const used = new Set([ ...[...els.gridBody.querySelectorAll(".code")].map(i=>i.value.trim().toUpperCase()), ...previousCatalogCodes.keys(), ]);
  const alph = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for(let i=0;i<50000;i++){ const code = alph[Math.floor(Math.random()*alph.length)] + String(Math.floor(Math.random()*1000)).padStart(3,"0"); if(!used.has(code)) return code; }
  let n=0; while(used.has(`Z${String(n).padStart(3,"0")}`)) n++; return `Z${String(n).padStart(3,"0")}`;
}

// ---- 環境切替 ----
els.dev.addEventListener("click", ()=>{ els.apiBase.value = DEV_API; updateEnvActive("dev"); showAlert("DEVに切替","ok"); });
els.prod.addEventListener("click", ()=>{ els.apiBase.value = PROD_API; updateEnvActive("prod"); showAlert("PRODに切替","ok"); });

// ---- ボタン ----
els.load.addEventListener("click", loadCatalog);
els.save.addEventListener("click", saveCatalog);
els.addRow.addEventListener("click", addRow);

// ---- utilities ----
function join(base, path){ return (base||"").replace(/\/+$/,"") + "/" + String(path||"").replace(/^\/+/,""); }

// ===== プロンプト同期（保存後） =====
async function syncClientPromptsAfterSave(currentClients){
  const nowMap = new Map(currentClients.map(c => [c.code, normalizeBehavior(c.behavior||"")]));
  const deletes = []; for (const code of previousCatalogCodes.keys()) { if (!nowMap.has(code)) deletes.push(code); }
  const adds = []; for (const [code, behavior] of nowMap.entries()) { adds.push({ code, behavior }); }
  if (adds.length === 0 && deletes.length === 0) return;

  setStatus("プロンプト同期中…");
  const url = join(els.apiBase.value, "SyncClientPrompts");
  const payload = { adds, deletes };
  try{
    const res = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json; charset=utf-8" }, body: JSON.stringify(payload) });
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    let result = {}; let rawText = "";
    try{ if (ctype.includes("application/json")) { result = await res.json(); } else { rawText = await res.text(); try { result = JSON.parse(rawText); } catch {} } }catch{}
    if (!res.ok) { const reason = result?.error || rawText || `HTTP ${res.status}`; throw new Error(reason); }
    const created = Array.isArray(result.created) ? result.created.length : 0;
    const skipped = Array.isArray(result.skipped) ? result.skipped.length : 0;
    const deleted = Array.isArray(result.deleted) ? result.deleted.length : 0;
    const errors  = Array.isArray(result.errors)  ? result.errors.length  : 0;
    showAlert(`プロンプト同期 完了（新規${created} / 既存${skipped} / 削除${deleted} / エラー${errors}）`, errors ? "error" : "ok");
  }catch(err){ showAlert(`プロンプト同期 失敗：${err.message||err}`,"error"); }
  finally{ setStatus(""); }
}

// ---- 起動時自動読込 ----
window.addEventListener("DOMContentLoaded", async () => {
  // 1) URLパラメータ / localStorage で既に apiBase が埋まっている場合はそれを優先
  //    （getApiBase → setApiBase の処理でここまでに反映済み）

  // 2) それでも空なら、ホスト名を見て DEV / PROD を判定してデフォルト設定
  if (!els.apiBase.value) {
    const host = location.hostname || "";

    // ★ここに本番SWAのホスト名を入れておく
    const isProdHost =
      host.includes("lemon-beach") ||   // texel の PROD 静的Webアプリ
      host.includes("texel-prod");      // 予備：将来名前を変えたとき用

    const defaultBase = isProdHost ? PROD_API : DEV_API;
    setApiBase(defaultBase); // input と localStorage の両方を更新
  }

  const base = els.apiBase.value || "";
  // API Base に応じて DEV / PROD ピルの見た目を決定
  updateEnvActive(base.includes("-prod-") ? "prod" : "dev");

  try { await loadCatalog(); } catch {}
});
