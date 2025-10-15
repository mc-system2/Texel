// client-editor.js
(() => {
  const FILE = 'texel-client-catalog.json';

  // ---- 環境プリセット（ご提供の URL） ----
  const PRESET = {
    dev: 'https://func-texel-api-dev-jpe-001-b2f6fec8fzcbdrc3.japaneast-01.azurewebsites.net/api',
    prod:'https://func-texel-api-prod-jpe-001-dsgfhtafbfbxawdz.japaneast-01.azurewebsites.net/api'
  };

  // ---- DOM ----
  const apiBaseEl  = document.getElementById('apiBase');
  const pingBtn    = document.getElementById('pingBtn');
  const pingState  = document.getElementById('pingState');
  const loadBtn    = document.getElementById('loadBtn');
  const saveBtn    = document.getElementById('saveBtn');
  const addRowBtn  = document.getElementById('addRowBtn');
  const exportBtn  = document.getElementById('exportBtn');
  const importFile = document.getElementById('importFile');
  const gridBody   = document.getElementById('gridBody');
  const rowTmpl    = document.getElementById('rowTmpl');
  const statusEl   = document.getElementById('status');
  const etagBadge  = document.getElementById('etagBadge');
  const versionEl  = document.getElementById('version');
  const updatedEl  = document.getElementById('updatedAt');
  const countEl    = document.getElementById('count');
  const alertEl    = document.getElementById('alert');

  const devPresetBtn  = document.getElementById('devPreset');
  const prodPresetBtn = document.getElementById('prodPreset');

  // ---- 状態 ----
  let currentETag = '';
  let currentCatalog = { version: 1, updatedAt: '', clients: [] };

  // ---- API ラッパ ----
  const api = {
    load: async () => {
      const base = apiBaseEl.value.trim().replace(/\/+$/,'');
      const url = `${base}/LoadClientCatalog?filename=${encodeURIComponent(FILE)}`;
      const res = await fetch(url, { method: 'GET', cache: 'no-cache' });
      if (!res.ok) {
        const t = await res.text().catch(()=> '');
        throw new Error(`Load 失敗: HTTP ${res.status} ${t || ''}`);
      }
      currentETag = res.headers.get('ETag') || '';
      etagBadge.textContent = currentETag || '';
      const text = await res.text();
      return text ? JSON.parse(text) : { version: 1, updatedAt: '', clients: [] };
    },
    save: async (catalog) => {
      const base = apiBaseEl.value.trim().replace(/\/+$/,'');
      const res  = await fetch(`${base}/SaveClientCatalog`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: FILE, etag: currentETag, catalog })
      });

      const text = await res.text().catch(()=> '');
      if (res.status === 409) {
        let e = {};
        try { e = JSON.parse(text || '{}'); } catch {}
        throw new Error(e.error || 'ETag 競合。再読み込みしてください。');
      }
      if (!res.ok) {
        let e = {};
        try { e = JSON.parse(text || '{}'); } catch {}
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      const json = text ? JSON.parse(text) : { ok: true };
      const newTag = res.headers.get('ETag') || json.etag || '';
      if (newTag) {
        currentETag = newTag;
        etagBadge.textContent = currentETag;
      }
      return json;
    }
  };

  // ---- 行テンプレ作成 ----
  function createRow(item = {}) {
    const tr = rowTmpl.content.firstElementChild.cloneNode(true);
    const codeEl = tr.querySelector('.code');
    const nameEl = tr.querySelector('.name');
    const behaviorEl = tr.querySelector('.behavior');
    const sheetEl = tr.querySelector('.sheet');
    const createdEl = tr.querySelector('.created');

    codeEl.value = item.code || '';
    nameEl.value = item.name || '';
    behaviorEl.value = normalizeBehavior(item.behavior);
    sheetEl.value = item.spreadsheetId || item.sheetId || '';
    createdEl.value = item.createdAt || '';

    // 削除
    tr.querySelector('.delBtn').addEventListener('click', () => {
      tr.remove();
      syncMeta();
    });

    return tr;
  }

  // ---- UI <-> カタログ 変換 ----
  function uiToCatalog() {
    const rows = [...gridBody.querySelectorAll('tr')];
    const clients = rows.map(tr => {
      const code = tr.querySelector('.code').value.trim().toUpperCase();
      const name = tr.querySelector('.name').value.trim();
      const behavior = normalizeBehavior(tr.querySelector('.behavior').value);
      const sheet = extractSheetId(tr.querySelector('.sheet').value);
      const createdAt = tr.querySelector('.created').value.trim();
      return { code, name, behavior, spreadsheetId: sheet, createdAt };
    }).filter(x => x.code);

    // 重複コードチェック
    const dup = findDuplicateCodes(clients.map(c => c.code));
    if (dup.length) {
      throw new Error(`クライアントコードが重複しています: ${dup.join(', ')}`);
    }

    return {
      version: Number(currentCatalog.version) || 1,
      updatedAt: new Date().toISOString(),
      clients
    };
  }

  function catalogToUI(catalog) {
    gridBody.innerHTML = '';
    const list = Array.isArray(catalog.clients) ? catalog.clients : [];
    list.forEach(c => gridBody.appendChild(createRow(c)));
    versionEl.textContent = String(catalog.version ?? 1);
    updatedEl.textContent = catalog.updatedAt || '-';
    countEl.textContent = String(list.length);
  }

  function syncMeta() {
    countEl.textContent = String(gridBody.querySelectorAll('tr').length);
  }

  // ---- ユーティリティ ----
  function normalizeBehavior(b) {
    const v = String(b || '').toUpperCase();
    if (v === 'R' || v === 'TYPE-R') return 'R';
    if (v === 'S' || v === 'TYPE-S') return 'S';
    return ''; // BASE
  }
  function extractSheetId(input) {
    const v = (input || '').trim();
    if (!v) return '';
    const m = v.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]{10,})/);
    if (m) return m[1];
    const m2 = v.match(/[?&]id=([a-zA-Z0-9-_]{10,})/);
    if (m2) return m2[1];
    return /^[a-zA-Z0-9-_]{10,}$/.test(v) ? v : v; // URL そのままでも許容（保存側ではそのまま保持）
  }
  function findDuplicateCodes(arr) {
    const seen = new Set();
    const dup = new Set();
    for (const c of arr) {
      if (seen.has(c)) dup.add(c);
      seen.add(c);
    }
    return [...dup];
  }

  // 一意な 4桁英数コード（先頭アルファ + 3桁 base36）
  function issueUniqueCode(prefix = 'B') {
    const used = new Set(
      [...gridBody.querySelectorAll('.code')].map(i => i.value.trim().toUpperCase())
    );
    for (let i = 0; i < 10000; i++) {
      const n = (Math.floor(Math.random() * 46656)).toString(36).toUpperCase().padStart(3, '0');
      const code = `${prefix}${n}`.slice(0, 4);
      if (!used.has(code)) return code;
    }
    // フォールバック
    return `${prefix}${Date.now().toString(36).toUpperCase().slice(-3)}`.slice(0, 4);
  }

  function showAlert(msg, kind = 'error') {
    alertEl.hidden = false;
    alertEl.textContent = msg;
    alertEl.className = `alert ${kind}`;
    setTimeout(() => { alertEl.hidden = true; }, 4000);
  }

  // ---- ボタン挙動 ----
  devPresetBtn.addEventListener('click', () => {
    apiBaseEl.value = PRESET.dev;
    devPresetBtn.classList.add('active');
    prodPresetBtn.classList.remove('active');
  });
  prodPresetBtn.addEventListener('click', () => {
    apiBaseEl.value = PRESET.prod;
    prodPresetBtn.classList.add('active');
    devPresetBtn.classList.remove('active');
  });

  pingBtn.addEventListener('click', async () => {
    pingState.textContent = '確認中…';
    try {
      const base = apiBaseEl.value.trim().replace(/\/+$/,'');
      const url = `${base}/LoadClientCatalog?filename=${encodeURIComponent(FILE)}`;
      const res = await fetch(url, { method:'HEAD' }).catch(()=>null);
      pingState.textContent = res && (res.ok || res.status === 404) ? 'OK' : 'NG';
    } catch {
      pingState.textContent = 'NG';
    }
  });

  loadBtn.addEventListener('click', async () => {
    await doLoad();
  });

  saveBtn.addEventListener('click', async () => {
    try {
      const catalog = uiToCatalog();
      statusEl.textContent = '保存中…';
      const res = await api.save(catalog);
      currentCatalog = { ...catalog };
      statusEl.textContent = '保存しました';
      updatedEl.textContent = catalog.updatedAt || '-';
    } catch (e) {
      showAlert(`保存に失敗しました： ${e.message || e}`);
      statusEl.textContent = '';
    }
  });

  addRowBtn.addEventListener('click', () => {
    const tr = createRow({
      code: issueUniqueCode(),
      name: '',
      behavior: '',
      spreadsheetId: '',
      createdAt: new Date().toISOString().slice(0,10)
    });
    gridBody.prepend(tr);
    syncMeta();
  });

  exportBtn.addEventListener('click', () => {
    try {
      const catalog = uiToCatalog();
      const blob = new Blob([JSON.stringify(catalog, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = FILE;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      showAlert(`JSON出力に失敗： ${e.message || e}`);
    }
  });

  importFile.addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      const json = JSON.parse(text);
      currentCatalog = json;
      catalogToUI(json);
      currentETag = ''; // 手取り込みは ETag 破棄（次保存で取得し直す）
      etagBadge.textContent = '';
    } catch (err) {
      showAlert('JSONの読み込みに失敗しました');
    } finally {
      importFile.value = '';
    }
  });

  // ---- 行の複製（新しいコードを自動発番） ----
  gridBody.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn.dupBtn');
    if (!btn) return;
    const tr = btn.closest('tr');
    if (!tr) return;

    const item = {
      code: issueUniqueCode(),
      name: tr.querySelector('.name').value,
      behavior: normalizeBehavior(tr.querySelector('.behavior').value),
      spreadsheetId: tr.querySelector('.sheet').value,
      createdAt: new Date().toISOString().slice(0,10)
    };
    const newRow = createRow(item);
    tr.after(newRow);
    syncMeta();
  });

  // ---- 初期化：色・プリセット・自動ロード ----
  (function initOnce() {
    // 初期色（薄緑系）は CSS 側で定義済み前提
    apiBaseEl.value = PRESET.dev;
    devPresetBtn.classList.add('active');
    doLoad().catch(()=>{});
  })();

  // ---- ロード共通処理 ----
  async function doLoad() {
    statusEl.textContent = '読込中…';
    try {
      const json = await api.load();
      currentCatalog = json;
      catalogToUI(json);
      statusEl.textContent = '読込完了';
    } catch (e) {
      showAlert(`読込に失敗しました： ${e.message || e}`);
      statusEl.textContent = '';
    }
  }
})();
