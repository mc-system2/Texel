
(() => {
  const $ = (s, el=document) => el.querySelector(s);
  const $$ = (s, el=document) => Array.from(el.querySelectorAll(s));

  let API_BASE = '';
  let currentClient = '';
  let currentBehavior = 'BASE';
  let indexPath = '';
  let promptIndex = null;
  let etagIndex = null;
  let currentItem = null;

  const REQUIRED_ROOMPHOTO = {
    file: 'texel-roomphoto.json',
    name: '画像分析プロンプト',
    order: 0,
    locked: true
  };

  function apiUrl(fn) {
    let base = $('#apiBase').value.trim();
    if (!base) throw new Error('API Base 未設定');
    if (!base.endsWith('/')) base += '/';
    return base + fn;
  }
  async function apiPost(fn, body) {
    const res = await fetch(apiUrl(fn), {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body||{})
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`${fn} ${res.status}: ${t}`);
    }
    return res.json();
  }

  const loadText = (path) => apiPost('LoadText', { path });
  const saveText = (path, text, etag) => apiPost('SaveText', { path, text, etag });
  const listFiles = (prefix) => apiPost('ListFiles', { prefix });

  function getClientFolder() {
    return `client/${currentClient}/`;
  }
  function getIndexPath() {
    return getClientFolder() + 'prompt-index.json';
  }

  function normalizeNameFromFile(file) {
    // texel-suumo-comment.json → Suumo Comment
    const m = file.replace(/^texel-/, '').replace(/\.json$/,'').split('-');
    return m.map(x => x.charAt(0).toUpperCase() + x.slice(1)).join(' ');
  }

  async function ensurePromptIndex() {
    indexPath = getIndexPath();
    try {
      const { text, etag } = await loadText(indexPath);
      etagIndex = etag || null;
      promptIndex = JSON.parse(text);
      // 実装差異に備え
      if (!promptIndex || !Array.isArray(promptIndex.prompts)) throw new Error('invalid index');
    } catch (e) {
      // 404想定 → 新規作成
      const { files } = await listFiles(getClientFolder());
      const items = files
        .filter(f => f.endsWith('.json') && f !== 'prompt-index.json')
        .map((f, i) => ({
          file: f.split('/').pop(),
          name: f.includes('roomphoto') ? '画像分析プロンプト' : normalizeNameFromFile(f.split('/').pop()),
          order: (i+1)*10,
          hidden: false,
          locked: f.includes('roomphoto')
        }));

      // 先頭に roomphoto 固定（無ければ追加）
      const hasRoom = items.some(x => x.file.includes('roomphoto'));
      if (!hasRoom) items.unshift(REQUIRED_ROOMPHOTO);
      else {
        // 確実に最上段へ
        items.sort((a,b) => (a.file.includes('roomphoto')?-1:1));
        items[0].order = 0; items[0].locked = true; items[0].name = '画像分析プロンプト';
      }

      promptIndex = { version: 1, client: currentClient, behavior: currentBehavior, prompts: items, params:{} };
      const { etag } = await saveText(indexPath, JSON.stringify(promptIndex, null, 2), null);
      etagIndex = etag || null;
    }
  }

  function renderFileList() {
    const ul = $('#fileList');
    ul.innerHTML = '';
    if (!promptIndex || !Array.isArray(promptIndex.prompts)) return;

    const sorted = [...promptIndex.prompts].sort((a,b)=> (a.order??0)-(b.order??0));
    for (const item of sorted) {
      // 検索フィルタ対応
      const q = $('#search').value.trim().toLowerCase();
      if (q && !(item.name||'').toLowerCase().includes(q) && !(item.file||'').toLowerCase().includes(q)) continue;

      const li = document.createElement('li');
      li.className = 'fileItem'+(item.locked?' locked':'');
      li.dataset.file = item.file;

      const drag = document.createElement('span');
      drag.className = 'drag'; drag.textContent = '≡';
      li.appendChild(drag);

      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = item.name || normalizeNameFromFile(item.file);
      li.appendChild(title);

      // rename（インライン）
      if (!item.locked) {
        const btnEdit = document.createElement('button');
        btnEdit.className='btn'; btnEdit.textContent='✎';
        btnEdit.title='名称変更';
        btnEdit.addEventListener('click', ()=> inlineRename(li, item, title));
        li.appendChild(btnEdit);
      }

      // delete
      if (!item.locked) {
        const btnDel = document.createElement('button');
        btnDel.className='btn'; btnDel.textContent='🗑';
        btnDel.title='削除';
        btnDel.addEventListener('click', async ()=> {
          if (!confirm(`「${item.name}」を一覧から削除しますか？（ファイルは削除しません）`)) return;
          promptIndex.prompts = promptIndex.prompts.filter(x=>x!==item);
          await saveIndex();
          renderFileList();
        });
        li.appendChild(btnDel);
      }

      // select
      li.addEventListener('click', ()=> openItem(item));

      ul.appendChild(li);
    }
  }

  async function openItem(item) {
    currentItem = item;
    $('#currentFile').textContent = getClientFolder()+item.file;
    $('#status').textContent = item.locked ? 'Locked' : '—';
    $('#etag').textContent = '—';
    $('#editor').value = '読み込み中…';
    try {
      const { text, etag } = await loadText(getClientFolder()+item.file);
      $('#editor').value = text;
      $('#etag').textContent = etag || '—';
    } catch(e) {
      $('#editor').value = `// 読み込み失敗: ${e.message}`;
    }
  }

  function inlineRename(li, item, titleEl) {
    const input = document.createElement('input');
    input.className='inline';
    input.value = item.name || normalizeNameFromFile(item.file);
    li.replaceChild(input, titleEl);
    input.focus();
    input.select();
    const cancel = () => {
      li.replaceChild(titleEl, input);
    };
    const commit = async () => {
      item.name = input.value.trim() || normalizeNameFromFile(item.file);
      titleEl.textContent = item.name;
      li.replaceChild(titleEl, input);
      await saveIndex();
      renderFileList();
    };
    input.addEventListener('keydown',(ev)=>{
      if (ev.key==='Enter') commit();
      if (ev.key==='Escape') cancel();
    });
    input.addEventListener('blur', commit);
  }

  async function saveIndex() {
    const { etag } = await saveText(indexPath, JSON.stringify(promptIndex, null, 2), etagIndex);
    etagIndex = etag || null;
  }

  async function boot() {
    // URL パラメータから復元
    const usp = new URLSearchParams(location.hash.replace(/^#\?/,'?'));
    currentClient = usp.get('client') || $('#client').value || 'A001';
    currentBehavior = usp.get('behavior') || $('#behavior').value || 'BASE';
    const api = usp.get('api') || $('#apiBase').value;
    $('#client').value = currentClient;
    $('#behavior').value = currentBehavior;
    if (api) $('#apiBase').value = api;

    // 主要イベント
    $('#search').addEventListener('input', renderFileList);
    $('#btnAdd').addEventListener('click', async () => {
      // 新規エントリ（空のプレースホルダ）
      const fname = prompt('新しいプロンプトのファイル名（.json）', 'custom-prompt.json');
      if (!fname) return;
      const item = { file: fname, name: normalizeNameFromFile(fname), order: ((promptIndex.prompts?.length||0)+1)*10, hidden:false };
      promptIndex.prompts.push(item);
      await saveIndex();
      renderFileList();
    });
    $('#btnSave').addEventListener('click', async ()=>{
      if (!currentItem) return;
      await saveText(getClientFolder()+currentItem.file, $('#editor').value, null);
      alert('保存しました');
    });
    window.addEventListener('keydown', (e)=>{
      if (e.ctrlKey && e.key.toLowerCase()==='s') { e.preventDefault(); $('#btnSave').click(); }
    });

    await ensurePromptIndex();
    renderFileList();
  }

  // init
  window.addEventListener('DOMContentLoaded', boot);
})();
