(() => {
  // ---- state ----
  let currentETag = '';
  let doc = { version: 1, updatedAt: '', clients: [] };

  // ---- elements ----
  const apiBaseEl   = $('#apiBase');
  const pingBtn     = $('#pingBtn');
  const pingState   = $('#pingState');
  const loadBtn     = $('#loadBtn');
  const saveBtn     = $('#saveBtn');
  const addRowBtn   = $('#addRowBtn');
  const exportBtn   = $('#exportBtn');
  const importFile  = $('#importFile');
  const etagBadge   = $('#etagBadge');
  const versionEl   = $('#version');
  const updatedAtEl = $('#updatedAt');
  const countEl     = $('#count');
  const gridBody    = $('#gridBody');
  const rowTmpl     = $('#rowTmpl');

  // ---- utils ----
  function $(q){ return document.querySelector(q); }
  const toast = (msg) => { $('#status').textContent = msg; };

  function ensureApiBase(){
    const base = (apiBaseEl.value || '').trim().replace(/\/+$/,'');
    if (!/^https?:\/\/.+/i.test(base)) throw new Error('API Base を正しく入力してください');
    return base;
  }

  function toIdOrKeep(v){
    const s = String(v||'').trim();
    // URL → ID 抜き出し
    const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]{10,})/);
    if (m) return m[1];
    const m2 = s.match(/[?&]id=([a-zA-Z0-9-_]{10,})/);
    if (m2) return m2[1];
    // 直接IDのとき
    return /^[a-zA-Z0-9-_]{10,}$/.test(s) ? s : s; // そのまま保持（Functions 側で更に正規化）
  }

  function render(){
    // meta
    versionEl.textContent   = doc.version ?? '-';
    updatedAtEl.textContent = doc.updatedAt || '-';
    countEl.textContent     = String(doc.clients?.length || 0);
    etagBadge.textContent   = currentETag ? `ETag: ${currentETag}` : '';

    // grid
    gridBody.innerHTML = '';
    (doc.clients || []).forEach(addRow);
  }

  function addRow(data = { code:'', name:'', behavior:'', spreadsheetId:'', createdAt:'' }){
    const node = rowTmpl.content.firstElementChild.cloneNode(true);
    const code = node.querySelector('.code');
    const name = node.querySelector('.name');
    const beh  = node.querySelector('.behavior');
    const sheet= node.querySelector('.sheet');
    const created = node.querySelector('.created');
    const del  = node.querySelector('.delBtn');

    code.value    = data.code || '';
    name.value    = data.name || '';
    beh.value     = (data.behavior || '').toUpperCase();
    sheet.value   = data.spreadsheetId || data.sheetId || '';
    created.value = data.createdAt || '';

    del.addEventListener('click', () => { node.remove(); toast('行を削除しました'); });

    gridBody.appendChild(node);
  }

  function collectDocFromUI(){
    const rows = [...gridBody.querySelectorAll('tr')];
    const clients = rows.map(r => ({
      code: (r.querySelector('.code').value || '').toUpperCase().trim(),
      name: r.querySelector('.name').value || '',
      behavior: (r.querySelector('.behavior').value || '').toUpperCase(),
      spreadsheetId: toIdOrKeep(r.querySelector('.sheet').value || ''),
      createdAt: r.querySelector('.created').value || ''
    })).filter(c => c.code);

    // 軽い検証
    const bad = clients.find(c => !/^[A-Z0-9]{4}$/.test(c.code));
    if (bad) throw new Error(`コード形式不正: ${bad.code}（4桁英数字）`);

    return {
      version: Number(doc.version || 1),
      updatedAt: new Date().toISOString(),
      clients
    };
  }

  // ---- IO ----
  async function load(){
    const base = ensureApiBase();
    toast('読込中…');
    const res = await fetch(`${base}/LoadClientCatalog`, {
      headers: { 'Accept':'application/json' },
      cache: 'no-store'
    });
    if (res.status === 304) { toast('変更なし (304)'); return; }
    if (!res.ok) throw new Error(`読み込み失敗: ${res.status}`);

    currentETag = res.headers.get('ETag') || '';
    doc = await res.json();
    render();
    toast('読込完了');
  }

  async function save(){
    const base = ensureApiBase();
    const payload = collectDocFromUI();

    toast('保存中…');
    const res = await fetch(`${base}/SaveClientCatalog`, {
      method: 'POST',
      headers: {
        'Content-Type':'application/json; charset=utf-8',
        // 競合を避けたい場合は If-Match を使う設計にできます（Functions 側の実装追加前提）
        // 'If-Match': currentETag || '*'
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`保存失敗: ${res.status}`);
    const body = await res.json().catch(()=>({}));
    currentETag = res.headers.get('ETag') || body.etag || '';

    // 保存後は最新版を再描画（updatedAt/件数も揃える）
    doc = payload;
    render();
    toast('保存完了');
  }

  async function ping(){
    try {
      const base = ensureApiBase();
      const res = await fetch(`${base}/LoadClientCatalog`, { method:'GET', cache:'no-store' });
      pingState.textContent = res.ok ? 'OK' : `NG(${res.status})`;
      pingState.style.color = res.ok ? '#22c55e' : '#ef4444';
    } catch (e) {
      pingState.textContent = 'NG';
      pingState.style.color = '#ef4444';
    }
  }

  // ---- export/import ----
  function exportJson(){
    const payload = collectDocFromUI();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type:'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'texel-client-catalog.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  importFile.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      if (!Array.isArray(json.clients)) throw new Error('形式が不正です（clients配列がありません）');
      doc = {
        version: Number(json.version || 1),
        updatedAt: String(json.updatedAt || new Date().toISOString()),
        clients: json.clients
      };
      render();
      toast('JSON を読み込みました（画面の状態は未保存）');
    } catch (err) {
      alert('JSON 取込に失敗しました: ' + err.message);
    } finally {
      e.target.value = '';
    }
  });

  // ---- events ----
  loadBtn.addEventListener('click', () => load().catch(e => alert(e.message)));
  saveBtn.addEventListener('click', () => save().catch(e => alert(e.message)));
  addRowBtn.addEventListener('click', () => addRow());
  exportBtn.addEventListener('click', exportJson);
  pingBtn.addEventListener('click', ping);

  // 便利：URL の hash に API Base を入れた場合に自動反映
  (function initFromHash(){
    const h = decodeURIComponent(location.hash.replace(/^#/, ''));
    if (h.startsWith('http')) apiBaseEl.value = h;
  })();
})();
