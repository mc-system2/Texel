/* =====================================================================
 *  Texel.js  ― Texel (external-only, clean, no hashtags)  [FULL]
 *  - Client Catalog から CL ID を解決（sheetId / behavior 取得）
 *  - ベースグレード：BK不要、物件IDは乱数＋日時で発番（重複低確率）
 *  - TYPE-R：BK必須 → Rehouse API から自動で間取り候補取得→解析→部屋写真コメント→おすすめ生成
 *  - TYPE-S：BK必須 → S-NETプレビュータブのDOMをスクレイピングしてメモ/間取/写真を取得→解析
 *  - BLOB の commitment-master を dev/prod 自動切替で読込（SWA → 拡張 → BLOB）
 *  - PDF 要約 / 間取り図解析 / 部屋写真解析 / SUUMO / athome 文言生成
 *  - 画像URL→Base64 は API.image2base64 に統一
 *  - localStorage/chrome.storage.local のキーは texel-* で統一
 *  - ★ おすすめ/ポータル生成は「間取り図分析＋部屋写真コメント＋AI参照用メモ(+PDF)」を材料に送信
 * ===================================================================== */

import { detectUserId } from "./utils/user.js";
import {
  API,
  chatGPT as analyzeWithGPT,
  fetchWithRetry,
  delay,
  SHEET_API,
  GAS_LOG_ENDPOINT
} from "./src/api.js";

/* ==============================
 * 1) 固定定数・実行時状態
 * ============================== */
const DEFAULT_SHEET_ID = "1Q8Vbluc5duil1KKWYOGiVoF9UyMxVUxAh6eYb0h2jkQ";
const LOG_SHEET_ID = DEFAULT_SHEET_ID;

let userId = "";
let clientId = "";                     // CL ID（4桁英数字）
let propertyCode = "";                 // 例：FXXXXXXX or ランダム発番
let sheetIdForGPT = DEFAULT_SHEET_ID;  // Client Catalog から差し替え
let sessionSheetId = sheetIdForGPT;

let basePropertyData = null;
let promptMap = {};                    // commitment-master（読み分け）
let originalSuggestionText = "";
let latestPdfThumbnailBase64 = "";
let latestPdfExtractedText = "";
let currentFloorplanBase64 = null;

let floorplanAnalysisResult = "";
let hasRoomAnalysis = false;

/* ==============================
 * 2) 環境判定（SWAホスト名）
 * ============================== */
const ENV = (() => {
  const h = location.host;
  if (h.includes("lively-tree-019937900.2.azurestaticapps.net")) return "dev";
  if (h.includes("lemon-beach-0ae87bc00.2.azurestaticapps.net")) return "prod";
  return "dev"; // ローカル等はdev扱い
})();

const PROMPTS_CONTAINER = "prompts";
const BLOB_ACCOUNT = {
  dev: "https://sttexeldevjpe001.blob.core.windows.net",
  prod: "https://sttexelprodjpe001.blob.core.windows.net",
};
const PROMPTS_SAS = ""; // 必要なら付与
const COMMITMENT_MASTER_FILE = "texel-commitment-master.json";

/* ------ プロンプトの論理キーとファイル名（texel-* に統一） ------ */
const P = {
  floorplan:      "texel-floorplan.json",
  roomphoto:      "texel-roomphoto.json",
  pdfImage:       "texel-pdf-image.json",
  suggestion:     "texel-suggestion.json",
  summary:        "texel-summary.json",
  suumoCatch:     "texel-suumo-catch.json",
  suumoComment:   "texel-suumo-comment.json",
  athomeComment:  "texel-athome-comment.json",
  athomeAppeal:   "texel-athome-appeal.json",
};

/* ------ localStorage/chrome.storage.local のキー正規化（texel-* に統一） ------ */
const KEY_ALIAS = {
  floorplan     : "texel-floorplan",
  roomphoto     : "texel-roomphoto",
  pdfImage      : "texel-pdf-image",
  suggestion    : "texel-suggestion",
  summary       : "texel-summary",
  suumoCatch    : "texel-suumo-catch",
  suumoComment  : "texel-suumo-comment",
  athomeComment : "texel-athome-comment",
  athomeAppeal  : "texel-athome-appeal"
};
const storageKeyFor = (keyLike) =>
  `prompt_${keyLike.startsWith("texel-") ? keyLike : (KEY_ALIAS[keyLike] || keyLike)}`;

/* ------ 404 時に使うデフォルトプロンプト ------ */
function defaultPrompt(key) {
  const baseWriter = "あなたは不動産広告の専門ライターです。読み手にとってわかりやすく、正確で誇張のない表現を使ってください。";
  switch (key) {
    case "floorplan":
      return { prompt: `${baseWriter}\n画像は不動産の間取り図です。方位や面積・部屋構成・設備などを読み取り、購入検討者向けに要点を簡潔にまとめてください。`, params: { temperature: 0.3, max_tokens: 4000 } };
    case "roomphoto":
      return { prompt: `${baseWriter}\n画像は室内写真です。写っている設備や使い勝手、魅力や注意点を過度に断定せず自然な日本語で150〜220文字程度にまとめてください。`, params: { temperature: 0.35, max_tokens: 4000 } };
    case "pdfImage":
      return { prompt: `${baseWriter}\n与えられたPDFのテキストと画像から、物件の重要ポイントを簡潔に要約してください。`, params: { temperature: 0.3, max_tokens: 4000 } };
    case "suggestion":
      return { prompt: `${baseWriter}\nこれまでの分析結果（間取り・室内コメント・メモ）を踏まえ、購入検討者に刺さる「おすすめポイント」を自然な文章でまとめてください。`, params: { temperature: 0.35, max_tokens: 4000 } };
    case "summary":
      return { prompt: baseWriter, params: { temperature: 0.3, max_tokens: 2000 } };
    case "suumoCatch":
      return { prompt: `${baseWriter}\nこの物件の魅力を最大37文字でキャッチコピー化してください。`, params: { temperature: 0.4, max_tokens: 400 } };
    case "suumoComment":
      return { prompt: `${baseWriter}\nこの物件の紹介文を最大300文字で作成してください。`, params: { temperature: 0.35, max_tokens: 600 } };
    case "athomeComment":
      return { prompt: `${baseWriter}\nスタッフコメント（最大100文字）を作成してください。`, params: { temperature: 0.35, max_tokens: 400 } };
    case "athomeAppeal":
      return { prompt: `${baseWriter}\nエンド向けのアピール文（最大500文字）を作成してください。`, params: { temperature: 0.35, max_tokens: 1200 } };
    default:
      return { prompt: baseWriter, params: { temperature: 0.3, max_tokens: 1000 } };
  }
}

/* ================= こだわりマスター読み込み（安全版） ================= */
function buildCommitmentMasterUrls() {
  const urls = [];
  try { const viaFunc = API.loadPromptText(COMMITMENT_MASTER_FILE); if (viaFunc) urls.push(viaFunc); } catch {}
  if (typeof chrome?.runtime?.getURL === "function") {
    urls.push(chrome.runtime.getURL(`${PROMPTS_CONTAINER}/${COMMITMENT_MASTER_FILE}`));
  }
  urls.push(`${location.origin}/${PROMPTS_CONTAINER}/${COMMITMENT_MASTER_FILE}`);
  if (PROMPTS_SAS && PROMPTS_SAS.trim()) {
    const account = ENV === "prod" ? BLOB_ACCOUNT.prod : BLOB_ACCOUNT.dev;
    urls.push(`${account}/${PROMPTS_CONTAINER}/${COMMITMENT_MASTER_FILE}${PROMPTS_SAS}`);
  }
  return urls;
}
async function loadCommitmentMaster() {
  const tried = [];
  const stripBOM = (t) => t.replace(/^\uFEFF/, "");
  for (const url of buildCommitmentMasterUrls()) {
    try {
      const res = await fetch(url, { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let data;
      const ctype = (res.headers.get("content-type") || "").toLowerCase();
      if (ctype.includes("application/json")) data = await res.json();
      else data = JSON.parse(stripBOM(await res.text()));
      promptMap = data.prompt || data.mapping || data || {};
      console.info("✅ commitment-master loaded from:", url);
      return;
    } catch (e) { tried.push(`${url} (${e?.message || e})`); }
  }
  promptMap = {};
  console.info("ℹ️ commitment-master not found", tried.join(" -> "));
}
loadCommitmentMaster().catch(() => {});

/* ------ クライアントカタログ（ローカル保存しない） ------ */
const CLIENT_CATALOG_FILE = "texel-client-catalog.json";
let clientCatalog = null; // その都度参照。ローカル保存しない。

async function loadClientCatalog() {
  try {
    const url = API.loadPromptText(CLIENT_CATALOG_FILE);
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const ctype = (res.headers.get("content-type") || "").toLowerCase();

    const raw = ctype.includes("application/json")
      ? await res.json()
      : JSON.parse((await res.text()).replace(/^\uFEFF/, ""));

    let payload;
    if (raw && typeof raw === "object" && "PROMPT" in raw) {
      if (typeof raw.PROMPT === "string") {
        try {
          payload = JSON.parse(raw.PROMPT.replace(/^\uFEFF/, ""));
        } catch {
          payload = raw.PROMPT;
        }
      } else if (typeof raw.PROMPT === "object" && raw.PROMPT) {
        payload = raw.PROMPT;
      } else {
        payload = raw;
      }
    } else {
      payload = raw;
    }

    // ★ BLOB 側が { "prompt": {...}, "params": {...} } 構造なので、
    // 実際に使うのは payload.prompt
    const catalogRoot = payload.prompt || payload;

    clientCatalog = normalizeClientCatalog(catalogRoot);

    console.info("✅ client-catalog loaded (no local cache).", {
      keys: Object.keys(clientCatalog?.clients || {})
    });

    try { evaluateDialogState(); } catch {}
  } catch (e) {
    clientCatalog = null;
    console.warn("ℹ️ client-catalog load skipped:", e?.message || e);
  }
}

function normalizeClientCatalog(src) {
  if (!src || typeof src !== "object") return null;
  const rawClients = src.clients || src || {};
  const normalized = {};
  // すべてのキーを trim + toUpperCase で正規化して詰め替える
  Object.keys(rawClients).forEach((k) => {
    if (k === "default") return; // default は別扱い
    const nk = (k || "").toString().trim().toUpperCase();
    const v  = rawClients[k] || {};
    normalized[nk] = {
      ...v,
      // 念のため behavior も正規化
      behavior: (v?.behavior || "").toString().trim().toUpperCase(),
      sheetId : (v?.sheetId  || "").toString().trim(),
    };
  });
  const def = src.default ? {
    ...src.default,
    sheetId: (src.default.sheetId || "").toString().trim()
  } : null;
  return { clients: normalized, default: def };
}
function resolveClientConfig(clientCode) {
  if (!clientCode || !clientCatalog) return null;
  const want = clientCode.toString().trim().toUpperCase();

  // 1) まずはダイレクトヒット
  let entry = clientCatalog.clients?.[want];

  // 2) 見つからない場合はキーを総当たりで正規化比較（不可視文字・全角スペース対策）
  if (!entry && clientCatalog.clients && typeof clientCatalog.clients === "object") {
    for (const rawKey of Object.keys(clientCatalog.clients)) {
      const normKey = String(rawKey).replace(/\u3000/g, " ").trim().toUpperCase();
      if (normKey === want) {
        entry = clientCatalog.clients[rawKey];
        break;
      }
    }
  }

  // 3) 返却前に behavior / sheetId も念のため正規化
  if (entry) {
    return {
      ...entry,
      behavior: (entry.behavior || "").toString().trim().toUpperCase(),
      sheetId : (entry.sheetId  || "").toString().trim(),
    };
  }
  // 4) 見つからなければ null（＝デフォルトなし）
  return null;
}

loadClientCatalog().catch(() => {});

/* ==============================
 * 3) ユーティリティ
 * ============================== */
const autosaveDebounced = debounce(() => saveExportJson().catch(() => {}), 600);
function debounce(fn, ms = 500) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }
const randBase62 = (n=6) => {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(arr, b => chars[b % chars.length]).join("");
};
function generateRandomPropertyCode(prefix="L") {
  const now = new Date();
  const yyyy = now.getFullYear().toString();
  const mm = String(now.getMonth()+1).padStart(2,"0");
  const dd = String(now.getDate()).padStart(2,"0");
  const hh = String(now.getHours()).padStart(2,"0");
  const mi = String(now.getMinutes()).padStart(2,"0");
  const rand = randBase62(5);
  return `${prefix}${rand}-${yyyy}${mm}${dd}${hh}${mi}`;
}

/* ---------- Loading Spinner（参照カウント） ---------- */
const spinnerCounter = Object.create(null);
function showLoadingSpinner(target) { const el = document.getElementById(`loadingSpinner-${target}`); if (!el) return; spinnerCounter[target] = (spinnerCounter[target] || 0) + 1; el.style.display = "block"; }
function hideLoadingSpinner(target) { const el = document.getElementById(`loadingSpinner-${target}`); if (!el) return; spinnerCounter[target] = Math.max((spinnerCounter[target] || 1) - 1, 0); if (spinnerCounter[target] === 0) el.style.display = "none"; }

/* ====== テキスト集約（おすすめ／ポータル共通） ====== */
function collectRoomCommentsText() {
  return [...document.querySelectorAll("#history-container .drop-zone textarea")]
    .map(t => t.value.trim())
    .filter(Boolean)
    .join("\n\n");
}
function buildCombinedSource() {
  const memo       = document.getElementById("property-info")?.value.trim() || "";
  const floorplan  = document.getElementById("floorplan-preview-text")?.value.trim() || "";
  const roomText   = collectRoomCommentsText();
  const pdfText    = document.getElementById("pdf-preview")?.textContent?.trim() || "";
  const sections = [
    `# 物件コード\n${propertyCode || "-"}`,
    memo && `# AI参照用メモ\n${memo}`,
    floorplan && `# 間取り図の分析結果\n${floorplan}`,
    roomText && `# 部屋写真のコメント\n${roomText}`,
    pdfText && `# PDF抽出テキスト＆要約\n${pdfText}`
  ].filter(Boolean);
  return sections.join("\n\n");
}

/* ==============================
 * 4) 入力ダイアログ（CL/BK）
 * ============================== */
function setModalModeText(mode, requiresBK) {
  const subtitle = document.getElementById("modal-subtitle");
  subtitle.textContent =
    mode === "BASE" ? "手動モード：PDFや間取図を手動で読み込んで使います（BK不要）" :
    mode === "TYPE-R" ? "TYPE-R：Rehouse API を使って物件情報を取得します（BK必須）" :
    mode === "TYPE-S" ? "TYPE-S：S-NETプレビューのタブが BK と一致している必要があります（BK必須）" :
    "CL ID が未登録です。カタログに存在するCL ID（例：B001）を指定してください。";
  const bkWrap = document.getElementById("bk-wrapper");
  bkWrap.style.display = requiresBK ? "block" : "none";
}
function sanitizeCL(v){ return (v||"").trim().toUpperCase(); }
function sanitizeBK(v){ return (v||"").trim().toUpperCase(); }

/** 現在入力の CL から behavior / sheetId を先読みし、決定ボタンの活性を制御 */
function evaluateDialogState() {
  const clIn = document.getElementById("client-code-input");
  const bkIn = document.getElementById("bk-id-input");
  const btn  = document.getElementById("start-button");
  const cl = sanitizeCL(clIn.value);
 // ✅ カタログ未ロード時は待機表示にする
 if (!clientCatalog) {
   document.getElementById("modal-subtitle").textContent = "クライアント情報を読み込んでいます…";
   document.getElementById("bk-wrapper").style.display = "none";
   btn.disabled = true;
   return;
 }
 const cfg = resolveClientConfig(cl);
 console.info("[Texel] CL:", cl, "resolved:", cfg);
  // CL形式チェック
  if (!cl || !/^[A-Z0-9]{4}$/.test(cl)) {
    setModalModeText("UNKNOWN", true);
    btn.disabled = true;
    return;
  }
  // CLがcatalogに無い場合は進めない
  if (!cfg) {
    document.getElementById("modal-subtitle").textContent = "このCL IDは登録がありません。カタログにあるCL ID（例：B001）を指定してください。";
    document.getElementById("bk-wrapper").style.display = "none";
    btn.disabled = true;
    return;
  }

  // sheetId 反映（CLごと）
  sheetIdForGPT = (cfg?.sheetId || DEFAULT_SHEET_ID).trim();
  sessionSheetId = sheetIdForGPT;
  let behavior = (cfg?.behavior || "").toString().toUpperCase();

  if (!behavior) {
    // behavior空＝手動モード（BK不要）
    setModalModeText("BASE", false);
    btn.disabled = false; // BK不要
    return;
  }
  if (behavior === "TYPE-R") {
    setModalModeText("TYPE-R", true);
    btn.disabled = sanitizeBK(bkIn.value).length === 0;
    return;
  }
  if (behavior === "TYPE-S") {
    setModalModeText("TYPE-S", true);
    btn.disabled = sanitizeBK(bkIn.value).length === 0; // 押下時にS-NET検証も行う
    return;
  }
  // 未知の指定は BK 必須扱い
  setModalModeText("UNKNOWN", true);
  btn.disabled = sanitizeBK(bkIn.value).length === 0;
}

/** TYPE-S: S-NETプレビューが対象BKで開いているか確認（簡易） */
async function isSuumoPreviewOpen(bkId) {
  try {
    if (!chrome?.tabs?.query) return false;
    const tabs = await new Promise((resolve) => {
      chrome.tabs.query({ url: ["https://manager.suumo.jp/*"] }, (res) => resolve(res || []));
    });
    const ok = tabs.some((t) => {
      try {
        const u = new URL(t.url || "");
        // bc=BKID が付いているか
        const bc = u.searchParams.get("bc");
        return bc && bc.toUpperCase() === bkId.toUpperCase();
      } catch { return false; }
    });
    return ok;
  } catch {
    return false;
  }
}

/* === TYPE-S 追加: S-NETタブ特定 & DOMスクレイプ === */
async function findSuumoTab(bkId) {
  const tabs = await chrome.tabs.query({});
  const target = tabs.find(t => {
    const url = t.url || "";
    const params = new URL(url).searchParams;
    const bcParam = params.get("bc") || params.get("bkc");
    return /https:\/\/manager\.suumo\.jp\//i.test(url) && bcParam === bkId;
  });
  return target || null;
}

/* ==========================================
 * scrapeSuumoPreview(tabId)
 * 1) content script へメッセージ送信（推奨）
 * 2) 失敗したら executeScript で同じ関数を直接実行（フォールバック）
 * ========================================== */
async function scrapeSuumoPreview(tabId) {
  // 1) content script に依頼
  const messageTry = new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tabId, { type: "SCRAPE_SUUMO_PREVIEW" }, (resp) => {
        const lastErr = chrome.runtime?.lastError;
        if (lastErr) return reject(new Error(lastErr.message || "sendMessage failed"));
        if (!resp) return reject(new Error("no response from content script"));
        resolve(resp);
      });
    } catch (e) {
      reject(e);
    }
  });

  try {
    const res = await Promise.race([
      messageTry,
      new Promise((_, rej) => setTimeout(() => rej(new Error("sendMessage timeout")), 5000)),
    ]);
    if (res && res.ok) return res; // { ok:true, bk, title, memoText, floorplanUrl, roomImageUrls }
  } catch (_) {
    // nop → フォールバックへ
  }

  // 2) フォールバック：executeScript（サイドパネル等で未提供ならここもスキップ）
  if (!chrome.scripting?.executeScript) {
    throw new Error("content script が見つからず、executeScript も使えません。");
  }

  const inlineScrape = () => {
    const ABS = (u) => { try { return new URL(u, location.href).href; } catch { return u || ""; } };
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const bk = document.querySelector('input[name="bukkenCd"]')?.value?.trim()
      || new URL(location.href).searchParams.get("bc")
      || document.getElementById("js-bukken_code")?.textContent?.trim() || "";

    const findRowValue = (labelLike) => {
      const ths = Array.from(document.querySelectorAll("table th"));
      const th = ths.find(th => norm(th.textContent).includes(labelLike));
      if (!th) return "";
      const td = th.parentElement?.querySelector("td");
      return norm(td ? (td.innerText || td.textContent) : "");
    };

    const title = norm(document.querySelector(".mainIndexK")?.textContent || "");
    const price = findRowValue("価格");
    const plan  = findRowValue("間取り");
    const area  = findRowValue("専有面積");
    const floor = findRowValue("所在階");
    const dir   = findRowValue("向き");
    const built = findRowValue("完成時期") || findRowValue("築年月") || findRowValue("完成時期(築年月)");
    const addr  = findRowValue("住所") || findRowValue("所在地");
    const traffic = findRowValue("交通");

    const allImgs = Array.from(document.images || []);
    const pickSrc = (img) =>
      img.currentSrc || img.src ||
      img.getAttribute("data-src") ||
      img.getAttribute("data-original") ||
      img.getAttribute("data-lazy") || "";
    const toItem = (img) => {
      const src = pickSrc(img);
      return { url: ABS(src), alt: img.alt || "", w: img.naturalWidth || img.width || 0, h: img.naturalHeight || img.height || 0 };
    };
    const imgs = allImgs.map(toItem).filter(x => x.url && !x.url.startsWith("data:"));

    const isFloorplanByText = (x) =>
      /間取|間取り|区画|間取図|madori|floor-?plan/i.test(x.alt) ||
      /madori|floor-?plan/i.test(x.url);
    const isProbablyFloorplanByShape = (x) => {
      const min = Math.min(x.w, x.h);
      const ar = x.w && x.h ? (x.w / x.h) : 1;
      return min >= 240 && ar >= 0.6 && ar <= 2.2;
    };
    const floorplan = imgs.find(isFloorplanByText) || imgs.find(isProbablyFloorplanByShape) || null;

    const roomPhotos = imgs
      .filter(x => !floorplan || x.url !== floorplan.url)
      .filter(x => {
        const min = Math.min(x.w, x.h);
        if (min < 180) return false;
        if (/logo|sprite|icon|gif/i.test(x.url)) return false;
        if (isFloorplanByText(x)) return false;
        return true;
      });

    const lines = [];
    if (title) lines.push(`・物件名：${title}`);
    if (addr)  lines.push(`・所在地：${addr}`);
    if (plan)  lines.push(`・間取り：${plan}`);
    if (area)  lines.push(`・専有面積：${area}`);
    if (floor) lines.push(`・所在階：${floor}`);
    if (dir)   lines.push(`・向き：${dir}`);
    if (built) lines.push(`・築年月：${built}`);
    if (price) lines.push(`・価格：${price}`);
    if (traffic) lines.push(`・交通：${traffic}`);
    const memoText = lines.join("\n");

    return {
      ok: true,
      bk,
      title,
      memoText,
      floorplanUrl: floorplan ? floorplan.url : "",
      roomImageUrls: roomPhotos.map(x => x.url)
    };
  };

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: inlineScrape
  });

  if (!result?.ok) throw new Error("inline executeScript でも抽出に失敗");
  return result;
}

/* ============================================================
 * TYPE-S 取得：BGに依頼（サイドパネル側では scripting を使わない）
 * ============================================================ */
async function scrapeSuumoPreviewViaBG(bkId) {
  const res = await chrome.runtime.sendMessage({ type: "TEXEL_SCRAPE_SUUMO", bkId });
  if (!res?.ok) throw new Error(res?.error || "BG scrape failed");
  // res.payload は { ok, bk, title, memoText, floorplanUrl, roomImageUrls }
  return res.payload;
}

/* ============================================================
 * TYPE-S メインフロー（呼び出し側の後段処理は従来のまま）
 * ============================================================ */
async function fetchImagesBase64ViaBG(bkId, urls) {
  const resp = await chrome.runtime.sendMessage({ type: "TEXEL_FETCH_IMAGES_BASE64", bkId, urls });
  if (!resp?.ok) throw new Error(resp?.error || "BG base64 fetch failed");
  return resp.result; // [{url, ok, base64? , error?}, ...]
}

// TYPE-S：Suumoプレビュー → 画像Base64化 → 間取りプレビュー表示＆方位待ち → 写真解析 → おすすめ生成
// SUUMO: 画像を集め、間取りがある時はプレビュー表示＋方位確定待ち（写真は defer）
async function startTypeSFlow(bkId) {
  try {
    showLoadingSpinner("floorplan");

    // 1) DOMスクレイプ
    const scrapedWrap = await scrapeSuumoPreviewViaBG(bkId);
    if (!scrapedWrap?.ok) throw new Error(scrapedWrap?.error || "scrape failed");
    const scraped = scrapedWrap;

    // 2) メモ反映
    const memo = document.getElementById("property-info");
    if (memo && scraped.memoText) { memo.value = scraped.memoText; autoGrow(memo); }

    // 3) 画像メタ（先頭は間取り）＋「写真分析対象」にも間取りを含める
    const imgsMeta = [];
    let rooms = (Array.isArray(scraped.roomImages) && scraped.roomImages.length)
      ? scraped.roomImages
      : (scraped.roomImageUrls || []).map(u => ({ url: u, title: "", desc: "" }));

    if (scraped.floorplanUrl) {
      imgsMeta.push({ url: scraped.floorplanUrl, title: "間取り図", desc: "", kind: "floorplan" });
      // ★ 写真分析の対象にも間取り図を追加（先頭）
      rooms = [{ url: suumoResizeWidth(scraped.floorplanUrl, 500), title: "間取り図", desc: "間取り図" }, ...rooms];
    }

    // room 側の URL も統一
    rooms = rooms.map(o => ({ ...o, url: suumoResizeWidth(o.url, 500) }));
    imgsMeta.push(...rooms.map(o => ({ ...o, kind: "room" })));

    if (!imgsMeta.length) { await saveExportJson(); return; }

    // 4) Base64化
    // ここで SUUMO のリサイズ幅を w=500 にそろえる
    const normalizedImgUrls = imgsMeta.map(i => suumoResizeWidth(i.url, 500));
    const b64results = await fetchImagesBase64ViaBG(bkId, normalizedImgUrls);

    // 5) 整形：間取りを表示→“北”確定ボタンに「間取り含む写真リスト」を退避（この時点では実行しない）
    let floorplanFound = false;
    for (let i = 0; i < b64results.length; i++) {
      const r = b64results[i];
      const meta = imgsMeta[i];
      if (!r?.ok || !r.base64) { console.warn("画像の読み込み失敗:", r?.url, r?.error); continue; }

      if (meta.kind === "floorplan") {
        floorplanFound = true;
        currentFloorplanBase64 = r.base64;

        const img = document.getElementById("floorplan-preview");
        if (img) {
          img.style.display = "none";
          img.onload = () => { img.style.display = "block"; img.style.cursor = "pointer"; };
          setTimeout(() => { img.style.display = "block"; img.style.cursor = "pointer"; }, 200);
          img.src = r.base64;
        }
        showNorthSelector(); // 表示（※名称変更）

        // “北”確定ボタンに「間取りを含む写真配列」を退避
        const confirmBtn = document.getElementById("confirmNorthButton");
        if (confirmBtn) confirmBtn.dataset.deferRoomImages = JSON.stringify(rooms);
      }
    }

    // 6) 間取りが無い場合のみ、写真を即時解析して完走
    if (!floorplanFound && rooms.length) {
      await analyzeRoomImagesSequentially(rooms);
      if (typeof runSuggestionAndPortals === "function") await runSuggestionAndPortals();
    }

    await saveExportJson();

  } catch (err) {
    console.error("TYPE-S フローエラー:", err);
    alert("画像の取得または解析に失敗しました。Suumoタブが開いているかをご確認ください。");
  } finally {
    hideLoadingSpinner("floorplan");
  }
}

/* ==============================
 * 5) プロンプト取得 + フォールバック
 * ============================== */
async function fetchPromptTextFile(filename) {
  try {
    const url = API.loadPromptText(filename);
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) { console.warn(`LoadPromptText 失敗: ${res.status} ${res.statusText}`); return null; }
    const ctype = res.headers.get("content-type") || "";
    if (ctype.includes("application/json")) {
      const data = await res.json().catch(() => ({}));
      if (typeof data === "string") return { prompt: data, params: {} };
      let promptText = "";
      if (typeof data?.prompt === "string") promptText = data.prompt;
      else if (typeof data?.prompt?.text === "string") promptText = data.prompt.text;
      else promptText = JSON.stringify(data?.prompt ?? data, null, 2);
      return { prompt: promptText, params: data?.params || {} };
    }
    const text = await res.text();
    return { prompt: text, params: {} };
  } catch (e) { console.warn("LoadPromptText 例外:", e); return null; }
}

async function getPromptObj(keyLike, filename) {
  const cacheKey = storageKeyFor(keyLike);
  const local = localStorage.getItem(cacheKey);
  if (local !== null) {
    console.info(`[prompt] localStorage 使用: ${cacheKey}`);
    try { return JSON.parse(local); } catch { return { prompt: local, params: {} }; }
  }
  try {
    if (chrome?.storage?.local) {
      const got = await new Promise((r) => chrome.storage.local.get([cacheKey], (ret) => r(ret?.[cacheKey] ?? null)));
      if (got !== null) {
        console.info(`[prompt] chrome.storage 使用: ${cacheKey}`);
        try { return JSON.parse(got); } catch { return { prompt: got, params: {} }; }
      }
    }
  } catch {}
  const fetched = await fetchPromptTextFile(filename);
  if (fetched) console.info(`[prompt] server/BLOB 使用: ${filename}`);
  const obj = fetched || defaultPrompt(keyLike);
  const saveStr = JSON.stringify(obj);
  try { localStorage.setItem(cacheKey, saveStr); } catch {}
  try { chrome?.storage?.local?.set({ [cacheKey]: saveStr }); } catch {}
  return obj;
}

/* ==============================
 * 6) 保存（Spreadsheet）
 * ============================== */
async function saveExportJson() {
  if (!sessionSheetId) {
    console.error("❌ sessionSheetId is empty – abort saveExportJson");
    hideLoadingSpinner("suggestion"); hideLoadingSpinner("pdf");
    return;
  }

  const exportJson = {
    propertyCode,
    clientId,

    // 既存の互換フィールド（そのまま維持）
    sheetIdForGPT,

    // ★ GAS 側が参照する可能性の高いキー名を追加
    spreadsheetId: sessionSheetId,
    sheetId: sessionSheetId,

    timestamp: new Date().toISOString(),
    pdfExtractedText:
      latestPdfExtractedText ||
      document.getElementById("pdf-preview")?.textContent?.trim() ||
      "",
    pdfImage:
      latestPdfThumbnailBase64 ||
      document.getElementById("pdf-image-preview")?.src ||
      "",
    memo: document.getElementById("property-info")?.value.trim() || "",
    floorplanAnalysis:
      document.getElementById("floorplan-preview-text")?.value.trim() || "",
    suggestions:
      document.querySelector("#suggestion-area textarea")?.value.trim() || "",
    "suumo-catch": getTextareaValue("suumo-catch"),
    "suumo-comment": getTextareaValue("suumo-comment"),
    "athome-comment": getTextareaValue("athome-comment"),
    "athome-appeal": getTextareaValue("athome-appeal"),
    originalSuggestion: originalSuggestionText,
    floorplanImageBase64:
      document.getElementById("floorplan-preview")?.src || "",
    rawPropertyData: basePropertyData,
    roomComments: (() => {
      const unique = new Set();
      return Array.from(
        document.querySelectorAll("#history-container .drop-zone")
      )
        .map((z) => {
          const img = z.querySelector("img")?.src || "";
          const cmt = z.querySelector("textarea")?.value || "";
          const key = img + "___" + cmt;
          if (
            !img ||
            img.startsWith("chrome-extension://") ||
            !cmt.trim() ||
            unique.has(key)
          )
            return null;
          unique.add(key);
          return { image: img, comment: cmt };
        })
        .filter(Boolean);
    })(),
  };

  try {
    await saveToSpreadsheet(exportJson);
  } catch (e) {
    console.error("❌ sheet save failed", e);
    alert("スプレッドシートへの保存に失敗しました");
  }
}

/* ==============================
 * 7) DOM参照
 * ============================== */
const pdfDrop = document.getElementById("pdf-drop");
const pdfInput = document.getElementById("pdf-file");
const pdfPreview = document.getElementById("pdf-preview");

const floorplanDrop = document.getElementById("floorplan-drop");
const floorplanPreview = document.getElementById("floorplan-preview");
const floorplanAnalysis = document.getElementById("floorplan-analysis");
const floorplanToggle = document.getElementById("floorplan-toggle");
const floorplanSelect = document.getElementById("floorplan-file");

const roomDrop = document.getElementById("room-drop");
const roomPreview = document.getElementById("room-preview");
const analysisResult = document.getElementById("analysis-result");
const roomSelect = document.getElementById("room-file");

const historyContainer = document.getElementById("history-container");
const generateButton = document.getElementById("generate-suggestions");
const suggestionArea = document.getElementById("suggestion-area");

/* ==============================
 * 8) 初期状態
 * ============================== */
floorplanAnalysis.style.display = "none";
floorplanToggle.textContent = "▶ 分析結果を表示";
generateButton.disabled = true;

/* ==============================
 * 9) PDF.js 読み込み
 * ============================== */
(function importScriptsIfAvailable() {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("libs/pdfjs/pdf.js");
  script.onload = () => { if (window["pdfjsLib"]) { pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("libs/pdfjs/pdf.worker.js"); } };
  script.onerror = () => console.error("❌ pdf.js 読み込み失敗");
  document.head.appendChild(script);
})();

/* ==============================
 * 10) 物件画像から間取り図候補
 * ============================== */
function guessFloorplanFromPropertyImages(data) {
  const imgs = data?.propertyImages || [];
  if (!Array.isArray(imgs) || !imgs.length) return null;
  const cand = imgs.find((img) =>
    /間取図|区画図/.test(img?.title || "") || /floorplan|floor-plan/i.test(img?.url || "")
  );
  return cand?.url || null;
}
function guessFloorplanUrlFromProperty(data) {
  // Rehouse の詳細 JSON にカスタムの間取図フィールドがある場合の補助（なければ null）
  const maybe = data?.floorplanUrl || data?.images?.find?.(x => /floor/i.test(x?.type||""))?.url;
  return maybe || null;
}

/* ==============================
 * 11) 起動時モーダル／イベント登録（CL/BK）
 * ============================== */
document.addEventListener("DOMContentLoaded", async () => {
  userId = await detectUserId();
  console.info("[Texel] Rehouse API: 直叩き専用モードで起動しました。");
  // ✅ Client Catalog と commitment-master を両方ロード完了させる
  try { await Promise.all([loadClientCatalog(), loadCommitmentMaster()]); } catch {}

  // 歯車：プロンプトエディタ（既存）
  document.body.addEventListener("click", async (e) => {
    const a = e.target.closest('a.prompt-config-link');
    if (!a) return;
    e.preventDefault();
    const t = a.getAttribute('data-type') || '';
    const url = chrome.runtime.getURL(`local-prompt-editor.html?type=${encodeURIComponent(t)}`);
    if (chrome?.tabs?.create) await chrome.tabs.create({ url });
    else window.open(url, "_blank");
  });

  // モーダル（CL/BK）
  const modal = document.getElementById("property-code-modal");
  const clIn  = document.getElementById("client-code-input");   // ★ 4桁英数字（必須）
  const bkIn  = document.getElementById("bk-id-input");         // ★ Behaviorにより必須
  const btn   = document.getElementById("start-button");
  document.getElementById("modal-title").textContent = "CL ID と BK ID を入力してください";
  document.getElementById("modal-subtitle").textContent = "CL ID は必須です。";

  clIn.addEventListener("input", evaluateDialogState);
  bkIn.addEventListener("input", evaluateDialogState);
  // 初回判定（カタログロード済み）
  evaluateDialogState();

  // 間取り分析のテキスト自動伸縮
  const fpTextarea = document.getElementById("floorplan-preview-text");
  if (fpTextarea) {
    fpTextarea.classList.add("auto-grow");
    fpTextarea.addEventListener("input", () => autoGrow(fpTextarea));
    autoGrow(fpTextarea);
  }

  // 生成／再要約／元に戻す
  document.getElementById("generate-suggestions").addEventListener("click", onGenerateSuggestions);
  document.getElementById("generate-summary").addEventListener("click", onRegenerateSummary);
  document.getElementById("reset-suggestion")?.addEventListener("click", onClickResetSuggestion);

  // 画像ポップアップ
  bindImagePopup();

  // 方位決定 → 間取り図解析（ROOM画像保留再開）
  document.getElementById("confirmNorthButton").addEventListener("click", onConfirmNorth);

  // 決定（起動）
  btn.addEventListener("click", async () => {
    clientId = sanitizeCL(clIn.value);
   const cfg = resolveClientConfig(clientId);
   if (!cfg) { alert("このCL IDは登録がありません。CatalogのCL（例：B001）を指定してください。"); return; }
    const behavior = (cfg.behavior || "").toString().toUpperCase();
    const bkId = sanitizeBK(bkIn.value);

    // 共通：sheetId セット（catalog＞default）
    sheetIdForGPT = (cfg.sheetId || DEFAULT_SHEET_ID).trim();
    sessionSheetId = sheetIdForGPT;
    console.info("[Texel] Using spreadsheetId:", sessionSheetId, "for CL:", clientId);

    // モード分岐
    if (!behavior) {
      // ベースグレード：BK不要／物件IDは乱数＋日時
      propertyCode = generateRandomPropertyCode();
    } else if (behavior === "TYPE-R") {
      if (!bkId) { alert("BK ID は必須です"); return; }
      propertyCode = bkId;
    } else if (behavior === "TYPE-S") {
      if (!bkId) { alert("BK ID は必須です"); return; }
      const ok = await isSuumoPreviewOpen(bkId);
      if (!ok) {
        alert("S-NET のプレビューページ（bc="+bkId+"）が開かれていません。該当タブを開いてから再度お試しください。");
        return;
      }
      propertyCode = bkId;
    } else {
      // 未知指定は TYPE-R 相当で BK 必須扱い
      if (!bkId) { alert("BK ID は必須です"); return; }
      propertyCode = bkId;
    }

    showCodeBanner(propertyCode);
    modal.style.display = "none";
    document.querySelectorAll("section.disabled").forEach((sec) => sec.classList.remove("disabled"));

    const memo = document.getElementById("property-info");
    if (memo) {
      memo.addEventListener("input", () => autoGrow(memo));
      autoGrow(memo);
    }

    // ベースなら自動取得しない（PDF/間取図を手動で投入）
if (!behavior) {
  // 文字数カウンタだけ準備
  setupCharCount("suumo-catch", "suumo-catch-count", 37);
  setupCharCount("suumo-comment", "suumo-comment-count", 300);
  setupCharCount("athome-comment", "athome-comment-count", 100);
  setupCharCount("athome-appeal", "athome-appeal-count", 500);
  // オートセーブ
  ["property-info","editable-suggestion","suumo-catch","suumo-comment","athome-comment","athome-appeal"]
    .forEach((id) => attachAutoSave(id));
  return;
}

// ✅ TYPE-R：Rehouse API を呼び出す
if (behavior === "TYPE-R") {
  try {
    const data = await fetchPropertyData(propertyCode);
    if (data) {
      basePropertyData = data;

      const memo = document.getElementById("property-info");
      if (memo) {
        // ★ より堅牢なメモ生成（空落ち対策）
        const memoText = generatePropertyMemo(data, promptMap);
        if (memoText) memo.value = memoText;
        autoGrow(memo);
      }

      const fpUrl =
        guessFloorplanFromPropertyImages(data) ||
        guessFloorplanUrlFromProperty(data);

     let roomImages = Array.isArray(data.propertyImages) ? data.propertyImages : [];
      if (fpUrl) roomImages = [{ url: fpUrl, title: "間取り図", desc: "間取り図" }, ...roomImages];

      if (fpUrl) {
        try {
          showLoadingSpinner("floorplan");
          const b64 = await convertUrlToBase64ViaFunctionBase(fpUrl);

          floorplanPreview.src = "";
          floorplanPreview.style.display = "none";
          floorplanPreview.onload = () => {
            floorplanPreview.style.display = "block";
            floorplanPreview.style.cursor = "pointer";
          };
          setTimeout(() => {
            floorplanPreview.style.display = "block";
            floorplanPreview.style.cursor = "pointer";
          }, 200);
          floorplanPreview.src = b64;

          currentFloorplanBase64 = b64;
          showNorthSelector();

          const confirmBtn = document.getElementById("confirmNorthButton");
          if (confirmBtn) {
            confirmBtn.dataset.deferRoomImages = JSON.stringify(roomImages);
          }
        } catch (e) {
          console.warn("間取り図の自動読込に失敗:", e);
          if (roomImages.length) {
            await analyzeRoomImagesSequentially(roomImages);
            await runSuggestionAndPortals();
          }
        } finally {
          hideLoadingSpinner("floorplan");
        }
      } else {
        if (roomImages.length) {
          await analyzeRoomImagesSequentially(roomImages);
          await runSuggestionAndPortals();
        }
      }
    }
  } catch (e) {
    console.warn("物件データ取得スキップ/失敗:", e);
  }
}

// ✅ TYPE-S：S-NETプレビューのDOMを読む
if (behavior === "TYPE-S") {
  await startTypeSFlow(propertyCode);
}

// 文字数カウンタ
setupCharCount("suumo-catch", "suumo-catch-count", 37);
setupCharCount("suumo-comment", "suumo-comment-count", 300);
setupCharCount("athome-comment", "athome-comment-count", 100);
setupCharCount("athome-appeal", "athome-appeal-count", 500);

// オートセーブ
["property-info","editable-suggestion","suumo-catch","suumo-comment","athome-comment","athome-appeal"]
  .forEach((id) => attachAutoSave(id));
  });

  // DnD バインド
  bindFloorplanDnD();
  bindRoomDnD();

  // PDF DnD/選択
  ["dragenter", "dragover"].forEach((evt) =>
    pdfDrop.addEventListener(evt, (e) => { e.preventDefault(); pdfDrop.classList.add("highlight"); })
  );
  pdfDrop.addEventListener("dragleave", (e) => { e.preventDefault(); pdfDrop.classList.remove("highlight"); });
  pdfDrop.addEventListener("drop", async (e) => {
    e.preventDefault(); pdfDrop.classList.remove("highlight");
    const file = e.dataTransfer.files[0];
    if (file?.type === "application/pdf") await handlePdfFile(file);
  });
  pdfInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (file?.type === "application/pdf") await handlePdfFile(file);
  });

  const pdfToggleBtn = document.getElementById("pdf-toggle");
  if (pdfToggleBtn) {
    pdfToggleBtn.addEventListener("click", () => {
      const area = document.getElementById("pdf-analysis");
      const show = area.style.display === "none";
      area.style.display = show ? "block" : "none";
      pdfToggleBtn.textContent = show ? "▼ 抽出結果を非表示" : "▶ 抽出結果を表示";
    });
  }

  // 間取り図の結果トグル
  floorplanToggle.addEventListener("click", () => {
    const hidden = floorplanAnalysis.style.display === "none";
    floorplanAnalysis.style.display = hidden ? "block" : "none";
    floorplanToggle.textContent = hidden ? "▼ 分析結果を非表示" : "▶ 分析結果を表示";
    if (hidden) requestAnimationFrame(() => autoGrow(document.getElementById("floorplan-preview-text")));
  });

  updateResetSuggestionBtn?.();
});

/* ==============================
 * 12) 画像→Base64 / URL→Base64
 * ============================== */
function readImageAsBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}
async function convertUrlToBase64ViaAPI(imageUrl) {
  const res = await fetch(API.image2base64, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageUrl }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Base64変換API失敗 (status=${res.status}) ${text}`);
  }
  const json = await res.json();
  if (!json?.base64) throw new Error("Base64変換API応答に base64 がありません");
  return json.base64;
}
async function convertUrlToBase64ViaFunctionBase(imageUrl) { return convertUrlToBase64ViaAPI(imageUrl); }

/* ==============================
 * 13) 間取り図 DnD
 * ============================== */
function bindFloorplanDnD() {
  if (floorplanDrop.dataset.bound) return;
  floorplanDrop.dataset.bound = "1";

  ["dragenter", "dragover"].forEach((evt) => {
    floorplanDrop.addEventListener(evt, (e) => { e.preventDefault(); floorplanDrop.classList.add("highlight"); });
  });
  floorplanDrop.addEventListener("dragleave", (e) => { e.preventDefault(); floorplanDrop.classList.remove("highlight"); });
  floorplanDrop.addEventListener("drop", async (e) => {
    e.preventDefault(); floorplanDrop.classList.remove("highlight");

    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"));
    if (files.length > 0) return handleFloorplanFile(files[0]);

    const html = e.dataTransfer.getData("text/html");
    const m = html?.match(/src\s*=\s*["']([^"']+)["']/i);
    if (m) {
      const src = m[1];
      if (src.startsWith("data:image/")) {
        floorplanPreview.src = src;
        floorplanPreview.style.display = "block";
        floorplanPreview.style.cursor = "pointer";
        currentFloorplanBase64 = src;
        showNorthSelector();
        return;
      }
      if (src.startsWith("http")) {
        try {
          showLoadingSpinner("floorplan");
          const base64 = await convertUrlToBase64ViaFunctionBase(src);
          floorplanPreview.src = "";
          floorplanPreview.style.display = "none";
          floorplanPreview.onload = () => { floorplanPreview.style.display = "block"; floorplanPreview.style.cursor = "pointer"; };
          setTimeout(() => { floorplanPreview.style.display = "block"; floorplanPreview.style.cursor = "pointer"; }, 200);
          floorplanPreview.src = base64;
          currentFloorplanBase64 = base64;
          showNorthSelector();
        } finally { hideLoadingSpinner("floorplan"); }
        return;
      }
    }

    const uri = e.dataTransfer.getData("text/uri-list");
    if (uri && uri.startsWith("http")) {
      try {
        showLoadingSpinner("floorplan");
        const base64 = await convertUrlToBase64ViaFunctionBase(uri);
        floorplanPreview.src = "";
        floorplanPreview.style.display = "none";
        floorplanPreview.onload = () => { floorplanPreview.style.display = "block"; floorplanPreview.style.cursor = "pointer"; };
        setTimeout(() => { floorplanPreview.style.display = "block"; floorplanPreview.style.cursor = "pointer"; }, 200);
        floorplanPreview.src = base64;
        currentFloorplanBase64 = base64;
        showNorthSelector();
      } finally { hideLoadingSpinner("floorplan"); }
      return;
    }

    console.warn("❌ ドロップされた間取り図画像が処理できませんでした");
  });

  floorplanSelect.addEventListener("change", (e) => { handleFloorplanFile(e.target.files[0]); });
}
async function handleFloorplanFile(file) {
  if (!file || !file.type.startsWith("image/")) return;
  showLoadingSpinner("floorplan");
  try {
    floorplanPreview.src = "";
    floorplanPreview.style.display = "none";
    const b64 = await readImageAsBase64(file);
    floorplanPreview.onload = () => { floorplanPreview.style.display = "block"; floorplanPreview.style.cursor = "pointer"; };
    setTimeout(() => { floorplanPreview.style.display = "block"; floorplanPreview.style.cursor = "pointer"; }, 200);
    floorplanPreview.src = b64;
    currentFloorplanBase64 = b64;
    showNorthSelector();
  } finally { hideLoadingSpinner("floorplan"); }
}

/* ==============================
 * 14) 部屋写真 DnD
 * ============================== */
function bindRoomDnD() {
  ["dragenter", "dragover"].forEach((evt) => {
    roomDrop.addEventListener(evt, (e) => { e.preventDefault(); roomDrop.classList.add("highlight"); });
  });
  roomDrop.addEventListener("dragleave", (e) => { e.preventDefault(); roomDrop.classList.remove("highlight"); });
  if (!roomDrop.dataset.bound) {
    roomDrop.dataset.bound = "1";
    roomDrop.addEventListener("drop", async (e) => {
      e.preventDefault(); roomDrop.classList.remove("highlight");

      const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"));
      if (files.length > 0) {
        for (const file of files) { await processRoomFile(file); await delay(500); }
        return;
      }

      const html = e.dataTransfer.getData("text/html");
      const m = html?.match(/src\s*=\s*["']([^"']+)["']/i);
      if (m) {
        const src = m[1];
        if (src.startsWith("data:image/")) {
          roomPreview.src = src;
          roomPreview.onload = () => { roomPreview.style.display = "block"; roomPreview.style.cursor = "pointer"; };
          setTimeout(() => { roomPreview.style.display = "block"; roomPreview.style.cursor = "pointer"; }, 200);
          await analyzeRoomPhotoWithGPT(src, src, "手動分析", "HTMLドラッグ");
          return;
        }
        if (src.startsWith("http")) {
          try {
            const b64 = await convertUrlToBase64ViaFunctionBase(src);
            roomPreview.src = b64;
            roomPreview.onload = () => { roomPreview.style.display = "block"; roomPreview.style.cursor = "pointer"; };
            setTimeout(() => { roomPreview.style.display = "block"; roomPreview.style.cursor = "pointer"; }, 200);
            await analyzeRoomPhotoWithGPT(b64, src, "手動分析", "Web画像");
          } catch (err) { console.error("画像URLからBase64変換に失敗:", err); }
          return;
        }
      }

      const uri = e.dataTransfer.getData("text/uri-list");
      if (uri && uri.startsWith("http")) {
        try {
          const b64 = await convertUrlToBase64ViaFunctionBase(uri);
          roomPreview.src = b64;
          roomPreview.onload = () => { roomPreview.style.display = "block"; roomPreview.style.cursor = "pointer"; };
          setTimeout(() => { roomPreview.style.display = "block"; roomPreview.style.cursor = "pointer"; }, 200);
          await analyzeRoomPhotoWithGPT(b64, uri, "手動分析", "URIリスト");
        } catch (err) { console.error("URI→Base64失敗:", err); }
        return;
      }

      console.warn("❌ ドロップされた画像が処理できませんでした");
    });
  }

  roomSelect.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file || !file.type.startsWith("image/")) return;
    await processRoomFile(file);
    roomSelect.value = "";
  });
}
async function processRoomFile(file) {
  roomPreview.src = "";
  roomPreview.style.display = "none";
  const b64 = await readImageAsBase64(file);
  roomPreview.src = b64;
  roomPreview.onload = () => { roomPreview.style.display = "block"; roomPreview.style.cursor = "pointer"; };
  setTimeout(() => { roomPreview.style.display = "block"; roomPreview.style.cursor = "pointer"; }, 200);
  const guessedTitle = file.name.replace(/\.[^.]+$/, "");
  await analyzeRoomPhotoWithGPT(b64, null, guessedTitle, null);
}

/* ==============================
 * 15) PDF処理
 * ============================== */
async function handlePdfFile(file) {
  showLoadingSpinner("pdf");
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const typedarray = new Uint8Array(reader.result);
      const pdf = await pdfjsLib.getDocument({ data: typedarray }).promise;
      const page = await pdf.getPage(1);

      const viewport = page.getViewport({ scale: 3 });
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: context, viewport }).promise;

      const base64Image = canvas.toDataURL("image/png");
      const pdfImagePreview = document.getElementById("pdf-image-preview");
      if (pdfImagePreview) { pdfImagePreview.src = base64Image; pdfImagePreview.style.display = "block"; pdfImagePreview.style.cursor = "pointer"; }
      latestPdfThumbnailBase64 = base64Image;

      const ops = await page.getOperatorList();
      const hasTextLayer = ops.fnArray.includes(pdfjsLib.OPS.showText);
      const hasImageLayer =
        ops.fnArray.includes(pdfjsLib.OPS.paintImageXObject) ||
        ops.fnArray.includes(pdfjsLib.OPS.paintJpegXObject);

      let extractedText = "";
      if (hasTextLayer) {
        const textContent = await page.getTextContent();
        extractedText = textContent.items.map((i) => i.str).join("\n").trim();
      }

      const promptObj = await getPromptObj("pdfImage", P.pdfImage);
      const summaryPrompt = promptObj.prompt || "";
      const params = promptObj.params || {};

      const messages = [{ role: "system", content: summaryPrompt }];
      if (extractedText) messages.push({ role: "user", content: extractedText });
      if (hasImageLayer && base64Image) {
        messages.push({ role: "user", content: [{ type: "image_url", image_url: { url: base64Image } }] });
      }

      const body = {
        messages,
        temperature: params.temperature ?? 0.3,
        max_tokens: params.max_tokens ?? 4000,
        top_p: params.top_p,
        frequency_penalty: params.frequency_penalty,
        presence_penalty: params.presence_penalty,
        purpose: "pdf"
      };

      const result = await callGPT(body);
      const summarized = result.choices?.[0]?.message?.content || "(GPT応答なし)";

      let combinedOutput = "";
      if (extractedText) combinedOutput += "【テキスト抽出内容】\n" + extractedText.trim() + "\n\n";
      combinedOutput += "【GPT要約】\n" + summarized;

      pdfPreview.textContent = combinedOutput;
      const memoArea = document.getElementById("property-info");
      if (memoArea) { memoArea.value += `\n${summarized}`; autoGrow(memoArea); }
      latestPdfExtractedText = combinedOutput;
      await saveExportJson();

      const pdfAnalysis = document.getElementById("pdf-analysis");
      const pdfToggle = document.getElementById("pdf-toggle");
      if (pdfAnalysis) pdfAnalysis.style.display = "none";
      if (pdfToggle) pdfToggle.textContent = "▶ 抽出結果を表示";
    } catch (err) {
      console.error("PDF読み込みエラー:", err);
      if (pdfPreview) pdfPreview.textContent = "PDF読み取り中にエラーが発生しました。";
    } finally { hideLoadingSpinner("pdf"); }
  };
  reader.readAsArrayBuffer(file);
}

/* ==============================
 * 16) 間取り図解析（GPT）
 * ============================== */
async function analyzeFloorplanWithGPT(base64Image, northVector) {
  const previewText = document.getElementById("floorplan-preview-text");
  try {
    showLoadingSpinner("floorplan");
    const promptObj = await getPromptObj("floorplan", P.floorplan);
    let systemPromptBase = promptObj.prompt || "これは不動産の間取り図です。内容を読み取り、わかりやすく要約してください。";
    const params = promptObj.params || {};

    const codeText  = `\n物件コードは「${propertyCode}」です。`;
    const northText = `\n間取り図の北方向（northVector）は「${northVector}」です。`;
    const memoText  = document.getElementById("property-info")?.value.trim() || "";
    const fullSystemPrompt = `${systemPromptBase}${codeText}${northText}\n\n--- AI参照用物件メモ ---\n${memoText}`;

    const body = {
      messages: [
        { role: "system", content: fullSystemPrompt },
        { role: "user",   content: [{ type: "image_url", image_url: { url: base64Image } }] }
      ],
      temperature: params.temperature ?? 0.3,
      max_tokens:  params.max_tokens ?? 4000,
      top_p: params.top_p,
      frequency_penalty: params.frequency_penalty,
      presence_penalty:  params.presence_penalty,
      purpose: "floorplan"
    };

    const result = await callGPT(body);
    const comment = result.choices?.[0]?.message?.content || "";
    floorplanAnalysisResult = comment;
    previewText.value = comment;
    updateGenerateButtonLabel();
    document.getElementById("floorplan-analysis").style.display = "none";
    requestAnimationFrame(() => autoGrow(previewText));
    floorplanToggle.textContent = "▶ 分析結果を表示";
  } catch (err) {
    console.error("❌ GPT呼び出しエラー:", err);
    floorplanAnalysisResult = "";
  } finally {
    hideLoadingSpinner("floorplan");
    hideNorthSelector(); // ★ 解析完了後に赤枠UIを確実に閉じる
    if (floorplanAnalysisResult) await saveExportJson();
  }
}

/* ==============================
 * 17) 部屋写真解析（GPT）
 * ============================== */
function buildRoomPhotoPrompt(base, roomType, description, past = [], isRetry=false) {
  const memoText = document.getElementById("property-info")?.value.trim() || "";
  const fpText   = document.getElementById("floorplan-preview-text")?.value.trim() || "";
  const hintPrev = past?.length ? `\n\n--- 直前の出力（参考・反省点） ---\n${past.join("\n\n")}` : "";
  const retryNote= isRetry ? "\n\n（注：前回と異なる切り口で、しかし事実に限定して出力）" : "";
  const head = `${base}\n写真の種類: ${roomType || "未指定"}\n補足: ${description || "-"}\n物件コード: ${propertyCode}\n\n--- 間取り図の要約 ---\n${fpText}\n\n--- AI参照用物件メモ ---\n${memoText}${hintPrev}${retryNote}`;
  return head;
}
async function analyzeRoomPhotoWithGPT(
  base64Image,
  imageSrc = null,
  roomType = null,
  description = null,
  pastComments = [],
  isRetry = false,
  insertAfter = null
) {
  const ta = document.getElementById("analysis-result");
  showLoadingSpinner("room");
  try {
    const promptObj = await getPromptObj("roomphoto", P.roomphoto);
    const basePrompt = promptObj.prompt || "";
    const params = promptObj.params || {};
    const temperature = isRetry ? 0.7 : (params.temperature ?? 0.3);
    const top_p      = isRetry ? 0.95 : params.top_p;

    const combinedPrompt = buildRoomPhotoPrompt(basePrompt, roomType, description, pastComments, isRetry);

    const body = {
      messages: [
        { role: "system", content: combinedPrompt },
        { role: "user",   content: [{ type: "image_url", image_url: { url: base64Image } }] }
      ],
      temperature,
      top_p,
      max_tokens: params.max_tokens ?? 4000,
      frequency_penalty: params.frequency_penalty,
      presence_penalty:  params.presence_penalty,
      purpose: isRetry ? "photo-regenerate" : "photo"
    };

    const result = await callGPT(body);
    const comment = result?.choices?.[0]?.message?.content?.trim();
    if (!comment) throw new Error("GPT 応答が空");

    await addToHistory(imageSrc || base64Image, comment, roomType, description, insertAfter);
    hasRoomAnalysis = true;
    updateGenerateButtonLabel();
  } catch (err) {
    console.error("❌ 画像コメント生成エラー:", err);
    if (!isRetry && ta) { ta.textContent = "解析に失敗しました。"; ta.style.display = "block"; }
  } finally {
    hideLoadingSpinner("room");
    saveExportJson().catch(() => {});
  }

  if (!isRetry && ta) { ta.textContent = ""; ta.style.display = "none"; }
}

/* ==============================
 * 18) 履歴追加
 * ============================== */
async function addToHistory(imageSrc, commentText, roomType = "", description = "", insertAfter = null) {
  if (!commentText.trim() || !imageSrc || imageSrc.startsWith("chrome-extension://")) return;

  const wrapper = document.createElement("div");
  wrapper.className = "drop-zone";
  wrapper.style.position = "relative";
  wrapper.dataset.roomType = roomType;
  wrapper.dataset.description = description;

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "×";
  closeBtn.style.cssText = "position:absolute;top:0;right:0;background:transparent;border:none;color:#999;font-size:16px;cursor:pointer;padding:4px;z-index:10;";
  closeBtn.onclick = async () => { wrapper.remove(); updateRoomAnalysisStatus(); await saveExportJson(); };

  const img = document.createElement("img");
  img.src = imageSrc;
  img.style.cssText = "width:100%;max-height:200px;object-fit:contain;cursor:pointer;";

  const toggle = document.createElement("div");
  toggle.className = "toggle-button";
  toggle.textContent = "▼ 生成コメントを非表示";

  const commentArea = document.createElement("div");
  commentArea.className = "analysis-area";
  const textarea = document.createElement("textarea");
  textarea.className = "editable-room-comment";
  textarea.style.cssText = "width:100%;font-size:13px;resize:none;";
  textarea.value = commentText;

  const toolRow = document.createElement("div");
  toolRow.style.cssText = "display:grid;grid-template-columns:auto 1fr auto;align-items:center;margin-top:4px;gap:8px;";

  const regenBtn = document.createElement("button");
  regenBtn.innerHTML = "↻";
  regenBtn.title = "コメントを再生成";
  regenBtn.className = "texel-regenerate-btn";
  regenBtn.style.cssText = "background:transparent;border:none;font-size:20px;cursor:pointer;color:#666;transition:transform .2s;line-height:1;";

  const copyBtn = document.createElement("button");
  copyBtn.textContent = "📋 コピー";
  copyBtn.className = "copy-button";
  copyBtn.style.justifySelf = "center";
  copyBtn.onclick = () => {
    navigator.clipboard
      .writeText(textarea.value.trim())
      .then(() => showCopyNotification("クリップボードへコピーしました"))
      .catch(() => showCopyNotification("コピーに失敗しました"));
  };

  const counter = document.createElement("span");
  counter.style.cssText = "font-size:12px;color:#555;justify-self:end;";

  toolRow.append(regenBtn, copyBtn, counter);
  commentArea.append(textarea, toolRow);

  regenBtn.onclick = async () => {
    regenBtn.setAttribute("aria-busy", "true");
    regenBtn.disabled = true;
    regenBtn.classList.add("spin");
    try {
      await analyzeRoomPhotoWithGPT(
        imageSrc,
        imageSrc,
        wrapper.dataset.roomType ?? "",
        wrapper.dataset.description ?? "",
        [textarea.value],
        true,
        wrapper
      );
    } finally {
      regenBtn.classList.remove("spin");
      regenBtn.disabled = false;
      regenBtn.removeAttribute("aria-busy");
    }
  };

  const updateCount = () => {
    const len = textarea.value.replace(/\r\n/g, "\n").length;
    counter.textContent = `${len}`;
  };
  textarea.addEventListener("input", () => {
    autoGrow(textarea);
    updateCount();
    autosaveDebounced();
  });
  updateCount();

  toggle.onclick = () => {
    const hidden = textarea.style.display === "none";
    textarea.style.display = hidden ? "block" : "none";
    toolRow.style.display = hidden ? "grid" : "none";
    toggle.textContent = hidden ? "▼ 生成コメントを非表示" : "▶ 生成コメントを表示";
  };

  wrapper.append(closeBtn, img, toggle, commentArea);
  if (insertAfter) insertAfter.after(wrapper);
  else historyContainer.prepend(wrapper);

  requestAnimationFrame(() => autoGrow(textarea));

  roomPreview.src = "";
  roomPreview.style.display = "none";
  updateRoomAnalysisStatus();

  await saveExportJson();
}

/* ==============================
 * 19) 共通ユーティリティ
 * ============================== */
function autoGrow(el, minH = 60) { if (!el) return; el.style.height = "auto"; el.style.height = Math.max(el.scrollHeight, minH) + "px"; }
function updateGenerateButtonLabel() {
  const available = !!floorplanAnalysisResult;
  generateButton.disabled = !available;
  generateButton.textContent = hasRoomAnalysis ? "間取図と画像から生成" : "間取図から生成";
}
function updateRoomAnalysisStatus() {
  hasRoomAnalysis = [...historyContainer.querySelectorAll(".drop-zone")]
    .some((w) => w.querySelector("textarea")?.value.trim());
  updateGenerateButtonLabel();
}
function showCopyNotification(message = "クリップボードへコピーしました") {
  const note = document.createElement("div");
  note.textContent = message;
  note.style.cssText = `position: fixed; bottom: 10%; left: 50%; transform: translateX(-50%);
    background: #333; color: #fff; padding: 8px 16px; border-radius: 6px; font-size: 13px;
    min-width: 260px; text-align: center; opacity: 0; transition: opacity .3s ease; z-index: 9999;`;
  document.body.appendChild(note);
  requestAnimationFrame(() => (note.style.opacity = "1"));
  setTimeout(() => {
    note.style.opacity = "0";
    note.addEventListener("transitionend", () => note.remove());
  }, 2000);
}
function showCodeBanner(codeText) {
  const banner = document.getElementById("code-banner");
  if (!banner) return;
  banner.textContent = `${codeText}`;
  banner.style.display = "block";
}
function getTextareaValue(id) {
  const el = document.getElementById(id);
  return el && typeof el.value === "string" ? el.value.trim() : "";
}
function bindImagePopup() {
  const overlay = document.getElementById("image-popup-overlay");
  const popupImg = document.getElementById("image-popup");
  if (!overlay || !popupImg) return;
  document.body.addEventListener("click", (e) => {
    if (
      e.target.tagName === "IMG" &&
      (e.target.closest(".drop-zone") ||
        e.target.id === "floorplan-preview" ||
        e.target.id === "pdf-image-preview")
    ) {
      const src = e.target.src;
      if (src) {
        popupImg.src = src;
        overlay.style.display = "flex";
      }
    }
  });
  overlay.addEventListener("click", () => { overlay.style.display = "none"; popupImg.src = ""; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { overlay.style.display = "none"; popupImg.src = ""; } });
}

/* --- スピナーCSS注入 --- */
(function injectSpinnerStyleOnce() {
  if (document.getElementById("texel-spinner-style")) return;
  const style = document.createElement("style");
  style.id = "texel-spinner-style";
  style.textContent = `
    @keyframes texel-rotate { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .texel-regenerate-btn { display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px; border-radius:6px; transform-origin:50% 50%; user-select:none; }
    .texel-regenerate-btn.spin { animation: texel-rotate 0.9s linear infinite; }
    .texel-regenerate-btn[aria-busy="true"] { opacity: .7; cursor: progress; }
  `;
  document.head.appendChild(style);
})();

/* ==============================
 * 20) 方位UI → 間取り解析起動
 * ============================== */
function showNorthSelector() {
  const wrap = document.getElementById("northSelectorWrap");
  if (!wrap) return;
  wrap.style.display = "grid";
  wrap.dataset.active = "1";
}
function hideNorthSelector() {
  const wrap = document.getElementById("northSelectorWrap");
  if (!wrap) return;
  wrap.style.display = "none";
  wrap.dataset.active = "0";
  wrap.classList.remove("highlight","danger","error","red");
}


async function onConfirmNorth() {
  const sel = document.getElementById("northVectorSelect");
  const north = (sel?.value || "up").trim();
  if (!currentFloorplanBase64) { alert("間取り図画像がありません。"); return; }

  // 1) 間取り解析（この結果が textarea に入り、写真プロンプトで参照される）
  await analyzeFloorplanWithGPT(currentFloorplanBase64, north);

  // 2) 退避しておいた「間取り含む写真」を、このタイミングで解析
  const confirmBtn = document.getElementById("confirmNorthButton");
  if (confirmBtn?.dataset?.deferRoomImages) {
    try {
      const list = JSON.parse(confirmBtn.dataset.deferRoomImages);
      if (Array.isArray(list) && list.length) {
        await analyzeRoomImagesSequentially(list);
      }
    } catch {}
    confirmBtn.dataset.deferRoomImages = "";
  }

  // 3) おすすめ → ポータル（空欄のみ）を自動生成
  if (typeof runSuggestionAndPortals === "function") {
    await runSuggestionAndPortals();
  }

  hideNorthSelector(); // ★ ここでも明示的に閉じる
  await saveExportJson();
}


/* ==============================
 * 21) GPT / Rehouse API / Save / 文字数など
 * ============================== */
async function callGPT(body) {
  // GPTProxy ラッパ（将来入替に備えて分離）
  return analyzeWithGPT(body);
}

/* --- Rehouse 物件取得（作業前と同じ“直叩き”一本化） --- */
async function fetchPropertyData(codeOrBk) {
  const bk = String(codeOrBk || "").trim();
  if (!bk) throw new Error("BK/物件コードが空です");

  const url = `https://www.rehouse.co.jp/rehouse-api/api/v1/salesProperties/${encodeURIComponent(bk)}`;
  console.info("[Texel] Rehouse (direct):", url);

  const res = await fetch(url, { cache: "no-cache" });
  if (res.ok) return await res.json();
  if (res.status === 404) {
    console.info("[Texel] Rehouse 直叩き: 404（該当なし）");
    return null;
  }
  throw new Error(`Rehouse API 取得失敗: ${res.status} ${res.statusText}`);
}

/* --- 物件メモ生成（commitment-master を反映） --- */
// Rehouseレスポンスの構造差異に強い堅牢版
/** 物件 JSON から「AI参照用メモ」を生成（SnapVoice準拠） */
function generatePropertyMemo(data, commitmentMaster = {}) {
  if (!data) return "";

  const uniq = (arr) => [...new Set(arr)];
  const line = (label, v) => `${label}：${v}`;
  const sqm2Tsubo = (v) => {
    const tsubo = Math.floor(v * 0.3025 * 100) / 100;
    return `${v}㎡（約${tsubo.toFixed(2)}坪）`;
  };
  const dirJP = { N:"北", S:"南", E:"東", W:"西", NE:"北東", NW:"北西", SE:"南東", SW:"南西" };
  const roadJP = { PB:"公道", PR:"私道", PV:"私道" };

  // 分類・住所・基本項目
  const propertyTypeLabel = resolvePropertyTypeFromItem(data.propertyItem);
  const category = classifyPropertyType(data.propertyItem);
  const address = `${data.prefecture?.name || ""}${data.city?.name || ""}${data.town?.name || ""}`;

  // 交通
  const access = (data.transportations || [])
    .map(t => {
      const ln = t.railway?.name || "";
      const st = t.station?.name || "駅名不明";
      if (t.accessMinutes != null) return `${ln}${st}駅 徒歩${t.accessMinutes}分`;
      if (t.busStopName && t.busRidingMinutes != null && t.busAccessMinutes != null)
        return `${ln}${st}駅 バス${t.busRidingMinutes}分「${t.busStopName}」停歩${t.busAccessMinutes}分`;
      return null;
    })
    .filter(Boolean).join("、") || "交通情報なし";

  // 面積・間取り・築年など
  const exclusiveArea = data.exclusiveArea ? sqm2Tsubo(data.exclusiveArea) : null;
  const landArea      = data.landArea ? sqm2Tsubo(data.landArea) : null;
  const buildingArea  = data.grossFloorArea ? sqm2Tsubo(data.grossFloorArea) : null;
  const floorPlan     = data.floorPlanText || `${data.roomCount ?? ""}LDK`;
  const built         = data.builtYearMonth ? (data.builtYearMonth.replace("-", "年") + "月築") : null;
  const floorInfo     = data.floorNumber ? `${data.floorNumber}階 / 地上${data.story || "?"}階` + (data.undergroundStory ? ` 地下${data.undergroundStory}階建` : "") : null;
  const balconyDir    = dirJP[data.balconyDirection] || data.balconyDirection || null;

  // 接道
  let roadLine = null;
  if (Array.isArray(data.connectingRoads) && data.connectingRoads.length) {
    const roads = data.connectingRoads.map(r => {
      const d  = dirJP[r.direction] || r.direction || "";
      const w  = r.width != null ? `約${parseFloat(r.width).toFixed(1)}m` : "";
      const rt = roadJP[r.roadType] || r.roadType || "";
      return [d && `${d}側`, w, rt].filter(Boolean).join(" ").trim();
    }).filter(Boolean);
    const uniqRoads = uniq(roads);
    roadLine = uniqRoads.join("／");
    if (uniqRoads.length >= 2) roadLine += "（角地）";
  }

  // 建ぺい率／容積率
  let bcrFarLine = null;
  const lr = data.landInformation?.landRestrictions?.[0];
  if (lr) {
    const conv = v => (v < 1) ? v*100 : (v < 10 && Number.isInteger(v)) ? v*100 : v;
    const bcr = lr.buildingCoverageRatio != null ? conv(lr.buildingCoverageRatio) : null;
    const far = lr.floorAreaRatio      != null ? conv(lr.floorAreaRatio)      : null;
    if (bcr != null && far != null) bcrFarLine = `${Math.round(bcr)}%／${Math.round(far)}%`;
  }

  // ① 基本情報
  const L = [
    "■ 物件の基本情報",
    line("物件種別", propertyTypeLabel),
    line("価格", `${(data.price).toLocaleString()}万円`),
    line("所在地", address),
    line("交通", access),
  ];

  // ② カテゴリー別
  switch (category) {
    case "mansion":
      if (exclusiveArea) L.push(line("専有面積", exclusiveArea));
      if (floorPlan)     L.push(line("間取り", floorPlan));
      if (built)         L.push(line("築年月", built));
      if (floorInfo)     L.push(line("階数", floorInfo));
      if (balconyDir)    L.push(line("向き", balconyDir));
      break;
    case "house":
      if (landArea)     L.push(line("土地面積", landArea));
      if (buildingArea) L.push(line("建物面積", buildingArea));
      if (floorPlan)    L.push(line("間取り", floorPlan));
      if (built)        L.push(line("築年月", built));
      break;
    case "land":
      if (landArea) L.push(line("土地面積", landArea));
      break;
    default:
      if (landArea)     L.push(line("土地面積", landArea));
      if (buildingArea) L.push(line("建物面積", buildingArea));
      if (exclusiveArea)L.push(line("専有面積", exclusiveArea));
  }

  // 共通追加
  if (roadLine)   L.push(line("接道状況", roadLine));
  if (bcrFarLine) L.push(line("建ぺい率／容積率", bcrFarLine));

  // ③ 特徴・備考（commitmentMaster でコード→ラベル解決）
  const commitments = (data.commitmentInformations || [])
    .map(info => {
      const code = String(info.commitmentCode ?? info.code ?? "");
      const name = info.name || commitmentMaster[code] || "";
      if (!name || /使用料|円|費|管理費|修繕/.test(name)) return null;
      const suf = info.distance != null ? (info.distance >= 50 ? "m" : "円") : "";
      return `・${name}${info.distance != null ? `（約${info.distance}${suf}）` : ""}`;
    })
    .filter(Boolean);

  const remarks = (data.recommendedInfo || "")
    .split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 1)
    .map(s => `・${s.replace(/^○|^〇/, "")}`);

  if (commitments.length) { L.push("", "■ 特徴・設備・条件など", ...uniq(commitments)); }
  if (remarks.length)     { L.push("", "■ 担当者記載", ...uniq(remarks)); }

  // ④ リフォーム
  if ((data.renovationInfos || []).length) {
    const reno = data.renovationInfos.map(r => {
      const d = r.renovationYearMonth ? r.renovationYearMonth.replace("-", "年") + "月" : "";
      return `・${r.renovationPoint}${d ? `（${d}実施）` : ""}`;
    });
    L.push("", "■ リフォーム情報", ...uniq(reno));
  }

  return L.join("\n");
}

// S-NET の /resizeImage? ... &w=XXX を指定幅にそろえる
function suumoResizeWidth(url, width = 500) {
  try {
    const u = new URL(url, location.origin);
    if (/\/resizeImage/i.test(u.pathname)) {
      u.searchParams.set("w", String(width));
      // 高さ指定があると縦横が固定されて縮むケースがあるので削除（幅優先）
      if (u.searchParams.has("h")) u.searchParams.delete("h");
      return u.href;
    }
    return url;
  } catch { return url; }
}

/* SnapVoice 準拠の型判定ヘルパー（Texel に無ければ追加） */
function classifyPropertyType(item) {
  const mansion = ["01","02","03","04","05","06","07","08","09","10","11","12","98"];
  const house   = ["14","15","20","21","23","24"];
  const land    = ["33","34","35"];
  if (mansion.includes(item)) return "mansion";
  if (house.includes(item))   return "house";
  if (land.includes(item))    return "land";
  return "other";
}
function resolvePropertyTypeFromItem(item) {
  const map = {
    "14":"新築戸建","15":"中古戸建","20":"新築テラスハウス","21":"中古テラスハウス",
    "01":"新築マンション","02":"中古マンション","03":"新築公団","04":"中古公団","05":"新築公社","06":"中古公社",
    "07":"新築タウンハウス","08":"中古タウンハウス","09":"リゾートマンション（区分所有）","10":"店舗（区分所有）",
    "11":"事務所（区分所有）","12":"店舗・事務所（区分所有）","98":"その他（区分所有）",
    "22":"店舗（一棟）","23":"店舗付住宅","24":"住居付店舗","25":"事務所（一棟）","26":"店舗・事務所（一棟）",
    "16":"ビル","27":"工場","17":"マンション一括","28":"倉庫","19":"アパート一括","29":"寮","30":"旅館","31":"ホテル",
    "32":"別荘","18":"リゾートマンション（一棟）","99":"その他（一棟）","33":"売地","34":"借地権","35":"底地権"
  };
  return map[item] || "物件種別不明";
}


/* --- 物件の部屋画像を順次解析（自動投入） --- */
async function analyzeRoomImagesSequentially(images) {
  for (const img of images) {
    const url = img?.url || img;
    if (!url) continue;
    try {
     const b64 = img.base64 || await convertUrlToBase64ViaFunctionBase(url);
     await analyzeRoomPhotoWithGPT(b64, url, img?.title || "", (img?.desc || "自動取込"));
      await delay(200);
    } catch (e) {
      console.warn("room image解析失敗", e);
    }
  }
}

// --- スプレッドシート保存（CORS回避＆旧GAS契約） ---
async function saveToSpreadsheet(payload) {
  const sheetSaveUrl =
    (typeof SHEET_API === "string" && SHEET_API) ||
    (SHEET_API && typeof SHEET_API.save === "string" && SHEET_API.save) ||
    "";

  if (!sheetSaveUrl || !/^https?:\/\//i.test(sheetSaveUrl)) {
    console.error("❌ SHEET_API が不正です:", SHEET_API);
    throw new Error("SHEET_API misconfigured");
  }

  // ✅ 旧GAS契約に合わせてラップ（クエリ ?sheetId= を廃止）
  const body = {
    mode: "upsertByCode",
    propertyCode: payload.propertyCode,
    spreadsheetId: payload.spreadsheetId || payload.sheetId || sessionSheetId,
    data: payload
  };

  try {
    // ✅ プリフライトを発生させない（結果は読めないが投げ切りできる）
    await fetch(sheetSaveUrl, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body)
    });
    console.info("📤 Sheet save posted (no-cors).");
  } catch (err) {
    console.error("❌ sheet save failed", err);
  }
}

/* --- 文字数カウンタ --- */
function setupCharCount(textareaId, counterId, limit) {
  const ta = document.getElementById(textareaId);
  const cn = document.getElementById(counterId);
  if (!ta || !cn) return;
  const update = () => {
    const len = (ta.value || "").replace(/\r\n/g, "\n").length;
    cn.textContent = `${len}/${limit}`;
    cn.style.color = len > limit ? "#c00" : "#555";
  };
  ta.addEventListener("input", () => { update(); autosaveDebounced(); });
  update();
}

/* --- オートセーブ（入力にフック） --- */
function attachAutoSave(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("input", autosaveDebounced);
}

/* ==============================
 * 22) おすすめ生成 / 要約 / 元に戻す
 * ============================== */
async function onGenerateSuggestions() {
  try {
    showLoadingSpinner("suggestion");
    const promptObj = await getPromptObj("suggestion", P.suggestion);
    const params = promptObj.params || {};
    const basePrompt = promptObj.prompt || "";

    const combined = buildCombinedSource();
    const messages = [
      { role: "system", content: basePrompt },
      { role: "user", content: combined }
    ];
    const body = {
      messages,
      temperature: params.temperature ?? 0.35,
      max_tokens: params.max_tokens ?? 4000,
      top_p: params.top_p,
      frequency_penalty: params.frequency_penalty,
      presence_penalty: params.presence_penalty,
      purpose: "suggestion"
    };
    const result = await callGPT(body);
    const text = result?.choices?.[0]?.message?.content?.trim() || "";
    const ta = document.querySelector("#suggestion-area textarea");
    if (ta) {
      if (!originalSuggestionText) originalSuggestionText = ta.value || "";
      ta.value = text;
      autoGrow(ta, 120);
    }
    await saveExportJson();
    updateResetSuggestionBtn?.();
  } catch (e) {
    console.error("おすすめ生成失敗", e);
    alert("おすすめポイントの生成に失敗しました。");
  } finally {
    hideLoadingSpinner("suggestion");
  }
}

// ===== ポータル4種（空欄のみ自動生成） =====
async function generatePortals({ force = false } = {}) {
  const fields = [
    { id: "suumo-catch",   pkey: "suumoCatch",   file: P.suumoCatch,   purpose: "suumo-catch",   limit: 37 },
    { id: "suumo-comment", pkey: "suumoComment", file: P.suumoComment, purpose: "suumo-comment", limit: 300 },
    { id: "athome-comment",pkey: "athomeComment",file: P.athomeComment,purpose: "athome-comment",limit: 100 },
    { id: "athome-appeal", pkey: "athomeAppeal", file: P.athomeAppeal, purpose: "athome-appeal", limit: 500 },
  ];

  const combined = buildCombinedSource();

  for (const f of fields) {
    const ta = document.getElementById(f.id);
    if (!ta) continue;
    const current = (ta.value || "").trim();
    if (!force && current) continue; // 既入力は保持

    // プロンプト取得
    const promptObj = await getPromptObj(f.pkey, f.file);
    const prompt = promptObj.prompt || "";
    const params = promptObj.params || {};

    const messages = [
      { role: "system", content: prompt },
      { role: "user",   content: combined }
    ];
    const body = {
      messages,
      temperature: params.temperature ?? 0.35,
      max_tokens:  params.max_tokens  ?? 800,
      top_p: params.top_p,
      frequency_penalty: params.frequency_penalty,
      presence_penalty:  params.presence_penalty,
      purpose: f.purpose
    };

    try {
      const res  = await callGPT(body);
      const text = res?.choices?.[0]?.message?.content?.trim() || "";
      if (text) {
        ta.value = text;
        // 文字数カウンタがあれば更新
        const counterId = {
          "suumo-catch": "suumo-catch-count",
          "suumo-comment": "suumo-comment-count",
          "athome-comment": "athome-comment-count",
          "athome-appeal": "athome-appeal-count",
        }[f.id];
        if (counterId) {
          const cn = document.getElementById(counterId);
          if (cn) {
            const len = text.replace(/\r\n/g, "\n").length;
            cn.textContent = `${len}/${f.limit}`;
            cn.style.color = len > f.limit ? "#c00" : "#555";
          }
        }
      }
    } catch (e) {
      console.warn(`ポータル生成失敗 (${f.id})`, e);
    }
  }

  await saveExportJson();
}

// おすすめ → ポータル4種 まで一気に回すヘルパー
async function runSuggestionAndPortals() {
  // おすすめポイント生成（既存どちらかに合わせて呼ぶ）
  if (typeof generateSuggestionPoints === "function") {
    await generateSuggestionPoints();
  } else if (typeof runSuggestionFlow === "function") {
    await runSuggestionFlow();
  } else {
    const btn = document.getElementById("generate-suggestions") || document.getElementById("generateSuggestionButton");
    if (btn) btn.click();
  }
  // おすすめ反映後にポータル4種も自動生成
  if (typeof generatePortals === "function") {
    await generatePortals({ force: false }); // 既入力は上書きしない
  }
}

/* === 高解像度化ユーティリティ（Rehouse/一般） === */
function upgradeImageUrl(u) {
  try {
    const url = new URL(u, location.origin);

    // 例: .../resizeImage?src=...&w=480&h=320 → w=1600,h=1200 に上げる
    if (/\/resizeImage/i.test(url.pathname)) {
      url.searchParams.set("w", "1600");
      url.searchParams.set("h", "1200");
      return url.href;
    }

    // よくあるクエリの幅・高さパラメータを上書き
    const W_KEYS = ["w","width","maxwidth","mw"];
    const H_KEYS = ["h","height","maxheight","mh"];
    let touched = false;
    for (const k of W_KEYS) if (url.searchParams.has(k)) { url.searchParams.set(k,"1600"); touched = true; }
    for (const k of H_KEYS) if (url.searchParams.has(k)) { url.searchParams.set(k,"1200"); touched = true; }
    if (touched) return url.href;

    // サムネ系パスの置換（Rehouse でありがち）
    let p = url.pathname.replace(/\/thumb\//i,"/").replace(/\/s\//i,"/l/").replace(/_s(\.\w+)$/i,"$1");
    if (p !== url.pathname) { url.pathname = p; return url.href; }

    return url.href;
  } catch { return u; }
}

/** 要約を再生成してメモ欄に反映する（SnapVoice準拠の安全版） */
async function onRegenerateSummary() {
  try {
    // プロンプト取得（ローカル/Blob/デフォルトの順）
    const promptObj = await getPromptObj("summary", P.summary);
    const params    = promptObj.params || {};
    const basePrompt= promptObj.prompt || "与えられた情報を、購入検討者にも伝わる要約にしてください。";

    // これまで集めた材料をひとまとめにする
    const combined = buildCombinedSource();

    // GPT 呼び出し
    const body = {
      messages: [
        { role: "system", content: basePrompt },
        { role: "user",   content: combined }
      ],
      temperature: params.temperature ?? 0.3,
      max_tokens:  params.max_tokens ?? 2000,
      top_p: params.top_p,
      frequency_penalty: params.frequency_penalty,
      presence_penalty:  params.presence_penalty,
      purpose: "summary"
    };
    const res  = await callGPT(body);
    const text = res?.choices?.[0]?.message?.content?.trim() || "";

    // メモ欄を更新（APIメモが無い/空なら先に復元→要約を追記）
    const memoEl = document.getElementById("property-info");
    if (memoEl) {
      const hasMemo = !!memoEl.value.trim();

      // Rehouse API からの素メモ復元（SnapVoiceのロジック）
      if (!hasMemo && basePropertyData) {
        const apiMemo = generatePropertyMemo(basePropertyData, promptMap);
        if (apiMemo) memoEl.value = apiMemo;
      }

      // 要約の反映（上書きではなく追記）
      if (text) {
        memoEl.value = (memoEl.value ? memoEl.value + "\n\n" : "")
          + "【AI要約】\n" + text;
      }

      autoGrow(memoEl);
    }

    await saveExportJson();
  } catch (e) {
    console.error("onRegenerateSummary 失敗:", e);
    alert("要約の生成に失敗しました。ネットワーク状況等をご確認ください。");
  }
}


function updateResetSuggestionBtn() {
  const btn = document.getElementById("reset-suggestion");
  const ta = document.querySelector("#suggestion-area textarea");
  if (!btn || !ta) return;
  btn.disabled = !originalSuggestionText || originalSuggestionText === ta.value;
}

function onClickResetSuggestion() {
  const ta = document.querySelector("#suggestion-area textarea");
  if (!ta) return;
  ta.value = originalSuggestionText || "";
  autoGrow(ta, 120);
  updateResetSuggestionBtn();
}

/* ==============================
 * 23) SUUMO/athome 文字カウントセット（起動時に呼び出し）
 * ============================== */
// 起動後、ベース/TYPE-R/S の分岐でそれぞれ setupCharCount を呼ぶ実装にしているためここでは定義のみ

/* ==============================
 * 24) END
 * ============================== */
