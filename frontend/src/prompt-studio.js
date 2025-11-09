
(() => {
  const $ = (id)=> document.getElementById(id);
  const els = {
    clientId: $('clientId'), behavior:$('behavior'), apiBase:$('apiBase'),
    fileList:$('fileList'), search:$('search'), btnAdd:$('btnAddPrompt'),
    promptEditor:$('promptEditor'), paramList:$('paramList'),
    status:$('statusChip'), etag:$('etagChip'), fileTitle:$('fileTitle'),
    btnSave:$('btnSave')
  };

  const INDEX_FILE = 'prompt-index.json';
  const ROOM_FILE  = 'texel-roomphoto.json';
  const ROOM_NAME  = '画像分析プロンプト';

  let index = null;
  let current = { file:null, etag:null };
  let dirty = false;

  const join = (...a)=> a.map((s,i)=>i? String(s).replace(/^\/+/,''):String(s).replace(/\/+$/,'')).join('/');
  function setStatus(text, tone){
    els.status.textContent = text;
    els.status.classList.remove('ok','warn');
    if (tone==='ok') els.status.classList.add('ok');
    if (tone==='warn') els.status.classList.add('warn');
  }
  function setEtag(et){ els.etag.textContent = 'ETag: ' + (et || '—'); }
  function markDirty(){ dirty = true; setStatus('未保存の変更','warn'); }
  function clearDirty(){ dirty = false; setStatus('保存済み','ok'); }

  async function postJSON(path, body){
    const r = await fetch(path, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)});
    if (!r.ok) throw new Error('HTTP '+r.status);
    return await r.json().catch(()=> ({}));
  }
  async function tryLoad(filename){
    try{
      const r = await postJSON(join(els.apiBase.value,'LoadPromptText'), { filename });
      if (r && (r.text || r.prompt || r.data)) return { etag:r.etag||null, text:r.text ?? r.prompt ?? r.data };
    }catch(e){}
    return null;
  }
  async function saveText(filename, text){
    return await postJSON(join(els.apiBase.value,'SavePromptText'), { filename, prompt:text });
  }

  function normalizeIndex(){
    const client = els.clientId.value.trim().toUpperCase();
    if (!index || !Array.isArray(index.items)) index = { version:1, client, items:[] };
    let room = index.items.find(i=> i.file===ROOM_FILE);
    if (!room) index.items.unshift({ file:ROOM_FILE, name:ROOM_NAME, order:1, hidden:false, fixed:true });
    else { room.name=ROOM_NAME; room.order=1; room.hidden=false; room.fixed=true; }
    index.items.sort((a,b)=> (a.order||0)-(b.order||0));
  }

  async function loadIndex(){
    const client = els.clientId.value.trim().toUpperCase();
    const r = await tryLoad(`client/${client}/${INDEX_FILE}`);
    if (r && r.text){
      try { index = typeof r.text==='string'? JSON.parse(r.text): r.text; } catch { index = null; }
    }
    normalizeIndex();
    await saveIndex();
  }

  async function saveIndex(){
    normalizeIndex();
    const client = els.clientId.value.trim().toUpperCase();
    await saveText(`client/${client}/${INDEX_FILE}`, JSON.stringify(index, null, 2));
  }

  function renderList(){
    els.fileList.innerHTML = '';
    const q = els.search.value.trim();
    for (const it of index.items){
      if (it.hidden) continue;
      const show = !q || (it.name||it.file).includes(q) || it.file.includes(q);
      if (!show) continue;

      const row = document.createElement('div');
      row.className = 'item';
      row.dataset.file = it.file;
      row.innerHTML = `
        <div class="name">${it.name || it.file}</div>
        <div class="meta">
          <span class="chip" data-chip>checking…</span>
          ${it.fixed ? '<span title="固定">🔒</span>' : `
            <button class="sm" data-op="up">↑</button>
            <button class="sm" data-op="down">↓</button>
            <button class="sm" data-op="rename">✎</button>
            <button class="sm" data-op="del">削除</button>
          `}
        </div>
      `;
      row.addEventListener('click', (ev)=>{ if (ev.target.closest('[data-op]')) return; openFile(it.file); });
      if (!it.fixed){
        row.querySelector('[data-op=up]').addEventListener('click', async (e)=>{ e.stopPropagation(); it.order=(it.order||100)-11; await saveIndex(); renderList(); });
        row.querySelector('[data-op=down]').addEventListener('click', async (e)=>{ e.stopPropagation(); it.order=(it.order||100)+11; await saveIndex(); renderList(); });
        row.querySelector('[data-op=rename]').addEventListener('click', async (e)=>{ e.stopPropagation(); const nn = prompt('表示名', it.name||it.file); if (!nn) return; it.name = nn; await saveIndex(); renderList(); });
        row.querySelector('[data-op=del]').addEventListener('click', async (e)=>{ e.stopPropagation(); if (!confirm('一覧から削除します（ファイルは消しません）')) return; index.items = index.items.filter(x=>x!==it); await saveIndex(); renderList(); });
      }
      els.fileList.appendChild(row);

      (async ()=>{
        const client = els.clientId.value.trim().toUpperCase();
        const res = await tryLoad(`client/${client}/${it.file}`);
        const chip = row.querySelector('[data-chip]');
        if (res) chip.textContent='Overridden', chip.classList.add('ok');
        else chip.textContent='Missing', chip.classList.add('warn');
      })();
    }
    [...els.fileList.children].forEach(n=> n.classList.toggle('active', n.dataset.file===current.file));
  }

  async function openFile(file){
    if (dirty && !confirm('未保存の変更があります。破棄しますか？')) return;
    setStatus('読込中…');
    const client = els.clientId.value.trim().toUpperCase();
    const candidates = [`client/${client}/${file}`, file];
    let txt = '', etag=null, used=null;
    for (const f of candidates){
      const r = await tryLoad(f);
      if (r){ etag = r.etag||null; used=f; txt = typeof r.text==='string'? r.text : JSON.stringify(r.text, null, 2); break; }
    }
    current.file = file;
    current.etag = used && used.startsWith('client/') ? etag : null;
    els.fileTitle.textContent = `client/${client}/${file}`;
    els.promptEditor.value = txt || '';
    setEtag(current.etag);
    setStatus(current.etag ? 'Overridden' : 'Template（未上書き）', current.etag? 'ok':'warn');
    clearDirty();
    renderList();
  }

  async function saveCurrent(){
    if (!current.file){ alert('ファイル未選択'); return; }
    const client = els.clientId.value.trim().toUpperCase();
    const path = `client/${client}/${current.file}`;
    await saveText(path, els.promptEditor.value);
    current.etag = 'saved';
    setEtag('saved'); clearDirty(); renderList();
  }

  async function boot(){
    const api = new URL(location.href).searchParams.get('api'); if (api) els.apiBase.value = api;
    els.promptEditor.addEventListener('input', markDirty);
    els.btnSave.addEventListener('click', saveCurrent);
    document.addEventListener('keydown', (e)=>{ if (e.ctrlKey && e.key.toLowerCase()==='s'){ e.preventDefault(); saveCurrent(); }});
    els.btnAdd.addEventListener('click', async ()=>{
      const name = prompt('表示名（例：スーモコメント v2）'); if (!name) return;
      const file = prompt('ファイル名（.json 推奨）'); if (!file) return;
      if (index.items.some(i=>i.file===file)){ alert('同名ファイルがあります'); return; }
      const max = Math.max(...index.items.map(i=> i.order||100), 100);
      index.items.push({ file, name, order:max+10, hidden:false });
      await saveIndex(); renderList();
    });
    els.search.addEventListener('input', renderList);

    await loadIndex();
    renderList();
    openFile(ROOM_FILE);
  }

  window.addEventListener('DOMContentLoaded', boot);
})();
