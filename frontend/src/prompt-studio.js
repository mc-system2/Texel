/* prompt-studio.js — Right editor behaves like PromptEditor, minimal integration */
(function(){
  'use strict';

  // ---- DOM refs ----
  const $ = (s,r)=> (r||document).querySelector(s);
  const $$ = (s,r)=> Array.from((r||document).querySelectorAll(s));

  const el = {
    fileList: $('#fileList'),
    statusBadge: $('#statusBadge'),
    etagBadge: $('#etagBadge'),
    path: $('#currentPath'),
    promptTA: $('#promptEditor'),
    tabPromptBtn: $('#tabPromptBtn'),
    tabParamsBtn: $('#tabParamsBtn'),
    promptTab: $('#promptTab'),
    paramsTab: $('#paramsTab'),
    // params
    p_max_tokens: $('#param_max_tokens'),
    p_temperature: $('#param_temperature'),
    p_top_p: $('#param_top_p'),
    p_freq: $('#param_frequency_penalty'),
    p_pres: $('#param_presence_penalty'),
    p_n: $('#param_n'),
    v_max_tokens: $('#val_max_tokens'),
    v_temperature: $('#val_temperature'),
    v_top_p: $('#val_top_p'),
    v_freq: $('#val_frequency_penalty'),
    v_pres: $('#val_presence_penalty'),
    v_n: $('#val_n'),
    btnSave: $('#btnSave'),
    statusMsg: $('#statusMessage')
  };

  // ---- Tab toggle (PromptEditorと同じ挙動) ----
  function toggleTab(isPrompt){
    el.tabPromptBtn.classList.toggle('active', isPrompt);
    el.tabParamsBtn.classList.toggle('active', !isPrompt);
    el.promptTab.classList.toggle('active', isPrompt);
    el.paramsTab.classList.toggle('active', !isPrompt);
  }
  el.tabPromptBtn.addEventListener('click', ()=>toggleTab(true));
  el.tabParamsBtn.addEventListener('click', ()=>toggleTab(false));

  // ---- Params live values ----
  const bind = (range, view, digits=2)=> range && view && range.addEventListener('input', ()=> view.textContent = (+range.value).toFixed(digits));
  bind(el.p_max_tokens, el.v_max_tokens, 0);
  bind(el.p_temperature, el.v_temperature, 2);
  bind(el.p_top_p, el.v_top_p, 2);
  bind(el.p_freq, el.v_freq, 2);
  bind(el.p_pres, el.v_pres, 2);
  bind(el.p_n, el.v_n, 0);

  // ---- Demo: populate left list (your real code should replace this) ----
  const sample = ['あああああ','新規プロンプト','Suumo Catch','Athome Comment','Suumo Comment','Suggestion','Athome Appeal'];
  el.fileList.innerHTML = sample.map(name => `
    <div class="fileitem" data-name="${name}">
      <div class="grip">≡</div>
      <div class="title">${name}</div>
      <div class="meta">
        <button class="edit" title="編集">✎</button>
        <button class="del" title="削除">🗑</button>
      </div>
    </div>`).join('');

  // ---- Save (hook to your backend) ----
  el.btnSave.addEventListener('click', ()=>{
    el.statusMsg.textContent = '保存（ダミー）';
    setTimeout(()=> el.statusMsg.textContent = ' ', 1200);
  });

  // Expose tiny helpers if needed by existing code
  window.PS_TOGGLE_TAB = toggleTab;

})();