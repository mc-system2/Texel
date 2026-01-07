/* build:ps-20260107-catalog-bootstrap+ui-dblclick */
/* ===== Prompt Studio – logic (index-safe add, robust reload, field-only edit) ===== */
const DEV_API = "https://func-texel-api-dev-jpe-001-b2f6fec8fzcbdrc3.japaneast-01.azurewebsites.net/api/";
const PROD_API = "https://func-texel-api-prod-jpe-001-dsgfhtafbfbxawdz.japaneast-01.azurewebsites.net/api/";

/* kind ⇔ filename */
const KIND_TO_NAME = {
    "suumo-catch": "texel-suumo-catch.json",
    "suumo-comment": "texel-suumo-comment.json",
    "roomphoto": "texel-roomphoto.json",
    "suggestion": "texel-suggestion.json",
    "athome-appeal": "texel-athome-appeal.json",
    "athome-comment": "texel-athome-comment.json",
};
const FAMILY = {
    "BASE": new Set(["roomphoto", "suumo-catch", "suumo-comment", "suggestion", "athome-appeal", "athome-comment"]),
    "TYPE-R": new Set(["roomphoto", "suumo-catch", "suumo-comment", "suggestion", "athome-appeal", "athome-comment"]),
    "TYPE-S": new Set(["roomphoto", "suumo-catch", "suumo-comment", "suggestion"])
};

const els = {
    clientId: document.getElementById("clientId"),
    clientName: document.getElementById("clientName"),
    behaviorLabel: document.getElementById("behaviorLabel"),
    apiBase: document.getElementById("apiBase"),
    fileList: document.getElementById("fileList"),
    search: document.getElementById("search"),
    fileTitle: document.getElementById("fileTitle"),
    badgeState: document.getElementById("badgeState"),
    badgeEtag: document.getElementById("badgeEtag"),
    tabPromptBtn: document.getElementById("tabPromptBtn"),
    tabParamsBtn: document.getElementById("tabParamsBtn"),
    promptTab: document.getElementById("promptTab"),
    paramsTab: document.getElementById("paramsTab"),
    promptEditor: document.getElementById("promptEditor"),
    btnSave: document.getElementById("btnSave"),
    btnDiff: document.getElementById("btnDiff"),
    diffPanel: document.getElementById("diffPanel"),
    diffLeft: document.getElementById("diffLeft"),
    diffRight: document.getElementById("diffRight"),
    status: document.getElementById("statusMessage"),
    btnAdd: document.getElementById("btnAdd"),
};

let currentEtag = null;
let currentLoadShape = "flat";
// 'flat' => {prompt:"", params:{}}, 'nested' => {prompt:{prompt:"",params:{}}, ...}
let templateText = "";
let dirty = false;

/* ---------- Prompt Index (order & display name) ---------- */
let promptIndex = null;
// {version, clientId, behavior, updatedAt, items:[{file,name,order,hidden,lock?}]}
let promptIndexPath = null;
let promptIndexEtag = null;

function indexClientPath(clientId) {
    return `client/${clientId}/prompt-index.json`;
}
function prettifyNameFromFile(filename) {
    return filename.replace(/\.json$/i, '').replace(/^texel[-_]?/i, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, s => s.toUpperCase());
}
function join(base, path) {
    return (base || "").replace(/\/+$/, "") + "/" + String(path || "").replace(/^\/+/, "");
}

const LOAD_CANDIDATES = ["LoadPromptText"];
const SAVE_CANDIDATES = ["SavePromptText"];

/* ---------- helpers: normalize/patch prompt docs ---------- */
function normalizePromptDoc(doc) {
    // returns {prompt, params, shape}
    let prompt = ""
      , params = {}
      , shape = "flat";
    if (typeof doc === "string") {
        prompt = doc;
    } else if (doc && typeof doc.prompt === "string") {
        prompt = doc.prompt;
        params = doc.params || {};
        shape = "flat";
    } else if (doc && doc.prompt && typeof doc.prompt.prompt === "string") {
        // nested style seen on some blobs: { "prompt": { "prompt": "...", "params": {...}}, "params": {...} }
        prompt = doc.prompt.prompt;
        params = Object.assign({}, doc.prompt.params || {}, doc.params || {});
        shape = "nested";
    } else if (doc && typeof doc.text === "string") {
        prompt = doc.text;
        params = doc.params || {};
        shape = "flat";
    }
    return {
        prompt,
        params,
        shape
    };
}

function patchPromptDoc(existing, newPrompt, newParams) {
    // Update only the fields, preserving original shape and unknown keys.
    if (!existing || typeof existing !== "object") {
        return {
            prompt: newPrompt,
            params: newParams || {}
        };
    }
    // copy to avoid mutating the reference from cache
    const out = JSON.parse(JSON.stringify(existing));

    if (typeof out.prompt === "string") {
        out.prompt = newPrompt;
        out.params = newParams || {};
        return out;
    }
    if (out.prompt && typeof out.prompt.prompt === "string") {
        // keep nested shape
        out.prompt.prompt = newPrompt;
        out.prompt.params = newParams || {};
        // do not touch top-level params if any（混在を避けるため空にしておく）
        if ("params"in out && out.params && Object.keys(out.params).length) {// keep it but do not overwrite
        }
        return out;
    }
    // unknown structure: fallback to the minimal flat shape but preserve unknown keys
    out.prompt = newPrompt;
    out.params = newParams || {};
    return out;
}

/* ---------- Save-time normalizer (last-mile) ---------- */
function toFlat(doc) {
    const out = {};
    if (doc && typeof doc === "object") {
        for (const k in doc) {
            if (k !== "prompt" && k !== "params")
                out[k] = doc[k];
        }
    }
    if (doc && typeof doc === "object" && doc.prompt && typeof doc.prompt === "object" && ('prompt'in doc.prompt)) {
        out.prompt = doc.prompt.prompt ?? "";
        const p1 = (doc.prompt.params && typeof doc.prompt.params === "object" && !Array.isArray(doc.prompt.params)) ? doc.prompt.params : {};
        const p2 = (doc.params && typeof doc.params === "object" && !Array.isArray(doc.params)) ? doc.params : {};
        out.params = Object.keys(p1).length ? p1 : p2;
        if (!out.params)
            out.params = {};
        return out;
    }
    if (doc && typeof doc === "object") {
        out.prompt = (doc.prompt !== undefined) ? doc.prompt : "";
        out.params = (doc.params && typeof doc.params === "object" && !Array.isArray(doc.params)) ? doc.params : {};
        return out;
    }
    out.prompt = (doc == null) ? "" : String(doc);
    out.params = {};
    return out;
}
/* ---------- API wrappers ---------- */
// ---- Client Catalog (texel-client-catalog.json) ----
// Prompt Studio の index bootstrap 時に、client-editor.js と同じ API（LoadClientCatalog）で取得する
async function loadClientCatalogMeta(clientId) {
    try {
        const fname = "texel-client-catalog.json";
        const url = join(els.apiBase.value, "LoadClientCatalog") + `?filename=${encodeURIComponent(fname)}`;
        const res = await fetch(url, { cache: "no-cache" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ctype = (res.headers.get("content-type") || "").toLowerCase();
        const data = ctype.includes("application/json") ? await res.json() : JSON.parse(await res.text());

        // catalog 形状差を吸収（配列直下 / items / clients）
        const list = Array.isArray(data) ? data
            : (Array.isArray(data.items) ? data.items
            : (Array.isArray(data.clients) ? data.clients : []));

        const hit = list.find(x => String(x?.clientId || x?.code || "") === String(clientId));
        if (!hit) return null;

        return {
            clientId: hit.clientId || clientId,
            name: hit.name || "",
            behavior: hit.behavior || hit.type || "",
            spreadsheetId: hit.spreadsheetId || hit.sheetId || "",
            createdAt: hit.createdAt || ""
        };
    } catch (e) {
        console.warn("loadClientCatalogMeta failed:", e);
        return null;
    }
}

async function apiLoadText(filename) {
    // Try GET first (cache disabled)
    const getRes = await tryLoad(filename);
    if (getRes) {
        getRes.used = "GET";
        return {
            etag: getRes.etag ?? null,
            data: getRes.data,
            used: "GET"
        };
    }

    // Try POST with multiple function names
    for (const fn of LOAD_CANDIDATES) {
        try {
            const r = await fetch(join(els.apiBase.value, fn), {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    filename
                })
            });
            if (!r.ok)
                continue;
            const j = await r.json().catch( () => null);
            let data = null;
            const t = j?.text ?? j?.prompt ?? null;
            if (typeof t === "string") {
                try {
                    data = JSON.parse(t)
                } catch {
                    data = t
                }
            } else if (j?.prompt)
                data = j.prompt;
            else if (j && typeof j === "object")
                data = j;
            return {
                etag: j?.etag ?? null,
                data,
                used: fn
            };
        } catch {/* ignore and try next */
        }
    }
    return null;
}

// ===== Prompt Index (pure JSON) dedicated APIs =====
async function apiLoadPromptIndex(filename) {
  const url = join(els.apiBase.value, "LoadPromptIndex") + "?filename=" + encodeURIComponent(filename);
  const res = await fetch(url, { cache: "no-store" });
  const text = await res.text().catch(() => "");
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { status: res.status, ok: res.ok, data, etag: res.headers.get("etag") || res.headers.get("ETag") || null };
}

async function apiSavePromptIndex(filename, indexObj, etag) {
  const url = join(els.apiBase.value, "SavePromptIndex");
  const headers = { "Content-Type": "application/json" };
  if (etag) headers["If-Match"] = etag;
  const body = { filename, index: indexObj }; // backend will store raw pure JSON
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text().catch(() => "");
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { status: res.status, ok: res.ok, data, etag: res.headers.get("etag") || res.headers.get("ETag") || null };
}
async function apiSaveText(filename, payload, etag) {
    const flat = (typeof payload === "string") ? ( () => {
        try {
            return toFlat(JSON.parse(payload));
        } catch {
            return toFlat({
                prompt: String(payload),
                params: {}
            });
        }
    }
    )() : toFlat(payload);
    const body = {
        filename,
        prompt: JSON.stringify(flat, null, 2)
    };
    if (etag)
        body.etag = etag;

    for (const fn of SAVE_CANDIDATES) {
        try {
            const r = await fetch(join(els.apiBase.value, fn), {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(body)
            });
            const raw = await r.text();
            let j = {};
            try {
                j = raw ? JSON.parse(raw) : {}
            } catch {}
            if (!r.ok)
                continue;
            if (els.badgeEtag)
                els.badgeEtag.title = "via " + fn;
            // show which endpoint succeeded
            return j;
        } catch {/* try next */
        }
    }
    throw new Error("保存APIが見つかりません（候補: " + SAVE_CANDIDATES.join(",") + "）");
}

/** Apply client metadata to UI (client name / sheet id). */
function applyClientMetaToUi(meta) {
  if (!meta) return;
  try {
    if (els.clientName) els.clientName.value = meta.name || "";
    if (els.clientSheetId) els.clientSheetId.value = meta.spreadsheetId || "";
  } catch {}
}

async function loadClientCatalogSafe() {
  const filename = "texel-client-catalog.json";
  const url = join(els.apiBase.value, `LoadClientCatalog?filename=${encodeURIComponent(filename)}`);
  const r = await fetch(url, { method: "GET" });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`LoadClientCatalog failed (${r.status}): ${t}`);
  }
  const raw = await r.text();
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

function findClientMetaFromCatalog(catalog, clientId) {
  if (!catalog || !clientId) return null;
  const arr =
    Array.isArray(catalog) ? catalog :
    Array.isArray(catalog.items) ? catalog.items :
    Array.isArray(catalog.clients) ? catalog.clients :
    Array.isArray(catalog.data) ? catalog.data : [];
  return arr.find(x => (x?.clientId || x?.id || "") === clientId) || null;
}

function normalizeIndex(x) {
    try {
        if (!x) return null;

        const sanitize = (o) => {
            if (!o || !Array.isArray(o.items)) return null;
            // 余計なフィールド（他形式の名残）を除去
            if ("prompt" in o) delete o.prompt;
            if ("params" in o) delete o.params;
            return o;
        };

        if (x.items) return sanitize(x);
        if (x.prompt?.items) return sanitize(x.prompt);

        if (typeof x === "string") {
            const p = JSON.parse(x);
            if (p.items) return sanitize(p);
            if (p.prompt?.items) return sanitize(p.prompt);
        }
    } catch {}
    return null;
}

async function reconcileIndexWithDirectory(clientId, idx) {
  // Adds missing json files (e.g., texel-custom-*.json) that exist in the client folder but not in index.
  // Keeps existing orders; appends new files at the end (10-step).
  try {
    const dirFiles = await apiListClientPromptFiles(clientId);
    if (!Array.isArray(dirFiles) || dirFiles.length === 0) return { changed: false, idx };

    const existing = new Set((idx.items || []).map(it => String(it.file || "")));
    let maxOrder = 0;
    for (const it of (idx.items || [])) maxOrder = Math.max(maxOrder, Number(it.order) || 0);
    let nextOrder = Math.ceil((maxOrder || 0) / 10) * 10;
    if (nextOrder <= maxOrder) nextOrder = maxOrder + 10;
    let changed = false;

    for (const f of dirFiles) {
      if (!f || f === "prompt-index.json") continue;
      if (!String(f).toLowerCase().endsWith(".json")) continue;
      if (existing.has(f)) continue;
      idx.items = idx.items || [];
      idx.items.push({ file: f, name: "", order: nextOrder, hidden: false, lock: false });
      existing.add(f);
      nextOrder += 10;
      changed = true;
    }

    // Keep deterministic ordering by order then file
    if (Array.isArray(idx.items)) {
      idx.items.sort((a, b) => {
        const oa = Number(a?.order) || 0, ob = Number(b?.order) || 0;
        if (oa !== ob) return oa - ob;
        return String(a?.file || "").localeCompare(String(b?.file || ""), "en");
      });
    }
    return { changed, idx };
  } catch {
    return { changed: false, idx };
  }
}




async function ensurePromptIndex(clientId, behavior, bootstrap=true) {
  const path = indexClientPath(clientId);

  // 1) Try load via dedicated index API (pure JSON)
  const r = await apiLoadPromptIndex(path).catch(() => null);

  if (r && r.status === 200) {
    const idx = normalizeIndex(r.data);
    if (idx) {
      // When index exists, index is source of truth for name/sheet
      promptIndex = idx;
      promptIndexPath = path;
      promptIndexEtag = r.etag || null;

      // If header fields are missing in index, backfill from client-catalog and persist (index is canonical thereafter)
      if ((!idx.name || !idx.spreadsheetId) && typeof loadClientCatalogSafe === "function") {
        try {
          const catalog = await loadClientCatalogSafe();
          const meta = findClientMetaFromCatalog(catalog, clientId);
          if (meta) {
            let changedMeta = false;
            if (!idx.name && meta.name) { idx.name = meta.name; changedMeta = true; }
            if (!idx.spreadsheetId && meta.spreadsheetId) { idx.spreadsheetId = meta.spreadsheetId; changedMeta = true; }
            if (!idx.behavior && (meta.behavior || behavior)) { idx.behavior = meta.behavior || behavior; changedMeta = true; }
            if (!idx.createdAt && meta.createdAt) { idx.createdAt = meta.createdAt; changedMeta = true; }
            if (changedMeta) {
              idx.updatedAt = new Date().toISOString();
              const savedMeta = await apiSavePromptIndex(path, idx, promptIndexEtag).catch(() => null);
              if (savedMeta && savedMeta.ok) promptIndexEtag = savedMeta.etag || promptIndexEtag;
            }
          }
        } catch {}
      }

      applyClientMetaToUi({ name: idx.name || "", spreadsheetId: idx.spreadsheetId || "" });
      // Reconcile: if folder has additional JSON files (e.g. texel-custom-*.json) not listed, append them
      const rec = await reconcileIndexWithDirectory(clientId, promptIndex);
      if (rec.changed) {
        promptIndex.updatedAt = new Date().toISOString();
        const saved = await apiSavePromptIndex(promptIndexPath, promptIndex, promptIndexEtag).catch(() => null);
        if (saved && saved.ok) promptIndexEtag = saved.etag || promptIndexEtag;
      }
      return promptIndex;
    }
  }

  // 404 is normal: index missing
  const isMissing = (r && r.status === 404);

  if (!bootstrap) {
    if (!isMissing) {
      console.warn("ensurePromptIndex: load failed; skipped bootstrap. Check API base or function name.");
      setStatus("インデックスの読込に失敗。API設定をご確認ください。", "orange");
    }
    return promptIndex;
  }

  if (!isMissing && r) {
    // Non-404 failures should not bootstrap (avoid overwriting)
    console.warn("ensurePromptIndex: load failed; skipped bootstrap to avoid overwrite.", r.status);
    setStatus("インデックスの読込に失敗（再構築は未実施）。API設定をご確認ください。", "orange");
    return promptIndex;
  }

  // 2) Index missing -> use client-catalog for header fields in UI, then bootstrap
  let meta = null;
  try {
    const catalog = await loadClientCatalogSafe();
    meta = findClientMetaFromCatalog(catalog, clientId);
    applyClientMetaToUi(meta);
  } catch {}

  const dirFiles = await apiListClientPromptFiles(clientId);
  const hasDir = Array.isArray(dirFiles) && dirFiles.length > 0;

  const kinds = [...FAMILY[behavior]];
  const standardFiles = kinds.map(k => KIND_TO_NAME[k]).filter(Boolean);

  const ordered = [];
  if (hasDir) {
    const set = new Set(dirFiles);
    for (const f of standardFiles) if (set.has(f)) ordered.push(f);
    for (const f of dirFiles) if (!ordered.includes(f)) ordered.push(f);
  } else {
    ordered.push(...standardFiles);
  }

  const items = [];
  let order = 10;
  for (const file of ordered) {
    items.push({ file, name: "", order, hidden: false, lock: false });
    order += 10;
  }

  const ymd = new Date().toISOString().slice(0, 10);
  promptIndex = {
    version: 1,
    clientId,
    name: meta?.name || "",
    behavior: meta?.behavior || behavior || "",
    spreadsheetId: meta?.spreadsheetId || "",
    createdAt: meta?.createdAt || ymd,
    updatedAt: new Date().toISOString(),
    items
  };
  promptIndexPath = path;
  promptIndexEtag = null;

  const saved = await apiSavePromptIndex(promptIndexPath, promptIndex, null).catch(e => {
    console.error("bootstrap save failed:", e);
    return null;
  });
  if (saved && saved.ok) promptIndexEtag = saved.etag || null;

  return promptIndex;
}


async function reloadIndex() {
  if (!promptIndexPath) return null;
  const r = await apiLoadPromptIndex(promptIndexPath).catch(() => null);
  if (r && r.status === 200) {
    const idx = normalizeIndex(r.data);
    if (idx) {
      promptIndex = idx;
      promptIndexEtag = r.etag || promptIndexEtag || null;
      applyClientMetaToUi({ name: idx.name || "", spreadsheetId: idx.spreadsheetId || "" });
      return promptIndex;
    }
  }
  return null;
}

async function saveIndex() {
  if (!promptIndex) return;
  promptIndex.updatedAt = new Date().toISOString();
  try {
    const res = await apiSavePromptIndex(promptIndexPath, promptIndex, promptIndexEtag);
    if (res && res.ok) promptIndexEtag = res.etag || promptIndexEtag || null;
  } catch (e) {
    const msg = String(e || "");
    if (msg.includes("412")) {
      await reloadIndex();
      const res2 = await apiSavePromptIndex(promptIndexPath, promptIndex, promptIndexEtag);
      if (res2 && res2.ok) promptIndexEtag = res2.etag || promptIndexEtag || null;
    } else {
      throw e;
    }
  }
}


async function renameIndexItem(file, newName) {
    if (!promptIndexPath || !promptIndex) {
        const clid = (els.clientId?.value || "").trim().toUpperCase();
        const beh = document.getElementById("behaviorLabel").textContent;
        await ensurePromptIndex(clid, beh, true);
    }
    const it = promptIndex?.items?.find(x => x.file === file);
    if (!it)
        throw new Error("対象が見つかりません。");

    const nv = (newName || "").trim();
    if (!nv)
        throw new Error("名称が空です。");

    it.name = nv;
    await saveIndex();
    await reloadIndex();
    return true;
}

async function deleteIndexItem(file) {
    const i = promptIndex.items.findIndex(x => x.file === file);
    if (i < 0 || promptIndex.items[i].lock)
        return;
    promptIndex.items.splice(i, 1);
    promptIndex.items.sort( (a, b) => (a.order ?? 0) - (b.order ?? 0)).forEach( (x, i) => x.order = (i + 1) * 10);
    await saveIndex();
}
async function addIndexItemRaw(fileName, displayName) {
    let file = (fileName || "").trim();
    if (!file.endsWith(".json"))
        file = file + ".json";
    if (!file.startsWith("texel-"))
        file = "texel-" + file;
    if (!promptIndex || !Array.isArray(promptIndex.items))
        promptIndex = {
            version: 1,
            items: []
        };
    if (promptIndex.items.some(x => x.file === file))
        throw new Error("同名ファイルが既に存在します。");
    const maxOrder = Math.max(0, ...promptIndex.items.map(x => x.order || 0));
    promptIndex.items.push({
        file,
        name: (displayName || '').trim() || prettifyNameFromFile(file),
        order: maxOrder + 10,
        hidden: false
    });
    await saveIndex();
}

/* === auto filename generator === */
function generateAutoFilename() {
    const d = new Date();
    const pad = n => String(n).padStart(2, "0");
    return `texel-custom-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.json`;
}

/* ---------- Tabs ---------- */
function showTab(which) {
    const isPrompt = which === "prompt";
    els.tabPromptBtn?.classList.toggle("active", isPrompt);
    els.tabParamsBtn?.classList.toggle("active", !isPrompt);
    els.promptTab?.classList.toggle("active", isPrompt);
    els.paramsTab?.classList.toggle("active", !isPrompt);
}
els.tabPromptBtn?.addEventListener("click", () => showTab("prompt"));
els.tabParamsBtn?.addEventListener("click", () => showTab("params"));

/* ---------- Params ---------- */
const paramKeys = [["max_tokens", 800], ["temperature", 1.00], ["top_p", 1.00], ["frequency_penalty", 0.00], ["presence_penalty", 0.00], ["n", 1], ];
function writeParamUI(params) {
    paramKeys.forEach( ([k,def]) => {
        const input = document.getElementById("param_" + k);
        const span = document.getElementById("val_" + k);
        if (!input || !span)
            return;
        const v = (params && params[k] !== undefined) ? params[k] : def;
        input.value = v;
        span.textContent = ("" + v).includes(".") ? Number(v).toFixed(2) : v;
    }
    );
}
function readParamUI() {
    const o = {};
    paramKeys.forEach( ([k]) => {
        const v = document.getElementById("param_" + k)?.value ?? "";
        o[k] = ("" + v).includes(".") ? parseFloat(v) : parseInt(v, 10);
    }
    );
    return o;
}
paramKeys.forEach( ([k]) => {
    const input = document.getElementById("param_" + k);
    const span = document.getElementById("val_" + k);
    if (input && span) {
        input.addEventListener("input", () => {
            const v = input.value;
            span.textContent = ("" + v).includes(".") ? Number(v).toFixed(2) : v;
            markDirty();
        }
        );
    }
}
);

/* ---------- Boot ---------- */
window.addEventListener("DOMContentLoaded", boot);
let dragBound = false;
function boot() {
    const q = new URLSearchParams(location.hash.replace(/^#\??/, ''));

    // Client ID（表示専用）
    if (els.clientId) {
        els.clientId.value = (q.get("client") || "").toUpperCase();
        els.clientId.readOnly = true;
    }

    // Behavior（表示専用）
    const beh = (q.get("behavior") || "BASE").toUpperCase();
    const behLabel = document.getElementById("behaviorLabel");
    if (behLabel) behLabel.textContent = beh;

    // API Base（表示専用）
    if (els.apiBase) {
        els.apiBase.value = q.get("api") || DEV_API;
        els.apiBase.readOnly = true;
    }

    // Search を非表示
    if (els.search) {
        els.search.style.display = "none";
    }

    // 左側リスト描画（内部で ensurePromptIndex が呼ばれる）
    renderFileList();

    // Ctrl+S 保存ショートカット
    window.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
            e.preventDefault();
            saveCurrent();
        }
    });

    // 本文 dirty 管理
    els.promptEditor?.addEventListener("input", markDirty);

    // 追加ボタン
    if (els.btnAdd) {
        els.btnAdd.removeEventListener("click", onClickAdd);
        els.btnAdd.addEventListener("click", onClickAdd);
    }

    // -------------------------------------------------
    // ★ prompt-index.json から clientName を読み込んでセット
    // -------------------------------------------------
    (async () => {
        try {
            const clid = (els.clientId?.value || "").trim().toUpperCase();
            if (!clid) return;

            const behavior = behLabel?.textContent || "BASE";

            // bootstrap=false → index が無ければ作らない
            const idx = await ensurePromptIndex(clid, behavior, false);
            const clientName = idx?.name || "";

            const clientNameEl = document.getElementById("clientName");
            if (clientNameEl) {
                clientNameEl.value = clientName;
                clientNameEl.readOnly = true;  // ★ 編集不可
            }
        } catch (err) {
            console.error("ClientName load error:", err);
        }
    })();

    // ★★ clientName の編集イベントは削除（保存されないようにする） ★★
}


function markDirty() {
    dirty = true;
}
function clearDirty() {
    dirty = false;
}
window.addEventListener("beforeunload", (e) => {
    if (!dirty)
        return;
    e.preventDefault();
    e.returnValue = "";
}
);

/* ---------- File List ---------- */
function templateFromFilename(filename, behavior) {
    if (behavior === "TYPE-R")
        return filename.replace(/^texel-/, "texel-r-");
    if (behavior === "TYPE-S")
        return filename.replace(/^texel-/, "texel-s-");
    return filename;
}


/* ===== Directory listing (for bootstrap + auto include custom prompts) =====
   Uses backend ListBLOB if available.
   Expected: ListBLOB returns either:
   - { prompt:[{name:"client/A001/texel-....json", ...}, ...] }
   - { files:[...names...] } or { items:[...] } or { blobs:[...] }
   We treat "directory truth" as authoritative for which JSON files exist.
*/
async function apiListClientPromptFiles(clientId) {
    const clid = String(clientId || "").trim().toUpperCase();
    if (!clid) return [];
    const container = "prompts";
    const folder1 = `client/${clid}`;       // folder param style
    const prefix1 = `client/${clid}/`;      // prefix param style

    const candidates = [
        // GET patterns
        { method: "GET", name: "ListBLOB", qs: { container, folder: folder1 } },
        { method: "GET", name: "ListBLOB", qs: { container, prefix: prefix1 } },
        { method: "GET", name: "ListBLOB", qs: { folder: folder1 } },
        { method: "GET", name: "ListBLOB", qs: { prefix: prefix1 } },
        // POST patterns
        { method: "POST", name: "ListBLOB", body: { container, folder: folder1 } },
        { method: "POST", name: "ListBLOB", body: { container, prefix: prefix1 } },
        { method: "POST", name: "ListBLOB", body: { folder: folder1 } },
        { method: "POST", name: "ListBLOB", body: { prefix: prefix1 } },
    ];

    for (const c of candidates) {
        try {
            const url = join(els.apiBase.value, c.name);
            let res;
            if (c.method === "GET") {
                const qs = new URLSearchParams();
                for (const [k,v] of Object.entries(c.qs||{})) {
                    if (v != null && v !== "") qs.set(k, v);
                }
                res = await fetch(url + "?" + qs.toString(), { cache: "no-store" });
            } else {
                res = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(c.body || {})
                });
            }
            if (!res.ok) continue;

            const j = await res.json().catch(() => ({}));
            const names = normalizeListNames(j);

            // strip folder/prefix and keep only filenames under client/<ID>/
            const out = [];
            for (const name of names) {
                if (!name) continue;
                const n = String(name);
                // we want only within client/<ID>/
                let rel = null;
                if (n.startsWith(prefix1)) rel = n.slice(prefix1.length);
                else if (n.startsWith(folder1 + "/")) rel = n.slice((folder1 + "/").length);
                else if (!n.includes("/")) rel = n; // already relative
                else continue;

                if (!rel.toLowerCase().endsWith(".json")) continue;
                if (rel === "prompt-index.json") continue;
                out.push(rel);
            }

            // de-dup
            return [...new Set(out)];
        } catch {
            // try next
        }
    }
    return [];
}

function normalizeListNames(j) {
    // common shapes
    const pools = [];
    if (Array.isArray(j)) pools.push(j);
    if (Array.isArray(j?.prompt)) pools.push(j.prompt);
    if (Array.isArray(j?.files)) pools.push(j.files);
    if (Array.isArray(j?.items)) pools.push(j.items);
    if (Array.isArray(j?.blobs)) pools.push(j.blobs);
    if (Array.isArray(j?.data?.prompt)) pools.push(j.data.prompt);
    if (Array.isArray(j?.data?.files)) pools.push(j.data.files);
    if (Array.isArray(j?.data?.items)) pools.push(j.data.items);
    if (Array.isArray(j?.data?.blobs)) pools.push(j.data.blobs);

    const names = [];
    for (const arr of pools) {
        for (const x of arr) {
            if (!x) continue;
            if (typeof x === "string") { names.push(x); continue; }
            if (typeof x?.name === "string") { names.push(x.name); continue; }
            if (typeof x?.filename === "string") { names.push(x.filename); continue; }
            if (typeof x?.path === "string") { names.push(x.path); continue; }
        }
    }
    return names;
}


async function tryLoad(filename) {
    const clid = (els.clientId?.value || "").trim().toUpperCase();
    const beh = document.getElementById("behaviorLabel").textContent;

    const candidates = [];
    if (typeof filename === "string" && !filename.includes("/")) {
        candidates.push(`client/${clid}/${filename}`);
        candidates.push(`prompt/${clid}/${filename}`);
        candidates.push(templateFromFilename(filename, beh));
    } else {
        candidates.push(filename);
    }
    for (const f of candidates) {
        const url = join(els.apiBase.value, "LoadPromptText") + `?filename=${encodeURIComponent(f)}`;
        const res = await fetch(url, { cache: "no-store" }).catch(() => null);
        if (!res) continue;

        // 404 を「ファイル未存在」と「関数/経路不整合」に切り分ける
        if (!res.ok) {
            if (res.status === 404) {
                const ct = (res.headers.get("content-type") || "").toLowerCase();
                let bodyText = "";
                try { bodyText = await res.text(); } catch { bodyText = ""; }

                // JSONエラー（= 関数は生きていて blob が無い）の場合のみ「missingFile」として返す
                if (ct.includes("application/json")) {
                    try {
                        const j = bodyText ? JSON.parse(bodyText) : {};
                        return { status: 404, missingFile: true, data: j, etag: null, used: f };
                    } catch {
                        return { status: 404, missingFile: true, data: {}, etag: null, used: f };
                    }
                }
                // HTML等（= 関数名/ベースURLが違う可能性）→ missingFile扱いしない
                return { status: 404, missingFile: false, data: {}, etag: null, used: f };
            }
            continue;
        }

        const etag = res.headers.get("etag") || null;
        let data = {};
        try { data = await res.json(); } catch { data = {}; }
        return { status: 200, data, etag, used: f };
    }
    return null;
}

async function renderFileList() {
    if (!els.fileList)
        return;
    els.fileList.innerHTML = "";
    const clid = (els.clientId?.value || "").trim().toUpperCase();
    const beh = document.getElementById("behaviorLabel").textContent;

    await ensurePromptIndex(clid, beh, true);

    const ROOM = KIND_TO_NAME["roomphoto"];

    const rows = [...(promptIndex.items || [])]
        .filter(it => !it.hidden)
        .sort((a, b) => {
            if (a.file === ROOM) return -1;
            if (b.file === ROOM) return 1;
            return (a.order ?? 0) - (b.order ?? 0);
        });

    rows.forEach(it => {
        if (it.file === ROOM && !it.lock) {
            it.lock = true;      // 既存 index でも強制的に lock を立てる
        }
    });

    // drag handlers once
    if (!dragBound) {
        dragBound = true;

        // ============================
        // ★ dragover で「Roomphoto の上に入る」操作を禁止
        // ============================
        els.fileList.addEventListener('dragover', (e) => {
            e.preventDefault();

            const dragging = document.querySelector('.fileitem.dragging');
            if (!dragging) return;

            const ROOM = KIND_TO_NAME["roomphoto"];

            // Roomphoto のDOM要素を取得
            const roomEl = [...els.fileList.children].find(x => x.dataset.file === ROOM);
            if (!roomEl) return;

            const roomBox = roomEl.getBoundingClientRect();

            // ★ もしカーソル位置が roomphoto より上なら → いれない
            if (e.clientY < roomBox.bottom) {
                return; // ← ここで placement を拒否
            }

            // 通常のドラッグ処理
            const after = getDragAfterElement(els.fileList, e.clientY);
            if (!after) {
                els.fileList.appendChild(dragging);
            } else {
                els.fileList.insertBefore(dragging, after);
            }
        });


        // ============================
        // drop 時の処理（順番再計算）
        // ============================
        els.fileList.addEventListener('drop', async () => {
            const lis = [...els.fileList.querySelectorAll('.fileitem')];

            lis.forEach((el, i) => {
                const f = el.dataset.file;
                const it2 = promptIndex.items.find(x => x.file === f);
                if (!it2) return;

                // 一旦ドラッグ後の順番で 10,20,30... を付ける
                it2.order = (i + 1) * 10;
            });

            // ★ 最後に Roomphoto の順番を order=1 に強制固定
            fixRoomphotoOrder();

            await saveIndex();
        });
    }

    for (const it of rows) {
    const name = it.name || prettifyNameFromFile(it.file);
    const isRoom = (it.file === ROOM);
    if (isRoom && !it.lock) it.lock = true;     // 念のためここでも lock を保証
    const locked = !!it.lock;

    const li = document.createElement("div");
    li.className = "fileitem" + (locked ? " locked" : "");
    li.dataset.file = it.file;
    li.draggable = !locked;

    if (locked) {
        li.draggable = false;
        li.setAttribute("draggable", "false");
    }

    const icon = locked
        ? `<span class="lock-icon" title="固定プロンプト">🔒</span>`
        : "";   // ロックしていなければ何も表示しない

    li.innerHTML = `
        <span class="drag">≡</span>
        <div class="name">
            ${icon}
            <input type="text"
                  class="name-input"
                  value="${name}"
                  title="${it.file}">
        </div>
        <div class="meta">
            ${locked ? "" : '<button class="delete" title="一覧から削除">🗑</button>'}
        </div>`;
    els.fileList.appendChild(li);


        // --- dragstart / dragend（ロック項目は一切動かないようにする） ---
        if (!locked) {

            // 通常アイテムのみ dragstart を許可
            li.addEventListener('dragstart', () => {
                li.classList.add('dragging');
            });

            li.addEventListener('dragend', async () => {
                li.classList.remove('dragging');

                const ROOM = KIND_TO_NAME["roomphoto"];
                const lis = [...els.fileList.querySelectorAll('.fileitem')];

                lis.forEach((el, i) => {
                    const f = el.dataset.file;
                    const it2 = promptIndex.items.find(x => x.file === f);
                    if (!it2) return;

                    // ★ roomphoto（lock=true）は絶対に順番変更しない（order=1固定）
                    if (it2.lock || f === ROOM) {
                        it2.order = 1;  // 先頭固定
                        return;
                    }

                    // ★ その他は 2番目以降として order を再計算
                    it2.order = i + 2;
                });

                fixRoomphotoOrder();
                await saveIndex();
            });

        } else {

            // ★ ロック項目（roomphoto）は dragstart そのものを禁止する
            li.addEventListener("dragstart", (e) => {
                e.preventDefault();
                e.stopImmediatePropagation();
                return false;
            });
            li.setAttribute("draggable", "false");
        }


        li.addEventListener("click", async (e) => {
            if (e.target.closest("button") || e.target.closest("input"))
                return; // ボタンと名前入力中は open しない
            await openByFilename(it.file);
        });

        const input = li.querySelector(".name-input");

        // ★ roomphoto でも名前変更は許可するので常に blur を登録
        input.addEventListener("blur", async (e) => {
            const nv = (e.target.value || "").trim();
            if (!nv || nv === name) return;
            try {
                setStatus('名称を変更中…', 'orange');
                await renameIndexItem(it.file, nv);
                setStatus('名称を変更しました。', 'green');
                await reloadIndex();
                await renderFileList();
            } catch (err) {
                console.error(err);
                setStatus('名称変更に失敗: ' + (err?.message || err), 'red');
                await reloadIndex();
                await renderFileList();
            }
        });

        // Enter → blur
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                input.blur();
            }
        });

        // ★ 削除ボタンは「locked=false のときだけ」付ける
        if (!locked) {
            li.querySelector(".delete")?.addEventListener("click", async (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!confirm(`「${name}」を一覧から削除します。ファイル自体は削除されません。よろしいですか？`))
                    return;
                await deleteIndexItem(it.file);
                await reloadIndex();
                await renderFileList();
            });
        }
    }
}

function getDragAfterElement(container, y) {
    const els2 = [...container.querySelectorAll('.fileitem:not(.dragging)')];
    return els2.reduce( (closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        return (offset < 0 && offset > closest.offset) ? {
            offset,
            element: child
        } : closest;
    }
    , {
        offset: Number.NEGATIVE_INFINITY
    }).element;
}

/* ---------- Open / Save ---------- */
async function openByFilename(filename) {
    if (dirty && !confirm("未保存の変更があります。破棄して読み込みますか？"))
        return;

    els.diffPanel && (els.diffPanel.hidden = true);
    [...(els.fileList?.children || [])].forEach(n => n.classList.toggle("active", n.dataset.file === filename));
    setStatus("読込中…", "orange");

    const clid = (els.clientId?.value || "").trim().toUpperCase();
    const beh = document.getElementById("behaviorLabel").textContent;

    const clientTarget = `client/${clid}/${filename}`;
    const titleEl = document.getElementById("fileTitle");
    if (titleEl)
        titleEl.textContent = clientTarget;

    const candidates = [clientTarget, `prompt/${clid}/${filename}`, templateFromFilename(filename, beh)];

    let loaded = null
      , used = null;
    for (const f of candidates) {
        const r = await tryLoad(f);
        if (r) {
            loaded = r;
            used = f;
            break;
        }
    }
    const templ = await tryLoad(templateFromFilename(filename, beh));
    templateText = templ ? JSON.stringify(templ.data, null, 2) : "";

    if (!loaded) {
        currentEtag = null;
        currentLoadShape = "flat";
        if (els.promptEditor)
            els.promptEditor.value = "";
        writeParamUI({});
        setBadges("Missing（新規）", null);
        setStatus("新規作成できます。右上の保存で client 配下に作成します。");
        clearDirty();
        return;
    }

    const norm = normalizePromptDoc(loaded.data || {});
    currentLoadShape = norm.shape;
    if (els.promptEditor)
        els.promptEditor.value = norm.prompt || "";
    writeParamUI(norm.params || {});

    currentEtag = (used.startsWith("client/") || used.startsWith("prompt/")) ? loaded.etag : null;

    if (used.startsWith("client/"))
        setBadges("Overridden", currentEtag, "ok");
    else if (used.startsWith("prompt/"))
        setBadges("Overridden (legacy)", currentEtag, "ok");
    else
        setBadges("Template（未上書き）", loaded.etag || "—", "info");

    setStatus("読み込み完了", "green");
    clearDirty();
}

els.btnSave?.addEventListener("click", saveCurrent);
async function saveCurrent() {
    const title = document.getElementById("fileTitle")?.textContent || "";
    if (!title || title === "未選択")
        return;

    const filename = title;
    // already "client/<id>/<file>.json" by openByFilename
    const newPrompt = els.promptEditor?.value ?? "";
    const newParams = readParamUI();
    setStatus("保存中…", "orange");

    try {
        // Load current to preserve unknown fields and shape
        let baseDoc = null;
        const cur = await tryLoad(filename);
        if (cur && cur.data)
            baseDoc = cur.data;

        // If nothing exists yet, still respect the last loaded shape (flat default)
        const payload = patchPromptDoc(baseDoc, newPrompt, newParams);
        const payloadFlat = toFlat(payload);

        const res = await apiSaveText(filename, payloadFlat, currentEtag || undefined);
        currentEtag = res?.etag || currentEtag || null;
        setBadges("Overridden", currentEtag, "ok");
        setStatus("保存完了", "green");
        clearDirty();
    } catch (e) {
        setStatus("保存失敗: " + (e.message || e), "red");
        if (String(e).includes("412"))
            alert("他の人が更新しました。再読み込みしてから保存してください。");
    }
}

/* ---------- Diff ---------- */
els.btnDiff?.addEventListener("click", () => {
    if (els.diffLeft)
        els.diffLeft.value = templateText || "(テンプレートなし)";
    if (els.diffRight)
        els.diffRight.value = els.promptEditor?.value || "";
    if (els.diffPanel)
        els.diffPanel.hidden = !els.diffPanel.hidden;
}
);

/* ---------- Utils ---------- */
function setStatus(msg, color="#0AA0A6") {
    if (els.status) {
        els.status.style.color = color;
        els.status.textContent = msg;
    }
}
function setBadges(stateText, etag, mode) {
    if (els.badgeState) {
        els.badgeState.textContent = stateText;
        els.badgeState.className = "chip " + (mode || "");
    }
    if (els.badgeEtag) {
        els.badgeEtag.textContent = etag || "—";
    }
}

/* ===== Add Button handler (asks name, creates blob, appends to index, updates UI) ===== */
async function onClickAdd() {
    try {
        const clid = (els.clientId?.value || "").trim().toUpperCase();
        const beh = document.getElementById("behaviorLabel").textContent;
        if (!clid) {
            alert("Client ID が未設定です。左上で選択してください。");
            return;
        }
        await ensurePromptIndex(clid, beh, true);

        const dname = prompt("新しいプロンプトの名称を入力してください", "新規プロンプト");
        if (dname === null)
            return;

        let file = generateAutoFilename();
        const existing = new Set((promptIndex.items || []).map(x => x.file));
        let salt = 0;
        while (existing.has(file)) {
            salt++;
            file = file.replace(/\.json$/, `-${salt}.json`);
        }

        const clientPath = `client/${clid}/${file}`;
        await apiSaveText(clientPath, {
            prompt: "",
            params: {}
        }, null);

        await addIndexItemRaw(file, dname);
        await reloadIndex();
        await renderFileList();
        await openByFilename(file);
        setStatus("新しいプロンプトを追加しました。", "green");
    } catch (e) {
        alert("追加に失敗: " + (e?.message || e));
        console.error(e);
    }
}

/* ===== Optional Safe Wrapper (kept for compatibility) ===== */
(function() {
    function $q(sel) {
        return document.querySelector(sel);
    }
    function bind() {
        const btn = $q('#btnAdd, [data-role="btn-add"]');
        if (btn)
            btn.removeEventListener('click', onClickAdd),
            btn.addEventListener('click', onClickAdd);
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }
}
)();

;(function() {
    try {
        const ver = window.__APP_BUILD__ || document.body?.dataset?.build || "(none)";
        console.log("%cPrompt Studio build:", "font-weight:bold", ver);
        const badge = document.getElementById("buildBadge");
        if (badge)
            badge.textContent = ver;
    } catch (e) {}
}
)();

function fixRoomphotoOrder() {
    const ROOM = KIND_TO_NAME["roomphoto"];
    if (!promptIndex || !Array.isArray(promptIndex.items)) return;

    // roomphoto を order=1 に固定
    const rp = promptIndex.items.find(x => x.file === ROOM);
    if (rp) rp.order = 1;

    // その他を 2,3,4... と並べる
    let n = 2;
    promptIndex.items
        .filter(x => x.file !== ROOM)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .forEach(x => x.order = n++);
}
