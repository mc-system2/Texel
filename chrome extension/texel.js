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

import {detectUserId} from "./utils/user.js";
import {API, chatGPT as analyzeWithGPT, fetchWithRetry, delay, SHEET_API, GAS_LOG_ENDPOINT, FUNCTION_BASE, EFFECTIVE_URLS} from "./src/api.js";

/* ==============================
 * 1) 固定定数・実行時状態
 * ============================== */
const DEFAULT_SHEET_ID = "1Q8Vbluc5duil1KKWYOGiVoF9UyMxVUxAh6eYb0h2jkQ";
const LOG_SPREADSHEET_ID = DEFAULT_SHEET_ID;

let userId = "";
let CURRENT_BEHAVIOR = "BASE";
let clientId = "";
// CL ID（4桁英数字）
let propertyCode = "";
// 例：FXXXXXXX or ランダム発番
let sheetIdForGPT = DEFAULT_SHEET_ID;
// Client Catalog から差し替え
let sessionSheetId = sheetIdForGPT;

let basePropertyData = null;
let promptMap = {};
// commitment-master（読み分け）
let originalSuggestionText = "";
let latestPdfThumbnailBase64 = "";
let latestPdfExtractedText = "";
let currentFloorplanBase64 = null;

let floorplanAnalysisResult = "";
let hasRoomAnalysis = false;

/* ==============================
 * 2) 環境判定（SWAホスト名）
 * ============================== */
const ENV = ( () => {
    const h = location.host;
    if (h.includes("lively-tree-019937900.2.azurestaticapps.net"))
        return "dev";
    if (h.includes("lemon-beach-0ae87bc00.2.azurestaticapps.net"))
        return "prod";
    return "dev";
    // ローカル等はdev扱い
}
)();

const PROMPTS_CONTAINER = "prompts";
const BLOB_ACCOUNT = {
    dev: "https://sttexeldevjpe001.blob.core.windows.net",
    prod: "https://sttexelprodjpe001.blob.core.windows.net",
};
const PROMPTS_SAS = "";
// 必要なら付与
const COMMITMENT_MASTER_FILE = "texel-commitment-master.json";

/* ------ プロンプトの論理キーとファイル名（texel-* に統一） ------ */
const P = {
    floorplan: "texel-floorplan.json",
    roomphoto: "texel-roomphoto.json",
    suggestion: "texel-suggestion.json",
    suumoCatch: "texel-suumo-catch.json",
    suumoComment: "texel-suumo-comment.json",
    athomeComment: "texel-athome-comment.json",
    athomeAppeal: "texel-athome-appeal.json",
};

/* ------ key名 → ファイル名片（texel-*.json の * 部分） ------ */
const KEY_TO_NAME = {
    floorplan: "floorplan",
    roomphoto: "roomphoto",
    pdfImage: "pdf-image",
    suggestion: "suggestion",
    summary: "summary",
    suumoCatch: "suumo-catch",
    suumoComment: "suumo-comment",
    athomeComment: "athome-comment",
    athomeAppeal: "athome-appeal",
};

/* 行動別に「テンプレが存在する種別」を定義 */
const TEMPLATE_FAMILIES = {
    "TYPE-S": new Set(["suumo-catch", "suumo-comment", "roomphoto", "suggestion"]),
    "TYPE-R": new Set(["athome-appeal", "athome-comment", "roomphoto", "suggestion", "suumo-catch", "suumo-comment"]),
    "BASE": new Set(["athome-appeal", "athome-comment", "roomphoto", "suggestion", "suumo-catch", "suumo-comment"])
};

/** keyLike から読み込み候補（優先順）を作る
 *  1) prompt/<CLID>/texel-<name>.json
 *  2) 挙動別テンプレ（TYPE-R: texel-r-<name>.json / TYPE-S: texel-s-<name>.json / BASE: texel-<name>.json）
 *  3) 最後の保険として、従来のファイル名（呼出し側が渡してきた P.*）
 */
function resolvePromptCandidates(keyLike, fallbackFilename) {
    // ここは「候補ファイル名（＝BLOB名）」を返すだけ（client/配下探索は fetchPromptTextFile 側で行う）
    const name = KEY_TO_NAME[keyLike];
    const list = [];
    const beh = (CURRENT_BEHAVIOR || "BASE").toUpperCase();

    if (name) {
        if (beh === "TYPE-R" && TEMPLATE_FAMILIES["TYPE-R"]?.has(name)) {
            // Type-R 専用 → 共通へフォールバック
            list.push(`texel-r-${name}.json`);
            list.push(`texel-${name}.json`);
        } else if (beh === "TYPE-S" && TEMPLATE_FAMILIES["TYPE-S"]?.has(name)) {
            // Type-S 専用 → 共通へフォールバック
            list.push(`texel-s-${name}.json`);
            list.push(`texel-${name}.json`);
        } else {
            // BASE など
            list.push(`texel-${name}.json`);
        }
    }

    if (fallbackFilename)
        list.push(fallbackFilename);

    // 重複除去
    return Array.from(new Set(list.filter(Boolean)));
}

/* ------ localStorage/chrome.storage.local のキー正規化（texel-* に統一） ------ */
const KEY_ALIAS = {
    floorplan: "texel-floorplan",
    roomphoto: "texel-roomphoto",
    pdfImage: "texel-pdf-image",
    suggestion: "texel-suggestion",
    summary: "texel-summary",
    suumoCatch: "texel-suumo-catch",
    suumoComment: "texel-suumo-comment",
    athomeComment: "texel-athome-comment",
    athomeAppeal: "texel-athome-appeal"
};
const storageKeyFor = (keyLike) => `prompt_${keyLike.startsWith("texel-") ? keyLike : (KEY_ALIAS[keyLike] || keyLike)}`;

/* ------ 404 時に使うデフォルトプロンプト ------ */
function defaultPrompt(key) {
    const baseWriter = "あなたは不動産広告の専門ライターです。読み手にとってわかりやすく、正確で誇張のない表現を使ってください。";
    switch (key) {
    case "floorplan":
        return {
            prompt: `${baseWriter}\n画像は不動産の間取り図です。方位や面積・部屋構成・設備などを読み取り、購入検討者向けに要点を簡潔にまとめてください。`,
            params: {
                temperature: 0.3,
                max_tokens: 4000
            }
        };
    case "roomphoto":
        return {
            prompt: `${baseWriter}\n画像は室内写真です。写っている設備や使い勝手、魅力や注意点を過度に断定せず自然な日本語で150〜220文字程度にまとめてください。`,
            params: {
                temperature: 0.35,
                max_tokens: 4000
            }
        };
    case "pdfImage":
        return {
            prompt: `${baseWriter}\n与えられたPDFのテキストと画像から、物件の重要ポイントを簡潔に要約してください。`,
            params: {
                temperature: 0.3,
                max_tokens: 4000
            }
        };
    case "suggestion":
        return {
            prompt: `${baseWriter}\nこれまでの分析結果（間取り・室内コメント・メモ）を踏まえ、購入検討者に刺さる「おすすめポイント」を自然な文章でまとめてください。`,
            params: {
                temperature: 0.35,
                max_tokens: 4000
            }
        };
    case "summary":
        return {
            prompt: baseWriter,
            params: {
                temperature: 0.3,
                max_tokens: 2000
            }
        };
    case "suumoCatch":
        return {
            prompt: `${baseWriter}\nこの物件の魅力を最大37文字でキャッチコピー化してください。`,
            params: {
                temperature: 0.4,
                max_tokens: 400
            }
        };
    case "suumoComment":
        return {
            prompt: `${baseWriter}\nこの物件の紹介文を最大300文字で作成してください。`,
            params: {
                temperature: 0.35,
                max_tokens: 600
            }
        };
    case "athomeComment":
        return {
            prompt: `${baseWriter}\nスタッフコメント（最大100文字）を作成してください。`,
            params: {
                temperature: 0.35,
                max_tokens: 400
            }
        };
    case "athomeAppeal":
        return {
            prompt: `${baseWriter}\nエンド向けのアピール文（最大500文字）を作成してください。`,
            params: {
                temperature: 0.35,
                max_tokens: 1200
            }
        };
    default:
        return {
            prompt: baseWriter,
            params: {
                temperature: 0.3,
                max_tokens: 1000
            }
        };
    }
}

function applyEnvBadge() {
    const badge = document.getElementById("env-badge");
    if (!badge)
        return;

    let explicitEnv = "";
    let overrideBase = "";

    try {
        explicitEnv = (localStorage.getItem("texel_env") || "").toLowerCase();
        overrideBase = (localStorage.getItem("texel_api_base") || "").trim();
    } catch {}

    const isDevMode = explicitEnv === "dev" || overrideBase.length > 0;

    badge.style.display = isDevMode ? "block" : "none";

    if (isDevMode) {
        badge.title = `DEV MODE\n` + `env=${explicitEnv || "(auto)"}\n` + `override=${overrideBase || "(none)"}\n` + `${EFFECTIVE_URLS.functionBase || ""}`;
    }
}

function logBootRouting() {
    const readLS = (k) => {
        try {
            return localStorage.getItem(k);
        } catch {
            return null;
        }
    }
    ;

    const explicitEnv = (readLS("texel_env") || "").toLowerCase();
    // dev/prod/空
    const overrideApi = (readLS("texel_api_base") || "").trim();
    // 任意
    const env = (EFFECTIVE_URLS?.env || "").toUpperCase();
    // 実効 env
    const envNote = explicitEnv === "dev" ? "explicit-dev" : explicitEnv === "prod" ? "explicit-prod" : "auto";

    const functionBase = EFFECTIVE_URLS?.functionBase || FUNCTION_BASE || "";
    const clientCatalogUrl = `${functionBase}/LoadClientCatalog?filename=texel-client-catalog.json`;
    const commitmentUrl = `${functionBase}/LoadPromptText?filename=texel-commitment-master.json`;

    console.info(`[Texel] ENV: ${env} (${envNote})`);
    console.info(`[Texel] FUNCTION_BASE: ${functionBase}${overrideApi ? ` (override=${overrideApi})` : ""}`);
    console.info(`[Texel] client-catalog: ${clientCatalogUrl}`);
    console.info(`[Texel] commitment-master: ${commitmentUrl}`);

    // 参考（必要なら）
    // console.info(`[Texel] SHEET_API: ${SHEET_API}`);
    // console.info(`[Texel] GAS_LOG_ENDPOINT: ${GAS_LOG_ENDPOINT}`);
}

/* ================= こだわりマスター読み込み（安全版） ================= */
function buildCommitmentMasterUrls() {
    const urls = [];
    try {
        const viaFunc = API.loadPromptText(COMMITMENT_MASTER_FILE);
        if (viaFunc)
            urls.push(viaFunc);
    } catch {}
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
            const res = await fetch(url, {
                cache: "no-cache"
            });
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            let data;
            const ctype = (res.headers.get("content-type") || "").toLowerCase();
            if (ctype.includes("application/json"))
                data = await res.json();
            else
                data = JSON.parse(stripBOM(await res.text()));
            promptMap = data.prompt || data.mapping || data || {};
            return;
        } catch (e) {
            tried.push(`${url} (${e?.message || e})`);
        }
    }
    promptMap = {};
    console.info("ℹ️ commitment-master not found", tried.join(" -> "));
}
loadCommitmentMaster().catch( () => {}
);

/* ------ クライアントカタログ（LoadClientCatalog API を叩くだけのシンプル版） ------ */
const CLIENT_CATALOG_FILE = "texel-client-catalog.json";

// ★ Functions Base は api.js の実効値に統一（texel_env / texel_api_base を反映）
const API_BASE = (String(FUNCTION_BASE || "").replace(/\/+$/, "") + "/");

// Texel 内で使う形
let clientCatalog = {
    version: 1,
    updatedAt: "",
    clients: {}
};

// ★ CLコードから catalog を引く関数（ないと落ちる）
function resolveClientConfig(cl) {
    const code = sanitizeCL(cl);
    const map = clientCatalog?.clients || {};
    const hit = map[code];
    if (!hit)
        return null;
    return {
        name: hit.name || "",
        behavior: hit.behavior || "",
        // "" | "R" | "S"
        spreadsheetId: hit.spreadsheetId || "",
        // Google Sheet ID
        createdAt: hit.createdAt || ""
    };
}

/* helpers */
function extractSheetId(input) {
    const v = String(input || "").trim();
    if (!v)
        return "";
    let m = v.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]{10,})/);
    if (m)
        return m[1];
    m = v.match(/[?&]id=([a-zA-Z0-9-_]{10,})/);
    if (m)
        return m[1];
    return /^[a-zA-Z0-9-_]{10,}$/.test(v) ? v : v;
    // URLも許容
}
function normBehavior(b) {
    const v = String(b || "").trim().toUpperCase();
    return v === "R" ? "R" : v === "S" ? "S" : "";
    // "" | R | S
}

// ★ これだけでOK：APIから読んで配列→マップへ正規化
async function loadClientCatalog() {
    try {
        const url = API_BASE + "LoadClientCatalog?filename=" + encodeURIComponent(CLIENT_CATALOG_FILE);
        const res = await fetch(url, { cache: "no-cache" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const ctype = (res.headers.get("content-type") || "").toLowerCase();
        const raw = ctype.includes("application/json") ? await res.json() : JSON.parse(await res.text());

        // 支持: clients が配列 / オブジェクト両対応
        let list = [];
        if (Array.isArray(raw?.clients)) {
            list = raw.clients;
        } else if (raw?.clients && typeof raw.clients === "object") {
            // { "A001": {...}, ... } 形式
            list = Object.entries(raw.clients).map(([code, v]) => ({ ...(v || {}), code }));
        } else if (Array.isArray(raw?.items)) {
            // 念のため（別スキーマ）
            list = raw.items;
        }

        const map = {};
        for (const c of list) {
            const code = sanitizeCL(c?.code || c?.clientId || c?.id || "");
            if (!code) continue;

            map[code] = {
                name: String(c?.name || ""),
                behavior: String(c?.behavior || ""),
                spreadsheetId: String(c?.spreadsheetId || c?.sheetId || ""),
                createdAt: String(c?.createdAt || "")
            };
        }

        clientCatalog = {
            version: Number(raw?.version || 1),
            updatedAt: String(raw?.updatedAt || ""),
            clients: map
        };

        // 起動ログ（存在確認）
        try {
            const keys = Object.keys(clientCatalog.clients || {});
            console.log(`[Texel] client-catalog: loaded ${keys.length} clients`);
        } catch {}
    } catch (e) {
        console.warn("⚠️ client catalog load failed:", e?.message || e);
        clientCatalog = { version: 1, updatedAt: "", clients: {} };
    }
}

// 起動時ロード
loadClientCatalog().catch( () => {}
);
/* ==============================
 * 3) ユーティリティ
 * ============================== */
const autosaveDebounced = debounce( () => saveExportJson().catch( () => {}
), 600);
function debounce(fn, ms=500) {
    let t;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout( () => fn(...args), ms);
    }
    ;
}
const randBase62 = (n=6) => {
    const arr = new Uint8Array(n);
    crypto.getRandomValues(arr);
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    return Array.from(arr, b => chars[b % chars.length]).join("");
}
;
function generateRandomPropertyCode(prefix="L") {
    const now = new Date();
    const yyyy = now.getFullYear().toString();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const hh = String(now.getHours()).padStart(2, "0");
    const mi = String(now.getMinutes()).padStart(2, "0");
    const rand = randBase62(5);
    return `${prefix}${rand}-${yyyy}${mm}${dd}${hh}${mi}`;
}

/* ---------- Loading Spinner（参照カウント） ---------- */
const spinnerCounter = Object.create(null);
function showLoadingSpinner(target) {
    const el = document.getElementById(`loadingSpinner-${target}`);
    if (!el)
        return;
    spinnerCounter[target] = (spinnerCounter[target] || 0) + 1;
    el.style.display = "block";
}
function hideLoadingSpinner(target) {
    const el = document.getElementById(`loadingSpinner-${target}`);
    if (!el)
        return;
    spinnerCounter[target] = Math.max((spinnerCounter[target] || 1) - 1, 0);
    if (spinnerCounter[target] === 0)
        el.style.display = "none";
}

/* ====== テキスト集約（おすすめ／ポータル共通） ====== */
function collectRoomCommentsText() {
    return [...document.querySelectorAll("#history-container .drop-zone textarea")].map(t => t.value.trim()).filter(Boolean).join("\n\n");
}
function buildCombinedSource() {
    const memo = document.getElementById("property-info")?.value.trim() || "";
    const floorplan = document.getElementById("floorplan-preview-text")?.value.trim() || "";
    const roomText = collectRoomCommentsText();
    const pdfText = document.getElementById("pdf-preview")?.textContent?.trim() || "";
    const sections = [`# 物件コード\n${propertyCode || "-"}`, memo && `# AI参照用メモ\n${memo}`, floorplan && `# 間取り図の分析結果\n${floorplan}`, roomText && `# 部屋写真のコメント\n${roomText}`, pdfText && `# PDF抽出テキスト＆要約\n${pdfText}`].filter(Boolean);
    return sections.join("\n\n");
}

// ===== 画像重複整理ヘルパ（新規） =====
function normalizeUrl(u='') {
    try {
        const url = new URL(u,location.origin);
        url.hash = "";
        return url.toString();
    } catch {
        return (u || "").split("#")[0];
    }
}

function uniqByLast(arr, keyFn) {
    const seen = new Set();
    const out = [];
    for (let i = arr.length - 1; i >= 0; i--) {
        const k = keyFn(arr[i]);
        if (seen.has(k))
            continue;
        // 後ろを優先
        seen.add(k);
        out.unshift(arr[i]);
    }
    return out;
}

function isFloorplan(item) {
    const name = (item.name || item.title || item.filename || "").toLowerCase();
    const url = (item.url || item.src || "").toLowerCase();
    const tag = String(item.tag || item.kind || "").toLowerCase();
    return /間取|間取り|間取図/.test(name) || /floor.?plan|madori/.test(name + url + tag);
}

// Type-R用：先頭が間取り図で同一画像が後方にある場合は先頭を落とす＋重複は後勝ち
function buildImageQueue_TypeR(raw) {
    let images = Array.isArray(raw) ? [...raw] : [];

    if (images.length && isFloorplan(images[0])) {
        const firstKey = normalizeUrl(images[0].url || images[0].src || images[0].id || images[0]);
        const dupBehind = images.slice(1).some(it => normalizeUrl(it.url || it.src || it.id || it) === firstKey);
        if (dupBehind)
            images.shift();
        // ← 先頭を捨てる（後方を残す）
    }

    images = uniqByLast(images, it => normalizeUrl(it.url || it.src || it.id || it));
    return images;
}

/* ==============================
 * 4) 入力ダイアログ（CL/BK）
 * ============================== */
function setModalModeText(mode, requiresBK) {
    const subtitle = document.getElementById("modal-subtitle");
    subtitle.textContent = mode === "BASE" ? "手動モード：PDFや間取図を手動で読み込んで使います（BK不要）" : mode === "TYPE-R" ? "TYPE-R：Rehouse API を使って物件情報を取得します（BK必須）" : mode === "TYPE-S" ? "TYPE-S：S-NETプレビューのタブが BK と一致している必要があります（BK必須）" : "CL ID が未登録です。カタログに存在するCL ID（例：B001）を指定してください。";
    const bkWrap = document.getElementById("bk-wrapper");
    bkWrap.style.display = requiresBK ? "block" : "none";
}
function sanitizeCL(v) {
    return (v || "").trim().toUpperCase();
}
function sanitizeBK(v) {
    return (v || "").trim().toUpperCase();
}

/**
 * behavior の表記揺れを吸収し、"BASE" | "TYPE-R" | "TYPE-S" に正規化する
 * - Client Catalog が "R"/"S" で返す場合も "TYPE-R"/"TYPE-S" で返す場合も吸収
 */
function normalizeBehavior(raw) {
    const v = String(raw || "").trim().toUpperCase();

    if (v === "" || v === "BASE") return "BASE";

    // short form
    if (v === "R" || v === "TYPE-R" || v === "TYPER") return "TYPE-R";
    if (v === "S" || v === "TYPE-S" || v === "TYPES") return "TYPE-S";

    // defensive (e.g., "TYPE R", "TYPE_R")
    if (v.replace(/[^A-Z]/g, "") === "TYPER") return "TYPE-R";
    if (v.replace(/[^A-Z]/g, "") === "TYPES") return "TYPE-S";

    // last resort: if it contains R/S token
    if (v.includes("R")) return "TYPE-R";
    if (v.includes("S")) return "TYPE-S";

    return "BASE";
}


/** 現在入力の CL から behavior / sheetId を先読みし、決定ボタンの活性を制御 */
function evaluateDialogState() {
    const clIn = document.getElementById("client-code-input");
    const bkIn = document.getElementById("bk-id-input");
    const btn = document.getElementById("start-button");
    const cl = sanitizeCL(clIn.value);
    // ✅ カタログ未ロード時は待機表示にする
    if (!clientCatalog || !Object.keys(clientCatalog.clients || {}).length) {
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
    sheetIdForGPT = (cfg?.spreadsheetId || DEFAULT_SHEET_ID).trim();
    sessionSheetId = sheetIdForGPT;
    const mode = normalizeBehavior(cfg?.behavior); // "BASE" | "TYPE-R" | "TYPE-S"
    const requiresBK = (mode === "TYPE-R" || mode === "TYPE-S");

    setModalModeText(mode, requiresBK);

    if (!requiresBK) {
        // BASE：BK不要
        btn.disabled = false;
        return;
    }

    // TYPE-R / TYPE-S：BK必須
    btn.disabled = sanitizeBK(bkIn.value).length === 0;
}

/** TYPE-S: S-NETプレビューが対象BKで開いているか確認（簡易） */
async function isSuumoPreviewOpen(bkId) {
    try {
        if (!chrome?.tabs?.query)
            return false;
        const tabs = await new Promise( (resolve) => {
            chrome.tabs.query({
                url: ["https://manager.suumo.jp/*"]
            }, (res) => resolve(res || []));
        }
        );
        const ok = tabs.some( (t) => {
            try {
                const u = new URL(t.url || "");
                // bc=BKID が付いているか
                const bc = u.searchParams.get("bc");
                return bc && bc.toUpperCase() === bkId.toUpperCase();
            } catch {
                return false;
            }
        }
        );
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
    }
    );
    return target || null;
}

/* ==========================================
 * scrapeSuumoPreview(tabId)
 * 1) content script へメッセージ送信（推奨）
 * 2) 失敗したら executeScript で同じ関数を直接実行（フォールバック）
 * ========================================== */
async function scrapeSuumoPreview(tabId) {
    // 1) content script に依頼
    const messageTry = new Promise( (resolve, reject) => {
        try {
            chrome.tabs.sendMessage(tabId, {
                type: "SCRAPE_SUUMO_PREVIEW"
            }, (resp) => {
                const lastErr = chrome.runtime?.lastError;
                if (lastErr)
                    return reject(new Error(lastErr.message || "sendMessage failed"));
                if (!resp)
                    return reject(new Error("no response from content script"));
                resolve(resp);
            }
            );
        } catch (e) {
            reject(e);
        }
    }
    );

    try {
        const res = await Promise.race([messageTry, new Promise( (_, rej) => setTimeout( () => rej(new Error("sendMessage timeout")), 5000)), ]);
        if (res && res.ok)
            return res;
        // { ok:true, bk, title, memoText, floorplanUrl, roomImageUrls }
    } catch (_) {// nop → フォールバックへ
    }

    // 2) フォールバック：executeScript（サイドパネル等で未提供ならここもスキップ）
    if (!chrome.scripting?.executeScript) {
        throw new Error("content script が見つからず、executeScript も使えません。");
    }

    const inlineScrape = () => {
        const ABS = (u) => {
            try {
                return new URL(u,location.href).href;
            } catch {
                return u || "";
            }
        }
        ;
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const bk = document.querySelector('input[name="bukkenCd"]')?.value?.trim() || new URL(location.href).searchParams.get("bc") || document.getElementById("js-bukken_code")?.textContent?.trim() || "";

        const findRowValue = (labelLike) => {
            const ths = Array.from(document.querySelectorAll("table th"));
            const th = ths.find(th => norm(th.textContent).includes(labelLike));
            if (!th)
                return "";
            const td = th.parentElement?.querySelector("td");
            return norm(td ? (td.innerText || td.textContent) : "");
        }
        ;

        const title = norm(document.querySelector(".mainIndexK")?.textContent || "");
        const price = findRowValue("価格");
        const plan = findRowValue("間取り");
        const area = findRowValue("専有面積");
        const floor = findRowValue("所在階");
        const dir = findRowValue("向き");
        const built = findRowValue("完成時期") || findRowValue("築年月") || findRowValue("完成時期(築年月)");
        const addr = findRowValue("住所") || findRowValue("所在地");
        const traffic = findRowValue("交通");

        const allImgs = Array.from(document.images || []);
        const pickSrc = (img) => img.currentSrc || img.src || img.getAttribute("data-src") || img.getAttribute("data-original") || img.getAttribute("data-lazy") || "";
        const toItem = (img) => {
            const src = pickSrc(img);
            return {
                url: ABS(src),
                alt: img.alt || "",
                w: img.naturalWidth || img.width || 0,
                h: img.naturalHeight || img.height || 0
            };
        }
        ;
        const imgs = allImgs.map(toItem).filter(x => x.url && !x.url.startsWith("data:"));

        const isFloorplanByText = (x) => /間取|間取り|区画|間取図|madori|floor-?plan/i.test(x.alt) || /madori|floor-?plan/i.test(x.url);
        const isProbablyFloorplanByShape = (x) => {
            const min = Math.min(x.w, x.h);
            const ar = x.w && x.h ? (x.w / x.h) : 1;
            return min >= 240 && ar >= 0.6 && ar <= 2.2;
        }
        ;
        const floorplan = imgs.find(isFloorplanByText) || imgs.find(isProbablyFloorplanByShape) || null;

        const roomPhotos = imgs.filter(x => !floorplan || x.url !== floorplan.url).filter(x => {
            const min = Math.min(x.w, x.h);
            if (min < 180)
                return false;
            if (/logo|sprite|icon|gif/i.test(x.url))
                return false;
            if (isFloorplanByText(x))
                return false;
            return true;
        }
        );

        const lines = [];
        if (title)
            lines.push(`・物件名：${title}`);
        if (addr)
            lines.push(`・所在地：${addr}`);
        if (plan)
            lines.push(`・間取り：${plan}`);
        if (area)
            lines.push(`・専有面積：${area}`);
        if (floor)
            lines.push(`・所在階：${floor}`);
        if (dir)
            lines.push(`・向き：${dir}`);
        if (built)
            lines.push(`・築年月：${built}`);
        if (price)
            lines.push(`・価格：${price}`);
        if (traffic)
            lines.push(`・交通：${traffic}`);
        const memoText = lines.join("\n");

        return {
            ok: true,
            bk,
            title,
            memoText,
            floorplanUrl: floorplan ? floorplan.url : "",
            roomImageUrls: roomPhotos.map(x => x.url)
        };
    }
    ;

    const [{result}] = await chrome.scripting.executeScript({
        target: {
            tabId
        },
        func: inlineScrape
    });

    if (!result?.ok)
        throw new Error("inline executeScript でも抽出に失敗");
    return result;
}

/* ============================================================
 * TYPE-S 取得：BGに依頼（サイドパネル側では scripting を使わない）
 * ============================================================ */
async function scrapeSuumoPreviewViaBG(bkId) {
    const res = await chrome.runtime.sendMessage({
        type: "TEXEL_SCRAPE_SUUMO",
        bkId
    });
    if (!res?.ok)
        throw new Error(res?.error || "BG scrape failed");
    // res.payload は { ok, bk, title, memoText, floorplanUrl, roomImageUrls }
    return res.payload;
}

/* ============================================================
 * TYPE-S メインフロー（呼び出し側の後段処理は従来のまま）
 * ============================================================ */
async function fetchImagesBase64ViaBG(bkId, urls) {
    const resp = await chrome.runtime.sendMessage({
        type: "TEXEL_FETCH_IMAGES_BASE64",
        bkId,
        urls
    });
    if (!resp?.ok)
        throw new Error(resp?.error || "BG base64 fetch failed");
    return resp.result;
    // [{url, ok, base64? , error?}, ...]
}

// TYPE-S：Suumoプレビュー → 画像Base64化 → 間取りプレビュー表示＆方位待ち → 写真解析 → おすすめ生成
// SUUMO: 画像を集め、間取りがある時はプレビュー表示＋方位確定待ち（写真は defer）
async function startTypeSFlow(bkId) {
    try {
        showLoadingSpinner("floorplan");

        // 1) DOMスクレイプ
        const scrapedWrap = await scrapeSuumoPreviewViaBG(bkId);
        postLog("type-s.scrape", scrapedWrap?.ok ? "ok" : "fail", {
            floorplan: !!scrapedWrap?.floorplanUrl,
            rooms: (scrapedWrap?.roomImageUrls || scrapedWrap?.roomImages || []).length || 0
        });
        if (!scrapedWrap?.ok)
            throw new Error(scrapedWrap?.error || "scrape failed");
        const scraped = scrapedWrap;

        // 2) メモ反映
        const memo = document.getElementById("property-info");
        if (memo && scraped.memoText) {
            memo.value = scraped.memoText;
            autoGrow(memo);
        }

        // 3) 画像メタ（先頭は間取り）＋「写真分析対象」にも間取りを含める
        const imgsMeta = [];
        let rooms = (Array.isArray(scraped.roomImages) && scraped.roomImages.length) ? scraped.roomImages : (scraped.roomImageUrls || []).map(u => ({
            url: u,
            title: "",
            desc: ""
        }));

        if (scraped.floorplanUrl) {
            imgsMeta.push({
                url: scraped.floorplanUrl,
                title: "間取り図",
                desc: "",
                kind: "floorplan"
            });
            rooms = [{
                url: suumoResizeWidth(scraped.floorplanUrl, 500),
                title: "間取り図",
                desc: "間取り図"
            }, ...rooms];
        }

        // room 側の URL も統一
        rooms = rooms.map(o => ({
            ...o,
            url: suumoResizeWidth(o.url, 500)
        }));

        // ★ 追加：Type-Sでも重複整理したい場合（任意）
        rooms = buildImageQueue_TypeR(rooms);

        imgsMeta.push(...rooms.map(o => ({
            ...o,
            kind: "room"
        })));

        if (!imgsMeta.length) {
            await saveExportJson();
            return;
        }

        // 4) Base64化
        // ここで SUUMO のリサイズ幅を w=500 にそろえる
        const normalizedImgUrls = imgsMeta.map(i => suumoResizeWidth(i.url, 500));
        const b64results = await fetchImagesBase64ViaBG(bkId, normalizedImgUrls);

        // 5) 整形：間取りを表示→“北”確定ボタンに「間取り含む写真リスト」を退避（この時点では実行しない）
        let floorplanFound = false;
        for (let i = 0; i < b64results.length; i++) {
            const r = b64results[i];
            const meta = imgsMeta[i];
            if (!r?.ok || !r.base64) {
                console.warn("画像の読み込み失敗:", r?.url, r?.error);
                continue;
            }

            if (meta.kind === "floorplan") {
                floorplanFound = true;
                currentFloorplanBase64 = r.base64;

                const img = document.getElementById("floorplan-preview");
                if (img) {
                    img.style.display = "none";
                    img.onload = () => {
                        img.style.display = "block";
                        img.style.cursor = "pointer";
                    }
                    ;
                    setTimeout( () => {
                        img.style.display = "block";
                        img.style.cursor = "pointer";
                    }
                    , 200);
                    img.src = r.base64;
                }
                showNorthSelector();
                // 表示（※名称変更）

                // “北”確定ボタンに「間取りを含む写真配列」を退避
                const confirmBtn = document.getElementById("confirmNorthButton");
                if (confirmBtn)
                    confirmBtn.dataset.deferRoomImages = JSON.stringify(rooms);
            }
        }

        // 6) 間取りが無い場合のみ、写真を即時解析して完走
        if (!floorplanFound && rooms.length) {
            await analyzeRoomImagesSequentially(rooms);
            if (typeof runSuggestionAndPortals === "function")
                await runSuggestionAndPortals();
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

/* === プロンプトURL解決（API → Blob(SAS)） ===
   Texel は「Blob を唯一の正」とするため、拡張内ファイルや same-origin は参照しない。
   ※ これにより chrome-extension://... の ERR_FILE_NOT_FOUND を発生させない。
*/
function buildPromptUrls(filename) {
    const urls = [];
    try {
        const viaFunc = API.loadPromptText(filename);
        if (viaFunc)
            urls.push(viaFunc);
    } catch {}
    if (PROMPTS_SAS && PROMPTS_SAS.trim()) {
        const account = ENV === "prod" ? BLOB_ACCOUNT.prod : BLOB_ACCOUNT.dev;
        urls.push(`${account}/${PROMPTS_CONTAINER}/${filename}${PROMPTS_SAS}`);
    }
    return urls;
}

function extractPromptText(obj) {
    if (obj == null)
        return "";
    if (typeof obj === "string")
        return obj;
    if (typeof obj !== "object")
        return String(obj);

    // 1) OpenAI互換: messages 配列から system を抽出
    // - {messages:[{role:'system',content:'...'}, ...]} 形式
    // - prompt/messages がネストされている既存資産も吸収
    const msgs = (Array.isArray(obj.messages) ? obj.messages : null) || (Array.isArray(obj.prompt?.messages) ? obj.prompt.messages : null) || (Array.isArray(obj.prompt) ? obj.prompt : null);

    if (msgs && msgs.length) {
        const sys = msgs.filter(m => (m?.role || "").toLowerCase() === "system");
        if (sys.length)
            return sys.map(m => (m?.content ?? "")).join("\n\n");

        // system が無い場合は先頭の content を返す
        const first = msgs.find(m => typeof m?.content === "string");
        if (first)
            return first.content;
    }

    // 2) 既存資産の揺れを吸収（prompt / system / systemPrompt / template 等）
    const v = obj.prompt ?? obj.system ?? obj.systemPrompt ?? obj.instructions ?? obj.template ?? obj.text ?? obj?.prompt?.text ?? obj?.system?.text ?? obj?.systemPrompt?.text ?? "";

    if (typeof v === "string")
        return v;

    // 3) 最後の砦：JSON文字列化
    try {
        return JSON.stringify(v, null, 2);
    } catch {
        return String(v);
    }
}
function extractPromptParams(obj) {
    if (!obj || typeof obj !== "object")
        return {};
    return obj.params || obj.parameters || obj.modelParams || {};
}

// ===== Prompt path policy =====
// ここに「Texel共通」を集約（再発防止の唯一の場所）
const SHARED_PROMPT_FILES = new Set(["texel-floorplan.json", "texel-client-catalog.json", "texel-commitment-master.json", ]);

function isSharedPromptFilename(filename) {
    const base = (filename || "").split("/").pop();
    // client/A001/... が来ても最後だけ見る
    return SHARED_PROMPT_FILES.has(base);
}
function normalizePromptFilename(filename) {
    const f = String(filename || "").trim().replace(/^\/+/, "");
    return f;
}


// --- Texel共通プロンプト（クライアント配下探索を行わない） ---
const COMMON_PROMPT_FILES = new Set([
    "texel-floorplan.json",
    "texel-pdf-image.json",
]);

function resolvePromptFetchCandidates(filename, clientId) {
    // 仕様：
    // 1) clientId がある場合は「client/<clientId>/」を先に探索
    // 2) 見つからなければ Texel 共通（直下）へフォールバック
    // 3) 既に client/ 配下が明示されている場合はそのまま（フォールバックしない）
    //
    // 追加仕様（Type-R/Type-S の互換）：
    // - client フォルダへのコピー時に texel-r-*.json / texel-s-*.json が texel-*.json に正規化されているケースがあるため、
    //   client/<cid>/texel-r-xxx.json を探す前に client/<cid>/texel-xxx.json を優先探索する。
    const f = normalizePromptFilename(filename);
    if (!f) return [];

    const fl = f.toLowerCase();

    // 明示的なパスはそのまま（探索しない）
    if (fl.startsWith("client/")) return [f];

    // Texel 共通プロンプトは client/ を探索しない
    if (COMMON_PROMPT_FILES.has(fl)) return [f];

    const list = [];

    // texel-r-xxx.json / texel-s-xxx.json → client では texel-xxx.json に正規化されている互換
    const m = /^texel-(r|s)-([a-z0-9\-]+)\.json$/i.exec(f);

    if (clientId) {
        if (m) {
            // まず正規化名（texel-xxx.json）を優先
            list.push(`client/${clientId}/texel-${m[2]}.json`);
            // その上で、もし client 側に texel-r- / texel-s- のまま存在する場合にも対応
            list.push(`client/${clientId}/${f}`);
        } else {
            list.push(`client/${clientId}/${f}`);
        }
    }

    // 最後に Texel 共通（直下）
    list.push(f);

    return Array.from(new Set(list.filter(Boolean)));
}

// ===== Prompt Index: Safe Loader =====
async function loadPromptIndexSafe(cid) {
  try {
    const idx = await fetchPromptIndexJson(cid);
    return idx || null;
  } catch (e) {
    console.warn("[Texel] loadPromptIndexSafe failed:", e);
    return null;
  }
}


async function fetchPromptIndexJson(clientId) {
    if (!clientId)
        return null;
    try {
        const obj = await fetchPromptTextFile("prompt-index.json", clientId);
        if (!obj)
            return null;
        if (typeof obj === "string") {
            try {
                return JSON.parse(obj);
            } catch {
                return null;
            }
        }
        return obj;
    } catch (e) {
        console.warn("[prompt-index] load failed:", e);
        return null;
    }
}

/**
 * Prompts container から JSON を取得する（探索しない・一発解決）
 * 期待：API の LoadPromptText が prompts コンテナ/filename を読む
 */
async function fetchPromptTextFile(filename, clientId) {
    const candidates = resolvePromptFetchCandidates(filename, clientId);
    if (!candidates.length)
        return null;

    const base = `${FUNCTION_BASE.replace(/\/+$/, "")}/LoadPromptText?filename=`;

    for (const resolved of candidates) {
        const url = base + encodeURIComponent(resolved);
        let res;
        try {
            res = await fetch(url, {
                method: "GET"
            });
        } catch (e) {
            console.warn(`[prompt] LoadPromptText fetch failed: ${resolved}`, e);
            continue;
        }

        if (!res.ok) {
            // 404/400 など「存在しない」扱いは次候補へ（= client → root フォールバック）
            console.warn(`[prompt] miss: ${resolved} (${res.status})`);
            continue;
        }

        console.log(`[prompt] BLOB使用: ${resolved}`);

        const ct = (res.headers.get("content-type") || "").toLowerCase();
        const text = await res.text();

        // JSONならparse、そうでなければ生テキスト
        if (ct.includes("application/json") || text.trim().startsWith("{") || text.trim().startsWith("[")) {
            try {
                return JSON.parse(text);
            } catch {
                // fallthrough
            }
        }
        return text;
    }

    return null;
}

async function getPromptObj(keyLike, fallbackFilename) {
    // BLOB優先・キャッシュ無効版
    const candidates = resolvePromptCandidates(keyLike, fallbackFilename);
    let fetched = null;
    for (const filename of candidates) {
        fetched = await fetchPromptTextFile(filename, clientId);
        if (fetched)
            break;
    }
    // すべて失敗 → 安全なデフォルト
    const obj = fetched || defaultPrompt(keyLike);
    // ローカル保存はしない（Texel方針）
    return obj;
}

/* ==============================
 * 6) 保存（Spreadsheet）
 * ============================== */
// ★前回成功したヘッダー/出力を保持（モジュールスコープ）
let __lastOrderedOutputHeaders = null;
let __lastOrderedOutputs = null;

async function saveExportJson() {
  if (!sessionSheetId) {
    console.error("❌ sessionSheetId is empty – abort saveExportJson");
    return;
  }

  function buildOrderedFromDom() {
    const wrap = document.getElementById("suggestion-outputs");
    if (!wrap) return [];

    const blocks = Array.from(wrap.children);
    const out = [];

    for (const block of blocks) {
      const ta = block.querySelector("textarea");
      if (!ta) continue;

      let file = String(ta.dataset.file || block.dataset.file || "").trim();

      let name =
        (block.querySelector("label")?.textContent || "").trim() ||
        (block.querySelector("h3")?.textContent || "").trim() ||
        (block.querySelector("h4")?.textContent || "").trim() ||
        file;

      name = name.replace(/^🧩\s*/u, "").trim();

      const text = String(ta.value || "");
      out.push({ file, name, text });
    }
    return out;
  }

  // 1) DOM から取得
  let orderedOutputs = buildOrderedFromDom();
  let orderedOutputHeaders = orderedOutputs.map(o => String(o.name || "").trim());

  // 2) 取れない/空なら「最後に取れたもの」を使う
  const valid = orderedOutputHeaders.some(h => h && h.trim() !== "");
  if (!valid) {
    if (__lastOrderedOutputHeaders && __lastOrderedOutputs) {
      orderedOutputHeaders = __lastOrderedOutputHeaders;
      orderedOutputs = __lastOrderedOutputs;
    }
  } else {
    // 3) 取れたらキャッシュ更新
    __lastOrderedOutputHeaders = orderedOutputHeaders.slice();
    __lastOrderedOutputs = orderedOutputs.slice();
  }
  // 4) 枠数はDOM（＝インデックスの並び）に合わせて可変。
  //    ただしヘッダー空欄は列名安定のため「予備N」で補完。
  orderedOutputHeaders = orderedOutputHeaders.map((h, i) => {
    const v = String(h || "").trim();
    return v || `予備${i + 1}`;
  });
  const orderedOutputSlotCount = orderedOutputs.length;

  const exportJson = {
    propertyCode,
    clientId,
    spreadsheetId: sessionSheetId,

    memo: document.getElementById("property-info")?.value.trim() || "",
    pdfImage: (typeof latestPdfThumbnailBase64 === "string" ? latestPdfThumbnailBase64 : "") || document.getElementById("pdf-image-preview")?.src || "",
    pdfExtractedText: (typeof latestPdfExtractedText === "string" ? latestPdfExtractedText : "") || "",
    floorplanImageBase64: document.getElementById("floorplan-preview")?.src || "",
    floorplanAnalysis: document.getElementById("floorplan-preview-text")?.value.trim() || "",

    // ★順序確定
    orderedOutputHeaders,
    orderedOutputs,
    orderedOutputSlotCount,

    // 既存互換も残す（必要なら）
    suggestions: document.querySelector("#suggestion-area textarea")?.value.trim() || "",
    "suumo-catch": getTextareaValue("suumo-catch"),
    "suumo-comment": getTextareaValue("suumo-comment"),
    "athome-comment": getTextareaValue("athome-comment"),
    "athome-appeal": getTextareaValue("athome-appeal"),

    roomComments: (() => {
      const unique = new Set();
      return Array.from(document.querySelectorAll("#history-container .drop-zone"))
        .map((z) => {
          const img = z.querySelector("img")?.src || "";
          const cmt = z.querySelector("textarea")?.value || "";
          const key = img + "___" + cmt;
          if (!img || !cmt || unique.has(key)) return null;
          unique.add(key);
          return { image: img, comment: cmt };
        })
        .filter(Boolean);
    })(),

    timestamp: new Date().toISOString(),
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

function createCustomPromptBlock(item) {
    const file = (item.file || "").trim();
    const labelText = (item.name && item.name.trim()) ? item.name.trim() : file;

    // id を file から安全に生成
    const baseId = "custom-" + file.replace(/\.json$/i, "").replace(/^texel-/, "").replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase();

    const wrap = document.createElement("div");
    wrap.className = "analysis-area";
    wrap.style.position = "relative";
    wrap.style.marginTop = "16px";
    wrap.dataset.file = file;

    const label = document.createElement("label");
    label.style.fontSize = "13px";
    label.textContent = `🧩 ${labelText}`;

    const ta = document.createElement("textarea");
    ta.id = baseId;
    ta.classList.add("auto-grow");
    ta.style.width = "100%";
    ta.style.fontSize = "13px";
    ta.dataset.file = file;
    // ★ 後で保存/生成処理に使える
    if (item.lock)
        ta.readOnly = true;

    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.justifyContent = "space-between";
    row.style.alignItems = "center";
    row.style.marginTop = "4px";

    const copyBtn = document.createElement("button");
    copyBtn.className = "copy-button";
    copyBtn.type = "button";
    copyBtn.textContent = "📋 コピー";

    const count = document.createElement("span");
    count.style.fontSize = "12px";
    count.style.color = "#555";
    count.textContent = "0";

    // 挙動：オートグロー & 文字数表示（制限なし）
    const update = () => {
        count.textContent = String((ta.value || "").replace(/\r\n/g, "\n").length);
    }
    ;

    ta.addEventListener("input", () => {
        if (typeof autoGrow === "function")
            autoGrow(ta);
        update();
        if (typeof autosaveDebounced === "function")
            autosaveDebounced();
    }
    );

    copyBtn.addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText((ta.value || "").trim());
            if (typeof showCopyNotification === "function")
                showCopyNotification("クリップボードへコピーしました");
        } catch {
            if (typeof showCopyNotification === "function")
                showCopyNotification("コピーに失敗しました");
        }
    }
    );

    row.appendChild(copyBtn);
    row.appendChild(count);

    wrap.appendChild(label);
    wrap.appendChild(ta);
    wrap.appendChild(row);

    // 初期反映
    if (typeof autoGrow === "function")
        autoGrow(ta);
    update();

    // hidden は上位で制御（display:none）
    return wrap;
}

/**
 * prompt-index.json の items(order/hidden/lock) に従って
 * おすすめポイント出力欄（既存5枠）を並べ替え、
 * さらに未知の texel-*.json（texel-roomphoto.json を除く）を
 * カスタム枠として動的に生成・挿入する。
 *
 * 前提：
 * - suggestion-section が存在する（#suggestion-section）
 * - 既存5枠の textarea id が存在する：
 *    #editable-suggestion（おすすめポイント本文）
 *    #suumo-catch
 *    #suumo-comment
 *    #athome-comment
 *    #athome-appeal
 * - 既存おすすめポイント枠は #suggestion-area（analysis-area）としてまとまっている
 * - 既存4ポータル枠は textarea の親 .analysis-area がブロック単位
 */
function applyPromptIndexOrderToSuggestionDom(promptIndex) {
    const sec = document.getElementById("suggestion-section");
    if (!sec || !promptIndex || !Array.isArray(promptIndex.items))
        return;

    // ---------------------------
    // Known outputs (既存5枠)
    // ---------------------------
    const KNOWN_OUTPUT_FILES = new Set(["texel-suggestion.json", "texel-suumo-catch.json", "texel-suumo-comment.json", "texel-athome-comment.json", "texel-athome-appeal.json", ]);

    function isCustomPromptFile(file) {
        if (!file)
            return false;
        if (!/^texel-.*\.json$/i.test(file))
            return false;
        if (file === "texel-roomphoto.json")
            return false;
        // ★除外（おすすめポイント出力欄の話ではない）
        if (KNOWN_OUTPUT_FILES.has(file))
            return false;
        // 既存5枠は custom ではない
        return true;
    }

    // ---------------------------
    // Output container (受け皿)
    // ---------------------------
    let wrap = document.getElementById("suggestion-outputs");
    if (!wrap) {
        wrap = document.createElement("div");
        wrap.id = "suggestion-outputs";
        wrap.style.marginTop = "8px";

        // generateボタン直後に入れるのが一番安定（UI崩れを防ぐ）
        const genBtn = document.getElementById("generate-suggestions");
        if (genBtn && genBtn.parentElement === sec) {
            genBtn.insertAdjacentElement("afterend", wrap);
        } else {
            sec.appendChild(wrap);
        }
    }

    // ---------------------------
    // Map: file -> block element
    // ---------------------------
    const map = new Map();

    // 既存：おすすめポイント本文ブロック
    const suggestionArea = document.getElementById("suggestion-area");
    if (suggestionArea)
        map.set("texel-suggestion.json", suggestionArea);

    // 既存：4ポータルは textarea から親 .analysis-area を取る
    const suumoCatchBlock = document.getElementById("suumo-catch")?.closest(".analysis-area");
    if (suumoCatchBlock)
        map.set("texel-suumo-catch.json", suumoCatchBlock);

    const suumoCommentBlock = document.getElementById("suumo-comment")?.closest(".analysis-area");
    if (suumoCommentBlock)
        map.set("texel-suumo-comment.json", suumoCommentBlock);

    const athomeCommentBlock = document.getElementById("athome-comment")?.closest(".analysis-area");
    if (athomeCommentBlock)
        map.set("texel-athome-comment.json", athomeCommentBlock);

    const athomeAppealBlock = document.getElementById("athome-appeal")?.closest(".analysis-area");
    if (athomeAppealBlock)
        map.set("texel-athome-appeal.json", athomeAppealBlock);

    // ---------------------------
    // Custom block factory
    // ---------------------------
    function createCustomPromptBlock(item) {
        const file = (item.file || "").trim();
        const labelText = (item.name && item.name.trim()) ? item.name.trim() : file;

        // id を file から安全に生成
        const baseId = "custom-" + file.replace(/\.json$/i, "").replace(/^texel-/, "").replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase();

        const block = document.createElement("div");
        block.className = "analysis-area";
        block.style.marginTop = "16px";
        block.style.position = "relative";
        block.dataset.file = file;

        const label = document.createElement("label");
        label.style.fontSize = "13px";
        label.textContent = `🧩 ${labelText}`;

        const ta = document.createElement("textarea");
        ta.id = baseId;
        ta.classList.add("auto-grow");
        ta.style.width = "100%";
        ta.style.fontSize = "13px";
        ta.dataset.file = file;
        // ★保存/復元のキーとして使える

        if (item.lock)
            ta.readOnly = true;

        const toolRow = document.createElement("div");
        toolRow.style.display = "flex";
        toolRow.style.justifyContent = "space-between";
        toolRow.style.alignItems = "center";
        toolRow.style.marginTop = "4px";

        const copyBtn = document.createElement("button");
        copyBtn.className = "copy-button";
        copyBtn.type = "button";
        copyBtn.textContent = "📋 コピー";

        const count = document.createElement("span");
        count.style.fontSize = "12px";
        count.style.color = "#555";
        count.textContent = "0";

        const updateCount = () => {
            count.textContent = String((ta.value || "").replace(/\r\n/g, "\n").length);
        }
        ;

        ta.addEventListener("input", () => {
            if (typeof autoGrow === "function")
                autoGrow(ta);
            updateCount();
            if (typeof autosaveDebounced === "function")
                autosaveDebounced();
        }
        );

        copyBtn.addEventListener("click", async () => {
            try {
                await navigator.clipboard.writeText((ta.value || "").trim());
                if (typeof showCopyNotification === "function")
                    showCopyNotification("クリップボードへコピーしました");
            } catch {
                if (typeof showCopyNotification === "function")
                    showCopyNotification("コピーに失敗しました");
            }
        }
        );

        toolRow.appendChild(copyBtn);
        toolRow.appendChild(count);

        block.appendChild(label);
        block.appendChild(ta);
        block.appendChild(toolRow);

        // 初期反映
        if (typeof autoGrow === "function")
            autoGrow(ta);
        updateCount();

        return block;
    }

    // ---------------------------
    // Normalize/sort items by order
    // ---------------------------
    const items = promptIndex.items.filter(it => it && typeof it.file === "string").map(it => ({
        file: it.file.trim(),
        name: (it.name || "").trim(),
        order: Number.isFinite(+it.order) ? +it.order : 9999,
        hidden: !!it.hidden,
        lock: !!it.lock
    })).sort( (a, b) => a.order - b.order);

    // ---------------------------
    // Apply order: append in sorted order
    // ---------------------------
    const moved = new Set();

    for (const it of items) {
        const file = it.file;

        // 既存ブロックを取得
        let block = map.get(file);

        // 無ければ custom 生成
        if (!block && isCustomPromptFile(file)) {
            block = createCustomPromptBlock(it);
            map.set(file, block);
        }

        // 対象外はスキップ（roomphoto等）
        if (!block)
            continue;

        // hidden / lock 反映
        block.style.display = it.hidden ? "none" : "";

        if (it.lock) {
            block.querySelectorAll("textarea").forEach(t => {
                t.readOnly = true;
            }
            );
        }

        wrap.appendChild(block);
        moved.add(file);
    }

    // ---------------------------
    // Safety: index に無い既存ブロックは最後に回す（壊さない）
    // ※「indexが絶対」なら、ここを削ってもOK
    // ---------------------------
    for (const [file,block] of map.entries()) {
        if (moved.has(file))
            continue;
        wrap.appendChild(block);
    }
}

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
    }
    ;
    script.onerror = () => console.error("❌ pdf.js 読み込み失敗");
    document.head.appendChild(script);
}
)();

/* ==============================
 * 10) 物件画像から間取り図候補
 * ============================== */
function guessFloorplanFromPropertyImages(data) {
    const imgs = data?.propertyImages || [];
    if (!Array.isArray(imgs) || !imgs.length)
        return null;
    const cand = imgs.find( (img) => /間取図|区画図/.test(img?.title || "") || /floorplan|floor-plan/i.test(img?.url || ""));
    return cand?.url || null;
}
function guessFloorplanUrlFromProperty(data) {
    // Rehouse の詳細 JSON にカスタムの間取図フィールドがある場合の補助（なければ null）
    const maybe = data?.floorplanUrl || data?.images?.find?.(x => /floor/i.test(x?.type || ""))?.url;
    return maybe || null;
}

/* ==============================
 * 11) 起動時モーダル／イベント登録（CL/BK）
 * ============================== */
document.addEventListener("DOMContentLoaded", async () => {
    applyEnvBadge();
    userId = await detectUserId();
    logBootRouting();
    // ★ 起動直後にDEV/PRODで変わるものを出す
    // ✅ 起動時は Client Catalog のみ（commitment-master は TYPE-R のときだけ）
    try {
        await loadClientCatalog();
    } catch {}

    // 歯車：プロンプトエディタ（既存）
    document.body.addEventListener("click", async (e) => {
        const a = e.target.closest('a.prompt-config-link');
        if (!a)
            return;
        e.preventDefault();
        const t = a.getAttribute('data-type') || '';
        const url = chrome.runtime.getURL(`local-prompt-editor.html?type=${encodeURIComponent(t)}`);
        if (chrome?.tabs?.create)
            await chrome.tabs.create({
                url
            });
        else
            window.open(url, "_blank");
    }
    );

    // モーダル（CL/BK）
    const modal = document.getElementById("property-code-modal");
    const clIn = document.getElementById("client-code-input");
    // ★ 4桁英数字（必須）
    const bkIn = document.getElementById("bk-id-input");
    // ★ Behaviorにより必須
    const btn = document.getElementById("start-button");
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
    //document.getElementById("generate-summary").addEventListener("click", onRegenerateSummary);
    //document.getElementById("reset-suggestion")?.addEventListener("click", onClickResetSuggestion);

    // おすすめポイントの「コピー＋文字数」初期化
    bindSuggestionTools();

    // 画像ポップアップ
    bindImagePopup();

    // 方位決定 → 間取り図解析（ROOM画像保留再開）
    document.getElementById("confirmNorthButton").addEventListener("click", onConfirmNorth);

    // 決定（起動）
    btn.addEventListener("click", async () => {
        clientId = sanitizeCL(clIn.value);
        const cfg = resolveClientConfig(clientId);
        const bkId = sanitizeBK(bkIn.value);
        postLog("start", "dialog confirmed", {
            behavior: (cfg?.behavior || ""),
            bk: bkId || null
        });

        if (!cfg) {
            alert("このCL IDは登録がありません。CatalogのCL（例：B001）を指定してください。");
            return;
        }

        const mode = normalizeBehavior(cfg?.behavior); // "BASE" | "TYPE-R" | "TYPE-S"
        const behavior = (mode === "TYPE-R") ? "R" : (mode === "TYPE-S") ? "S" : "";
        // "" | "R" | "S"（下流の既存分岐を活かす）
        CURRENT_BEHAVIOR = mode;
        // "BASE" | "TYPE-R" | "TYPE-S"

        // 共通：sheetId セット
        sheetIdForGPT = (cfg.spreadsheetId || DEFAULT_SHEET_ID).trim();
        sessionSheetId = sheetIdForGPT;

        if (!behavior) {
            propertyCode = generateRandomPropertyCode();
            // BASE: BK不要
        } else if (behavior === "R") {
            if (!bkId) {
                alert("BK ID は必須です");
                return;
            }
            propertyCode = bkId;
        } else if (behavior === "S") {
            if (!bkId) {
                alert("BK ID は必須です");
                return;
            }
            const ok = await isSuumoPreviewOpen(bkId);
            if (!ok) {
                alert(`S-NET プレビュー（bc=${bkId}）を開いてください。`);
                return;
            }
            propertyCode = bkId;
        } else {
            if (!bkId) {
                alert("BK ID は必須です");
                return;
            }
            // 安全側
            propertyCode = bkId;
        }

        showCodeBanner(propertyCode);
        modal.style.display = "none";
        document.querySelectorAll("section.disabled").forEach( (sec) => sec.classList.remove("disabled"));

        // ★ prompt-index に基づき、おすすめポイント（出力ブロック）を並べ替え
        try {
            const idx = await fetchPromptIndexJson(clientId);
            if (idx)
                applyPromptIndexOrderToSuggestionDom(idx);
        } catch (e) {
            console.warn("[prompt-index] apply failed:", e);
        }

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

            initPortalAutoGrow();

            // オートセーブ
            ["property-info", "editable-suggestion", "suumo-catch", "suumo-comment", "athome-comment", "athome-appeal"].forEach( (id) => attachAutoSave(id));
            return;
        }

        // ✅ TYPE-R：Rehouse API を呼び出す
        if (behavior === "R") {
            // TYPE-R でだけ必要。失敗しても空マップで続行できる
            try {
                await loadCommitmentMaster();
            } catch {
                promptMap = {};
            }
            postLog("type-r.begin", "fetch property begin", {
                bk: propertyCode
            });
            try {
                const data = await fetchPropertyData(propertyCode);
                postLog("type-r.fetch", data ? "ok" : "not-found", {
                    hasData: !!data
                });
                if (data) {
                    basePropertyData = data;

                    const memo = document.getElementById("property-info");
                    if (memo) {
                        // ★ より堅牢なメモ生成（空落ち対策）
                        const memoText = generatePropertyMemo(data, promptMap);
                        if (memoText)
                            memo.value = memoText;
                        autoGrow(memo);
                    }

                    const fpUrl = guessFloorplanFromPropertyImages(data) || guessFloorplanUrlFromProperty(data);

                    let roomImages = Array.isArray(data.propertyImages) ? data.propertyImages : [];
                    if (fpUrl)
                        roomImages = [{
                            url: fpUrl,
                            title: "間取り図",
                            desc: "間取り図"
                        }, ...roomImages];

                    // ★ 追加：Type-R 先頭ダブり対策（先頭が間取りで後方に同一があるなら先頭を捨て、重複は後勝ち）
                    roomImages = buildImageQueue_TypeR(roomImages);

                    if (fpUrl) {
                        try {
                            showLoadingSpinner("floorplan");
                            const b64 = await convertUrlToBase64ViaFunctionBase(fpUrl);

                            floorplanPreview.src = "";
                            floorplanPreview.style.display = "none";
                            floorplanPreview.onload = () => {
                                floorplanPreview.style.display = "block";
                                floorplanPreview.style.cursor = "pointer";
                            }
                            ;
                            setTimeout( () => {
                                floorplanPreview.style.display = "block";
                                floorplanPreview.style.cursor = "pointer";
                            }
                            , 200);
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
                postLog("type-r.fetch", "error", {
                    message: String(e?.message || e)
                });
                console.warn("物件データ取得スキップ/失敗:", e);
            }
        }

        // ✅ TYPE-S：S-NETプレビューのDOMを読む
        if (behavior === "S" || CURRENT_BEHAVIOR === "TYPE-S") {
            postLog("type-s.begin", "scrape begin", {
                bk: propertyCode
            });
            await startTypeSFlow(propertyCode);
        }

        // 文字数カウンタ
        setupCharCount("suumo-catch", "suumo-catch-count", 37);
        setupCharCount("suumo-comment", "suumo-comment-count", 300);
        setupCharCount("athome-comment", "athome-comment-count", 100);
        setupCharCount("athome-appeal", "athome-appeal-count", 500);

        initPortalAutoGrow();

        // オートセーブ
        ["property-info", "editable-suggestion", "suumo-catch", "suumo-comment", "athome-comment", "athome-appeal"].forEach( (id) => attachAutoSave(id));
    }
    );

    // DnD バインド
    bindFloorplanDnD();
    bindRoomDnD();

    // PDF DnD/選択
    ["dragenter", "dragover"].forEach( (evt) => pdfDrop.addEventListener(evt, (e) => {
        e.preventDefault();
        pdfDrop.classList.add("highlight");
    }
    ));
    pdfDrop.addEventListener("dragleave", (e) => {
        e.preventDefault();
        pdfDrop.classList.remove("highlight");
    }
    );
    pdfDrop.addEventListener("drop", async (e) => {
        e.preventDefault();
        pdfDrop.classList.remove("highlight");
        const file = e.dataTransfer.files[0];
        if (file?.type === "application/pdf")
            await handlePdfFile(file);
    }
    );
    pdfInput.addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (file?.type === "application/pdf")
            await handlePdfFile(file);
    }
    );

    const pdfToggleBtn = document.getElementById("pdf-toggle");
    if (pdfToggleBtn) {
        pdfToggleBtn.addEventListener("click", () => {
            const area = document.getElementById("pdf-analysis");
            const show = area.style.display === "none";
            area.style.display = show ? "block" : "none";
            pdfToggleBtn.textContent = show ? "▼ 抽出結果を非表示" : "▶ 抽出結果を表示";
        }
        );
    }

    // 間取り図の結果トグル
    floorplanToggle.addEventListener("click", () => {
        const hidden = floorplanAnalysis.style.display === "none";
        floorplanAnalysis.style.display = hidden ? "block" : "none";
        floorplanToggle.textContent = hidden ? "▼ 分析結果を非表示" : "▶ 分析結果を表示";
        if (hidden)
            requestAnimationFrame( () => autoGrow(document.getElementById("floorplan-preview-text")));
    }
    );

    if (typeof updateResetSuggestionBtn === "function")
        updateResetSuggestionBtn();
}
);

/* ==============================
 * 12) 画像→Base64 / URL→Base64
 * ============================== */
function readImageAsBase64(file) {
    return new Promise( (res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = rej;
        r.readAsDataURL(file);
    }
    );
}
async function convertUrlToBase64ViaAPI(imageUrl) {
    const res = await fetch(API.image2base64, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            imageUrl
        }),
    });
    if (!res.ok) {
        const text = await res.text().catch( () => "");
        throw new Error(`Base64変換API失敗 (status=${res.status}) ${text}`);
    }
    const json = await res.json();
    if (!json?.base64)
        throw new Error("Base64変換API応答に base64 がありません");
    return json.base64;
}
async function convertUrlToBase64ViaFunctionBase(imageUrl) {
    return convertUrlToBase64ViaAPI(imageUrl);
}

/* ==============================
 * 13) 間取り図 DnD
 * ============================== */
function bindFloorplanDnD() {
    if (floorplanDrop.dataset.bound)
        return;
    floorplanDrop.dataset.bound = "1";

    ["dragenter", "dragover"].forEach( (evt) => {
        floorplanDrop.addEventListener(evt, (e) => {
            e.preventDefault();
            floorplanDrop.classList.add("highlight");
        }
        );
    }
    );
    floorplanDrop.addEventListener("dragleave", (e) => {
        e.preventDefault();
        floorplanDrop.classList.remove("highlight");
    }
    );
    floorplanDrop.addEventListener("drop", async (e) => {
        e.preventDefault();
        floorplanDrop.classList.remove("highlight");

        const files = [...e.dataTransfer.files].filter( (f) => f.type.startsWith("image/"));
        if (files.length > 0)
            return handleFloorplanFile(files[0]);

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
                    floorplanPreview.onload = () => {
                        floorplanPreview.style.display = "block";
                        floorplanPreview.style.cursor = "pointer";
                    }
                    ;
                    setTimeout( () => {
                        floorplanPreview.style.display = "block";
                        floorplanPreview.style.cursor = "pointer";
                    }
                    , 200);
                    floorplanPreview.src = base64;
                    currentFloorplanBase64 = base64;
                    showNorthSelector();
                } finally {
                    hideLoadingSpinner("floorplan");
                }
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
                }
                ;
                setTimeout( () => {
                    floorplanPreview.style.display = "block";
                    floorplanPreview.style.cursor = "pointer";
                }
                , 200);
                floorplanPreview.src = base64;
                currentFloorplanBase64 = base64;
                showNorthSelector();
            } finally {
                hideLoadingSpinner("floorplan");
            }
            return;
        }

        console.warn("❌ ドロップされた間取り図画像が処理できませんでした");
    }
    );

    floorplanSelect.addEventListener("change", (e) => {
        handleFloorplanFile(e.target.files[0]);
    }
    );
}
async function handleFloorplanFile(file) {
    if (!file || !file.type.startsWith("image/"))
        return;
    showLoadingSpinner("floorplan");
    try {
        floorplanPreview.src = "";
        floorplanPreview.style.display = "none";
        const b64 = await readImageAsBase64(file);
        floorplanPreview.onload = () => {
            floorplanPreview.style.display = "block";
            floorplanPreview.style.cursor = "pointer";
        }
        ;
        setTimeout( () => {
            floorplanPreview.style.display = "block";
            floorplanPreview.style.cursor = "pointer";
        }
        , 200);
        floorplanPreview.src = b64;
        currentFloorplanBase64 = b64;
        showNorthSelector();
    } finally {
        hideLoadingSpinner("floorplan");
    }
}

/* ==============================
 * 14) 部屋写真 DnD
 * ============================== */
function bindRoomDnD() {
    ["dragenter", "dragover"].forEach( (evt) => {
        roomDrop.addEventListener(evt, (e) => {
            e.preventDefault();
            roomDrop.classList.add("highlight");
        }
        );
    }
    );
    roomDrop.addEventListener("dragleave", (e) => {
        e.preventDefault();
        roomDrop.classList.remove("highlight");
    }
    );
    if (!roomDrop.dataset.bound) {
        roomDrop.dataset.bound = "1";
        roomDrop.addEventListener("drop", async (e) => {
            e.preventDefault();
            roomDrop.classList.remove("highlight");

            const files = [...e.dataTransfer.files].filter( (f) => f.type.startsWith("image/"));
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
                    }
                    ;
                    setTimeout( () => {
                        roomPreview.style.display = "block";
                        roomPreview.style.cursor = "pointer";
                    }
                    , 200);
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
                        }
                        ;
                        setTimeout( () => {
                            roomPreview.style.display = "block";
                            roomPreview.style.cursor = "pointer";
                        }
                        , 200);
                        await analyzeRoomPhotoWithGPT(b64, src, "手動分析", "Web画像");
                    } catch (err) {
                        console.error("画像URLからBase64変換に失敗:", err);
                    }
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
                    }
                    ;
                    setTimeout( () => {
                        roomPreview.style.display = "block";
                        roomPreview.style.cursor = "pointer";
                    }
                    , 200);
                    await analyzeRoomPhotoWithGPT(b64, uri, "手動分析", "URIリスト");
                } catch (err) {
                    console.error("URI→Base64失敗:", err);
                }
                return;
            }

            console.warn("❌ ドロップされた画像が処理できませんでした");
        }
        );
    }

    roomSelect.addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (!file || !file.type.startsWith("image/"))
            return;
        await processRoomFile(file);
        roomSelect.value = "";
    }
    );
}
async function processRoomFile(file) {
    roomPreview.src = "";
    roomPreview.style.display = "none";
    const b64 = await readImageAsBase64(file);
    roomPreview.src = b64;
    roomPreview.onload = () => {
        roomPreview.style.display = "block";
        roomPreview.style.cursor = "pointer";
    }
    ;
    setTimeout( () => {
        roomPreview.style.display = "block";
        roomPreview.style.cursor = "pointer";
    }
    , 200);
    const guessedTitle = file.name.replace(/\.[^.]+$/, "");
    await analyzeRoomPhotoWithGPT(b64, null, guessedTitle, null);
}

/* ==============================
 * 15) PDF処理
 * ============================== */
/* === Multipage PDF additions: thumbnails + sequential processing === */
// Globals for multipage PDF
let pdfDocRef = null;
// PDFDocumentProxy
let pdfPageCount = 0;
let pdfCurrentIndex = 0;
// 0-based
let pdfPageSummaries = [];
// [{text, summary, imageBase64}]

// Inject thumbnail styles once
(function injectPdfThumbStyleOnce() {
    if (document.getElementById("texel-pdf-thumb-style"))
        return;
    const style = document.createElement("style");
    style.id = "texel-pdf-thumb-style";
    style.textContent = `
    #pdf-thumbs { display:flex; gap:8px; overflow-x:auto; padding:6px 2px; margin-top:6px; }
#pdf-thumbs .pdf-thumb-wrap { height:118px; min-width:84px; border:2px solid transparent; border-radius:6px; cursor:pointer; flex:0 0 auto; box-shadow:0 1px 3px rgba(0,0,0,.15); background:#fff; display:flex; align-items:center; justify-content:center; }
#pdf-thumbs .pdf-thumb-wrap.active { border-color:#e53935; }
#pdf-thumbs .pdf-thumb { max-width:100%; max-height:100%; width:auto; height:auto; object-fit:contain; display:block; } /* 処理中/選択中を赤枠表示 */
  `;
    document.head.appendChild(style);
}
)();

function ensurePdfThumbsUI() {
    let thumbs = document.getElementById("pdf-thumbs");
    if (!thumbs) {
        thumbs = document.createElement("div");
        thumbs.id = "pdf-thumbs";
        const host = document.getElementById("pdf-drop") || document.body;
        host.insertAdjacentElement("afterend", thumbs);
    }
    return thumbs;
}

function setActivePdfThumb(index) {
    const thumbs = document.getElementById("pdf-thumbs");
    if (!thumbs)
        return;
    [...thumbs.querySelectorAll(".pdf-thumb-wrap")].forEach( (wrap, i) => {
        wrap.classList.toggle("active", i === index);
    }
    );
}

function clearActivePdfThumb() {
    const thumbs = document.getElementById("pdf-thumbs");
    if (!thumbs)
        return;
    [...thumbs.querySelectorAll(".pdf-thumb-wrap")].forEach( (wrap) => wrap.classList.remove("active"));
}

// Render large page preview into #pdf-image-preview; returns base64
async function renderMainPdfPage(index) {
    if (!window.pdfjsLib || !pdfDocRef)
        return "";
    const page = await pdfDocRef.getPage(index + 1);
    const viewport = page.getViewport({
        scale: 3
    });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({
        canvasContext: canvas.getContext("2d"),
        viewport
    }).promise;
    const base64 = canvas.toDataURL("image/png");
    const pdfImagePreview = document.getElementById("pdf-image-preview");
    if (pdfImagePreview) {
        pdfImagePreview.src = base64;
        pdfImagePreview.style.display = "block";
        pdfImagePreview.style.cursor = "pointer";
    }
    latestPdfThumbnailBase64 = base64;
    return base64;
}

// Build page thumbnails for all pages
async function renderPdfThumbnails() {
    if (!window.pdfjsLib || !pdfDocRef)
        return;
    const thumbs = ensurePdfThumbsUI();
    thumbs.innerHTML = "";
    for (let i = 0; i < pdfPageCount; i++) {
        const page = await pdfDocRef.getPage(i + 1);
        const viewport = page.getViewport({
            scale: 0.5
        });
        const c = document.createElement("canvas");
        c.width = viewport.width;
        c.height = viewport.height;
        await page.render({
            canvasContext: c.getContext("2d"),
            viewport
        }).promise;

        const wrap = document.createElement("div");
        wrap.className = "pdf-thumb-wrap";
        wrap.dataset.index = String(i);

        const img = document.createElement("img");
        img.src = c.toDataURL("image/png");
        img.className = "pdf-thumb";
        img.alt = `Page ${i + 1}`;

        wrap.appendChild(img);

        wrap.addEventListener("click", async () => {
            const idx = Number(wrap.dataset.index);
            pdfCurrentIndex = idx;
            setActivePdfThumb(idx);
            showLoadingSpinner("pdf");
            try {
                await renderMainPdfPage(idx);
            } finally {
                hideLoadingSpinner("pdf");
            }
        }
        );

        thumbs.appendChild(wrap);
    }
    setActivePdfThumb(pdfCurrentIndex);
}
async function extractAndSummarizePage(index, mainImageBase64) {
    if (!window.pdfjsLib || !pdfDocRef)
        return;
    const page = await pdfDocRef.getPage(index + 1);

    let hasTextLayer = false
      , hasImageLayer = true;
    try {
        const ops = await page.getOperatorList();
        hasTextLayer = ops.fnArray.includes(pdfjsLib.OPS.showText);
        hasImageLayer = ops.fnArray.includes(pdfjsLib.OPS.paintImageXObject) || ops.fnArray.includes(pdfjsLib.OPS.paintJpegXObject);
    } catch {}

    let extractedText = "";
    if (hasTextLayer) {
        try {
            const textContent = await page.getTextContent();
            extractedText = textContent.items.map(i => i.str).join("\\n").trim();
        } catch {}
    }

    const promptObj = await getPromptObj("pdfImage", P.pdfImage);
    const summaryPrompt = promptObj.prompt || "";
    const params = promptObj.params || {};

    const messages = [{
        role: "system",
        content: summaryPrompt
    }];
    if (extractedText)
        messages.push({
            role: "user",
            content: extractedText
        });
    if (hasImageLayer && mainImageBase64) {
        messages.push({
            role: "user",
            content: [{
                type: "image_url",
                image_url: {
                    url: mainImageBase64
                }
            }]
        });
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
    const summarized = result?.choices?.[0]?.message?.content || "(要約なし)";

    pdfPageSummaries[index] = {
        text: extractedText,
        summary: summarized,
        imageBase64: mainImageBase64
    };

    const parts = pdfPageSummaries.map( (p, i) => {
        if (!p)
            return null;
        const header = `【Page ${i + 1}】`;
        const tex = p.text ? `\\n【テキスト抽出】\\n${p.text}\\n` : "";
        const sum = `\\n【GPT要約】\\n${p.summary}\\n`;
        return header + tex + sum;
    }
    ).filter(Boolean);

    const combined = parts.join("\\n");
    const outBox = document.getElementById("pdf-preview");
    if (outBox) {
        if ("value"in outBox) {
            outBox.value = combined;
            autoGrow(outBox);
        } else {
            outBox.textContent = combined;
        }
    }
    latestPdfExtractedText = combined;

    const memoArea = document.getElementById("property-info");
    if (memoArea) {
        memoArea.value += `\\n${summarized}`;
        autoGrow(memoArea);
    }

    await saveExportJson();
}
/* === End of multipage additions === */

async function handlePdfFile(file) {
    showLoadingSpinner("pdf");
    const reader = new FileReader();
    reader.onload = async () => {
        try {
            const typedarray = new Uint8Array(reader.result);
            if (!window.pdfjsLib)
                throw new Error("pdfjsLib not loaded");
            // 1) Open PDF
            pdfDocRef = await pdfjsLib.getDocument({
                data: typedarray,
                disableWorker: true
            }).promise;
            pdfPageCount = pdfDocRef.numPages;
            pdfCurrentIndex = 0;
            pdfPageSummaries = new Array(pdfPageCount).fill(null);

            // 2) Render thumbnails
            await renderPdfThumbnails();

            // 3) Reset analysis accordion (if exists)
            const pdfAnalysis = document.getElementById("pdf-analysis");
            const pdfToggle = document.getElementById("pdf-toggle");
            if (pdfAnalysis)
                pdfAnalysis.style.display = "none";
            if (pdfToggle)
                pdfToggle.textContent = "▶ 抽出結果を表示";

            // 4) Process sequentially page by page
            for (let i = 0; i < pdfPageCount; i++) {
                pdfCurrentIndex = i;
                setActivePdfThumb(i);
                const mainB64 = await renderMainPdfPage(i);
                await extractAndSummarizePage(i, mainB64);
            }

            clearActivePdfThumb();
            postLog("pdf", "summarized-multipage", {
                pages: pdfPageCount
            });
        } catch (err) {
            console.error("PDF読み込みエラー:", err);
            const outBox = document.getElementById("pdf-preview");
            if (outBox) {
                if ("value"in outBox) {
                    outBox.value = "PDF読み取り中にエラーが発生しました。";
                    autoGrow(outBox);
                } else {
                    outBox.textContent = "PDF読み取り中にエラーが発生しました。";
                }
            }
        } finally {
            hideLoadingSpinner("pdf");
        }
    }
    ;
    reader.readAsArrayBuffer(file);
}

/* ==============================
 * 16) 間取り図解析（GPT）
 * ============================== */
async function analyzeFloorplanWithGPT(base64Image, northVector) {
    postLog("floorplan", "begin", {
        northVector
    });
    const previewText = document.getElementById("floorplan-preview-text");
    try {
        showLoadingSpinner("floorplan");
        const promptObj = await getPromptObj("floorplan", P.floorplan);
        let systemPromptBase = promptObj.prompt || "これは不動産の間取り図です。内容を読み取り、わかりやすく要約してください。";
        const params = promptObj.params || {};

        const codeText = `\n物件コードは「${propertyCode}」です。`;
        const northText = `\n間取り図の北方向（northVector）は「${northVector}」です。`;
        const memoText = document.getElementById("property-info")?.value.trim() || "";
        const fullSystemPrompt = `${systemPromptBase}${codeText}${northText}\n\n--- AI参照用物件メモ ---\n${memoText}`;

        const body = {
            messages: [{
                role: "system",
                content: fullSystemPrompt
            }, {
                role: "user",
                content: [{
                    type: "image_url",
                    image_url: {
                        url: base64Image
                    }
                }]
            }],
            temperature: params.temperature ?? 0.3,
            max_tokens: params.max_tokens ?? 4000,
            top_p: params.top_p,
            frequency_penalty: params.frequency_penalty,
            presence_penalty: params.presence_penalty,
            purpose: "floorplan"
        };

        const result = await callGPT(body);
        const comment = result.choices?.[0]?.message?.content || "";
        floorplanAnalysisResult = comment;
        previewText.value = comment;
        updateGenerateButtonLabel();
        document.getElementById("floorplan-analysis").style.display = "none";
        requestAnimationFrame( () => autoGrow(previewText));
        floorplanToggle.textContent = "▶ 分析結果を表示";
        postLog("floorplan", "ok", {
            length: (comment || "").length
        });
    } catch (err) {
        postLog("floorplan", "error", {
            message: String(err?.message || err)
        });
        console.error("❌ GPT呼び出しエラー:", err);
        floorplanAnalysisResult = "";
    } finally {
        hideLoadingSpinner("floorplan");
        hideNorthSelector();
        // ★ 解析完了後に赤枠UIを確実に閉じる
        if (floorplanAnalysisResult)
            await saveExportJson();
    }
}

/* ==============================
 * 17) 部屋写真解析（GPT）
 * ============================== */
function buildRoomPhotoPrompt(base, roomType, description, past=[], isRetry=false) {
    const memoText = document.getElementById("property-info")?.value.trim() || "";
    const fpText = document.getElementById("floorplan-preview-text")?.value.trim() || "";
    const hintPrev = past?.length ? `\n\n--- 直前の出力（参考・反省点） ---\n${past.join("\n\n")}` : "";
    const retryNote = isRetry ? "\n\n（注：前回と異なる切り口で、しかし事実に限定して出力）" : "";
    const head = `${base}\n写真の種類: ${roomType || "未指定"}\n補足: ${description || "-"}\n物件コード: ${propertyCode}\n\n--- 間取り図の要約 ---\n${fpText}\n\n--- AI参照用物件メモ ---\n${memoText}${hintPrev}${retryNote}`;
    return head;
}
async function analyzeRoomPhotoWithGPT(base64Image, imageSrc=null, roomType=null, description=null, pastComments=[], isRetry=false, insertAfter=null) {
    postLog(isRetry ? "photo-regenerate" : "photo", "begin", {
        src: imageSrc ? String(imageSrc).slice(0, 180) : "base64",
        roomType,
        description
    });
    const ta = document.getElementById("analysis-result");
    showLoadingSpinner("room");
    try {
        const promptObj = await getPromptObj("roomphoto", P.roomphoto);
        const basePrompt = promptObj.prompt || "";
        const params = promptObj.params || {};
        const temperature = isRetry ? 0.7 : (params.temperature ?? 0.3);
        const top_p = isRetry ? 0.95 : params.top_p;

        const combinedPrompt = buildRoomPhotoPrompt(basePrompt, roomType, description, pastComments, isRetry);

        const body = {
            messages: [{
                role: "system",
                content: combinedPrompt
            }, {
                role: "user",
                content: [{
                    type: "image_url",
                    image_url: {
                        url: base64Image
                    }
                }]
            }],
            temperature,
            top_p,
            max_tokens: params.max_tokens ?? 4000,
            frequency_penalty: params.frequency_penalty,
            presence_penalty: params.presence_penalty,
            purpose: isRetry ? "photo-regenerate" : "photo"
        };

        const result = await callGPT(body);
        const comment = result?.choices?.[0]?.message?.content?.trim();
        if (!comment)
            throw new Error("GPT 応答が空");

        await addToHistory(imageSrc || base64Image, comment, roomType, description, insertAfter);
        hasRoomAnalysis = true;
        updateGenerateButtonLabel();
        postLog(isRetry ? "photo-regenerate" : "photo", "ok", {
            length: (comment || "").length
        });
    } catch (err) {
        postLog(isRetry ? "photo-regenerate" : "photo", "error", {
            message: String(err?.message || err)
        });
        console.error("❌ 画像コメント生成エラー:", err);
        if (!isRetry && ta) {
            ta.textContent = "解析に失敗しました。";
            ta.style.display = "block";
        }
    } finally {
        hideLoadingSpinner("room");
        saveExportJson().catch( () => {}
        );
    }

    if (!isRetry && ta) {
        ta.textContent = "";
        ta.style.display = "none";
    }
}

/* ==============================
 * 18) 履歴追加
 * ============================== */
async function addToHistory(imageSrc, commentText, roomType="", description="", insertAfter=null) {
    if (!commentText.trim() || !imageSrc || imageSrc.startsWith("chrome-extension://"))
        return;

    const wrapper = document.createElement("div");
    wrapper.className = "drop-zone";
    wrapper.style.position = "relative";
    wrapper.dataset.roomType = roomType;
    wrapper.dataset.description = description;

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "×";
    closeBtn.style.cssText = "position:absolute;top:0;right:0;background:transparent;border:none;color:#999;font-size:16px;cursor:pointer;padding:4px;z-index:10;";
    closeBtn.onclick = async () => {
        wrapper.remove();
        updateRoomAnalysisStatus();
        await saveExportJson();
    }
    ;

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
        navigator.clipboard.writeText(textarea.value.trim()).then( () => showCopyNotification("クリップボードへコピーしました")).catch( () => showCopyNotification("コピーに失敗しました"));
    }
    ;

    const counter = document.createElement("span");
    counter.style.cssText = "font-size:12px;color:#555;justify-self:end;";

    toolRow.append(regenBtn, copyBtn, counter);
    commentArea.append(textarea, toolRow);

    regenBtn.onclick = async () => {
        regenBtn.setAttribute("aria-busy", "true");
        regenBtn.disabled = true;
        regenBtn.classList.add("spin");
        try {
            await analyzeRoomPhotoWithGPT(imageSrc, imageSrc, wrapper.dataset.roomType ?? "", wrapper.dataset.description ?? "", [textarea.value], true, wrapper);
        } finally {
            regenBtn.classList.remove("spin");
            regenBtn.disabled = false;
            regenBtn.removeAttribute("aria-busy");
        }
    }
    ;

    const updateCount = () => {
        const len = textarea.value.replace(/\r\n/g, "\n").length;
        counter.textContent = `${len}`;
    }
    ;
    textarea.addEventListener("input", () => {
        autoGrow(textarea);
        updateCount();
        autosaveDebounced();
    }
    );
    updateCount();

    toggle.onclick = () => {
        const hidden = textarea.style.display === "none";
        textarea.style.display = hidden ? "block" : "none";
        toolRow.style.display = hidden ? "grid" : "none";
        toggle.textContent = hidden ? "▼ 生成コメントを非表示" : "▶ 生成コメントを表示";
    }
    ;

    wrapper.append(closeBtn, img, toggle, commentArea);
    // ---- Drag & Drop reordering for history cards ----
    wrapper.draggable = true;
    wrapper.addEventListener("dragstart", (e) => {
        wrapper.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
    }
    );
    wrapper.addEventListener("dragend", async () => {
        wrapper.classList.remove("dragging");
        updateRoomAnalysisStatus();
        await saveExportJson().catch( () => {}
        );
    }
    );
    historyContainer.addEventListener("dragover", (e) => {
        e.preventDefault();
        const afterEl = ( () => {
            const siblings = [...historyContainer.querySelectorAll(".drop-zone:not(.dragging)")];
            const y = e.clientY;
            let candidate = null;
            for (const sib of siblings) {
                const box = sib.getBoundingClientRect();
                const offset = y - (box.top + box.height / 2);
                if (offset > 0)
                    candidate = sib;
            }
            return candidate;
        }
        )();
        const dragging = historyContainer.querySelector(".drop-zone.dragging");
        if (!dragging)
            return;
        if (afterEl)
            afterEl.after(dragging);
        else
            historyContainer.prepend(dragging);
    }
    );

    if (insertAfter)
        insertAfter.after(wrapper);
    else
        historyContainer.appendChild(wrapper);

    requestAnimationFrame( () => autoGrow(textarea));

    roomPreview.src = "";
    roomPreview.style.display = "none";
    updateRoomAnalysisStatus();

    await saveExportJson();
}

/* ==============================
 * 19) 共通ユーティリティ
 * ============================== */
function autoGrow(el, minH=60) {
    if (!el)
        return;

    const cs = getComputedStyle(el);
    const min = Math.max(minH, parseFloat(cs.minHeight) || 0);

    // ★空欄は“必ず”最小高さに戻す（初期デカさ問題の根治）
    if (!String(el.value || "").trim()) {
        el.style.height = min + "px";
        return;
    }

    // ★測定前に一旦自動へ（0pxより安定）
    el.style.height = "auto";
    el.style.height = Math.max(el.scrollHeight, min) + "px";
}

function initPortalAutoGrow() {
    const defs = [{
        id: "suumo-catch",
        minH: 64
    }, {
        id: "suumo-comment",
        minH: 120
    }, {
        id: "athome-comment",
        minH: 80
    }, // スタッフコメント(100)として使っている想定
    {
        id: "athome-appeal",
        minH: 140
    }, ];

    defs.forEach( ({id, minH}) => {
        const ta = document.getElementById(id);
        if (!ta)
            return;

        // ★ ここが重要：過去の手動リサイズ等で入った inline height を必ず消す
        ta.style.height = "";
        ta.style.overflowY = "hidden";

        // 入力のたびに伸縮
        ta.addEventListener("input", () => autoGrow(ta, minH));

        // 起動直後にも一度反映（初期状態を“小さく”確定させる）
        requestAnimationFrame( () => autoGrow(ta, minH));
    }
    );
}

function initAutoGrowTextareas() {
    ["suumo-catch", "suumo-comment", "athome-comment", "athome-appeal"].forEach(id => {
        const el = document.getElementById(id);
        if (!el)
            return;

        el.classList.add("auto-grow");

        el.addEventListener("input", () => autoGrow(el));

        // 初期表示・再生成時対策
        el.style.height = "";
        autoGrow(el);
    }
    );
}

function updateGenerateButtonLabel() {
    const available = !!floorplanAnalysisResult;
    generateButton.disabled = !available;
    generateButton.textContent = hasRoomAnalysis ? "間取図と画像から生成" : "間取図から生成";
}
function updateRoomAnalysisStatus() {
    hasRoomAnalysis = [...historyContainer.querySelectorAll(".drop-zone")].some( (w) => w.querySelector("textarea")?.value.trim());
    updateGenerateButtonLabel();
}
function showCopyNotification(message="クリップボードへコピーしました") {
    const note = document.createElement("div");
    note.textContent = message;
    note.style.cssText = `position: fixed; bottom: 10%; left: 50%; transform: translateX(-50%);
    background: #333; color: #fff; padding: 8px 16px; border-radius: 6px; font-size: 13px;
    min-width: 260px; text-align: center; opacity: 0; transition: opacity .3s ease; z-index: 9999;`;
    document.body.appendChild(note);
    requestAnimationFrame( () => (note.style.opacity = "1"));
    setTimeout( () => {
        note.style.opacity = "0";
        note.addEventListener("transitionend", () => note.remove());
    }
    , 2000);
}
function showCodeBanner(codeText) {
    const banner = document.getElementById("code-banner");
    if (!banner)
        return;
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
    if (!overlay || !popupImg)
        return;
    document.body.addEventListener("click", (e) => {
        if (e.target.tagName === "IMG" && (e.target.closest(".drop-zone") || e.target.id === "floorplan-preview" || e.target.id === "pdf-image-preview")) {
            const src = e.target.src;
            if (src) {
                popupImg.src = src;
                overlay.style.display = "flex";
            }
        }
    }
    );
    overlay.addEventListener("click", () => {
        overlay.style.display = "none";
        popupImg.src = "";
    }
    );
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            overlay.style.display = "none";
            popupImg.src = "";
        }
    }
    );
}

/* --- スピナーCSS注入 --- */
(function injectSpinnerStyleOnce() {
    if (document.getElementById("texel-spinner-style"))
        return;
    const style = document.createElement("style");
    style.id = "texel-spinner-style";
    style.textContent = `
    @keyframes texel-rotate { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .texel-regenerate-btn { display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px; border-radius:6px; transform-origin:50% 50%; user-select:none; }
    .texel-regenerate-btn.spin { animation: texel-rotate 0.9s linear infinite; }
    .texel-regenerate-btn[aria-busy="true"] { opacity: .7; cursor: progress; }
  `;
    document.head.appendChild(style);
}
)();

/* ==============================
 * 20) 方位UI → 間取り解析起動
 * ============================== */
function showNorthSelector() {
    const wrap = document.getElementById("northSelectorWrap");
    if (!wrap)
        return;
    wrap.style.display = "grid";
    wrap.dataset.active = "1";
}
function hideNorthSelector() {
    const wrap = document.getElementById("northSelectorWrap");
    if (!wrap)
        return;
    wrap.style.display = "none";
    wrap.dataset.active = "0";
    wrap.classList.remove("highlight", "danger", "error", "red");
}

async function onConfirmNorth() {
    const sel = document.getElementById("northVectorSelect");
    const north = (sel?.value || "up").trim();

    // ---- Fallbacks: try to recover a base64 image if currentFloorplanBase64 is empty ----
    if (!currentFloorplanBase64) {
        const hidden = document.getElementById("floorplan-base64");
        const preview = document.getElementById("floorplan-preview");
        const pdfImg = document.getElementById("pdf-image-preview");

        // 1) hidden input
        if (hidden && /^data:image\//.test(hidden.value || ""))
            currentFloorplanBase64 = hidden.value;

        // 2) preview <img>
        if (!currentFloorplanBase64 && preview && /^data:image\//.test(preview.src || ""))
            currentFloorplanBase64 = preview.src;

        // 3) PDFセクションの大きいプレビュー
        if (!currentFloorplanBase64 && pdfImg && /^data:image\//.test(pdfImg.src || ""))
            currentFloorplanBase64 = pdfImg.src;

        // 4) PDFのサマリ配列（最初のページでもOK）
        try {
            if (!currentFloorplanBase64 && Array.isArray(pdfPageSummaries)) {
                const first = pdfPageSummaries.find(p => p && /^data:image\//.test(p.imageBase64 || ""));
                if (first)
                    currentFloorplanBase64 = first.imageBase64;
            }
        } catch {}

        // 5) サムネDOMから拾う（pdf-thumbsの先頭）
        try {
            if (!currentFloorplanBase64) {
                const firstThumb = document.querySelector("#pdf-thumbs .pdf-thumb");
                if (firstThumb && /^data:image\//.test(firstThumb.src || ""))
                    currentFloorplanBase64 = firstThumb.src;
            }
        } catch {}
    }

    if (!currentFloorplanBase64) {
        alert("間取り図画像がありません。");
        return;
    }

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

    // 3) おすすめポイント＋ポータル4種の生成（ボタン押下ルートと完全統一）
    //    BASE は自動生成しない／TYPE-R 等は onGenerateSuggestions()（ボタンと同じ）を呼ぶ
    if (CURRENT_BEHAVIOR !== "BASE") {
        // ★ null を渡さない（onGenerateSuggestions の引数はオブジェクト想定）
        await onGenerateSuggestions();
    }

    hideNorthSelector();

    // BASE のみ保存（TYPE-R 等は onGenerateSuggestions() 側で saveExportJson 済み）
    if (CURRENT_BEHAVIOR === "BASE") {
        await saveExportJson();
    }
}

/* ==============================
 * 21) GPT / Rehouse API / Save / 文字数など
 * ============================== */
async function callGPT(body) {
    // ログ基盤と整合させるため spreadsheetId など識別情報を付帯
    const payload = {
        ...body,
        spreadsheetId: LOG_SPREADSHEET_ID,
        sheetIdForGPT: LOG_SPREADSHEET_ID,
        clientId,
        propertyCode,
        userId,
    };
    return analyzeWithGPT(payload);
}

/* --- Rehouse 物件取得（作業前と同じ“直叩き”一本化） --- */
async function fetchPropertyData(codeOrBk) {
    const bk = String(codeOrBk || "").trim();
    if (!bk)
        throw new Error("BK/物件コードが空です");

    const url = `https://www.rehouse.co.jp/rehouse-api/api/v1/salesProperties/${encodeURIComponent(bk)}`;
    console.info("[Texel] Rehouse (direct):", url);

    const res = await fetch(url, {
        cache: "no-cache"
    });
    if (res.ok)
        return await res.json();
    if (res.status === 404) {
        console.info("[Texel] Rehouse 直叩き: 404（該当なし）");
        return null;
    }
    throw new Error(`Rehouse API 取得失敗: ${res.status} ${res.statusText}`);
}

/* --- 物件メモ生成（commitment-master を反映） --- */
// Rehouseレスポンスの構造差異に強い堅牢版
/** 物件 JSON から「AI参照用メモ」を生成（SnapVoice準拠） */
function generatePropertyMemo(data, commitmentMaster={}) {
    if (!data)
        return "";

    const uniq = (arr) => [...new Set(arr)];
    const line = (label, v) => `${label}：${v}`;
    const sqm2Tsubo = (v) => {
        const tsubo = Math.floor(v * 0.3025 * 100) / 100;
        return `${v}㎡（約${tsubo.toFixed(2)}坪）`;
    }
    ;
    const dirJP = {
        N: "北",
        S: "南",
        E: "東",
        W: "西",
        NE: "北東",
        NW: "北西",
        SE: "南東",
        SW: "南西"
    };
    const roadJP = {
        PB: "公道",
        PR: "私道",
        PV: "私道"
    };

    // 分類・住所・基本項目
    const propertyTypeLabel = resolvePropertyTypeFromItem(data.propertyItem);
    const category = classifyPropertyType(data.propertyItem);
    const address = `${data.prefecture?.name || ""}${data.city?.name || ""}${data.town?.name || ""}`;

    // 交通
    const access = (data.transportations || []).map(t => {
        const ln = t.railway?.name || "";
        const st = t.station?.name || "駅名不明";
        if (t.accessMinutes != null)
            return `${ln}${st}駅 徒歩${t.accessMinutes}分`;
        if (t.busStopName && t.busRidingMinutes != null && t.busAccessMinutes != null)
            return `${ln}${st}駅 バス${t.busRidingMinutes}分「${t.busStopName}」停歩${t.busAccessMinutes}分`;
        return null;
    }
    ).filter(Boolean).join("、") || "交通情報なし";

    // 面積・間取り・築年など
    const exclusiveArea = data.exclusiveArea ? sqm2Tsubo(data.exclusiveArea) : null;
    const landArea = data.landArea ? sqm2Tsubo(data.landArea) : null;
    const buildingArea = data.grossFloorArea ? sqm2Tsubo(data.grossFloorArea) : null;
    const floorPlan = data.floorPlanText || `${data.roomCount ?? ""}LDK`;
    const built = data.builtYearMonth ? (data.builtYearMonth.replace("-", "年") + "月築") : null;
    const floorInfo = data.floorNumber ? `${data.floorNumber}階 / 地上${data.story || "?"}階` + (data.undergroundStory ? ` 地下${data.undergroundStory}階建` : "") : null;
    const balconyDir = dirJP[data.balconyDirection] || data.balconyDirection || null;

    // 接道
    let roadLine = null;
    if (Array.isArray(data.connectingRoads) && data.connectingRoads.length) {
        const roads = data.connectingRoads.map(r => {
            const d = dirJP[r.direction] || r.direction || "";
            const w = r.width != null ? `約${parseFloat(r.width).toFixed(1)}m` : "";
            const rt = roadJP[r.roadType] || r.roadType || "";
            return [d && `${d}側`, w, rt].filter(Boolean).join(" ").trim();
        }
        ).filter(Boolean);
        const uniqRoads = uniq(roads);
        roadLine = uniqRoads.join("／");
        if (uniqRoads.length >= 2)
            roadLine += "（角地）";
    }

    // 建ぺい率／容積率
    let bcrFarLine = null;
    const lr = data.landInformation?.landRestrictions?.[0];
    if (lr) {
        const conv = v => (v < 1) ? v * 100 : (v < 10 && Number.isInteger(v)) ? v * 100 : v;
        const bcr = lr.buildingCoverageRatio != null ? conv(lr.buildingCoverageRatio) : null;
        const far = lr.floorAreaRatio != null ? conv(lr.floorAreaRatio) : null;
        if (bcr != null && far != null)
            bcrFarLine = `${Math.round(bcr)}%／${Math.round(far)}%`;
    }

    // ① 基本情報
    const L = ["■ 物件の基本情報", line("物件種別", propertyTypeLabel), line("価格", `${(data.price).toLocaleString()}万円`), line("所在地", address), line("交通", access), ];

    // ② カテゴリー別
    switch (category) {
    case "mansion":
        if (exclusiveArea)
            L.push(line("専有面積", exclusiveArea));
        if (floorPlan)
            L.push(line("間取り", floorPlan));
        if (built)
            L.push(line("築年月", built));
        if (floorInfo)
            L.push(line("階数", floorInfo));
        if (balconyDir)
            L.push(line("向き", balconyDir));
        break;
    case "house":
        if (landArea)
            L.push(line("土地面積", landArea));
        if (buildingArea)
            L.push(line("建物面積", buildingArea));
        if (floorPlan)
            L.push(line("間取り", floorPlan));
        if (built)
            L.push(line("築年月", built));
        break;
    case "land":
        if (landArea)
            L.push(line("土地面積", landArea));
        break;
    default:
        if (landArea)
            L.push(line("土地面積", landArea));
        if (buildingArea)
            L.push(line("建物面積", buildingArea));
        if (exclusiveArea)
            L.push(line("専有面積", exclusiveArea));
    }

    // 共通追加
    if (roadLine)
        L.push(line("接道状況", roadLine));
    if (bcrFarLine)
        L.push(line("建ぺい率／容積率", bcrFarLine));

    // ③ 特徴・備考（commitmentMaster でコード→ラベル解決）
    const commitments = (data.commitmentInformations || []).map(info => {
        const code = String(info.commitmentCode ?? info.code ?? "");
        const name = info.name || commitmentMaster[code] || "";
        if (!name || /使用料|円|費|管理費|修繕/.test(name))
            return null;
        const suf = info.distance != null ? (info.distance >= 50 ? "m" : "円") : "";
        return `・${name}${info.distance != null ? `（約${info.distance}${suf}）` : ""}`;
    }
    ).filter(Boolean);

    const remarks = (data.recommendedInfo || "").split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 1).map(s => `・${s.replace(/^○|^〇/, "")}`);

    if (commitments.length) {
        L.push("", "■ 特徴・設備・条件など", ...uniq(commitments));
    }
    if (remarks.length) {
        L.push("", "■ 担当者記載", ...uniq(remarks));
    }

    // ④ リフォーム
    if ((data.renovationInfos || []).length) {
        const reno = data.renovationInfos.map(r => {
            const d = r.renovationYearMonth ? r.renovationYearMonth.replace("-", "年") + "月" : "";
            return `・${r.renovationPoint}${d ? `（${d}実施）` : ""}`;
        }
        );
        L.push("", "■ リフォーム情報", ...uniq(reno));
    }

    return L.join("\n");
}

// S-NET の /resizeImage? ... &w=XXX を指定幅にそろえる
function suumoResizeWidth(url, width=500) {
    try {
        const u = new URL(url,location.origin);
        if (/\/resizeImage/i.test(u.pathname)) {
            u.searchParams.set("w", String(width));
            // 高さ指定があると縦横が固定されて縮むケースがあるので削除（幅優先）
            if (u.searchParams.has("h"))
                u.searchParams.delete("h");
            return u.href;
        }
        return url;
    } catch {
        return url;
    }
}

/* SnapVoice 準拠の型判定ヘルパー（Texel に無ければ追加） */
function classifyPropertyType(item) {
    const mansion = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12", "98"];
    const house = ["14", "15", "20", "21", "23", "24"];
    const land = ["33", "34", "35"];
    if (mansion.includes(item))
        return "mansion";
    if (house.includes(item))
        return "house";
    if (land.includes(item))
        return "land";
    return "other";
}
function resolvePropertyTypeFromItem(item) {
    const map = {
        "14": "新築戸建",
        "15": "中古戸建",
        "20": "新築テラスハウス",
        "21": "中古テラスハウス",
        "01": "新築マンション",
        "02": "中古マンション",
        "03": "新築公団",
        "04": "中古公団",
        "05": "新築公社",
        "06": "中古公社",
        "07": "新築タウンハウス",
        "08": "中古タウンハウス",
        "09": "リゾートマンション（区分所有）",
        "10": "店舗（区分所有）",
        "11": "事務所（区分所有）",
        "12": "店舗・事務所（区分所有）",
        "98": "その他（区分所有）",
        "22": "店舗（一棟）",
        "23": "店舗付住宅",
        "24": "住居付店舗",
        "25": "事務所（一棟）",
        "26": "店舗・事務所（一棟）",
        "16": "ビル",
        "27": "工場",
        "17": "マンション一括",
        "28": "倉庫",
        "19": "アパート一括",
        "29": "寮",
        "30": "旅館",
        "31": "ホテル",
        "32": "別荘",
        "18": "リゾートマンション（一棟）",
        "99": "その他（一棟）",
        "33": "売地",
        "34": "借地権",
        "35": "底地権"
    };
    return map[item] || "物件種別不明";
}

/* --- 物件の部屋画像を順次解析（自動投入） --- */
async function analyzeRoomImagesSequentially(images) {
    for (const img of images) {
        const url = img?.url || img;
        if (!url)
            continue;
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
    const sheetSaveUrl = (typeof SHEET_API === "string" && SHEET_API) || (SHEET_API && typeof SHEET_API.save === "string" && SHEET_API.save) || "";

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
            headers: {
                "Content-Type": "text/plain;charset=utf-8"
            },
            body: JSON.stringify(body)
        });
        console.info("📤 Sheet save posted (no-cors).");
        postLog("save", "posted", {
            roomComments: (payload?.roomComments || []).length
        });
    } catch (err) {
        postLog("save", "error", {
            message: String(err?.message || err)
        });
        console.error("❌ sheet save failed", err);
    }
}

/* --- 文字数カウンタ --- */
function setupCharCount(textareaId, counterId, limit) {
    const ta = document.getElementById(textareaId);
    const cn = document.getElementById(counterId);
    if (!ta || !cn)
        return;
    const update = () => {
        const len = (ta.value || "").replace(/\r\n/g, "\n").length;
        cn.textContent = `${len}/${limit}`;
        cn.style.color = len > limit ? "#c00" : "#555";
    }
    ;
    ta.addEventListener("input", () => {
        update();
        autosaveDebounced();
    }
    );
    update();
}

/* --- オートセーブ（入力にフック） --- */
function attachAutoSave(id) {
    const el = document.getElementById(id);
    if (!el)
        return;
    el.addEventListener("input", autosaveDebounced);
}

/* ==============================
 * 21b) Logs 出力ユーティリティ
 * ============================== */
function postLog(purpose, detail="", extra={}) {
    try {
        const url = (typeof GAS_LOG_ENDPOINT === "string" && GAS_LOG_ENDPOINT) || (GAS_LOG_ENDPOINT && GAS_LOG_ENDPOINT.url) || "";
        if (!url || !/^https?:\/\//i.test(url)) {
            console.info("ℹ️ GAS_LOG_ENDPOINT 未設定につきログ送信スキップ:", purpose, detail);
            return;
        }

        const payload = {
            purpose,
            // 例: 'start', 'type-r.fetch', 'photo', 'suggestion', etc.
            detail,
            // 例: 'TYPE-R begin', 'scrape ok', 'field=suumo-comment'
            timestamp: new Date().toISOString(),
            // 識別情報（ログは常に Logs 用スプレッドシートへ）
            sheetIdForGPT: LOG_SPREADSHEET_ID,
            spreadsheetId: LOG_SPREADSHEET_ID,
            clientId,
            propertyCode,
            userId,
            // 任意の付加情報
            extra
        };

        // プリフライト回避（no-cors / text/plain）
        fetch(url, {
            method: "POST",
            mode: "no-cors",
            headers: {
                "Content-Type": "text/plain;charset=utf-8"
            },
            body: JSON.stringify(payload)
        }).catch( () => {}
        );
    } catch (e) {
        console.warn("log post skipped:", e?.message || e);
    }
}

/* ==============================
 * 22) おすすめ生成 / 要約 / 元に戻す
 *    - おすすめ + ポータル4種は「内部チャット（会話履歴）で連続生成」できるようにする
 *    - 各ステップで system+user+assistant を messages に積み上げる
 * ============================== */

const SUGGEST_FLOW = {
    active: false,
    messages: [],
    lastOutputs: {
        suggestion: "",
        "suumo-catch": "",
        "suumo-comment": "",
        "athome-comment": "",
        "athome-appeal": ""
    }
};

function resetSuggestFlow() {
    SUGGEST_FLOW.active = true;
    SUGGEST_FLOW.messages = [];
    SUGGEST_FLOW.lastOutputs = {
        suggestion: "",
        "suumo-catch": "",
        "suumo-comment": "",
        "athome-comment": "",
        "athome-appeal": ""
    };
}

function normalizeGptText(res) {
    if (res == null)
        return "";
    if (typeof res === "string")
        return res;
    if (typeof res.text === "string")
        return res.text;
    if (typeof res.content === "string")
        return res.content;
    if (typeof res.output === "string")
        return res.output;
    if (typeof res.result === "string")
        return res.result;
    const c0 = res.choices?.[0];
    if (typeof c0?.message?.content === "string")
        return c0.message.content;
    if (typeof c0?.text === "string")
        return c0.text;
    try {
        return JSON.stringify(res);
    } catch {
        return String(res);
    }
}

function buildNoReuseConstraint(purpose, prevText) {
    // 「直前の応答を含めない／参照しない」を明示して、同じ材料から別案を出させる
    if (!prevText)
        return "";
    // 長いとトークンを食うので先頭だけ
    const clip = prevText.slice(0, 600);
    return (`【重要】再生成ルール（必須）
- 直前に生成された${purpose}の文章を、コピー・言い換え・部分引用して再利用しない。
- 直前の文章の構成・語尾・言い回しも踏襲しない。別の観点・別の表現で新規に作成する。
- 次の文章（参考）を出力に含めない：\n---\n${clip}\n---\n`);
}

async function callSuggestFlowStep({promptKeyLike, promptFile, purpose, maxTokensFallback, temperatureFallback, isRetry=false, userContent}) {
    const promptObj = await getPromptObj(promptKeyLike, promptFile);
    const params = promptObj.params || {};
    const basePrompt = (promptObj.prompt || "").trim();

    if (!basePrompt) {
        console.error("[prompt] empty prompt body:", promptKeyLike, promptFile, promptObj?.raw);
        throw new Error(`Prompt本文が空です: ${promptKeyLike} / ${promptFile}`);
    }

    if (!SUGGEST_FLOW.active)
        resetSuggestFlow();

    // system は「プロンプト本文」 + （再生成時のみ）直前再利用禁止
    const prev = SUGGEST_FLOW.lastOutputs[purpose] || "";
    const constraint = isRetry ? buildNoReuseConstraint(purpose, prev) : "";
    const systemText = constraint ? (basePrompt + "\n\n" + constraint) : basePrompt;

    // 会話に積む（system + user）
    SUGGEST_FLOW.messages.push({
        role: "system",
        content: systemText
    });
    SUGGEST_FLOW.messages.push({
        role: "user",
        content: userContent
    });

    const body = {
        messages: SUGGEST_FLOW.messages,
        temperature: params.temperature ?? temperatureFallback ?? 0.35,
        max_tokens: params.max_tokens ?? maxTokensFallback ?? 800,
        top_p: params.top_p,
        frequency_penalty: params.frequency_penalty,
        presence_penalty: params.presence_penalty,
        purpose
    };

    const res = await callGPT(body);
    const text = (normalizeGptText(res) || "").trim();

    // assistant を会話に積む（次ステップが参照できる）
    SUGGEST_FLOW.messages.push({
        role: "assistant",
        content: text
    });

    // 保存（再生成ルール用）
    SUGGEST_FLOW.lastOutputs[purpose] = text;

    return text;
}

function buildSuggestionStepsFromIndex(promptIndex) {
    if (!promptIndex?.items?.length)
        return [];

    // 既存の“規定5枠” + suggestion
    const KNOWN = {
        "texel-suggestion.json": {
            keyLike: "suggestion",
            purpose: "suggestion",
            max: 4000,
            taId: "editable-suggestion"
        },
        "texel-suumo-catch.json": {
            keyLike: "suumoCatch",
            purpose: "suumo-catch",
            max: 800,
            taId: "suumo-catch"
        },
        "texel-suumo-comment.json": {
            keyLike: "suumoComment",
            purpose: "suumo-comment",
            max: 1200,
            taId: "suumo-comment"
        },
        "texel-athome-comment.json": {
            keyLike: "athomeComment",
            purpose: "athome-comment",
            max: 800,
            taId: "athome-comment"
        },
        "texel-athome-appeal.json": {
            keyLike: "athomeAppeal",
            purpose: "athome-appeal",
            max: 1600,
            taId: "athome-appeal"
        },
    };

    const items = [...promptIndex.items].filter(it => it && typeof it.file === "string").map(it => ({
        file: it.file.trim(),
        name: (it.name || "").trim(),
        order: Number.isFinite(+it.order) ? +it.order : 9999,
        hidden: !!it.hidden,
        lock: !!it.lock
    })).sort( (a, b) => a.order - b.order);

    const steps = [];

    for (const it of items) {
        const file = it.file;

        // このフェーズ（おすすめポイント生成）の対象外
        if (file === "texel-roomphoto.json")
            continue;
        if (!/^texel-.*\.json$/i.test(file))
            continue;
        // 念のため

        // hidden は「UI上で非表示」だが、処理もスキップしたいならここで continue
        // 今回は「hiddenは処理対象外」として扱うのが自然
        if (it.hidden)
            continue;

        // --- 規定枠 ---
        if (KNOWN[file]) {
            const def = KNOWN[file];
            const ta = document.getElementById(def.taId);
            if (!ta)
                continue;
            steps.push({
                file,
                promptFile: file,
                // 規定枠は keyLike により resolvePromptCandidates が client/ を試す
                keyLike: def.keyLike,
                purpose: def.purpose,
                maxTokens: def.max,
                textarea: ta,
                lock: it.lock
            });
            continue;
        }

        // --- custom 枠 ---
        // UI生成済みの textarea は data-file に file が入っている想定（あなたの実装）
        const ta = document.querySelector(`#suggestion-outputs textarea[data-file="${CSS.escape(file)}"]`);
        if (!ta) {
            // UI側生成が未完/失敗していても落とさずスキップ
            console.warn("[index-flow] custom textarea not found for:", file);
            continue;
        }

        steps.push({
            file,
            // ★重要：custom は client 配下にしか無いので client/ を明示
            promptFile: `client/${clientId}/${file}`,
            // keyLike は既知でなくてもよい（fallbackFilename で読める）
            keyLike: file,
            // purpose は会話フロー内でユニークならOK（再利用禁止制約にも使われる）
            purpose: `custom:${file}`,
            maxTokens: 1200,
            // 制限は無いが、暴走させないための安全値（必要なら上げる）
            textarea: ta,
            lock: it.lock
        });
    }

    return steps;
}


// --- Rate-limit / backoff helpers (429対策) ---
const _texelDelay = (ms) => new Promise(r => setTimeout(r, ms));
let _lastGptCallAt = 0;
const MIN_GPT_INTERVAL_MS = 1500; // 連続呼び出しの間隔（必要なら調整）
async function waitForGptSlot() {
  const now = Date.now();
  const wait = Math.max(0, (_lastGptCallAt + MIN_GPT_INTERVAL_MS) - now);
  if (wait > 0) await _texelDelay(wait);
  _lastGptCallAt = Date.now();
}
async function callSuggestFlowStepWithBackoff(args) {
  const maxTry = 6;
  let backoff = 1200;
  for (let i = 1; i <= maxTry; i++) {
    try {
      return await callSuggestFlowStep(args);
    } catch (e) {
      const msg = String(e?.message || e || "");
      const is429 = msg.includes("429") || /too many requests|rate limit|retry limit/i.test(msg);
      if (!is429 || i === maxTry) throw e;
      console.warn(`[rate] 429/backoff: attempt ${i}/${maxTry} wait ${backoff}ms`);
      await _texelDelay(backoff + Math.floor(Math.random() * 250));
      backoff = Math.min(backoff * 2, 20000);
    }
  }
}

async function runSuggestionStepsInOrder({steps, combined, isRetry}) {
    for (const s of steps) {
        const ta = s.textarea;
        if (!ta)
            continue;

        // lock は「編集不可」だけでなく「生成結果を書き込むか」も方針がある
        // 今回は lock でも “生成はするが readOnly” とする（現行UIと整合）
        if (s.lock)
            ta.readOnly = true;

        await waitForGptSlot();
        const text = await callSuggestFlowStepWithBackoff({
            promptKeyLike: s.keyLike,
            promptFile: s.promptFile,
            purpose: s.purpose,
            maxTokensFallback: s.maxTokens,
            temperatureFallback: 0.35,
            isRetry,
            userContent: combined
        });

        if (typeof text === "string") {
            ta.value = text;
            if (typeof autoGrow === "function")
                autoGrow(ta);

            // 文字数カウンタ更新（存在する場合だけ）
            // 規定枠は既存 id、custom は生成時に row span があるので直近の span を拾う
            const knownCounterId = {
                "editable-suggestion": null,
                // suggestion は suggestion-count を使いたければここに入れる
                "suumo-catch": "suumo-catch-count",
                "suumo-comment": "suumo-comment-count",
                "athome-comment": "athome-comment-count",
                "athome-appeal": "athome-appeal-count",
            }[ta.id];

            const len = text.replace(/\r\n/g, "\n").length;

            if (knownCounterId) {
                const cn = document.getElementById(knownCounterId);
                if (cn)
                    cn.textContent = String(len) + (cn.textContent.includes("/") ? cn.textContent.slice(cn.textContent.indexOf("/")) : "");
            } else {
                // custom: 同ブロック内の span（右側）を更新
                const block = ta.closest(".analysis-area");
                const cn = block?.querySelector("div[style*='justify-content: space-between'] span");
                if (cn)
                    cn.textContent = String(len);
            }
        }
    }
}

async function onGenerateSuggestions(arg) {
  // arg は以下の可能性がある：
  // - undefined（通常）
  // - MouseEvent（ボタン押下の addEventListener 経由）
  // - { isRetry: true/false }（明示オプション）
  // - null（自動フロー等で誤って渡されるケース） ← ここで落ちていた
  const isRetry = !!(arg && typeof arg === "object" && "isRetry" in arg ? arg.isRetry : false);

  postLog("suggestion", isRetry ? "retry-begin" : "begin");

  try {
    if (typeof showLoadingSpinner === "function") showLoadingSpinner("suggestion");

    // 新規生成はセッションをリセット。再生成は保持（履歴を残したまま「再利用禁止」を差し込む）
    if (!isRetry) resetSuggestFlow();

    // index 取得（client/<id>/prompt-index.json）
    // ※ loadPromptIndexSafe を必ず通す（未定義エラー・取得失敗の握りつぶし対策）
    // clientId が未入力のケースに備え、最後に確定した clientId を救済
    if (!clientId) {
      const last = (localStorage.getItem("texel_last_clientId") || "").trim();
      if (last) clientId = last;
    } else {
      localStorage.setItem("texel_last_clientId", clientId);
    }

    const promptIndex = await loadPromptIndexSafe(clientId);
    if (!promptIndex) {
      throw new Error("prompt-index.json を取得できませんでした（clientId=" + clientId + "）");
    }

    // index -> steps（DOMは並べ替え済みでもOK。処理順はここで確定）
    const steps = buildSuggestionStepsFromIndex(promptIndex);
    if (!steps.length) {
      console.warn("[index-flow] no steps to run");
      return;
    }

    // 会話に与える共通ソース（既存ロジックを使用）
    const combined = buildCombinedSource();

    // index順に会話処理（＝会話順保証）
    await runSuggestionStepsInOrder({ steps, combined, isRetry });

    postLog("suggestion", "ok", { steps: steps.map(s => s.file) });

    // 生成結果を保存（GAS/Blob）
    await saveExportJson();

  } catch (e) {
    postLog("suggestion", "error", { message: String(e?.message || e) });
    console.warn("[Texel] onGenerateSuggestions failed", e);
    throw e; // 自動フロー側でも検知したい場合に備え、再throw（不要なら削除可）
  } finally {
    if (typeof hideLoadingSpinner === "function") hideLoadingSpinner("suggestion");
  }
}

// ===== ポータル4種（空欄のみ自動生成） =====
async function generatePortals({force=false, isRetry=false}={}) {
    const fields = [{
        id: "suumo-catch",
        pkey: "suumoCatch",
        file: P.suumoCatch,
        purpose: "suumo-catch",
        limit: 37,
        max: 800
    }, {
        id: "suumo-comment",
        pkey: "suumoComment",
        file: P.suumoComment,
        purpose: "suumo-comment",
        limit: 300,
        max: 1200
    }, {
        id: "athome-comment",
        pkey: "athomeComment",
        file: P.athomeComment,
        purpose: "athome-comment",
        limit: 100,
        max: 800
    }, {
        id: "athome-appeal",
        pkey: "athomeAppeal",
        file: P.athomeAppeal,
        purpose: "athome-appeal",
        limit: 500,
        max: 1600
    }, ];

    const combined = buildCombinedSource();

    for (const f of fields) {
        const ta = document.getElementById(f.id);
        if (!ta)
            continue;
        const current = (ta.value || "").trim();
        if (!force && current)
            continue;

        try {
            await waitForGptSlot();
        const text = await callSuggestFlowStepWithBackoff({
                promptKeyLike: f.pkey,
                promptFile: f.file,
                purpose: f.purpose,
                maxTokensFallback: f.max,
                temperatureFallback: 0.35,
                isRetry,
                userContent: combined
            });

            if (text) {
                ta.value = text;
                if (typeof autoGrow === "function")
                    autoGrow(ta);

                // 文字数カウンタ（あれば更新）
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

                postLog("portal", "ok", {
                    field: f.id,
                    length: (text || "").length
                });
            }
        } catch (e) {
            postLog("portal", "error", {
                field: f.id,
                message: String(e?.message || e)
            });
            console.warn(`[Texel] portal generate failed (${f.id})`, e);
        }
    }

    // ここでは保存だけ。toast/counter は存在するなら別途 UI 側で。
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
        if (btn)
            btn.click();
    }
    // おすすめ反映後にポータル4種も自動生成
    if (typeof generatePortals === "function") {
        await generatePortals({
            force: false
        });
        // 既入力は上書きしない
    }
}

/* === 高解像度化ユーティリティ（Rehouse/一般） === */
function upgradeImageUrl(u) {
    try {
        const url = new URL(u,location.origin);

        // 例: .../resizeImage?src=...&w=480&h=320 → w=1600,h=1200 に上げる
        if (/\/resizeImage/i.test(url.pathname)) {
            url.searchParams.set("w", "1600");
            url.searchParams.set("h", "1200");
            return url.href;
        }

        // よくあるクエリの幅・高さパラメータを上書き
        const W_KEYS = ["w", "width", "maxwidth", "mw"];
        const H_KEYS = ["h", "height", "maxheight", "mh"];
        let touched = false;
        for (const k of W_KEYS)
            if (url.searchParams.has(k)) {
                url.searchParams.set(k, "1600");
                touched = true;
            }
        for (const k of H_KEYS)
            if (url.searchParams.has(k)) {
                url.searchParams.set(k, "1200");
                touched = true;
            }
        if (touched)
            return url.href;

        // サムネ系パスの置換（Rehouse でありがち）
        let p = url.pathname.replace(/\/thumb\//i, "/").replace(/\/s\//i, "/l/").replace(/_s(\.\w+)$/i, "$1");
        if (p !== url.pathname) {
            url.pathname = p;
            return url.href;
        }

        return url.href;
    } catch {
        return u;
    }
}

/** 要約を再生成してメモ欄に反映する（SnapVoice準拠の安全版） */
async function onRegenerateSummary() {
    postLog("summary", "begin");
    try {
        // プロンプト取得（ローカル/Blob/デフォルトの順）
        const promptObj = await getPromptObj("summary", P.summary);
        const params = promptObj.params || {};
        const basePrompt = promptObj.prompt || "与えられた情報を、購入検討者にも伝わる要約にしてください。";

        // これまで集めた材料をひとまとめにする
        const combined = buildCombinedSource();

        // GPT 呼び出し
        const body = {
            messages: [{
                role: "system",
                content: basePrompt
            }, {
                role: "user",
                content: combined
            }],
            temperature: params.temperature ?? 0.3,
            max_tokens: params.max_tokens ?? 2000,
            top_p: params.top_p,
            frequency_penalty: params.frequency_penalty,
            presence_penalty: params.presence_penalty,
            purpose: "summary"
        };
        const res = await callGPT(body);
        const text = res?.choices?.[0]?.message?.content?.trim() || "";

        // メモ欄を更新（APIメモが無い/空なら先に復元→要約を追記）
        const memoEl = document.getElementById("property-info");
        if (memoEl) {
            const hasMemo = !!memoEl.value.trim();

            // Rehouse API からの素メモ復元（SnapVoiceのロジック）
            if (!hasMemo && basePropertyData) {
                const apiMemo = generatePropertyMemo(basePropertyData, promptMap);
                if (apiMemo)
                    memoEl.value = apiMemo;
            }

            // 要約の反映（上書きではなく追記）
            if (text) {
                memoEl.value = (memoEl.value ? memoEl.value + "\n\n" : "") + "【AI要約】\n" + text;
            }

            autoGrow(memoEl);
        }

        await saveExportJson();
        postLog("summary", "ok", {
            length: (text || "").length
        });
    } catch (e) {
        postLog("summary", "error", {
            message: String(e?.message || e)
        });
        console.error("onRegenerateSummary 失敗:", e);
        alert("要約の生成に失敗しました。ネットワーク状況等をご確認ください。");
    }
}

function updateResetSuggestionBtn() {
    const btn = document.getElementById("reset-suggestion");
    const ta = document.querySelector("#suggestion-area textarea");
    if (!btn || !ta)
        return;
    btn.disabled = !originalSuggestionText || originalSuggestionText === ta.value;
}

function onClickResetSuggestion() {
    const ta = document.querySelector("#suggestion-area textarea");
    if (!ta)
        return;
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

/* ===== PDF floorplan multi-page + room PDF all-pages — merged on build ===== */

/* =====================================================================
 *  texel_pdf_floorplan_plus.js  — Add-on for Texel
 *  Feature:
 *    1) Floorplan area now accepts PDFs. If multi-page, show thumbnails
 *       to let the user pick ONE page, *then* choose North and analyze.
 *    2) Room Images area now also accepts PDFs. When a PDF is provided,
 *       ALL pages are rendered and analyzed sequentially as images.
 *  Integration:
 *    - Load this file AFTER your base texel.js.
 *    - Requires pdf.js (the base texel.js already loads libs/pdfjs/pdf.js).
 *  Safe: No changes to base file; only augments UI and event handlers.
 * ===================================================================== */
(function() {
    'use strict';

    // ---------- Helpers ----------
    function $(id) {
        return document.getElementById(id);
    }
    function ensurePdfJs() {
        return new Promise( (resolve, reject) => {
            if (window.pdfjsLib)
                return resolve();
            const s = document.createElement("script");
            s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.7.76/pdf.min.js";
            s.onload = () => resolve();
            s.onerror = () => reject(new Error("pdf.js load failed"));
            document.head.appendChild(s);
        }
        );
    }
    function showSpinner(key) {
        try {
            if (typeof showLoadingSpinner === "function")
                showLoadingSpinner(key);
        } catch {}
    }
    function hideSpinner(key) {
        try {
            if (typeof hideLoadingSpinner === "function")
                hideLoadingSpinner(key);
        } catch {}
    }
    function dataURLFromCanvas(canvas, type="image/png") {
        try {
            return canvas.toDataURL(type);
        } catch {
            return "";
        }
    }

    async function renderPdfPageToDataURL(pdfDoc, pageIndex0, scale=2.0) {
        const page = await pdfDoc.getPage(pageIndex0 + 1);
        const viewport = page.getViewport({
            scale
        });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({
            canvasContext: canvas.getContext("2d"),
            viewport
        }).promise;
        return dataURLFromCanvas(canvas);
    }

    async function readFileAsArrayBuffer(file) {
        const buf = await file.arrayBuffer();
        return new Uint8Array(buf);
    }

    // ---------- Floorplan: PDF thumbnails selection ----------
    function ensureFloorplanThumbsUI() {
        let host = $("floorplan-drop");
        if (!host)
            host = document.body;
        let thumbs = document.getElementById("floorplan-pdf-thumbs");
        if (!thumbs) {
            const wrap = document.createElement("div");
            wrap.id = "floorplan-pdf-thumbs";
            wrap.style.cssText = "display:flex;gap:8px;overflow-x:auto;margin:8px 0;";
            host.insertAdjacentElement("afterend", wrap);

            // style per-thumb
            const style = document.createElement("style");
            style.textContent = `
        #floorplan-pdf-thumbs .fp-thumb{min-width:92px;height:128px;border:2px solid transparent;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.2);cursor:pointer;background:#fff;display:flex;align-items:center;justify-content:center;}
        #floorplan-pdf-thumbs .fp-thumb.active{border-color:#1e88e5;}
        #floorplan-pdf-thumbs img{max-width:100%;max-height:100%;display:block;object-fit:contain;}
      `;
            document.head.appendChild(style);
            thumbs = wrap;
        }
        return thumbs;
    }

    function setActiveFloorplanThumb(index) {
        const t = $("floorplan-pdf-thumbs");
        if (!t)
            return;
        [...t.querySelectorAll(".fp-thumb")].forEach( (el, i) => {
            el.classList.toggle("active", i === index);
        }
        );
    }

    async function handleFloorplanPdf(file) {
        try {
            await ensurePdfJs();
            showSpinner("floorplan");
            const bytes = await readFileAsArrayBuffer(file);
            const pdfDoc = await pdfjsLib.getDocument({
                data: bytes,
                disableWorker: true
            }).promise;
            const pageCount = pdfDoc.numPages;

            const thumbs = ensureFloorplanThumbsUI();
            thumbs.innerHTML = "";
            const previews = [];
            for (let i = 0; i < pageCount; i++) {
                const thumbURL = await renderPdfPageToDataURL(pdfDoc, i, 0.8);
                previews.push(thumbURL);
                const cell = document.createElement("div");
                cell.className = "fp-thumb";
                cell.dataset.index = String(i);
                const img = document.createElement("img");
                img.src = thumbURL;
                img.alt = "Page " + (i + 1);
                cell.appendChild(img);
                cell.addEventListener("click", async () => {
                    const idx = Number(cell.dataset.index);
                    setActiveFloorplanThumb(idx);
                    // render selected page at higher scale as floorplan image
                    showSpinner("floorplan");
                    try {
                        const mainURL = await renderPdfPageToDataURL(pdfDoc, idx, 2.5);
                        const imgEl = $("floorplan-preview");
                        if (imgEl) {
                            imgEl.src = mainURL;
                            imgEl.style.display = "block";
                            imgEl.style.cursor = "pointer";
                        }
                        // set global
                        try {
                            window.currentFloorplanBase64 = mainURL;
                        } catch {}
                        // show north selector after selection
                        if (typeof showNorthSelector === "function")
                            showNorthSelector();
                    } finally {
                        hideSpinner("floorplan");
                    }
                }
                );
                thumbs.appendChild(cell);
            }

            // auto-select first page for convenience
            if (pageCount > 0) {
                setActiveFloorplanThumb(0);
                const firstURL = await renderPdfPageToDataURL(pdfDoc, 0, 2.5);
                const imgEl = $("floorplan-preview");
                if (imgEl) {
                    imgEl.src = firstURL;
                    imgEl.style.display = "block";
                    imgEl.style.cursor = "pointer";
                }
                try {
                    window.currentFloorplanBase64 = firstURL;
                } catch {}
                if (typeof showNorthSelector === "function")
                    showNorthSelector();
            }
        } catch (err) {
            console.error("Floorplan PDF handling failed:", err);
            alert("PDFの読み込みに失敗しました。");
        } finally {
            hideSpinner("floorplan");
        }
    }

    // Extend floorplan drop/file inputs to accept PDFs
    function extendFloorplanInputs() {
        const drop = $("floorplan-drop");
        const file = $("floorplan-file");

        if (drop && !drop.dataset.pdfExtended) {
            drop.dataset.pdfExtended = "1";
            drop.addEventListener("drop", async (e) => {
                try {
                    const items = [...(e.dataTransfer?.files || [])];
                    const pdf = items.find(f => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
                    if (!pdf)
                        return;
                    // let base handler manage images/urls
                    e.preventDefault();
                    await handleFloorplanPdf(pdf);
                } catch {}
            }
            , true);
            // capture to preempt base
        }
        if (file && !file.dataset.pdfExtended) {
            file.dataset.pdfExtended = "1";
            file.setAttribute("accept", ".pdf,image/*");
            file.addEventListener("change", async (e) => {
                const f = e.target.files && e.target.files[0];
                if (f && (f.type === "application/pdf" || /\.pdf$/i.test(f.name))) {
                    e.stopPropagation();
                    await handleFloorplanPdf(f);
                    // clear selection so re-choosing the same file works
                    //e.target.value = "";
                }
            }
            , true);
        }
    }

    // ---------- Room images: accept PDF and analyze all pages ----------
    async function analyzePdfAsRoomImages(file) {
        try {
            await ensurePdfJs();
            showSpinner("room");
            const bytes = await readFileAsArrayBuffer(file);
            const pdfDoc = await pdfjsLib.getDocument({
                data: bytes,
                disableWorker: true
            }).promise;
            const pageCount = pdfDoc.numPages;
            for (let i = 0; i < pageCount; i++) {
                const pageURL = await renderPdfPageToDataURL(pdfDoc, i, 2.0);
                // roomType/desc hint
                const title = (file.name || "PDF") + " p." + (i + 1);
                if (typeof analyzeRoomPhotoWithGPT === "function") {
                    await analyzeRoomPhotoWithGPT(pageURL, null, title, "PDFページ");
                }
            }
        } catch (err) {
            console.error("Room PDF handling failed:", err);
            alert("PDFの画像解析でエラーが発生しました。");
        } finally {
            hideSpinner("room");
        }
    }

    function extendRoomInputs() {
        const drop = $("room-drop");
        const file = $("room-file");
        if (drop && !drop.dataset.pdfExtended) {
            drop.dataset.pdfExtended = "1";
            drop.addEventListener("drop", async (e) => {
                const files = [...(e.dataTransfer?.files || [])];
                const pdfs = files.filter(f => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
                if (!pdfs.length)
                    return;
                // let base handle images
                e.preventDefault();
                for (const p of pdfs) {
                    await analyzePdfAsRoomImages(p);
                }
            }
            , true);
        }
        if (file && !file.dataset.pdfExtended) {
            file.dataset.pdfExtended = "1";
            file.setAttribute("accept", ".pdf,image/*");
            file.addEventListener("change", async (e) => {
                const fs = [...(e.target.files || [])];
                const pdfs = fs.filter(f => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
                if (!pdfs.length)
                    return;
                // base handles images
                for (const p of pdfs) {
                    await analyzePdfAsRoomImages(p);
                }
                //e.target.value = "";
            }
            , true);
        }
    }

    // ---------- Boot ----------
    document.addEventListener("DOMContentLoaded", () => {
        try {
            extendFloorplanInputs();
        } catch {}
        try {
            extendRoomInputs();
        } catch {}
        initAutoGrowTextareas();
    }
    );

}
)();

/* === File input label helper ================================= */
function setFloorplanPicked(name, extra) {
    var el = document.getElementById('floorplan-file-picked');
    if (!el)
        return;
    el.textContent = name ? (extra ? (name + '（' + extra + '）') : name) : '';
}

function bindSuggestionTools() {
    const ta = document.getElementById("editable-suggestion");
    const cn = document.getElementById("suggestion-count");
    const btn = document.getElementById("copy-suggestion");
    if (!ta || !cn || !btn)
        return;

    const update = () => {
        const len = (ta.value || "").replace(/\r\n/g, "\n").length;
        cn.textContent = `${len}`;
    }
    ;

    ta.addEventListener("input", () => {
        if (typeof autoGrow === "function")
            autoGrow(ta, 120);
        update();
        if (typeof autosaveDebounced === "function")
            autosaveDebounced();
    }
    );
    update();

    btn.addEventListener("click", () => {
        const text = (ta.value || "").trim();
        navigator.clipboard.writeText(text).then( () => showCopyNotification?.("クリップボードへコピーしました")).catch( () => showCopyNotification?.("コピーに失敗しました"));
    }
    );
}