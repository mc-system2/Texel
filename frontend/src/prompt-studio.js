/* ============== Prompt Studio – prompt-editor 融合UI ============== */
const DEV_API  = "https://func-texel-api-dev-jpe-001-b2f6fec8fzcbdrc3.japaneast-01.azurewebsites.net/api/";
const PROD_API = "https://func-texel-api-prod-jpe-001-dsgfhtafbfbxawdz.japaneast-01.azurewebsites.net/api/";

/* 種別 → 共通ファイル名（Client側は client/<CLID>/<name> になる） */
const KIND_TO_NAME = {
  "suumo-catch":   "texel-suumo-catch.json",
  "suumo-comment": "texel-suumo-comment.json",
  "roomphoto":     "texel-roomphoto.json",
  "suggestion":    "texel-suggestion.json",
  "athome-appeal": "texel-athome-appeal.json",
  "athome-comment":"texel-athome-comment.json",
};
/* 行動別で扱うファイル集合（テンプレ可用性） */
const FAMILY = {
  "BASE":   new Set(["suumo-catch","suumo-comment","roomphoto","suggestion","athome-appeal","athome-comment"]),
  "TYPE-R": new Set(["suumo-catch","suumo-comment","roomphoto","suggestion","athome-appeal","athome-comment"]),
  "TYPE-S": new Set(["suumo-catch","suumo-comment","roomphoto","suggestion"]),
};

/* UI refs */
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

  btnCreate: document.getElementById("btnCreateFromTemplate"),
  btnSave:   document.getElementById("btnSave"),
  btnDiff:   document.getElementById("btnDiff"),

  diffPanel: document.getElementById("diffPanel"),
  diffLeft:  document.getElementById("diffLeft"),
  diffRight: document.getElementById("diffRight"),

  status:    document.getElementById("statusMessage"),
};

let currentKind = null;
let currentFilenameTarget = null; // いつでも client/<CLID>/<name> を指す
let currentEtag = null;           // client/ を開いた時のみ反映
let templateText = "";            // diff用
let loadedText = "";              // 右ペイン現在値（編集テキスト）
let loadedParams = {};            // スライダー値
let dirty = false;

/* ==== タブ切替（prompt-editor準拠） ==== */
function showTab(which){
  if (which==="prompt"){
    els.tabPromptBtn.classList.add("active"); els.tabParamsBtn.classList.remove("active");
    els.promptTab.classList.add("active");    els.paramsTab.classList.remove("active");
  }else{
    els.tabPromptBtn.classList.remove("active"); els.tabParamsBtn.classList.add("active");
    els.promptTab.classList.remove("active");    els.paramsTab.classList.add("active");
  }
}
els.tabPromptBtn.addEventListener("click", ()=>showTab("prompt"));
els.tabParamsBtn.addEventListener("click", ()=>showTab("params"));

/* ==== Param スライダー（prompt-editor と同じキーバリエーション） ==== */
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
    if (input && span){
      input.value = (params && params[k] !== undefined) ? params[k] : def;
      span.textContent = (""+input.value).includes(".") ? Number(input.value).toFixed(2) : input.value;
    }
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
      span.textContent = (""+input.value).includes(".") ? Number(input.value).toFixed(2) : input.value;
      markDirty();
    });
  }
});

/* ==== 起動 ==== */
window.addEventListener("DOMContentLoaded", boot);
function boot(){
  // クエリ/ハッシュから初期化（ClientEditor から渡ってくる）
  const q = new URLSearchParams(location.hash.replace(/^#\??/, ''));
  els.clientId.value = (q.get("client") || "").toUpperCase();
  els.behavior.value = (q.get("behavior") || "BASE").toUpperCase();
  els.apiBase.value  = q.get("api") || DEV_API;

  // ファイルリスト描画
  renderFileList();

  // ショートカット
  window.addEventListener("keydown", (e)=>{
    if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==="s"){ e.preventDefault(); saveCurrent(); }
  });

  // 検索
  els.search.addEventListener("input", ()=>{
    const q = els.search.value.toLowerCase();
    [...els.fileList.children].forEach(it=>{
      const t = it.querySelector(".name").textContent.toLowerCase();
      it.style.display = t.includes(q) ? "" : "none";
    });
  });

  // 入力変更で dirty
  els.promptEditor.addEventListener("input", markDirty);
}
function markDirty(){ dirty = true; }
function clearDirty(){ dirty = false; }
window.addEventListener("beforeunload", (e)=>{ if (!dirty) return; e.preventDefault(); e.returnValue=""; });

/* ==== ファイルリスト ==== */
async function renderFileList(){
  els.fileList.innerHTML = "";
  const clid = els.clientId.value.trim().toUpperCase();
  const beh  = els.behavior.value.toUpperCase();

  const kinds = Object.keys(KIND_TO_NAME).filter(k=>FAMILY[beh].has(k));
  for (const kind of kinds){
    const name = KIND_TO_NAME[kind];

    const li = document.createElement("div");
    li.className = "fileitem";
    li.dataset.kind = kind;
    li.innerHTML = `
      <div class="name">${name}</div>
      <div class="meta"><span class="chip">checking…</span></div>
    `;
    els.fileList.appendChild(li);

    // 状態 (client → legacy → template)
    const clientPath = `client/${clid}/${name}`;
    const legacyPath = `prompt/${clid}/${name}`;
    const template   = behaviorTemplatePath(beh, kind);

    const state = await resolveState([clientPath, legacyPath], template);
    const chip  = li.querySelector(".chip");
    if (state === "client") { chip.textContent = "Overridden"; chip.classList.add("ok"); }
    else if (state === "legacy"){ chip.textContent = "Overridden (legacy)"; chip.classList.add("ok"); }
    else if (state === "template"){ chip.textContent = "Template"; chip.classList.add("info"); }
    else { chip.textContent = "Missing"; chip.classList.add("warn"); }

    li.addEventListener("click", ()=> openKind(kind));
  }
}

function behaviorTemplatePath(beh, kind){
  const base = KIND_TO_NAME[kind];
  if (beh === "TYPE-R") return base.replace("texel-", "texel-r-");
  if (beh === "TYPE-S") return base.replace("texel-", "texel-s-");
  return base;
}

/* ==== ロード・状態判定 ==== */
async function tryLoad(filename){
  const url = join(els.apiBase.value, "LoadPromptText") + `?filename=${encodeURIComponent(filename)}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;
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

async function openKind(kind){
  if (dirty && !confirm("未保存の変更があります。破棄して読み込みますか？")) return;

  currentKind = kind;
  els.diffPanel.hidden = true;
  els.fileTitle.textContent = KIND_TO_NAME[kind];
  [...els.fileList.children].forEach(n=>n.classList.toggle("active", n.dataset.kind===kind));
  setStatus("読込中…","orange");

  const clid = els.clientId.value.trim().toUpperCase();
  const beh  = els.behavior.value.toUpperCase();
  const name = KIND_TO_NAME[kind];

  currentFilenameTarget = `client/${clid}/${name}`; // 保存先は常に client 配下

  // ロード候補（優先順）
  const candidates = [
    `client/${clid}/${name}`,
    `prompt/${clid}/${name}`,                // 旧
    behaviorTemplatePath(beh, kind)         // テンプレ
  ];

  let loaded = null, used = null;
  for (const f of candidates){
    const r = await tryLoad(f);
    if (r) { loaded = r; used = f; break; }
  }
  // テンプレも取得（diff用）
  const templ = await tryLoad(behaviorTemplatePath(beh, kind));
  templateText = templ ? JSON.stringify(templ.data, null, 2) : "";

  // UI反映
  if (!loaded){
    // 何も無い → 新規
    currentEtag = null;
    loadedText = ""; loadedParams = {};
    els.promptEditor.value = loadedText;
    writeParamUI(loadedParams);
    setBadges("Missing（新規）", null);
    els.btnCreate.style.display = templ ? "" : "none"; // テンプレがあれば「テンプレから新規作成」
    setStatus("新規作成できます。右上の保存を押すと client 配下に作成します。");
    clearDirty();
    return;
  }

  // { prompt, params } の形を吸収（prompt-editorと同じ判定）
  const d = loaded.data || {};
  let promptText = "";
  if (typeof d.prompt === "string") promptText = d.prompt;
  else if (d.prompt && typeof d.prompt.text === "string") promptText = d.prompt.text;
  else if (typeof d === "string") promptText = d;
  else promptText = JSON.stringify(d, null, 2);

  loadedText   = promptText;
  loadedParams = d.params || {};

  els.promptEditor.value = loadedText;
  writeParamUI(loadedParams);

  currentEtag = (used.startsWith("client/") || used.startsWith("prompt/")) ? loaded.etag : null;

  // 状態バッジ＆ボタン
  if (used.startsWith("client/")) {
    setBadges("Overridden", currentEtag, "ok");
    els.btnCreate.style.display = "none";
  } else if (used.startsWith("prompt/")) {
    setBadges("Overridden (legacy)", currentEtag, "ok");
    els.btnCreate.style.display = ""; // client/ に移行作成を許可
  } else {
    setBadges("Template（未上書き）", loaded.etag || "—", "info");
    els.btnCreate.style.display = ""; // テンプレから作成
  }

  setStatus("読み込み完了","green");
  clearDirty();
}

/* ==== Save / Create ==== */
els.btnSave.addEventListener("click", saveCurrent);
els.btnCreate.addEventListener("click", createFromTemplate);

async function saveCurrent(){
  if (!currentFilenameTarget) return;
  const prompt = els.promptEditor.value;
  const params = readParamUI();
  const body = {
    filename: currentFilenameTarget,
    prompt, params,
    etag: currentEtag || undefined
  };
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
    // 左のチップも更新したいので再描画（軽い）
    renderFileList();
  }catch(e){
    setStatus("保存失敗: " + e.message, "red");
    if (String(e).includes("412")) alert("他の人が更新しました。再読み込みしてから保存してください。");
  }
}
async function createFromTemplate(){
  // 今表示中の内容をそのまま client/ に保存（テンプレから読み込んだ直後の値でもOK）
  currentEtag = null;
  await saveCurrent();
}

/* ==== Diff（簡易） ==== */
els.btnDiff.addEventListener("click", ()=>{
  els.diffLeft.value  = templateText || "(テンプレートなし)";
  els.diffRight.value = els.promptEditor.value || "";
  els.diffPanel.hidden = !els.diffPanel.hidden;
});

/* ==== ステータス/バッジ ==== */
function setStatus(msg, color="#0AA0A6"){
  els.status.style.color = color;
  els.status.textContent = msg;
}
function setBadges(stateText, etag, mode){
  els.badgeState.textContent = stateText;
  els.badgeState.className = "chip " + (mode||"");
  els.badgeEtag.textContent = etag || "—";
  els.fileTitle.textContent = currentFilenameTarget || "—";
}

/* ==== utils ==== */
function join(base, path){ return (base||"").replace(/\/+$/,"") + "/" + String(path||"").replace(/^\/+/,""); }
