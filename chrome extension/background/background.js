import { API } from '../src/api.js';    // 相対パスで OK

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.setOptions({
    tabId:   tab.id,
    path:    'panel.html',
    enabled: true
  });
});
