
(() => {
  // ---------- UI refs ----------
  const els = {
    clientId: document.getElementById('clientId'),
    behavior: document.getElementById('behavior'),
    apiBase: document.getElementById('apiBase'),
    fileList: document.getElementById('fileList'),
    promptEditor: document.getElementById('promptEditor'),
    paramList: document.getElementById('paramList'),
    statusChip: document.getElementById('statusChip'),
    etagChip: document.getElementById('etagChip'),
    fileTitle: document.getElementById('fileTitle'),
    btnSave: document.getElementById('btnSave'),
    btnAdd: document.getElementById('btnAddPrompt'),
    search: document.getElementById('search'),
    btnDiff: document.getElementById('btnDiff')
  };

  // ---------- State ----------
  const INDEX_FILE = 'prompt-index.json';
  const ROOM_FILE  = 'texel-roomphoto.json';
  const ROOM_NAME  = '画像分析プロンプト';
  let index = null;       // {version, client, items:[{file,name,order,hidden,fixed}]
  let current = { file:null, etag:null, params:{} };
  let dirty = false;

  // ---------- Utils ----------
  const join = (...a) => a.map((s,i) => i? String(s).replace(/^\/+/, '') : String(s).replace(/\/+$/, '')).join('/');
  function setStatus(text, tone){
    els.statusChip.textContent = text;
    els.statusChip.classList.remove('ok','warn');
    if (tone==='ok') els.statusChip.classList.add('ok');
    if (tone==='warn') els.statusChip.classList.add('warn');
  }
  function setETag(et){ els.etagChip.textContent = 'ETag: ' + (et || '—'); }
  function markDirty(){ dirty = true; setStatus('未保存の変更','warn'); }
  function clearDirty(){ dirty = false; setStatus('保存済み','ok'); }

  async function postJSON(path, body){
    const r = await fetch(path, { method:'POST', headers:{'Content-Type':'application/json; charset=utf-8'}, body: JSON.stringify(body)});
    if (!r.ok) throw new Error('HTTP '+r.status);
    return await r.json().catch(()=> ({}));
  }
  async function tryLoad(filename){
    try{
      const r = await postJSON(join(els.apiBase.value,'LoadPromptText'), { filename });
      if (r && (r.text || r.prompt || r.data)) return { etag: r.etag || null, text: r.text ?? r.prompt ?? r.data };
    }catch(e){}
    return null;
  }
  async function saveText(filename, text){
    const res = await postJSON(join(els.apiBase.value,'SavePromptText'), { filename, prompt: text });
    return res;
  }

  // ---------- Index ----------
  function normalizeIndex(){
    const cl = els.clientId.value.trim().toUpperCase();
    if (!index || !Array.isArray(index.items)) index = { version:1, client:cl, items:[] };
    // ensure roomphoto
    let room = index.items.find(i=> i.file===ROOM_FILE);
    if (!room) index.items.unshift({ file:ROOM_FILE, name:ROOM_NAME, order:1, hidden:false, fixed:true });
    else { room.name=ROOM_NAME; room.order=1; room.fixed=true; room.hidden=false; }
    // sort
    index.items.sort((a,b)=> (a.order||0)-(b.order||0));
  }

  async function loadIndex(){
    const cl = els.clientId.value.trim().toUpperCase();
    const r = await tryLoad(`client/${cl}/${INDEX_FILE}`);
    if (r && r.text){
      try{ index = typeof r.text==='string' ? JSON.parse(r.text) : r.text; }catch{ index = null; }
    }
    normalizeIndex();
    await saveIndex(); // create if missing
  }
  async function saveIndex(){
    normalizeIndex();
    const cl = els.clientId.value.trim().toUpperCase();
    await saveText(`client/${cl}/${INDEX_FILE}`, JSON.stringify(index, null, 2));
  }

  // ---------- File list UI ----------
  function renderList(){
    els.fileList.innerHTML = '';
    const q = els.search.value.trim();
    for (const item of index.items){
      if (item.hidden) continue;
      const show = !q || (item.name||item.file).includes(q) || item.file.includes(q);
      if (!show) continue;
      const li = document.createElement('div');
      li.className = 'fileitem';
      li.dataset.file = item.file;
      li.innerHTML = `
        <div class="name">${item.name||item.file}</div>
        <div class="meta">
          <span class="chip" data-chip>checking…</span>
          ${item.fixed? '<span title="固定">🔒</span>' : `
            <button class="btn sm ghost" data-op="up">↑</button>
            <button class="btn sm ghost" data-op="down">↓</button>
            <button class="btn sm ghost" data-op="rename">✎</button>
            <button class="btn sm ghost" data-op="del">削除</button>`}
        </div>`;
      // open
      li.addEventListener('click', (ev)=>{ if (ev.target.closest('[data-op]')) return; openFile(item.file); });
      // tools
      if (!item.fixed){
        li.querySelector('[data-op=up]').addEventListener('click', async (e)=>{ e.stopPropagation(); item.order=(item.order||100)-11; await saveIndex(); renderList(); });
        li.querySelector('[data-op=down]').addEventListener('click', async (e)=>{ e.stopPropagation(); item.order=(item.order||100)+11; await saveIndex(); renderList(); });
        li.querySelector('[data-op=rename]').addEventListener('click', async (e)=>{ e.stopPropagation(); const nn = prompt('表示名を入力', item.name||item.file); if (!nn) return; item.name = nn; await saveIndex(); renderList(); });
        li.querySelector('[data-op=del]').addEventListener('click', async (e)=>{ e.stopPropagation(); if (!confirm('一覧から削除します（ファイルは消えません）')) return; index.items = index.items.filter(x=>x!==item); await saveIndex(); renderList(); });
      }
      els.fileList.appendChild(li);

      // chip
      (async()=>{
        const cl = els.clientId.value.trim().toUpperCase();
        const r = await tryLoad(`client/${cl}/${item.file}`);
        const chip = li.querySelector('[data-chip]');
        if (r) chip.textContent='Overridden', chip.classList.add('ok');
        else chip.textContent='Missing', chip.classList.add('warn');
      })();
    }
    // active mark
    [...els.fileList.children].forEach(n=> n.classList.toggle('active', n.dataset.file===current.file));
  }

  // ---------- Open & Save ----------
  async function openFile(file){
    if (dirty && !confirm('未保存の変更があります。破棄しますか？')) return;
    setStatus('読込中…');
    const cl = els.clientId.value.trim().toUpperCase();
    const candidates = [`client/${cl}/${file}`, file];
    let txt = '', etag=null, used=null;
    for (const f of candidates){
      const r = await tryLoad(f);
      if (r){ etag = r.etag || null; used=f; txt = typeof r.text==='string'? r.text : JSON.stringify(r.text, null, 2); break; }
    }
    current.file = file;
    current.etag = used && used.startsWith('client/') ? etag : null;
    els.fileTitle.textContent = `client/${cl}/${file}`;
    els.promptEditor.value = txt || '';
    setETag(current.etag);
    setStatus(current.etag ? 'Overridden' : 'Template（未上書き）', current.etag? 'ok':'warn');
    clearDirty();
    renderList();
  }

  async function saveCurrent(){
    if (!current.file){ alert('ファイル未選択'); return; }
    const cl = els.clientId.value.trim().toUpperCase();
    const path = `client/${cl}/${current.file}`;
    const txt = els.promptEditor.value;
    await saveText(path, txt);
    current.etag = 'saved';
    setETag('saved');
    clearDirty();
    renderList();
  }

  // ---------- Boot ----------
  async function boot(){
    // hydrate API base from URL param
    const url = new URL(location.href);
    const api = url.searchParams.get('api'); if (api) els.apiBase.value = api;

    els.promptEditor.addEventListener('input', markDirty);
    els.btnSave.addEventListener('click', saveCurrent);
    document.addEventListener('keydown', (e)=>{ if (e.ctrlKey && e.key.toLowerCase()==='s'){ e.preventDefault(); saveCurrent(); } });
    els.btnAdd.addEventListener('click', async ()=>{
      const name = prompt('表示名（例：スーモコメント v2）'); if (!name) return;
      const file = prompt('ファイル名（.json 推奨）'); if (!file) return;
      if (index.items.some(i=>i.file===file)){ alert('同名ファイルがあります'); return; }
      const max = Math.max(...index.items.map(i=> i.order||100), 100);
      index.items.push({ file, name, order:max+10, hidden:false });
      await saveIndex();
      renderList();
    });
    els.search.addEventListener('input', renderList);

    await loadIndex();
    renderList();
    openFile(ROOM_FILE);
  }

  window.addEventListener('DOMContentLoaded', boot);
})(); 
