
(() => {
  const $ = (s, el=document) => el.querySelector(s);
  const $$ = (s, el=document) => Array.from(el.querySelectorAll(s));

  let currentClient = '';
  let currentBehavior = 'BASE';
  let indexPath = '';
  let promptIndex = null;
  let etagIndex = null;
  let currentItem = null;

  // --- API helpers -----------------------------------------------------------
  function apiUrl(fn) {
    let base = $('#apiBase').value.trim();
    if (!base) throw new Error('API Base 未設定');
    if (!base.endsWith('/')) base += '/';
    return base + fn;
  }

  async function apiPostRaw(fn, body) {
    const res = await fetch(apiUrl(fn), {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body||{})
    });
    return res;
  }

  async function apiPostMulti(fnCandidates, bodyCandidates) {
    let lastErr = null;
    for (const fn of fnCandidates) {
      for (const body of bodyCandidates) {
        try {
          const res = await apiPostRaw(fn, body);
          if (res.status === 404) { lastErr = new Error(`${fn} 404`); continue; }
          if (!res.ok) {
            const t = await res.text().catch(()=>'');
            lastErr = new Error(`${fn} ${res.status}: ${t}`);
            continue;
          }
          const json = await res.json();
          return { json, fn, body };
        } catch (e) {
          lastErr = e;
        }
      }
    }
    throw lastErr || new Error('API call failed');
  }

  // candidates for function names
  const FN = {
    LOAD: ['LoadPromptText','LoadText','LoadBLOB','LoadFile'],
    SAVE: ['SavePromptText','SaveText','SaveBLOB','SaveFile'],
    LIST: ['ListBLOB','ListFiles','ListBlob','List']
  };

  function getClientFolder() { return `client/${currentClient}/`; }
  function getIndexPath() { return getClientFolder() + 'prompt-index.json'; }

  // Normalizers for varied API response shapes
  function normalizeLoad(resp) {
    // {text,etag} or {content,etag} or {body}
    if (typeof resp === 'string') return { text: resp, etag: null };
    const t = resp.text ?? resp.content ?? resp.body ?? '';
    const e = resp.etag ?? resp.ETag ?? null;
    return { text: t, etag: e };
  }

  function normalizeList(resp, folder) {
    // Possible shapes:
    // { files:["client/A001/texel-...json", ...] }
    // { blobs:[{name:"client/A001/.."}, ...] }
    // [{name:"client/A001/.."}, ...]
    // ["client/A001/..", ...]
    let list = [];
    if (Array.isArray(resp)) list = resp;
    else if (resp && Array.isArray(resp.files)) list = resp.files;
    else if (resp && Array.isArray(resp.blobs)) list = resp.blobs;
    else if (resp && Array.isArray(resp.items)) list = resp.items;
    // map to strings
    list = list.map(x => typeof x === 'string' ? x : (x.name ?? x.path ?? x.url ?? ''));
    // keep only json under folder
    list = list.filter(x => x && x.endsWith('.json') && x.startsWith(folder));
    return list;
  }

  async function loadText(path) {
    const bodies = [{ path }, { key: path }, { file: path }];
    const { json } = await apiPostMulti(FN.LOAD, bodies);
    return normalizeLoad(json);
  }

  async function saveText(path, text, etag) {
    const bodies = [
      { path, text, etag },
      { file: path, content: text, etag },
      { key: path, body: text, etag }
    ];
    const { json } = await apiPostMulti(FN.SAVE, bodies);
    return normalizeLoad(json);
  }

  async function listFiles(prefix) {
    // try prefix, then {container,folder}
    const container = 'prompts';
    const folder = prefix;
    const bodies = [
      { prefix },
      { path: prefix },
      { container, folder },
      { container, path: folder },
    ];
    const { json } = await apiPostMulti(FN.LIST, bodies);
    return { files: normalizeList(json, prefix) };
  }

  const REQUIRED_ROOMPHOTO = {
    file: 'texel-roomphoto.json',
    name: '画像分析プロンプト',
    order: 0,
    locked: true
  };

  function normalizeNameFromFile(file) {
    const m = file.replace(/^texel-/, '').replace(/\.json$/,'').split('-');
    return m.map(x => x.charAt(0).toUpperCase() + x.slice(1)).join(' ');
  }

  async function ensurePromptIndex() {
    indexPath = getIndexPath();
    try {
      const { text, etag } = await loadText(indexPath);
      etagIndex = etag || null;
      promptIndex = JSON.parse(text);
      if (!promptIndex || !Array.isArray(promptIndex.prompts)) throw new Error('invalid index');
    } catch (e) {
      const { files } = await listFiles(getClientFolder());
      const items = files
        .filter(f => f.endsWith('.json') && !f.endsWith('prompt-index.json'))
        .map((f, i) => {
          const file = f.split('/').pop();
          return {
            file,
            name: file.includes('roomphoto') ? '画像分析プロンプト' : normalizeNameFromFile(file),
            order: (i+1)*10,
            hidden: false,
            locked: file.includes('roomphoto')
          };
        });

      const hasRoom = items.some(x => x.file.includes('roomphoto'));
      if (!hasRoom) items.unshift(REQUIRED_ROOMPHOTO);
      else {
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

      if (!item.locked) {
        const btnEdit = document.createElement('button');
        btnEdit.className='btn'; btnEdit.textContent='✎';
        btnEdit.title='名称変更';
        btnEdit.addEventListener('click', ()=> inlineRename(li, item, title));
        li.appendChild(btnEdit);
      }

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
    input.focus(); input.select();
    const cancel = () => li.replaceChild(titleEl, input);
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
    const usp = new URLSearchParams(location.hash.replace(/^#\?/,'?'));
    currentClient = usp.get('client') || $('#client').value || 'A001';
    currentBehavior = usp.get('behavior') || $('#behavior').value || 'BASE';
    const api = usp.get('api') || $('#apiBase').value;
    $('#client').value = currentClient;
    $('#behavior').value = currentBehavior;
    if (api) $('#apiBase').value = api;

    $('#search').addEventListener('input', renderFileList);
    $('#btnAdd').addEventListener('click', async () => {
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

  window.addEventListener('DOMContentLoaded', boot);
})();
