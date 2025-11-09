
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
  const body = JSON.stringify({ filename:`client/${clid}/${file}`, text:"// Prompt template\n// ここにルールや出力形式を書いてください。\n" });
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
