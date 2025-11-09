// Prompt Studio – inline rename edition
(() => {
  const $ = (sel, el=document) => el.querySelector(sel);
  const $$ = (sel, el=document) => Array.from(el.querySelectorAll(sel));

  // ---- State ----
  let API_BASE = localStorage.getItem('ps.api') || '';
  let CLIENT   = localStorage.getItem('ps.client') || '';
  let BEHAVIOR = localStorage.getItem('ps.behavior') || 'BASE';

  const INDEX_NAME = 'prompt-index.json'; // client/<client>/prompt-index.json

  // Prompt index schema: { version, client, behavior, items:[{file,name,order,hidden}], params:{} }
  let promptIndex = null;
  let fileMap = new Map(); // key -> item

  // selection
  let currentKey = null;
  let currentETag = null;

  // ---- Elements ----
  const clientInput    = $('#clientInput');
  const behaviorSelect = $('#behaviorSelect');
  const apiBaseInput   = $('#apiBaseInput');
  const fileListEl     = $('#fileList');
  const filterInput    = $('#filterInput');
  const addBtn         = $('#addBtn');
  const saveBtn        = $('#saveBtn');
  const diffBtn        = $('#diffBtn');

  const statusBadge = $('#statusBadge');
  const etagBadge   = $('#etagBadge');
  const fileBadge   = $('#fileBadge');

  const promptArea = $('#promptArea');
  const paramsArea = $('#paramsArea');

  // ---- Boot ----
  clientInput.value = CLIENT;
  apiBaseInput.value = API_BASE;
  behaviorSelect.value = BEHAVIOR;

  clientInput.addEventListener('change', () => {
    CLIENT = clientInput.value.trim();
    localStorage.setItem('ps.client', CLIENT);
    reload();
  });
  apiBaseInput.addEventListener('change', () => {
    API_BASE = apiBaseInput.value.trim();
    localStorage.setItem('ps.api', API_BASE);
  });
  behaviorSelect.addEventListener('change', () => {
    BEHAVIOR = behaviorSelect.value;
    localStorage.setItem('ps.behavior', BEHAVIOR);
  });

  addBtn.addEventListener('click', onAdd);
  fileListEl.addEventListener('click', onFileListClick);
  fileListEl.addEventListener('keydown', onFileListKey);

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      onSave();
    }
  });

  reload();

  async function reload() {
    clearEditor();
    await ensureIndex();
    renderFileList();
  }

  function getClientFolder() {
    if (!CLIENT) throw new Error('Client 未設定');
    return `client/${CLIENT}`;
  }

  // ---- API helpers ----
  async function apiPost(path, body) {
    if (!API_BASE) throw new Error('API Base 未設定');
    const res = await fetch(`${API_BASE}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) {
      const t = await res.text().catch(()=>'');
      throw new Error(`${path} ${res.status} ${res.statusText}\n${t}`);
    }
    return res.json();
  }

  // Expected server functions:
  // - LoadText { path } -> { text, etag? }
  // - SaveText { path, text, etag? } -> { etag }
  // - ListFiles { prefix } -> { files: [ "client/A001/xxx.json", ... ] }
  async function loadText(path) { return apiPost('LoadText', { path }); }
  async function saveText(path, text, etag) { return apiPost('SaveText', { path, text, etag }); }
  async function listFiles(prefix) { return apiPost('ListFiles', { prefix }); }

  // ----- Index handling -----
  async function ensureIndex() {
    const folder = getClientFolder();
    const indexPath = `${folder}/${INDEX_NAME}`;
    try {
      const { text } = await loadText(indexPath);
      promptIndex = JSON.parse(text);
    } catch (e) {
      // Create initial index (roomphoto fixed)
      promptIndex = {
        version: 1,
        client: CLIENT,
        behavior: BEHAVIOR,
        items: [
          { file: 'texel-roomphoto.json', name: '画像分析プロンプト', order: 0, locked: true }
        ],
        params: {}
      };
      await saveIndex();
    }
    fileMap.clear();
    for (const it of promptIndex.items) fileMap.set(it.file, it);
  }

  async function saveIndex() {
    const folder = getClientFolder();
    const indexPath = `${folder}/${INDEX_NAME}`;
    await saveText(indexPath, JSON.stringify(promptIndex, null, 2));
  }

  // ----- List render -----
  function renderFileList() {
    fileListEl.innerHTML = '';
    const tpl = $('#fileItemTpl');

    // sort by order asc
    const items = [...promptIndex.items].sort((a,b) => (a.order ?? 0) - (b.order ?? 0));

    for (const it of items) {
      const li = tpl.content.firstElementChild.cloneNode(true);
      li.dataset.key = it.file;
      $('.title', li).textContent = it.name || toTitle(it.file);
      if (it.locked) li.classList.add('locked');
      fileListEl.appendChild(li);
    }
  }

  function toTitle(file) {
    // "texel-sumo-comment.json" -> "Suumo Comment"
    return file
      .replace(/^texel-/, '')
      .replace(/\.json$/,'')
      .split('-')
      .map(s => s.charAt(0).toUpperCase() + s.slice(1))
      .join(' ');
  }

  // ----- Events -----
  function onFileListClick(e) {
    const li = e.target.closest('.file-item');
    if (!li) return;
    const key = li.dataset.key;
    const item = fileMap.get(key);

    if (e.target.classList.contains('rename')) {
      if (item.locked) return;
      beginInlineRename(li, item);
      return;
    }
    if (e.target.classList.contains('remove')) {
      if (item.locked) return;
      removeItem(key);
      return;
    }
    if (e.target.classList.contains('drag')) {
      // no-op here (drag handled by browser if needed / or future enhancement)
      return;
    }
    // select
    selectKey(key);
  }

  function onFileListKey(e) {
    const li = e.target.closest('.file-item');
    if (!li) return;
    const key = li.dataset.key;
    const item = fileMap.get(key);
    if (e.key === 'Enter' && e.target.classList.contains('inline-edit')) {
      e.preventDefault();
      commitInlineRename(li, item, e.target.value);
    } else if (e.key === 'Escape' && e.target.classList.contains('inline-edit')) {
      e.preventDefault();
      cancelInlineRename(li, item);
    }
  }

  function beginInlineRename(li, item) {
    const titleSpan = $('.title', li);
    const old = item.name || titleSpan.textContent;
    const input = document.createElement('input');
    input.className = 'inline-edit';
    input.value = old;
    li.replaceChild(input, titleSpan);
    input.focus();
    input.select();
    input.addEventListener('blur', () => commitInlineRename(li, item, input.value));
  }

  async function commitInlineRename(li, item, value) {
    const newName = (value || '').trim();
    const span = document.createElement('span');
    span.className = 'title';
    if (!newName) {
      span.textContent = item.name || toTitle(item.file);
      li.replaceChild(span, $('.inline-edit', li));
      return;
    }
    item.name = newName;
    span.textContent = newName;
    li.replaceChild(span, $('.inline-edit', li));
    await saveIndex();
  }

  function cancelInlineRename(li, item) {
    const span = document.createElement('span');
    span.className = 'title';
    span.textContent = item.name || toTitle(item.file);
    li.replaceChild(span, $('.inline-edit', li));
  }

  async function removeItem(key) {
    const idx = promptIndex.items.findIndex(i => i.file === key);
    if (idx >= 0) {
      promptIndex.items.splice(idx, 1);
      fileMap.delete(key);
      await saveIndex();
      renderFileList();
      if (currentKey === key) clearEditor();
    }
  }

  async function onAdd() {
    const baseName = prompt('追加するファイル（例: texel-suggestion.json または suggestion）', 'suggestion');
    if (!baseName) return;
    const file = baseName.endsWith('.json') ? `texel-${baseName.replace(/^texel-/, '')}` : `texel-${baseName}.json`;
    if (fileMap.has(file)) {
      alert('すでに存在します');
      return;
    }
    const display = prompt('表示名（空で自動整形）', '');
    const order = Math.max(0, ...promptIndex.items.map(i => i.order ?? 0)) + 10;
    const item = { file, name: (display||'').trim() || toTitle(file), order };
    promptIndex.items.push(item);
    fileMap.set(file, item);
    await saveIndex();
    renderFileList();
  }

  async function selectKey(key) {
    currentKey = key;
    fileBadge.textContent = `${getClientFolder()}/${key}`;
    statusBadge.textContent = 'Loading…';
    etagBadge.textContent = '—';
    promptArea.value = '';
    paramsArea.value = JSON.stringify(promptIndex.params || {}, null, 2);

    const path = `${getClientFolder()}/${key}`;
    try {
      const { text, etag } = await loadText(path);
      currentETag = etag || null;
      etagBadge.textContent = etag || '—';
      statusBadge.textContent = 'Overridden';
      promptArea.value = text;
    } catch (e) {
      // not found -> empty
      currentETag = null;
      statusBadge.textContent = 'Missing';
      promptArea.value = '';
    }
  }

  function clearEditor() {
    currentKey = null;
    fileBadge.textContent = '未選択';
    statusBadge.textContent = '—';
    etagBadge.textContent = '—';
    promptArea.value = '';
    paramsArea.value = JSON.stringify(promptIndex?.params || {}, null, 2);
  }

  async function onSave() {
    if (!currentKey) return;
    const path = `${getClientFolder()}/${currentKey}`;
    const text = promptArea.value;
    const { etag } = await saveText(path, text, currentETag);
    currentETag = etag || null;
    etagBadge.textContent = etag || '—';
    statusBadge.textContent = 'Overridden';
  }

})();