/* ================== Prompt Studio core ================== */
// 既存のAPIエンドポイント（ClientEditorと同じ値を使ってOK）
const DEV_API  = "https://func-texel-api-dev-jpe-001-b2f6fec8fzcbdrc3.japaneast-01.azurewebsites.net/api/";
const PROD_API = "https://func-texel-api-prod-jpe-001-dsgfhtafbfbxawdz.japaneast-01.azurewebsites.net/api/";

// 対象kind → ファイル共通名
const KIND_TO_NAME = {
  "suumo-catch":   "texel-suumo-catch.json",
  "suumo-comment": "texel-suumo-comment.json",
  "roomphoto":     "texel-roomphoto.json",
  "suggestion":    "texel-suggestion.json",
  "athome-appeal": "texel-athome-appeal.json",
  "athome-comment":"texel-athome-comment.json",
};

// 行動別テンプレ可用性
const FAMILY = {
  "BASE":  new Set(["suumo-catch","suumo-comment","roomphoto","suggestion","athome-appeal","athome-comment"]),
  "TYPE-R":new Set(["suumo-catch","suumo-comment","roomphoto","suggestion","athome-appeal","athome-comment"]),
  "TYPE-S":new Set(["suumo-catch","suumo-comment","roomphoto","suggestion"]),
};

// UI refs
const els = {
  clientId:  document.getElementById("clientId"),
  behavior:  document.getElementById("behavior"),
  apiBase:   document.getElementById("apiBase"),
  fileList:  document.getElementById("fileList"),
  fileTitle: document.getElementById("fileTitle"),
  badgeState:document.getElementById("badgeState"),
  badgeEtag: document.getElementById("badgeEtag"),
  status:    document.getElementById("status"),
  btnSave:   document.getElementById("btnSave"),
  btnFormat: document.getElementById("btnFormat"),
  btnValidate:document.getElementById("btnValidate"),
  btnDiff:   document.getElementById("btnDiff"),
  search:    document.getElementById("search"),
  editorHost:document.getElementById("editorHost"),
  diffHost:  document.getElementById("diffHost"),
};

let editor = null;
let diffEditor = null;
let currentKind = null;
let currentFilename = null;
let currentEtag = null;
let currentTemplateText = ""; // diff用
let currentClientText = "";   // editor原本

// Monaco 初期化
require(['vs/editor/editor.main'], function () {
  editor = monaco.editor.create(els.editorHost, {
    value: "",
    language: "json",
    theme: "vs-dark",
    automaticLayout: true,
    fontLigatures: true,
    fontSize: 14,
    minimap: { enabled: false }
  });
  diffEditor = monaco.editor.createDiffEditor(els.diffHost, {
    theme: "vs-dark",
    automaticLayout: true,
    renderOverviewRuler: false,
    readOnly: true,
    originalEditable: false
  });

  // ショートカット
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveCurrent());
  // 起動
  boot();
});

function boot(){
  // クエリ（client, behavior, apiBase, kind）から初期化
  const q = new URLSearchParams(location.hash.replace(/^#\??/,'') || location.search.replace(/^\?/,''));
  els.clientId.value = (q.get("client") || "").toUpperCase();
  els.behavior.value = (q.get("behavior") || "BASE").toUpperCase();
  els.apiBase.value  = q.get("api") || DEV_API;
  // ファイル一覧描画
  renderFileList();
  // 初期kind指定があれば開く
  const initKind = q.get("kind");
  if (initKind && KIND_TO_NAME[initKind]) openKind(initKind);
}

// ファイル一覧（ステータス付き）
async function renderFileList(){
  els.fileList.innerHTML = "";
  const clid = els.clientId.value.trim().toUpperCase();
  const beh  = els.behavior.value.toUpperCase();

  const kinds = Object.keys(KIND_TO_NAME).filter(k => FAMILY[beh].has(k));
  for (const kind of kinds){
    const name = KIND_TO_NAME[kind];
    const item = document.createElement("div");
    item.className = "fileitem";
    item.dataset.kind = kind;
    item.innerHTML = `
      <div class="name">${name}</div>
      <div class="meta">
        <span class="chip info" data-role="state">checking…</span>
      </div>`;
    els.fileList.appendChild(item);

    // 状態判定（client → legacy → template）
    const clientPath = `client/${clid}/${name}`;
    const legacyPath = `prompt/${clid}/${name}`;
    const templatePath = behaviorTemplatePath(beh, kind);

    const st = await resolveState([clientPath, legacyPath], templatePath);
    const chip = item.querySelector('[data-role="state"]');
    if (st === "client") { chip.textContent = "Overridden"; chip.classList.add("ok"); }
    else if (st === "legacy") { chip.textContent = "Overridden (legacy)"; chip.classList.add("ok"); }
    else if (st === "template") { chip.textContent = "Template"; chip.classList.add("info"); }
    else { chip.textContent = "Missing"; chip.classList.add("warn"); }

    item.addEventListener("click", ()=> openKind(kind));
  }

  // 検索
  els.search.oninput = () => {
    const q = els.search.value.toLowerCase();
    [...els.fileList.children].forEach(c=>{
      const text = c.querySelector('.name').textContent.toLowerCase();
      c.style.display = text.includes(q) ? "" : "none";
    });
  };
}

function behaviorTemplatePath(beh, kind){
  const base = KIND_TO_NAME[kind];
  if (beh === "TYPE-R") return base.replace("texel-", "texel-r-");
  if (beh === "TYPE-S") return base.replace("texel-", "texel-s-");
  return base; // BASE
}

// 存在チェック兼ロード（順に試す）
async function tryLoad(filename){
  const url = join(els.apiBase.value, "LoadPromptText") + `?filename=${encodeURIComponent(filename)}`;
  const res = await fetch(url, { cache:"no-store" });
  if (!res.ok) return null;
  const etag = res.headers.get("etag") || (await res.clone().text() && null);
  let json = {};
  try { json = await res.json(); } catch {}
  return { json, etag };
}

async function resolveState(clientCandidates, templatePath){
  for (const c of clientCandidates){
    const got = await tryLoad(c);
    if (got) return c.includes("prompt/") ? "legacy" : "client";
  }
  if (await tryLoad(templatePath)) return "template";
  return "missing";
}

async function openKind(kind){
  currentKind = kind;
  els.fileTitle.textContent = KIND_TO_NAME[kind];
  [...els.fileList.children].forEach(n=>n.classList.toggle("active", n.dataset.kind===kind));
  els.status.textContent = "loading…"; els.diffHost.hidden = true; els.editorHost.hidden = false;

  const clid = els.clientId.value.trim().toUpperCase();
  const beh  = els.behavior.value.toUpperCase();

  const name = KIND_TO_NAME[kind];
  const candidates = [
    `client/${clid}/${name}`,
    `prompt/${clid}/${name}`, // legacy fallback
    behaviorTemplatePath(beh, kind),
  ];

  let loaded = null, usedPath = null;
  for (const f of candidates){
    const got = await tryLoad(f);
    if (got){ loaded = got; usedPath = f; break; }
  }

  // diff用にテンプレも保持
  const templ = await tryLoad(behaviorTemplatePath(beh, kind));
  currentTemplateText = templ ? JSON.stringify(templ.json, null, 2) : "";

  if (!loaded){
    // 何もない → 新規
    currentFilename = `client/${clid}/${name}`;
    currentEtag = null;
    currentClientText = JSON.stringify({ prompt:"", params:{} }, null, 2);
    editor.setValue(currentClientText);
    setBadges("Missing（新規）", null);
    els.status.textContent = "new file";
    return;
  }

  currentFilename = usedPath.includes("prompt/") ? `client/${clid}/${name}` : usedPath; // legacyを開いた場合は保存先をclientに寄せる
  currentEtag = loaded.etag || null;
  currentClientText = JSON.stringify(loaded.json, null, 2);
  editor.setValue(currentClientText);

  // バッジ
  if (usedPath.startsWith("client/")) setBadges("Overridden", currentEtag, "ok");
  else if (usedPath.startsWith("prompt/")) setBadges("Overridden (legacy)", currentEtag, "ok");
  else setBadges("Template（未上書き）", currentEtag, "info");

  els.status.textContent = "loaded";
}

function setBadges(stateText, etag, mode){
  els.badgeState.textContent = stateText;
  els.badgeState.className = "chip " + (mode||"");
  els.badgeEtag.textContent = `ETag: ${etag || "—"}`;
}

// 保存
async function saveCurrent(){
  if (!currentFilename) return;
  els.status.textContent = "saving…";

  let text = editor.getValue();
  try { JSON.parse(text); }
  catch(e){ els.status.textContent = "JSONエラー: " + e.message; flashDanger(); return; }

  const body = {
    filename: currentFilename,
    // SavePromptText: { prompt, params } 形式で保存する前提
    ...splitPromptAndParams(JSON.parse(text)),
    etag: currentEtag || undefined
  };

  const url = join(els.apiBase.value, "SavePromptText");
  const res = await fetch(url, {
    method:"POST",
    headers:{ "Content-Type":"application/json; charset=utf-8" },
    body: JSON.stringify(body)
  });

  const raw = await res.text();
  let json = {}; try { json = raw ? JSON.parse(raw) : {}; } catch {}

  if (!res.ok){
    const msg = json?.error || raw || `HTTP ${res.status}`;
    els.status.textContent = "保存失敗: " + msg;
    flashDanger();
    if (res.status === 412) { // 競合 → 最新を取得してdiff表示を促す
      await openKind(currentKind);
      showDiff();
    }
    return;
  }

  currentEtag = json?.etag || currentEtag;
  setBadges("Overridden", currentEtag, "ok");
  els.status.textContent = "保存完了";
}

function splitPromptAndParams(obj){
  // {prompt, params} 以外で来た場合も吸収
  if ("prompt" in obj || "params" in obj) {
    return { prompt: obj.prompt ?? "", params: obj.params ?? {} };
  }
  // それ以外は丸ごとpromptとして保存
  return { prompt: obj, params: {} };
}

function flashDanger(){
  els.status.style.color = "#ff9b9b";
  clearTimeout(flashDanger._t);
  flashDanger._t = setTimeout(()=>{ els.status.style.color=""; }, 1400);
}

// 整形
els.btnFormat.onclick = ()=>{
  try{
    const obj = JSON.parse(editor.getValue());
    editor.setValue(JSON.stringify(obj, null, 2));
    els.status.textContent = "整形しました";
  }catch(e){ els.status.textContent = "JSONエラー: " + e.message; flashDanger(); }
};

// 検証
els.btnValidate.onclick = ()=>{
  try{
    const obj = JSON.parse(editor.getValue());
    if (!("prompt" in obj)) { els.status.textContent = "warning: `prompt` がありません（保存は可能）"; return; }
    els.status.textContent = "OK";
  }catch(e){ els.status.textContent = "JSONエラー: " + e.message; flashDanger(); }
};

// 差分
els.btnDiff.onclick = ()=> showDiff();
function showDiff(){
  els.diffHost.hidden = false;
  els.editorHost.hidden = true;
  const modified = editor.getValue();
  const original = currentTemplateText || "{}";
  diffEditor.setModel({
    original: monaco.editor.createModel(original, "json"),
    modified: monaco.editor.createModel(modified, "json")
  });
  els.status.textContent = "テンプレートとの差分表示中（戻るにはもう一度 [差分] を押す）";
  // トグル
  els.btnDiff.onclick = ()=>{
    els.diffHost.hidden = true; els.editorHost.hidden = false;
    els.btnDiff.onclick = ()=> showDiff();
  };
}

// ユーティリティ
function join(base, path){
  return (base||"").replace(/\/+$/,"") + "/" + String(path||"").replace(/^\/+/,"");
}
