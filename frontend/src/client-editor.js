// client-editor.js  — 自動ロード対応版（dev/prod切替・永続化つき）

// ====== 設定 ======
const DEFAULT_FILENAME = "client-catalog.json";     // BLOB上のマスター
const ENDPOINT_LOAD = "LoadClientCatalog";
const ENDPOINT_SAVE = "SaveClientCatalog";

// 既定の API Base（切替可能）
const API_BASES = {
  dev : "https://func-texel-api-dev-jpe-001-b2f6fec8fzcbdrc3.japaneast-01.azurewebsites.net/api",
  prod: "https://func-texel-api-prod-jpe-001-dsgfhtafbfbxawdz.japaneast-01.azurewebsites.net/api",
};

const $ = (q, r=document) => r.querySelector(q);
const $$ = (q, r=document) => Array.from(r.querySelectorAll(q));

const els = {
  apiBase: $("#apiBase"),          // <input> API Base
  envDev:  $("#envDev"),           // <input type=radio>
  envProd: $("#envProd"),
  loadBtn: $("#btnLoad"),
  saveBtn: $("#btnSave"),
  addBtn:  $("#btnAdd"),
  table:   $("#gridBody"),
  ver:     $("#version"),
  updated: $("#updatedAt"),
  toast:   $("#toast"),
};

// ====== 状態 ======
let catalog = { version: 1, updatedAt: "", clients: {} };

// ====== ユーティリティ ======
const savePref = (k, v) => localStorage.setItem(`client-ed:${k}`, JSON.stringify(v));
const getPref  = (k, d=null) => {
  try { return JSON.parse(localStorage.getItem(`client-ed:${k}`)) ?? d; } catch { return d; }
};

function toast(msg, ok=true){
  if (!els.toast) return;
  els.toast.textContent = msg;
  els.toast.className = ok ? "toast ok" : "toast ng";
  els.toast.style.opacity = "1";
  setTimeout(()=> els.toast.style.opacity = "0", 2000);
}

function currentApiBase(){
  let base = (els.apiBase.value || "").replace(/\/+$/,"");
  if (!base) base = API_BASES[getPref("env","dev")] || API_BASES.dev;
  return base;
}

// ====== レンダリング ======
function render(){
  // ヘッダ情報
  els.ver.textContent = `version: ${catalog.version ?? "-"}`;
  els.updated.textContent = `updatedAt: ${catalog.updatedAt || "-"}`;
  // 本体
  els.table.innerHTML = "";
  const entries = Object.entries(catalog.clients || {}).sort(([a],[b]) => a.localeCompare(b));
  for (const [code, c] of entries){
    const tr = document.createElement("tr");

    tr.innerHTML = `
      <td><input class="cell code" value="${code}"></td>
      <td><input class="cell name" value="${c.name||""}" placeholder="名称"></td>
      <td>
        <select class="cell behavior">
          <option value="">BASE</option>
          <option value="R"${c.behavior==="R"?" selected":""}>TYPE-R</option>
          <option value="S"${c.behavior==="S"?" selected":""}>TYPE-S</option>
        </select>
      </td>
      <td><input class="cell sheet" value="${c.spreadsheetId||""}" placeholder="Spreadsheet ID またはURL"></td>
      <td><input class="cell created" value="${c.createdAt||""}" placeholder="yyyy-mm-dd"></td>
      <td class="ops">
        <button class="btn tiny ghost btn-dup">複製</button>
        <button class="btn tiny btn-del">削除</button>
      </td>
    `;
    // 削除
    tr.querySelector(".btn-del").onclick = () => {
      const k = tr.querySelector(".code").value.trim().toUpperCase();
      delete catalog.clients[k];
      render();
    };
    // 複製
    tr.querySelector(".btn-dup").onclick = () => {
      const k = tr.querySelector(".code").value.trim().toUpperCase();
      const base = catalog.clients[k];
      if (!base) return;
      const next = suggestCode(k);
      catalog.clients[next] = { ...base, createdAt: base.createdAt };
      render();
    };
    // 変更監視
    tr.addEventListener("input", () => {
      const k = tr.querySelector(".code").value.trim().toUpperCase();
      const v = {
        name: tr.querySelector(".name").value.trim(),
        behavior: tr.querySelector(".behavior").value.trim(),
        spreadsheetId: normalizeSheetId(tr.querySelector(".sheet").value),
        createdAt: tr.querySelector(".created").value.trim()
      };
      // key変更対応：一旦消して再セット
      for (const key of Object.keys(catalog.clients)) {
        if (catalog.clients[key] === v) delete catalog.clients[key];
      }
      catalog.clients[k] = v;
    });

    els.table.appendChild(tr);
  }
}

function normalizeSheetId(input){
  const v = (input||"").trim();
  if (!v) return "";
  const m = v.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]{10,})/);
  if (m) return m[1];
  const m2 = v.match(/[?&]id=([a-zA-Z0-9-_]{10,})/);
  if (m2) return m2[1];
  return /^[a-zA-Z0-9-_]{10,}$/.test(v) ? v : v; // URLでも保存OKにしておく
}

function suggestCode(from="A000"){
  // 末尾数字を+1
  const m = from.match(/^([A-Z]*)(\d{1,})$/i);
  if (!m) return from + "1";
  const head = m[1].toUpperCase();
  const n = String(parseInt(m[2],10)+1).padStart(m[2].length,"0");
  let cand = head + n;
  while (catalog.clients[cand]) cand = head + (parseInt(n,10)+1);
  return cand;
}

// ====== 通信 ======
async function loadCatalog(auto=false){
  const base = currentApiBase();
  const url = `${base}/${ENDPOINT_LOAD}?filename=${encodeURIComponent(DEFAULT_FILENAME)}`;

  try{
    const res = await fetch(url, { method:"GET", headers:{ "Accept":"application/json" }});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Function側で JSON.stringify 済みでもOKにする
    const text = await res.text();
    const json = typeof text === "string" ? JSON.parse(text) : text;

    // 受け取り形式の標準化
    // 期待：{ version, updatedAt, clients: { CODE:{name,behavior,spreadsheetId,createdAt} } }
    catalog = {
      version: json.version ?? 1,
      updatedAt: json.updatedAt ?? new Date().toISOString(),
      clients: json.clients ?? {},
    };
    render();
    toast(auto ? "自動ロード OK" : "ロード完了", true);
    $("#apiStatus")?.classList.add("status-ok");
  }catch(e){
    console.error("loadCatalog failed:", e);
    toast("ロード失敗: " + e.message, false);
    $("#apiStatus")?.classList.remove("status-ok");
  }
}

async function saveCatalog(){
  const base = currentApiBase();
  const url  = `${base}/${ENDPOINT_SAVE}`;

  const payload = {
    filename: DEFAULT_FILENAME,
    // BLOBにそのまま保存する形に合わせる
    catalog: {
      version: catalog.version ?? 1,
      updatedAt: new Date().toISOString(),
      clients: catalog.clients ?? {},
    }
  };

  try{
    const res = await fetch(url, {
      method:"POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    toast("保存完了", true);
  }catch(e){
    console.error("saveCatalog failed:", e);
    toast("保存失敗: " + e.message, false);
  }
}

// ====== イベント ======
function bindEvents(){
  // env 切替（要素があればだけバインド）
  if (els.envDev) {
    els.envDev.addEventListener("change", () => {
      if (!els.envDev.checked) return;
      savePref("env","dev");
      els.apiBase.value = API_BASES.dev;
      loadCatalog(true);
    });
  }

  if (els.envProd) {
    els.envProd.addEventListener("change", () => {
      if (!els.envProd.checked) return;
      savePref("env","prod");
      els.apiBase.value = API_BASES.prod;
      loadCatalog(true);
    });
  }

  // API Base 手入力を保持
  els.apiBase?.addEventListener("input", () => savePref("apiBase", els.apiBase.value));

  els.loadBtn?.addEventListener("click", () => loadCatalog(false));
  els.saveBtn?.addEventListener("click", () => saveCatalog());
  els.addBtn?.addEventListener("click", () => {
    const code = suggestCode("A000");
    catalog.clients[code] = { name:"", behavior:"", spreadsheetId:"", createdAt:new Date().toISOString().slice(0,10) };
    render();
  });
}

// ====== 起動（自動ロード） ======
document.addEventListener("DOMContentLoaded", () => {
  // 直前の選択を復元
  const env = getPref("env", "dev");

  // ラジオがある場合だけチェックを付ける
  if (env === "prod") {
    if (els.envProd) els.envProd.checked = true;
  } else {
    if (els.envDev) els.envDev.checked = true;
  }

  // API Base はラジオの有無に関わらず復元
  const savedBase = getPref("apiBase", API_BASES[env]);
  if (els.apiBase) els.apiBase.value = (savedBase || API_BASES[env]).replace(/\/+$/,"");

  bindEvents();

  // ★ エディターを開いたら即ロード
  loadCatalog(true);
});
