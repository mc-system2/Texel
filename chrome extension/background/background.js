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

// ===== Texel: TYPE-S スクレイプ一式（BG側で実行） =====

// bc / bkc の両対応で Suumo タブを探す
async function findSuumoTabInBG(bkId) {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    const url = t.url || "";
    if (!/https:\/\/manager\.suumo\.jp\//i.test(url)) continue;
    try {
      const p = new URL(url).searchParams;
      const code = p.get("bc") || p.get("bkc");
      if (code === bkId) return t;
    } catch { /* ignore */ }
  }
  return null;
}

// content script を（静的登録に加えて）念のため動的注入も試す
async function ensureSuumoCS(tabId) {
  try {
    if (!chrome.scripting?.executeScript) return; // Edgeケース用
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/suumo-preview.js"]
    });
  } catch (e) {
    // 既にロード済み等は無視
    console.warn("[BG] ensureSuumoCS:", e?.message || e);
  }
}

// タブへ sendMessage（タイムアウト付き）
function sendMessageToTab(tabId, message, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; reject(new Error("content script response timeout")); }
    }, timeoutMs);

    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (done) return;
      clearTimeout(timer);
      const lastErr = chrome.runtime?.lastError;
      if (lastErr) return reject(new Error(lastErr.message || "sendMessage failed"));
      resolve(resp);
    });
  });
}

// パネル→BG リクエストの入口
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "TEXEL_SCRAPE_SUUMO") {
    (async () => {
      try {
        const bkId = msg.bkId;

        // 1) タブ探索（bc / bkc 両対応）
        const tab = await findSuumoTabInBG(bkId);
        if (!tab?.id) throw new Error("Suumoタブが見つかりません（bc/bkc不一致の可能性）");

        // 2) 念のため content script を保証
        await ensureSuumoCS(tab.id);

        // 3) DOM抽出を依頼
        const res = await sendMessageToTab(tab.id, { type: "SCRAPE_SUUMO_PREVIEW" });
        if (!res?.ok) throw new Error(res?.error || "SCRAPE_SUUMO_PREVIEW 失敗");

        sendResponse({ ok: true, payload: res });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true; // async 返信
  }
});

// 既存: findSuumoTabInBG, ensureSuumoCS はそのまま利用

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "TEXEL_SCRAPE_SUUMO") {
    (async () => {
      try {
        const tab = await findSuumoTabInBG(msg.bkId);
        if (!tab?.id) throw new Error("Suumoタブが見つかりません");
        await ensureSuumoCS(tab.id);
        const res = await new Promise((resolve, reject) => {
          chrome.tabs.sendMessage(tab.id, { type: "SCRAPE_SUUMO_PREVIEW" }, (r) => {
            const le = chrome.runtime.lastError; if (le) return reject(new Error(le.message));
            resolve(r);
          });
        });
        if (!res?.ok) throw new Error(res?.error || "scrape failed");
        sendResponse({ ok: true, payload: res });
      } catch (e) { sendResponse({ ok: false, error: e?.message || String(e) }); }
    })();
    return true;
  }

  // ★追加: 画像Base64バッチ中継
  if (msg?.type === "TEXEL_FETCH_IMAGES_BASE64") {
    (async () => {
      try {
        const tab = await findSuumoTabInBG(msg.bkId);
        if (!tab?.id) throw new Error("Suumoタブが見つかりません");
        await ensureSuumoCS(tab.id);
        const r = await new Promise((resolve, reject) => {
          chrome.tabs.sendMessage(tab.id, { type: "FETCH_IMAGES_BASE64", urls: msg.urls || [] }, (resp) => {
            const le = chrome.runtime.lastError; if (le) return reject(new Error(le.message));
            resolve(resp);
          });
        });
        if (!r?.ok) throw new Error(r?.error || "fetchImagesBase64 failed");
        sendResponse({ ok: true, result: r.result });
      } catch (e) { sendResponse({ ok: false, error: e?.message || String(e) }); }
    })();
    return true;
  }
});
