/* client-editor.js — FULL */

(() => {
  // ========== 定数 ==========
  const PRESETS = {
    dev : "https://func-texel-api-dev-jpe-001-b2f6fec8fzcbdrc3.japaneast-01.azurewebsites.net/api/",
    prod: "https://func-texel-api-prod-jpe-001-dsgfhtafbfbxawdz.japaneast-01.azurewebsites.net/api/",
  };
  const LS_KEYS = {
    apiBase: "clientEditor.apiBase",
    etag  : "clientEditor.etag",
  };
  const FILE_NAME = "client-catalog.json"; // BLOB側のマスター

  // ========== 要素取得 ==========
  const $ = (id) => document.getElementById(id);
  const apiBaseInput = $("apiBase");
  const devBtn       = $("devPreset");
  const prodBtn      = $("prodPreset");
  const pingBtn      = $("pingBtn");
  const pingState    = $("pingState");
  const loadBtn      = $("loadBtn");
  const saveBtn      = $("saveBtn");
  const addRowBtn    = $("addRowBtn");
  const exportBtn    = $("exportBtn");
  const importFile   = $("importFile");
  const etagBadge    = $("etagBadge");
  const statusSpan   = $("status");
  const versionSpan  = $("version");
  const updatedSpan  = $("updatedAt");
  const countSpan    = $("count");
  const gridBody     = $("gridBody");
  const rowTmpl      = $("rowTmpl");

  // ========== ユーティリティ ==========
  const setStatus = (m) => (statusSpan.textContent = m || "");
  const setBadge  = (m) => (etagBadge.textContent = m || "");
  const saveApiBase = (url) => localStorage.setItem(LS_KEYS.apiBase, url);
  const loadApiBase = () => localStorage.getItem(LS_KEYS.apiBase) || PRESETS.dev;

  const asJson = async (res) => {
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    return ctype.includes("application/json") ? res.json() : JSON.parse(await res.text());
  };

  const buildUrl = (name, q = {}) => {
    const base = (apiBaseInput.value || "").replace(/\/+$/, "");
    const u = new URL(`${base}/${name}`);
    Object.entries(q).forEach(([k, v]) => u.searchParams.set(k, v));
    return u.toString();
  };

  const setPresetActive = (mode) => {
    devBtn.classList.toggle("active", mode === "dev");
    prodBtn.classList.toggle("active", mode === "prod");
  };

  // ========== 行描画 ==========
  function addRow(rec = {}) {
    const tr = rowTmpl.content.firstElementChild.cloneNode(true);
    tr.querySelector(".code").value     = rec.code || "";
    tr.querySelector(".name").value     = rec.name || "";
    tr.querySelector(".behavior").value = (rec.behavior || "").toUpperCase();
    tr.querySelector(".sheet").value    = rec.spreadsheetId || rec.sheetId || "";
    tr.querySelector(".created").value  = rec.createdAt || "";

    tr.querySelector(".delBtn").addEventListener("click", () => {
      tr.remove(); refreshCount();
    });
    gridBody.appendChild(tr);
  }
  function gridToJson() {
    const rows = [...gridBody.querySelectorAll("tr")];
    const clients = rows.map((tr) => {
      const code = tr.querySelector(".code").value.trim().toUpperCase();
      if (!code) return null;
      return {
        code,
        name: tr.querySelector(".name").value.trim(),
        behavior: tr.querySelector(".behavior").value.trim().toUpperCase(),
        spreadsheetId: tr.querySelector(".sheet").value.trim(),
        createdAt: tr.querySelector(".created").value.trim(),
      };
    }).filter(Boolean);
    return { version: Number(versionSpan.textContent || 1), updatedAt: new Date().toISOString(), clients };
  }
  function render(json) {
    gridBody.innerHTML = "";
    (json.clients || []).forEach(addRow);
    versionSpan.textContent = json.version ?? 1;
    updatedSpan.textContent = json.updatedAt || "";
    refreshCount();
  }
  const refreshCount = () => (countSpan.textContent = gridBody.querySelectorAll("tr").length);

  // ========== API 呼び出し ==========
  async function ping() {
    try {
      setStatus("ping…");
      const url = buildUrl("LoadClientCatalog", { filename: FILE_NAME, _: Date.now() });
      const res = await fetch(url, { method: "GET", cache: "no-cache" });
      pingState.textContent = res.ok ? "疎通 OK" : `NG (${res.status})`;
      setStatus("");
      return res.ok;
    } catch (e) {
      pingState.textContent = "NG";
      setStatus("");
      return false;
    }
  }

  async function loadCatalog() {
    try {
      setStatus("読込中…");
      const url = buildUrl("LoadClientCatalog", { filename: FILE_NAME, _: Date.now() });
      const res = await fetch(url, { method: "GET", cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const etag = res.headers.get("etag") || "";
      setBadge(etag);
      const json = await asJson(res);
      render(json);
      setStatus("OK");
    } catch (e) {
      setStatus("読込失敗");
      console.error("Load failed", e);
      alert("読み込みに失敗しました。API Base と関数の公開状態をご確認ください。");
    }
  }

  async function saveCatalog() {
    try {
      const body = gridToJson();
      setStatus("保存中…");
      const url = buildUrl("SaveClientCatalog");
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ filename: FILE_NAME, json: body }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await asJson(res);
      setBadge(j?.etag || "");
      updatedSpan.textContent = body.updatedAt;
      setStatus("保存完了");
    } catch (e) {
      setStatus("保存失敗");
      console.error("Save failed", e);
      alert("保存に失敗しました。API Base と CORS/認可をご確認ください。");
    }
  }

  // ========== プリセット適用 ==========
  function applyPreset(mode) {
    const base = PRESETS[mode];
    if (!base) return;
    apiBaseInput.value = base;
    saveApiBase(base);
    setPresetActive(mode);
    // 使い勝手向上：プリセット選択で疎通→読込まで自動実行
    ping().then((ok) => ok && loadCatalog());
  }

  // ========== 起動時 ==========
  document.addEventListener("DOMContentLoaded", () => {
    // 既存保存 or dev 初期値
    apiBaseInput.value = loadApiBase();
    setPresetActive(apiBaseInput.value.includes("-prod-") ? "prod" : "dev");

    // イベント：プリセット
    devBtn.addEventListener("click", () => applyPreset("dev"));
    prodBtn.addEventListener("click", () => applyPreset("prod"));

    // 入力直接変更 → 保存
    apiBaseInput.addEventListener("change", () => {
      saveApiBase(apiBaseInput.value.trim());
      setPresetActive(apiBaseInput.value.includes("-prod-") ? "prod" : "dev");
    });

    // 疎通/読込/保存/行追加/入出力
    pingBtn.addEventListener("click", ping);
    loadBtn.addEventListener("click", loadCatalog);
    saveBtn.addEventListener("click", saveCatalog);
    addRowBtn.addEventListener("click", () => addRow({ createdAt: new Date().toISOString().slice(0,10) }));
    exportBtn.addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(gridToJson(), null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "client-catalog.export.json";
      a.click();
    });
    importFile.addEventListener("change", async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const text = await f.text();
      const json = JSON.parse(text);
      render(json);
      e.target.value = "";
    });

    // 要望：「エディター開いたら自動ロード」
    ping().then((ok) => ok && loadCatalog());
  });
})();
