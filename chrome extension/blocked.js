const q = (s)=>document.querySelector(s);
function showUser(u){ q("#user").textContent = u?.email ? `User: ${u.email} (hd: ${u.hd||"—"})` : "User: —"; }

// 現在のユーザー表示
chrome.runtime.sendMessage({type:"TEXEL_GET_USER"}, (r)=> showUser(r?.user));

// サインイン実行 → 許可されれば BG 側が sidePanel を texel.html に切替
q("#btn").addEventListener("click", ()=>{
  chrome.runtime.sendMessage({type:"TEXEL_GATE_SIGNIN"}, (res)=>{
    if (res?.allowed) {
      chrome.runtime.sendMessage({type:"TEXEL_GET_USER"}, (r)=> showUser(r?.user));
      // パネルを開き直すと反映。必要なら BG を拡張して当該 tabId に対し setOptions を再実行してもOK
    } else {
      alert("会社アカウントでのサインインが必要です。");
    }
  });
});
