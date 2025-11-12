(function(){
  "use strict";

  /* ========= ENV ========= */
  const $  = (s, r)=> (r||document).querySelector(s);
  const $$ = (s, r)=> Array.from((r||document).querySelectorAll(s));
  const qs = new URLSearchParams(location.search);

  // FUNCTION_BASE 優先順: query > input(localStorage初期値) > localStorage > window.FUNCTION_BASE
  const envInput = $('#env-function-base');
  const pathInput = $('#env-client-path');

  const initialFunctionBase =
    qs.get('FUNCTION_BASE') ||
    localStorage.getItem('FUNCTION_BASE') ||
    (window.FUNCTION_BASE || '');

  const initialClientPath =
    qs.get('path') ||
    localStorage.getItem('CLIENT_PATH') ||
    'client/A001/';

  envInput.value = initialFunctionBase;
  pathInput.value = initialClientPath;

  let FUNCTION_BASE = initialFunctionBase;
  let CLIENT_PATH   = initialClientPath;

  function showEnvGuard(){
    const list = $('#prompt-list');
    if (list) {
      list.innerHTML = '<div class="ps-item" style="justify-content:center;gap:8px;background:#fff"><span>右上の <b>FUNCTION_BASE</b> と <b>Client Path</b> を設定し、<b>適用</b>を押してください。</span></div>';
    }
    $('#status').textContent = 'FUNCTION_BASE未設定：適用後にインデックスを読み込みます。';
  }

  $('#env-apply').addEventListener('click', ()=>{
    FUNCTION_BASE = envInput.value.trim();
    CLIENT_PATH   = pathInput.value.trim() || 'client/A001/';
    localStorage.setItem('FUNCTION_BASE', FUNCTION_BASE);
    localStorage.setItem('CLIENT_PATH', CLIENT_PATH);
    info('環境を適用しました。');
    refreshIndex();
  });

  /* ========= STATE ========= */
  const state = {
    index: [],           // [{name, filename}]
    active: null,        // {name, filename}
    activeJson: null     // last loaded JSON object (normalized)
  };

  /* ========= HELPERS ========= */
  function info(msg){ $('#status').textContent = msg || ''; }
  function err(e){ $('#status').textContent = (e && e.message) ? e.message : (e+'');
                   console.error(e); }

  function apiUrl(path, params){
    const base = (FUNCTION_BASE||'').trim();
    if (!base) { throw new Error('FUNCTION_BASE未設定です（右上で設定→適用）。'); }
    const u = new URL(base.replace(/\/+$/,'') + '/' + path.replace(/^\/+/,'') );
    if (params && typeof params === 'object') {
      Object.entries(params).forEach(([k,v])=> u.searchParams.set(k, v));
    }
    return u.toString();
  }

  async function apiGET(path, params){
    const url = apiUrl(path, params);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} at GET ${url}`);
    return await res.json();
  }
  async function apiPOST(path, params, body){
    const url = apiUrl(path, params);
    const res = await fetch(url, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body ?? {}, null, 2)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} at POST ${url}`);
    return await res.json();
  }

  /* ========= NORMALIZER ========= */
  function normalizePromptPayload(payload){
    const empty = { prompt:{}, params:{} };
    if (!payload || typeof payload !== 'object') return empty;

    // 正しい形（prompt の中に prompt フィールドが無い）
    if (payload.prompt && typeof payload.prompt === 'object' && !('prompt' in payload.prompt)) {
      return { prompt: payload.prompt, params: payload.params ?? {} };
    }
    // 典型的な誤り: { prompt:{ prompt:"", params:{} }, params:{} }
    if (payload.prompt && typeof payload.prompt === 'object' && ('prompt' in payload.prompt)) {
      return {
        prompt: (typeof payload.prompt.prompt === 'object') ? payload.prompt.prompt : {},
        // prompt.params を優先、なければトップの params
        params: (payload.prompt.params && typeof payload.prompt.params === 'object')
          ? payload.prompt.params
          : (payload.params ?? {})
      };
    }
    // それ以外の曖昧ケース
    return {
      prompt: (payload.prompt && typeof payload.prompt === 'object') ? payload.prompt : {},
      params: (payload.params && typeof payload.params === 'object') ? payload.params : {}
    };
  }

  const NEW_PROMPT_TEMPLATE = { prompt:{}, params:{} };

  /* ========= INDEX I/O =========
     ※ 環境に合わせて必要なら関数名を変更してください。
     - LoadPromptIndex?path=client/A001/
     - SavePromptIndex?path=client/A001/  (body: index配列)
  */
  async function loadIndex(){
    const data = await apiGET('LoadPromptIndex', { path: CLIENT_PATH });
    if (Array.isArray(data)) return data;
    // 互換: オブジェクト形式 { items:[...] } にも対応
    if (data && Array.isArray(data.items)) return data.items;
    return [];
  }
  async function saveIndex(indexArr){
    return await apiPOST('SavePromptIndex', { path: CLIENT_PATH }, indexArr);
  }

  /* ========= PROMPT I/O =========
     - LoadPromptText?filename=client/A001/foo.json
     - SavePromptText?filename=...
  */
  async function loadPrompt(filename){
    const full = CLIENT_PATH + filename;
    const data = await apiGET('LoadPromptText', { filename: full });
    return normalizePromptPayload(data);
  }
  async function savePrompt(filename, payload){
    const full = CLIENT_PATH + filename;
    const normalized = normalizePromptPayload(payload);
    return await apiPOST('SavePromptText', { filename: full }, normalized);
  }

  /* ========= UI RENDER ========= */
  function renderList(){
    const list = $('#prompt-list');
    list.innerHTML = '';
    state.index.forEach((it)=>{
      const item = document.createElement('div');
      item.className = 'ps-item' + ((state.active && state.active.filename===it.filename)?' active':'');
      item.innerHTML = `
        <div class="ps-item-name" title="${it.name||''}">${escapeHtml(it.name||'（無題）')}</div>
        <div class="ps-item-file">${escapeHtml(it.filename||'')}</div>
      `;
      item.addEventListener('click', ()=> selectItem(it));
      list.appendChild(item);
    });
  }

  function escapeHtml(s){
    return (s||'').replace(/[&<>"']/g, m => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[m]));
  }

  async function selectItem(it){
    try{
      state.active = { ...it };
      $('#active-file').textContent = `${it.name}  —  ${it.filename}`;
      $('#btn-rename').disabled = false;
      $('#btn-delete').disabled = false;
      $('#btn-save').disabled   = false;

      info('読込中...');
      const obj = await loadPrompt(it.filename);
      state.activeJson = obj;
      $('#json-editor').value = JSON.stringify(obj, null, 2);
      renderList();
      info('読み込み完了');
    }catch(e){ err(e); }
  }

  /* ========= COMMANDS ========= */
  async function refreshIndex(){
    try{
      info('インデックス取得中...');
      const idx = await loadIndex();
      state.index = idx.filter(Boolean);
      renderList();
      info('インデックス更新');
    }catch(e){ err(e); }
  }

  async function cmdAdd(){
    try{
      const name = prompt('新しいプロンプトの名称を入力してください', '新規プロンプト');
      if (!name) return;

      // ファイル名はシステム生成（texel-custom-yyyymmdd-hhmmss.json）
      const dt = new Date();
      const fn = `texel-custom-${dt.getFullYear()}${String(dt.getMonth()+1).padStart(2,'0')}${String(dt.getDate()).padStart(2,'0')}-${String(dt.getHours()).padStart(2,'0')}${String(dt.getMinutes()).padStart(2,'0')}${String(dt.getSeconds()).padStart(2,'0')}.json`;

      info('作成中...');
      await savePrompt(fn, NEW_PROMPT_TEMPLATE);

      // index に追記
      const newEntry = { name, filename: fn };
      state.index.push(newEntry);
      await saveIndex(state.index);
      renderList();

      // 自動選択
      await selectItem(newEntry);
      info('新規作成完了');
    }catch(e){ err(e); }
  }

  async function cmdRename(){
    if (!state.active) return;
    const newName = prompt('新しい名称を入力してください', state.active.name || '');
    if (!newName) return;
    try{
      // index 更新
      const target = state.index.find(x => x.filename === state.active.filename);
      if (target){ target.name = newName; }
      await saveIndex(state.index);
      state.active.name = newName;
      $('#active-file').textContent = `${state.active.name}  —  ${state.active.filename}`;
      renderList();
      info('名称を変更しました');
    }catch(e){ err(e); }
  }

  async function cmdDelete(){
    if (!state.active) return;
    if (!confirm(`削除しますか？\n${state.active.name}  —  ${state.active.filename}\n※BLOB本体の削除は関数側の実装に依存します`)) return;
    try{
      // インデックスから除去（BLOB本体の削除は SavePromptIndex 側の運用に合わせてください）
      state.index = state.index.filter(x => x.filename !== state.active.filename);
      await saveIndex(state.index);
      state.active = null;
      state.activeJson = null;
      $('#active-file').textContent = '（未選択）';
      $('#json-editor').value = '';
      $('#btn-rename').disabled = true;
      $('#btn-delete').disabled = true;
      $('#btn-save').disabled   = true;
      renderList();
      info('削除しました（インデックス）');
    }catch(e){ err(e); }
  }

  async function cmdSave(){
    if (!state.active) return;
    try{
      const raw = $('#json-editor').value;
      let obj;
      try{
        obj = JSON.parse(raw);
      }catch(parseErr){
        throw new Error('JSONの構文エラーです。保存できません。');
      }
      info('保存中（正規化適用）...');
      await savePrompt(state.active.filename, obj);
      // 反映確認として正規化後を再ロード
      const reloaded = await loadPrompt(state.active.filename);
      state.activeJson = reloaded;
      $('#json-editor').value = JSON.stringify(reloaded, null, 2);
      info('保存しました');
    }catch(e){ err(e); }
  }

  async function cmdRepair(){
    if (!state.index.length){
      info('インデックスが空です');
      return;
    }
    try{
      info('一括修復を開始します...');
      for (const it of state.index){
        try{
          const cur = await loadPrompt(it.filename);
          await savePrompt(it.filename, cur); // 正規化形で上書き
          console.log('Repaired:', it.filename);
        }catch(inner){
          console.warn('Skip:', it.filename, inner);
        }
      }
      info('一括修復が完了しました');
    }catch(e){ err(e); }
  }

  /* ========= EVENTS ========= */
  $('#btn-add').addEventListener('click', cmdAdd);
  $('#btn-rename').addEventListener('click', cmdRename);
  $('#btn-delete').addEventListener('click', cmdDelete);
  $('#btn-save').addEventListener('click', cmdSave);
  $('#btn-repair').addEventListener('click', cmdRepair);

  // エディタ編集時、まだ保存してないよヒントを出す
  $('#json-editor').addEventListener('input', ()=>{
    if (!state.active) return;
    $('#status').textContent = '未保存の変更があります…';
  });

  // 初期ロード（FUNCTION_BASE未設定なら案内を表示し、設定後に読み込む）
  if ((FUNCTION_BASE||'').trim()) {
    refreshIndex();
  } else {
    showEnvGuard();
  }

})();