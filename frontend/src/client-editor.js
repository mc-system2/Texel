/* Texel Client Editor – 静的Webアプリ
 * 依存API: LoadPromptText (GET), SavePromptText (POST)
 * BLOB構成: prompts/<CLIENT_CODE>/*, prompts/texel-client-catalog.json
 * コピー元: prompts 直下のテンプレ（例：texel-r-roomphoto.json）
 */

/* ============ 1) 環境切替（Texelと同規則） ============ */
const ENV_BASES = {
  dev : "https://func-texel-api-dev-jpe-001-b2f6fec8fzcbdrc3.japaneast-01.azurewebsites.net/api",
  prod: "https://func-texel-api-prod-jpe-001-dsgfhtafbfbxawdz.japaneast-01.azurewebsites.net/api",
};
function resolveEnv(){
  const q = new URLSearchParams(location.search).get("env");
  if (q === "dev" || q === "prod") return q;
  const h = location.host;
  if (h.includes("lively-tree-019937900.2.azurestaticapps.net")) return "dev";
  if (h.includes("lemon-beach-0ae87bc00.2.azurestaticapps.net"))  return "prod";
  try { const x = localStorage.getItem("texel_env"); if (x==="dev"||x==="prod") return x; } catch {}
  return "prod";
}
const API_BASE = () => (ENV_BASES[resolveEnv()] || ENV_BASES.prod);
document.getElementById("envLabel").textContent = resolveEnv();

/* ============ 2) パスとテンプレ一覧 ============ */
const CATALOG_BLOB = "texel-client-catalog.json";

// R/S のテンプレは prompts 直下（コピー元）
const TEMPLATE_FILES = {
  R: [
    "texel-r-roomphoto.json",
    "texel-r-suggestion.json",
    "texel-r-suumo-catch.json",
    "texel-r-suumo-comment.json",
    "texel-r-athome-appeal.json",
    "texel-r-athome-comment.json",
  ],
  S: [
    "texel-s-roomphoto.json",
    "texel-s-suggestion.json",
    "texel-s-suumo-catch.json",
    "texel-s-suumo-comment.json",
  ],
};

/* ============ 3) ユーティリティ ============ */
const $ = (id) => document.getElementById(id);
const $tbody = $("clientTbody");
const $status = $("statusMsg");
function setStatus(msg, ok=true){
  $status.textContent = msg;
  $status.style.color = ok ? "#22c55e" : "#ef4444";
  if (ok) setTimeout(()=>($status.textContent=""), 2500);
}
async function loadJSON(url){
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function postJSON(url, body){
  const r = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(await r.text());
  return r.json().catch(()=> ({}));
}
// URL or ID から Spreadsheet ID を抽出
function extractSheetId(input){
  const v = (input||"").trim();
  if (!v) return "";
  // フルURLのとき
  const m = v.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]{10,})/);
  if (m) return m[1];
  // 共有リンクの?id=形式
  const m2 = v.match(/[?&]id=([a-zA-Z0-9-_]{10,})/);
  if (m2) return m2[1];
  // それ以外はIDとみなす（ざっくり長さ・文字種チェック）
  return /^[a-zA-Z0-9-_]{10,}$/.test(v) ? v : "";
}
function sheetUrl(id){
  return `https://docs.google.com/spreadsheets/d/${id}/edit`;
}

/* ============ 4) カタログ I/O ============ */
let catalog = { version:1, updatedAt:"", clients:[] };

function normalizeCatalog(obj){
  const clients = Array.isArray(obj?.clients) ? obj.clients : [];
  return {
    version: typeof obj?.version === "number" ? obj.version : 1,
    updatedAt: new Date().toISOString(),
    clients: clients.map(x=>({
      code: String(x.code ?? "").trim(),
      name: String(x.name ?? "").trim(),
      behavior: (x.behavior === "R" || x.behavior === "S") ? x.behavior : "", // 空を許容
      spreadsheetId: extractSheetId(x.spreadsheetId || x.sheetId || ""), // 旧キー取り込み互換
      createdAt: x.createdAt || new Date().toISOString(),
    })).filter(x=>x.code),
  };
}
async function loadCatalog(){
  try{
    const data = await loadJSON(`${API_BASE()}/LoadPromptText?filename=${encodeURIComponent(CATALOG_BLOB)}`);
    return normalizeCatalog(data);
  }catch{
    return { version:1, updatedAt:new Date().toISOString(), clients:[] };
  }
}
async function saveCatalog(){
  const body = { filename: CATALOG_BLOB, prompt: catalog };
  await postJSON(`${API_BASE()}/SavePromptText`, body);
}

/* ============ 5) 描画 ============ */
function renderTable(filter=""){
  const q = filter.trim().toLowerCase();
  $tbody.innerHTML = "";
  catalog.clients
    .filter(c => {
      if (!q) return true;
      return (
        c.code.toLowerCase().includes(q) ||
        c.name.toLowerCase().includes(q) ||
        (c.spreadsheetId||"").toLowerCase().includes(q)
      );
    })
    .sort((a,b)=>a.code.localeCompare(b.code))
    .forEach(client=>{
      const tr = document.createElement("tr");

      // code
      const tdCode = document.createElement("td");
      tdCode.textContent = client.code;
      tr.appendChild(tdCode);

      // name (editable)
      const tdName = document.createElement("td");
      const inpName = document.createElement("input");
      inpName.value = client.name;
      inpName.addEventListener("input", ()=>{ client.name = inpName.value; });
      tdName.appendChild(inpName);
      tr.appendChild(tdName);

      // behavior (label)
      const tdBeh = document.createElement("td");
      const label = document.createElement("span");
      label.textContent = client.behavior || "（なし）";
      label.className = "muted";
      tdBeh.appendChild(label);
      tr.appendChild(tdBeh);

      // spreadsheet id (editable + open)
      const tdId = document.createElement("td");
      tdId.className = "idcell";
      const inpId = document.createElement("input");
      inpId.placeholder = "1AbCdEfGhIjKlmNoP...";
      inpId.value = client.spreadsheetId || "";
      const btnOpen = document.createElement("button");
      btnOpen.textContent = "開く";
      function refreshOpenBtn(){
        const sid = extractSheetId(inpId.value);
        btnOpen.disabled = !sid;
      }
      inpId.addEventListener("input", ()=>{
        client.spreadsheetId = extractSheetId(inpId.value);
        refreshOpenBtn();
      });
      btnOpen.addEventListener("click", ()=>{
        const sid = extractSheetId(inpId.value);
        if (sid) window.open(sheetUrl(sid), "_blank");
      });
      refreshOpenBtn();
      tdId.appendChild(inpId);
      tdId.appendChild(btnOpen);
      tr.appendChild(tdId);

      // createdAt
      const tdAt = document.createElement("td");
      tdAt.textContent = (client.createdAt||"").replace("T"," ").replace("Z","");
      tdAt.className = "muted";
      tr.appendChild(tdAt);

      // ops
      const tdOps = document.createElement("td");
      const wrap = document.createElement("div");
      wrap.className="toolbar";

      const btnRecopy = document.createElement("button");
      btnRecopy.textContent = "テンプレ再コピー";
      btnRecopy.disabled = !client.behavior; // 空は対象外
      btnRecopy.addEventListener("click", ()=>provisionPrompts(client.code, client.behavior, true));

      const btnDelete = document.createElement("button");
      btnDelete.textContent = "台帳から削除";
      btnDelete.className = "danger";
      btnDelete.addEventListener("click", ()=>removeClient(client.code));

      wrap.appendChild(btnRecopy);
      wrap.appendChild(btnDelete);
      tdOps.appendChild(wrap);
      tr.appendChild(tdOps);

      $tbody.appendChild(tr);
    });
}

/* ============ 6) 登録/削除/コピー ============ */
function validateCode(v){
  return /^[0-9A-Za-z_\-]{1,32}$/.test(v); // 4桁推奨だが柔軟に
}
async function onCreate(){
  const code = $("clientCode").value.trim();
  const name = $("clientName").value.trim();
  const behavior = $("behavior").value; // "" | "R" | "S"
  const overwrite = $("overwrite").checked;
  const spreadsheetId = extractSheetId($("sheetId").value);

  if (!validateCode(code)) { setStatus("コードが不正です", false); return; }
  if (!name) { setStatus("名称を入力してください", false); return; }

  if (catalog.clients.some(c=>c.code===code)) {
    if (!confirm("同一コードが存在します。名称/シートIDのみ更新し、テンプレコピーを続行しますか？")) return;
    catalog.clients = catalog.clients.map(c =>
      c.code===code ? { ...c, name, spreadsheetId } : c
    );
  } else {
    catalog.clients.push({ code, name, behavior, spreadsheetId, createdAt:new Date().toISOString() });
  }
  catalog.updatedAt = new Date().toISOString();
  await saveCatalog();
  renderTable($("searchBox").value);

  await provisionPrompts(code, behavior, overwrite);
}

async function removeClient(code){
  if (!confirm(`クライアント ${code} を台帳から削除します。BLOBの /${code}/ は残ります。`)) return;
  catalog.clients = catalog.clients.filter(x=>x.code!==code);
  catalog.updatedAt = new Date().toISOString();
  await saveCatalog();
  renderTable($("searchBox").value);
  setStatus("削除しました");
}

/** BehaviorがR/Sのときのみ、テンプレを prompts 直下から prompts/<code>/ へコピー */
async function provisionPrompts(code, behavior, overwrite){
  if (!behavior) { setStatus("テンプレコピー不要（Behavior なし）"); return; }

  const files = TEMPLATE_FILES[behavior] || [];
  if (!files.length) { setStatus("テンプレ一覧が見つかりません", false); return; }

  setStatus(`コピー中: ${code} (${behavior}) ...`);
  try{
    for (const file of files){
      const src = file;                    // ルート直下
      const dst = `${code}/${file}`;       // <CLIENT_CODE>/file

      if (!overwrite) {
        const chk = await fetch(`${API_BASE()}/LoadPromptText?filename=${encodeURIComponent(dst)}`);
        if (chk.ok) continue; // 既存あり → スキップ
      }

      const data = await loadJSON(`${API_BASE()}/LoadPromptText?filename=${encodeURIComponent(src)}`);
      const body = { filename: dst, prompt: data?.prompt ?? data, params: data?.params };
      await postJSON(`${API_BASE()}/SavePromptText`, body);
    }
    setStatus("テンプレコピー完了");
  }catch(e){
    console.error(e);
    setStatus("コピー中にエラー: " + e.message, false);
  }
}

/* ============ 7) イベント & 初期化 ============ */
$("createBtn").addEventListener("click", onCreate);
$("reloadBtn").addEventListener("click", async ()=>{
  catalog = await loadCatalog(); renderTable($("searchBox").value);
});
$("saveCatalogBtn").addEventListener("click", async ()=>{
  catalog.updatedAt = new Date().toISOString();
  await saveCatalog();
  setStatus("台帳を保存しました");
});
$("exportBtn").addEventListener("click", ()=>{
  const blob = new Blob([JSON.stringify(catalog, null, 2)], {type:"application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "texel-client-catalog.json";
  a.click();
  URL.revokeObjectURL(a.href);
});
$("searchBox").addEventListener("input", (e)=>renderTable(e.target.value));

/* 登録ブロック：シートID入力で「開く」を有効化 */
const openBtn = $("openSheetBtn");
$("sheetId").addEventListener("input", ()=>{
  const sid = extractSheetId($("sheetId").value);
  openBtn.disabled = !sid;
});
openBtn.addEventListener("click", ()=>{
  const sid = extractSheetId($("sheetId").value);
  if (sid) window.open(sheetUrl(sid), "_blank");
});

(async function init(){
  catalog = await loadCatalog();
  renderTable();
})();
