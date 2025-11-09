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
