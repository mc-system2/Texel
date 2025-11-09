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
  const candidates = [
    base+"/DeletePromptText",
    base+"/DeleteBlob",
    base+"/DeleteFile"
  ];
  const body = JSON.stringify({ filename: path });
  for (const url of candidates){
    try{
      const r = await fetch(url, { method:"POST", headers:{"Content-Type":"application/json"}, body });
      if (r.ok) return true;
    }catch(e){/* try next */}
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
  lis.forEach((el, i) => {
    const f = el.dataset.file;
    const it = promptIndex.items.find(x=>x.file===f);
    if (it) it.order = (i+1)*10;
  });
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


/* --- Hoisted utility: markDirty (defined before boot) --- */
function markDirty(){
  try{
    window.__ps_dirty = true;
    if (els && els.badgeState){ els.badgeState.textContent = "● 編集中"; }
  }catch(e){}
}


/* --- Hoisted utility: clearDirty (defined before boot) --- */
function clearDirty(){
  try{
    window.__ps_dirty = false;
    if (els && els.badgeState){ els.badgeState.textContent = ""; }
  }catch(e){}
}

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
  // --- safe wiring: search filter & editor dirty flag (ES5-safe) ---
  (function(){
    try{
      var searchEl = document.getElementById('search');
      if (searchEl && !searchEl.__wired){
        searchEl.__wired = true;
        searchEl.addEventListener('input', function(){
          var kw = (searchEl.value||'').toLowerCase();
          var list = (els && els.fileList && els.fileList.children) ? Array.prototype.slice.call(els.fileList.children) : [];
          list.forEach(function(it){
            var nameEl = it.querySelector('.name');
            var t = nameEl ? String(nameEl.textContent||'').toLowerCase() : '';
            it.style.display = t.indexOf(kw) !== -1 ? '' : 'none';
          });
        });
      }
    }catch(e){}
  })();

  }
  if (els.promptEditor && !els.promptEditor.__wired) {
    els.promptEditor.__wired = true;
    els.promptEditor.addEventListener("input", markDirty);
  }

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
    li.draggable = true;
    li.innerHTML = `<span class="drag">≡</span>
                    <div class="name" title="${it.file}">${name}</div>
                    <div class="meta">
                      <button class="rename" title="名称を変更">✎</button>
                      <button class="trash" title="削除">🗑</button>
                    </div>`;
    els.fileList.appendChild(li);

    li.addEventListener('dragstart', ()=> li.classList.add('dragging'));
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
      const input = nameDiv.querySelector("input");
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

    li.querySelector(".trash").addEventListener("click", async (e)=>{
      e.preventDefault(); e.stopPropagation();
      const ok = confirm(`「${name}」を一覧から削除します。\n※ BLOB 上のファイル自体は消えません。`);
      if (!ok) return;
      // 先に BLOB を削除（失敗しても index は進める）
      const blobPath = `client/${clid}/${it.file}`;
      const okDel = await tryDelete(blobPath);
      await deleteIndexItem(it.file);
      setStatus(okDel?"削除しました（BLOBも削除）":"インデックスのみ削除しました（BLOB削除失敗）","green");
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
    if (window.state?.promptIndex?.prompts) return;
    if (typeof window.loadPromptIndex === 'function'){
      const idx = await window.loadPromptIndex(window.state.clientCode, window.state.behavior);
      if (!idx || !Array.isArray(idx.prompts)) {
        window.state.promptIndex = {version:1, client: window.state.clientCode, behavior: window.state.behavior, prompts:[], params:{}};
      } else {
        window.state.promptIndex = idx;
      }
      return;
    }
    // If there's a custom loader elsewhere, leave it; otherwise create empty.
    if (!window.state) window.state = {};
    if (!window.state.promptIndex) window.state.promptIndex = {version:1, client: window.state.clientCode, behavior: window.state.behavior, prompts:[], params:{}};
  }

  function ensureRoomPhotoPinned(){
    const idx = window.state.promptIndex;
    const fixedFile = 'texel-roomphoto.json';
    const fixedName = '画像分析プロンプト';
    let rp = idx.prompts.find(p => p.file === fixedFile);
    if (!rp){
      idx.prompts.unshift({ file: fixedFile, name: fixedName, order: 0, hidden: false, locked: true });
    }else{
      rp.name = fixedName; rp.locked = true; rp.order = 0;
    }
    idx.prompts.sort((a,b)=> (b.locked?1:0)-(a.locked?1:0) || a.order-b.order)
      .forEach((p,i)=> p.order = i*10);
  }

  async function onAdd(){
    try{
      await ensurePromptIndexLoaded();
      ensureRoomPhotoPinned();

      const name = prompt('新しいプロンプトの表示名', 'おすすめ');
      if (name === null) return;
      const base = sanitizeFileBase(name || 'prompt');
      const file = `${base}-${timestampId()}.json`;

      const idx = window.state.promptIndex;
      const insertAt = Math.min(1, idx.prompts.length);
      const nextOrder = (idx.prompts.at(-1)?.order ?? 0) + 10;
      idx.prompts.splice(insertAt, 0, { file, name: name || '新しいプロンプト', order: nextOrder, hidden: false });

      if (typeof window.savePromptIndex === 'function'){
        await window.savePromptIndex(window.state.clientCode, window.state.behavior, idx);
      }

      const template = [
        'あなたは不動産向けのプロンプトです。',
        '（ここにルールや出力形式を書いてください）'
      ].join('\\n');
      if (typeof window.savePromptText === 'function'){
        await window.savePromptText(window.state.clientCode, file, template, { behavior: window.state.behavior });
      }

      if (typeof window.renderFileList === 'function') window.renderFileList();
      if (typeof window.selectFileInList === 'function') window.selectFileInList(file);
      if (typeof window.showToast === 'function') window.showToast('新しいプロンプトを追加しました');
    }catch(e){
      console.error(e);
      if (typeof window.showError === 'function') window.showError('追加に失敗しました：'+(e?.message||e));
    }
  }

  function wire(){
    const btn = findAddButton();
    if (btn && !btn.__wiredAdd){
      btn.__wiredAdd = true;
      btn.id ||= 'btnAdd';
      btn.addEventListener('click', onAdd);
    }
  }

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
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

/* === Minimal Stable Add Patch (2025-11-09) ==============================================
   Strategy:
   - Replace the original #btnAdd element with a fresh one having id="btnAdd2" so that any
     old capture-phase interceptors bound to "#btnAdd" are bypassed.
   - Wire a single, simple handler that appends to in-memory promptIndex, saves the index,
     creates the file, and re-renders the list. One prompt dialog, immediate reflect.
========================================================================================== */
(function(){
  async function simpleAddHandler(){
    try{
      var clid = (els.clientId && els.clientId.value || "").trim().toUpperCase();
      var beh  = (els.behavior && els.behavior.value || "BASE").trim().toUpperCase();
      if (!clid){ alert("クライアントコードを入力してください"); return; }

      if (typeof ensurePromptIndex === "function"){
        await ensurePromptIndex(clid, beh);
      } else {
        if (!window.promptIndex) window.promptIndex = { items:[], updatedAt:new Date().toISOString() };
      }

      var display = window.prompt("新しいプロンプトの表示名", "おすすめ");
      if (display === null) return;
      display = (display||"").trim();
      if (!display) display = "新規プロンプト";

      function slug(s){
        s = (s||"").trim().replace(/\s+/g,"-").replace(/[^0-9A-Za-z._\-一-龯ぁ-ゔァ-ヴー々〆〤]/g,"-");
        s = s.replace(/-+/g,"-").replace(/^-|-$/g,"");
        return s || "prompt";
      }
      function ts(){
        var d=new Date(), p=(n)=>String(n).padStart(2,"0");
        return d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+"-"+p(d.getHours())+p(d.getMinutes())+p(d.getSeconds());
      }

      var base = slug(display);
      var existing = new Set((window.promptIndex && window.promptIndex.items || []).map(function(x){ return x.file; }));
      var file = base+"-"+ts()+".json"; var i=2;
      while(existing.has(file)){ file = base+"-"+ts()+"-"+(i++)+".json"; }

      var maxOrder = 0;
      if (window.promptIndex && Array.isArray(window.promptIndex.items) && window.promptIndex.items.length){
        maxOrder = Math.max.apply(null, window.promptIndex.items.map(function(it){ return it.order||0; }));
      }

      var item = { file:file, name:display, order:maxOrder+10, hidden:false };
      if (!window.promptIndex) window.promptIndex = { items:[] };
      window.promptIndex.items.push(item);
      window.promptIndex.updatedAt = new Date().toISOString();

      var idxPath = (typeof promptIndexPath!=="undefined" && promptIndexPath) ? promptIndexPath : ("client/"+clid+"/prompt-index.json");
      if (typeof saveIndex === "function"){
        await saveIndex(idxPath, window.promptIndex, (typeof promptIndexEtag!=="undefined"?promptIndexEtag:null));
      }

      if (typeof window.createClientFile === "function"){
        await window.createClientFile(clid, file, "// Prompt template\n");
      }

      // ensure file exists before open
      if (typeof window.createClientFile === "function"){ await window.createClientFile(clid, file, "// Prompt template\n"); }
      if (typeof renderFileList === "function"){
        await renderFileList(); // regular render（ネット再読込があっても index は保存済みのため反映）
      }

      if (typeof openItem === "function"){ openItem(item); }
    }catch(e){
      console.error("simpleAddHandler failed:", e);
      alert("追加処理でエラーが発生しました: " + (e && e.message ? e.message : e));
    }
  }

  function installSimpleAdd(){
    try{
      var oldBtn = document.getElementById("btnAdd");
      if (!oldBtn) return;
      var newBtn = oldBtn.cloneNode(true);
      newBtn.id = "btnAdd2";
      // 表示テキストを維持
      if (oldBtn.parentNode) oldBtn.parentNode.replaceChild(newBtn, oldBtn);
      newBtn.addEventListener("click", function(ev){
        ev.preventDefault();
        ev.stopPropagation();
        simpleAddHandler();
      });
    }catch(e){ console.warn("installSimpleAdd failed:", e); }
  }

  if (document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", installSimpleAdd, { once:true });
  }else{
    installSimpleAdd();
  }
})();
// === End Minimal Stable Add Patch ========================================================

/* === Hotfix: markDirty fallback & auto-create index on 404 (2025-11-09) ================= */
(function(){
  // 1) markDirty polyfill (no-op if original exists)
  if (typeof window.markDirty !== "function"){
    window.markDirty = function(){ try{ window.__ps_dirty = true; }catch(e){} };
  }

  // 2) ensurePromptIndex wrapper: create empty index when not found (404)
  if (typeof window.ensurePromptIndex === "function" && !window.ensurePromptIndex.__ps_wrap404){
    const __origEnsure = window.ensurePromptIndex;
    window.ensurePromptIndex = async function(clientId, behavior){
      try{
        const r = await __origEnsure(clientId, behavior);
        // If it returned falsy, normalize
        if (!window.promptIndex || !Array.isArray(window.promptIndex.items)){
          window.promptIndex = { items:[], updatedAt: new Date().toISOString() };
        }
        return r;
      }catch(e){
        // Heuristic for 404: create blank index and persist
        try{
          if (!window.promptIndex || !Array.isArray(window.promptIndex.items)){
            window.promptIndex = { items:[], updatedAt: new Date().toISOString() };
          }
          const clid = (els.clientId && els.clientId.value || "").trim().toUpperCase();
          const idxPath = (typeof promptIndexPath!=="undefined" && promptIndexPath) ? promptIndexPath : ("client/"+clid+"/prompt-index.json");
          if (typeof saveIndex === "function"){
            await saveIndex(idxPath, window.promptIndex, (typeof promptIndexEtag!=="undefined"?promptIndexEtag:null));
          }
          return window.promptIndex;
        }catch(e2){
          console.warn("auto-create index failed:", e2);
          throw e;
        }
      }
    };
    window.ensurePromptIndex.__ps_wrap404 = true;
  }
})();
// === End Hotfix ==========================================================================

/* --- Guard openItem: avoid crash when clearDirty missing or 404 on new file --- */
(function(){
  if (typeof window.openItem === "function" && !window.openItem.__ps_guarded){
    const __origOpen = window.openItem;
    window.openItem = async function(item){
      try {
        // ensure clearDirty exists
        if (typeof window.clearDirty !== "function"){
          window.clearDirty = function(){ try{ window.__ps_dirty=false; if (els && els.badgeState) els.badgeState.textContent=''; }catch(e){} };
        }
        return await __origOpen.apply(this, arguments);
      } catch (e){
        console.warn("openItem guarded:", e);
        try{
          const clid = (els.clientId && els.clientId.value || '').trim().toUpperCase();
          if (window.createClientFile && item && item.file){
            await window.createClientFile(clid, item.file, "// auto-created\n");
          }
          // fallback: show empty editor, keep list intact
          if (els && els.promptEditor){ els.promptEditor.value = ''; }
          if (els && els.fileTitle){ els.fileTitle.textContent = item && item.file ? item.file : '(new)'; }
          if (els && els.badgeState){ els.badgeState.textContent = 'Missing（新規）'; }
          return;
        }catch(e2){ console.warn("openItem guard fallback failed:", e2); }
      }
    };
    window.openItem.__ps_guarded = true;
  }
})();

/* === Consolidated Path & Filename Shim (2025-11-09) =====================================
   - Forces all operations under prompts/client/{clid}/...
   - Uses ASCII-only filenames: prompt-YYYYMMDD-HHMMSS.json
   - Auto-creates index/file before open to avoid 404 and list wipes
========================================================================================== */
(function(){
  const BLOB_ROOT = "prompts";
  function indexPathOf(clid){ return `${BLOB_ROOT}/client/${clid}/prompt-index.json`; }
  function filePathOf(clid, file){ return `${BLOB_ROOT}/client/${clid}/${file}`; }
  function tsStamp(){ const d=new Date(),p=n=>String(n).padStart(2,"0"); return d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+"-"+p(d.getHours())+p(d.getMinutes())+p(d.getSeconds()); }
  function newAsciiFilename(){ return `prompt-${tsStamp()}.json`; }
  function currentClid(){ try{ return (els?.clientId?.value||"").trim().toUpperCase(); }catch(_){ return ""; } }
  function currentBeh(){ try{ return (els?.behavior?.value||"BASE").trim().toUpperCase(); }catch(_){ return "BASE"; } }

  // Ensure promptIndexPath always points under prompts/
  window.__ps_fixPaths = function(){
    const clid = currentClid();
    if (clid) window.promptIndexPath = indexPathOf(clid);
  };

  // Wrap ensurePromptIndex: set path; if 404/empty, create index
  if (typeof window.ensurePromptIndex === "function" && !window.ensurePromptIndex.__ps_paths){
    const orig = window.ensurePromptIndex;
    window.ensurePromptIndex = async function(clientId, behavior){
      const cl = (clientId||currentClid()).trim().toUpperCase();
      const bh = (behavior||currentBeh()).trim().toUpperCase();
      window.promptIndexPath = indexPathOf(cl);
      try{
        const r = await orig(cl, bh);
        if (!window.promptIndex || !Array.isArray(window.promptIndex.items)){
          window.promptIndex = { items:[], updatedAt:new Date().toISOString() };
          if (typeof saveIndex==="function"){
            await saveIndex(window.promptIndexPath, window.promptIndex, (typeof promptIndexEtag!=="undefined"?promptIndexEtag:null));
          }
        }
        return r;
      }catch(e){
        window.promptIndex = { items:[], updatedAt:new Date().toISOString() };
        if (typeof saveIndex==="function"){
          await saveIndex(indexPathOf(cl), window.promptIndex, (typeof promptIndexEtag!=="undefined"?promptIndexEtag:null));
        }
        return window.promptIndex;
      }
    };
    window.ensurePromptIndex.__ps_paths = true;
  }

  // Force createClientFile to use prompts/ full path
  if (typeof window.createClientFile === "function" && !window.createClientFile.__ps_promptsRoot){
    const orig = window.createClientFile;
    window.createClientFile = async function(clientId, file, text){
      const cl = (clientId||currentClid()).trim().toUpperCase();
      const full = String(file||"").startsWith(`${BLOB_ROOT}/`) ? file : filePathOf(cl, file);
      return await orig(cl, full, text);
    };
    window.createClientFile.__ps_promptsRoot = true;
  }

  // After any add, enforce ASCII filename and create file before open
  const __origAdd = window.addPromptUnified || window.onAdd || null;
  if (__origAdd && !__origAdd.__ps_asciiCreate){
    const wrapped = async function(){
      await window.ensurePromptIndex(currentClid(), currentBeh());
      const before = (window.promptIndex?.items||[]).map(x=>x.file);
      const r = await __origAdd.apply(this, arguments);
      const after = (window.promptIndex?.items||[]);
      const newly = after.find(x=>!before.includes(x.file));
      if (newly){
        // enforce ascii filename
        const isAscii = /^[\x00-\x7F]+$/.test(newly.file);
        if (!isAscii){
          newly.file = newAsciiFilename();
          if (typeof saveIndex==="function"){
            await saveIndex(window.promptIndexPath, window.promptIndex, (typeof promptIndexEtag!=="undefined"?promptIndexEtag:null));
          }
        }
        // create file before open
        if (typeof window.createClientFile === "function"){
          await window.createClientFile(currentClid(), newly.file, "// Prompt template\\n");
        }
        // re-render locally and open
        try{ await (window.renderFileList ? window.renderFileList({local:true}) : null); }catch{}
        try{ if (typeof openItem==="function") openItem(newly); }catch{}
      }
      return r;
    };
    wrapped.__ps_asciiCreate = true;
    if (window.addPromptUnified) window.addPromptUnified = wrapped;
    else window.onAdd = wrapped;
  }

  // If we added our own simpleAdd earlier, align its behavior too
  if (typeof window.simpleAddHandler === "function" && !window.simpleAddHandler.__ps_asciiCreate){
    const origSimple = window.simpleAddHandler;
    window.simpleAddHandler = async function(){
      await window.ensurePromptIndex(currentClid(), currentBeh());
      const r = await origSimple.apply(this, arguments);
      const items = (window.promptIndex?.items||[]);
      const last = items[items.length-1];
      if (last){
        if (!/^[\x00-\x7F]+$/.test(last.file)){
          last.file = newAsciiFilename();
          if (typeof saveIndex==="function"){
            await saveIndex(window.promptIndexPath, window.promptIndex, (typeof promptIndexEtag!=="undefined"?promptIndexEtag:null));
          }
        }
        if (typeof window.createClientFile === "function"){
          await window.createClientFile(currentClid(), last.file, "// Prompt template\\n");
        }
        try{ await (window.renderFileList ? window.renderFileList({local:true}) : null); }catch{}
        try{ if (typeof openItem==="function") openItem(last); }catch{}
      }
      return r;
    };
    window.simpleAddHandler.__ps_asciiCreate = true;
  }
})();
// === End Consolidated Shim ===============================================================

/* === Strong Shim v2 (2025-11-09) ========================================================
   Goals:
   - Force all paths under prompts/client/{clid}/...
   - Ensure ASCII filename on add
   - Hijack #btnAdd click (capture) to run reliable add flow
   - Force promptIndexPath on every render/open
========================================================================================== */
(function(){
  const BLOB_ROOT = "prompts";
  function pad(n){ return String(n).padStart(2,"0"); }
  function ts(){ const d=new Date(); return d.getFullYear()+pad(d.getMonth()+1)+pad(d.getDate())+"-"+pad(d.getHours())+pad(d.getMinutes())+pad(d.getSeconds()); }
  function asciiName(){ return `prompt-${ts()}.json`; }
  function clid(){ try{return (els.clientId?.value||"").trim().toUpperCase();}catch(_){return "";} }
  function beh(){ try{return (els.behavior?.value||"BASE").trim().toUpperCase();}catch(_){return "BASE";} }
  function idxPath(){ return `${BLOB_ROOT}/client/${clid()}/prompt-index.json`; }
  function filePath(file){ return `${BLOB_ROOT}/client/${clid()}/${file}`; }

  // Always set promptIndexPath when rendering or booting
  function ensurePaths(){
    const c = clid();
    if (c){
      window.promptIndexPath = idxPath();
    }
  }
  ensurePaths();

  // Wrap renderFileList to enforce path each time
  if (typeof window.renderFileList === "function" && !window.renderFileList.__ps_paths){
    const orig = window.renderFileList;
    window.renderFileList = async function(){
      ensurePaths();
      return await orig.apply(this, arguments);
    };
    window.renderFileList.__ps_paths = true;
  }

  // Wrap ensurePromptIndex to enforce path + auto-create
  if (typeof window.ensurePromptIndex === "function" && !window.ensurePromptIndex.__ps_paths2){
    const orig = window.ensurePromptIndex;
    window.ensurePromptIndex = async function(clientId, behavior){
      ensurePaths();
      try{
        const r = await orig(clientId||clid(), behavior||beh());
        if (!window.promptIndex || !Array.isArray(window.promptIndex.items)){
          window.promptIndex = { items:[], updatedAt:new Date().toISOString() };
          if (typeof saveIndex==="function"){ await saveIndex(idxPath(), window.promptIndex, (typeof promptIndexEtag!=="undefined"?promptIndexEtag:null)); }
        }
        return r;
      }catch(e){
        window.promptIndex = { items:[], updatedAt:new Date().toISOString() };
        if (typeof saveIndex==="function"){ await saveIndex(idxPath(), window.promptIndex, (typeof promptIndexEtag!=="undefined"?promptIndexEtag:null)); }
        return window.promptIndex;
      }
    };
    window.ensurePromptIndex.__ps_paths2 = true;
  }

  // Wrap createClientFile to prepend prompts/ if missing
  if (typeof window.createClientFile === "function" && !window.createClientFile.__ps_pathfix2){
    const orig = window.createClientFile;
    window.createClientFile = async function(clientId, file, text){
      const p = String(file||"");
      const full = p.startsWith(`${BLOB_ROOT}/`) ? p : filePath(p);
      return await orig(clientId||clid(), full, text);
    };
    window.createClientFile.__ps_pathfix2 = true;
  }

  // Hijack #btnAdd (capture) to avoid other listeners
  function installAddHijack(){
    const btn = document.getElementById("btnAdd");
    if (!btn || btn.__ps_hijacked) return;
    btn.__ps_hijacked = true;
    btn.addEventListener("click", async function(ev){
      try{
        ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation();
        ensurePaths();
        await window.ensurePromptIndex(clid(), beh());

        const disp = window.prompt("新しいプロンプトの表示名", "おすすめ");
        if (disp === null) return;

        // decide filename (ASCII)
        const file = asciiName();
        // push into index
        const items = (window.promptIndex?.items)||[];
        const maxOrder = items.length ? Math.max.apply(null, items.map(it=>it.order||0)) : 0;
        const item = { file, name: (disp||"").trim() || "新規プロンプト", order: maxOrder+10, hidden:false };
        if (!window.promptIndex) window.promptIndex = { items:[] };
        window.promptIndex.items.push(item);
        window.promptIndex.updatedAt = new Date().toISOString();
        await saveIndex(idxPath(), window.promptIndex, (typeof promptIndexEtag!=="undefined"?promptIndexEtag:null));

        // create file BEFORE open
        if (typeof window.createClientFile === "function"){
          await window.createClientFile(clid(), file, "// Prompt template\n");
        }

        // local render and open
        try{ await (window.renderFileList ? window.renderFileList({local:true}) : null); }catch{}
        try{ if (typeof openItem==="function") openItem(item); }catch{}
      }catch(e){
        console.warn("Add hijack failed:", e);
        alert("追加に失敗しました: " + (e && e.message ? e.message : e));
      }
    }, true); // capture
  }
  if (document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", installAddHijack, { once:true });
  } else {
    installAddHijack();
  }

  // Guard openItem: ensure paths each time
  if (typeof window.openItem === "function" && !window.openItem.__ps_paths2){
    const orig = window.openItem;
    window.openItem = async function(item){
      ensurePaths();
      try{ return await orig.apply(this, arguments); }
      catch(e){
        // try create then show empty without killing list
        try{
          if (typeof window.createClientFile === "function" && item && item.file){
            await window.createClientFile(clid(), item.file, "// auto-created\n");
          }
        }catch(_){}
        if (els && els.promptEditor) els.promptEditor.value = "";
        if (els && els.fileTitle) els.fileTitle.textContent = `client/${clid()}/${item?.file||"(new)"}`;
        if (els && els.badgeState) els.badgeState.textContent = "Missing（新規）";
      }
    };
    window.openItem.__ps_paths2 = true;
  }
})();
// === End Strong Shim v2 ==================================================================

/* === Prompt Studio Robust Normalization Shim (2025-11-09 final) =========================
   What this does:
   1) Forces every API call path to be "prompts/client/{CLID}/{file}"
   2) Auto-migrates non-ASCII file names in the index to ASCII: "prompt-YYYYMMDD-HHMMSS.json"
   3) Guarantees file creation before open (to avoid 404) and never clears the list on failure
========================================================================================== */
(function(){
  // ---------- helpers ----------
  const ROOT = "prompts";
  const asc = s => /^[\x00-\x7F]+$/.test(s);
  const pad = n => String(n).padStart(2, "0");
  const ts  = () => { const d=new Date(); return d.getFullYear()+pad(d.getMonth()+1)+pad(d.getDate())+"-"+pad(d.getHours())+pad(d.getMinutes())+pad(d.getSeconds()); };
  const asciiName = () => `prompt-${ts()}.json`;
  const clid = () => { try { return (els?.clientId?.value || "").trim().toUpperCase(); } catch { return ""; } };
  const idxPath = (c) => `${ROOT}/client/${c}/prompt-index.json`;
  const fullPath = (c, f) => `${ROOT}/client/${c}/${f}`;

  function ensurePaths(){
    const c = clid(); if (c) window.promptIndexPath = idxPath(c);
  }

  // ---------- index migration (once per boot) ----------
  async function migrateIndex(){
    try{
      ensurePaths();
      const c = clid(); if (!c) return;
      if (!window.promptIndex || !Array.isArray(window.promptIndex.items)) return;
      let changed = false;
      for (const it of window.promptIndex.items){
        if (!asc(it.file)){
          it.file = asciiName();
          changed = true;
        }
      }
      if (changed && typeof saveIndex === "function"){
        window.promptIndex.updatedAt = new Date().toISOString();
        await saveIndex(idxPath(c), window.promptIndex, (typeof promptIndexEtag!=="undefined"?promptIndexEtag:null));
      }
    }catch(e){ console.warn("migrateIndex failed:", e); }
  }

  // ---------- API wrappers (path normalization) ----------
  function wrap1(name){
    const orig = window[name];
    if (typeof orig !== "function" || orig.__ps_norm) return;
    window[name] = async function(a,b,c){
      try{
        const cId = clid();
        // normalize single 'filename' param (string) usage
        let fn = a;
        if (typeof fn === "string"){
          if (!fn.startsWith(`${ROOT}/`)){
            fn = fullPath(cId, fn);
          }
        }
        return await orig.call(this, fn, b, c);
      }catch(e){
        console.warn(`${name} norm failed`, e);
        return await orig.apply(this, arguments);
      }
    };
    window[name].__ps_norm = true;
  }
  ["LoadPromptText", "SavePromptText", "DeletePromptText"].forEach(wrap1);

  // create wrapper (signature may be (clientId, filename, text) or (filename, text))
  (function(){
    const name = "createClientFile";
    const orig = window[name];
    if (typeof orig !== "function" || orig.__ps_norm) return;
    window[name] = async function(a,b,c){
      const cId = clid();
      let clientArg = a, fileArg = b, textArg = c;
      if (typeof b === "undefined"){
        // pattern: (filename, text)
        fileArg = a; textArg = b; clientArg = cId;
      }
      if (typeof fileArg === "string" && !fileArg.startsWith(`${ROOT}/`)){
        fileArg = fullPath(cId, fileArg);
      }
      return await orig.call(this, clientArg, fileArg, textArg);
    };
    window[name].__ps_norm = true;
  })();

  // ---------- openItem guard: create if missing, don't clear list ----------
  if (typeof window.openItem === "function" && !window.openItem.__ps_norm){
    const orig = window.openItem;
    window.openItem = async function(item){
      ensurePaths();
      try {
        // ensure ascii filename for this item
        if (item && item.file && !asc(item.file)){
          item.file = asciiName();
          if (window.promptIndex){
            window.promptIndex.updatedAt = new Date().toISOString();
            await saveIndex(idxPath(clid()), window.promptIndex, (typeof promptIndexEtag!=="undefined"?promptIndexEtag:null));
          }
        }
        // pre-create file to avoid 404
        if (item && item.file && typeof window.createClientFile === "function"){
          await window.createClientFile(clid(), item.file, "// init\n");
        }
        return await orig.apply(this, arguments);
      } catch (e){
        console.warn("openItem fallback:", e);
        try{
          if (item && item.file && typeof window.createClientFile === "function"){
            await window.createClientFile(clid(), item.file, "// created by fallback\n");
          }
        }catch(_){}
        if (els && els.promptEditor) els.promptEditor.value = "";
        if (els && els.fileTitle) els.fileTitle.textContent = `client/${clid()}/${item?.file || "(new)"}`;
        if (els && els.badgeState) els.badgeState.textContent = "Missing（新規）";
      }
    };
    window.openItem.__ps_norm = true;
  }

  // ---------- add button: enforce ascii + precreate ----------
  function installAddFix(){
    const btn = document.getElementById("btnAdd");
    if (!btn || btn.__ps_norm) return;
    btn.__ps_norm = true;
    btn.addEventListener("click", async (ev)=>{
      try{
        ensurePaths();
        await (window.ensurePromptIndex ? window.ensurePromptIndex(clid()) : null);
        const disp = window.prompt("新しいプロンプトの表示名", "新規プロンプト");
        if (disp === null) return;
        const items = (window.promptIndex?.items)||[];
        const maxOrder = items.length ? Math.max.apply(null, items.map(it=>it.order||0)) : 0;
        const item = { file: asciiName(), name: (disp||"").trim() || "新規プロンプト", order: maxOrder+10, hidden:false };
        if (!window.promptIndex) window.promptIndex = { items:[] };
        window.promptIndex.items.push(item);
        window.promptIndex.updatedAt = new Date().toISOString();
        await saveIndex(idxPath(clid()), window.promptIndex, (typeof promptIndexEtag!=="undefined"?promptIndexEtag:null));
        if (typeof window.createClientFile === "function"){
          await window.createClientFile(clid(), item.file, "// Prompt template\n");
        }
        try{ await (window.renderFileList ? window.renderFileList({local:true}) : null); }catch{}
        try{ if (typeof openItem==="function") openItem(item); }catch{}
      }catch(e){
        console.warn("Add fix failed:", e);
      }
    }, true);
  }
  if (document.readyState === "loading"){ document.addEventListener("DOMContentLoaded", installAddFix, {once:true}); } else { installAddFix(); }

  // run migration once
  (async ()=>{ await migrateIndex(); })();
})();
// === End Robust Normalization Shim =======================================================

/* === Ensure-Create Shim (final) - 2025-11-09 ============================================
   1) guarantee file creation with SavePromptText before opening (avoid 404)
   2) force prompts/client/{clid}/... path
   3) make +追加 create file first, then open
=========================================================================================== */
(function(){
  const ROOT = "prompts";
  const pad = n => String(n).padStart(2,'0');
  const ts  = () => { const d=new Date(); return d.getFullYear()+pad(d.getMonth()+1)+pad(d.getDate())+"-"+pad(d.getHours())+pad(d.getMinutes())+pad(d.getSeconds()); };
  const asciiName = () => `prompt-${ts()}.json`;
  const clid = () => { try { return (els && els.clientId ? (els.clientId.value||"") : "").trim().toUpperCase(); } catch(e){ return ""; } };
  const idxPath = (c) => `${ROOT}/client/${c}/prompt-index.json`;
  const filePath = (c, f) => `${ROOT}/client/${c}/${f}`;

  async function ensureFileExists(fullPath){
    try{
      if (typeof LoadPromptText === "function"){
        await LoadPromptText(fullPath); // exists -> return
        return;
      }
    }catch(_e){ /* continue to create */ }
    if (typeof SavePromptText === "function"){
      await SavePromptText(fullPath, "// Prompt template\n");
    }else{
      console.warn("SavePromptText is not defined. Please map your save API here.");
    }
  }

  // Always keep promptIndexPath aligned
  function syncIndexPath(){
    const c = clid();
    if (c) window.promptIndexPath = idxPath(c);
  }
  syncIndexPath();

  // Wrap openItem so it always ensures the blob exists
  if (typeof window.openItem === "function" && !window.openItem.__ps_ensure){
    const orig = window.openItem;
    window.openItem = async function(item){
      try{
        const c = clid();
        if (item && item.file){
          await ensureFileExists(filePath(c, item.file));
        }
      }catch(e){ console.warn("ensure before open failed:", e); }
      syncIndexPath();
      return await orig.apply(this, arguments);
    };
    window.openItem.__ps_ensure = true;
  }

  // Hijack +追加 to: save index -> create blob -> render -> open
  function installAddFlow(){
    const btn = document.getElementById("btnAdd");
    if (!btn || btn.__ps_addflow) return;
    btn.__ps_addflow = true;
    btn.addEventListener("click", async (ev)=>{
      try{
        ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation();
        const c = clid(); if (!c) return;
        syncIndexPath();
        if (typeof ensurePromptIndex === "function"){
          await ensurePromptIndex(c, (els && els.behavior ? els.behavior.value : "BASE"));
        }
        const disp = window.prompt("新しいプロンプトの表示名", "新規プロンプト");
        if (disp === null) return;
        if (!window.promptIndex) window.promptIndex = { items:[], updatedAt:new Date().toISOString() };
        const items = window.promptIndex.items || [];
        const maxOrder = items.length ? Math.max.apply(null, items.map(it => it.order || 0)) : 0;
        const file = asciiName();
        const item = { file, name: (disp||"").trim() || "新規プロンプト", order: maxOrder + 10, hidden:false };
        items.push(item);
        window.promptIndex.updatedAt = new Date().toISOString();
        if (typeof saveIndex === "function"){
          await saveIndex(idxPath(c), window.promptIndex, (typeof promptIndexEtag!=="undefined"?promptIndexEtag:null));
        }
        // create blob BEFORE open
        await ensureFileExists(filePath(c, file));
        // refresh + open
        try{ await (window.renderFileList ? window.renderFileList({local:true}) : null); }catch(_){}
        try{ if (typeof openItem === "function") openItem(item); }catch(_){}
      }catch(e){
        console.warn("add flow failed:", e);
        alert("追加に失敗しました: " + (e && e.message ? e.message : e));
      }
    }, true);
  }
  if (document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", installAddFlow, { once:true });
  }else{
    installAddFlow();
  }
})();
// === End Ensure-Create Shim ===============================================================

/* === API Adaptor Shim (maps SavePromptText/LoadPromptText + path fix) - 2025-11-09 ======
   - Provides SavePromptText if missing (delegates to existing save routine or raw fetch)
   - Wraps LoadPromptText to force prompts/client/{clid}/... path
   - Normalizes filename to prompts/ root
========================================================================================== */
(function(){
  const ROOT = "prompts";
  const pad = n => String(n).padStart(2,'0');
  const ts  = () => { const d=new Date(); return d.getFullYear()+pad(d.getMonth()+1)+pad(d.getDate())+"-"+pad(d.getHours())+pad(d.getMinutes())+pad(d.getSeconds()); };
  const asciiName = () => `prompt-${ts()}.json`;
  const clid = () => { try { return (els && els.clientId ? (els.clientId.value||"") : "").trim().toUpperCase(); } catch(e){ return ""; } };
  const idxPath = (c) => `${ROOT}/client/${c}/prompt-index.json`;
  const filePath = (c, f) => `${ROOT}/client/${c}/${f}`;
  const apiBase = () => (els && els.apiBase ? els.apiBase.value : "").replace(/\/+$/,"");

  function norm(p){
    const c = clid();
    if (!p) return p;
    if (p.startsWith(`${ROOT}/`)) return p;
    if (p.startsWith(`client/`)) return `${ROOT}/${p}`;
    if (/\.json$/i.test(p)) return filePath(c, p);
    return p;
  }

  async function apiFetch(name, params, method="GET", body=null){
    const base = apiBase();
    const url = new URL(`${base}/api/${name}`);
    for (const [k,v] of Object.entries(params||{})){
      url.searchParams.set(k, v);
    }
    const res = await fetch(url.href, {
      method,
      headers: body ? {"Content-Type":"text/plain;charset=UTF-8"} : undefined,
      body: body || undefined,
    });
    if (!res.ok){
      const t = await res.text().catch(()=>res.statusText);
      throw new Error(`${name} ${res.status} ${t}`);
    }
    return res;
  }

  // ------- LoadPromptText wrapper (path fix) -------
  if (typeof window.LoadPromptText === "function" && !window.LoadPromptText.__ps_wrap){
    const orig = window.LoadPromptText;
    window.LoadPromptText = async function(filename){
      return await orig.call(this, norm(filename));
    };
    window.LoadPromptText.__ps_wrap = true;
  }
  if (typeof window.LoadPromptText !== "function"){
    window.LoadPromptText = async function(filename){
      const res = await apiFetch("LoadPromptText", { filename: norm(filename) }, "GET");
      return await res.text();
    };
    window.LoadPromptText.__ps_wrap = true;
  }

  // ------- SavePromptText shim (delegates or fetch) -------
  if (typeof window.SavePromptText !== "function"){
    // try common alternates
    const alt = window.SaveBLOBText || window.SaveText || null;
    if (typeof alt === "function"){
      window.SavePromptText = async function(filename, text){
        return await alt.call(this, norm(filename), text);
      };
    }else{
      window.SavePromptText = async function(filename, text){
        await apiFetch("SavePromptText", { filename: norm(filename) }, "POST", text || "");
        return true;
      };
    }
  } else if (!window.SavePromptText.__ps_wrap){
    const orig = window.SavePromptText;
    window.SavePromptText = async function(filename, text){
      return await orig.call(this, norm(filename), text);
    };
    window.SavePromptText.__ps_wrap = true;
  }

  // Expose helpers for other shims
  window.__ps_normPath = norm;
  window.__ps_idxPath = idxPath;
  window.__ps_filePath = filePath;
})();
// === End API Adaptor Shim ================================================================

/* === Ultra-Compat BLOB API Adapter (2025-11-09) =========================================
   Purpose:
   - Works with various Azure Functions backends you've used before:
     SaveBLOB / SaveBLOBText / SavePromptText / SaveText and LoadBLOB / LoadPromptText
   - Tries multiple endpoints + parameter shapes until one succeeds (HTTP 2xx).
   - Normalizes path to: container=prompts, key=client/{CLID}/{file}
=========================================================================================== */
(function(){
  const ROOT = "prompts";
  const pad = n => String(n).padStart(2,'0');
  const ts  = () => { const d=new Date(); return d.getFullYear()+pad(d.getMonth()+1)+pad(d.getDate())+"-"+pad(d.getHours())+pad(d.getMinutes())+pad(d.getSeconds()); };
  const asciiName = () => `prompt-${ts()}.json`;
  const clid = () => { try { return (els && els.clientId ? (els.clientId.value||"") : "").trim().toUpperCase(); } catch(e){ return ""; } };
  const idxPath = (c) => `${ROOT}/client/${c}/prompt-index.json`;
  const fileKey = (c,f) => `client/${c}/${f}`;              // key under container
  const fullPath = (c,f) => `${ROOT}/${fileKey(c,f)}`;      // prompts/client/...

  const apiBase = () => (els && els.apiBase ? els.apiBase.value : "").replace(/\/+$/,"");

  async function tryFetch(url, init){
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`${init?.method||'GET'} ${url} -> ${res.status}`);
    return res;
  }

  async function trySaveCandidates(container, key, text){
    const base = apiBase();
    const bodyTxt = (typeof text === "string" ? text : "");
    const headersTxt = {"Content-Type":"text/plain;charset=UTF-8"};
    const headersJson = {"Content-Type":"application/json;charset=UTF-8"};

    const tries = [
      // 1) SaveBLOB (JSON body: {container, filename, text})
      { url:`${base}/api/SaveBLOB`,       init:{ method:"POST", headers:headersJson, body:JSON.stringify({container, filename:key, text:bodyTxt}) } },
      // 2) SaveBLOBText (query + raw text)
      { url:`${base}/api/SaveBLOBText?container=${encodeURIComponent(container)}&filename=${encodeURIComponent(key)}`, init:{ method:"POST", headers:headersTxt, body:bodyTxt } },
      // 3) SavePromptText (filename=prompts/client/..., raw text)
      { url:`${base}/api/SavePromptText?filename=${encodeURIComponent(`${container}/${key}`)}`, init:{ method:"POST", headers:headersTxt, body:bodyTxt } },
      // 4) SaveText (filename=prompts/client/..., raw text)
      { url:`${base}/api/SaveText?filename=${encodeURIComponent(`${container}/${key}`)}`, init:{ method:"POST", headers:headersTxt, body:bodyTxt } },
    ];
    let lastErr;
    for (const t of tries){
      try{ await tryFetch(t.url, t.init); return true; }catch(e){ lastErr = e; }
    }
    throw lastErr || new Error("All save attempts failed.");
  }

  async function tryLoadCandidates(container, key){
    const base = apiBase();
    const tries = [
      // 1) LoadBLOB (query container+filename)
      `${base}/api/LoadBLOB?container=${encodeURIComponent(container)}&filename=${encodeURIComponent(key)}`,
      // 2) LoadPromptText (filename=prompts/client/...)
      `${base}/api/LoadPromptText?filename=${encodeURIComponent(`${container}/${key}`)}`,
      // 3) LoadText (filename=prompts/client/...)
      `${base}/api/LoadText?filename=${encodeURIComponent(`${container}/${key}`)}`,
    ];
    let lastErr, lastText;
    for (const url of tries){
      try{
        const res = await tryFetch(url, { method:"GET" });
        return await res.text();
      }catch(e){ lastErr = e; }
    }
    throw lastErr || new Error("All load attempts failed.");
  }

  // Export shims (overwrite if not present, wrap if present)
  window.__ps_blob = { idxPath, fileKey, fullPath };

  // Load
  (function(){
    const name = "LoadPromptText";
    const orig = window[name];
    if (typeof orig === "function"){
      window[name] = async function(filename){
        // accept both prompts/client/... and client/... forms
        const f = String(filename||"");
        if (f.startsWith("prompts/")) return await orig.call(this, f);
        // convert "client/.../file" to container+key
        // when underlying orig expects full path, pass fullPath
        try{ return await orig.call(this, `prompts/${f}`);}catch(_){}
        const c = "prompts";
        const txt = await tryLoadCandidates(c, f.replace(/^client\//,""));
        return txt;
      };
    } else {
      window[name] = async function(filename){
        const f = String(filename||"").replace(/^prompts\//,"");
        const c = "prompts";
        return await tryLoadCandidates(c, f.replace(/^client\//,""));
      };
    }
  })();

  // Save
  (function(){
    const name = "SavePromptText";
    const orig = window[name];
    if (typeof orig === "function"){
      window[name] = async function(filename, text){
        const f = String(filename||"").replace(/^prompts\//,"");
        try{ return await orig.call(this, `prompts/${f}`, text);}catch(_){}
        return await trySaveCandidates("prompts", f.replace(/^client\//,""), text);
      };
    } else {
      window[name] = async function(filename, text){
        const f = String(filename||"").replace(/^prompts\//,"");
        return await trySaveCandidates("prompts", f.replace(/^client\//,""), text);
      };
    }
  })();

  // ensureFileExists used by other shims
  window.__ps_ensure = async function(fullOrKey){
    const c = "prompts";
    const f = String(fullOrKey||"").replace(/^prompts\//,"");
    try{
      await tryLoadCandidates(c, f.replace(/^client\//,""));
      return true;
    }catch(_){}
    await trySaveCandidates(c, f.replace(/^client\//,""), "// Prompt template\n");
    return true;
  };

  // Patch openItem to ensure existence before read
  if (typeof window.openItem === "function" && !window.openItem.__ps_exist){
    const orig = window.openItem;
    window.openItem = async function(item){
      try{
        const c = clid();
        if (item && item.file){
          await window.__ps_ensure(`prompts/${fileKey(c, item.file)}`);
        }
      }catch(e){ console.warn("ensure before open failed:", e); }
      return await orig.apply(this, arguments);
    };
    window.openItem.__ps_exist = true;
  }

  // Patch +追加ボタンのフロー（index保存→本体作成→描画→open）
  function installAddFlow(){
    const btn = document.getElementById("btnAdd");
    if (!btn || btn.__ps_add2) return;
    btn.__ps_add2 = true;
    btn.addEventListener("click", async (ev)=>{
      try{
        ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation();
        const c = clid(); if (!c) return;
        if (typeof ensurePromptIndex === "function"){
          await ensurePromptIndex(c, (els && els.behavior ? els.behavior.value : "BASE"));
        }
        const disp = window.prompt("新しいプロンプトの表示名", "新規プロンプト");
        if (disp === null) return;
        if (!window.promptIndex) window.promptIndex = { items:[], updatedAt:new Date().toISOString() };
        const items = window.promptIndex.items || [];
        const maxOrder = items.length ? Math.max.apply(null, items.map(it => it.order || 0)) : 0;
        const file = asciiName();
        const item = { file, name: (disp||"").trim() || "新規プロンプト", order: maxOrder + 10, hidden:false };
        items.push(item);
        window.promptIndex.updatedAt = new Date().toISOString();
        if (typeof saveIndex === "function"){
          await saveIndex(idxPath(c), window.promptIndex, (typeof promptIndexEtag!=="undefined"?promptIndexEtag:null));
        }
        // create blob BEFORE open
        await window.__ps_ensure(`prompts/${fileKey(c, file)}`);
        // refresh + open
        try{ await (window.renderFileList ? window.renderFileList({local:true}) : null); }catch(_){}
        try{ if (typeof openItem === "function") openItem(item); }catch(_){}
      }catch(e){
        console.warn("add flow failed:", e);
        alert("追加に失敗しました: " + (e && e.message ? e.message : e));
      }
    }, true);
  }
  if (document.readyState === "loading"){ document.addEventListener("DOMContentLoaded", installAddFlow, { once:true }); }
  else { installAddFlow(); }
})();
// === End Ultra-Compat Adapter ============================================================
