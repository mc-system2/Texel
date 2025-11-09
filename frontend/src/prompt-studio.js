
// ---- Prompt Studio (clean build) ----

// DOM refs
const els = {
  clientId:  document.getElementById("clientId"),
  behavior:  document.getElementById("behavior"),
  apiBase:   document.getElementById("apiBase"),
  fileList:  document.getElementById("fileList"),
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
  btnAdd:    document.getElementById("btnAdd"),
};

// State
let promptIndex = null;      // {version, clientId, behavior, updatedAt, items:[{file,name,order,hidden,locked}]}
let promptIndexPath = null;  // BLOB path
let promptIndexEtag = null;  // ETag

// Utils
function join(base, path){ return base.replace(/\/+$/,'') + "/" + path.replace(/^\/+/,'' ); }
function timestampId(){ const d=new Date(); const p=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }
function sanitizeFileBase(s){ return (s||'').toLowerCase().trim().replace(/\s+/g,'-').replace(/[^a-z0-9._-]/g,'-').replace(/-+/g,'-'); }
function isRoomphotoFile(it){ const f=(typeof it==='string'?it:it.file||'').toLowerCase(); return f==='texel-roomphoto.json' || f==='roomphoto.json'; }
function indexClientPath(clientId){ return `client/${clientId}/prompt-index.json`; }
function setStatus(msg, color){ if(!els.status) return; els.status.textContent = msg||''; els.status.style.color = color||'var(--tx-muted)'; }

// API helpers
async function tryLoad(path){
  try{
    const r = await fetch(join(els.apiBase.value, "LoadPromptText"), {
      method:"POST",
      headers:{ "Content-Type":"application/json; charset=utf-8" },
      body: JSON.stringify({ filename: path })
    });
    if (!r.ok) return null;
    const json = await r.json();
    const text = (typeof json.text === "string") ? json.text
               : (typeof json.prompt === "string") ? json.prompt
               : null;
    let data = null;
    if (text) { try{ data = JSON.parse(text); }catch{ data = null; } }
    if (!data && json && typeof json.prompt === "object") data = json.prompt;
    return { etag: json?.etag ?? null, data };
  }catch{ return null; }
}
async function saveIndex(path, idx, etag){
  const payload = { filename: path, prompt: JSON.stringify(idx, null, 2) };
  if (etag) payload.etag = etag;
  const r = await fetch(join(els.apiBase.value, "SavePromptText"), {
    method:"POST",
    headers:{ "Content-Type":"application/json; charset=utf-8" },
    body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error("Save failed");
}
async function saveIndexRobust(path, idx){
  try{
    await saveIndex(path, idx, promptIndexEtag);
  }catch{
    const latest = await tryLoad(path);
    const server = normalizeIndex(latest?.data) || { items: [] };
    const merged = mergeIndexItems(server, idx);
    promptIndexEtag = latest?.etag || null;
    await saveIndex(path, merged, promptIndexEtag);
    promptIndex = merged;
  }
}
async function tryDelete(path){
  const base = els.apiBase.value.replace(/\/+$/,'');
  const post = ["DeletePromptText","DeleteBlob","DeleteFile"];
  const body = JSON.stringify({ filename: path });
  for (const name of post){
    try{
      const r = await fetch(`${base}/${name}`, { method:"POST", headers:{ "Content-Type":"application/json" }, body });
      if (r.ok) return true;
    }catch{}
  }
  // GET fallback
  try{
    const r = await fetch(`${base}/DeletePromptText?filename=${encodeURIComponent(path)}`);
    if (r.ok) return true;
  }catch{}
  return false;
}

// Normalizers
function normalizeIndex(obj){
  if (!obj) return null;
  const src = obj.prompt ? obj.prompt : obj;
  const items = Array.isArray(src.items) ? src.items.map(x=>({
    file: x.file || "", name: x.name || prettifyNameFromFile(x.file||""),
    order: Number.isFinite(x.order)?x.order:0, hidden: !!x.hidden, locked: !!x.locked
  })) : [];
  return {
    version: src.version || 1,
    clientId: src.clientId || (els.clientId?.value || "A001"),
    behavior: src.behavior || (els.behavior?.value || "BASE"),
    updatedAt: src.updatedAt || new Date().toISOString(),
    items,
    params: src.params || {}
  };
}
function prettifyNameFromFile(filename){
  return (filename||'').replace(/\.json$/i,'')
    .replace(/^texel[-_]?/i,'')
    .replace(/[-_]+/g,' ')
    .replace(/\b\w/g, s=>s.toUpperCase());
}
function mergeIndexItems(serverIdx, localIdx){
  const out = { ...serverIdx, updatedAt: new Date().toISOString() };
  const map = new Map();
  (serverIdx.items||[]).forEach(it=> map.set(it.file, { ...it }));
  (localIdx.items||[]).forEach(it=>{
    const prev = map.get(it.file);
    map.set(it.file, prev? { ...prev, ...it } : { ...it });
  });
  let arr = [...map.values()];
  // pin roomphoto to head
  const pin = arr.filter(isRoomphotoFile);
  const rest= arr.filter(x=>!isRoomphotoFile(x));
  pin.forEach((it,i)=>{ it.locked = true; it.hidden=false; it.order = 10; });
  rest.forEach((it,i)=> it.order = (i+2)*10);
  out.items = [...pin, ...rest];
  return out;
}

// Load index & pin Roomphoto (and save if changed)
async function ensurePromptIndex(){
  const clid = (els.clientId?.value || "A001").trim() || "A001";
  const beh  = (els.behavior?.value || "BASE");
  const path = indexClientPath(clid);
  const got  = await tryLoad(path);
  promptIndexPath = path;
  promptIndexEtag = got?.etag || null;
  let idx = normalizeIndex(got?.data) || { version:1, clientId:clid, behavior:beh, items:[], params:{} };

  // ensure roomphoto present and first
  const before = JSON.stringify(idx.items);
  let rp = (idx.items||[]).find(isRoomphotoFile);
  if (!rp){
    rp = { file:"texel-roomphoto.json", name:"Roomphoto", hidden:false, locked:true, order:10 };
    idx.items = [rp, ...(idx.items||[])];
  }else{
    rp.name = "Roomphoto"; rp.locked = true; rp.hidden = false; rp.order = 10;
    idx.items = [ rp, ...(idx.items||[]).filter(x=>x!==rp) ];
  }
  // resequence others
  const rest = idx.items.filter(x=>!isRoomphotoFile(x));
  rest.forEach((it,i)=> it.order = (i+2)*10);
  idx.items = [ rp, ...rest ];

  promptIndex = idx;
  if (JSON.stringify(idx.items) !== before){
    await saveIndexRobust(path, idx);
  }
}

// UI: render list
async function renderFileList(){
  const list = els.fileList;
  list.innerHTML = "";
  if (!promptIndex || !Array.isArray(promptIndex.items)) return;

  let rows = [...promptIndex.items].filter(it=>!it.hidden);
  const pin = rows.filter(isRoomphotoFile);
  const rest= rows.filter(x=>!isRoomphotoFile(x));
  rows = [...pin, ...rest];

  for (const it of rows){
    const li = document.createElement("div");
    li.className = "fileitem";
    li.dataset.file = it.file;
    const pinned = isRoomphotoFile(it);

    const name = it.name || prettifyNameFromFile(it.file);
    li.innerHTML = `
      <div class="row">
        <span class="drag">≡</span>
        <div class="name" title="${it.file}">${name}${pinned? ' <span class="chip info">固定</span>' : ''}</div>
        <div class="meta">
          ${pinned ? '' : '<button class="rename" title="名称を変更">✎</button><button class="trash" title="削除">🗑</button>'}
        </div>
      </div>`;
    li.draggable = !pinned;
    list.appendChild(li);

    // click to load file title
    li.addEventListener("click", (e)=>{
      if (e.target.closest(".meta")) return;
      els.fileTitle.textContent = it.file;
    });

    if (!pinned){
      li.querySelector(".rename").addEventListener("click", async (e)=>{
        e.stopPropagation();
        const newName = window.prompt("表示名を入力", it.name || "");
        if (newName===null) return;
        it.name = newName.trim() || it.name;
        await saveIndexRobust(promptIndexPath, promptIndex);
        await renderFileList();
      });
      li.querySelector(".trash").addEventListener("click", async (e)=>{
        e.stopPropagation();
        const ok = window.confirm(`「${it.name||it.file}」を削除します。
※ BLOB の実ファイルも削除します。`);
        if (!ok) return;
        const clid = (els.clientId.value||"A001").trim()||"A001";
        const blobPath = `client/${clid}/${it.file}`;
        const okDel = await tryDelete(blobPath);
        const still = await tryLoad(blobPath);
        // index remove
        promptIndex.items = promptIndex.items.filter(x=>x.file!==it.file);
        await saveIndexRobust(promptIndexPath, promptIndex);
        setStatus((okDel && !still) ? "削除しました（BLOBも削除）" : "インデックスのみ削除しました（BLOB削除失敗）", "green");
        await renderFileList();
      });
    }

    li.addEventListener("dragstart", ()=>{ if (li.draggable) li.classList.add("dragging"); });
    li.addEventListener("dragend",   ()=>{ li.classList.remove("dragging"); saveOrderFromDOM(); });
  }

  // drag sort
  list.addEventListener("dragover", (e)=>{
    e.preventDefault();
    const dragging = list.querySelector(".dragging");
    if (!dragging) return;
    const elsArr = [...list.querySelectorAll(".fileitem")].filter(n=>n!==dragging);
    const y = e.clientY;
    let next = null;
    for (const el of elsArr){
      const rect = el.getBoundingClientRect();
      const offset = y - rect.top - rect.height/2;
      if (offset < 0){ next = el; break; }
    }
    list.insertBefore(dragging, next);
  });
}

function saveOrderFromDOM(){
  const lis = [...els.fileList.querySelectorAll(".fileitem")];
  let cursor = 10; // 10 reserved for roomphoto
  for (const el of lis){
    const file = el.dataset.file;
    const it = promptIndex.items.find(x=>x.file===file);
    if (!it) continue;
    if (isRoomphotoFile(it)) { it.order = 10; continue; }
    cursor += 10; it.order = cursor;
  }
  saveIndexRobust(promptIndexPath, promptIndex);
}

// Add
async function onAdd(){
  await ensurePromptIndex();
  const name = window.prompt("新しいプロンプトの表示名", "おすすめ");
  if (name===null) return;
  const clid = (els.clientId.value||"A001").trim()||"A001";
  const base = sanitizeFileBase(name||"prompt");
  const file = `${base}-${timestampId()}.json`;
  const items = Array.isArray(promptIndex.items) ? [...promptIndex.items] : [];
  items.push({ file, name, hidden:false, order:(items.at(-1)?.order??10)+10 });
  promptIndex.items = items;
  // normalize & pin
  promptIndex = mergeIndexItems(promptIndex, promptIndex);
  // save index
  await saveIndexRobust(promptIndexPath || indexClientPath(clid), promptIndex);
  // create empty blob
  const body = JSON.stringify({ filename:`client/${clid}/${file}`, text:"// Prompt template
// ここにルールや出力形式を書いてください。
" });
  await fetch(join(els.apiBase.value, "SavePromptText"), { method:"POST", headers:{ "Content-Type":"application/json" }, body });
  await renderFileList();
  setStatus(`「${name}」を追加しました。`, "green");
}

// Boot
async function boot(){
  if (!els.clientId?.value) els.clientId.value = "A001";
  if (!els.apiBase?.value)  els.apiBase.value  = "/api";
  await ensurePromptIndex();
  await renderFileList();
  if (els.btnAdd && !els.btnAdd.__wired){ els.btnAdd.__wired = true; els.btnAdd.addEventListener("click", onAdd); }
}
document.addEventListener("DOMContentLoaded", boot);
