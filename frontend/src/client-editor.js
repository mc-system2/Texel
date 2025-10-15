(() => {
  // --- state ---
  let catalog = { version: 1, updatedAt: "", clients: [] }; // array in editor; API save converts
  let etag = "";

  // --- el helpers ---
  const qs = (s, r = document) => r.querySelector(s);
  const ce = (tag, props = {}) => Object.assign(document.createElement(tag), props);
  const toast = (msg) => {
    const t = qs("#toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    setTimeout(() => t.classList.add("hidden"), 2400);
  };
  const setStatus = (s) => (qs("#status").textContent = s);

  // --- validators / normalizers ---
  const extractSheetId = (input) => {
    const v = String(input || "").trim();
    if (!v) return "";
    let m = v.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]{10,})/);
    if (m) return m[1];
    m = v.match(/[?&]id=([a-zA-Z0-9-_]{10,})/);
    if (m) return m[1];
    return /^[a-zA-Z0-9-_]{10,}$/.test(v) ? v : "";
  };
  const normCode = (s) => String(s || "").trim().toUpperCase();
  const isCode = (s) => /^[A-Z0-9]{4}$/.test(normCode(s));
  const normBehavior = (b) => {
    const v = String(b || "").toUpperCase();
    return v === "R" ? "R" : v === "S" ? "S" : ""; // ""|R|S
  };

  // --- API ---
  const apiBaseInput = qs("#apiBase");
  const apiKeyInput = qs("#apiKey");
  const api = (url) => apiBaseInput.value.trim().replace(/\/+$/, "") + url;

  async function loadCatalog() {
    const url = api("/LoadClientCatalog");
    setStatus("loading");
    try {
      const headers = {};
      if (etag) headers["If-None-Match"] = etag;
      const res = await fetch(url, { headers });
      if (res.status === 304) {
        setStatus("not modified");
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      etag = res.headers.get("ETag") || "";
      const json = await res.json();
      const list = Array.isArray(json?.clients) ? json.clients : [];
      catalog = {
        version: Number(json?.version || 1),
        updatedAt: String(json?.updatedAt || ""),
        clients: list,
      };
      qs("#updatedAt").textContent = `updated: ${catalog.updatedAt || "-"}`;
      qs("#etag").textContent = `ETag: ${etag || "-"}`;
      render();
      setStatus("loaded");
      toast("カタログを読み込みました");
    } catch (e) {
      setStatus("error");
      toast("読込に失敗しました: " + e.message);
    }
  }

  async function saveCatalog() {
    const url = api("/SaveClientCatalog");
    const payload = {
      version: Number(catalog.version || 1),
      updatedAt: new Date().toISOString(),
      clients: catalog.clients.map((r) => ({
        code: normCode(r.code),
        name: String(r.name || ""),
        behavior: normBehavior(r.behavior),
        spreadsheetId: extractSheetId(r.spreadsheetId || r.sheetId || ""),
        createdAt: String(r.createdAt || ""),
      })),
    };

    // 重複コードは後勝ちで圧縮
    const map = new Map();
    for (const row of payload.clients) map.set(row.code, row);
    payload.clients = Array.from(map.values());

    // バリデーション
    const errs = [];
    for (const row of payload.clients) {
      if (!isCode(row.code)) errs.push(`invalid code: ${row.code}`);
      if (row.behavior !== "" && row.behavior !== "R" && row.behavior !== "S")
        errs.push(`invalid behavior: ${row.code}`);
    }
    if (errs.length) {
      toast("保存できません: " + errs[0]);
      return;
    }

    setStatus("saving");
    try {
      const headers = { "Content-Type": "application/json" };
      const key = apiKeyInput.value.trim();
      if (key) headers["x-api-key"] = key;

      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = { message: text };
      }
      if (!res.ok) throw new Error(json?.error || text || `HTTP ${res.status}`);

      etag = res.headers.get("ETag") || json?.etag || "";
      qs("#etag").textContent = `ETag: ${etag || "-"}`;
      setStatus("saved");
      toast("保存しました");
    } catch (e) {
      setStatus("error");
      toast("保存に失敗しました: " + e.message);
    }
  }

  // --- table render ---
  const tbody = qs("#tbody");

  function render() {
    tbody.innerHTML = "";
    const rows = Array.isArray(catalog.clients) ? catalog.clients : [];
    if (!rows.length) {
      const tr = ce("tr");
      const td = ce("td", {
        colSpan: 7,
        className: "muted",
        textContent: "データがありません。『行を追加』で作成してください。",
      });
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    rows.forEach((row, idx) => {
      tbody.appendChild(renderRow(row, idx));
    });
  }

  function renderRow(row, idx) {
    const tr = ce("tr");

    const tdCode = ce("td");
    const inCode = ce("input", { value: row.code || "", placeholder: "B001" });
    inCode.addEventListener("input", () => {
      row.code = normCode(inCode.value);
      validateRow(tr, row);
    });
    tdCode.appendChild(inCode);

    const tdName = ce("td");
    const inName = ce("input", { value: row.name || "", placeholder: "お客様名など" });
    inName.addEventListener("input", () => (row.name = inName.value));
    tdName.appendChild(inName);

    const tdBeh = ce("td");
    const sel = ce("select");
    ["", "R", "S"].forEach((v) => {
      const o = ce("option", { value: v, textContent: v === "" ? "BASE(空)" : v });
      if ((row.behavior || "") === v) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener("change", () => {
      row.behavior = normBehavior(sel.value);
      validateRow(tr, row);
    });
    tdBeh.appendChild(sel);

    const tdSheet = ce("td");
    const inSheet = ce("input", {
      value: row.spreadsheetId || row.sheetId || "",
      placeholder: "ID または URL",
    });
    inSheet.addEventListener("input", () => {
      const v = inSheet.value.trim();
      const id = extractSheetId(v);
      row.spreadsheetId = id || v; // 未確定でも保持
      validateRow(tr, row);
    });
    tdSheet.appendChild(inSheet);

    const tdCreated = ce("td");
    const inDate = ce("input", { value: row.createdAt || "", placeholder: "YYYY-MM-DD" });
    inDate.addEventListener("input", () => (row.createdAt = inDate.value));
    tdCreated.appendChild(inDate);

    const tdCheck = ce("td");
    tdCheck.className = "small";
    tdCheck.appendChild(ce("div", { className: "muted", innerHTML: auditRowHTML(row) }));

    const tdOps = ce("td");
    tdOps.appendChild(rowTools(idx));

    tr.append(tdCode, tdName, tdBeh, tdSheet, tdCreated, tdCheck, tdOps);
    validateRow(tr, row);
    return tr;
  }

  function auditRowHTML(r) {
    const msgs = [];
    if (!isCode(r.code)) msgs.push(`<span class="err">コード不正</span>`);
    const b = normBehavior(r.behavior);
    if (b && b !== "R" && b !== "S") msgs.push(`<span class="err">挙動不正</span>`);
    const id = extractSheetId(r.spreadsheetId || r.sheetId || "");
    if ((b === "R" || b === "S") && !id) msgs.push(`<span class="warn">要:SheetID</span>`);
    if (!msgs.length) return `<span class="ok">OK</span>`;
    return msgs.join(" / ");
  }

  function validateRow(tr, r) {
    const valid = isCode(r.code);
    tr.style.outline = valid ? "none" : "1px solid var(--danger)";
    const chk = tr.querySelector("td:nth-child(6) > div");
    if (chk) chk.innerHTML = auditRowHTML(r);
  }

  function rowTools(idx) {
    const wrap = ce("div", { className: "rowtools" });
    const up = ce("button", { className: "ghost", textContent: "↑" });
    const down = ce("button", { className: "ghost", textContent: "↓" });
    const del = ce("button", { className: "danger", textContent: "削除" });
    up.onclick = () => {
      if (idx <= 0) return;
      const r = catalog.clients.splice(idx, 1)[0];
      catalog.clients.splice(idx - 1, 0, r);
      render();
    };
    down.onclick = () => {
      if (idx >= catalog.clients.length - 1) return;
      const r = catalog.clients.splice(idx, 1)[0];
      catalog.clients.splice(idx + 1, 0, r);
      render();
    };
    del.onclick = () => {
      catalog.clients.splice(idx, 1);
      render();
    };
    wrap.append(up, down, del);
    return wrap;
  }

  // --- actions ---
  qs("#btnAdd").onclick = () => {
    catalog.clients.push({ code: "", name: "", behavior: "", spreadsheetId: "", createdAt: "" });
    render();
  };

  qs("#btnLoad").onclick = loadCatalog;
  qs("#btnSave").onclick = saveCatalog;

  // --- import/export ---
  const fileInput = qs("#fileInput");

  qs("#btnImportJson").onclick = () => {
    fileInput.accept = ".json,application/json";
    fileInput.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const text = await file.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        toast("JSONが不正です");
        return;
      }
      const list = Array.isArray(data?.clients) ? data.clients : Array.isArray(data) ? data : [];
      if (!Array.isArray(list)) {
        toast("JSONに clients 配列がありません");
        return;
      }
      const map = new Map(catalog.clients.map((r) => [normCode(r.code), r]));
      for (const r of list) {
        map.set(normCode(r.code), {
          code: normCode(r.code),
          name: String(r.name || ""),
          behavior: normBehavior(r.behavior),
          spreadsheetId: r.spreadsheetId || r.sheetId || "",
          createdAt: String(r.createdAt || ""),
        });
      }
      catalog.clients = Array.from(map.values());
      render();
      fileInput.value = "";
      toast("JSONを取り込みました");
    };
    fileInput.click();
  };

  qs("#btnImportCsv").onclick = () => {
    fileInput.accept = ".csv,text/csv";
    fileInput.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const text = await file.text();
      const lines = text.split(/\r?\n/).filter(Boolean);
      if (!lines.length) {
        toast("CSVが空です");
        return;
      }
      const head = lines[0].split(",").map((s) => s.trim().toLowerCase());
      const idx = (k) => head.indexOf(k);
      const rows = lines.slice(1).map((line) => {
        const a = line.split(",");
        return {
          code: normCode(a[idx("code")] || ""),
          name: a[idx("name")] || "",
          behavior: normBehavior(a[idx("behavior")] || ""),
          spreadsheetId: a[idx("spreadsheetid")] || a[idx("sheetid")] || "",
          createdAt: a[idx("createdat")] || "",
        };
      });
      const map = new Map(catalog.clients.map((r) => [normCode(r.code), r]));
      for (const r of rows) map.set(r.code, r);
      catalog.clients = Array.from(map.values());
      render();
      fileInput.value = "";
      toast("CSVを取り込みました");
    };
    fileInput.click();
  };

  qs("#btnExport").onclick = () => {
    const payload = {
      version: Number(catalog.version || 1),
      updatedAt: new Date().toISOString(),
      clients: catalog.clients,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = ce("a", { href: URL.createObjectURL(blob), download: "texel-client-catalog.json" });
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  // --- sensible defaults for local testing ---
  apiBaseInput.value ||= location.origin.replace(/\/$/, "") + "/api";
})();
