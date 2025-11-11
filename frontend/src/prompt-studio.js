/* build:ps-20251112-idxfix */
/* ===== Prompt Studio – logic (index-safe add, robust reload) ===== */
const DEV_API  = "https://func-texel-api-dev-jpe-001-b2f6fec8fzcbdrc3.japaneast-01.azurewebsites.net/api/";
const PROD_API = "https://func-texel-api-prod-jpe-001-dsgfhtafbfbxawdz.japaneast-01.azurewebsites.net/api/";

/* kind ⇔ filename */
const KIND_TO_NAME = {
  "suumo-catch":   "texel-suumo-catch.json",
  "suumo-comment": "texel-suumo-comment.json",
  "roomphoto":     "texel-roomphoto.json",
  "suggestion":    "texel-suggestion.json",
  "athome-appeal": "texel-athome-appeal.json",
  "athome-comment":"texel-athome-comment.json",
};
const FAMILY = {
  "BASE":   new Set(["roomphoto","suumo-catch","suumo-comment","suggestion","athome-appeal","athome-comment"]),
  "TYPE-R": new Set(["roomphoto","suumo-catch","suumo-comment","suggestion","athome-appeal","athome-comment"]),
  "TYPE-S": new Set(["roomphoto","suumo-catch","suumo-comment","suggestion"])
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
  btnAdd:    document.getElementById("btnAdd"),
};

let currentEtag = null;
let templateText = "";
let dirty = false;

/* ---------- Prompt Index (order & display name) ---------- */
let promptIndex = null;      // {version, clientId, behavior, updatedAt, items:[{file,name,order,hidden,lock?}]}
let promptIndexPath = null;
let promptIndexEtag = null;

function indexClientPath(clientId){ return `client/${clientId}/prompt-index.json`; }
function prettifyNameFromFile(filename){
  return filename.replace(/\.json$/i,'').replace(/^texel[-_]?/i,'').replace(/[-_]+/g,' ').replace(/\b\w/g, s=>s.toUpperCase());
}
function join(base, path){ return (base||"").replace(/\/+$/,"") + "/" + String(path||"").replace(/^\/+/, ""); }

async function apiLoadText(filename){
  const r = await fetch(join(els.apiBase.value,"LoadPromptText"),{
    method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ filename })
  }).catch(()=>null);
  if (!r || !r.ok) return null;
  const j = await r.json().catch(()=>null);
  let data = null;
  const t = j?.text ?? j?.prompt ?? null;
  if (typeof t === "string"){ try{ data = JSON.parse(t) }catch{ data = t } }
  else if (j?.prompt) data = j.prompt;
  else if (j && typeof j === "object") data = j;
  return { etag: j?.etag ?? null, data };
}
async function apiSaveText(filename, payload, etag){
  const body = { filename, prompt: typeof payload==="string"? payload : JSON.stringify(payload,null,2) };
  if (etag) body.etag = etag;
  const r = await fetch(join(els.apiBase.value,"SavePromptText"),{
    method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body)
  });
  const raw = await r.text(); let j={}; try{ j = raw?JSON.parse(raw):{} }catch{}
  if (!r.ok) throw new Error(j?.error || raw || `HTTP ${r.status}`);
  return j;
}

function normalizeIndex(x){
  try{
    if (!x) return null;
    const pick = (o)=> (o && Array.isArray(o.items)) ? o : null;
    if (x.items) return pick(x);
    if (x.prompt?.items) return pick(x.prompt);
    if (typeof x === "string"){
      const p = JSON.parse(x);
      if (p.items) return pick(p);
      if (p.prompt?.items) return pick(p.prompt);
    }
  }catch{}
  return null;
}

async function ensurePromptIndex(clientId, behavior){
  const path = indexClientPath(clientId);
  const r = await apiLoadText(path);
  if (r){
    const idx = normalizeIndex(r.data);
    if (idx){ promptIndex=idx; promptIndexPath=path; promptIndexEtag=r.etag||null; return promptIndex; }
  }
  // not found → bootstrap (do NOT overwrite if exists)
  const kinds = [...FAMILY[behavior]];
  const items = [];
  let order = 10;
  for (const k of kinds){
    const file = KIND_TO_NAME[k];
    const isRoom = (k==="roomphoto");
    items.push({
      file,
      name: isRoom ? "画像分析プロンプト" : prettifyNameFromFile(file),
      order: order, hidden:false, lock: isRoom
    });
    order += 10;
  }
  promptIndex = { version:1, clientId, behavior, updatedAt:new Date().toISOString(), items };
  promptIndexPath = path; promptIndexEtag=null;
  await apiSaveText(promptIndexPath, promptIndex, null);
  return promptIndex;
}

async function reloadIndex(){
  if (!promptIndexPath) return;
  const r = await apiLoadText(promptIndexPath);
  if (!r) return;
  const idx = normalizeIndex(r.data);
  if (idx){ promptIndex = idx; promptIndexEtag = r.etag || null; }
}

async function saveIndex(){
  if (!promptIndex) return;
  promptIndex.updatedAt = new Date().toISOString();
  try{
    const res = await apiSaveText(promptIndexPath, promptIndex, promptIndexEtag);
    promptIndexEtag = res?.etag || promptIndexEtag || null;
  }catch(e){
    // If ETag precondition failed, reload and retry once
    const msg = String(e||"");
    if (msg.includes("412")){
      await reloadIndex();
      const res2 = await apiSaveText(promptIndexPath, promptIndex, promptIndexEtag);
      promptIndexEtag = res2?.etag || promptIndexEtag || null;
    }else{
      throw e;
    }
  }
}

async function renameIndexItem(file, newName){
  if (!promptIndexPath || !promptIndex){
    const clid = (els.clientId?.value||"").trim().toUpperCase();
    const beh  = (els.behavior?.value||"BASE").toUpperCase();
    await ensurePromptIndex(clid, beh);
  }
  const it = promptIndex?.items?.find(x=>x.file===file);
  if (!it) throw new Error("対象が見つかりません。");
  if (it.lock) throw new Error("ロックされている項目は名称変更できません。");
  const nv = (newName||"").trim();
  if (!nv) throw new Error("名称が空です。");
  it.name = nv;
  await saveIndex();
  await reloadIndex();
  return true;
}
async function deleteIndexItem(file){
  const i = promptIndex.items.findIndex(x=>x.file===file);
  if (i<0 || promptIndex.items[i].lock) return;
  promptIndex.items.splice(i,1);
  // re-number
  promptIndex.items.sort((a,b)=>(a.order??0)-(b.order??0)).forEach((x,i)=>x.order=(i+1)*10);
  await saveIndex();
}
async function addIndexItemRaw(fileName, displayName){
  // append only (never reconstruct)
  let file = (fileName||"").trim();
  if (!file.endsWith(".json")) file = file + ".json";
  if (!file.startsWith("texel-")) file = "texel-" + file;
  if (!promptIndex || !Array.isArray(promptIndex.items)) promptIndex = { version:1, items: [] };
  if (promptIndex.items.some(x=>x.file===file)) throw new Error("同名ファイルが既に存在します。");
  const maxOrder = Math.max(0, ...promptIndex.items.map(x=>x.order||0));
  promptIndex.items.push({ file, name:(displayName||'').trim()||prettifyNameFromFile(file), order:maxOrder+10, hidden:false });
  await saveIndex();
}

/* === auto filename generator === */
function generateAutoFilename(){
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `texel-custom-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.json`;
}

/* ---------- Tabs ---------- */
function showTab(which){
  const isPrompt = which === "prompt";
  els.tabPromptBtn?.classList.toggle("active", isPrompt);
  els.tabParamsBtn?.classList.toggle("active", !isPrompt);
  els.promptTab?.classList.toggle("active", isPrompt);
  els.paramsTab?.classList.toggle("active", !isPrompt);
}
els.tabPromptBtn?.addEventListener("click", ()=>showTab("prompt"));
els.tabParamsBtn?.addEventListener("click", ()=>showTab("params"));

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
    const v = document.getElementById("param_"+k)?.value ?? "";
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
let dragBound = false;
function boot(){
  const q = new URLSearchParams(location.hash.replace(/^#\??/, ''));
  els.clientId && (els.clientId.value = (q.get("client") || "").toUpperCase());
  els.behavior && (els.behavior.value = (q.get("behavior") || "BASE").toUpperCase());
  els.apiBase  && (els.apiBase.value  = q.get("api") || DEV_API);

  if (els.search){ els.search.style.display='none'; }
  renderFileList();

  window.addEventListener("keydown", (e)=>{
    if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==="s"){ e.preventDefault(); saveCurrent(); }
  });

  els.search?.addEventListener("input", ()=>{
    const kw = (els.search.value||"").toLowerCase();
    [...(els.fileList?.children||[])].forEach(it=>{
      const t = it.querySelector(".name")?.textContent.toLowerCase() || "";
      it.style.display = t.includes(kw) ? "" : "none";
    });
  });

  els.promptEditor?.addEventListener("input", markDirty);

  if (els.btnAdd){
    els.btnAdd.removeEventListener("click", onClickAdd);
    els.btnAdd.addEventListener("click", onClickAdd);
  }
}

function markDirty(){ dirty = true; }
function clearDirty(){ dirty = false; }
window.addEventListener("beforeunload", (e)=>{ if (!dirty) return; e.preventDefault(); e.returnValue=""; });

/* ---------- File List ---------- */
function templateFromFilename(filename, behavior){
  if (behavior === "TYPE-R") return filename.replace(/^texel-/, "texel-r-");
  if (behavior === "TYPE-S") return filename.replace(/^texel-/, "texel-s-");
  return filename;
}

async function tryLoad(filename){
  const url = join(els.apiBase.value, "LoadPromptText") + `?filename=${encodeURIComponent(filename)}`;
  const res = await fetch(url, { cache: "no-store" }).catch(()=>null);
  if (!res || !res.ok) return null;
  const etag = res.headers.get("etag") || null;
  let data = {};
  try { data = await res.json(); } catch { data = {}; }
  return { data, etag };
}

async function renderFileList(){
  if (!els.fileList) return;
  els.fileList.innerHTML = "";
  const clid = (els.clientId?.value||"").trim().toUpperCase();
  const beh  = (els.behavior?.value||"BASE").toUpperCase();

  await ensurePromptIndex(clid, beh);

  const rows = [...(promptIndex.items||[])]
    .filter(it => !it.hidden)
    .sort((a,b)=>(a.order??0)-(b.order??0));

  // Attach drag handlers once
  if (!dragBound){
    dragBound = true;
    els.fileList.addEventListener('dragover', (e)=>{
      e.preventDefault();
      const dragging = document.querySelector('.fileitem.dragging');
      const after = getDragAfterElement(els.fileList, e.clientY);
      if (dragging){
        if (!after) els.fileList.appendChild(dragging);
        else els.fileList.insertBefore(dragging, after);
      }
    });
    els.fileList.addEventListener('drop', async ()=>{
      const lis = [...els.fileList.querySelectorAll('.fileitem')];
      lis.forEach((el, i) => {
        const f = el.dataset.file;
        const it = promptIndex.items.find(x=>x.file===f);
        if (it) it.order = (i+1)*10;
      });
      await saveIndex();
    });
  }

  for (const it of rows){
    const name = it.name || prettifyNameFromFile(it.file);
    const li = document.createElement("div");
    li.className = "fileitem" + (it.lock? " locked": "");
    li.dataset.file = it.file;
    li.draggable = !it.lock;

    const lockIcon = it.lock ? `<span class="lock">🔒</span>` : "";

    li.innerHTML = `<span class="drag">≡</span>
                    <div class="name" title="${it.file}">${lockIcon}${name}</div>
                    <div class="meta">
                      ${it.lock? "" : '<button class="rename" title="名称を変更">✎</button>'}
                      ${it.lock? "" : '<button class="delete" title="削除">🗑</button>'}
                    </div>`;
    els.fileList.appendChild(li);

    if (!it.lock){
      li.addEventListener('dragstart', ()=> li.classList.add('dragging'));
      li.addEventListener('dragend', async ()=>{
        li.classList.remove('dragging');
        const lis = [...els.fileList.querySelectorAll('.fileitem')];
        lis.forEach((el, i) => {
          const f = el.dataset.file;
          const it2 = promptIndex.items.find(x=>x.file===f);
          if (it2) it2.order = (i+1)*10;
        });
        await saveIndex();
      });
    }

    li.addEventListener("click", async (e)=>{
      if (e.target.closest("button")) return; // handled by buttons
      await openByFilename(it.file);
    });

    if (!it.lock){
      li.querySelector(".rename")?.addEventListener("click", async (e)=>{
        e.preventDefault(); e.stopPropagation();
        const nv = prompt("表示名の変更", name);
        if (nv!=null){
          try{
            // optimistic update in UI
            li.querySelector('.name').innerHTML = (it.lock? '<span class="lock">🔒</span>' : '') + nv.trim();
            setStatus('名称を変更中…','orange');
            await renameIndexItem(it.file, nv.trim());
            setStatus('名称を変更しました。','green');
            await renderFileList();
          }catch(err){
            console.error(err);
            setStatus('名称変更に失敗: ' + (err?.message||err),'red');
            await reloadIndex();
            await renderFileList();
          }
        }
      });
      li.querySelector(".delete")?.addEventListener("click", async (e)=>{
        e.preventDefault(); e.stopPropagation();
        if (!confirm(`「${name}」を一覧から削除します。ファイル自体は削除されません。よろしいですか？`)) return;
        await deleteIndexItem(it.file);
        await reloadIndex();
        await renderFileList();
      });
    }
  }
}

function getDragAfterElement(container, y){
  const els2 = [...container.querySelectorAll('.fileitem:not(.dragging)')];
  return els2.reduce((closest, child)=>{
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height/2;
    return (offset < 0 && offset > closest.offset) ? { offset, element: child } : closest;
  }, { offset: Number.NEGATIVE_INFINITY }).element;
}

/* ---------- Open / Save ---------- */
async function openByFilename(filename){
  if (dirty && !confirm("未保存の変更があります。破棄して読み込みますか？")) return;

  els.diffPanel && (els.diffPanel.hidden = true);
  [...(els.fileList?.children||[])].forEach(n=>n.classList.toggle("active", n.dataset.file===filename));
  setStatus("読込中…","orange");

  const clid = (els.clientId?.value||"").trim().toUpperCase();
  const beh  = (els.behavior?.value||"BASE").toUpperCase();

  const clientTarget = `client/${clid}/${filename}`;
  const titleEl = document.getElementById("fileTitle");
  if (titleEl) titleEl.textContent = clientTarget;

  const candidates = [ clientTarget, `prompt/${clid}/${filename}`, templateFromFilename(filename, beh) ];

  let loaded = null, used = null;
  for (const f of candidates){
    const r = await tryLoad(f);
    if (r) { loaded = r; used = f; break; }
  }
  const templ = await tryLoad(templateFromFilename(filename, beh));
  templateText = templ ? JSON.stringify(templ.data, null, 2) : "";

  if (!loaded){
    currentEtag = null;
    if (els.promptEditor) els.promptEditor.value = "";
    writeParamUI({});
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

  if (els.promptEditor) els.promptEditor.value = promptText;
  writeParamUI(d.params || {});

  currentEtag = (used.startsWith("client/") || used.startsWith("prompt/")) ? loaded.etag : null;

  if (used.startsWith("client/")) setBadges("Overridden", currentEtag, "ok");
  else if (used.startsWith("prompt/")) setBadges("Overridden (legacy)", currentEtag, "ok");
  else setBadges("Template（未上書き）", loaded.etag || "—", "info");

  setStatus("読み込み完了","green");
  clearDirty();
}

els.btnSave?.addEventListener("click", saveCurrent);
async function saveCurrent(){
  const title = document.getElementById("fileTitle")?.textContent || "";
  if (!title || title==="未選択") return;
  const filename = title;
  const prompt = els.promptEditor?.value ?? "";
  const params = readParamUI();
  setStatus("保存中…","orange");
  try{
    const res = await apiSaveText(filename, { prompt, params }, currentEtag || undefined);
    currentEtag = res?.etag || currentEtag || null;
    setBadges("Overridden", currentEtag, "ok");
    setStatus("保存完了","green");
    clearDirty();
  }catch(e){
    setStatus("保存失敗: " + (e.message||e), "red");
    if (String(e).includes("412")) alert("他の人が更新しました。再読み込みしてから保存してください。");
  }
}

/* ---------- Diff ---------- */
els.btnDiff?.addEventListener("click", ()=>{
  if (els.diffLeft)  els.diffLeft.value  = templateText || "(テンプレートなし)";
  if (els.diffRight) els.diffRight.value = els.promptEditor?.value || "";
  if (els.diffPanel) els.diffPanel.hidden = !els.diffPanel.hidden;
});

/* ---------- Utils ---------- */
function setStatus(msg, color="#0AA0A6"){ if (els.status){ els.status.style.color = color; els.status.textContent = msg; } }
function setBadges(stateText, etag, mode){
  if (els.badgeState){ els.badgeState.textContent = stateText; els.badgeState.className = "chip " + (mode||""); }
  if (els.badgeEtag){ els.badgeEtag.textContent = etag || "—"; }
}

/* ===== Add Button handler (asks name, creates blob, appends to index, updates UI) ===== */
async function onClickAdd(){
  try{
    const clid = (els.clientId?.value||"").trim().toUpperCase();
    const beh  = (els.behavior?.value||"BASE").toUpperCase();
    if (!clid){ alert("Client ID が未設定です。左上で選択してください。"); return; }
    await ensurePromptIndex(clid, beh); // load existing index or bootstrap

    // ask only display name; filename auto
    const dname = prompt("新しいプロンプトの名称を入力してください", "新規プロンプト");
    if (dname === null) return;

    // unique filename
    let file = generateAutoFilename();
    const existing = new Set((promptIndex.items||[]).map(x=>x.file));
    let salt = 0;
    while (existing.has(file)){
      salt++;
      file = file.replace(/\.json$/, `-${salt}.json`);
    }

    // create placeholder at client/
    const clientPath = `client/${clid}/${file}`;
    await apiSaveText(clientPath, { prompt: "", params: {} }, null);

    // append to *existing* index
    await addIndexItemRaw(file, dname);

    // 🔁 re-fetch index to update local ETag and items
    await reloadIndex();

    // refresh list and open it
    await renderFileList();
    await openByFilename(file);
    setStatus("新しいプロンプトを追加しました。","green");
  }catch(e){
    alert("追加に失敗: " + (e?.message || e));
    console.error(e);
  }
}

/* ===== Optional Safe Wrapper (kept for compatibility) ===== */
(function(){
  function $q(sel){ return document.querySelector(sel); }
  function bind(){
    const btn = $q('#btnAdd, [data-role="btn-add"]');
    if (btn) btn.removeEventListener('click', onClickAdd), btn.addEventListener('click', onClickAdd);
  }
  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();


;(function(){
  try{
    const ver = window.__APP_BUILD__ || document.body?.dataset?.build || "(none)";
    console.log("%cPrompt Studio build:", "font-weight:bold", ver);
    const badge = document.getElementById("buildBadge");
    if (badge) badge.textContent = ver;
  }catch(e){}
})();