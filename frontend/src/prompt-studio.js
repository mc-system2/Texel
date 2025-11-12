
/* =====================================================================
   TEMPLATE-COPY INIT PATCH
   - On add: load 'texel-prompt-template.json' and save it to client/<ID>/texel-<ts>.json
   - Ensures flat structure like:
     { "prompt": "<string>", "params": { ... } }
   ===================================================================== */
(function(){
  try {
    var DEV_BASE = (typeof getFunctionBase === 'function') ? getFunctionBase() :
      (window.FUNCTION_BASE || "https://func-texel-api-dev-jpe-001-b2f6fec8fzcbdrc3.japaneast-01.azurewebsites.net/api");
    window.TEXEL_USE_TEMPLATE = true;
    var TEMPLATE_NAME = "texel-prompt-template.json";

    async function __loadTemplateDoc() {
      var url = DEV_BASE + "/LoadPromptText?filename=" + encodeURIComponent(TEMPLATE_NAME) + "&ts=" + Date.now();
      var res = await fetch(url, { method: "GET", cache: "no-store", headers: { "Accept":"application/json", "Cache-Control":"no-cache" } });
      if (!res.ok) throw new Error("Load template failed: " + res.status);
      return await res.json();
    }

    async function __saveDocTo(path, doc) {
      var url = DEV_BASE + "/SavePromptText?filename=" + encodeURIComponent(path);
      var body = JSON.stringify(doc);
      var res = await fetch(url, { method: "POST", cache: "no-store", headers: { "Content-Type":"application/json", "If-Match":"*" }, body });
      if (!res.ok) throw new Error("Save to client path failed: " + res.status);
      return res.headers.get("ETag") || null;
    }

    function __resolveClientId() {
      try {
        if (window.currentClientId) return String(window.currentClientId).trim();
        if (typeof window.getCurrentClientId === "function") return String(window.getCurrentClientId()||"").trim();
      } catch(_e){}
      return "";
    }

    // Normalize template into flat expected form (guard)
    function __normalizeFlatTemplate(raw){
      if (!raw || typeof raw !== "object") return { prompt:"", params:{} };
      if (typeof raw.prompt === "string") {
        return { prompt: String(raw.prompt), params: (raw.params && typeof raw.params==="object") ? raw.params : {} };
      }
      // nested → flat
      if (raw.prompt && typeof raw.prompt === "object" && "prompt" in raw.prompt) {
        return { prompt: String(raw.prompt.prompt || ""), params: (raw.prompt.params && typeof raw.prompt.params==="object") ? raw.prompt.params : {} };
      }
      // fallback minimal
      return { prompt:"", params:{} };
    }

    async function __createFromTemplate(displayName) {
      var clientId = __resolveClientId();
      if (!clientId) throw new Error("clientId not resolved");
      var file = "texel-" + Date.now() + ".json";
      var path = "client/" + clientId + "/" + file;

      var tpl = await __loadTemplateDoc();
      var flat = __normalizeFlatTemplate(tpl); // ensure exactly the requested shape
      await __saveDocTo(path, flat);

      if (typeof window.upsertPromptIndex === "function") {
        try { await window.upsertPromptIndex({ path: path, name: displayName || file, order: Date.now() }); } catch(_e){}
      }
      if (typeof window.openPrompt === "function") {
        try { await window.openPrompt({ path }); } catch(_e){}
      }
      return path;
    }

    // Override entry points to use the template-based creation
    window.addNewPrompt = __createFromTemplate;
    window.createPromptFile = __createFromTemplate;
    window.createNewPrompt = __createFromTemplate;

  } catch(e) {
    console.error("TEMPLATE-COPY INIT PATCH error:", e);
  }
})();
// ====================== END TEMPLATE-COPY INIT PATCH =======================


/* =====================================================================
   STRICT EMPTY INIT PATCH
   - Guarantee: newly created file content is exactly { "prompt": {}, "params": {} }
   - Overrides any existing creation flows (addNewPrompt/createPromptFile)
   - After creation, opens the created path
   ===================================================================== */
(function(){
  try {
    var DEV_BASE = (typeof getFunctionBase === 'function') ? getFunctionBase() :
      (window.FUNCTION_BASE || "https://func-texel-api-dev-jpe-001-b2f6fec8fzcbdrc3.japaneast-01.azurewebsites.net/api");
    window.TEXEL_EMPTY_INIT = true;

    async function __strictSaveEmpty(path) {
      var body = JSON.stringify({ prompt: {}, params: {} });
      var res = await fetch(DEV_BASE + "/SavePromptText?filename=" + encodeURIComponent(path), {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json", "If-Match": "*" },
        body
      });
      if (!res.ok) throw new Error("Strict empty init save failed: " + res.status);
      return res.headers.get("ETag") || null;
    }

    function __resolveClientId() {
      try {
        if (window.currentClientId) return String(window.currentClientId).trim();
        if (typeof window.getCurrentClientId === "function") return String(window.getCurrentClientId()||"").trim();
      } catch(_e){}
      return "";
    }

    async function __strictCreate(displayName) {
      var clientId = __resolveClientId();
      if (!clientId) throw new Error("clientId not resolved");
      var file = "texel-" + Date.now() + ".json";
      var path = "client/" + clientId + "/" + file;
      await __strictSaveEmpty(path);
      if (typeof window.upsertPromptIndex === "function") {
        try { await window.upsertPromptIndex({ path: path, name: displayName || file, order: Date.now() }); } catch(_e){}
      }
      if (typeof window.openPrompt === "function") {
        try { await window.openPrompt({ path }); } catch(_e){}
      }
      return path;
    }

    // Override multiple likely entry points
    window.addNewPrompt = __strictCreate;
    window.createPromptFile = __strictCreate;
    window.createNewPrompt = __strictCreate;

    // Defensive: intercept any DOM button with [data-action="add-prompt"]
    try {
      document.addEventListener("click", function(ev){
        var t = ev.target;
        if (!t) return;
        var el = t.closest("[data-action='add-prompt']");
        if (el) {
          ev.preventDefault();
          __strictCreate(el.getAttribute("data-name") || "");
        }
      }, true);
    } catch(_e){}
  } catch(e) {
    console.error("STRICT EMPTY INIT PATCH error:", e);
  }
})();
// ========================= END STRICT EMPTY INIT PATCH =====================


/* =====================================================================
   TEXEL Prompt-Studio Patch Block (DEV forced + cache/shape/ETag fixes)
   - Always use DEV endpoint
   - Full-path addressing (client/<ID>/...)
   - Load: no-store, no If-None-Match; cache-buster ts
   - Save: If-Match with lastKnownETag; update ETag on success
   - Shape normalize (flat <-> nested) to avoid "empty" first reopen
   - LocalStorage keys are full-path based
   - Add: create file in client/<ID>/..., upsert index, open that path
   - Reopen: always hit server (no stale LS), update editor state
   ===================================================================== */
(function() {
  try {
    var DEV_BASE = "https://func-texel-api-dev-jpe-001-b2f6fec8fzcbdrc3.japaneast-01.azurewebsites.net/api";
    // ===== Force DEV environment to avoid 404s
    if (typeof window !== 'undefined') {
      window.ENV = 'DEV';
      window.TEXEL_ENV = 'DEV';
      window.TEXEL_FORCE_DEV = true;
      window.FUNCTION_BASE = DEV_BASE;
      window.getFunctionBase = function() { return DEV_BASE; };
      window.FUNCTION_BASES = Object.assign({}, window.FUNCTION_BASES||{}, { DEV: DEV_BASE, PROD: DEV_BASE });
    }

    // ===== In-memory state & helpers
    window.editorState = window.editorState || { currentPath: null, lastKnownETag: null };
    var _memoryCache = new Map();
    function _localKey(path) { return "prompt:" + path; }

    // ===== Shape normalize (flat <-> nested)
    function normalizeDoc(raw) {
      var out = { prompt: { prompt: '', params: {} }, params: {} };
      if (!raw || typeof raw !== 'object') return out;
      // nested
      if (raw.prompt && typeof raw.prompt === 'object' && ('prompt' in raw.prompt)) {
        out.prompt.prompt = String(raw.prompt.prompt || '');
        out.prompt.params = raw.prompt.params || {};
        out.params = raw.params || {};
      } else {
        // flat
        if (typeof raw.prompt === 'string') out.prompt.prompt = raw.prompt;
        if (raw.params && typeof raw.params === 'object') out.prompt.params = raw.params;
      }
      // carry over unknown keys (shape-preserving)
      for (var k in raw) if (!(k in out)) out[k] = raw[k];
      return out;
    }

    // ===== I/O (always DEV, no-store)
    async function loadPromptText(path) {
      var base = (typeof getFunctionBase === 'function') ? getFunctionBase() : DEV_BASE;
      var url = base + "/LoadPromptText?filename=" + encodeURIComponent(path) + "&ts=" + Date.now();
      var res = await fetch(url, {
        method: "GET",
        cache: "no-store",
        headers: { "Accept": "application/json", "Cache-Control": "no-cache" }
      });
      if (!res.ok) throw new Error("Load failed: " + res.status);
      var etag = res.headers.get("ETag") || null;
      var doc = await res.json();
      return { doc, etag };
    }

    async function savePromptText(path, normalizedDoc, lastEtag) {
      var base = (typeof getFunctionBase === 'function') ? getFunctionBase() : DEV_BASE;
      var url = base + "/SavePromptText?filename=" + encodeURIComponent(path);
      var body = JSON.stringify(normalizedDoc);
      var headers = { "Content-Type": "application/json" };
      if (lastEtag) headers["If-Match"] = lastEtag; else headers["If-Match"] = "*";
      var res = await fetch(url, { method: "POST", cache: "no-store", headers, body });
      if (res.status === 412) throw new Error("Precondition Failed (ETag mismatch)");
      if (!res.ok) throw new Error("Save failed: " + res.status);
      var newEtag = res.headers.get("ETag") || null;
      // update state & caches
      window.editorState.currentPath = path;
      window.editorState.lastKnownETag = newEtag;
      _memoryCache.set(path, normalizedDoc);
      try { localStorage.setItem(_localKey(path), body); } catch(_e) {}
      return newEtag;
    }

    // ===== Path resolver (client -> prompt -> template)
    window.resolvePromptPath = window.resolvePromptPath || async function(entry) {
      if (entry && entry.path) return entry.path;
      // Fallback: resolve from entry fields
      var clientId = (window.currentClientId || (window.getCurrentClientId && window.getCurrentClientId()) || "").trim();
      var nameOrFile = (entry && (entry.file || entry.name || entry.id || entry.title)) || "";
      var candidates = [];
      if (clientId) candidates.push("client/" + clientId + "/" + nameOrFile);
      if (clientId) candidates.push("prompt/" + clientId + "/" + nameOrFile);
      candidates.push(nameOrFile); // template/raw
      // First that exists wins
      for (var i=0;i<candidates.length;i++) {
        try {
          var test = candidates[i];
          await loadPromptText(test); // if ok, return that path
          return test;
        } catch(_e) { /* try next */ }
      }
      // default to client path
      return candidates[0];
    };

    // ===== Open (always hit server; avoid stale LS)
    window.openPrompt = window.openPrompt || async function(entry) {
      var path = entry && entry.path ? entry.path : await window.resolvePromptPath(entry||{});
      var loaded = await loadPromptText(path);
      var normalized = normalizeDoc(loaded.doc);
      window.editorState.currentPath = path;
      window.editorState.lastKnownETag = loaded.etag;
      // render hooks (Project-specific): try common names and no-op fallback
      var render = window.renderEditor || window.bindEditor || window.showPromptEditor || function(doc){ 
        // fallback: put into a textarea if exists
        var ta = document.querySelector('#prompt-text') || document.querySelector('textarea[name="prompt"]');
        if (ta) ta.value = (doc && doc.prompt && doc.prompt.prompt) ? doc.prompt.prompt : "";
        var pa = document.querySelector('#prompt-params');
        if (pa) try { pa.value = JSON.stringify(doc.prompt.params || {}, null, 2); } catch(_e) {}
      };
      render(normalized);
      try { localStorage.setItem(_localKey(path), JSON.stringify(normalized)); } catch(_e) {}
      return normalized;
    };

    // ===== Add new prompt (client/<ID>/...)
    window.addNewPrompt = window.addNewPrompt || async function(displayName) {
      var clientId = (window.currentClientId || (window.getCurrentClientId && window.getCurrentClientId()) || "").trim();
      if (!clientId) throw new Error("clientId not resolved");
      var file = "texel-" + Date.now() + ".json";
      var path = "client/" + clientId + "/" + file;
      var initial = { prompt: {}, params: {} };
      await savePromptText(path, initial, null);
      // index upsert (project-specific hook)
      if (typeof window.upsertPromptIndex === 'function') {
        try { await window.upsertPromptIndex({ path: path, name: displayName || file, order: Date.now() }) } catch(_e) { console.warn(_e); }
      }
      await window.openPrompt({ path });
      return path;
    };

    // ===== Save current editor content using our robust I/O
    window.saveCurrentPrompt = window.saveCurrentPrompt || async function() {
      var path = window.editorState.currentPath;
      if (!path) throw new Error("No currentPath");
      // extract from UI (project-specific)
      var getDoc = window.collectEditorDoc || function() {
        var ta = document.querySelector('#prompt-text') || document.querySelector('textarea[name="prompt"]');
        var txt = (ta && ta.value) || "";
        var params = {};
        var pa = document.querySelector('#prompt-params');
        if (pa) { try { params = JSON.parse(pa.value || "{}"); } catch(_e) { params = {}; } }
        return { prompt: (txt || Object.keys(params||{}).length ? { prompt: txt, params: params } : {}), params: {} };
      };
      var doc = normalizeDoc(getDoc());
      var etag = window.editorState.lastKnownETag || null;
      var newEtag = await savePromptText(path, doc, etag);
      return newEtag;
    };

    // Expose helpers for debugging
    window.__PromptStudioPatch = {
      normalizeDoc, loadPromptText, savePromptText, addNewPrompt
    };
  } catch(e) {
    console.error("Prompt-Studio Patch error:", e);
  }
})();
// ========================== END OF PATCH BLOCK ===========================

/* build:ps-20251112-idxfix+pathfix+field-only-edit */
/* ===== Prompt Studio – logic (index-safe add, robust reload, field-only edit) ===== */
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
let currentLoadShape = "flat"; // 'flat' => {prompt:"", params:{}}, 'nested' => {prompt:{prompt:"",params:{}}, ...}
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

const LOAD_CANDIDATES = ["LoadPromptText","LoadBLOB","LoadPrompt","LoadText"];
const SAVE_CANDIDATES = ["SavePromptText","SaveBLOB","SavePrompt","SaveText"];

/* ---------- helpers: normalize/patch prompt docs ---------- */
function normalizePromptDoc(doc){
  // returns {prompt, params, shape}
  let prompt = "", params = {}, shape = "flat";
  if (typeof doc === "string"){
    prompt = doc;
  } else if (doc && typeof doc.prompt === "string"){
    prompt = doc.prompt;
    params = doc.params || {};
    shape = "flat";
  } else if (doc && doc.prompt && typeof doc.prompt.prompt === "string"){
    // nested style seen on some blobs: { "prompt": { "prompt": "...", "params": {...}}, "params": {...} }
    prompt = doc.prompt.prompt;
    params = Object.assign({}, doc.prompt.params || {}, doc.params || {});
    shape = "nested";
  } else if (doc && typeof doc.text === "string"){
    prompt = doc.text;
    params = doc.params || {};
    shape = "flat";
  }
  return { prompt, params, shape };
}

function patchPromptDoc(existing, newPrompt, newParams){
  // Update only the fields, preserving original shape and unknown keys.
  if (!existing || typeof existing !== "object"){
    return { prompt: newPrompt, params: newParams || {} };
  }
  // copy to avoid mutating the reference from cache
  const out = JSON.parse(JSON.stringify(existing));

  if (typeof out.prompt === "string"){
    out.prompt = newPrompt;
    out.params = newParams || {};
    return out;
  }
  if (out.prompt && typeof out.prompt.prompt === "string"){
    // keep nested shape
    out.prompt.prompt = newPrompt;
    out.prompt.params = newParams || {};
    // do not touch top-level params if any（混在を避けるため空にしておく）
    if ("params" in out && out.params && Object.keys(out.params).length){
      // keep it but do not overwrite
    }
    return out;
  }
  // unknown structure: fallback to the minimal flat shape but preserve unknown keys
  out.prompt = newPrompt;
  out.params = newParams || {};
  return out;
}

/* ---------- API wrappers ---------- */
async function apiLoadText(filename){
  // Try GET first (cache disabled)
  const getRes = await tryLoad(filename);
  if (getRes) { getRes.used = "GET"; return { etag: getRes.etag ?? null, data: getRes.data, used: "GET" }; }

  // Try POST with multiple function names
  for (const fn of LOAD_CANDIDATES){
    try{
      const r = await fetch(join(els.apiBase.value, fn), {
        method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ filename })
      });
      if (!r.ok) continue;
      const j = await r.json().catch(()=>null);
      let data = null;
      const t = j?.text ?? j?.prompt ?? null;
      if (typeof t === "string"){ try{ data = JSON.parse(t) }catch{ data = t } }
      else if (j?.prompt) data = j.prompt;
      else if (j && typeof j === "object") data = j;
      return { etag: j?.etag ?? null, data, used: fn };
    }catch{ /* ignore and try next */ }
  }
  return null;
}
async function apiSaveText(filename, payload, etag){
  const body = { filename, prompt: typeof payload==="string"? payload : JSON.stringify(payload,null,2) };
  if (etag) body.etag = etag;

  for (const fn of SAVE_CANDIDATES){
    try{
      const r = await fetch(join(els.apiBase.value, fn), {
        method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body)
      });
      const raw = await r.text(); let j={}; try{ j = raw?JSON.parse(raw):{} }catch{}
      if (!r.ok) continue;
      if (els.badgeEtag) els.badgeEtag.title = "via " + fn; // show which endpoint succeeded
      return j;
    }catch{ /* try next */ }
  }
  throw new Error("保存APIが見つかりません（候補: " + SAVE_CANDIDATES.join(",") + "）");
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

async function ensurePromptIndex(clientId, behavior, bootstrap=true){
  const path = indexClientPath(clientId);
  // 1) Try POST/GET loader
  let r = await apiLoadText(path);
  if (!r) {
    const g = await tryLoad(path);
    if (g) r = g;
  }
  if (r){
    const idx = normalizeIndex(r.data);
    if (idx){ promptIndex=idx; promptIndexPath=path; promptIndexEtag=r.etag||null; return promptIndex; }
  }
  if (!bootstrap && promptIndex && promptIndexPath===path){
    return promptIndex;
  }
  if (!bootstrap){
    console.warn("ensurePromptIndex: load failed; skipped bootstrap to avoid overwrite. Check API base or function name.");
    setStatus("インデックスの読込に失敗（再構築は未実施）。API設定をご確認ください。","orange");
    return promptIndex;
  }
  // Bootstrap (index新規作成)
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
  try{
    await apiSaveText(promptIndexPath, promptIndex, null);
  }catch(e){
    console.error("bootstrap save failed:", e);
    setStatus("インデックス新規作成に失敗しました。API設定をご確認ください。","red");
  }
  return promptIndex;
}

async function reloadIndex(){
  if (!promptIndexPath) return;
  const res = await tryLoad(promptIndexPath);
  if (!res) return;
  const idx = normalizeIndex(res.data);
  if (idx){
    promptIndex = idx;
    promptIndexEtag = res.etag || null;
  }
}

async function saveIndex(){
  if (!promptIndex) return;
  promptIndex.updatedAt = new Date().toISOString();
  try{
    const res = await apiSaveText(promptIndexPath, promptIndex, promptIndexEtag);
    promptIndexEtag = res?.etag || promptIndexEtag || null;
  }catch(e){
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
    await ensurePromptIndex(clid, beh, true);
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
  promptIndex.items.sort((a,b)=>(a.order??0)-(b.order??0)).forEach((x,i)=>x.order=(i+1)*10);
  await saveIndex();
}
async function addIndexItemRaw(fileName, displayName){
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
  // 正規化：既に r-/s- で始まっていたら一度 texel- に戻す
  const normalized = (filename || "").replace(/^texel-(r-|s-)/, 'texel-');
  const beh = (behavior || '').toUpperCase();
  if (beh === "TYPE-R") return normalized.replace(/^texel-/, "texel-r-");
  if (beh === "TYPE-S") return normalized.replace(/^texel-/, "texel-s-");
  return normalized;
}

async function tryLoad(filename){
  const clid = (els.clientId?.value||"").trim().toUpperCase();
  const beh  = (els.behavior?.value||"BASE").toUpperCase();

  const candidates = [];
  if (typeof filename === "string" && !filename.includes("/")){
    candidates.push(`client/${clid}/${filename}`);
    candidates.push(`prompt/${clid}/${filename}`);
    candidates.push(templateFromFilename(filename, beh));
  } else {
    candidates.push(filename);
  }
  for (const f of candidates){
    const url = join(els.apiBase.value, "LoadPromptText") + `?filename=${encodeURIComponent(f)}`;
    const res = await fetch(url, { cache: "no-store" }).catch(()=>null);
    if (!res || !res.ok) continue;
    const etag = res.headers.get("etag") || null;
    let data = {};
    try { data = await res.json(); } catch { data = {}; }
    return { data, etag, used:f };
  }
  return null;
}

async function renderFileList(){
  if (!els.fileList) return;
  els.fileList.innerHTML = "";
  const clid = (els.clientId?.value||"").trim().toUpperCase();
  const beh  = (els.behavior?.value||"BASE").toUpperCase();

  await ensurePromptIndex(clid, beh, true);

  const rows = [...(promptIndex.items||[])]
    .filter(it => !it.hidden)
    .sort((a,b)=>(a.order??0)-(b.order??0));

  // drag handlers once
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
    currentLoadShape = "flat";
    if (els.promptEditor) els.promptEditor.value = "";
    writeParamUI({});
    setBadges("Missing（新規）", null);
    setStatus("新規作成できます。右上の保存で client 配下に作成します。");
    clearDirty();
    return;
  }

  const norm = normalizePromptDoc(loaded.data || {});
  currentLoadShape = norm.shape;
  if (els.promptEditor) els.promptEditor.value = norm.prompt || "";
  writeParamUI(norm.params || {});

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

  const filename = title; // already "client/<id>/<file>.json" by openByFilename
  const newPrompt = els.promptEditor?.value ?? "";
  const newParams = readParamUI();
  setStatus("保存中…","orange");

  try{
    // Load current to preserve unknown fields and shape
    let baseDoc = null;
    const cur = await tryLoad(filename);
    if (cur && cur.data) baseDoc = cur.data;

    // If nothing exists yet, still respect the last loaded shape (flat default)
    const payload = patchPromptDoc(baseDoc, newPrompt, newParams);

    const res = await apiSaveText(filename, payload, currentEtag || undefined);
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
    await ensurePromptIndex(clid, beh, true);

    const dname = prompt("新しいプロンプトの名称を入力してください", "新規プロンプト");
    if (dname === null) return;

    let file = generateAutoFilename();
    const existing = new Set((promptIndex.items||[]).map(x=>x.file));
    let salt = 0;
    while (existing.has(file)){ salt++; file = file.replace(/\.json$/, `-${salt}.json`); }

    const clientPath = `client/${clid}/${file}`;
    await apiSaveText(clientPath, { prompt: "", params: {} }, null);

    await addIndexItemRaw(file, dname);
    await reloadIndex();
    await renderFileList();
    await openNewlyCreatedWithRetry(file, 6, 250);
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

async function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function openNewlyCreatedWithRetry(filename, tries=6, interval=250){
  try{
    const clid = (els && els.clientId && els.clientId.value ? els.clientId.value : "").trim().toUpperCase();
    const target = `client/${clid}/${filename}`;
    for (let i=0;i<tries;i++){
      try{
        const url = join(els.apiBase.value, "LoadPromptText") + `?filename=${encodeURIComponent(target)}`;
        const res = await fetch(url, { cache:"no-store" });
        if (res.ok){
          // 成功したら通常オープンへ
          await openByFilename(filename);
          return true;
        }
      }catch(e){}
      await sleep(interval);
    }
    // 取得できなくても最後に開く（テンプレになる可能性はあるが UI は継続）
    await openByFilename(filename);
    return false;
  }catch(e){
    try{ await openByFilename(filename); }catch(_){}
    return false;
  }
}

