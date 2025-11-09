// Client Catalog Editor v2025-11-09-2
// 保存後：新規クライアントに限り roomphoto 固定の index とテンプレを自動作成。

const els = {
  apiBase: document.getElementById("apiBase"),
  btnRead: document.getElementById("btnRead"),
  btnSave: document.getElementById("btnSave"),
  btnAdd: document.getElementById("btnAddClientRow"),
  btnNew: document.getElementById("btnNew"),
  list: document.getElementById("list"),
  status: document.getElementById("status"),
};

function join(base, path){ return base.replace(/\/+$/,'') + '/' + path.replace(/^\/+/,''); }

// ---- API compatibility helper ----
async function callApiCompat(name, variants){
  let lastErr=null;
  for (const body of variants){
    try{
      const r = await postJSON(join(els.apiBase.value, name), body);
      const j = await r.json().catch(()=>null);
      if (j!=null) return j;
    }catch(e){ lastErr=e; }
  }
  if (lastErr) throw lastErr; else throw new Error('API response empty');
}

// ===== API Base (lenient) =====
function resolveApiBase(){
  const u = new URL(location.href);
  const q = u.searchParams.get("api");
  if (q){ els.apiBase.value = q; localStorage.setItem("apiBase", q); }
  else if (localStorage.getItem("apiBase")) { els.apiBase.value = localStorage.getItem("apiBase"); }
  // 既定の input 値を尊重（ここでは何もしない）
  els.apiBase.addEventListener("input", ()=> localStorage.setItem("apiBase", els.apiBase.value.trim()));
}
async function postJSON(url, body){
  const r = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json; charset=utf-8" }, body: JSON.stringify(body||{}) });
  if (!r.ok) throw new Error(await r.text()||`HTTP ${r.status}`);
  return r;
}
function setStatusfunction setStatus(s){ els.status.textContent = s; }

let clients = [];           // [{ code, name, behavior }]
let previousCodes = new Set();

function renderClientList(){
  els.list.innerHTML = "";
  clients.forEach((c, idx)=>{
    const row = document.createElement("div");
    row.className = "client-row";
    row.innerHTML = `
      <input class="code" maxlength="4" placeholder="CODE" value="${c.code||""}">
      <input class="name" placeholder="名称" value="${c.name||""}">
      <button class="btn row-del" title="削除">🗑</button>`;
    const [codeEl, nameEl] = row.querySelectorAll("input");
    codeEl.addEventListener("input", (e)=>{
      clients[idx].code = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,4);
      e.target.value = clients[idx].code;
    });
    nameEl.addEventListener("input", (e)=> clients[idx].name = e.target.value );
    row.querySelector(".row-del").addEventListener("click", ()=>{ clients.splice(idx,1); renderClientList(); });
    els.list.appendChild(row);
  });
}

// ==== 読込/保存 ====
async function loadCatalog(){
  resolveApiBase();
  setStatus("読込中…");
  try{
    const j = await callApiCompat("LoadPromptText", [
      { filename: "client/catalog.json" }, { path: "client/catalog.json" }
    ]);
    const p = j?.text ? JSON.parse(j.text) : (j||{ clients:[] });
    clients = (p.clients||[]).map(x=>({ code:(x.code||"").toUpperCase(), name: x.name||"", behavior: (x.behavior||"BASE").toUpperCase() }));
    previousCodes = new Set(clients.map(x=>x.code));
    renderClientList();
    setStatus("読込完了");
  }catch(e){
    await listClientFoldersFallback(); // catalog.json が無ければフォルダ列挙にフォールバック
  }
}

async function saveCatalog(){
  
  setStatus("保存中…");
  const payload = { clients };
  const text = JSON.stringify(payload, null, 2);
  try{
    await postJSON(join(els.apiBase.value,"SavePromptText"), { filename:"client/catalog.json", text });
  }catch(e){
    await postJSON(join(els.apiBase.value,"SavePromptText"), { filename:"client/catalog.json", prompt:text });
  }
  await initPromptsForNewClients(clients);
  previousCodes = new Set(clients.map(x=>x.code));
  setStatus("保存完了");
}

// ---- fallback: enumerate client folders when catalog.json is missing ----
async function listClientFoldersFallback(){
  try{
    const j = await callApiCompat("ListBLOB", [
      { container: "prompts", folder: "client" },
      { containerName: "prompts", prefix: "client/" },
      { container: "prompts", prefix: "client/" }
    ]);
    let codes = [];
    if (j?.prefixes?.length){
      codes = j.prefixes.map(x => String(x).split("/")[1]).filter(Boolean);
    } else if (Array.isArray(j?.items)){
      const set = new Set();
      j.items.forEach(it=>{
        const m = String(it.name||it.path||"").match(/^client\/([A-Za-z0-9]{1,10})\//);
        if (m) set.add(m[1]);
      });
      codes = [...set];
    }
    codes.sort();
    clients = codes.map(c=>({ code: (c||"").toUpperCase(), name: "", behavior:"BASE" }));
    previousCodes = new Set(clients.map(x=>x.code));
    renderClientList();
    setStatus(clients.length ? "フォルダ一覧から読込" : "クライアントなし");
  }catch(e){
    console.warn("ListBLOB fallback failed:", e);
    clients = []; previousCodes = new Set();
    renderClientList();
    setStatus("読込エラー");
  }
}

// ==== 新規クライアントの初期化 ====
function templateFromFilename(filename, behavior){
  behavior = (behavior||"BASE").toUpperCase();
  if (behavior === "TYPE-R") return filename.replace(/^texel-/, "texel-r-");
  if (behavior === "TYPE-S") return filename.replace(/^texel-/, "texel-s-");
  return filename;
}

async function savePromptText(filename, promptText){
  await postJSON(join(els.apiBase.value,"SavePromptText"), { filename, prompt: promptText });
}
async function loadPromptText(filename){
  try{
    const r = await postJSON(join(els.apiBase.value,"LoadPromptText"), { filename });
    const j = await r.json().catch(()=>null);
    return j?.text || j?.prompt || "";
  }catch{ return ""; }
}

async function initPromptsForNewClients(currentClients){
  const now = new Map(currentClients.map(c => [c.code.toUpperCase(), (c.behavior||"BASE").toUpperCase()]));
  const adds = [];
  for (const [code, beh] of now.entries()){
    if (!previousCodes.has(code)) adds.push({ code, behavior: beh });
  }
  if (adds.length===0) return;

  for (const {code, behavior} of adds){
    const index = {
      version: 1,
      clientId: code,
      behavior,
      updatedAt: new Date().toISOString(),
      items: [{ file:"texel-roomphoto.json", name:"画像分析プロンプト", order:10, hidden:false, fixed:true }],
      params: {}
    };
    await savePromptText(`client/${code}/prompt-index.json`, JSON.stringify(index, null, 2));
    const templFile = templateFromFilename("texel-roomphoto.json", behavior);
    const t = await loadPromptText(templFile);
    const content = t || JSON.stringify({ prompt:"", params:{} }, null, 2);
    await savePromptText(`client/${code}/texel-roomphoto.json`, content);
  }
}

// ==== 起動 ====
els.btnRead.addEventListener("click", loadCatalog);
els.btnSave.addEventListener("click", saveCatalog);
els.btnAdd.addEventListener("click", ()=>{ clients.push({ code:"", name:"", behavior:"BASE" }); renderClientList(); });
els.btnNew.addEventListener("click", ()=>{ clients = []; renderClientList(); setStatus("新規作成（未保存）"); });
loadCatalog();
