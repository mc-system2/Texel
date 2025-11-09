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

/* ---------- Prompt Index (order & display name) ---------- */
let promptIndex = null;      // {version, clientId, behavior, updatedAt, items:[{file,name,order,hidden}]}
let promptIndexPath = null;  // BLOB path
let promptIndexEtag = null;  // ETag

function indexBehaviorPath(clientId, behavior){
  return `client/${clientId}/${behavior}/prompt-index.json`;
}
function indexClientPath(clientId){
  return `client/${clientId}/prompt-index.json`;
}
function prettifyNameFromFile(filename){
  return filename.replace(/\.json$/i,'')
                 .replace(/^texel[-_]?/i,'')
                 .replace(/[-_]+/g,' ')
                 .replace(/\b\w/g, s=>s.toUpperCase());
}

// load if exists
async function tryLoad(path){
  try{
    const r = await fetch(join(els.apiBase.value, "LoadPromptText"), {
      method:"POST",
      headers:{ "Content-Type":"application/json; charset=utf-8" },
      body: JSON.stringify({ filename: path })
    });
    if (!r.ok) return null;
    const json = await r.json();
    const dataText = json && typeof json.text === 'string' ? json.text : (typeof json.prompt === 'string' ? json.prompt : null);
    let data = null;
    if (dataText){ try{ data = JSON.parse(dataText); }catch{ data = dataText; } }
    if (!data && json && typeof json.prompt === 'object') data = json;
    return { etag: json?.etag ?? null, data };
  }catch{ return null; }
}

// Save index json via SavePromptText
async function saveIndex(path, idx, etag){
  const payload = { filename: path, prompt: JSON.stringify(idx, null, 2) };
  if (etag) payload.etag = etag;
  const r = await fetch(join(els.apiBase.value, "SavePromptText"), {
    method:"POST",
    headers:{ "Content-Type":"application/json; charset=utf-8" },
    body: JSON.stringify(payload)
  });
  const raw = await r.text(); let j={}; try{ j = raw?JSON.parse(raw):{} }catch{}
  if (!r.ok) throw new Error(j?.error || raw || `HTTP ${r.status}`);
  promptIndexEtag = j?.etag || promptIndexEtag || null;
  return j;
}
async function saveIndexRobust(path, localIdx){
  // Try optimistic save with known etag; if lost update -> refetch/merge/retry
  try{
    await saveIndex(path, localIdx, promptIndexEtag);
    return true;
  }catch(e){
    // refetch latest then merge
    const latest = await tryLoad(path);
    const srv = normalizeIndex(latest?.data) || { items: [] };
    const merged = mergeIndexItems(srv, localIdx);
    promptIndexEtag = latest?.etag || null;
    await saveIndex(path, merged, promptIndexEtag);
    // Replace current in-memory
    promptIndex = merged;
    return true;
  }
}
function mergeIndexItems(serverIdx, localIdx){
  const out = { ...serverIdx, version: (serverIdx.version||1), clientId: localIdx.clientId||serverIdx.clientId, behavior: localIdx.behavior||serverIdx.behavior, updatedAt: new Date().toISOString() };
  const map = new Map();
  (serverIdx.items||[]).forEach(it=> map.set(it.file, { ...it }));
  (localIdx.items||[]).forEach(it=>{
    if (!map.has(it.file)) map.set(it.file, { ...it });
    else {
      const cur = map.get(it.file);
      map.set(it.file, { ...cur, ...it });
    }
  });
  const arr = [...map.values()];
  arr.sort((a,b)=>(a.order??0)-(b.order??0));
  // pin roomphoto top
  const pinned = arr.filter(isRoomphotoFile);
  const rest   = arr.filter(it=>!isRoomphotoFile(it));
  pinned.forEach((it,i)=> it.order = (i+1)*10);
  rest.forEach((it,i)=> it.order = (pinned.length*10) + (i+1)*10);
  out.items = [...pinned, ...rest];
  return out;
}
function isRoomphotoFile(it){
  const f = (typeof it==="string"?it:it.file||"").toLowerCase();
  return f==="texel-roomphoto.json" || f==="roomphoto.json";
}


// ensure index exists (client-root preferred), else auto-generate
function normalizeIndex(obj){
  try{
    if (!obj) return null;
    if (obj.items && Array.isArray(obj.items)) return obj;
    if (obj.prompt && obj.prompt.items) return obj.prompt;
    // Some endpoints may return stringified index
    if (typeof obj === "string"){
      const parsed = JSON.parse(obj);
      if (parsed.items) return parsed;
      if (parsed.prompt && parsed.prompt.items) return parsed.prompt;
    }
  }catch{}
  return null;
}

async function ensurePromptIndex(clientId, behavior){
  const path = indexClientPath(clientId);
  const res = await tryLoad(path);
  if (res && res.data){
    const n = normalizeIndex(res.data);
    if (n){
      promptIndex = n;
      promptIndexPath = path;
      promptIndexEtag = res.etag || null;
      return promptIndex;
    }
  }
  // auto-generate from behavior kinds
  const kinds = Object.keys(KIND_TO_NAME).filter(k=>FAMILY[behavior].has(k));
  const items = kinds.map((k,i)=>{
    const file = KIND_TO_NAME[k];
    return { file, name: prettifyNameFromFile(file), order: (i+1)*10, hidden:false };
  });
  promptIndex = { version:1, clientId, behavior, updatedAt:new Date().toISOString(), items };
  promptIndexPath = path;
  promptIndexEtag = null;
  await saveIndex(promptIndexPath, promptIndex, null);
  return promptIndex;
}


// Rename an item and save index
async function renameIndexItem(file, newName){
  if (!promptIndex) return;
  const it = promptIndex.items.find(x=>x.file===file);
  if (!it) return;
  it.name = newName || it.name;
  promptIndex.updatedAt = new Date().toISOString();
  await saveIndex(promptIndexPath, promptIndex, promptIndexEtag);
}
async function tryDelete(path){
  const base = els.apiBase.value.replace(/\/+$/,'');
  const postCandidates = ["DeletePromptText","DeleteBlob","DeleteFile"]; // POST JSON
  const getCandidates  = ["DeletePromptText"]; // GET ?filename=
  const body = JSON.stringify({ filename: path });
  for (const name of postCandidates){
    const url = base+"/"+name;
    try{ const r = await fetch(url, { method:"POST", headers:{"Content-Type":"application/json"}, body }); if (r.ok) return true; }catch(e){}
  }
  // try GET style
  for (const name of getCandidates){
    const url = base+"/"+name+"?filename="+encodeURIComponent(path);
    try{ const r = await fetch(url, { method:"GET" }); if (r.ok) return true; }catch(e){}
  }
  return false;
}

async function deleteIndexItem(file){
  if (!promptIndex) return;
  const before = promptIndex.items.length;
  promptIndex.items = promptIndex.items.filter(x=>x.file!==file);
  // re-number order in 10s
  promptIndex.items.sort((a,b)=>(a.order??0)-(b.order??0))
                  .forEach((it,i)=> it.order = (i+1)*10);
  if (promptIndex.items.length === before) return; // nothing removed
  promptIndex.updatedAt = new Date().toISOString();
  await saveIndex(promptIndexPath, promptIndex, promptIndexEtag);
}


// Update orders from current DOM list and save
async function saveOrderFromDOM(){
  if (!promptIndex) return;
  const lis = [...els.fileList.querySelectorAll('.fileitem')];
  let cursor = 0;
  for (const el of lis){
    const f = el.dataset.file; const it = promptIndex.items.find(x=>x.file===f);
    if (!it) continue;
    if (isRoomphotoFile(it)) { it.order = 10; continue; }
    cursor += 10; it.order = 10 + cursor;
  }
  promptIndex.updatedAt = new Date().toISOString();
  await saveIndex(promptIndexPath, promptIndex, promptIndexEtag);
}


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

  await ensurePromptIndex(clid, beh);

  const kinds = Object.keys(KIND_TO_NAME).filter(k=>FAMILY[beh].has(k));
  const allowedFiles = new Set(kinds.map(k=>KIND_TO_NAME[k]));

  const rows = [...((promptIndex && Array.isArray(promptIndex.items) ? promptIndex.items : []))]
    .filter(it => !it.hidden)
    .sort((a,b)=>(a.order??0)-(b.order??0));

  // enable drag sort events on container
  els.fileList.addEventListener('dragover', (e)=>{
    e.preventDefault();
    const dragging = document.querySelector('.fileitem.dragging');
    const after = getDragAfterElement(els.fileList, e.clientY);
    if (!after) els.fileList.appendChild(dragging);
    else els.fileList.insertBefore(dragging, after);
  });
  els.fileList.addEventListener('drop', async ()=>{ await saveOrderFromDOM(); });

  for (const it of rows){
    const name = it.name || prettifyNameFromFile(it.file);
    const li = document.createElement("div");
    li.className = "fileitem";
    li.dataset.file = it.file;
    const pinned = isRoomphotoFile(it);
    li.draggable = !pinned;
    li.innerHTML = `<span class="drag">≡</span>
                    <div class="name" title="${it.file}">${name}${isRoomphotoFile(it)?' <span class="chip info">固定</span>':''} </div>
                    <div class="meta">
                      ${isRoomphotoFile(it)?'':'<button class="rename" title="名称を変更">✎</button><button class="trash" title="削除">🗑</button>'}
                    </div>`;
    els.fileList.appendChild(li);

    li.addEventListener('dragstart', ()=> { if(li.draggable){ li.classList.add('dragging'); } });
    li.addEventListener('dragend', async ()=>{
      li.classList.remove('dragging');
      await saveOrderFromDOM();
    });

        // (state check removed)
li.addEventListener("click", (e)=>{ if (!e.target.classList.contains("rename") && !e.target.classList.contains("drag")) openItem(it); });

    li.querySelector(".rename").addEventListener("click", (e)=>{
      e.preventDefault(); e.stopPropagation();
      const nameDiv = li.querySelector(".name");
      const current = nameDiv.textContent;
      nameDiv.classList.add("editing");
      nameDiv.innerHTML = `<input value="${current}" aria-label="name">`;
      if (pinned) return; const input = nameDiv.querySelector("input");
      const finish = async (commit)=>{
        nameDiv.classList.remove("editing");
        if (commit){
          const nv = input.value.trim() || current;
          nameDiv.textContent = nv;
          await renameIndexItem(it.file, nv);
        } else {
          nameDiv.textContent = current;
        }
      };
      input.addEventListener("keydown", (ev)=>{
        if (ev.key==="Enter") finish(true);
        else if (ev.key==="Escape") finish(false);
      });
      input.addEventListener("blur", ()=>finish(true));
      input.focus(); input.select();
    });

    if (!pinned) li.querySelector(".trash").addEventListener("click", async (e)=>{
      e.preventDefault(); e.stopPropagation();
      const ok = confirm(`「${name}」を一覧から削除します。\n※ BLOB の実ファイルも削除します。`);
      if (!ok) return;
      // 先に BLOB を削除（失敗しても index は進める）
      const blobPath = `client/${clid}/${it.file}`;
      const okDel = await tryDelete(blobPath);
      // read-back verification (best-effort)
      const still = await tryLoad(blobPath);
      await deleteIndexItem(it.file);
      const done = okDel && !still;
      setStatus(done?"削除しました（BLOBも削除）":"インデックスのみ削除しました（BLOB削除失敗）","green");
      await renderFileList();
      // もし削除したアイテムを編集中ならエディタをリセット
      if (currentFilenameTarget && currentFilenameTarget.endsWith(`/${it.file}`)){
        currentFilenameTarget = null; currentEtag = null;
        els.fileTitle.textContent = "未選択"; els.promptEditor.value = ""; writeParamUI({});
      }
    });
  }
}

function getDragAfterElement(container, y){
  const els = [...container.querySelectorAll('.fileitem:not(.dragging)')];
  return els.reduce((closest, child)=>{
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height/2;
    return (offset < 0 && offset > closest.offset) ? { offset, element: child } : closest;
  }, { offset: Number.NEGATIVE_INFINITY }).element;
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


async function openItem(it){
  if (dirty && !confirm("未保存の変更があります。破棄して読み込みますか？")) return;

  els.diffPanel.hidden = true;
  [...els.fileList.children].forEach(n=>n.classList.toggle("active", n.dataset.file===it.file));
  setStatus("読込中…","orange");

  const clid = els.clientId.value.trim().toUpperCase();
  const beh  = els.behavior.value.toUpperCase();
  const name = it.file;

  currentFilenameTarget = `client/${clid}/${name}`;
  document.getElementById("fileTitle").textContent = currentFilenameTarget;

  const candidates = [
    `client/${clid}/${name}`,
    `prompt/${clid}/${name}`,
    templateFromFilename(name, beh)
  ];

  let loaded = null, used = null;
  for (const f of candidates){
    const r = await tryLoad(f);
    if (r) { loaded = r; used = f; break; }
  }
  const templ = await tryLoad(templateFromFilename(name, beh));
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

  if (used.startsWith("client/")) setBadges("上書き", currentEtag, "ok");
  else if (used.startsWith("prompt/")) setBadges("上書き（旧）", currentEtag, "ok");
  else setBadges("Template（未上書き）", loaded.etag || "—", "info");

  setStatus("読み込み完了","green");
  clearDirty();
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

  if (used.startsWith("client/")) setBadges("上書き", currentEtag, "ok");
  else if (used.startsWith("prompt/")) setBadges("上書き（旧）", currentEtag, "ok");
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
    setBadges("上書き", currentEtag, "ok");
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

function templateFromFilename(filename, behavior){
  if (behavior === "TYPE-R") return filename.replace(/^texel-/, "texel-r-");
  if (behavior === "TYPE-S") return filename.replace(/^texel-/, "texel-s-");
  return filename;
}


/* === Add Prompt (+追加) unified handler (safe append) ===================== */
(function(){
  if (window.__addPromptPatched) return; window.__addPromptPatched = true;

  function findAddButton(){
    // Try common selectors
    let btn = document.querySelector('#btnAdd, [data-action="add-prompt"], .js-add-prompt');
    if (btn) return btn;
    // Fallback: scan buttons that contain '追加'
    const candidates = Array.from(document.querySelectorAll('button, .button, .btn'));
    return candidates.find(el => (el.textContent || '').replace(/\s/g,'').includes('追加')) || null;
  }

  function timestampId(){
    const d = new Date();
    const pad = n => String(n).padStart(2,'0');
    return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }
  function sanitizeFileBase(s){
    return (s||'').toLowerCase().replace(/[^\w\-]+/g,'-').replace(/\-+/g,'-').replace(/^\-|\-$/g,'');
  }

  async function ensurePromptIndexLoaded(){
  if (promptIndex && Array.isArray(promptIndex.items)) return;
  const clid = els.clientId.value.trim() || "A001";
  const path = indexClientPath(clid);
  const res  = await tryLoad(path);
  promptIndexPath = path;
  promptIndexEtag = res?.etag || null;
  promptIndex = normalizeIndex(res?.data) || { version:1, clientId: clid, behavior: (els.behavior.value||'BASE'), items:[], params:{} };
}

/* === / Add Prompt handler ================================================ */


/* === Patch: Add (+追加) handler & label localization ===================== */
(function(){
  if (window.__psAddOnce) return; window.__psAddOnce = true;

  const els = {
    apiBase: document.getElementById("apiBase"),
    clientId: document.getElementById("clientId"),
    behavior: document.getElementById("behavior"),
    fileList: document.getElementById("fileList"),
    promptEditor: document.getElementById("promptEditor"),
  };

  function join(base, path){ return (base||"").replace(/\/+$/,"") + "/" + String(path||"").replace(/^\/+/,""); }
  function ts(){ const d=new Date(); const p=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }
  function slug(s){ return String(s||'').toLowerCase().replace(/[^\w\-]+/g,'-').replace(/\-+/g,'-').replace(/^\-|\-$/g,''); }

  async function createClientFile(client, file, text){
    const body = { filename: `client/${client}/${file}`, prompt: text ?? '' };
    const res = await fetch(join(els.apiBase.value, "SavePromptText"), {
      method:"POST",
      headers:{ "Content-Type":"application/json; charset=utf-8" },
      body: JSON.stringify(body)
    });
    if (!res.ok){
      const t = await res.text();
      throw new Error(t || `HTTP ${res.status}`);
    }
  }

  async function onAdd(){
    const clid = (els.clientId.value||'').trim().toUpperCase();
    const beh  = (els.behavior.value||'BASE').toUpperCase();
    if (!clid || !/^[A-Z0-9]{4}$/.test(clid)){ alert("クライアントコードが不正です"); return; }

    // ask display name
    const display = prompt("新しいプロンプトの表示名", "おすすめ");
    if (display === null) return;

    // ensure index loaded (reuse existing ensurePromptIndex if present)
    if (typeof window.ensurePromptIndex === "function"){
      await window.ensurePromptIndex(clid, beh);
    }
    // fallback: if promptIndex still empty, synthesize minimal
    if (!window.promptIndex || !Array.isArray(window.promptIndex.items)){
      window.promptIndex = { version:1, clientId: clid, behavior: beh, updatedAt:new Date().toISOString(), items: [] };
    }

    // generate unique file name
    const base = slug(display || "prompt");
    let file = `${base}-${ts()}.json`;
    const exist = new Set(window.promptIndex.items.map(it=>it.file));
    let i=2; while(exist.has(file)){ file = `${base}-${ts()}-${i++}.json`; }

    // insert item after roomphoto if present
    const items = window.promptIndex.items;
    const rpIdx = items.findIndex(x=>x.file==="texel-roomphoto.json");
    let insertAt = (rpIdx >= 0) ? rpIdx+1 : items.length;
    items.splice(insertAt, 0, { file, name: display, order: ((items.length+1)*10), hidden:false });

    // save index
    window.promptIndex.updatedAt = new Date().toISOString();
    if (typeof window.saveIndex === "function"){
      await window.saveIndex(window.promptIndexPath || `client/${clid}/prompt-index.json`, window.promptIndex, window.promptIndexEtag);
    } else if (typeof window.saveIndex === "undefined") {
      // if not exported, use internal saveIndex(path, idx, etag)
      if (typeof saveIndex === "function"){
        await saveIndex(window.promptIndexPath || `client/${clid}/prompt-index.json`, window.promptIndex, window.promptIndexEtag);
      }
    }

    // create actual file
    const template = [
      "// Prompt template",
      "// ここにルールや出力形式を書いてください。"
    ].join("\n");
    await createClientFile(clid, file, template);

    // refresh list & open
    if (typeof window.renderFileList === "function") window.renderFileList();
    if (typeof window.openItem === "function"){
      const it = window.promptIndex.items.find(x=>x.file===file);
      if (it) window.openItem(it);
    }
  }

  // wire button
  const btnAdd = document.getElementById("btnAdd");
  if (btnAdd && !btnAdd.__wired){
    btnAdd.__wired = true;
    btnAdd.addEventListener("click", onAdd);
  }

  // Localize chips after list render
  const _renderFileList = window.renderFileList;
  window.renderFileList = async function(){
    if (_renderFileList) await _renderFileList();

  };
})();
/* === /Patch =============================================================== */