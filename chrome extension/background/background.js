/* ===================================================================
 * Texel BG (MV3 / module) — MOCK AUTH EDITION
 * - Side Panel（SnapVoice同等）
 * - 会社アカウント認証はモックで常に許可
 * - Logs（userEmail はモックユーザー）
 * - TYPE-S（Suumo）スクレイプ中継
 * =================================================================== */

/* ===== 設定 ===== */
const ALLOWED_HDS = ["your-company.co.jp"]; // 例: "mf-realty.jp"（モック中は未使用）
const LOG_ENDPOINT = "https://your-func-app.azurewebsites.net/api/log";

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
  await chrome.sidePanel.setOptions({ tabId, path, enabled: true });
}
async function setUser(u) { await chrome.storage.local.set({ texelUser: u }); }
async function getUser() { return (await chrome.storage.local.get("texelUser")).texelUser || null; }
async function sendLog(event, detail = {}) {
  const u = await getUser();
  try {
    await fetch(LOG_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        userEmail: u?.email || "",
        event,
        detail
      })
    });
  } catch (e) {
    console.warn("[Texel] log failed:", e);
  }
}

/* ===================================================================
 * ゲート本体（モック版）
 * - 常に許可し、texel.html を表示
 * - ユーザーは AUTH_MOCK_USER を採用
 * =================================================================== */
async function gateAndRoute({ interactive = false, tabId } = {}) {
  if (AUTH_MOCK_ENABLED) {
    await setUser(AUTH_MOCK_USER);
    await setPanelPath("texel.html", tabId);
    await sendLog("allowed-mock", { email: AUTH_MOCK_USER.email, hd: AUTH_MOCK_USER.hd });
    return { allowed: true, user: AUTH_MOCK_USER };
  }

  // ---- 本実装（将来用）：必要になったら enable して使う ----
  // const user = await realGate(interactive); // 未実装プレースホルダ
  // if (!user || !ALLOWED_HDS.includes(user.hd)) {
  //   await setPanelPath("blocked.html", tabId);
  //   await sendLog("blocked", { reason: "domain", email: user?.email, hd: user?.hd });
  //   return { allowed: false, user: user || null };
  // }
  // await setPanelPath("texel.html", tabId);
  // await setUser(user);
  // await sendLog("allowed", { email: user.email, hd: user.hd });
  // return { allowed: true, user };
}

/* ===================================================================
 * Side Panel 動線（SnapVoice同等）
 * =================================================================== */
// ① インストール時：アクションボタンクリックでサイドパネル起動
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  // 既定（タブ未指定）も一度ルーティング
  gateAndRoute({ interactive: false }).catch(() => {});
});

// ② アクションボタン：このタブ向けに出し分け（モックで常に texel.html）
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id || !tab.url || isSystemUrl(tab.url)) return;
  await gateAndRoute({ interactive: false, tabId: tab.id });
  // openPanelOnActionClick により、明示 open は不要
});

// タブ切替 / 読込完了でも都度ルーティング
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const t = await chrome.tabs.get(tabId);
    if (t?.url && !isSystemUrl(t.url)) await gateAndRoute({ interactive: false, tabId });
  } catch {}
});
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status === "complete" && tab?.url && !isSystemUrl(tab.url)) {
    await gateAndRoute({ interactive: false, tabId });
  }
});

/* ===================================================================
 * Runtime メッセージ API
 * - TEXEL_GATE_CHECK / TEXEL_GATE_SIGNIN / TEXEL_GET_USER / TEXEL_LOG
 * - TEXEL_SCRAPE_SUUMO / TEXEL_FETCH_IMAGES_BASE64
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
        await sendLog(msg.event || "custom", msg.detail || {});
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
    // console.warn("[BG] ensureSuumoCS:", e?.message || e);
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
