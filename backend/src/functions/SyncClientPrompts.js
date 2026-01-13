const { app } = require("@azure/functions");
const { BlobServiceClient } = require("@azure/storage-blob");

const connectionString = process.env["AzureWebJobsStorage"];
const CONTAINER = "prompts";

// ======================= テンプレート対応表 =========================
const TEMPLATE_MAP = {
  "TYPE-S": [
    ["texel-s-suumo-catch.json",   (c)=>`client/${c}/texel-suumo-catch.json`],
    ["texel-s-suumo-comment.json", (c)=>`client/${c}/texel-suumo-comment.json`],
    ["texel-s-roomphoto.json",     (c)=>`client/${c}/texel-roomphoto.json`],
    ["texel-s-suggestion.json",    (c)=>`client/${c}/texel-suggestion.json`],
  ],
  "TYPE-R": [
    ["texel-r-athome-appeal.json",   (c)=>`client/${c}/texel-athome-appeal.json`],
    ["texel-r-athome-comment.json",  (c)=>`client/${c}/texel-athome-comment.json`],
    ["texel-r-roomphoto.json",       (c)=>`client/${c}/texel-roomphoto.json`],
    ["texel-r-suggestion.json",      (c)=>`client/${c}/texel-suggestion.json`],
    ["texel-r-suumo-catch.json",     (c)=>`client/${c}/texel-suumo-catch.json`],
    ["texel-r-suumo-comment.json",   (c)=>`client/${c}/texel-suumo-comment.json`],
  ],
  "BASE": [
    ["texel-athome-appeal.json",   (c)=>`client/${c}/texel-athome-appeal.json`],
    ["texel-athome-comment.json",  (c)=>`client/${c}/texel-athome-comment.json`],
    ["texel-roomphoto.json",       (c)=>`client/${c}/texel-roomphoto.json`],
    ["texel-suggestion.json",      (c)=>`client/${c}/texel-suggestion.json`],
    ["texel-suumo-catch.json",     (c)=>`client/${c}/texel-suumo-catch.json`],
    ["texel-suumo-comment.json",   (c)=>`client/${c}/texel-suumo-comment.json`],
  ]
};

// ======================= メイン処理 =========================
app.http("SyncClientPrompts", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    context.log("◆ SyncClientPrompts START");

    let body;
    try {
      body = await request.json();
    } catch {
      return { status: 400, body: { error: "JSONボディが必要です" } };
    }

    const adds = Array.isArray(body.adds) ? body.adds : [];
    const deletes = Array.isArray(body.deletes) ? body.deletes : [];

    // 互換のため options は任意
    const options = (body && typeof body.options === "object" && body.options) ? body.options : {};
    // 既存 index があっても明示的にテンプレ構成へ寄せたい場合に true
    const forceRebuildIndex = !!options.forceRebuildIndex;

    try {
      const blobSvc = BlobServiceClient.fromConnectionString(connectionString);
      const container = blobSvc.getContainerClient(CONTAINER);
      await container.createIfNotExists();

      const results = { created: [], updated: [], skipped: [], deleted: [], errors: [] };

      // ================================================================
      // ① クライアントのプロンプトコピー & prompt-index.json 生成/更新
      // ================================================================
      for (const a of adds) {
        const code = normalizeCode(a && a.code);
        const behavior = normalizeBehavior(a && a.behavior);
        const name = (a && typeof a.name === "string") ? a.name : "";
        const spreadsheetId = (a && typeof a.spreadsheetId === "string") ? a.spreadsheetId : "";

        if (!code) continue;
        if (!["TYPE-R", "TYPE-S", "BASE"].includes(behavior)) continue;

        const pairs = TEMPLATE_MAP[behavior] || [];

        // --- 各テンプレート JSON をコピー（既存は上書きしない） ---
        for (const [src, dstFn] of pairs) {
          const dst = dstFn(code);
          const dstBlob = container.getBlobClient(dst);

          if (await dstBlob.exists()) {
            results.skipped.push({ code, dst, reason: "exists" });
            continue;
          }

          const srcBlob = container.getBlobClient(src);
          if (!(await srcBlob.exists())) {
            results.errors.push({ code, src, dst, error: "template_missing" });
            continue;
          }

          const dl = await srcBlob.download();
          const buf = await streamToBuffer(dl.readableStreamBody);

          const blockBlobClient = container.getBlockBlobClient(dst);
          await blockBlobClient.upload(buf, buf.length, {
            blobHTTPHeaders: { blobContentType: "application/json; charset=utf-8" }
          });

          results.created.push({ code, dst });
        }

        // --- prompt-index.json の安全な生成/更新 ---
        const indexPath = `client/${code}/prompt-index.json`;
        const backupPath = `client/${code}/prompt-index.backup.json`;

        const indexBlob = container.getBlobClient(indexPath);
        const indexExists = await indexBlob.exists();

        const nowIso = new Date().toISOString();
        const today = nowIso.substring(0, 10);

        const templateItems = pairs.map(([src], i) => ({
          file: plainFileName(src),
          name: "",
          order: (i + 1) * 10,
          hidden: false,
          lock: false
        }));

        if (!indexExists) {
          // 新規作成（bootstrap）
          const indexObj = {
            version: 1,
            clientId: code,
            name,
            behavior,
            spreadsheetId,
            createdAt: today,
            updatedAt: nowIso,
            items: templateItems
          };

          await uploadJson(container, indexPath, indexObj);
          results.created.push({ code, dst: indexPath, reason: "created_index" });
          continue;
        }

        // 既存 index がある場合：破壊しない更新がデフォルト
        const currentIndex = await tryDownloadJson(container, indexPath);
        if (!currentIndex.ok) {
          // 既存が壊れている/読めない場合は、強制指定があるときだけ再生成する
          if (!forceRebuildIndex && !truthy(a && a.forceRebuildIndex)) {
            results.errors.push({ code, dst: indexPath, error: "index_parse_failed" });
            continue;
          }

          // バックアップ（壊れていても raw は一応退避）
          await safeCopyBlobIfExists(container, indexPath, backupPath);

          const rebuilt = {
            version: 1,
            clientId: code,
            name,
            behavior,
            spreadsheetId,
            createdAt: today,
            updatedAt: nowIso,
            items: templateItems
          };

          await uploadJson(container, indexPath, rebuilt);
          results.updated.push({ code, dst: indexPath, reason: "rebuilt_index_parse_failed" });
          continue;
        }

        const idx = currentIndex.data;

        // ここが重要：名前変更等で「勝手に items を作り直さない」。
        // ただし behavior が変わった場合のみ、テンプレ構成へ寄せつつ custom を保持する（安全マージ）。
        const behaviorChanged = String(idx.behavior || "").toUpperCase() !== behavior;

        // 強制再構築（管理者運用）または behavior 変更時は、backup を取り merge する
        const doMergeRebuild =
          forceRebuildIndex ||
          truthy(a && a.forceRebuildIndex) ||
          behaviorChanged;

        if (!doMergeRebuild) {
          // メタのみ更新（items は完全維持）
          const next = {
            ...idx,
            clientId: code, // 念のため固定
            name,
            behavior,
            spreadsheetId,
            createdAt: idx.createdAt || today,
            updatedAt: nowIso,
            items: Array.isArray(idx.items) ? idx.items : []
          };

          const changed = JSON.stringify(slimIndexMeta(idx)) !== JSON.stringify(slimIndexMeta(next));
          if (changed) {
            await uploadJson(container, indexPath, next);
            results.updated.push({ code, dst: indexPath, reason: "meta_updated_only" });
          } else {
            results.skipped.push({ code, dst: indexPath, reason: "meta_no_change" });
          }
          continue;
        }

        // ====== merge rebuild（custom保持、テンプレ不足分は補完、順序は相対維持） ======
        await safeCopyBlobIfExists(container, indexPath, backupPath);

        const oldItems = Array.isArray(idx.items) ? idx.items : [];
        const mergedItems = mergeItemsKeepingCustom(oldItems, templateItems);

        const merged = {
          version: 1,
          clientId: code,
          name,
          behavior,
          spreadsheetId,
          createdAt: idx.createdAt || today,
          updatedAt: nowIso,
          items: mergedItems
        };

        await uploadJson(container, indexPath, merged);
        results.updated.push({ code, dst: indexPath, reason: behaviorChanged ? "behavior_changed_merge" : "force_merge" });
      }

      // ================================================================
      // ② クライアントフォルダ削除
      // ================================================================
      for (const codeRaw of deletes) {
        const code = normalizeCode(codeRaw);
        if (!code) continue;

        const prefix = `client/${code}/`;

        for await (const blob of container.listBlobsFlat({ prefix })) {
          await container.deleteBlob(blob.name);
          results.deleted.push({ name: blob.name });
        }
      }

      context.log("◆ SyncClientPrompts DONE", results);
      return {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: results
      };

    } catch (err) {
      context.log("◆ SyncClientPrompts ERROR", err);
      return {
        status: 500,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: { error: "SyncClientPrompts 失敗", details: err.message }
      };
    }
  }
});

// ======================= helper =========================

function normalizeCode(v) {
  const code = String(v || "").trim().toUpperCase();
  return /^[A-Z0-9]{4}$/.test(code) ? code : "";
}

function normalizeBehavior(v) {
  const b = String(v || "").trim().toUpperCase();
  if (["TYPE-R", "TYPE-S", "BASE"].includes(b)) return b;
  return "BASE";
}

function truthy(v) {
  return v === true || v === 1 || v === "1" || String(v || "").toLowerCase() === "true";
}

function plainFileName(src) {
  // texel-(s-|r-)? を texel- に正規化（index items はプレーン名に統一）
  return String(src || "").replace(/^texel-(s-|r-)?/, "texel-");
}

function slimIndexMeta(idx) {
  // 比較用（items は比較しない）
  return {
    version: idx.version,
    clientId: idx.clientId,
    name: idx.name,
    behavior: idx.behavior,
    spreadsheetId: idx.spreadsheetId
  };
}

function normalizeItem(it) {
  return {
    file: String(it && it.file || "").trim(),
    name: (it && typeof it.name === "string") ? it.name : "",
    order: toInt(it && it.order),
    hidden: !!(it && it.hidden),
    lock: !!(it && it.lock)
  };
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function mergeItemsKeepingCustom(oldItemsRaw, templateItemsRaw) {
  // 方針：
  // - テンプレ項目は必ず含める
  // - 既存に同一 file があれば name/hidden/lock を優先し、order は既存を尊重
  // - 既存の custom（テンプレに無い file）も落とさず残す
  // - 最終的に order で安定ソートして、10刻みで振り直す（相対順序は維持）
  const oldItems = oldItemsRaw.map(normalizeItem).filter(x => x.file);
  const tmplItems = templateItemsRaw.map(normalizeItem).filter(x => x.file);

  const oldByFile = new Map(oldItems.map(x => [x.file, x]));
  const used = new Set();

  const merged = [];
  let seq = 0;

  // ①テンプレ優先で取り込み
  for (const t of tmplItems) {
    const old = oldByFile.get(t.file);
    const it = old ? {
      file: t.file,
      name: old.name,
      order: old.order || t.order,
      hidden: old.hidden,
      lock: old.lock,
      __seq: seq++
    } : {
      ...t,
      __seq: seq++
    };
    merged.push(it);
    used.add(t.file);
  }

  // ②テンプレ外（custom）を追加
  for (const o of oldItems) {
    if (used.has(o.file)) continue;
    merged.push({ ...o, order: o.order || 0, __seq: seq++ });
  }

  // ③安定ソート → order振り直し
  merged.sort((a, b) => {
    const ao = a.order || 0;
    const bo = b.order || 0;
    if (ao !== bo) return ao - bo;
    return a.__seq - b.__seq;
  });

  // order を 10刻みに
  for (let i = 0; i < merged.length; i++) {
    merged[i].order = (i + 1) * 10;
    delete merged[i].__seq;
  }
  return merged;
}

async function tryDownloadJson(container, blobName) {
  try {
    const blob = container.getBlobClient(blobName);
    if (!(await blob.exists())) return { ok: false, reason: "missing" };

    const dl = await blob.download();
    const buf = await streamToBuffer(dl.readableStreamBody);
    const txt = buf.toString("utf8");
    const data = JSON.parse(txt);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, reason: "parse_error", error: String(e && e.message || e) };
  }
}

async function uploadJson(container, blobName, obj) {
  const json = JSON.stringify(obj, null, 2);
  const blockBlob = container.getBlockBlobClient(blobName);
  await blockBlob.upload(
    Buffer.from(json, "utf8"),
    Buffer.byteLength(json),
    { blobHTTPHeaders: { blobContentType: "application/json; charset=utf-8" } }
  );
}

async function safeCopyBlobIfExists(container, srcName, dstName) {
  try {
    const src = container.getBlobClient(srcName);
    if (!(await src.exists())) return;

    const dl = await src.download();
    const buf = await streamToBuffer(dl.readableStreamBody);

    const dst = container.getBlockBlobClient(dstName);
    await dst.upload(buf, buf.length, {
      blobHTTPHeaders: { blobContentType: "application/json; charset=utf-8" }
    });
  } catch {
    // backup 失敗でも本処理を止めない（最悪、後続で index を維持していれば破壊にならない）
  }
}

// ======================= ストリーム→Buffer =========================
async function streamToBuffer(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on("data", d => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    readable.on("end", () => resolve(Buffer.concat(chunks)));
    readable.on("error", reject);
  });
}
