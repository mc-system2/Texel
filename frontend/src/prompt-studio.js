/* ===== Prompt Studio – logic (fixed) ===== */
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

function indexClientPath(clientId){
  return `client/${clientId}/prompt-index.json`;
}
function prettifyNameFromFile(filename){
  return filename.replace(/\.json$/i,'')
                 .replace(/^texel[-_]?/i,'')
                 .replace(/[-_]+/g,' ')
                 .replace(/\b\w/g, s=>s.toUpperCase());
}

async function tryLoad(path){
  const url = join(els.apiBase.value, "LoadPromptText") + `?filename=${encodeURIComponent(path)}`;
  const res = await fetch(url, { cache: "no-store" }).catch(()=>null);
  if (!res || !res.ok) return null;
  const etag = res.headers.get("etag") || null;
  let data = {};
  try { data = await res.json(); } catch { data = {}; }
  return { data, etag };
}

// Save index json via SavePromptText
async function saveIndex(path, idx, etag){
  // never drop items accidentally
  if (!idx || !Array.isArray(idx.items)) throw new Error("index.items is invalid");
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

// normalize various index shapes
function normalizeIndex(obj){
  try{
    if (!obj) return null;
    if (obj.items && Array.isArray(obj.items)) return obj;
    if (obj.prompt && obj.prompt.items) return obj.prompt;
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


  els.promptEditor.addEventListener("input", markDirty);

  // wire +追加（重複防止）
  const addBtn = document.getElementById("btnAdd");
  if (addBtn && !addBtn.__wired){
    addBtn.__wired = true;
    addBtn.addEventListener("click", onAdd);
  }
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

  const rows = [...((promptIndex && Array.isArray(promptIndex.items) ? promptIndex.items : []))]
    .filter(it => !it.hidden)
    .sort((a,b)=>(a.order??0)-(b.order??0));

  // avoid multiple listeners
  els.fileList.onDragOverAttached ||= false;
  if (!els.fileList.onDragOverAttached){
    els.fileList.addEventListener('dragover', (e)=>{
      e.preventDefault();
      const dragging = document.querySelector('.fileitem.dragging');
      const after = getDragAfterElement(els.fileList, e.clientY);
      if (!after) els.fileList.appendChild(dragging);
      else els.fileList.insertBefore(dragging, after);
    });
    els.fileList.addEventListener('drop', async ()=>{ await saveOrderFromDOM(); });
    els.fileList.onDragOverAttached = true;
  }

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
                      <span class="chip">checking…</span>
                    </div>`;
    els.fileList.appendChild(li);

    li.addEventListener('dragstart', ()=> li.classList.add('dragging'));
    li.addEventListener('dragend', async ()=>{
      li.classList.remove('dragging');
      await saveOrderFromDOM();
    });

    const clientPath = `client/${clid}/${it.file}`;
    const legacyPath = `prompt/${clid}/${it.file}`;
    const template   = templateFromFilename(it.file, beh);
    const state = await resolveState([clientPath, legacyPath], template);
    const chip  = li.querySelector(".chip");
    chip.style.display = "none";

    li.addEventListener("click", (e)=>{ if (!e.target.classList.contains("rename") && !e.target.classList.contains("drag")) openItem(it); });

    li.querySelector(".rename").addEventListener("click", (e)=>{
      e.preventDefault(); e.stopPropagation();
      const nameDiv = li.querySelector(".name");
      const current = nameDiv.textContent;
      nameDiv.classList.add("editing");
      nameDiv.innerHTML = `<input value="${current.replace(/"/g, "&quot;")}" aria-label="name">`;
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
    setBadges("—", null);
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

  setBadges("—", currentEtag || loaded?.etag || "—");

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
    setBadges("—", currentEtag);
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

/* === +追加：既存 index を必ず読み出してから安全に追記 ==================== */
function ts(){ const d=new Date(); const p=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }
function slug(s){ return String(s||'').toLowerCase().replace(/[^\w\-]+/g,'-').replace(/\-+/g,'-').replace(/^\-|\-$/g,''); }

async function onAdd(){
  const clid = (els.clientId.value||'').trim().toUpperCase();
  const beh  = (els.behavior.value||'BASE').toUpperCase();
  if (!clid || !/^[A-Z0-9]{3,}$/.test(clid)){ alert("クライアントコードが不正です"); return; }

  const display = prompt("新しいプロンプトの表示名", "おすすめ");
  if (display === null) return;

  // 直前の index を再取得（競合で落とさない）
  await ensurePromptIndex(clid, beh);
  const items = Array.isArray(promptIndex.items) ? [...promptIndex.items] : [];

  // ユニークなファイル名
  const base = slug(display || "prompt");
  let file = `${base}-${ts()}.json`;
  const exist = new Set(items.map(it=>it.file));
  let i=2; while(exist.has(file)){ file = `${base}-${ts()}-${i++}.json`; }

  // order は末尾 +10。roomphoto の直後に入れる（存在すれば）
  const rpIdx = items.findIndex(x=>x.file==="texel-roomphoto.json");
  const insertAt = (rpIdx >= 0) ? (rpIdx + 1) : items.length;
  const nextOrder = ((items.reduce((m,it)=>Math.max(m, it.order||0), 0) || 0) + 10);
  items.splice(insertAt, 0, { file, name: display, order: nextOrder, hidden:false });

  // 上書き保存
  promptIndex.items = items;
  promptIndex.updatedAt = new Date().toISOString();
  await saveIndex(promptIndexPath || indexClientPath(clid), promptIndex, promptIndexEtag);

  // 空テンプレを作成
  const body = { filename: `client/${clid}/${file}`, prompt: ["// Prompt template","// ここにルールや出力形式を書いてください。"].join("\n") };
  await fetch(join(els.apiBase.value, "SavePromptText"), {
    method:"POST", headers:{ "Content-Type":"application/json; charset=utf-8" },
    body: JSON.stringify(body)
  });

  setStatus("追加しました。","green");
  await renderFileList();
  // 新規を開く
  const it = promptIndex.items.find(x=>x.file===file);
  if (it) openItem(it);
}
