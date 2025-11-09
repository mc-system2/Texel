// Prompt Studio – minimal stable build

// ===== DOM =====
const els = {
  clientId:  document.getElementById("clientId"),
  behavior:  document.getElementById("behavior"),
  apiBase:   document.getElementById("apiBase"),
  fileList:  document.getElementById("fileList"),
  fileTitle: document.getElementById("fileTitle"),
  badgeState:document.getElementById("badgeState"),
  badgeEtag: document.getElementById("badgeEtag"),
  promptEditor: document.getElementById("promptEditor"),
  btnAdd:    document.getElementById("btnAdd"),
  status:    document.getElementById("statusMessage"),
};

// ===== State =====
let promptIndex = null;      // normalized index object
let promptIndexPath = null;  // client/<id>/prompt-index.json
let promptIndexEtag = null;  // etag from API

// ===== Utils =====
function join(base, path){ return base.replace(/\/+$/,'') + '/' + path.replace(/^\/+/,''); }
function timestampId(){
  const d=new Date(); const p=n=>String(n).padStart(2,'0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function sanitizeFileBase(s){ return (s||'').toLowerCase().trim().replace(/\s+/g,'-').replace(/[^a-z0-9._-]/g,'-').replace(/-+/g,'-'); }
function indexClientPath(cid){ return `client/${cid}/prompt-index.json`; }
function isRoomphotoFile(it){ const f=(typeof it==='string'?it:it.file||'').toLowerCase(); return f==='texel-roomphoto.json' || f==='roomphoto.json'; }
function setStatus(msg,color){ if(!els.status) return; els.status.textContent=msg||''; els.status.style.color=color||'var(--tx-muted)'; }


// ===== Diagnostics / Preflight =====
const apiCaps = { loadPost:true, loadGet:true, savePost:true, saveGet:true };

async function checkMethod(url, method, body=null){
  try{
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type":"application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    // 200-299: ok, 405: method not allowed, others: treat as unknown but not fatal
    if (res.status === 405) return false;
    return res.ok || res.status === 404; // 404でもAPIの到達はできているとみなす
  }catch{ return false; }
}

async function preflight(){
  const base = els.apiBase?.value?.replace(/\/+$/,'') || "/api";
  // 軽い確認：LoadPromptText を GET/POST で叩いてみる（存在しないファイル名を指定）
  const dummy = { filename: "client/A001/__probe__.json" };
  apiCaps.loadPost = await checkMethod(`${base}/LoadPromptText`, "POST", dummy);
  apiCaps.loadGet  = await checkMethod(`${base}/LoadPromptText?filename=${encodeURIComponent(dummy.filename)}`, "GET");

  // SavePromptText はBODYが必要。GET/POSTの両方を試す（保存はしないが405検知用）
  const saveDummy = { filename: "client/A001/__probe__.json", prompt: "{}" };
  apiCaps.savePost = await checkMethod(`${base}/SavePromptText`, "POST", saveDummy);
  apiCaps.saveGet  = await checkMethod(`${base}/SavePromptText?filename=${encodeURIComponent(saveDummy.filename)}&prompt=%7B%7D`, "GET");

  console.info("[PromptStudio] API capability:", apiCaps);
}

// グローバルエラーハンドラ（画面上の状態エリアにも反映）
window.addEventListener("error", (e)=> setStatus(`Error: ${e.message||e}`, "#b30"));
window.addEventListener("unhandledrejection", (e)=> setStatus(`Unhandled: ${e.reason?.message||e.reason||"unknown"}`, "#b30"));

// ===== API =====


async function tryLoad(path){
  const base = els.apiBase.value.replace(/\/+$/,'');
  // prefer method based on preflight
  const order = apiCaps.loadPost ? ["POST","GET"] : ["GET","POST"];
  for (const m of order){
    try{
      if (m==="POST"){
        const r = await fetch(`${base}/LoadPromptText`, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ filename:path }) });
        if (r.ok){
          const j = await r.json();
          const text = (typeof j.text === "string") ? j.text : (typeof j.prompt === "string" ? j.prompt : null);
          let data = null; if (text){ try{ data = JSON.parse(text); }catch{ data=null; } }
          if (!data && j && typeof j.prompt === "object") data = j.prompt;
          return { etag: j?.etag ?? null, data };
        }
        if (r.status===405) continue;
      }else{
        const r = await fetch(`${base}/LoadPromptText?filename=${encodeURIComponent(path)}`);
        if (r.ok){
          const j = await r.json();
          const text = (typeof j.text === "string") ? j.text : (typeof j.prompt === "string" ? j.prompt : null);
          let data = null; if (text){ try{ data = JSON.parse(text); }catch{ data=null; } }
          if (!data && j && typeof j.prompt === "object") data = j.prompt;
          return { etag: j?.etag ?? null, data };
        }
        if (r.status===405) continue;
      }
    }catch{ /* try next */ }
  }
  return null;
}




async function saveIndex(path, idx, etag){
  const base = els.apiBase.value.replace(/\/+$/,'');
  const payload = { filename: path, prompt: JSON.stringify(idx, null, 2) };
  const order = apiCaps.savePost ? ["POST","GET"] : ["GET","POST"];
  for (const m of order){
    try{
      if (m==="POST"){
        const r = await fetch(`${base}/SavePromptText`, {
          method:"POST", headers:{ "Content-Type":"application/json" },
          body: JSON.stringify(etag ? { ...payload, etag } : payload)
        });
        if (r.ok) return;
        if (r.status===405) continue;
      }else{
        const q = new URLSearchParams();
        q.set("filename", path); q.set("prompt", JSON.stringify(idx)); if (etag) q.set("etag", etag);
        const r = await fetch(`${base}/SavePromptText?${q.toString()}`);
        if (r.ok) return;
        if (r.status===405) continue;
      }
    }catch{ /* try next */ }
  }
  throw new Error("Save failed");
}
;
  // 1) Try POST
  try{
    const r = await fetch(`${base}/SavePromptText`, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify(etag ? { ...payload, etag } : payload)
    });
    if (r.ok) return;
  }catch{}
  // 2) Fallback GET (URL-encoded)
  const q = new URLSearchParams();
  q.set("filename", path);
  q.set("prompt", JSON.stringify(idx));
  if (etag) q.set("etag", etag);
  const r2 = await fetch(`${base}/SavePromptText?${q.toString()}`);
  if (!r2.ok) throw new Error("Save failed");
}

async function saveIndexRobust(path, idx){
  try{ await saveIndex(path, idx, promptIndexEtag); }
  catch{
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
  const body = JSON.stringify({ filename: path });
  const posts = ["DeletePromptText","DeleteBlob","DeleteFile"];
  for (const name of posts){
    try{ const r = await fetch(`${base}/${name}`, { method:"POST", headers:{ "Content-Type":"application/json" }, body }); if(r.ok) return true; }catch{}
  }
  try{ const r = await fetch(`${base}/DeletePromptText?filename=${encodeURIComponent(path)}`); if(r.ok) return true; }catch{}
  return false;
}

// ===== Normalizers =====
function normalizeIndex(obj){
  if(!obj) return null;
  const src = obj.prompt ? obj.prompt : obj;
  const items = Array.isArray(src.items) ? src.items.map(x=>({
    file: x.file || "", name: x.name || prettify(x.file||""),
    order: Number.isFinite(x.order)?x.order:0, hidden: !!x.hidden, locked: !!x.locked
  })) : [];
  return {
    version: src.version || 1,
    clientId: src.clientId || (els.clientId?.value||"A001"),
    behavior: src.behavior || "BASE",
    updatedAt: src.updatedAt || new Date().toISOString(),
    items, params: src.params || {}
  };
}
function prettify(filename){
  return (filename||'').replace(/\.json$/i,'').replace(/^texel[-_]?/i,'').replace(/[-_]+/g,' ').replace(/\b\w/g,s=>s.toUpperCase());
}
function mergeIndexItems(serverIdx, localIdx){
  const out = { ...serverIdx, updatedAt: new Date().toISOString() };
  const map = new Map();
  (serverIdx.items||[]).forEach(it=> map.set(it.file, { ...it }));
  (localIdx.items||[]).forEach(it=>{ const prev = map.get(it.file); map.set(it.file, prev? { ...prev, ...it } : { ...it }); });
  const arr = [...map.values()];
  const pin = arr.filter(isRoomphotoFile); const rest = arr.filter(x=>!isRoomphotoFile(x));
  pin.forEach(it=>{ it.order=10; it.locked=true; it.hidden=false; });
  rest.forEach((it,i)=> it.order=(i+2)*10);
  out.items = [...pin, ...rest];
  return out;
}

// ===== Core =====
async function ensurePromptIndex(){
  const clid = (els.clientId?.value||"A001").trim()||"A001";
  const path = indexClientPath(clid);
  const got  = await tryLoad(path);
  promptIndexPath = path;
  promptIndexEtag = got?.etag || null;
  let idx = normalizeIndex(got?.data) || { version:1, clientId:clid, behavior:"BASE", items:[], params:{} };

  const before = JSON.stringify(idx.items);
  let rp = (idx.items||[]).find(isRoomphotoFile);
  if(!rp){
    rp = { file:"texel-roomphoto.json", name:"Roomphoto", hidden:false, locked:true, order:10 };
    idx.items = [rp, ...(idx.items||[])];
  }else{
    rp.name = "Roomphoto"; rp.locked = true; rp.hidden = false; rp.order = 10;
    idx.items = [rp, ...(idx.items||[]).filter(x=>x!==rp)];
  }
  const rest = idx.items.filter(x=>!isRoomphotoFile(x));
  rest.forEach((it,i)=> it.order=(i+2)*10);
  idx.items = [rp, ...rest];

  promptIndex = idx;
  if(JSON.stringify(idx.items)!==before){ await saveIndexRobust(path, idx); }
}

async function renderFileList(){
  const list = els.fileList; list.innerHTML = "";
  if(!promptIndex || !Array.isArray(promptIndex.items)) return;
  const rows = [...promptIndex.items].filter(it=>!it.hidden);
  for(const it of rows){
    const fixed = isRoomphotoFile(it);
    const div = document.createElement("div");
    div.className = "fileitem"; div.dataset.file = it.file; div.draggable = !fixed;
    div.innerHTML = `
      <div class="row">
        <span class="drag">≡</span>
        <div class="name" title="${it.file}">${it.name||prettify(it.file)}${fixed? ' <span class="chip info">固定</span>':''}</div>
        <div class="meta">${fixed?'':'<button class="rename">✎</button><button class="trash">🗑</button>'}</div>
      </div>`;
    list.appendChild(div);

    div.addEventListener("click",(e)=>{ if(e.target.closest('.meta')) return; els.fileTitle.textContent = it.file; });

    if(!fixed){
      div.querySelector(".rename").addEventListener("click", async (e)=>{
        e.stopPropagation();
        const name = window.prompt("表示名を入力", it.name||""); if(name===null) return;
        it.name = name.trim()||it.name; await saveIndexRobust(promptIndexPath, promptIndex); await renderFileList();
      });
      div.querySelector(".trash").addEventListener("click", async (e)=>{
        e.stopPropagation();
        if(!window.confirm(`「${it.name||it.file}」を削除します。\n※BLOBも削除します。`)) return;
        const clid = (els.clientId?.value||"A001").trim()||"A001";
        const blob = `client/${clid}/${it.file}`;
        const delOk = await tryDelete(blob);
        promptIndex.items = promptIndex.items.filter(x=>x.file!==it.file);
        await saveIndexRobust(promptIndexPath, promptIndex);
        setStatus(delOk? "削除しました（BLOBも削除）":"BLOB削除に失敗（インデックスのみ削除）", delOk?"green":"#b30");
        await renderFileList();
      });
    }
  }
}

function saveOrderFromDOM(){
  const nodes = [...els.fileList.querySelectorAll(".fileitem")];
  let cursor = 10;
  for(const el of nodes){
    const it = promptIndex.items.find(x=>x.file===el.dataset.file);
    if(!it) continue;
    if(isRoomphotoFile(it)){ it.order=10; continue; }
    cursor += 10; it.order = cursor;
  }
  saveIndexRobust(promptIndexPath, promptIndex);
}

async function onAdd(){
  await preflight();
  await ensurePromptIndex();
  const name = window.prompt("新しいプロンプトの表示名", "おすすめ"); if(name===null) return;
  const clid = (els.clientId?.value||"A001").trim()||"A001";
  const file = `${sanitizeFileBase(name||'prompt')}-${timestampId()}.json`;
  const items = Array.isArray(promptIndex.items)? [...promptIndex.items] : [];
  items.push({ file, name, hidden:false, order:(items.at(-1)?.order??10)+10 });
  promptIndex.items = items;
  promptIndex = mergeIndexItems(promptIndex, promptIndex);
  await saveIndexRobust(promptIndexPath||indexClientPath(clid), promptIndex);
  const body = JSON.stringify({ filename:`client/${clid}/${file}`, text:"// Prompt template\n// ここにルールや出力形式を書いてください。\n" });
  {
    const base = els.apiBase.value.replace(/\/+$/,'');
    let ok = false;
    try{
      const r = await fetch(`${base}/SavePromptText`, { method:"POST", headers:{ "Content-Type":"application/json" }, body });
      ok = r.ok;
    }catch{}
    if(!ok){
      const j = JSON.parse(body);
      const q = new URLSearchParams(); q.set("filename", j.filename); q.set("text", j.text||"");
      await fetch(`${base}/SavePromptText?${q.toString()}`);
    }
  }
  await renderFileList();
  setStatus(`「${name}」を追加しました。`, "green");
}

// ===== Boot =====
async function boot(){
  if(!els.clientId?.value) els.clientId.value = "A001";
  if(!els.apiBase?.value)  els.apiBase.value  = "/api";
  await preflight();
  await ensurePromptIndex();
  await renderFileList();
  if(els.btnAdd && !els.btnAdd.__wired){ els.btnAdd.__wired=true; els.btnAdd.addEventListener("click", onAdd); }
}
document.addEventListener("DOMContentLoaded", boot);
