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
/* === Index handling === */
const INDEX_FILENAME = 'prompt-index.json';
let promptIndex = null; // { items: [{file, name, order, fixed?, hidden?}], params:{} }
const DEFAULT_ROOMPHOTO = { file: 'texel-roomphoto.json', name: '画像分析プロンプト', order: 1, fixed: true, hidden: false };
const FALLBACK_ITEMS = [
  DEFAULT_ROOMPHOTO,
  { file:'texel-suumo-catch.json',   name:'Suumo Catch',   order:20, hidden:false },
  { file:'texel-suumo-comment.json', name:'Suumo Comment', order:30, hidden:false },
  { file:'texel-suggestion.json',    name:'Suggestion',    order:40, hidden:false },
  { file:'texel-athome-appeal.json', name:'Athome Appeal', order:50, hidden:false },
  { file:'texel-athome-comment.json',name:'Athome Comment',order:60, hidden:false },
];

async function loadIndex(){
  const clid = els.clientId.value.trim().toUpperCase();
  const idxPath = `client/${clid}/${INDEX_FILENAME}`;
  const r = await tryLoad(idxPath);
  if (r && r.data && r.data.items) { promptIndex = r.data; return; }
  // auto-generate when missing
  promptIndex = { version:1, client:clid, items:[...FALLBACK_ITEMS.map(x=>({...x}))], params:{} };
  await saveIndex();
}
async function saveIndex(){
  const clid = els.clientId.value.trim().toUpperCase();
  const body = { filename:`client/${clid}/${INDEX_FILENAME}`, prompt: JSON.stringify(promptIndex, null, 2) };
  await fetch(join(els.apiBase.value, 'SavePromptText'), { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
}

// Helpers to query items
function itemsSorted(){ return [...(promptIndex?.items||[])].sort((a,b)=> (a.order||0)-(b.order||0)); }
function ensureRoomphotoFirst(){
  if (!promptIndex) return;
  const has = promptIndex.items.find(it=>/texel-roomphoto\.json$/i.test(it.file));
  if (!has) promptIndex.items.unshift({...DEFAULT_ROOMPHOTO});
  promptIndex.items = promptIndex.items.map(it=> ({...it, order: it.file==='texel-roomphoto.json'?1: (it.order||100)}));
}


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
  btnAddPrompt: document.getElementById('btnAddPrompt'),
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

  loadIndex().then(()=>{ ensureRoomphotoFirst(); renderFileList(); });

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
  if (!promptIndex) await loadIndex();
  ensureRoomphotoFirst();
  const clid = els.clientId.value.trim().toUpperCase();

  for (const item of itemsSorted()){
    if (item.hidden) continue;
    const li = document.createElement("div");
    li.className = "fileitem";
    li.dataset.file = item.file;
    const lock = /texel-roomphoto\.json$/i.test(item.file) ? '<span title="固定" style="color:#888">🔒</span>' : '';
    li.innerHTML = `<div class="name" title="${item.file}">${item.name||item.file}</div><div class="meta">${lock}<span class="chip">checking…</span><button class="btn ghost sm" data-op="up">↑</button><button class="btn ghost sm" data-op="down">↓</button><button class="btn ghost sm" data-op="del">削除</button></div>`;
    els.fileList.appendChild(li);

    const state = await resolveState([`client/${clid}/${item.file}`, `prompt/${clid}/${item.file}`], item.file);
    const chip  = li.querySelector(".chip");
    if (state === "client") { chip.textContent = "Overridden"; chip.classList.add("ok"); }
    else if (state === "legacy"){ chip.textContent = "Overridden (legacy)"; chip.classList.add("ok"); }
    else if (state === "template"){ chip.textContent = "Template"; chip.classList.add("info"); }
    else { chip.textContent = "Missing"; chip.classList.add("warn"); }

    li.addEventListener("click", (e)=>{ if (e.target.closest('button')) return; openFile(item.file); });
    li.querySelector('[data-op=up]').addEventListener('click', async (e)=>{ e.stopPropagation(); if (item.fixed) return; item.order=(item.order||100)-15; await saveIndex(); renderFileList(); });
    li.querySelector('[data-op=down]').addEventListener('click', async (e)=>{ e.stopPropagation(); if (item.fixed) return; item.order=(item.order||100)+15; await saveIndex(); renderFileList(); });
    li.querySelector('[data-op=del]').addEventListener('click', async (e)=>{ e.stopPropagation(); if (item.fixed) return; if (!confirm('この項目を一覧から削除します（ファイルは消しません）。よろしいですか？')) return; promptIndex.items = promptIndex.items.filter(x=>x!=item); await saveIndex(); renderFileList(); });
  }
}

function file{
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

async function openFile(file){
  if (dirty && !confirm("未保存の変更があります。破棄して読み込みますか？")) return;

  currentKind = file;
  els.diffPanel.hidden = true;
  [...els.fileList.children].forEach(n=>n.classList.toggle("active", n.dataset.kind===kind));
  setStatus("読込中…","orange");

  const clid = els.clientId.value.trim().toUpperCase();
  const beh  = els.behavior.value.toUpperCase();
  const name = file;

  currentFilenameTarget = `client/${clid}/${name}`;
  document.getElementById("fileTitle").textContent = currentFilenameTarget;

  const candidates = [
    `client/${clid}/${name}`,
    `prompt/${clid}/${name}`,
    file
  ];

  let loaded = null, used = null;
  for (const f of candidates){
    const r = await tryLoad(f);
    if (r) { loaded = r; used = f; break; }
  }
  const templ = await tryLoad(file);
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
    loadIndex().then(()=>{ ensureRoomphotoFirst(); renderFileList(); });
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

// Add new prompt item
if (els.btnAddPrompt){
  els.btnAddPrompt.addEventListener('click', async ()=>{
    const name = prompt('表示名（例：SUUMOキャッチ新版）'); if (!name) return;
    const file = prompt('ファイル名（.jsonまで） 例: custom-1.json'); if (!file) return;
    const maxOrder = Math.max(1, ...(promptIndex.items||[]).map(i=>i.order||0));
    promptIndex.items.push({file, name, order:maxOrder+10, hidden:false});
    await saveIndex();
    await renderFileList();
  });
}
