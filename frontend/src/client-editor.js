/* =====================================================================
 * Client Catalog Editor - client-editor.js  [FULL]
 * - Dev/Prod API Base 切替（ボタン／手入力）
 * - 起動時に自動ロード
 * - 保存時：Spreadsheet ID / URL が空ならエラー
 * - ステータス「読込完了／保存しました」は自動で消える
 * - 複製時：重複しないクライアントコードを自動発番
 * - ローカル保存(localStorage等)は一切しない
 * ===================================================================== */

(() => {
  /* ====== 定数・要素取得 ====== */
  const FILENAME = "texel-client-catalog.json";

  const DEV_BASE  = "https://func-texel-api-dev-jpe-001-b2f6fec8fzcbdrc3.japaneast-01.azurewebsites.net/api";
  const PROD_BASE = "https://func-texel-api-prod-jpe-001-dsgfhtafbfbxawdz.japaneast-01.azurewebsites.net/api";

  const apiBaseEl   = document.getElementById("apiBase");
  const pingBtn     = document.getElementById("pingBtn");
  const pingStateEl = document.getElementById("pingState");

  const devPresetBtn  = document.getElementById("devPreset");
  const prodPresetBtn = document.getElementById("prodPreset");

  const loadBtn   = document.getElementById("loadBtn");
  const saveBtn   = document.getElementById("saveBtn");
  const addRowBtn = document.getElementById("addRowBtn");
  const exportBtn = document.getElementById("exportBtn");
  const importFile= document.getElementById("importFile");

  const gridBody  = document.getElementById("gridBody");
  const rowTmpl   = document.getElementById("rowTmpl");

  const etagBadge = document.getElementById("etagBadge");
  const statusEl  = document.getElementById("status");
  const alertEl   = document.getElementById("alert");

  const versionEl   = document.getElementById("version");
  const updatedAtEl = document.getElementById("updatedAt");
  const countEl     = document.getElementById("count");

  /* ====== 状態 ====== */
  let currentCatalog = { version: 1, updatedAt: "", clients: [] };
  let currentETag = "";
  let statusTimer = null;

  /* ====== ユーティリティ ====== */
  function setStatus(msg = "", kind = "ok", durationMs = 2500) {
    clearTimeout(statusTimer);
    statusEl.textContent = msg || "";
    statusEl.className = kind; // .ok / .error / .muted など CSS があれば色付け
    if (msg) {
      statusTimer = setTimeout(() => {
        statusEl.textContent = "";
        statusEl.className = "";
      }, durationMs);
    }
  }
  function showAlert(msg) {
    alertEl.textContent = msg;
    alertEl.hidden = false;
  }
  function clearAlert() {
    alertEl.hidden = true;
    alertEl.textContent = "";
  }

  function normalizeBehavior(viewValue) {
    const v = String(viewValue || "").toUpperCase();
    if (v === "TYPE-R" || v === "R") return "R";
    if (v === "TYPE-S" || v === "S") return "S";
    return ""; // BASE
  }
  function viewBehavior(model) {
    if (!model) return "BASE";
    if (model === "R") return "TYPE-R";
    if (model === "S") return "TYPE-S";
    return "BASE";
  }
  function extractSheetId(input) {
    const v = (input || "").trim();
    if (!v) return "";
    const m = v.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]{10,})/);
    if (m) return m[1];
    const m2 = v.match(/[?&]id=([a-zA-Z0-9-_]{10,})/);
    if (m2) return m2[1];
    return /^[a-zA-Z0-9-_]{10,}$/.test(v) ? v : "";
  }
  function findDuplicateCodes(codes) {
    const seen = new Set();
    const dup = [];
    for (const c of codes) {
      if (seen.has(c)) dup.push(c);
      else seen.add(c);
    }
    return dup;
  }
  function randBase36(n = 3) {
    // 0-9A-Z
    const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    return Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  }
  function issueNewClientCode(existingSet, basePrefix = "B") {
    // 先頭1字 + 3桁（英数字）= 4桁
    for (let i = 0; i < 200; i++) {
      const code = (basePrefix + randBase36(3)).slice(0, 4).toUpperCase();
      if (!existingSet.has(code)) return code;
    }
    // 念のためフォールバック
    return (basePrefix + Date.now().toString(36).slice(-3)).slice(0, 4).toUpperCase();
  }

  /* ====== API ラッパ（BLOBのJSONを素のまま読み書き） ====== */
  const api = {
    get base() {
      return (apiBaseEl.value || "").replace(/\/+$/, "");
    },
    async ping() {
      // 軽い GET を投げる（LoadClientCatalog の 404 回避のため filename 同じに）
      const url = `${this.base}/LoadClientCatalog?filename=${encodeURIComponent(FILENAME)}`;
      return fetch(url, { method: "GET", cache: "no-cache" });
    },
    async load() {
      const url = `${this.base}/LoadClientCatalog?filename=${encodeURIComponent(FILENAME)}`;
      const res = await fetch(url, { method: "GET", cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      currentETag = res.headers.get("etag") || "";
      etagBadge.textContent = currentETag ? `ETag: ${currentETag}` : "";
      const data = await res.json();
      // 期待する形: { version, updatedAt, clients:[{code,name,behavior,spreadsheetId,createdAt}, ...] }
      if (!Array.isArray(data?.clients)) throw new Error("Invalid catalog format");
      return data;
    },
    async save(catalog) {
      // サーバ側の SaveClientCatalog は “素の JSON を保存” する想定
      // 互換性のため text も併送（サーバ側が string を期待していても通る）
      const url = `${this.base}/SaveClientCatalog`;
      const payload = {
        filename: FILENAME,
        json: catalog,                   // ← オブジェクト
        text: JSON.stringify(catalog),   // ← 文字列（両対応）
        etag: currentETag || undefined   // ← If-Match 的に使うなら
      };
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${t}`);
      }
      // 新しい ETag が返ることを期待（なくても可）
      try {
        const js = await res.json();
        currentETag = js?.etag || currentETag;
        if (currentETag) etagBadge.textContent = `ETag: ${currentETag}`;
      } catch {
        // ignore
      }
      return true;
    }
  };

  /* ====== テーブル行の生成・操作 ====== */
    function addRow(data = {}) {
    const tr = rowTmpl.content.firstElementChild.cloneNode(true);

    const codeEl     = tr.querySelector(".code");
    const nameEl     = tr.querySelector(".name");
    const behaviorEl = tr.querySelector(".behavior");
    const sheetEl    = tr.querySelector(".sheet");
    const createdEl  = tr.querySelector(".created");
    const opsCell    = tr.querySelector(".ops");

    // 既存の中身（テンプレート由来のボタン等）をいったん空にする
    opsCell.innerHTML = "";

    codeEl.value     = (data.code || "").toUpperCase();
    nameEl.value     = data.name || "";
    behaviorEl.value = viewBehavior(data.behavior || "");
    sheetEl.value    = data.spreadsheetId || data.sheetId || data.sheet || "";
    createdEl.value  = data.createdAt || new Date().toISOString().slice(0, 10);

    // 削除ボタン
    const delBtn = document.createElement("button");
    delBtn.className = "btn tiny danger";
    delBtn.textContent = "削除";
    delBtn.addEventListener("click", () => tr.remove());

    // 複製ボタン（新コード発番）
    const cloneBtn = document.createElement("button");
    cloneBtn.className = "btn tiny success";
    cloneBtn.textContent = "複製";
    cloneBtn.title = "この行を複製して新しいコードを発番";
    cloneBtn.addEventListener("click", () => {
        const existCodes = new Set(
        [...gridBody.querySelectorAll("tr .code")]
            .map((i) => i.value.trim().toUpperCase())
            .filter(Boolean)
        );
        const newCode = issueNewClientCode(existCodes, (codeEl.value || "B")[0]);
        const newRow = addRow({
        code: newCode,
        name: nameEl.value,
        behavior: normalizeBehavior(behaviorEl.value),
        spreadsheetId: extractSheetId(sheetEl.value) || sheetEl.value,
        createdAt: new Date().toISOString().slice(0, 10)
        });
        newRow.scrollIntoView({ behavior: "smooth", block: "center" });
        newRow.querySelector(".code")?.focus();
    });

    // 並び順はお好みで
    opsCell.append(cloneBtn, delBtn);

    gridBody.appendChild(tr);
    return tr;
    }

  function catalogToUI(catalog) {
    gridBody.innerHTML = "";
    const list = Array.isArray(catalog?.clients) ? catalog.clients : [];
    list.forEach((c) => addRow(c));
    versionEl.textContent = String(catalog.version ?? "");
    updatedAtEl.textContent = String(catalog.updatedAt ?? "");
    countEl.textContent = String(list.length);
  }

  function uiToCatalog() {
    const rows = [...gridBody.querySelectorAll("tr")];
    const clients = rows.map((tr, idx) => {
      const codeEl     = tr.querySelector(".code");
      const nameEl     = tr.querySelector(".name");
      const behaviorEl = tr.querySelector(".behavior");
      const sheetEl    = tr.querySelector(".sheet");
      const createdEl  = tr.querySelector(".created");

      const code = codeEl.value.trim().toUpperCase();
      const name = nameEl.value.trim();
      const behavior = normalizeBehavior(behaviorEl.value);
      const inputSheet = sheetEl.value.trim();
      const sheet = extractSheetId(inputSheet) || inputSheet;

      // Spreadsheet 未入力はエラー
      if (!sheet) {
        sheetEl.classList.add("invalid");
        sheetEl.focus();
        throw new Error(`行${idx + 1}: 「Spreadsheet ID / URL」は必須です`);
      } else {
        sheetEl.classList.remove("invalid");
      }

      return { code, name, behavior, spreadsheetId: sheet, createdAt: createdEl.value.trim() };
    }).filter((c) => c.code);

    // コード重複チェック
    const dup = findDuplicateCodes(clients.map((c) => c.code));
    if (dup.length) throw new Error(`クライアントコードが重複しています: ${dup.join(", ")}`);

    return {
      version: Number(currentCatalog.version) || 1,
      updatedAt: new Date().toISOString(),
      clients
    };
  }

  /* ====== ボタン操作 ====== */
  devPresetBtn.addEventListener("click", () => {
    apiBaseEl.value = DEV_BASE;
    devPresetBtn.classList.add("active");
    prodPresetBtn.classList.remove("active");
  });
  prodPresetBtn.addEventListener("click", () => {
    apiBaseEl.value = PROD_BASE;
    prodPresetBtn.classList.add("active");
    devPresetBtn.classList.remove("active");
  });

  pingBtn.addEventListener("click", async () => {
    pingStateEl.textContent = "疎通中…";
    try {
      const r = await api.ping();
      pingStateEl.textContent = r.ok ? "疎通 OK" : `NG (${r.status})`;
    } catch (e) {
      pingStateEl.textContent = `NG (${e.message || e})`;
    }
    setTimeout(() => (pingStateEl.textContent = ""), 2500);
  });

  loadBtn.addEventListener("click", async () => {
    await doLoad();
  });

  saveBtn.addEventListener("click", async () => {
    clearAlert();
    try {
      const catalog = uiToCatalog(); // ここで必須チェック＆重複チェック
      setStatus("保存中…", "muted", 60000);
      await api.save(catalog);
      currentCatalog = { ...catalog };
      versionEl.textContent = String(currentCatalog.version);
      updatedAtEl.textContent = String(currentCatalog.updatedAt);
      countEl.textContent = String(currentCatalog.clients.length);
      setStatus("保存しました", "ok");
    } catch (e) {
      showAlert(`保存に失敗しました： ${e.message || e}`);
      setStatus("", "");
    }
  });

  addRowBtn.addEventListener("click", () => addRow({ createdAt: new Date().toISOString().slice(0, 10) }));

  exportBtn.addEventListener("click", () => {
    try {
      const catalog = uiToCatalog();
      const blob = new Blob([JSON.stringify(catalog, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = FILENAME;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      showAlert(`JSON出力に失敗しました： ${e.message || e}`);
    }
  });

  importFile.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      currentCatalog = json;
      catalogToUI(json);
      setStatus("取込完了", "ok");
    } catch (err) {
      showAlert("JSONの読み込みに失敗しました。");
    } finally {
      importFile.value = "";
    }
  });

  /* ====== 読み込み本体 ====== */
  async function doLoad() {
    clearAlert();
    setStatus("読込中…", "muted", 60000);
    try {
      const json = await api.load();
      currentCatalog = json;
      catalogToUI(json);
      setStatus("読込完了", "ok");
    } catch (e) {
      showAlert(`読込に失敗しました： ${e.message || e}`);
      setStatus("", "");
    }
  }

  /* ====== 初期化：デフォは DEV をセットして自動ロード ====== */
  document.addEventListener("DOMContentLoaded", async () => {
    // 直近で使いやすいよう DEV を初期値に
    devPresetBtn.click();
    // 自動ロード
    await doLoad();

    // グリッド内の Enter で次セルへ移動（使い勝手向上）
    gridBody.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const inputs = [...gridBody.querySelectorAll("input,select")];
      const idx = inputs.indexOf(e.target);
      if (idx >= 0) {
        e.preventDefault();
        const next = inputs[idx + 1] || inputs[0];
        next.focus();
      }
    });
  });
})();
