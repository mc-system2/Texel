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
  // 初期は roomphoto のみ固定で生成
  const items = [
    { file: "texel-roomphoto.json", name: "画像分析プロンプト", order: 10, hidden:false, fixed:true }
  ];
  promptIndex = { version:1, clientId, behavior, updatedAt:new Date().toISOString(), items, params:{} };
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

  await ensurePromptIndex(clid, beh);

  const kinds = Object.keys(KIND_TO_NAME).filter(k=>FAMILY[beh].has(k));
  const allowedFiles = new Set(kinds.map(k=>KIND_TO_NAME[k]));

  ensureRoomphotoFixed();
  const list = (promptIndex && Array.isArray(promptIndex.items) ? promptIndex.items : []);
  const rows = [...list]
    .filter(it => !it.hidden)
    .sort((a,b)=>{
      const af = (a.file==="texel-roomphoto.json"||a.fixed)?-1:0;
      const bf = (b.file==="texel-roomphoto.json"||b.fixed)?-1:0;
      if (af!==bf) return af-bf; return (a.order??0)-(b.order??0);
    });

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
    li.draggable = !isFixedItem(it);
    li.innerHTML = `<span class="drag">≡</span>
                    <div class="name" title="${it.file}">${name}</div>
                    <div class="meta">
                      ${ (it.file==="texel-roomphoto.json"||it.fixed) ? '<span class="lock" title="固定">🔒</span>' : '<button class="dup" title="複製">⧉</button><button class="del" title="削除">🗑</button><button class="rename" title="名称を変更">✎</button>' }
                      <span class="chip">checking…</span>
                    </div>`;
    els.fileList.appendChild(li);

    if (!isFixedItem(it)) li.addEventListener('dragstart', ()=> li.classList.add('dragging'));
    li.addEventListener('dragend', async ()=>{
      li.classList.remove('dragging');
      await saveOrderFromDOM();
    });

    const clientPath = `client/${clid}/${it.file}`;
    const legacyPath = `prompt/${clid}/${it.file}`;
    const template   = templateFromFilename(it.file, beh);
    const state = await resolveState([clientPath, legacyPath], template);
    const chip  = li.querySelector(".chip");
    if (state === "client") { chip.textContent = "Overridden"; chip.classList.add("ok"); }
    else if (state === "legacy"){ chip.textContent = "Overridden (legacy)"; chip.classList.add("ok"); }
    else if (state === "template"){ chip.textContent = "Template"; chip.classList.add("info"); }
    else { chip.textContent = "Missing"; chip.classList.add("warn"); }

    li.addEventListener("click", (e)=>{ if (!e.target.classList.contains("rename") && !e.target.classList.contains("drag") && !e.target.classList.contains('dup') && !e.target.classList.contains('del')) openItem(it); });

    li.querySelector('.dup')?.addEventListener('click', (e)=>{ e.preventDefault(); e.stopPropagation(); duplicatePromptItem(it.file); });
    li.querySelector('.del')?.addEventListener('click', (e)=>{ e.preventDefault(); e.stopPropagation(); deletePromptItem(it.file); });

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

  if (used.startsWith("client/")) setBadges("Overridden", currentEtag, "ok");
  else if (used.startsWith("prompt/")) setBadges("Overridden (legacy)", currentEtag, "ok");
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

function templateFromFilename(filename, behavior){
  if (behavior === "TYPE-R") return filename.replace(/^texel-/, "texel-r-");
  if (behavior === "TYPE-S") return filename.replace(/^texel-/, "texel-s-");
  return filename;
}

function ensureRoomphotoFixed(){
  if (!promptIndex) return;
  const has = (promptIndex.items||[]).some(it => it.file==="texel-roomphoto.json");
  if (!has){
    promptIndex.items = [{ file:"texel-roomphoto.json", name:"画像分析プロンプト", order:10, hidden:false, fixed:true }, ...(promptIndex.items||[])];
  }else{
    promptIndex.items = (promptIndex.items||[]).map(it => it.file==="texel-roomphoto.json" ? ({...it, name:"画像分析プロンプト", order:10, hidden:false, fixed:true}) : it);
  }
}

async function addPromptItem(){
  const clid = els.clientId.value.trim().toUpperCase();
  const beh  = els.behavior.value.toUpperCase();
  let filename = prompt("内部ファイル名（*.json）を入力してください", "texel-custom.json");
  if (!filename) return;
  filename = filename.trim();
  if (!filename.endsWith(".json")) filename += ".json";
  if (filename==="texel-roomphoto.json"){ alert("roomphoto は固定のため追加できません。"); return; }
  if ((promptIndex.items||[]).some(it => it.file===filename)){ alert("同名のファイルが既に存在します。"); return; }
  const display = prompt("表示名を入力してください", filename.replace(/\.json$/,''));
  if (display===null) return;
  const nextOrder = Math.max(10, ...((promptIndex.items||[]).map(it=>it.order||10))) + 10;
  promptIndex.items.push({ file: filename, name: display||filename, order: nextOrder, hidden:false });
  promptIndex.updatedAt = new Date().toISOString();
  await saveIndex(promptIndexPath, promptIndex, promptIndexEtag);

  // テンプレがあればコピー、なければ空雛形を作成
  const templ = await tryLoad(templateFromFilename(filename, beh));
  let text = "";
  if (templ && templ.data){
    if (typeof templ.data === "string") text = templ.data;
    else if (typeof templ.data.prompt === "string") text = templ.data.prompt;
    else text = JSON.stringify(templ.data, null, 2);
  }else{
    text = JSON.stringify({ prompt:"", params:{} }, null, 2);
  }
  await fetch(join(els.apiBase.value,"SavePromptText"),{
    method:"POST",
    headers:{ "Content-Type":"application/json; charset=utf-8" },
    body: JSON.stringify({ filename:`client/${clid}/${filename}`, prompt:text })
  });
  await renderFileList();
}

async function duplicatePromptItem(file){
  const clid = els.clientId.value.trim().toUpperCase();
  const beh  = els.behavior.value.toUpperCase();
  const base = file.replace(/\.json$/,'');
  let newFile = base + "-copy.json";
  let i=2;
  while ((promptIndex.items||[]).some(it => it.file===newFile)){
    newFile = `${base}-copy${i++}.json`;
  }
  const it = (promptIndex.items||[]).find(x=>x.file===file);
  const newName = (it?.name||base) + "（コピー）";

  // 既存の内容を取得（client → legacy → template）
  const candidates = [
    `client/${clid}/${file}`,
    `prompt/${clid}/${file}`,
    templateFromFilename(file, beh)
  ];
  let loaded=null;
  for (const f of candidates){
    const r = await tryLoad(f);
    if (r){ loaded = r; break; }
  }
  let text = "";
  if (loaded && loaded.data){
    if (typeof loaded.data === "string") text = loaded.data;
    else if (typeof loaded.data.prompt === "string") text = loaded.data.prompt;
    else text = JSON.stringify(loaded.data, null, 2);
  }else{
    text = JSON.stringify({ prompt:"", params:{} }, null, 2);
  }
  await fetch(join(els.apiBase.value,"SavePromptText"),{
    method:"POST",
    headers:{ "Content-Type":"application/json; charset=utf-8" },
    body: JSON.stringify({ filename:`client/${clid}/${newFile}`, prompt:text })
  });
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
  if (!confirm(`「${it.name||file}」をリストから削除します。よろしいですか？\n（注）ファイル自体の削除は行いません）`)) return;
  promptIndex.items = (promptIndex.items||[]).filter(x=>x.file!==file);
  promptIndex.updatedAt = new Date().toISOString();
  await saveIndex(promptIndexPath, promptIndex, promptIndexEtag);
  await renderFileList();
}

// Disable drag/rename for fixed (roomphoto)
function isFixedItem(it){ return it && (it.file==="texel-roomphoto.json" || it.fixed===true); }
