/* =====================================================================
 *  Texel.js  ― Texel (external-only, clean, no hashtags)
 *  - BLOBの commitment-master を dev/prod 自動切替で読込
 *  - export-format / hashtags は完全撤去（保存は都度構築）
 * ===================================================================== */

import { detectUserId } from "./utils/user.js";
import {
  API,
  chatGPT as analyzeWithGPT,
  fetchWithRetry, // 予備（未使用なら残してOK）
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
// BLOBがプライベートならSASを設定（先頭 ? から）
const PROMPTS_SAS = ""; // 例: "?sv=2025-...&ss=bfqt&..."

const COMMITMENT_MASTER_FILE = "snapvoice-commitment-master.json";

function buildCommitmentMasterUrls() {
  const base = BLOB_ACCOUNT[ENV];
  const blobUrl = `${base}/${PROMPTS_CONTAINER}/${COMMITMENT_MASTER_FILE}${PROMPTS_SAS}`;
  const swaUrl = `${location.origin}/prompts/${COMMITMENT_MASTER_FILE}`; // SWA直配信（置いてあれば）
  const extUrl =
    chrome?.runtime?.getURL?.(`prompts/${COMMITMENT_MASTER_FILE}`) || null; // 拡張内同梱（任意）
  return [blobUrl, swaUrl, extUrl].filter(Boolean);
}

async function loadCommitmentMasterJson() {
  for (const url of buildCommitmentMasterUrls()) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) return res.json();
    } catch {/* 次の候補へ */}
  }
  throw new Error("commitment-master not found in any source");
}

/* ==============================
 * 3) ユーティリティ
 * ============================== */
const autosaveDebounced = debounce(() => saveExportJson().catch(()=>{}), 600);

function extractSpreadsheetId(text) {
  const m = text.trim().match(/\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : text.trim();
}
function debounce(fn, ms = 500) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ---------- Loading Spinner（参照カウント） ---------- */
const spinnerCounter = Object.create(null);
function showLoadingSpinner(target) {
  const el = document.getElementById(`loadingSpinner-${target}`);
  if (!el) return;
  spinnerCounter[target] = (spinnerCounter[target] || 0) + 1;
  el.style.display = "block";
}
function hideLoadingSpinner(target) {
  const el = document.getElementById(`loadingSpinner-${target}`);
  if (!el) return;
  spinnerCounter[target] = Math.max((spinnerCounter[target] || 1) - 1, 0);
  if (spinnerCounter[target] === 0) el.style.display = "none";
}
function attachAutoSave(id, evt = "input") {
  const el = document.getElementById(id);
  if (!el || el.dataset.autosave) return;
  el.dataset.autosave = "1";
  el.addEventListener(evt, autosaveDebounced);
}

/* ==============================
 * 4) 入力バリデーション
 * ============================== */
function validateInput() {
  const pcIn = document.getElementById("property-code-input");
  const ssIn = document.getElementById("spreadsheet-id-input");
  const btn  = document.getElementById("property-code-submit");

  const pcVal = pcIn.value.trim().toUpperCase();
  const ssVal = ssIn.value.trim();
  pcIn.value = pcVal;
  btn.disabled = !(pcVal && ssVal);
}

/* ==============================
 * 5) プロンプト取得（ローカル→storage→BLOB/SWA）
 * ============================== */
async function fetchPromptText(filename) {
  const res = await fetch(API.getPromptText(filename));
  if (!res.ok) throw new Error(`${filename} 読み込み失敗: ${res.status}`);
  const ctype = res.headers.get("content-type") || "";
  if (ctype.includes("application/json")) {
    const json = await res.json();
    if (typeof json.prompt === "string") return json.prompt;
    if (typeof json.content === "string") return json.content;
    if (typeof json === "string") return json;
    return JSON.stringify(json);
  }
  return res.text();
}
async function getPromptFromLocalOrBlob(key, fetcher) {
  const cacheKey = `prompt_${key}`;
  let cached = localStorage.getItem(cacheKey);
  if (cached !== null) return cached;

  cached = await new Promise((r) =>
    chrome.storage?.local?.get([cacheKey], (ret) => r(ret[cacheKey] ?? null))
  );
  if (cached !== null) return cached;

  const text = await fetcher();
  try { localStorage.setItem(cacheKey, text); } catch {}
  try { chrome.storage?.local?.set({ [cacheKey]: text }); } catch {}
  return text;
}

/* ==============================
 * 6) commitment-master 読み込み
 * ============================== */
loadCommitmentMasterJson()
  .then((data) => {
    promptMap = data?.prompt || data || {};
    const textarea = document.getElementById("promptTextArea");
    if (textarea) textarea.value = JSON.stringify(data, null, 2);
  })
  .catch((e) => {
    console.error("❌ マスター取得失敗", e);
    promptMap = {};
  });

/* ==============================
 * 7) 保存（Spreadsheetのみ）
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

    // PDF
    pdfExtractedText:
      latestPdfExtractedText ||
      document.getElementById("pdf-preview")?.textContent?.trim() || "",
    pdfImage:
      latestPdfThumbnailBase64 ||
      document.getElementById("pdf-image-preview")?.src || "",

    // メモ・生成物
    memo: document.getElementById("property-info")?.value.trim() || "",
    floorplanAnalysis:
      document.getElementById("floorplan-preview-text")?.value.trim() || "",
    suggestions:
      document.querySelector("#suggestion-area textarea")?.value.trim() || "",
    "suumo-catch":   getTextareaValue("suumo-catch"),
    "suumo-comment": getTextareaValue("suumo-comment"),
    "athome-comment":getTextareaValue("athome-comment"),
    "athome-appeal": getTextareaValue("athome-appeal"),

    originalSuggestion: originalSuggestionText,
    floorplanImageBase64: document.getElementById("floorplan-preview")?.src || "",
    rawPropertyData: basePropertyData,

    // 履歴（画像＋コメント）
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
    console.error("❌ saveExportJson failed", e);
  }
}

/* ==============================
 * 8) DOM参照
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
 * 9) 初期状態
 * ============================== */
floorplanAnalysis.style.display = "none";
floorplanToggle.textContent = "▶ 分析結果を表示";
generateButton.disabled = true;

/* ==============================
 * 10) PDF.js 読み込み
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
 * 11) 起動時モーダル／イベント登録
 * ============================== */
document.addEventListener("DOMContentLoaded", async () => {
  userId = await detectUserId();

  // モーダル
  const modal = document.getElementById("property-code-modal");
  const pcIn  = document.getElementById("property-code-input");
  const ssIn  = document.getElementById("spreadsheet-id-input");
  const btn   = document.getElementById("property-code-submit");

  document.getElementById("modal-title").textContent = "BK IDとGS IDを入力してください";
  pcIn.style.display = "block";
  ssIn.style.display = "block";
  const noWrap = document.getElementById("no-code-wrapper");
  if (noWrap) noWrap.style.display = "none";

  pcIn.addEventListener("input", validateInput);
  ssIn.addEventListener("input", validateInput);
  window.addEventListener("load", validateInput);

  // 間取図テキスト自動伸縮
  const fpTextarea = document.getElementById("floorplan-preview-text");
  if (fpTextarea) {
    fpTextarea.classList.add("auto-grow");
    fpTextarea.addEventListener("input", () => autoGrow(fpTextarea));
    autoGrow(fpTextarea);
  }

  // 決定（起動）
  btn.addEventListener("click", async () => {
    propertyCode   = pcIn.value.trim().toUpperCase();
    sheetIdForGPT  = extractSpreadsheetId(ssIn.value);
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
      }
    } catch (e) {
      console.warn("物件データ取得スキップ/失敗:", e);
    }

    // 文字数カウンタ
    setupCharCount("suumo-catch",   "suumo-catch-count",   37);
    setupCharCount("suumo-comment", "suumo-comment-count", 300);
    setupCharCount("athome-comment","athome-comment-count",100);
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

  // PDF 折りたたみ
  const pdfToggleBtn = document.getElementById("pdf-toggle");
  if (pdfToggleBtn) {
    pdfToggleBtn.addEventListener("click", () => {
      const area = document.getElementById("pdf-analysis");
      const show = area.style.display === "none";
      area.style.display = show ? "block" : "none";
      pdfToggleBtn.textContent = show ? "▼ 抽出結果を非表示" : "▶ 抽出結果を表示";
    });
  }

  // 間取図の結果トグル
  floorplanToggle.addEventListener("click", () => {
    const hidden = floorplanAnalysis.style.display === "none";
    floorplanAnalysis.style.display = hidden ? "block" : "none";
    floorplanToggle.textContent = hidden ? "▼ 分析結果を非表示" : "▶ 分析結果を表示";
    if (hidden) requestAnimationFrame(() => autoGrow(document.getElementById("floorplan-preview-text")));
  });

  // 生成／再要約
  document.getElementById("generate-suggestions").addEventListener("click", onGenerateSuggestions);
  document.getElementById("generate-summary").addEventListener("click", onRegenerateSummary);

  // 画像ポップアップ
  bindImagePopup();

  // 方位決定 → 間取図解析
  document.getElementById("confirmNorthButton").addEventListener("click", onConfirmNorth);
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
    body: JSON.stringify({ imageUrl })
  });
  if (!res.ok) throw new Error("Base64変換API失敗");
  const json = await res.json();
  return json.base64;
}

/* ==============================
 * 13) 間取図 DnD
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
      if (src.startsWith("data:image/")) return showFloorplan(src);
      if (src.startsWith("http")) {
        try {
          showLoadingSpinner("floorplan");
          const base64 = await convertUrlToBase64ViaAPI(src);
          showFloorplan(base64);
        } finally { hideLoadingSpinner("floorplan"); }
        return;
      }
    }
    const uri = e.dataTransfer.getData("text/uri-list");
    if (uri && uri.startsWith("http")) {
      try {
        showLoadingSpinner("floorplan");
        const base64 = await convertUrlToBase64ViaAPI(uri);
        showFloorplan(base64);
      } finally { hideLoadingSpinner("floorplan"); }
      return;
    }
    console.warn("❌ ドロップされた間取図画像が処理できませんでした");
  });

  floorplanSelect.addEventListener("change", (e) => {
    handleFloorplanFile(e.target.files[0]);
  });
}
async function handleFloorplanFile(file) {
  if (!file || !file.type.startsWith("image/")) return;
  showLoadingSpinner("floorplan");
  try {
    const b64 = await readImageAsBase64(file);
    showFloorplan(b64);
  } finally { hideLoadingSpinner("floorplan"); }
}
function showFloorplan(base64) {
  floorplanPreview.src = base64;
  floorplanPreview.style.display = "block";
  floorplanPreview.style.cursor = "pointer";
  currentFloorplanBase64 = base64;
  showNorthVectorDropdown();
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
          roomPreview.src = src; roomPreview.style.display = "block"; roomPreview.style.cursor = "pointer";
          await analyzeRoomPhotoWithGPT(src, src, "手動分析", "HTMLドラッグ");
          return;
        }
        if (src.startsWith("http")) {
          try {
            const b64 = await convertUrlToBase64ViaAPI(src);
            roomPreview.src = b64; roomPreview.style.display = "block"; roomPreview.style.cursor = "pointer";
            await analyzeRoomPhotoWithGPT(b64, src, "手動分析", "Web画像");
          } catch (err) { console.error("画像URLからBase64変換に失敗:", err); }
          return;
        }
      }

      const uri = e.dataTransfer.getData("text/uri-list");
      if (uri && uri.startsWith("http")) {
        try {
          const b64 = await convertUrlToBase64ViaAPI(uri);
          roomPreview.src = b64; roomPreview.style.display = "block"; roomPreview.style.cursor = "pointer";
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
  roomPreview.style.display = "block";
  roomPreview.style.cursor = "pointer";
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

      // サムネイル
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

      // テキスト抽出
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

      // プロンプト
      const promptObj = await getPromptFromLocalOrBlob(
        "snapvoice-pdf-image",
        () => fetchPromptText("snapvoice-pdf-image.json")
      ).then((text) => { try { return JSON.parse(text); } catch { return { prompt: text }; }});
      const summaryPrompt = promptObj.prompt || promptObj;
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
 * 16) 間取図解析（GPT）
 * ============================== */
async function analyzeFloorplanWithGPT(base64Image, northVector) {
  const previewText = document.getElementById("floorplan-preview-text");
  try {
    showLoadingSpinner("floorplan");
    let promptObj = await getPromptFromLocalOrBlob(
      "snapvoice-floorplan",
      () => fetchPromptText("snapvoice-floorplan.json")
    ).then((text) => { try { return JSON.parse(text); } catch { return { prompt: text }; }});

    let systemPromptBase = promptObj.prompt || promptObj;
    const params = promptObj.params || {};
    if (!systemPromptBase) systemPromptBase = "これは不動産の間取図です。内容を読み取り、わかりやすく要約してください。";

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
    const promptObj = await getPromptFromLocalOrBlob(
      "snapvoice-roomphoto",
      () => fetchPromptText("snapvoice-roomphoto.json")
    ).then((t) => { try { return JSON.parse(t); } catch { return { prompt: t }; }});

    const basePrompt = promptObj.prompt || promptObj;
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
    saveExportJson().catch(()=>{});
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
    "display:grid;grid-template-columns:auto 1fr auto;align-items:center;margin-top:4px;";

  const regenBtn = document.createElement("button");
  regenBtn.innerHTML = "↻";
  regenBtn.title = "コメントを再生成";
  regenBtn.style.cssText =
    "background:transparent;border:none;font-size:20px;cursor:pointer;color:#666;transition:transform .3s;";

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
    regenBtn.disabled = true;
    regenBtn.classList.add("spin");
    await analyzeRoomPhotoWithGPT(
      imageSrc,
      imageSrc,
      wrapper.dataset.roomType ?? "",
      wrapper.dataset.description ?? "",
      [textarea.value],
      true,
      wrapper
    );
    regenBtn.classList.remove("spin");
    regenBtn.disabled = false;
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
    toolRow.style.display = hidden ? "flex" : "none";
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
  hasRoomAnalysis = [...historyContainer.querySelectorAll(".drop-zone")].some(
    (w) => w.querySelector("textarea")?.value.trim()
  );
  updateGenerateButtonLabel();
}
function showCopyNotification(message = "クリップボードへコピーしました") {
  const note = document.createElement("div");
  note.textContent = message;
  note.style.cssText = `
    position: fixed; bottom: 10%; left: 50%; transform: translateX(-50%);
    background: #333; color: #fff; padding: 8px 16px; border-radius: 6px;
    font-size: 13px; min-width: 260px; text-align: center; opacity: 0;
    transition: opacity .3s ease; z-index: 9999;`;
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
  overlay.addEventListener("click", () => {
    overlay.style.display = "none";
    popupImg.src = "";
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      overlay.style.display = "none";
      popupImg.src = "";
    }
  });
}

/* ==============================
 * 20) 間取図：方位決定
 * ============================== */
async function onConfirmNorth() {
  const dropdown = document.getElementById("north-vector-dropdown");
  const northSel = document.getElementById("northVectorSelect");
  const selected = northSel.value;
  if (!selected) {
    dropdown.classList.add("glow");
    return;
  }
  dropdown.classList.remove("glow");
  dropdown.style.border = "none";
  try {
    await analyzeFloorplanWithGPT(currentFloorplanBase64, selected);
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
async function onGenerateSuggestions() {
  if (!floorplanAnalysisResult) return;
  showLoadingSpinner("suggestion");
  try {
    const promptObj = await getPromptFromLocalOrBlob(
      "snapvoice-suggestion",
      () => fetchPromptText("snapvoice-suggestion.json")
    ).then((text) => { try { return JSON.parse(text); } catch { return { prompt: text }; }});
    const suggestionPrompt = promptObj.prompt || promptObj;
    const params = promptObj.params || {};

    const propertyInfo = document.getElementById("property-info")?.value.trim() || "";
    const textareasContent = [...document.querySelectorAll("textarea")]
      .map((t) => t.value.trim())
      .filter(Boolean);
    const combined = [propertyInfo, ...textareasContent].filter(Boolean).join("\n\n");

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

    let ta = document.getElementById("editable-suggestion");
    if (!ta) {
      ta = document.createElement("textarea");
      ta.id = "editable-suggestion";
      ta.style.cssText = "width:100%;height:300px;font-size:13px;";
      suggestionArea.prepend(ta);
    }
    ta.value = suggestion;
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";

    initSuggestionCount();
    if (!originalSuggestionText) originalSuggestionText = suggestion;

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

  const promptObj = await getPromptFromLocalOrBlob(
    "snapvoice-summary",
    () => Promise.resolve(JSON.stringify({ prompt: "あなたは不動産広告のライターです。" }))
  ).then((text) => { try { return JSON.parse(text); } catch { return { prompt: text }; }});
  const sysPrompt = promptObj.prompt || "あなたは不動産広告のライターです。";
  const params = promptObj.params || {};

  const body = {
    messages: [{ role: "system", content: sysPrompt }, { role: "user", content: prompt }],
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
      headers: { "Content-Type": "application/json" },
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
 * 24) ポータル用コメント自動生成（ハッシュタグなし）
 * ============================== */
async function generatePortalComments(combinedText) {
  const entries = [
    { id: "suumo-catch",    label: "SUUMOキャッチコピー",      promptKey: "snapvoice-suumo-catch",    max: 37  },
    { id: "suumo-comment",  label: "SUUMOネット用コメント",      promptKey: "snapvoice-suumo-comment",  max: 300 },
    { id: "athome-comment", label: "スタッフコメント",           promptKey: "snapvoice-athome-comment", max: 100 },
    { id: "athome-appeal",  label: "athomeエンド向けアピール",   promptKey: "snapvoice-athome-appeal",  max: 500 }
  ];

  await Promise.all(entries.map(async (entry) => {
    try {
      const promptObj = await getPromptFromLocalOrBlob(
        entry.promptKey,
        () => fetchPromptText(`${entry.promptKey}.json`)
      ).then((text) => { try { return JSON.parse(text); } catch { return { prompt: text }; }});

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
  const counter  = document.getElementById(counterId);
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

  const maxRetries = 3, delayMs = 1000;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await analyzeWithGPT(payload);
      if (result?.choices?.[0]?.message?.content) return result;
      throw new Error("GPT応答が空または不正");
    } catch (err) {
      console.warn(`⚠️ GPT失敗 (${attempt}/${maxRetries}):`, err.message || err);
      if (attempt === maxRetries) throw err;
      await delay(delayMs);
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
    the d = description ? `: ${description}` : "";
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
    `--- 間取図分析結果 ---\n${floorplan}`
  );
}

/* ==============================
 * 29) 物件メモ生成（簡略）
 * ============================== */
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
