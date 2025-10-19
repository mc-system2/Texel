/* prompt-editor.js — ファイル名直指定 & 規約解決（マップ撤廃版）
   - ?file= または ?filename= で与えられたパス/ベース名をそのまま使用
   - ?type= があれば TYPE_TO_FILE なしで `${type}.json` に自動解決（規約バリデーションあり）
   - ?client= と併用時、/ を含まないベース名なら `client/<ID>/` を自動付与
   - ?api= で Functions ベースURLを上書き可（既定は DEV）
   - ETag を保持して保存時の競合検知に使用
*/

// ====== 設定 ======
const DEV_API = "https://func-texel-api-dev-jpe-001-b2f6fec8fzcbdrc3.japaneast-01.azurewebsites.net/api/";

// ====== DOM 参照（あなたの HTML に合わせて ID をそろえてください） ======
const el = {
  ta:        document.getElementById("editor"),     // <textarea id="editor">
  status:    document.getElementById("status"),     // ステータス表示
  fileLabel: document.getElementById("fileLabel"),  // 現在のファイル名表示（任意）
  btnLoad:   document.getElementById("btnLoad"),    // 「開く」ボタン（任意）
  btnSave:   document.getElementById("btnSave"),    // 「保存」ボタン
};

let API_BASE   = DEV_API;
let currentFilename = null;
let currentEtag     = null;
let dirty           = false;

// ====== 起動 ======
init().catch(err => showStatus("初期化エラー: " + err.message, "red"));

async function init(){
  const qs = new URLSearchParams(location.search);

  // API ベースの上書き（任意）
  API_BASE = (qs.get("api") || DEV_API).replace(/\/+$/,"") + "/";

  // ファイル解決
  let filename = resolveFilenameFromQuery(qs);

  // UI イベント
  el.ta?.addEventListener("input", ()=>{ dirty = true; });
  el.btnLoad?.addEventListener("click", async ()=>{
    const client = (qs.get("client") || "").trim();
    const manual = prompt("読み込むファイル名（client/.. から or ベース名のみ）を入力", currentFilename || "");
    if (!manual) return;
    const name = attachClientDirIfNeeded(manual.trim(), client);
    await openFile(name);
  });
  el.btnSave?.addEventListener("click", save);
  window.addEventListener("keydown", (e)=>{
    if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==="s"){ e.preventDefault(); save(); }
  });
  window.addEventListener("beforeunload", (e)=>{ if (!dirty) return; e.preventDefault(); e.returnValue=""; });

  // 自動ロード
  if (filename) {
    await openFile(filename);
  } else {
    showStatus("ファイル未指定です。?file= または ?type= を付けてアクセスしてください。", "#0AA0A6");
  }
}

/** クエリからファイル名を解決（file/filename 優先 → type 規約 → null） */
function resolveFilenameFromQuery(qs){
  const client = (qs.get("client") || "").trim();
  // 1) file / filename 直指定を最優先
  let file = qs.get("file") || qs.get("filename");
  if (file) return attachClientDirIfNeeded(file.trim(), client);

  // 2) 後方互換: type=xxx → `${type}.json` へ自動解決（一覧マップ不要）
  const type = (qs.get("type") || "").trim();
  if (type){
    // 許可規約: texel-(s|r)-[a-z0-9-]+ だけ通す（必要なら調整）
    if (!/^texel-(s|r)-[a-z0-9-]+$/i.test(type)) {
      showStatus(`不正な type です: ${type}`, "red");
      return null;
    }
    const name = `${type}.json`;
    return attachClientDirIfNeeded(name, client);
  }
  return null;
}

/** client= があり、file に / が含まれない（ベース名）なら client/<ID>/ を付与 */
function attachClientDirIfNeeded(file, client){
  if (!file) return file;
  if (!file.includes("/") && client) return `client/${client}/${file}`;
  return file;
}

/** ファイル名バリデーション（最低限のクライアント側ガード） */
function validateFilename(name){
  if (!name || name.startsWith("/") || name.includes("..")) return false;
  if (!/^[A-Za-z0-9/_\-.]+\.json$/.test(name)) return false; // .json 必須
  if (name.includes("//")) return false;
  return true;
}

// ====== 読み込み ======
async function openFile(filename){
  if (!validateFilename(filename)) { showStatus(`不正なファイル名です: ${filename}`, "red"); return; }
  if (dirty && !confirm("未保存の変更があります。読み込みますか？")) return;

  showStatus("読み込み中…", "orange");
  try{
    const { data, etag } = await loadPrompt(filename);
    const text = extractPromptText(data);
    if (el.ta) el.ta.value = text;
    currentFilename = filename;
    currentEtag = etag || null;
    if (el.fileLabel) el.fileLabel.textContent = filename;
    dirty = false;
    showStatus("読み込み完了", "green");
  }catch(err){
    showStatus("読み込み失敗: " + err.message, "red");
  }
}

async function loadPrompt(filename){
  const url = API_BASE + "LoadPromptText?filename=" + encodeURIComponent(filename);
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const etag = res.headers.get("etag");
  let json = {};
  try { json = await res.json(); } catch {}
  return { data: json, etag };
}

function extractPromptText(data){
  if (!data) return "";
  if (typeof data === "string") return data;
  if (typeof data.prompt === "string") return data.prompt;
  if (data.prompt && typeof data.prompt.text === "string") return data.prompt.text;
  return JSON.stringify(data, null, 2); // 想定外形式はJSONをそのまま編集
}

// ====== 保存 ======
async function save(){
  if (!currentFilename) { showStatus("保存先ファイルが未選択です。", "red"); return; }
  if (!validateFilename(currentFilename)) { showStatus("不正なファイル名です。", "red"); return; }

  const body = {
    filename: currentFilename,
    prompt: el.ta ? el.ta.value : "",
    params: {},                 // prompt-editor は params 未使用（将来用に保持）
    etag: currentEtag || undefined
  };

  showStatus("保存中…", "orange");
  try{
    const res = await fetch(API_BASE + "SavePromptText", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body)
    });
    const raw = await res.text();
    let json = {}; try { json = raw ? JSON.parse(raw) : {}; } catch {}
    if (!res.ok) throw new Error(json?.error || raw || `HTTP ${res.status}`);

    currentEtag = json?.etag || currentEtag || null;
    dirty = false;
    showStatus("保存完了", "green");
  }catch(err){
    showStatus("保存失敗: " + err.message, "red");
    if (String(err).includes("412")) alert("他の人が更新しました。再読み込みしてから保存してください。");
  }
}

// ====== UI ユーティリティ ======
function showStatus(msg, color){
  if (!el.status) return;
  el.status.textContent = msg;
  el.status.style.color = color || "#0AA0A6";
}
