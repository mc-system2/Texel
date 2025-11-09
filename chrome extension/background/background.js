/* ===================================================================
 * Texel BG (MV3 / module) — SnapVoice準拠 + Safe Logging
 * - サイドパネルは「拡張アイコンクリック時」のタブでのみ有効化
 * - sendLog は URL 未設定/不正時は NO-OP、設定されても fire-and-forget（例外を投げない）
 * - TYPE-S（Suumo）スクレイプ中継はそのまま
 * =================================================================== */

/* ===== 設定 ===== */
const ALLOWED_HDS = ["your-company.co.jp"]; // 例: "mf-realty.jp"（モック中は未使用）
// ★ ここが未設定/空だと sendLog は NO-OP になります（開発時の赤エラー回避）
const LOG_ENDPOINT = ""; // ex. "https://your-func-app.azurewebsites.net/api/log"

/* ★★★ モック設定：本実装に切り替える際は false に変更 ★★★ */
const AUTH_MOCK_ENABLED = true;
const AUTH_MOCK_USER = {
  email: "texel.dev@your-company.co.jp",
  name: "Texel Dev",
  hd: "your-company.co.jp"
};

/* ===== ユーティリティ ===== */
const isSystemUrl = (u = "") => {
  u = (u || "").toLowerCase();
  return (
    u.startsWith("chrome://") ||
    u.startsWith("edge://") ||
    u.startsWith("devtools://") ||
    u.startsWith("chrome-extension://") ||
    u.startsWith("about:")
  );
};
async function setPanelPath(path, tabId) {
  if (!tabId) return; // クリックされたタブにだけパス設定
  await chrome.sidePanel.setOptions({ tabId, path, enabled: true });
}
async function setUser(u) { await chrome.storage.local.set({ texelUser: u }); }
async function getUser() { return (await chrome.storage.local.get("texelUser")).texelUser || null; }

/**
 * 安全なログ送信（NO-OP許容）
 * - URL 未設定/不正なら NO-OP
 * - 例外は絶対に投げず、console にもエラーを出さない
 * - fire-and-forget（await しない）
 */
function sendLog(event, detail = {}) {
  try {
    if (!LOG_ENDPOINT || !/^https?:\/\//i.test(LOG_ENDPOINT)) return; // NO-OP
    const body = JSON.stringify({
      timestamp: new Date().toISOString(),
      userEmail: "", // 後で u?.email を入れるが、getUser() は async のため省略
      event,
      detail
    });
    // fire-and-forget
    fetch(LOG_ENDPOINT, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body
    }).catch(() => {});
  } catch {}
}

/* ===================================================================
 * ゲート（モック版）— クリック時のみ呼ぶ
 * =================================================================== */
async function gateAndRoute({ interactive = false, tabId } = {}) {
  if (AUTH_MOCK_ENABLED) {
    await setUser(AUTH_MOCK_USER);
    await setPanelPath("texel.html", tabId);
    sendLog("allowed-mock", { email: AUTH_MOCK_USER.email, hd: AUTH_MOCK_USER.hd });
    return { allowed: true, user: AUTH_MOCK_USER };
  }

  // 将来の本実装（必要になったら活性化）
  // const user = await realGate(interactive);
  // if (!user || !ALLOWED_HDS.includes(user.hd)) {
  //   await setPanelPath("blocked.html", tabId);
  //   sendLog("blocked", { reason: "domain", email: user?.email, hd: user?.hd });
  //   return { allowed: false, user: user || null };
  // }
  // await setPanelPath("texel.html", tabId);
  // await setUser(user);
  // sendLog("allowed", { email: user.email, hd: user.hd });
  // return { allowed: true, user };
}

/* ===================================================================
 * Side Panel 動線（SnapVoice準拠）
 * =================================================================== */
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  // ここでは setPanelPath/gateAndRoute を呼ばない（自動起動なし）
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id || !tab.url || isSystemUrl(tab.url)) return;
  await gateAndRoute({ interactive: false, tabId: tab.id });
  // openPanelOnActionClick により明示 open は不要
});

// 自動ルーティングは一切登録しない（タブ更新/切替で起動しない）
// chrome.tabs.onActivated.addListener(...)
// chrome.tabs.onUpdated.addListener(...)

/* ===================================================================
 * Runtime メッセージ API
 * =================================================================== */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "TEXEL_GATE_CHECK") {
        const r = await gateAndRoute({ interactive: false, tabId: sender?.tab?.id });
        return sendResponse(r);
      }
      if (msg?.type === "TEXEL_GATE_SIGNIN") {
        const r = await gateAndRoute({ interactive: true, tabId: sender?.tab?.id });
        return sendResponse(r);
      }
      if (msg?.type === "TEXEL_GET_USER") {
        return sendResponse({ user: await getUser() });
      }
      if (msg?.type === "TEXEL_LOG") {
        sendLog(msg.event || "custom", msg.detail || {});
        return sendResponse({ ok: true });
      }

      // ===== TYPE-S: Suumo スクレイプ中継 =====
      if (msg?.type === "TEXEL_SCRAPE_SUUMO") {
        const res = await scrapeSuumoPreview(msg.bkId);
        return sendResponse(res);
      }
      if (msg?.type === "TEXEL_FETCH_IMAGES_BASE64") {
        const res = await fetchSuumoImagesBase64(msg.bkId, msg.urls || []);
        return sendResponse(res);
      }

      return sendResponse({ ok: false, error: "unknown_message" });
    } catch (e) {
      return sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true; // async
});

/* ===================================================================
 * TYPE-S（Suumo）スクレイプ：元コード同等
 * =================================================================== */
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

async function ensureSuumoCS(tabId) {
  try {
    if (!chrome.scripting?.executeScript) return; // Edge 対策
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/suumo-preview.js"]
    });
  } catch (e) {
    // 既に登録済みなどは無視
  }
}

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

async function scrapeSuumoPreview(bkId) {
  try {
    const tab = await findSuumoTabInBG(bkId);
    if (!tab?.id) throw new Error("Suumoタブが見つかりません（bc/bkc不一致の可能性）");
    await ensureSuumoCS(tab.id);
    const res = await sendMessageToTab(tab.id, { type: "SCRAPE_SUUMO_PREVIEW" });
    if (!res?.ok) throw new Error(res?.error || "SCRAPE_SUUMO_PREVIEW 失敗");
    return { ok: true, payload: res };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function fetchSuumoImagesBase64(bkId, urls = []) {
  try {
    const tab = await findSuumoTabInBG(bkId);
    if (!tab?.id) throw new Error("Suumoタブが見つかりません");
    await ensureSuumoCS(tab.id);
    const r = await sendMessageToTab(tab.id, { type: "FETCH_IMAGES_BASE64", urls });
    if (!r?.ok) throw new Error(r?.error || "fetchImagesBase64 failed");
    return { ok: true, result: r.result };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}
