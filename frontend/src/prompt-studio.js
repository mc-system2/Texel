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


/* ---------- Prompt Index (order & display name) ---------- */
let promptIndex = null;      // {version, clientId, behavior, updatedAt, items:[{file,name,order,hidden}]}
let promptIndexPath = null;  // BLOB pathlet promptIndexEtag = null;  // ETag for concurrency

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

// Load/ensure index. If not found, auto-generate from KIND_TO_NAME+FAMILY and save to behavior-level path.
async function ensurePromptIndex(clientId, behavior){
  const tryPaths = [ indexBehaviorPath(clientId, behavior), indexClientPath(clientId) ];
  let usedPath = null, idx = null, etag = null;

  for (const p of tryPaths){
    const r = await tryLoad(p);
    if (r && r.data){
      idx = r.data; usedPath = p; etag = r.etag || null;
      break;
    }
  }
  if (!idx){
    // auto-generate
    const kinds = Object.keys(KIND_TO_NAME).filter(k=>FAMILY[behavior].has(k));
    const items = kinds.map((k,i)=>{
      const file = KIND_TO_NAME[k];
      return { file, name: prettifyNameFromFile(file), order: (i+1)*10, hidden:false };
    });
    idx = {
      version:1, clientId, behavior, updatedAt:new Date().toISOString(), items
    };
    usedPath = indexBehaviorPath(clientId, behavior);
    await saveIndex(usedPath, idx, null);
    // reload to get etag
    const r = await tryLoad(usedPath);
    etag = r ? r.etag : null;
  }

  promptIndex = idx;
  promptIndexPath = usedPath;
  promptIndexEtag = etag;
  return idx;
}

// Save index JSON (as text body via SavePromptText)
async function saveIndex(path, idx, etag){
  const body = { filename: path, prompt: JSON.stringify(idx, null, 2), etag: etag || undefined };
  const r = await fetch(join(els.apiBase.value, "SavePromptText"), {
    method:"POST",
    headers:{ "Content-Type":"application/json; charset=utf-8" },
    body: JSON.stringify(body)
  });
  const raw = await r.text(); let json={}; try{ json = raw?JSON.parse(raw):{} }catch{}
  if (!r.ok) throw new Error(json?.error || raw || `HTTP ${r.status}`);
  promptIndexEtag = json?.etag || promptIndexEtag || null;
  return json;
}

// Update name in index and persist
async function renameIndexItem(file, newName){
  if (!promptIndex) return;
  const it = promptIndex.items.find(x=>x.file===file);
  if (!it) return;
  it.name = newName || it.name;
  promptIndex.updatedAt = new Date().toISOString();
  await saveIndex(promptIndexPath, promptIndex, promptIndexEtag);
}

// Helper: compute template filename for behavior from actual file name
function templateFromFilename(filename, behavior){
  if (behavior === "TYPE-R") return filename.replace(/^texel-/, "texel-r-");
  if (behavior === "TYPE-S") return filename.replace(/^texel-/, "texel-s-");
  return filename;
}
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

  // Load/ensure index
  await ensurePromptIndex(clid, beh);

  // Build rows from index (visible only)
  const rows = [...(promptIndex.items||[])]
    .filter(it => !it.hidden)
    .sort((a,b)=>(a.order??0)-(b.order??0));

  for (const it of rows){
    const name = it.name || prettifyNameFromFile(it.file);
    const li = document.createElement("div");
    li.className = "fileitem";
    li.dataset.file = it.file;
    li.innerHTML = `<div class="name" title="${it.file}">${name}</div>
                     <div class="meta">
                       <button class="rename" title="名称を変更">✎</button>
                       <span class="chip">checking…</span>
                     </div>`;
    els.fileList.appendChild(li);

    // State check (client/legacy/template)
    const clientPath = `client/${clid}/${it.file}`;
    const legacyPath = `prompt/${clid}/${it.file}`;
    const template   = templateFromFilename(it.file, beh);

    const state = await resolveState([clientPath, legacyPath], template);
    const chip  = li.querySelector(".chip");
    if (state === "client") { chip.textContent = "Overridden"; chip.classList.add("ok"); }
    else if (state === "legacy"){ chip.textContent = "Overridden (legacy)"; chip.classList.add("ok"); }
    else if (state === "template"){ chip.textContent = "Template"; chip.classList.add("info"); }
    else { chip.textContent = "Missing"; chip.classList.add("warn"); }

    // open
    li.addEventListener("click", (e)=>{
      // avoid triggering when clicking rename button
      if (e.target && e.target.classList.contains("rename")) return;
      openItem(it);
    });

    // rename (inline)
    li.querySelector(".rename").addEventListener("click", (e)=>{
      e.preventDefault();
      e.stopPropagation();
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
        }else{
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


async function openItem(item){
  if (dirty && !confirm("未保存の変更があります。破棄して読み込みますか？")) return;

  els.diffPanel.hidden = true;
  [...els.fileList.children].forEach(n=>n.classList.toggle("active", n.dataset.file===item.file));
  setStatus("読込中…","orange");

  const clid = els.clientId.value.trim().toUpperCase();
  const beh  = els.behavior.value.toUpperCase();

  currentKind = null; // kind概念は使わない（ファイル基準）
  currentFilenameTarget = `client/${clid}/${item.file}`;
  document.getElementById("fileTitle").textContent = currentFilenameTarget;

  const candidates = [
    `client/${clid}/${item.file}`,
    `prompt/${clid}/${item.file}`,
    templateFromFilename(item.file, beh)
  ];

  let loaded = null, used = null;
  for (const f of candidates){
    const r = await tryLoad(f);
    if (r) { loaded = r; used = f; break; }
  }
  const templ = await tryLoad(templateFromFilename(item.file, beh));
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