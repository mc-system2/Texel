async function apiPost(fn, body){
  const base = (typeof getApiBase === 'function') ? getApiBase() : (apiBaseInput ? apiBaseInput.value.trim() : '');
  if(!base){ throw new Error('API Base 未設定'); }
  const url = base.replace(/\/+$/,'') + '/' + fn.replace(/^\/+/,''); // ensure single slash
  const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body||{}) });
  if(!res.ok){
    const t = await res.text().catch(()=>'');
    throw new Error(fn+' '+res.status+' '+res.statusText+(t?(' :: '+t):''));
  }
  const type = res.headers.get('content-type')||'';
  return type.includes('application/json') ? res.json() : res.text();
}

// ---- API Base persistence (minimal, no design change) ----
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
 *  - 重複IDの即時検知/警告（保存ボタン自動無効化）
 *  - ユニークなランダム発番（表内・既存スナップショットと衝突回避）
 *  - 保存後にクライアント別プロンプト同期（BASE / TYPE-R / TYPE-S 対応）
 *  - Prompt Studio（prompt-studio.html）を Studio ピル/行ダブルクリックで起動
 *  - 堅牢なレスポンス処理（Content-Typeを判定）
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

// 直近ロード時スナップショット（保存後の差分検出に使用）: code -> behaviorView
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

const normalizeBehavior = (b)=>{
  const v = String(b||"").toUpperCase();
  return v==="R" ? "TYPE-R" : v==="S" ? "TYPE-S" : v==="TYPE-R" ? "TYPE-R" : v==="TYPE-S" ? "TYPE-S" : "BASE";
};
const behaviorToPayload = (v)=> v==="TYPE-R" ? "R" : v==="TYPE-S" ? "S" : "";

/* ---------- 行生成 & 監視取付 ---------- */
function makeRow(item = {code:"",name:"",behavior:"BASE",spreadsheetId:"",createdAt:""}) {
  const tr = rowTmpl.content.firstElementChild.cloneNode(true);
  tr.querySelector(".code").value  = item.code || "";
  tr.querySelector(".name").value  = item.name || "";
  tr.querySelector(".behavior").value = normalizeBehavior(item.behavior);
  tr.querySelector(".sheet").value = item.spreadsheetId || "";
  tr.querySelector(".created").value = item.createdAt || "";
  attachCodeWatcher(tr); // コード入力監視（即時検証）
  return tr;
}
function attachCodeWatcher(tr){
  const codeInput = tr.querySelector(".code");
  if (!codeInput) return;
  // エラーヒントを行内に生成
  let hint = tr.querySelector(".code-hint");
  if (!hint) {
    hint = document.createElement("div");
    hint.className = "hint bad code-hint";
    hint.style.display = "none";
    codeInput.parentElement.appendChild(hint);
  }
  codeInput.addEventListener("input", ()=>{
    // 英大文字・数字のみ 4桁に矯正
    const raw = codeInput.value;
    const norm = raw.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,4);
    if (raw !== norm) codeInput.value = norm;
    validateGrid(); // 全体再評価
  });
}

/* ---------- 読込 ---------- */
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

    // スナップショット更新（次回保存時の差分検出に使用）
    previousCatalogCodes = new Map();
    for (const c of clients) {
      const code = String(c.code||"").toUpperCase();
      if (!code) continue;
      previousCatalogCodes.set(code, normalizeBehavior(c.behavior||""));
    }

    validateGrid(); // 初期状態の検証
    showAlert("読み込み完了", "ok");
  }catch(e){
    showAlert(`読み込み失敗：${e.message||e}`, "error");
  }finally{
    setStatus("");
  }
}

function clearTable(){ els.gridBody.innerHTML = ""; }
function addRow(){
  els.gridBody.appendChild(makeRow());
  validateGrid();
}

/* ---------- 保存 ---------- */
async function saveCatalog(){
  // 直前検証（NGなら保存しない）
  const v = validateGrid();
  if (!v.ok) { showAlert(v.message || "入力エラーがあります。", "error"); return; }

  const rows = [...els.gridBody.querySelectorAll("tr")];
  const clients = [];

  for (const tr of rows){
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
    const res = await fetch(url, {
      method:"POST",
      headers:{ "Content-Type":"application/json; charset=utf-8" },
      body: JSON.stringify(body)
    });
    const rawText = await res.text();
    let json = {}; try{ json = rawText ? JSON.parse(rawText) : {}; }catch{}

    if (!res.ok) throw new Error(json?.error || rawText || `HTTP ${res.status}`);

    els.updatedAt.textContent = catalog.updatedAt;
    els.count.textContent     = String(clients.length);
    if (json?.etag){ els.etag.dataset.etag = json.etag; els.etag.textContent = `ETag: ${json.etag}`; }
    showAlert("保存完了", "ok");

    // 保存成功後：クライアント別プロンプト 初期コピー/削除 を同期
    await syncClientPromptsAfterSave(clients);

    // スナップショットを最新に
    previousCatalogCodes = new Map();
    for (const c of clients) previousCatalogCodes.set(c.code, normalizeBehavior(c.behavior||""));

  }catch(e){
    showAlert(`保存に失敗しました： ${e.message||e}`, "error");
  }finally{
    setStatus("");
  }
}

/* ---------- 重複/形式検証（即時） ---------- */
function validateGrid(){
  const inputs = [...els.gridBody.querySelectorAll("input.code")];
  const codes = inputs.map(i => i.value.trim().toUpperCase());
  const counts = new Map();
  let hasError = false;
  let duplicateList = [];

  // カウント
  for (const c of codes) counts.set(c, (counts.get(c)||0) + 1);

  // 入力ごとに装飾＆ヒント
  inputs.forEach((inp) => {
    const v = inp.value.trim().toUpperCase();
    const isFormatOk = /^[A-Z0-9]{4}$/.test(v);
    const isDup = v && (counts.get(v) > 1);

    const hint = inp.parentElement.querySelector(".code-hint");
    inp.classList.toggle("is-invalid", !isFormatOk || isDup);
    if (!isFormatOk) {
      hint.textContent = "A〜Z/0〜9の4桁で入力してください";
      hint.style.display = "block";
      hasError = true;
    } else if (isDup) {
      hint.textContent = "このコードは重複しています";
      hint.style.display = "block";
      hasError = true;
      if (!duplicateList.includes(v)) duplicateList.push(v);
    } else {
      hint.textContent = "";
      hint.style.display = "none";
    }
  });

  // Spreadsheet ID 空チェック（保存時は必須）
  let sheetMissing = false;
  for (const tr of els.gridBody.querySelectorAll("tr")) {
    const sid = extractSheetId(tr.querySelector(".sheet").value);
    if (!sid) { sheetMissing = true; }
  }

  // 保存ボタンの有効/無効
  els.save.disabled = hasError || sheetMissing;

  // ステータス表示
  let message = "";
  if (hasError) {
    if (duplicateList.length) message += `重複: ${duplicateList.join(", ")} `;
  }
  if (sheetMissing) message += (message ? "/ " : "") + "Spreadsheet ID が未入力の行があります";

  if (message) setStatus(message); else setStatus("");

  return { ok: !(hasError || sheetMissing), message };
}

/* ---------- 行内操作 + Studio 起動 ---------- */
els.gridBody.addEventListener("click", (e)=>{
  const tr = e.target.closest("tr");
  if (!tr) return;

  // 削除
  if (e.target.classList.contains("btn-del")) {
    tr.remove();
    els.count.textContent = String(els.gridBody.querySelectorAll("tr").length);
    validateGrid();
    return;
  }
  // 複製（ユニーク発番＋監視の付け直し）
  if (e.target.classList.contains("btn-dup")) {
    const copy = tr.cloneNode(true);
    copy.querySelectorAll(".code-hint").forEach(h => h.remove());
    els.gridBody.insertBefore(copy, tr.nextSibling);
    attachCodeWatcher(copy);
    copy.querySelector(".code").value = issueNewCode();
    els.count.textContent = String(els.gridBody.querySelectorAll("tr").length);
    validateGrid();
    return;
  }
  // Studio ピルで Prompt Studio を開く
  if (e.target.classList.contains("studio-link")) {
    openPromptStudioForRow(tr);
    return;
  }
});

// 行ダブルクリックでも Studio を開く（入力上のダブルクリックは除外）
els.gridBody.addEventListener("dblclick", (e)=>{
  const tr = e.target.closest("tr");
  if (!tr) return;
  if (e.target.matches('input, select, textarea')) return;
  openPromptStudioForRow(tr);
});

function openPromptStudioForRow(tr){
  const code = tr.querySelector(".code").value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(code)) { showAlert("コードが不正です", "error"); return; }
  const behavior = tr.querySelector(".behavior").value;
  const api = (document.getElementById("apiBase").value || DEV_API).trim();
  const url = `./prompt-studio.html#?client=${encodeURIComponent(code)}&behavior=${encodeURIComponent(behavior)}&api=${encodeURIComponent(api)}`;
  window.open(url, "_blank");
}

/* ---------- ユニークなランダム発番 ---------- */
function issueNewCode(){
  // 表内＋前回ロード時スナップショットの両方に衝突しない
  const used = new Set([
    ...[...els.gridBody.querySelectorAll(".code")].map(i=>i.value.trim().toUpperCase()),
    ...previousCatalogCodes.keys(),
  ]);
  const alph = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (let i=0; i<50000; i++){
    const code = alph[Math.floor(Math.random()*alph.length)] + String(Math.floor(Math.random()*1000)).padStart(3,"0");
    if (!used.has(code)) return code;
  }
  // フォールバック（理論上到達しにくい）
  let n = 0;
  while (used.has(`Z${String(n).padStart(3,"0")}`)) n++;
  return `Z${String(n).padStart(3,"0")}`;
}

/* ---------- 環境切替 ---------- */
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

/* ---------- ボタン ---------- */
els.load.addEventListener("click", loadCatalog);
els.save.addEventListener("click", saveCatalog);
els.addRow.addEventListener("click", addRow);

/* ---------- utilities ---------- */
function join(base, path){
  return (base||"").replace(/\/+$/,"") + "/" + String(path||"").replace(/^\/+/,"");
}

/* ===== プロンプト同期（保存後） =====
 * - adds: 現在行すべて（BASE/TYPE-R/TYPE-S）→ 初回コピーのみ（API側で存在チェック）
 * - deletes: 前回にあって今回ないコード → client/<CLID>/ と legacy prompt/<CLID>/ を削除（API側実装）
 */
async function syncClientPromptsAfterSave(currentClients){
  const nowMap = new Map(currentClients.map(c => [c.code, normalizeBehavior(c.behavior||"")]));

  // 削除検出
  const deletes = [];
  for (const code of previousCatalogCodes.keys()) {
    if (!nowMap.has(code)) deletes.push(code);
  }

  // 追加：全行（存在するものはAPI側でskip）
  const adds = [];
  for (const [code, behavior] of nowMap.entries()) {
    adds.push({ code, behavior });
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
        rawText = await res.text();
        try { result = JSON.parse(rawText); } catch {}
      }
    } catch {}

    if (!res.ok) {
      const reason = result?.error || rawText || `HTTP ${res.status}`;
      throw new Error(reason);
    }

    const created = Array.isArray(result.created) ? result.created.length : 0;
    const skipped = Array.isArray(result.skipped) ? result.skipped.length : 0;
    const deleted = Array.isArray(result.deleted) ? result.deleted.length : 0;
    const errors  = Array.isArray(result.errors)  ? result.errors.length  : 0;
    showAlert(`プロンプト同期 完了（新規${created} / 既存${skipped} / 削除${deleted} / エラー${errors}）`, errors ? "error" : "ok");
    if (errors && result.errors) console.table(result.errors);
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


// List client folders under prompts/client/
async function listClientFolders(){
  // Primary: ListBLOB (folder listing)
  try{
    const r = await apiPost('ListBLOB', { container:'prompts', prefix:'client/', recursive:false });
    // Accept various shapes
    let folders = [];
    if(Array.isArray(r.prefixes)){ folders = r.prefixes; }
    else if (Array.isArray(r.folders)){ folders = r.folders; }
    else if (r.items){ folders = Object.keys(r.items).filter(k=>k.endsWith('/')).map(k=>k); }
    folders = folders.map(p=>p.replace(/^client\//,'').replace(/\/$/,''));
    return folders.filter(code=>/^[A-Z0-9]{4}$/.test(code));
  }catch(e){
    // Fallback: ListFiles then derive folders
    const r2 = await apiPost('ListFiles', { container:'prompts', prefix:'client/', recursive:true });
    const paths = (r2.files||r2||[]).map(x=>typeof x==='string'?x:(x.name||''));
    const set = new Set();
    for(const p of paths){
      const m = p.match(/^client\/([A-Z0-9]{4})\//);
      if(m) set.add(m[1]);
    }
    return [...set];
  }
}


async function ensurePromptIndex(code){
  try{
    await apiPost('LoadPromptText', { container:'prompts', blobPath:`client/${code}/prompt-index.json` });
    return; // exists
  }catch(e){
    // create with roomphoto fixed
    const index = {
      prompt:[
        { file:'texel-roomphoto.json', name:'画像分析プロンプト', order:10, hidden:false, locked:true }
      ],
      params:{}
    };
    await apiPost('SavePromptText', { container:'prompts', blobPath:`client/${code}/prompt-index.json`, text: JSON.stringify(index, null, 2) });
    // create empty roomphoto if not exists
    try{
      await apiPost('LoadPromptText', { container:'prompts', blobPath:`client/${code}/texel-roomphoto.json` });
    }catch(_){
      await apiPost('SavePromptText', { container:'prompts', blobPath:`client/${code}/texel-roomphoto.json`, text: '' });
    }
  }
}

async function saveAll(){
  const used = new Set();
  for(const r of rows){
    if(!/^[A-Z0-9]{4}$/.test(r.code||'')) throw new Error('コードは英数4桁: '+(r.code||'(空)'));
    if(used.has(r.code)) throw new Error('コード重複: '+r.code);
    used.add(r.code);
  }
  for(const r of rows){
    const blobPath = `client/${r.code}/texel-client-catalog.json`;
    const payload = { code: r.code, name: r.name||'' };
    await apiPost('SavePromptText', { container:'prompts', blobPath, text: JSON.stringify(payload, null, 2) });
    await ensurePromptIndex(r.code);
  }
  alert('保存しました');
}
if(btnSave){ btnSave.addEventListener('click', ()=>saveAll().catch(e=>alert(e.message||e))); }

// --- UI cleanup (remove JSON buttons & bottom toolbar) ----------------------
(function cleanupUI() {
  // 上部の JSON ボタンを除去（ラベル一致で安全に）
  const killLabels = new Set(['JSON出力','JSON取込','JSON読み込み','JSON読込']);
  document.querySelectorAll('button, a[role="button"]').forEach(b => {
    const t = (b.textContent || '').trim();
    if (killLabels.has(t)) b.remove();
  });

  // もしフッター側に複製のツールバーがあるなら削除
  const bottomBars = Array.from(document.querySelectorAll('footer, .actions-bottom, .toolbar-bottom, .page-footer'));
  bottomBars.forEach(el => {
    // ボタンを含んでいそうなバーだけを対象に
    if (el.querySelector('button, a[role="button"]')) el.remove();
  });

  // 万一テンプレートで複数回生成されても、初回だけ動くようにする
  cleanupUI = () => {};
})();
