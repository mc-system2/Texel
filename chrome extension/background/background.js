// SnapVoiceと同等：Side Panel APIで開く
// （chrome:// 等のシステムURLでは開きません）

// ① インストール時：アクションボタンクリックでサイドパネルを開く挙動に
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// ② クリック時：このタブ用に texel.html を指定して有効化
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id || !tab.url) return;

  // 注入不可URL（chrome:// 等）は無視
  const u = tab.url.toLowerCase();
  if (
    u.startsWith("chrome://") ||
    u.startsWith("edge://") ||
    u.startsWith("devtools://") ||
    u.startsWith("chrome-extension://") ||
    u.startsWith("about:")
  ) return;

  await chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: "texel.html",
    enabled: true
  });
  // openPanelOnActionClick を使うので明示 open は不要だが、明示してもOK
  // await chrome.sidePanel.open({ tabId: tab.id });
});
