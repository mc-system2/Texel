// Prompt Studio v2025-11-09-2
// roomphoto(画像分析プロンプト)は先頭固定/変更不可。他は追加・複製・削除可。

const els = {
  clientId: document.getElementById("clientId"),
  behavior: document.getElementById("behavior"),
  apiBase:  document.getElementById("apiBase"),
  apiWarn:  document.getElementById("apiWarn"),
  btnAddPrompt: document.getElementById("btnAddPrompt"),
  btnAddPromptLeft: document.getElementById("btnAddPromptLeft"),
  btnSave: document.getElementById("btnSave"),
  btnDiff: document.getElementById("btnDiff"),
  search: document.getElementById("search"),
  fileList: document.getElementById("fileList"),
  status: document.getElementById("status"),
  etag: document.getElementById("etag"),
  filename: document.getElementById("filename"),
  promptEditor: document.getElementById("promptEditor"),
  paramArea: document.getElementById("paramArea"),
  emptyHint: document.getElementById("emptyHint"),
};

function join(base, path){ return base.replace(/\/+$/,'') + '/' + path.replace(/^\/+/,''); }

// ===== API Base guard =====
function resolveApiBase(){
  const u = new URL(location.href);
  const q = u.searchParams.get("api");
  if (q){ els.apiBase.value = q; localStorage.setItem("apiBase", q); }
  else if (localStorage.getItem("apiBase")) els.apiBase.value = localStorage.getItem("apiBase");
  els.apiBase.addEventListener("input", ()=>{
    localStorage.setItem("apiBase", els.apiBase.value.trim());
    updateApiWarn();
  });
  updateApiWarn();
}
function apiBaseOk(){
  const v = (els.apiBase.value||"").trim();
  return v && !v.includes("...");
}
function updateApiWarn(){
  els.apiWarn.style.display = apiBaseOk() ? "none" : "inline-block";
}
async function postJSON(url, body){
  if (!apiBaseOk()) throw new Error("API Base 未設定");
  const r = await fetch(url, {
    method:"POST", headers:{ "Content-Type":"application/json; charset=utf-8" },
    body: JSON.stringify(body||{})
  });
  if (!r.ok) throw new Error(await r.text()||`HTTP ${r.status}`);
  return r;
}

async function tryLoad(filename){
  try{
    const r = await postJSON(join(els.apiBase.value, "LoadPromptText"), { filename });
    const j = await r.json().catch(()=>null);
    if (!j) return null;
    return { etag: j.etag||null, data: parsePromptText(j) };
  }catch(e){ return null; }
}
function parsePromptText(j){
  if (!j) return null;
  if (typeof j.text === "string") {
    try{ return JSON.parse(j.text); }catch{ return { prompt: j.text, params:{} }; }
  }
  if (typeof j.prompt === "string") return { prompt: j.prompt, params: j.params||{} };
  return j;
}
async function savePromptText(filename, promptText, etag){
  const body = { filename, prompt: promptText, etag: etag||null };
  const r = await postJSON(join(els.apiBase.value, "SavePromptText"), body);
  const j = await r.json().catch(()=>({}));
  return j.etag||null;
}

function setStatus(s){ els.status.textContent = `状態: ${s}`; }
function setETag(t){ els.etag.textContent = `ETag: ${t??"―"}`; }
function setFilename(f){ els.filename.textContent = `ファイル: ${f??"未選択"}`; }

function templateFromFilename(filename, behavior){
  if (behavior === "TYPE-R") return filename.replace(/^texel-/, "texel-r-");
  if (behavior === "TYPE-S") return filename.replace(/^texel-/, "texel-s-");
  return filename;
}

// ===== index =====
let promptIndex = null;
let promptIndexPath = null;
let promptIndexEtag = null;

function normalizeIndex(obj){
  if (!obj) return null;
  const p = obj.prompt ? (typeof obj.prompt==="string" ? JSON.parse(obj.prompt) : obj.prompt) : obj;
  if (!p || !Array.isArray(p.items)) return null;
  p.items = p.items.map((it,i)=> ({
    file: it.file, name: it.name || it.file, order: it.order??((i+1)*10),
    hidden: !!it.hidden, fixed: !!it.fixed
  }));
  return p;
}
function prettifyName(file){
  return (file||"").replace(/\.json$/,"").replace(/^[a-z]+-/i,"").replace(/-/g," ").trim();
}

async function ensurePromptIndex(clientId, behavior){
  const path = `client/${clientId}/prompt-index.json`;
  const res = await tryLoad(path);
  if (res && res.data){
    const n = normalizeIndex(res.data);
    if (n){ promptIndex = n; promptIndexPath = path; promptIndexEtag = res.etag||null; return; }
  }
  // 初期は roomphoto だけ
  promptIndex = {
    version: 1,
    clientId, behavior,
    updatedAt: new Date().toISOString(),
    items: [{ file:"texel-roomphoto.json", name:"画像分析プロンプト", order:10, hidden:false, fixed:true }],
    params: {}
  };
  promptIndexPath = path; promptIndexEtag = null;
  await saveIndex(promptIndexPath, promptIndex, null);
}

function ensureRoomphotoFixed(){
  if (!promptIndex) return;
  const idx = (promptIndex.items||[]).findIndex(x=>x.file==="texel-roomphoto.json");
  if (idx === -1){
    promptIndex.items.unshift({ file:"texel-roomphoto.json", name:"画像分析プロンプト", order:10, hidden:false, fixed:true });
  }else{
    promptIndex.items[idx].name = "画像分析プロンプト";
    promptIndex.items[idx].fixed = true;
    promptIndex.items[idx].order = 10;
    const it = promptIndex.items.splice(idx,1)[0];
    promptIndex.items.unshift(it);
  }
}

async function saveIndex(filename, indexObj, etag){
  const text = JSON.stringify(indexObj, null, 2);
  const newTag = await savePromptText(filename, text, etag);
  promptIndexEtag = newTag;
}

function toggleEmptyHint(){
  const count = (promptIndex?.items||[]).filter(x=>!x.hidden && x.file!=="texel-roomphoto.json").length;
  els.emptyHint.style.display = count===0 ? "block" : "none";
}

// ===== list render =====
async function renderFileList(){
  ensureRoomphotoFixed();
  const items = [...(promptIndex.items||[])]
    .filter(x=>!x.hidden)
    .sort((a,b)=>{
      const af = (a.file==="texel-roomphoto.json"||a.fixed)?-1:0;
      const bf = (b.file==="texel-roomphoto.json"||b.fixed)?-1:0;
      if (af!==bf) return af-bf;
      return (a.order??0)-(b.order??0);
    });

  els.fileList.innerHTML = "";
  for (const it of items){
    const li = document.createElement("div");
    li.className = "fileitem";
    li.dataset.file = it.file;

    const fixed = (it.file==="texel-roomphoto.json" || it.fixed === true);
    const name = it.name || prettifyName(it.file);

    li.innerHTML = `
      <span class="drag">≡</span>
      <div class="name" title="${it.file}">${name}</div>
      <div class="meta">
        ${fixed ? '<span class="lock" title="固定">🔒</span>' : '<button class="dup" title="複製">⧉</button><button class="del" title="削除">🗑</button><button class="rename" title="名称を変更">✎</button>'}
        <span class="chip">checking…</span>
      </div>`;

    li.draggable = !fixed;
    if (!fixed){
      li.addEventListener("dragstart", ()=> li.classList.add("dragging"));
      li.addEventListener("dragend", async ()=>{
        li.classList.remove("dragging");
        await saveOrderFromDOM();
      });
    }
    li.addEventListener("click", (e)=>{
      const t = e.target;
      if (t.classList.contains("dup") || t.classList.contains("del") || t.classList.contains("rename") || t.classList.contains("drag")) return;
      openItem(it);
    });
    li.querySelector(".dup")?.addEventListener("click", (e)=>{ e.preventDefault(); e.stopPropagation(); duplicatePromptItem(it.file); });
    li.querySelector(".del")?.addEventListener("click", (e)=>{ e.preventDefault(); e.stopPropagation(); deletePromptItem(it.file); });
    li.querySelector(".rename")?.addEventListener("click", (e)=>{
      e.preventDefault(); e.stopPropagation();
      const nn = prompt("新しい表示名", it.name||prettifyName(it.file));
      if (nn===null) return;
      it.name = nn.trim()||it.name;
      promptIndex.updatedAt = new Date().toISOString();
      saveIndex(promptIndexPath, promptIndex, promptIndexEtag).then(renderFileList);
    });

    els.fileList.appendChild(li);
  }

  els.fileList.addEventListener("dragover", (e)=>{
    e.preventDefault();
    const dragging = els.fileList.querySelector(".dragging");
    if (!dragging) return;
    const y = e.clientY;
    let after = null;
    const children = [...els.fileList.querySelectorAll(".fileitem:not(.dragging)")];
    for (const c of children){
      const rect = c.getBoundingClientRect();
      const offset = y - rect.top - rect.height/2;
      if (offset < 0){ after = c; break; }
    }
    if (after) els.fileList.insertBefore(dragging, after);
    else els.fileList.appendChild(dragging);
  });

  for (const it of items){
    const chip = els.fileList.querySelector(`.fileitem[data-file="${CSS.escape(it.file)}"] .chip`);
    updateChip(it, chip);
  }
  toggleEmptyHint();
}

async function saveOrderFromDOM(){
  const rows = [...els.fileList.querySelectorAll(".fileitem")];
  let od = 10;
  for (const r of rows){
    const file = r.dataset.file;
    const it = promptIndex.items.find(x=>x.file===file);
    if (!it) continue;
    if (file==="texel-roomphoto.json"||it.fixed) { it.order = 10; continue; }
    it.order = (od += 10);
  }
  promptIndex.updatedAt = new Date().toISOString();
  await saveIndex(promptIndexPath, promptIndex, promptIndexEtag);
}

async function updateChip(it, chipEl){
  const clid = els.clientId.value.trim().toUpperCase();
  const beh = els.behavior.value.toUpperCase();
  const candidates = [
    `client/${clid}/${it.file}`,
    `prompt/${clid}/${it.file}`,
    templateFromFilename(it.file, beh)
  ];
  for (const f of candidates){
    const r = await tryLoad(f);
    if (r){ chipEl.textContent = (f.startsWith("client/")||f.startsWith("prompt/")) ? "Overridden" : "Template"; return; }
  }
  chipEl.textContent = "Missing";
}

// ===== open / save =====
let currentFile = null;
let currentEtag = null;

async function openItem(it){
  const clid = els.clientId.value.trim().toUpperCase();
  const beh = els.behavior.value.toUpperCase();
  currentFile = `client/${clid}/${it.file}`;
  setFilename(currentFile);
  setStatus("読込中…");

  const cands = [
    `client/${clid}/${it.file}`,
    `prompt/${clid}/${it.file}`,
    templateFromFilename(it.file, beh)
  ];
  let loaded = null;
  let used = null;
  for (const f of cands){
    const r = await tryLoad(f);
    if (r){ loaded=r; used=f; break; }
  }
  if (!loaded){
    els.promptEditor.value = "";
    currentEtag = null;
    setETag("—"); setStatus("新規作成可");
    return;
  }
  currentEtag = (used.startsWith("client/")||used.startsWith("prompt/")) ? loaded.etag : null;
  setETag(currentEtag||"—");
  const d = loaded.data || {};
  const text = (typeof d === "string") ? d
            : (typeof d.prompt === "string") ? d.prompt
            : JSON.stringify(d, null, 2);
  els.promptEditor.value = text;
  setStatus("読み込み完了");
}

async function saveCurrent(){
  if (!currentFile){ alert("ファイルを選択してください。"); return; }
  const text = els.promptEditor.value;
  const etag = await savePromptText(currentFile, text, currentEtag);
  currentEtag = etag; setETag(etag||"—"); setStatus("保存しました");
  renderFileList();
}

// ===== add / duplicate / delete =====
async function addPromptItem(){
  let filename = prompt("内部ファイル名（*.json）", "texel-custom.json");
  if (!filename) return;
  filename = filename.trim();
  if (!filename.endsWith(".json")) filename += ".json";
  if (filename === "texel-roomphoto.json"){ alert("roomphoto は固定のため追加できません。"); return; }
  if ((promptIndex.items||[]).some(x=>x.file===filename)){ alert("同名のファイルが存在します。"); return; }
  const name = prompt("表示名", filename.replace(/\.json$/,"")) || filename.replace(/\.json$/,"");
  const nextOrder = Math.max(10, ...((promptIndex.items||[]).map(it=>it.order||10))) + 10;
  promptIndex.items.push({ file: filename, name, order: nextOrder, hidden:false });
  promptIndex.updatedAt = new Date().toISOString();
  await saveIndex(promptIndexPath, promptIndex, promptIndexEtag);

  const clid = els.clientId.value.trim().toUpperCase();
  const beh = els.behavior.value.toUpperCase();
  const templ = await tryLoad(templateFromFilename(filename, beh));
  let text = "";
  if (templ && templ.data){
    if (typeof templ.data === "string") text = templ.data;
    else if (typeof templ.data.prompt === "string") text = templ.data.prompt;
    else text = JSON.stringify(templ.data, null, 2);
  }else{
    text = JSON.stringify({ prompt:"", params:{} }, null, 2);
  }
  await savePromptText(`client/${clid}/${filename}`, text, null);

  await renderFileList();
}

async function duplicatePromptItem(file){
  const clid = els.clientId.value.trim().toUpperCase();
  const beh = els.behavior.value.toUpperCase();
  const it = (promptIndex.items||[]).find(x=>x.file===file);
  const base = file.replace(/\.json$/,"");
  let newFile = base + "-copy.json"; let n=2;
  while ((promptIndex.items||[]).some(x=>x.file===newFile)){ newFile = `${base}-copy${n++}.json`; }
  const newName = (it?.name||base) + "（コピー）";

  const cands = [`client/${clid}/${file}`, `prompt/${clid}/${file}`, templateFromFilename(file, beh)];
  let loaded = null;
  for (const f of cands){
    const r = await tryLoad(f); if (r){ loaded=r; break; }
  }
  let text = "";
  if (loaded && loaded.data){
    if (typeof loaded.data === "string") text = loaded.data;
    else if (typeof loaded.data.prompt === "string") text = loaded.data.prompt;
    else text = JSON.stringify(loaded.data, null, 2);
  }else{
    text = JSON.stringify({ prompt:"", params:{} }, null, 2);
  }
  await savePromptText(`client/${clid}/${newFile}`, text, null);

  const nextOrder = Math.max(10, ...((promptIndex.items||[]).map(it=>it.order||10))) + 10;
  promptIndex.items.push({ file:newFile, name:newName, order:nextOrder, hidden:false });
  promptIndex.updatedAt = new Date().toISOString();
  await saveIndex(promptIndexPath, promptIndex, promptIndexEtag);
  await renderFileList();
}

async function deletePromptItem(file){
  const it = (promptIndex.items||[]).find(x=>x.file===file);
  if (!it) return;
  if (it.fixed){ alert("roomphoto は削除できません。"); return; }
  if (!confirm(`「${it.name||file}」をリストから削除します。\n（注）ファイル自体の削除は行いません）`)) return;
  promptIndex.items = (promptIndex.items||[]).filter(x=>x.file!==file);
  promptIndex.updatedAt = new Date().toISOString();
  await saveIndex(promptIndexPath, promptIndex, promptIndexEtag);
  await renderFileList();
}

// ===== boot =====
async function boot(){
  resolveApiBase();
  els.clientId.addEventListener("input", ()=> els.clientId.value = els.clientId.value.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,4));
  els.btnAddPrompt.addEventListener("click", addPromptItem);
  els.btnAddPromptLeft.addEventListener("click", addPromptItem);
  els.btnSave.addEventListener("click", saveCurrent);
  window.addEventListener("keydown", (ev)=>{
    if ((ev.ctrlKey||ev.metaKey) && ev.key.toLowerCase()==="s"){ ev.preventDefault(); saveCurrent(); }
  });

  const clid = els.clientId.value.trim().toUpperCase();
  const beh  = els.behavior.value.toUpperCase();
  if (!apiBaseOk()){ setStatus("API Base を設定してください"); return; }
  await ensurePromptIndex(clid, beh);
  await renderFileList();
  setStatus("準備完了");
}
boot();
