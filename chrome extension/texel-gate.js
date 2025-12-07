// texel-gate.js  — Gate(会社ドメインチェック)を外部JSに分離
(function(){
  const $ = (s)=>document.querySelector(s);
  const hide = (el)=> el && (el.style.display = "none");
  const show = (el)=> el && (el.style.display = "");
  const disableAll = (flag)=> {
    document.querySelectorAll("section, #property-code-modal").forEach(el=>{
      if (flag) el.classList.add("disabled"); else el.classList.remove("disabled");
    });
  };

  const gateOverlay = $("#gate-overlay");
  const gateMsg = $("#gate-msg");
  const gateRetry = $("#gate-retry");
  const bannerUser = $("#banner-user");

  async function sendRuntime(msg){
    return new Promise((resolve)=> chrome.runtime.sendMessage(msg, resolve));
  }
  async function log(event, detail){
    await sendRuntime({ type:"TEXEL_LOG", event, detail });
  }

  async function afterAllowed(){
    const r = await sendRuntime({ type:"TEXEL_GET_USER" });
    const u = r && r.user;
    if (u?.email) bannerUser.textContent = `— ${u.email}`;
    disableAll(false);
    hide(gateOverlay);
    await log("open_texel", { page: "texel.html" });
  }

  async function startGate(){
    // 全UIロック→オーバーレイ表示
    disableAll(true);
    show(gateOverlay);
    gateMsg.textContent = "Google サインイン状態のチェック中";

    // 非対話チェック
    let res = await sendRuntime({ type:"TEXEL_GATE_CHECK" });
    if (res?.allowed) return afterAllowed();

    // 非許可 → サインイン誘導
    gateMsg.textContent = "会社アカウントでのサインインが必要です";
    show(gateRetry);
  }

  gateRetry?.addEventListener("click", async ()=>{
    gateMsg.textContent = "サインイン処理中…";
    hide(gateRetry);
    const res2 = await sendRuntime({ type:"TEXEL_GATE_SIGNIN" });
    if (res2?.allowed) {
      await afterAllowed();
    } else {
      gateMsg.textContent = "会社アカウントでのサインインが必要です。もう一度お試しください。";
      show(gateRetry);
    }
  });

  // DOM 準備後に開始
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startGate);
  } else {
    startGate();
  }
})();
