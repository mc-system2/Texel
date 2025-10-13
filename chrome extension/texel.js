/* =====================================================================
 *  Texel.js  ― Texel (external-only, clean, no hashtags)
 *  - BLOB の commitment-master を dev/prod 自動切替で読込（SWA → 拡張 → BLOB）
 *  - 物件APIから間取り図URLを推測 → Base64化 → プレビュー表示
 *  - PDF 要約 / 間取り図解析 / 部屋写真解析 / SUUMO / athome 文言生成
 *  - 画像URL→Base64 は API.image2base64 に統一
 *  - localStorage/chrome.storage.local のキーは texel-* で統一
 *  - ★ おすすめ/ポータル生成は「間取り図分析＋部屋写真コメント＋AI参照用メモ(+PDF)」を材料に送信
 *  - ★ クライアントカタログ texel-client-catalog.json を純JSONでロード（ローカルに複製しない）
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
let propertyCode = "";                 // 例：FXXXXXXX
let sheetIdForGPT = DEFAULT_SHEET_ID;  // ユーザー入力から差し替え
let sessionSheetId = sheetIdForGPT;

let basePropertyData = null;
let promptMap = {};                    // commitment-master（読み分け）
let clientCatalog = {};                // CL→プロファイル（純JSON）
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
const CLIENT_CATALOG_FILE    = "texel-client-catalog.json"; // 純JSON

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
  for (const url of buildCommitmentMasterUrls()) {
    try {
      const r = await fetch(url, { cache: "no-cache" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const ctype = r.headers.get("content-type") || "";
      let data;
      if (ctype.includes("application/json")) data = await r.json();
      else data = JSON.parse(await r.text());
      promptMap = data.mapping || data.prompt || data || {};
      console.info("✅ commitment-master loaded from:", url);
      return;
    } catch (e) {
      tried.push(`${url} (${e.message})`);
    }
  }
  promptMap = {};
  const last = tried[tried.length - 1] || "";
  const msg = String(last).includes("HTTP 404") || String(last).includes("HTTP 409")
    ? "commitment-master not found or not publicly accessible (fallback to empty)."
    : "commitment-master load skipped (fallback to empty).";
  console.info("ℹ️", msg, last);
}
loadCommitmentMaster().catch(() => {});

/* ================= クライアントカタログ読み込み（純JSON / ノーキャッシュ） ================ */
async function loadClientCatalog(){
  try{
    const url = API.loadPromptText(CLIENT_CATALOG_FILE);
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // 受理形：A) 純JSON {..} / B) ラッパ {prompt:{..}, params?:{}}
    clientCatalog =
      (data && typeof data.prompt === "object")
        ? data.prompt
        : (data && typeof data === "object")
          ? data
          : {};
    console.info("✅ client-catalog loaded", Object.keys(clientCatalog));
  }catch(e){
    clientCatalog = {};
    console.warn("⚠️ client-catalog load failed:", e);
  }
  return clientCatalog;
}
function getClientProfile(clId){
  return clId ? clientCatalog?.[clId] ?? null : null;
}

/* ==============================
 * 3) ユーティリティ
 * ============================== */
const autosaveDebounced = debounce(() => saveExportJson().catch(() => {}), 600);
function extractSpreadsheetId(text) { const m = text.trim().match(/\/d\/([a-zA-Z0-9-_]+)/); return m ? m[1] : text.trim(); }
function debounce(fn, ms = 500) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }

/* ---------- Loading Spinner（参照カウント） ---------- */
const spinnerCounter = Object.create(null);
function showLoadingSpinner(target) { const el = document.getElementById(`loadingSpinner-${target}`); if (!el) return; spinnerCounter[target] = (spinnerCounter[target] || 0) + 1; el.style.display = "block"; }
function hideLoadingSpinner(target) { const el = document.getElementById(`loadingSpinner-${target}`); if (!el) return; spinnerCounter[target] = Math.max((spinnerCounter[target] || 1) - 1, 0); if (spinnerCounter[target] === 0) el.style.display = "none"; }
function attachAutoSave(id, evt = "input") { const el = document.getElementById(id); if (!el || el.dataset.autosave) return; el.dataset.autosave = "1"; el.addEventListener(evt, autosaveDebounced); }

/* ====== 新規：ネタ元を束ねる（おすすめ／ポータル共通） ====== */
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
 * 4) 入力バリデーション
 * ============================== */
function validateInput() {
  const pcIn = document.getElementById("property-code-input");
  const ssIn = document.getElementById("spreadsheet-id-input");
  const btn = document.getElementById("property-code-submit");
  const pcVal = pcIn.value.trim().toUpperCase();
  const ssVal = ssIn.value.trim();
  pcIn.value = pcVal;
  btn.disabled = !(pcVal && ssVal);
}

/* ==============================
 * 5) プロンプト取得 + フォールバック
 * ============================== */

/** BLOB(Functions) から {prompt, params} を吸収的に取得 */
async function fetchPromptTextFile(filename) {
  try {
    // ※ API.loadPromptText 側で encodeURIComponent 済み。ここではそのまま渡す。
    const url = API.loadPromptText(filename);
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) {
      console.warn(`LoadPromptText 失敗: ${res.status} ${res.statusText}`);
      return null;
    }

    const ctype = res.headers.get("content-type") || "";
    if (ctype.includes("application/json")) {
      const data = await res.json().catch(() => ({}));

      if (typeof data === "string") return { prompt: data, params: {} };

      let promptText = "";
      if (typeof data?.prompt === "string") {
        promptText = data.prompt;
      } else if (typeof data?.prompt?.text === "string") {
        promptText = data.prompt.text;
      } else {
        promptText = JSON.stringify(data?.prompt ?? data, null, 2);
      }
      return { prompt: promptText, params: data?.params || {} };
    }

    const text = await res.text();
    return { prompt: text, params: {} };

  } catch (e) {
    console.warn("LoadPromptText 例外:", e);
    return null;
  }
}

/** localStorage → chrome.storage.local → BLOB の順で探索し、見つかったら両方へキャッシュ */
async function getPromptObj(keyLike, filename) {
  const cacheKey = storageKeyFor(keyLike);

  // 1) localStorage
  const local = localStorage.getItem(cacheKey);
  if (local !== null) {
    console.info(`[prompt] localStorage 使用: ${cacheKey}`);
    try { return JSON.parse(local); } catch { return { prompt: local, params: {} }; }
  }

  // 2) chrome.storage.local
  try {
    if (chrome?.storage?.local) {
      const got = await new Promise((r) =>
        chrome.storage.local.get([cacheKey], (ret) => r(ret?.[cacheKey] ?? null))
      );
      if (got !== null) {
        console.info(`[prompt] chrome.storage 使用: ${cacheKey}`);
        try { return JSON.parse(got); } catch { return { prompt: got, params: {} }; }
      }
    }
  } catch {}

  // 3) BLOB（取得できたら両方へキャッシュ）
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
    hideLoadingSpinner("suggestion");
    hideLoadingSpinner("pdf");
    return;
  }
  const exportJson = {
    propertyCode,
    sheetIdForGPT,
    timestamp: new Date().toISOString(),
    pdfExtractedText: latestPdfExtractedText || document.getElementById("pdf-preview")?.textContent?.trim() || "",
    pdfImage: latestPdfThumbnailBase64 || document.getElementById("pdf-image-preview")?.src || "",
    memo: document.getElementById("property-info")?.value.trim() || "",
    floorplanAnalysis: document.getElementById("floorplan-preview-text")?.value.trim() || "",
    suggestions: document.querySelector("#suggestion-area textarea")?.value.trim() || "",
    "suumo-catch": getTextareaValue("suumo-catch"),
    "suumo-comment": getTextareaValue("suumo-comment"),
    "athome-comment": getTextareaValue("athome-comment"),
    "athome-appeal": getTextareaValue("athome-appeal"),
    originalSuggestion: originalSuggestionText,
    floorplanImageBase64: document.getElementById("floorplan-preview")?.src || "",
    rawPropertyData: basePropertyData,
    roomComments: (() => {
      const unique = new Set();
      return Array.from(document.querySelectorAll("#history-container .drop-zone"))
        .map((z) => {
          const img = z.querySelector("img")?.src || "";
          const cmt = z.querySelector("textarea")?.value || "";
          const key = img + "___" + cmt;
          if (!img || img.startsWith("chrome-extension://") || !cmt.trim() || unique.has(key)) return null;
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
  script.onload = () => {
    if (window["pdfjsLib"]) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("libs/pdfjs/pdf.worker.js");
    }
  };
  script.onerror = () => console.error("❌ pdf.js 読み込み失敗");
  document.head.appendChild(script);
})();

/* ==============================
 * 10) 物件画像から間取り図候補
 * ============================== */
function guessFloorplanFromPropertyImages(data) {
  const imgs = data?.propertyImages || [];
  if (!Array.isArray(imgs) || !imgs.length) return null;
  const cand = imgs.find(
    (img) =>
      /間取図|区画図/.test(img?.title || "") ||
      /floorplan|floor-plan/i.test(img?.url || "")
  );
  return cand?.url || null;
}

/* ==============================
 * 11) 起動時モーダル／イベント登録
 * ============================== */
document.addEventListener("DOMContentLoaded", async () => {
  userId = await detectUserId();

  // クライアントカタログは起動時に読み込み（管理者のみ更新・UIリンクなし）
  await loadClientCatalog();

  // 歯車：ローカルプロンプトエディタを別ウィンドウで開く
  document.body.addEventListener("click", async (e) => {
    const a = e.target.closest('a.prompt-config-link');
    if (!a) return;
    e.preventDefault();
    const t = a.getAttribute('data-type') || '';
    const url = chrome.runtime.getURL(`local-prompt-editor.html?type=${encodeURIComponent(t)}`);

    // メインウィンドウの新規タブで開く
    if (chrome?.tabs?.create) {
      await chrome.tabs.create({ url });
    } else {
      // 古い環境などのフォールバック
      window.open(url, "_blank");
    }
  });

  // モーダル
  const modal = document.getElementById("property-code-modal");
  const pcIn = document.getElementById("property-code-input");
  const ssIn = document.getElementById("spreadsheet-id-input");
  const btn = document.getElementById("property-code-submit");

  // タイトルや表示は HTML 側の定義をそのまま使う（JSで上書きしない）
  const noWrap = document.getElementById("no-code-wrapper"); // 管理UI未使用のまま

  pcIn.addEventListener("input", validateInput);
  ssIn.addEventListener("input", validateInput);
  window.addEventListener("load", validateInput);

  // 間取り図テキスト自動伸縮
  const fpTextarea = document.getElementById("floorplan-preview-text");
  if (fpTextarea) {
    fpTextarea.classList.add("auto-grow");
    fpTextarea.addEventListener("input", () => autoGrow(fpTextarea));
    autoGrow(fpTextarea);
  }

  // 生成／再要約／元に戻す
  document.getElementById("generate-suggestions").addEventListener("click", onGenerateSuggestions);
  document.getElementById("generate-summary").addEventListener("click", onRegenerateSummary);
  const resetBtn = document.getElementById("reset-suggestion");
  if (resetBtn) {
    resetBtn.addEventListener("click", onClickResetSuggestion);
  }

  // 画像ポップアップ
  bindImagePopup();

  // 方位決定 → 間取り図解析（保留した部屋画像の再開も実施）
  document.getElementById("confirmNorthButton").addEventListener("click", onConfirmNorth);

  // 決定（起動）
  btn.addEventListener("click", async () => {
    propertyCode = pcIn.value.trim().toUpperCase();
    sheetIdForGPT = extractSpreadsheetId(ssIn.value);
    sessionSheetId = sheetIdForGPT;

    showCodeBanner(propertyCode);
    modal.style.display = "none";
    document.querySelectorAll("section.disabled").forEach((sec) => sec.classList.remove("disabled"));

    const memo = document.getElementById("property-info");
    if (memo) {
      memo.addEventListener("input", () => autoGrow(memo));
      autoGrow(memo);
    }

    // 物件データ取得（存在しなければ新規扱い）
    try {
      const data = await fetchPropertyData(propertyCode);
      if (data) {
        basePropertyData = data;
        if (memo) {
          memo.value = generatePropertyMemo(data, promptMap);
          autoGrow(memo);
        }

        const fpUrl = guessFloorplanFromPropertyImages(data) || guessFloorplanUrlFromProperty(data);
        const roomImages = Array.isArray(data.propertyImages) ? data.propertyImages : [];

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
            showNorthVectorDropdown();

            const confirmBtn = document.getElementById("confirmNorthButton");
            if (confirmBtn) {
              confirmBtn.dataset.deferRoomImages = JSON.stringify(roomImages);
            }
          } catch (e) {
            console.warn("間取り図の自動読込に失敗:", e);
            if (roomImages.length) {
              await analyzeRoomImagesSequentially(roomImages);
            }
          } finally {
            hideLoadingSpinner("floorplan");
          }
        } else {
          if (roomImages.length) {
            await analyzeRoomImagesSequentially(roomImages);
          }
        }
      }
    } catch (e) {
      console.warn("物件データ取得スキップ/失敗:", e);
    }

    // 文字数カウンタ
    setupCharCount("suumo-catch", "suumo-catch-count", 37);
    setupCharCount("suumo-comment", "suumo-comment-count", 300);
    setupCharCount("athome-comment", "athome-comment-count", 100);
    setupCharCount("athome-appeal", "athome-appeal-count", 500);

    // オートセーブ
    [
      "property-info",
      "editable-suggestion",
      "suumo-catch",
      "suumo-comment",
      "athome-comment",
      "athome-appeal"
    ].forEach((id) => attachAutoSave(id));
  });

  // DnD バインド
  bindFloorplanDnD();
  bindRoomDnD();

  // PDF DnD/選択
  ["dragenter", "dragover"].forEach((evt) =>
    pdfDrop.addEventListener(evt, (e) => {
      e.preventDefault();
      pdfDrop.classList.add("highlight");
    })
  );
  pdfDrop.addEventListener("dragleave", (e) => {
    e.preventDefault();
    pdfDrop.classList.remove("highlight");
  });
  pdfDrop.addEventListener("drop", async (e) => {
    e.preventDefault();
    pdfDrop.classList.remove("highlight");
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

  // 最初は「元に戻す」ボタンの状態を同期
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
// texel.js —— 画像URL→Base64
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
// 互換名（既存呼び出しをそのままにする）
async function convertUrlToBase64ViaFunctionBase(imageUrl) {
  return convertUrlToBase64ViaAPI(imageUrl);
}

/* ==============================
 * 13) 間取り図 DnD
 * ============================== */
function bindFloorplanDnD() {
  if (floorplanDrop.dataset.bound) return;
  floorplanDrop.dataset.bound = "1";

  ["dragenter", "dragover"].forEach((evt) => {
    floorplanDrop.addEventListener(evt, (e) => {
      e.preventDefault();
      floorplanDrop.classList.add("highlight");
    });
  });
  floorplanDrop.addEventListener("dragleave", (e) => {
    e.preventDefault();
    floorplanDrop.classList.remove("highlight");
  });
  floorplanDrop.addEventListener("drop", async (e) => {
    e.preventDefault();
    floorplanDrop.classList.remove("highlight");

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
        showNorthVectorDropdown();
        return;
      }
      if (src.startsWith("http")) {
        try {
          showLoadingSpinner("floorplan");
          const base64 = await convertUrlToBase64ViaFunctionBase(src);
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
          floorplanPreview.src = base64;
          currentFloorplanBase64 = base64;
          showNorthVectorDropdown();
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
        floorplanPreview.onload = () => {
          floorplanPreview.style.display = "block";
          floorplanPreview.style.cursor = "pointer";
        };
        setTimeout(() => {
          floorplanPreview.style.display = "block";
          floorplanPreview.style.cursor = "pointer";
        }, 200);
        floorplanPreview.src = base64;
        currentFloorplanBase64 = base64;
        showNorthVectorDropdown();
      } finally { hideLoadingSpinner("floorplan"); }
      return;
    }

    console.warn("❌ ドロップされた間取り図画像が処理できませんでした");
  });

  floorplanSelect.addEventListener("change", (e) => {
    handleFloorplanFile(e.target.files[0]);
  });
}
async function handleFloorplanFile(file) {
  if (!file || !file.type.startsWith("image/")) return;
  showLoadingSpinner("floorplan");
  try {
    floorplanPreview.src = "";
    floorplanPreview.style.display = "none";
    const b64 = await readImageAsBase64(file);
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
    showNorthVectorDropdown();
  } finally { hideLoadingSpinner("floorplan"); }
}

/* ==============================
 * 14) 部屋写真 DnD
 * ============================== */
function bindRoomDnD() {
  ["dragenter", "dragover"].forEach((evt) => {
    roomDrop.addEventListener(evt, (e) => {
      e.preventDefault();
      roomDrop.classList.add("highlight");
    });
  });
  roomDrop.addEventListener("dragleave", (e) => {
    e.preventDefault();
    roomDrop.classList.remove("highlight");
  });
  if (!roomDrop.dataset.bound) {
    roomDrop.dataset.bound = "1";
    roomDrop.addEventListener("drop", async (e) => {
      e.preventDefault();
      roomDrop.classList.remove("highlight");

      const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"));
      if (files.length > 0) {
        for (const file of files) {
          await processRoomFile(file);
          await delay(500);
        }
        return;
      }

      const html = e.dataTransfer.getData("text/html");
      const m = html?.match(/src\s*=\s*["']([^"']+)["']/i);
      if (m) {
        const src = m[1];
        if (src.startsWith("data:image/")) {
          roomPreview.src = src;
          roomPreview.onload = () => {
            roomPreview.style.display = "block";
            roomPreview.style.cursor = "pointer";
          };
          setTimeout(() => {
            roomPreview.style.display = "block";
            roomPreview.style.cursor = "pointer";
          }, 200);
          await analyzeRoomPhotoWithGPT(src, src, "手動分析", "HTMLドラッグ");
          return;
        }
        if (src.startsWith("http")) {
          try {
            const b64 = await convertUrlToBase64ViaFunctionBase(src);
            roomPreview.src = b64;
            roomPreview.onload = () => {
              roomPreview.style.display = "block";
              roomPreview.style.cursor = "pointer";
            };
            setTimeout(() => {
              roomPreview.style.display = "block";
              roomPreview.style.cursor = "pointer";
            }, 200);
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
          roomPreview.onload = () => {
            roomPreview.style.display = "block";
            roomPreview.style.cursor = "pointer";
          };
          setTimeout(() => {
            roomPreview.style.display = "block";
            roomPreview.style.cursor = "pointer";
          }, 200);
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
  roomPreview.onload = () => {
    roomPreview.style.display = "block";
    roomPreview.style.cursor = "pointer";
  };
  setTimeout(() => {
    roomPreview.style.display = "block";
    roomPreview.style.cursor = "pointer";
  }, 200);
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
      if (pdfImagePreview) {
        pdfImagePreview.src = base64Image;
        pdfImagePreview.style.display = "block";
        pdfImagePreview.style.cursor = "pointer";
      }
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
      if (memoArea) {
        memoArea.value += `\n${summarized}`;
        autoGrow(memoArea);
      }
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
    let systemPromptBase = promptObj.prompt || "";
    const params = promptObj.params || {};
    if (!systemPromptBase) systemPromptBase = "これは不動産の間取り図です。内容を読み取り、わかりやすく要約してください。";

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
    if (floorplanAnalysisResult) await saveExportJson();
  }
}

/* ==============================
 * 17) 部屋写真解析（GPT）
 * ============================== */
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
    if (!isRetry && ta) {
      ta.textContent = "解析に失敗しました。";
      ta.style.display = "block";
    }
  } finally {
    hideLoadingSpinner("room");
    saveExportJson().catch(() => {});
  }

  if (!isRetry && ta) {
    ta.textContent = "";
    ta.style.display = "none";
  }
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
  closeBtn.style.cssText =
    "position:absolute;top:0;right:0;background:transparent;border:none;color:#999;font-size:16px;cursor:pointer;padding:4px;z-index:10;";
  closeBtn.onclick = async () => {
    wrapper.remove();
    updateRoomAnalysisStatus();
    await saveExportJson();
  };

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
  toolRow.style.cssText =
    "display:grid;grid-template-columns:auto 1fr auto;align-items:center;margin-top:4px;gap:8px;";

  // ▼ 再生成ボタン（スピン対応）
  const regenBtn = document.createElement("button");
  regenBtn.innerHTML = "↻";
  regenBtn.title = "コメントを再生成";
  regenBtn.className = "texel-regenerate-btn"; // ← CSSで回転中心など調整
  regenBtn.style.cssText =
    "background:transparent;border:none;font-size:20px;cursor:pointer;color:#666;transition:transform .2s;line-height:1;";

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

  // ▼ くるくる実装：押下→回転ON、完了→回転OFF
  regenBtn.onclick = async () => {
    // aria と disabled をセット（アクセシビリティ＋連打防止）
    regenBtn.setAttribute("aria-busy", "true");
    regenBtn.disabled = true;

    // 回転開始（.spin は 19) で注入する CSS で定義）
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
      // 回転停止
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
function autoGrow(el, minH = 60) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.max(el.scrollHeight, minH) + "px";
}
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

/* --- ▼ 追加：スピナー用CSSを一度だけ注入（↻ がクルクル回ります） --- */
(function injectSpinnerStyleOnce() {
  if (document.getElementById("texel-spinner-style")) return;
  const style = document.createElement("style");
  style.id = "texel-spinner-style";
  style.textContent = `
    /* 回転アニメーション */
    @keyframes texel-rotate {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }
    /* 再生成ボタンの基準スタイル（回転中心など調整） */
    .texel-regenerate-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border-radius: 6px;
      transform-origin: 50% 50%;
      user-select: none;
    }
    /* クリック中に回転させるクラス */
    .texel-regenerate-btn.spin {
      animation: texel-rotate 0.9s linear infinite;
    }
    /* aria-busy=true のとき少し薄くする（進行中の雰囲気） */
    .texel-regenerate-btn[aria-busy="true"] {
      opacity: 0.7;
      cursor: progress;
    }
  `;
  document.head.appendChild(style);
})();

/* ==============================
 * 20) 間取り図：方位決定
 * ============================== */
async function onConfirmNorth() {
  const dropdown = document.getElementById("north-vector-dropdown");
  const northSel = document.getElementById("northVectorSelect");
  const selected = northSel.value;
  if (!selected) { dropdown.classList.add("glow"); return; }
  dropdown.classList.remove("glow");
  dropdown.style.border = "none";
  try {
    await analyzeFloorplanWithGPT(currentFloorplanBase64, selected);
    const confirmBtn = document.getElementById("confirmNorthButton");
    const defer = confirmBtn?.dataset?.deferRoomImages;
    if (defer) {
      const roomImages = JSON.parse(defer);
      if (Array.isArray(roomImages) && roomImages.length) {
        await analyzeRoomImagesSequentially(roomImages);
        hasRoomAnalysis = true;
      }
      delete confirmBtn.dataset.deferRoomImages;
    }
    if (floorplanAnalysisResult && hasRoomAnalysis) {
      document.getElementById("generate-suggestions")?.click();
    }
  } catch (err) {
    console.error("❌ 間取り図解析エラー:", err);
    alert("間取り図の解析に失敗しました。");
  } finally {
    hideLoadingSpinner("floorplan");
  }
}
function showNorthVectorDropdown() {
  const dropdown = document.getElementById("north-vector-dropdown");
  dropdown.style.display = "block";
  dropdown.classList.add("glow");
}

/* ==============================
 * 21) おすすめ生成
 * ============================== */

// 使い回しヘルパ（元に戻すが何度でも効くようにする）
function applySuggestion(text) {
  let ta = document.getElementById("editable-suggestion");
  if (!ta) {
    ta = document.createElement("textarea");
    ta.id = "editable-suggestion";
    ta.style.cssText = "width:100%;height:300px;font-size:13px;";
    suggestionArea.prepend(ta);
  }
  ta.value = text ?? "";
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + "px";
  initSuggestionCount();
  attachAutoSave("editable-suggestion");
}

function setOriginalSuggestionIfEmpty(text) {
  if (!originalSuggestionText && text) {
    originalSuggestionText = text;
  }
}

function updateResetSuggestionBtn() {
  const btn = document.getElementById("reset-suggestion");
  if (!btn) return;
  const enabled = !!originalSuggestionText;
  btn.disabled = !enabled;
  btn.title = enabled ? "" : "おすすめ未生成のため無効";
}

// 「元に戻す」クリック（何度でも原文へ戻せる）
async function onClickResetSuggestion(e) {
  e?.preventDefault?.();
  if (!originalSuggestionText) return;
  applySuggestion(originalSuggestionText);
  updateResetSuggestionBtn();
  try { await saveExportJson(); } catch {}
}

async function onGenerateSuggestions() { // 既存名を上書き
  if (!floorplanAnalysisResult) return;
  showLoadingSpinner("suggestion");
  try {
    const promptObj = await getPromptObj("suggestion", P.suggestion);
    const suggestionPrompt = promptObj.prompt || "";
    const params = promptObj.params || {};

    // ここがネタ：AI参照用メモ + 間取り図分析 +（履歴内）部屋コメント + 既存テキストエリア群
    const memoText = document.getElementById("property-info")?.value.trim() || "";
    const floorplanText = document.getElementById("floorplan-preview-text")?.value.trim() || "";
    const roomComments = Array.from(document.querySelectorAll("#history-container .drop-zone textarea"))
      .map(t => t.value.trim()).filter(Boolean);

    const textareasContent = [...document.querySelectorAll("textarea")]
      .map((t) => t.value.trim())
      .filter(Boolean);

    const combined = [
      "【AI参照用メモ】", memoText,
      "【間取り図分析】", floorplanText,
      ...(roomComments.length ? ["【部屋コメント】", ...roomComments] : []),
      "【その他テキスト】", ...textareasContent
    ].filter(Boolean).join("\n\n");

    const body = {
      messages: [
        { role: "system", content: suggestionPrompt },
        { role: "user",   content: combined }
      ],
      temperature: params.temperature ?? 0.3,
      max_tokens:  params.max_tokens ?? 4000,
      top_p: params.top_p,
      frequency_penalty: params.frequency_penalty,
      presence_penalty:  params.presence_penalty,
      purpose: "suggestion"
    };

    const result = await callGPT(body);
    const suggestion = result.choices?.[0]?.message?.content;
    if (!suggestion) throw new Error("応答が空でした");

    // 初回のみ原文を確定、それ以降は保持（何度でも戻せる）
    setOriginalSuggestionIfEmpty(suggestion);
    applySuggestion(suggestion);
    updateResetSuggestionBtn();

    await generatePortalComments(suggestion);
    await saveExportJson();
  } catch (err) {
    console.error("おすすめポイント生成エラー:", err);
    alert("おすすめポイントの生成に失敗しました。再度お試しください。");
  } finally {
    hideLoadingSpinner("suggestion");
    ["summary-length", "summary-format", "generate-summary", "reset-suggestion"]
      .forEach((id) => { const el = document.getElementById(id); if (el) el.disabled = false; });
  }
}

/* ==============================
 * 22) 再要約
 * ============================== */
async function onRegenerateSummary() {
  const length = +document.getElementById("summary-length").value;
  const format = document.getElementById("summary-format").value;
  if (!originalSuggestionText) return alert("おすすめポイントが未生成のため、再整理できません。");

  const current = document.getElementById("editable-suggestion")?.value || "";
  const prompt =
    format === "bullet"
      ? `以下の文章を、購入希望者に伝わりやすくなるように全体で${length}文字以内で、5〜7項目程度の箇条書きにまとめてください。\n\n${current}`
      : `以下の文章を${length}文字程度に要約してください。読みやすく、要点を明確に伝えてください。\n\n${current}`;

  const promptObj = await getPromptObj("summary", P.summary);
  const sysPrompt = promptObj.prompt || "あなたは不動産広告のライターです。";
  const params = promptObj.params || {};

  const body = {
    messages: [{ role: "system", content: sysPrompt }, { role: "user", content: prompt } ],
    temperature: params.temperature ?? 0.3,
    max_tokens:  params.max_tokens ?? 4000,
    top_p: params.top_p,
    frequency_penalty: params.frequency_penalty,
    presence_penalty:  params.presence_penalty,
    purpose: "text"
  };

  try {
    showLoadingSpinner("suggestion");
    const result = await callGPT(body);
    const suggestion = result.choices?.[0]?.message?.content;
    if (!suggestion) throw new Error("返答が空でした");

    suggestionArea.innerHTML =
      `<textarea id="editable-suggestion" style="width:100%;height:300px;font-size:13px;"></textarea>`;
    document.getElementById("editable-suggestion").value = suggestion;
    initSuggestionCount();
  } catch (err) {
    console.error("要約エラー:", err);
    alert("再要約に失敗しました。");
  } finally {
    hideLoadingSpinner("suggestion");
    await saveExportJson();
  }
}

/* ==============================
 * 23) GAS送信（Spreadsheet）
 * ============================== */
async function saveToSpreadsheet(data) {
  try {
    const payload = {
      mode: "upsertByCode",
      propertyCode,
      spreadsheetId: sheetIdForGPT,
      data
    };
    const res = await fetch(SHEET_API, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(await res.text());
    console.log("✅ sheet OK:", await res.text());
  } catch (e) {
    console.error("❌ sheet save failed", e);
    alert("スプレッドシートへの保存に失敗しました");
  }
}

/* ==============================
 * 24) ポータル用コメント
 * ============================== */
async function generatePortalComments(combinedText) {
  const entries = [
    { id: "suumo-catch",    label: "SUUMOキャッチコピー",      promptKey: "suumoCatch",    file: P.suumoCatch,   max: 37  },
    { id: "suumo-comment",  label: "SUUMOネット用コメント",      promptKey: "suumoComment",  file: P.suumoComment, max: 300 },
    { id: "athome-comment", label: "スタッフコメント",           promptKey: "athomeComment", file: P.athomeComment,max: 100 },
    { id: "athome-appeal",  label: "athomeエンド向けアピール",   promptKey: "athomeAppeal",  file: P.athomeAppeal, max: 500 }
  ];

  await Promise.all(entries.map(async (entry) => {
    try {
      const promptObj = await getPromptObj(entry.promptKey, entry.file);
      const prompt = promptObj.prompt || `${entry.label} を出力してください（最大 ${entry.max} 文字）`;
      const params = promptObj.params || {};

      const body = {
        messages: [{ role: "system", content: prompt }, { role: "user", content: combinedText }],
        temperature: params.temperature ?? 0.3,
        max_tokens:  params.max_tokens ?? 4000,
        top_p: params.top_p,
        frequency_penalty: params.frequency_penalty,
        presence_penalty:  params.presence_penalty,
        purpose: entry.id
      };

      const res = await callGPT(body);
      let result = res.choices?.[0]?.message?.content || "";
      result = result
        .replace(/\n[ \t]+/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/^\s+/gm, "")
        .replace(/\s+$/g, "");

      const el = document.getElementById(entry.id);
      if (el) {
        el.value = result;
        autoGrow(el);
        setupCharCount(entry.id, `${entry.id}-count`, entry.max);
      }
    } catch (err) {
      console.warn(`❌ ${entry.label} 生成エラー:`, err);
      const el = document.getElementById(entry.id);
      if (el) el.value = "生成に失敗しました";
    }
  }));
}

/* ==============================
 * 25) 文字数カウンタ
 * ============================== */
function initSuggestionCount() {
  const ta = document.getElementById("editable-suggestion");
  if (!ta) return;
  setupCharCount("editable-suggestion", "suggestion-count", 1000);
}
function setupCharCount(textareaId, counterId, max) {
  const textarea = document.getElementById(textareaId);
  const counter = document.getElementById(counterId);
  const update = () => {
    const len = textarea.value.replace(/\r\n/g, "\n").length;
    counter.textContent = `${len}`;
  };
  textarea.addEventListener("input", update);
  update();
}

/* ==============================
 * 26) 外部API（物件）
 * ============================== */
async function fetchPropertyData(code) {
  try {
    const live = await fetch(`https://www.rehouse.co.jp/rehouse-api/api/v1/salesProperties/${code}`);
    if (live.ok) return live.json();
    if (live.status === 404) return null;
    return null;
  } catch (e) {
    console.warn("liveAPI fetch error", e);
    return null;
  }
}

/* ==============================
 * 27) GPT ラッパ（リトライ付）
 * ============================== */
async function callGPT(localBody) {
  const code = propertyCode || Date.now().toString(36);
  const sheet = LOG_SHEET_ID;
  const payload = { ...localBody, propertyCode: code, spreadsheetId: sheet, userId };

  const maxRetries = 4;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const backoff = 500 * Math.pow(2, attempt - 1); // 0.5s,1s,2s,4s
    try {
      const res = await analyzeWithGPT(payload);
      const data = (typeof res === "string") ? JSON.parse(res) : res;
      const content = data?.choices?.[0]?.message?.content;
      if (content && typeof content === "string" && content.trim()) {
        return data;
      }
      const snippet = JSON.stringify(data)?.slice(0, 160);
      throw new Error(`GPT応答が空または不正（snippet=${snippet}）`);
    } catch (err) {
      const isLast = attempt === maxRetries;
      const msg = (err && err.message) ? err.message : String(err);
      console.warn(`⚠️ GPT失敗 (${attempt}/${maxRetries}): ${msg}`);
      if (isLast) throw err;
      await delay(backoff);
    }
  }
}

/* ==============================
 * 28) RoomPhoto プロンプト合成
 * ============================== */
function buildRoomPhotoPrompt(basePrompt, roomType, description, pastComments = [], isRetry = false) {
  const memo = document.getElementById("property-info")?.value.trim() ?? "";
  const floorplan = document.getElementById("floorplan-preview-text")?.value.trim() ?? "";

  let prefix = "";
  if (roomType || description) {
    const t = roomType ? `「${roomType}」` : "";
    const d = description ? `: ${description}` : "";
    prefix = `# 画像メタ情報 ${t}${d}\n\n`;
  }

  let retryNote = "";
  if (isRetry && pastComments.length > 0) {
    const last = pastComments[pastComments.length - 1];
    retryNote = `※以下のコメントと重複・類似しない新たな表現にしてください：\n「${last}」\n\n`;
  }

  let historyText = "";
  if (pastComments.length > 0) {
    historyText =
      `--- 過去のコメント履歴 ---\n` +
      pastComments.map((c, i) => `【${i + 1}】\n${c}`).join("\n\n") +
      "\n\n";
  }

  return (
    `${prefix}${retryNote}${basePrompt}\n\n` +
    historyText +
    `--- AI参照用物件メモ ---\n${memo}\n\n` +
    `--- 間取り図分析結果 ---\n${floorplan}`
  );
}

/* ==============================
 * 29) 物件メモ生成（簡略）
 * ============================== */
function generatePropertyMemo(data, commitmentMaster = {}) {
  if (!data) return "";
  const uniq = (arr) => [...new Set(arr)];
  const line = (label, v) => `${label}：${v}`;
  const sqm2Tsubo = (v) => { const tsubo = Math.floor(v * 0.3025 * 100) / 100; return `${v}㎡（約${tsubo.toFixed(2)}坪）`; };
  const dirJP = { N:"北", S:"南", E:"東", W:"西", NE:"北東", NW:"北西", SE:"南東", SW:"南西" };
  const roadJP = { PB:"公道", PR:"私道", PV:"私道" };

  const propertyTypeLabel = resolvePropertyTypeFromItem(data.propertyItem);
  const category = classifyPropertyType(data.propertyItem);
  const address = `${data.prefecture?.name || ""}${data.city?.name || ""}${data.town?.name || ""}`;

  const access = (data.transportations || [])
    .map((t) => {
      const ln = t.railway?.name || "";
      const st = t.station?.name || "駅名不明";
      if (t.accessMinutes != null) return `${ln}${st}駅 徒歩${t.accessMinutes}分`;
      if (t.busStopName && t.busRidingMinutes != null && t.busAccessMinutes != null)
        return `${ln}${st}駅 バス${t.busRidingMinutes}分「${t.busStopName}」停歩${t.busAccessMinutes}分`;
      return null;
    })
    .filter(Boolean)
    .join("、") || "交通情報なし";

  const exclusiveArea = data.exclusiveArea ? sqm2Tsubo(data.exclusiveArea) : null;
  const landArea      = data.landArea      ? sqm2Tsubo(data.landArea)      : null;
  const buildingArea  = data.grossFloorArea? sqm2Tsubo(data.grossFloorArea): null;
  const floorPlan     = data.floorPlanText || `${data.roomCount ?? ""}LDK`;
  const built         = data.builtYearMonth ? data.builtYearMonth.replace("-", "年") + "月築" : null;
  const floorInfo     = data.floorNumber
    ? `${data.floorNumber}階 / 地上${data.story || "?"}階` + (data.undergroundStory ? ` 地下${data.undergroundStory}階建` : "")
    : null;
  const balconyDir = dirJP[data.balconyDirection] || data.balconyDirection || null;

  let roadLine = null;
  if (Array.isArray(data.connectingRoads) && data.connectingRoads.length) {
    const roads = data.connectingRoads
      .map((r) => {
        const d = dirJP[r.direction] || r.direction || "";
        const w = r.width != null ? `約${parseFloat(r.width).toFixed(1)}m` : "";
        const rt = roadJP[r.roadType] || r.roadType || "";
        return [d && `${d}側`, w, rt].filter(Boolean).join(" ").trim();
      })
      .filter(Boolean);
    const uniqRoads = uniq(roads);
    roadLine = uniqRoads.join("／");
    if (uniqRoads.length >= 2) roadLine += "（角地）";
  }

  let bcrFarLine = null;
  const lr = data.landInformation?.landRestrictions?.[0];
  if (lr) {
    const conv = (v) => (v < 1 ? v * 100 : v < 10 && Number.isInteger(v) ? v * 100 : v);
    const bcr = lr.buildingCoverageRatio != null ? conv(lr.buildingCoverageRatio) : null;
    const far = lr.floorAreaRatio      != null ? conv(lr.floorAreaRatio)      : null;
    if (bcr != null && far != null) bcrFarLine = `${Math.round(bcr)}%／${Math.round(far)}%`;
  }

  const L = [
    "■ 物件の基本情報",
    line("物件種別", propertyTypeLabel),
    line("価格", `${(data.price).toLocaleString()}万円`),
    line("所在地", address),
    line("交通", access)
  ];

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
      if (landArea)      L.push(line("土地面積", landArea));
      if (buildingArea)  L.push(line("建物面積", buildingArea));
      if (exclusiveArea) L.push(line("専有面積", exclusiveArea));
  }

  if (roadLine)   L.push(line("接道状況", roadLine));
  if (bcrFarLine) L.push(line("建ぺい率／容積率", bcrFarLine));

  const commitments = (data.commitmentInformations || [])
    .map((info) => {
      const name = info.name || commitmentMaster[String(info.commitmentCode)] || "";
      if (!name || /使用料|円|費|管理費|修繕/.test(name)) return null;
      const suf = info.distance != null ? (info.distance >= 50 ? "m" : "円") : "";
      return `・${name}${info.distance != null ? `（約${info.distance}${suf}）` : ""}`;
    })
    .filter(Boolean);

  const remarks = (data.recommendedInfo || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1)
    .map((s) => `・${s.replace(/^○|^〇/, "")}`);

  if (commitments.length) L.push("", "■ 特徴・設備・条件など", ...uniq(commitments));
  if (remarks.length)     L.push("", "■ 担当者記載", ...uniq(remarks));

  if ((data.renovationInfos || []).length) {
    const reno = data.renovationInfos.map((r) => {
      const d = r.renovationYearMonth ? r.renovationYearMonth.replace("-", "年") + "月" : "";
      return `・${r.renovationPoint}${d ? `（${d}実施）` : ""}`;
    });
    L.push("", "■ リフォーム情報", ...uniq(reno));
  }

  return L.join("\n");
}
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
    "01":"新築マンション","02":"中古マンション","03":"新築公団","04":"中古公団",
    "05":"新築公社","06":"中古公社","07":"新築タウンハウス","08":"中古タウンハウス",
    "09":"リゾートマンション（区分所有）","10":"店舗（区分所有）","11":"事務所（区分所有）",
    "12":"店舗・事務所（区分所有）","98":"その他（区分所有）","22":"店舗（一棟）","23":"店舗付住宅",
    "24":"住居付店舗","25":"事務所（一棟）","26":"店舗・事務所（一棟）","16":"ビル","27":"工場",
    "17":"マンション一括","28":"倉庫","19":"アパート一括","29":"寮","30":"旅館","31":"ホテル",
    "32":"別荘","18":"リゾートマンション（一棟）","99":"その他（一棟）","33":"売地","34":"借地権","35":"底地権"
  };
  return map[item] || "物件種別不明";
}

/* ==============================
 * 30) 画像の逐次解析
 * ============================== */
async function analyzeRoomImagesSequentially(images) {
  if (!Array.isArray(images) || !images.length) return;
  showLoadingSpinner("room");
  for (const img of images) {
    try {
      const base64 = await convertUrlToBase64ViaFunctionBase(img.url);
      roomPreview.src = "";
      roomPreview.style.display = "none";
      roomPreview.onload = () => {
        roomPreview.style.display = "block";
        roomPreview.style.cursor = "pointer";
      };
      setTimeout(() => {
        roomPreview.style.display = "block";
        roomPreview.style.cursor = "pointer";
      }, 200);
      roomPreview.src = base64;

      analysisResult.style.display = "none";
      const metaTitle = img.title?.trim() || null;
      const metaDesc  = img.comment?.trim() || null;
      await analyzeRoomPhotoWithGPT(base64, base64, metaTitle, metaDesc);
      await delay(1000);
    } catch (err) {
      console.error("❌ 部屋画像の解析失敗:", err);
    }
  }
  roomPreview.src = "";
  roomPreview.style.display = "none";
  hideLoadingSpinner("room");
}

/* ==============================
 * 31) 旧ヘルパ（互換）
 * ============================== */
function guessFloorplanUrlFromProperty(data) {
  if (!data || typeof data !== "object") return null;
  const cands = [];
  const push = (u) => { if (typeof u === "string" && u) cands.push(u); };
  push(data.floorPlanImageUrl);
  push(data.floorplanImageUrl);
  if (data.floorPlan && typeof data.floorPlan === "object") {
    push(data.floorPlan.imageUrl || data.floorPlan.url);
  }
  const arrays = [
    data.images,
    data.propertyImages,
    data.photos,
    data.photoInformations,
    data.imageInformations
  ].filter(Array.isArray);
  arrays.forEach(arr => {
    arr.forEach(img => {
      const label = [img.type, img.category, img.name, img.label, img.photoTypeName, img.title].join(" ").toLowerCase();
      const url   = img.url || img.imageUrl || (img.photoFile && img.photoFile.url);
      if (/間取|間取り|区画|madori|floor/.test(label) || /floor(plan)?/i.test(url || "")) push(url);
    });
  });
  const uniq = [...new Set(cands)];
  return uniq.find((u) => /^https?:\/\//.test(u)) || null;
}
