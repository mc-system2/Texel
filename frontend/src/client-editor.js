// client-editor.js
(() => {
  // === 固定 ===
  const FILE = "texel-client-catalog.json";
  const PRESETS = {
    dev: "https://func-texel-api-dev-jpe-001-b2f6fec8fzcbdrc3.japaneast-01.azurewebsites.net/api",
    prod:"https://func-texel-api-prod-jpe-001-dsgfhtafbfbxawdz.japaneast-01.azurewebsites.net/api"
  };

  // === DOM ===
  const apiBaseEl   = document.getElementById("apiBase");
  const pingBtn     = document.getElementById("pingBtn");
  const pingState   = document.getElementById("pingState");
  const loadBtn     = document.getElementById("loadBtn");
  const saveBtn     = document.getElementById("saveBtn");
  const addRowBtn   = document.getElementById("addRowBtn");
  const exportBtn   = document.getElementById("exportBtn");
  const importFile  = document.getElementById("importFile");
  const gridBody    = document.getElementById("gridBody");
  const rowTmpl     = document.getElementById("rowTmpl");
  const etagBadge   = document.getElementById("etagBadge");
  const statusEl    = document.getElementById("status");
  const versionEl   = document.getElementById("version");
  const updatedAtEl = document.getElementById("updatedAt");
  const countEl     = document.getElementById("count");
  const alertEl     = document.getElementById("alert");

  // === 状態（ローカル保存しない） ===
  let currentETag = null;
  let currentCatalog = { version: 1, updatedAt: "", clients: [] };

  // ====== Utils ======
  const nowIso = () => new Date().toISOString();
  const toast  = (msg, kind="info") => {
    statusEl.textContent = msg;
    statusEl.className = `muted ${kind}`;
    setTimeout(()=>{ statusEl.textContent=""; }, 3000);
  };
  const showAlert = (msg) => {
    alertEl.textContent = msg;
    alertEl.hidden = false;
    setTimeout(()=> alertEl.hidden = true, 4000);
  };

  const extractSheetId = (input) => {
    const v = (input||"").trim();
    if (!v) return "";
    const m = v.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]{10,})/);
    if (m) return m[1];
    const m2 = v.match(/[?&]id=([a-zA-Z0-9-_]{10,})/);
    if (m2) return m2[1];
    return /^[a-zA-Z0-9-_]{10,}$/.test(v) ? v : v; // ID でも URL でも保存可（表示はそのまま）
  };

  const api = {
    load: async () => {
      const base = apiBaseEl.value.trim().replace(/\/+$/,"");
      const url = `${base}/LoadClientCatalog?filename=${encodeURIComponent(FILE)}`;
      const res = await fetch(url, { method: "GET", cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const etag = res.headers.get("etag") || null;
      const json = await res.json();
      currentETag = json?.etag || etag || null;
      return json;
    },
    save: async (catalog) => {
      const base = apiBaseEl.value.trim().replace(/\/+$/,"");
      const res  = await fetch(`${base}/SaveClientCatalog`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: FILE,
          etag: currentETag,   // 楽観ロック
          catalog
        })
      });
      if (res.status === 409) {
        const e = await res.json().catch(()=>({error:""}));
        throw new Error(e.error || "ETag 競合。再読み込みしてください。");
      }
      if (!res.ok) {
        const e = await res.json().catch(()=>({error:"保存エラー"}));
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      return await res.json();
    }
  };

  // ====== UI構築 ======
  function render(catalog) {
    // ヘッダ
    versionEl.textContent   = catalog.version ?? "-";
    updatedAtEl.textContent = catalog.updatedAt ?? "-";
    etagBadge.textContent   = currentETag ? `ETag: ${currentETag}` : "";
    // テーブル
    gridBody.innerHTML = "";
    (catalog.clients || []).forEach(addRow);
    countEl.textContent = String(catalog.clients?.length || 0);
  }

  function addRow(client) {
    const tr = rowTmpl.content.firstElementChild.cloneNode(true);

    const codeEl     = tr.querySelector(".code");
    const nameEl     = tr.querySelector(".name");
    const behEl      = tr.querySelector(".behavior");
    const sheetEl    = tr.querySelector(".sheet");
    const createdEl  = tr.querySelector(".created");
    const delBtn     = tr.querySelector(".delBtn");

    codeEl.value    = client?.code || "";
    nameEl.value    = client?.name || "";
    // 表示は TYPE-R / TYPE-S、保存は "R"/"S"/""
    const behVal = (client?.behavior || "").toUpperCase();
    behEl.value  = behVal === "R" ? "R" : behVal === "S" ? "S" : "";
    sheetEl.value   = client?.spreadsheetId || client?.sheetId || "";
    createdEl.value = client?.createdAt || "";

    // 行操作
    delBtn.addEventListener("click", () => {
      tr.remove();
      updateCount();
    });

    // 変更時の軽いバリデーション
    codeEl.addEventListener("input", () => codeEl.value = codeEl.value.toUpperCase());
    gridBody.appendChild(tr);
  }

  function updateCount() {
    countEl.textContent = String(gridBody.querySelectorAll("tr").length);
  }

  // 重複チェック（保存直前）
  function collectCatalogFromGrid() {
    const rows = [...gridBody.querySelectorAll("tr")];
    const clients = [];
    const seen = new Set();
    for (const tr of rows) {
      const code = tr.querySelector(".code").value.trim().toUpperCase();
      const name = tr.querySelector(".name").value.trim();
      const beh  = tr.querySelector(".behavior").value.trim().toUpperCase(); // "" | R | S
      const sheet= tr.querySelector(".sheet").value.trim();
      const created = tr.querySelector(".created").value.trim();

      if (!code) continue;

      if (!/^[A-Z0-9]{4}$/.test(code)) {
        throw new Error(`コード形式が不正です: ${code}`);
      }
      if (seen.has(code)) {
        throw new Error(`クライアントコードが重複しています: ${code}`);
      }
      seen.add(code);

      clients.push({
        code,
        name,
        behavior: beh === "R" ? "R" : beh === "S" ? "S" : "",
        spreadsheetId: extractSheetId(sheet),
        createdAt: created || ""
      });
    }
    return {
      version: currentCatalog.version ?? 1,
      updatedAt: nowIso(),
      clients
    };
  }

  // 複製：新しいコードを自動発番（未使用の 1文字＋3桁）
  function duplicateRow(tr) {
    const code = nextClientCode();
    const c = {
      code,
      name: tr.querySelector(".name").value,
      behavior: tr.querySelector(".behavior").value,
      spreadsheetId: tr.querySelector(".sheet").value,
      createdAt: nowIso().slice(0,10)
    };
    addRow(c);
    updateCount();
  }

  function nextClientCode() {
    const used = new Set(
      [...gridBody.querySelectorAll(".code")].map(i => i.value.trim().toUpperCase()).filter(Boolean)
    );
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    for (const L of letters) {
      for (let n=1; n<=999; n++) {
        const code = `${L}${String(n).padStart(3,"0")}`;
        if (!used.has(code)) return code;
      }
    }
    // 予備：完全ランダム
    return Math.random().toString(36).slice(2,6).toUpperCase();
  }

  // ====== イベント ======
  document.getElementById("devPreset").addEventListener("click", () => {
    apiBaseEl.value = PRESETS.dev;
    localStorage.setItem("texel-client-editor-apiBase", PRESETS.dev);
    loadBtn.click();
  });
  document.getElementById("prodPreset").addEventListener("click", () => {
    apiBaseEl.value = PRESETS.prod;
    localStorage.setItem("texel-client-editor-apiBase", PRESETS.prod);
    loadBtn.click();
  });

  pingBtn.addEventListener("click", async () => {
    try {
      await api.load(); // 実質疎通
      pingState.textContent = "OK";
      pingState.style.color = "#1a7f37";
    } catch {
      pingState.textContent = "NG";
      pingState.style.color = "#b00020";
    }
    setTimeout(()=> pingState.textContent = "", 2000);
  });

  loadBtn.addEventListener("click", async () => {
    try {
      const data = await api.load();
      // API は { etag?, version, updatedAt, clients } を返す想定
      currentETag   = data?.etag || currentETag;
      currentCatalog= { version: data.version ?? 1, updatedAt: data.updatedAt ?? "", clients: data.clients || [] };
      render(currentCatalog);
      toast("読み込み完了");
    } catch (e) {
      showAlert(`読込に失敗しました：${e.message}`);
    }
  });

  saveBtn.addEventListener("click", async () => {
    try {
      const catalog = collectCatalogFromGrid();
      // 画面反映だけ先に
      currentCatalog = catalog;
      updatedAtEl.textContent = catalog.updatedAt;

      const res = await api.save(catalog);
      currentETag = res?.etag || currentETag;
      etagBadge.textContent = currentETag ? `ETag: ${currentETag}` : "";
      toast("保存しました", "ok");
    } catch (e) {
      showAlert(`保存に失敗しました：${e.message}`);
    }
  });

  addRowBtn.addEventListener("click", () => {
    addRow({ code: nextClientCode(), name:"", behavior:"", spreadsheetId:"", createdAt: nowIso().slice(0,10) });
    updateCount();
  });

  exportBtn.addEventListener("click", () => {
    try {
      const catalog = collectCatalogFromGrid();
      const blob = new Blob([JSON.stringify(catalog, null, 2)], { type:"application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = FILE;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      showAlert(`JSON出力に失敗: ${e.message}`);
    }
  });

  importFile.addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      const json = JSON.parse(text);
      currentCatalog = { version: json.version ?? 1, updatedAt: json.updatedAt ?? "", clients: json.clients || [] };
      currentETag = null; // インポート後は必ず最新ロード→保存推奨
      render(currentCatalog);
      toast("JSONを読み込みました");
    } catch (err) {
      showAlert("JSONの読み込みに失敗しました");
    } finally {
      e.target.value = "";
    }
  });

  // 行の「複製」ボタンを動的委譲（テンプレート変更に合わせる）
  gridBody.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".dupBtn");
    if (!btn) return;
    const tr = btn.closest("tr");
    if (tr) duplicateRow(tr);
  });

  // ===== 起動時 =====
  document.addEventListener("DOMContentLoaded", async () => {
    // API Base 初期値（前回の選択を復元）
    apiBaseEl.value = localStorage.getItem("texel-client-editor-apiBase") || PRESETS.dev;

    // 画面を薄緑トーンへ：body にクラス付与（CSS側で反映済み）
    document.body.classList.add("theme-texel-green");

    // 起動時に即ロード
    try {
      const data = await api.load();
      currentETag   = data?.etag || null;
      currentCatalog= { version: data.version ?? 1, updatedAt: data.updatedAt ?? "", clients: data.clients || [] };
      render(currentCatalog);
      toast("自動読み込み完了");
    } catch (e) {
      showAlert(`初期読込に失敗：${e.message}`);
    }
  });
})();
