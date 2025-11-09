/* ===== Prompt Studio – logic ===== */
const DEV_API  = "https://func-texel-api-dev-jpe-001-b2f6fec8fzcbdrc3.japaneast-01.azurewebsites.net/api/";
const PROD_API = "https://func-texel-api-prod-jpe-001-dsgfhtafbfbxawdz.japaneast-01.azurewebsites.net/api/";

const KIND_TO_NAME = {
  "suumo-catch":   "texel-suumo-catch.json",
  "suumo-comment": "texel-suumo-comment.json",
  "roomphoto":     "texel-roomphoto.json",
  "suggestion":    "texel-suggestion.json",
  "athome-appeal": "texel-athome-appeal.json",
  "athome-comment":"texel-athome-comment.json",
};
const FAMILY = {
  "BASE":   new Set(["suumo-catch","suumo-comment","roomphoto","suggestion","athome-appeal","athome-comment"]),
  "TYPE-R": new Set(["suumo-catch","suumo-comment","roomphoto","suggestion","athome-appeal","athome-comment"]),
  "TYPE-S": new Set(["suumo-catch","suumo-comment","roomphoto","suggestion"])
};

const els = {
  clientId:  document.getElementById("clientId"),
  behavior:  document.getElementById("behavior"),
  apiBase:   document.getElementById("apiBase"),
  fileList:  document.getElementById("fileList"),
  search:    document.getElementById("search"),
  fileTitle: document.getElementById("fileTitle"),
  badgeState:document.getElementById("badgeState"),
  badgeEtag: document.getElementById("badgeEtag"),
  tabPromptBtn: document.getElementById("tabPromptBtn"),
  tabParamsBtn: document.getElementById("tabParamsBtn"),
  promptTab:    document.getElementById("promptTab"),
  paramsTab:    document.getElementById("paramsTab"),
  promptEditor: document.getElementById("promptEditor"),
  btnSave:   document.getElementById("btnSave"),
  btnDiff:   document.getElementById("btnDiff"),
  diffPanel: document.getElementById("diffPanel"),
  diffLeft:  document.getElementById("diffLeft"),
  diffRight: document.getElementById("diffRight"),
  status:    document.getElementById("statusMessage"),
};

let currentKind = null;
let currentFilenameTarget = null;
let currentEtag = null;
let templateText = "";
let loadedParams = {};
let dirty = false;

/* ---------- Tabs ---------- */
function showTab(which){
  const isPrompt = which === "prompt";
  els.tabPromptBtn.classList.toggle("active", isPrompt);
  els.tabParamsBtn.classList.toggle("active", !isPrompt);
  els.promptTab.classList.toggle("active", isPrompt);
  els.paramsTab.classList.toggle("active", !isPrompt);
}
els.tabPromptBtn.addEventListener("click", ()=>showTab("prompt"));
els.tabParamsBtn.addEventListener("click", ()=>showTab("params"));

/* ---------- Params ---------- */
const paramKeys = [
  ["max_tokens",         800],
  ["temperature",       1.00],
  ["top_p",             1.00],
  ["frequency_penalty", 0.00],
  ["presence_penalty",  0.00],
  ["n",                 1   ],
];
function writeParamUI(params){
  paramKeys.forEach(([k, def])=>{
    const input = document.getElementById("param_"+k);
    const span  = document.getElementById("val_"+k);
    if (!input || !span) return;
    const v = (params && params[k] !== undefined) ? params[k] : def;
    input.value = v;
    span.textContent = (""+v).includes(".") ? Number(v).toFixed(2) : v;
  });
}
function readParamUI(){
  const o = {};
  paramKeys.forEach(([k])=>{
    const v = document.getElementById("param_"+k).value;
    o[k] = (""+v).includes(".") ? parseFloat(v) : parseInt(v,10);
  });
  return o;
}
paramKeys.forEach(([k])=>{
  const input = document.getElementById("param_"+k);
  const span  = document.getElementById("val_"+k);
  if (input && span){
    input.addEventListener("input", ()=>{
      const v = input.value;
      span.textContent = (""+v).includes(".") ? Number(v).toFixed(2) : v;
      markDirty();
    });
  }
});

/* ---------- Boot ---------- */
window.addEventListener("DOMContentLoaded", boot);
function boot(){
  const q = new URLSearchParams(location.hash.replace(/^#\??/, ''));
  els.clientId.value = (q.get("client") || "").toUpperCase();
  els.behavior.value = (q.get("behavior") || "BASE").toUpperCase();
  els.apiBase.value  = q.get("api") || DEV_API;

  renderFileList();

  window.addEventListener("keydown", (e)=>{
    if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==="s"){ e.preventDefault(); saveCurrent(); }
  });

  els.search.addEventListener("input", ()=>{
    const kw = els.search.value.toLowerCase();
    [...els.fileList.children].forEach(it=>{
      const t = it.querySelector(".name").textContent.toLowerCase();
      it.style.display = t.includes(kw) ? "" : "none";
    });
  });

  els.promptEditor.addEventListener("input", markDirty);
}
function markDirty(){ dirty = true; }
function clearDirty(){ dirty = false; }
window.addEventListener("beforeunload", (e)=>{ if (!dirty) return; e.preventDefault(); e.returnValue=""; });

/* ---------- File List ---------- */
async function renderFileList(){
  els.fileList.innerHTML = "";
  const clid = els.clientId.value.trim().toUpperCase();
  const beh  = els.behavior.value.toUpperCase();
  const kinds = Object.keys(KIND_TO_NAME).filter(k=>FAMILY[beh].has(k));

  for (const kind of kinds){
    const name = KIND_TO_NAME[kind];
    const li = document.createElement("div");
    li.className = "fileitem";
    li.dataset.kind = kind;
    li.innerHTML = `<div class="name" title="${name}">${name}</div><div class="meta"><span class="chip">checking…</span></div>`;
    els.fileList.appendChild(li);

    const clientPath = `client/${clid}/${name}`;
    const legacyPath = `prompt/${clid}/${name}`;
    const template   = behaviorTemplatePath(beh, kind);

    const state = await resolveState([clientPath, legacyPath], template);
    const chip  = li.querySelector(".chip");
    if (state === "client") { chip.textContent = "Overridden"; chip.classList.add("ok"); }
    else if (state === "legacy"){ chip.textContent = "Overridden (legacy)"; chip.classList.add("ok"); }
    else if (state === "template"){ chip.textContent = "Template"; chip.classList.add("info"); }
    else { chip.textContent = "Missing"; chip.classList.add("warn"); }

    li.addEventListener("click", ()=> openKind(kind));
  }
}
function behaviorTemplatePath(beh, kind){
  const base = KIND_TO_NAME[kind];
  if (beh === "TYPE-R") return base.replace("texel-", "texel-r-");
  if (beh === "TYPE-S") return base.replace("texel-", "texel-s-");
  return base;
}

/* ---------- Load ---------- */
async function tryLoad(filename){
  const url = join(els.apiBase.value, "LoadPromptText") + `?filename=${encodeURIComponent(filename)}`;
  const res = await fetch(url, { cache: "no-store" }).catch(()=>null);
  if (!res || !res.ok) return null;
  const etag = res.headers.get("etag") || null;
  let data = {};
  try { data = await res.json(); } catch { data = {}; }
  return { data, etag };
}
async function resolveState(clientCandidates, templatePath){
  for (const c of clientCandidates){
    const r = await tryLoad(c);
    if (r) return c.includes("/prompt/") ? "legacy" : "client";
  }
  if (await tryLoad(templatePath)) return "template";
  return "missing";
}

async function openKind(kind){
  if (dirty && !confirm("未保存の変更があります。破棄して読み込みますか？")) return;

  currentKind = kind;
  els.diffPanel.hidden = true;
  [...els.fileList.children].forEach(n=>n.classList.toggle("active", n.dataset.kind===kind));
  setStatus("読込中…","orange");

  const clid = els.clientId.value.trim().toUpperCase();
  const beh  = els.behavior.value.toUpperCase();
  const name = KIND_TO_NAME[kind];

  currentFilenameTarget = `client/${clid}/${name}`;
  document.getElementById("fileTitle").textContent = currentFilenameTarget;

  const candidates = [
    `client/${clid}/${name}`,
    `prompt/${clid}/${name}`,
    behaviorTemplatePath(beh, kind)
  ];

  let loaded = null, used = null;
  for (const f of candidates){
    const r = await tryLoad(f);
    if (r) { loaded = r; used = f; break; }
  }
  const templ = await tryLoad(behaviorTemplatePath(beh, kind));
  templateText = templ ? JSON.stringify(templ.data, null, 2) : "";

  if (!loaded){
    currentEtag = null;
    els.promptEditor.value = "";
    loadedParams = {};
    writeParamUI(loadedParams);
    setBadges("Missing（新規）", null);
    setStatus("新規作成できます。右上の保存で client 配下に作成します。");
    clearDirty();
    return;
  }

  const d = loaded.data || {};
  let promptText = "";
  if (typeof d.prompt === "string") promptText = d.prompt;
  else if (d.prompt && typeof d.prompt.text === "string") promptText = d.prompt.text;
  else if (typeof d === "string") promptText = d;
  else promptText = JSON.stringify(d, null, 2);

  els.promptEditor.value = promptText;
  loadedParams = d.params || {};
  writeParamUI(loadedParams);

  currentEtag = (used.startsWith("client/") || used.startsWith("prompt/")) ? loaded.etag : null;

  if (used.startsWith("client/")) setBadges("Overridden", currentEtag, "ok");
  else if (used.startsWith("prompt/")) setBadges("Overridden (legacy)", currentEtag, "ok");
  else setBadges("Template（未上書き）", loaded.etag || "—", "info");

  setStatus("読み込み完了","green");
  clearDirty();
}

/* ---------- Save ---------- */
els.btnSave.addEventListener("click", saveCurrent);
async function saveCurrent(){
  if (!currentFilenameTarget) return;
  const prompt = els.promptEditor.value;
  const params = readParamUI();
  const body = { filename: currentFilenameTarget, prompt, params, etag: currentEtag || undefined };

  setStatus("保存中…","orange");
  try{
    const r = await fetch(join(els.apiBase.value, "SavePromptText"), {
      method:"POST",
      headers:{ "Content-Type":"application/json; charset=utf-8" },
      body: JSON.stringify(body)
    });
    const raw = await r.text(); let json={}; try{ json = raw?JSON.parse(raw):{} }catch{}
    if (!r.ok) throw new Error(json?.error || raw || `HTTP ${r.status}`);

    currentEtag = json?.etag || currentEtag || null;
    setBadges("Overridden", currentEtag, "ok");
    setStatus("保存完了","green");
    clearDirty();
    renderFileList();
  }catch(e){
    setStatus("保存失敗: " + e.message, "red");
    if (String(e).includes("412")) alert("他の人が更新しました。再読み込みしてから保存してください。");
  }
}

/* ---------- Diff ---------- */
els.btnDiff.addEventListener("click", ()=>{
  els.diffLeft.value  = templateText || "(テンプレートなし)";
  els.diffRight.value = els.promptEditor.value || "";
  els.diffPanel.hidden = !els.diffPanel.hidden;
});

/* ---------- Utils ---------- */
function setStatus(msg, color="#0AA0A6"){ els.status.style.color = color; els.status.textContent = msg; }
function setBadges(stateText, etag, mode){
  els.badgeState.textContent = stateText;
  els.badgeState.className = "chip " + (mode||"");
  els.badgeEtag.textContent = etag || "—";
}
function join(base, path){ return (base||"").replace(/\/+$/,"") + "/" + String(path||"").replace(/^\/+/,""); }



/* ===== Prompt Studio: Reliable "+追加" implementation (minimal, UI unchanged) ===== */
(function(){
  if (window.__promptStudioAddFixed) return; window.__promptStudioAddFixed = true;

  // ---- State bootstrap (from hash #?client=...&behavior=...&api=... ) ----
  const H = new URLSearchParams((location.hash||'').replace(/^#\??/, ''));
  const state = window.state = window.state || {};
  state.clientCode = state.clientCode || (H.get('client')||'').toUpperCase();
  state.behavior   = state.behavior   || (H.get('behavior')||'BASE');
  state.apiBase    = state.apiBase    || (H.get('api')||'').trim();

  // Fallback: localStorage / input#apiBase (if any)
  try {
    if (!state.apiBase) {
      const saved = localStorage.getItem('promptStudio.apiBase');
      if (saved) state.apiBase = saved;
    } else {
      localStorage.setItem('promptStudio.apiBase', state.apiBase);
    }
  } catch(_){}
  if (!state.apiBase) {
    const apiEl = document.getElementById('apiBase');
    if (apiEl && apiEl.value) state.apiBase = apiEl.value.trim();
  }

  function apiJoin(base, fn){ return (base||'').replace(/\/+$/,'') + '/' + String(fn||'').replace(/^\/+/,''); }
  async function apiPost(fn, body){
    if(!state.apiBase) throw new Error('API Base 未設定');
    const url = apiJoin(state.apiBase, fn);
    const res = await fetch(url, {
      method:'POST', headers:{'Content-Type':'application/json; charset=utf-8'},
      body: JSON.stringify(body||{})
    });
    const text = await res.text();
    const ctype = res.headers.get('content-type')||'';
    let json = null;
    try { if (ctype.includes('application/json')) json = JSON.parse(text); } catch{}
    if (!res.ok) throw new Error((json && json.error) || text || `HTTP ${res.status}`);
    return json ?? text;
  }

  // ---- Index helpers (define if project doesn't provide) ----
  async function defaultLoadPromptIndex(clientCode, behavior){
    // prompt-index.json is under client/<CODE>/
    try {
      const r = await apiPost('LoadBLOB', { container:'prompts', filename:`client/${clientCode}/prompt-index.json` });
      if (typeof r === 'string') return JSON.parse(r);
      if (r && r.text) return JSON.parse(r.text);
    } catch(_){ /* not found */ }
    return { version:1, client: clientCode, behavior, prompts:[], params:{} };
  }
  async function defaultSavePromptIndex(clientCode, behavior, indexObj){
    return apiPost('SaveBLOB', {
      container:'prompts',
      filename:`client/${clientCode}/prompt-index.json`,
      text: JSON.stringify(indexObj, null, 2),
      contentType:'application/json; charset=utf-8'
    });
  }
  async function defaultSavePromptText(clientCode, fileName, text, opts){
    return apiPost('SaveBLOB', {
      container:'prompts',
      filename:`client/${clientCode}/${fileName}`,
      text: text ?? '',
      contentType:'application/json; charset=utf-8'
    });
  }

  const loadPromptIndex = window.loadPromptIndex || defaultLoadPromptIndex;
  const savePromptIndex = window.savePromptIndex || defaultSavePromptIndex;
  const savePromptText  = window.savePromptText  || defaultSavePromptText;

  // ---- Roomphoto pin ----
  function ensureRoomPhotoPinned(indexObj){
    const fixedFile = 'texel-roomphoto.json';
    const fixedName = '画像分析プロンプト';
    indexObj.prompts = Array.isArray(indexObj.prompts) ? indexObj.prompts : [];
    let rp = indexObj.prompts.find(p => p.file === fixedFile);
    if (!rp){
      indexObj.prompts.unshift({ file: fixedFile, name: fixedName, order: 0, hidden: false, locked: true });
    } else {
      rp.name = fixedName; rp.locked = true; rp.order = 0;
    }
    indexObj.prompts.sort((a,b)=> (b.locked?1:0)-(a.locked?1:0) || (a.order||0)-(b.order||0))
      .forEach((p,i)=> p.order = i*10);
  }

  // ---- filename helpers ----
  function ts(){ const d=new Date(); const p=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }
  function slug(s){ return String(s||'').toLowerCase().replace(/[^\w\-]+/g,'-').replace(/\-+/g,'-').replace(/^\-|\-$/g,''); }

  // ---- render refresh ----
  async function refreshList(fileToSelect){
    try {
      if (typeof window.renderFileList === 'function') {
        // 既存の描画ロジックを呼ぶ
        if (!window.state.promptIndex) window.state.promptIndex = await loadPromptIndex(state.clientCode, state.behavior);
        window.renderFileList();
        if (fileToSelect && typeof window.selectFileInList === 'function') window.selectFileInList(fileToSelect);
        return;
      }
    } catch(_){}
    // 最後の手段：リロード（UIを壊したくないため）
    if (fileToSelect) sessionStorage.setItem('__ps.select', fileToSelect);
    location.reload();
  }

  // ---- add handler ----
  async function onAdd(){
    if (!/^[A-Z0-9]{4}$/.test(state.clientCode||'')) { alert('クライアントコードが不正です'); return; }
    const name = prompt('新しいプロンプトの表示名', 'おすすめ');
    if (name === null) return;

    let indexObj = window.state.promptIndex;
    if (!indexObj) indexObj = window.state.promptIndex = await loadPromptIndex(state.clientCode, state.behavior);
    ensureRoomPhotoPinned(indexObj);

    // Generate unique file name
    const base = slug(name||'prompt');
    let file = `${base}-${ts()}.json`;
    // guard against accidental duplicates in-memory
    const exists = new Set(indexObj.prompts.map(p=>p.file));
    let n=2;
    while(exists.has(file)){
      file = `${base}-${ts()}-${n++}.json`;
    }

    // Insert after roomphoto
    const insertAt = Math.min(1, indexObj.prompts.length);
    const nextOrder = (indexObj.prompts.at(-1)?.order ?? 0) + 10;
    indexObj.prompts.splice(insertAt, 0, { file, name: name || '新しいプロンプト', order: nextOrder, hidden:false });

    // 1) Save index
    await savePromptIndex(state.clientCode, state.behavior, indexObj);

    // 2) Create prompt file
    const template = [
      '// Prompt template',
      '// ここにルールや出力形式を書いてください。'
    ].join('\n');
    await savePromptText(state.clientCode, file, template, { behavior: state.behavior });

    // 3) Refresh list and focus
    await refreshList(file);

    // 4) Optional toast
    try { if (typeof window.showToast === 'function') window.showToast('新しいプロンプトを追加しました'); } catch(_){}
  }

  // ---- wire button ----
  function findAddButton(){
    let btn = document.querySelector('#btnAdd, [data-action="add-prompt"], .js-add-prompt');
    if (btn) return btn;
    const candidates = Array.from(document.querySelectorAll('button, .button, .btn'));
    return candidates.find(el => (el.textContent || '').replace(/\s/g,'').includes('追加')) || null;
  }
  function wire(){
    const btn = findAddButton();
    if (btn && !btn.__wiredAdd){
      btn.__wiredAdd = true;
      btn.addEventListener('click', onAdd);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  // ---- select after reload (if any) ----
  try {
    const selectAfter = sessionStorage.getItem('__ps.select');
    if (selectAfter){
      sessionStorage.removeItem('__ps.select');
      if (typeof window.selectFileInList === 'function') window.selectFileInList(selectAfter);
    }
  } catch(_){}
})();
/* ===== /Prompt Studio "+追加" fix ========================================= */
