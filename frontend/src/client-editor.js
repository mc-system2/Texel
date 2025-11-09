(() => {
  'use strict';

  // ====== State ======
  const CODE_RE = /^[A-Za-z0-9]{4}$/;               // RX78 等 OK
  const state = { rows: [], apiBase: '' };

  const $ = (s, el=document) => el.querySelector(s);
  const $$ = (s, el=document) => Array.from(el.querySelectorAll(s));
  const setStatus = (msg, cls='') => {
    const el = $('#status'); el.textContent = msg; el.className = 'status ' + cls;
  };

  // ====== Utilities ======
  const normApiBase = (v) => {
    if (!v) return '';
    v = v.trim();
    if (!/\/api\/?$/.test(v)) v = v.replace(/\/?$/, '/api/');
    return v;
  };

  async function postJSON(url, body, expectJson=true) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} @ ${url}`);
    }
    return expectJson ? res.json() : res.text();
  }

  function validate() {
    const codes = new Set();
    for (const r of state.rows) {
      if (!CODE_RE.test(r.code || '')) throw new Error(`コードは英数字4桁で入力: ${r.code || '(未入力)'}`);
      const key = r.code.toUpperCase();
      if (codes.has(key)) throw new Error(`コード重複: ${key}`);
      codes.add(key);
    }
  }

  // ====== API calls ======
  async function listClientFolders() {
    const api = normApiBase($('#apiBase').value);
    state.apiBase = api;
    const url = api + 'ListBLOB';
    const body = { container: 'prompts', prefix: 'client/', recursive: false, foldersOnly: true };
    const json = await postJSON(url, body);
    // items: [{name:"client/A001/"}, ...]
    const codes = (json.items || [])
      .map(x => (x.name || '').replace(/^client\/|\/$/g, ''))
      .filter(code => CODE_RE.test(code))
      .sort();
    return codes;
  }

  async function loadClientCatalog(code) {
    const url = state.apiBase + 'LoadBLOB';
    const body = { container: 'prompts', filename: `client/${code}/texel-client-catalog.json` };
    try {
      const text = await postJSON(url, body, false);
      try { return JSON.parse(text); } catch { return { code, name: '' }; }
    } catch (e) {
      // 404 等 → 未作成とみなす
      return { code, name: '' };
    }
  }

  async function saveCatalog(code, name) {
    const url = state.apiBase + 'SaveBLOB';
    const payload = {
      container: 'prompts',
      filename: `client/${code}/texel-client-catalog.json`,
      text: JSON.stringify({
        version: 1, code, name: name || '', updatedAt: new Date().toISOString()
      }, null, 2),
      contentType: 'application/json; charset=utf-8'
    };
    await postJSON(url, payload);
  }

  async function ensurePromptIndex(code) {
    // prompt-index.json がなければ roomphoto 固定の初期値を作る
    const loadUrl = state.apiBase + 'LoadBLOB';
    const fname = `client/${code}/prompt-index.json`;
    try {
      await postJSON(loadUrl, { container:'prompts', filename: fname }, false);
    } catch {
      const saveUrl = state.apiBase + 'SaveBLOB';
      const indexJson = {
        prompt: [
          { file: 'texel-roomphoto.json', name: '画像分析プロンプト', order: 10, locked: true }
        ],
        params: {}
      };
      await postJSON(saveUrl, {
        container: 'prompts',
        filename: fname,
        text: JSON.stringify(indexJson, null, 2),
        contentType: 'application/json; charset=utf-8'
      });
      // roomphoto テンプレも同時に用意（空でOK）
      await postJSON(saveUrl, {
        container: 'prompts',
        filename: `client/${code}/texel-roomphoto.json`,
        text: '// roomphoto default',
        contentType: 'text/plain; charset=utf-8'
      });
    }
  }

  // ====== Rendering ======
  function renderRows() {
    const root = $('#clientList');
    root.innerHTML = '';
    state.rows.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'client-row';
      row.innerHTML = `
        <input class="row-code-input code-badge" data-index="${i}" maxlength="4" value="${r.code||''}" placeholder="CODE(4)">
        <input class="row-name-input" data-index="${i}" value="${r.name||''}" placeholder="名称">
        <button class="icon-btn dup" data-index="${i}" title="複製">複製</button>
        <button class="icon-btn danger del" data-index="${i}" title="削除">削除</button>
      `;
      root.appendChild(row);
    });

    // bind
    $$('.row-code-input', root).forEach(inp => {
      inp.addEventListener('input', e => {
        const ix = +e.target.dataset.index;
        state.rows[ix].code = e.target.value.toUpperCase();
        if (state.rows[ix].state !== 'new') state.rows[ix].state = 'dirty';
      });
    });
    $$('.row-name-input', root).forEach(inp => {
      inp.addEventListener('input', e => {
        const ix = +e.target.dataset.index;
        state.rows[ix].name = e.target.value;
        if (state.rows[ix].state !== 'new') state.rows[ix].state = 'dirty';
      });
    });
    $$('.dup', root).forEach(btn => {
      btn.addEventListener('click', e => {
        const ix = +e.currentTarget.dataset.index;
        const src = state.rows[ix];
        state.rows.push({ code:'', name: src.name, state:'new' });
        renderRows();
        setStatus('複製しました。コードを入力してください。');
      });
    });
    $$('.del', root).forEach(btn => {
      btn.addEventListener('click', e => {
        const ix = +e.currentTarget.dataset.index;
        state.rows.splice(ix,1);
        renderRows();
      });
    });
  }

  // ====== Events ======
  $('#addRowBtn').addEventListener('click', () => {
    state.rows.push({ code:'', name:'', state:'new' });
    renderRows();
    setStatus('新しい行を追加しました。コードと名称を入力してください。');
    queueMicrotask(() => {
      const inputs = $$('.row-code-input');
      if (inputs.length) inputs[inputs.length-1].focus();
    });
  });

  $('#loadBtn').addEventListener('click', async () => {
    try {
      setStatus('読込中…');
      const codes = await listClientFolders();
      const rows = [];
      for (const code of codes) {
        const cat = await loadClientCatalog(code);
        rows.push({ code, name: cat.name || '', state:'clean' });
      }
      state.rows = rows;
      renderRows();
      setStatus(`読込完了（${rows.length}件）`, 'good');
    } catch (e) {
      console.error(e);
      setStatus('読込に失敗しました: ' + e.message, 'bad');
    }
  });

  $('#saveBtn').addEventListener('click', async () => {
    try {
      validate();
      setStatus('保存中…');
      for (const r of state.rows) {
        if (r.state === 'new' || r.state === 'dirty') {
          await saveCatalog(r.code, r.name);
          await ensurePromptIndex(r.code);
          r.state = 'clean';
        }
      }
      setStatus('保存しました。', 'good');
    } catch (e) {
      console.error(e);
      setStatus('保存に失敗: ' + e.message, 'bad');
    }
  });

  // JSON 出力 / 取込（任意）
  $('#exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state.rows, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'client-catalog-export.json'; a.click();
    URL.revokeObjectURL(url);
  });
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const arr = JSON.parse(text);
      if (!Array.isArray(arr)) throw new Error('不正なJSON');
      state.rows = arr.map(x => ({
        code: String(x.code||'').toUpperCase(),
        name: String(x.name||''),
        state: 'new'
      }));
      renderRows();
      setStatus('インポートしました。保存で反映されます。');
    } catch (err) {
      setStatus('取込失敗: ' + err.message, 'bad');
    } finally {
      e.target.value = '';
    }
  });

  // 初期：localStorage から API Base を復元
  const KEY = 'clientEditor.apiBase';
  const saved = localStorage.getItem(KEY);
  if (saved) $('#apiBase').value = saved;
  $('#apiBase').addEventListener('change', () => {
    localStorage.setItem(KEY, $('#apiBase').value.trim());
  });

  setStatus('ready');
})();
