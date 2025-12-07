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

    try {
      const blobSvc = BlobServiceClient.fromConnectionString(connectionString);
      const container = blobSvc.getContainerClient(CONTAINER);
      await container.createIfNotExists();

      const results = { created: [], skipped: [], deleted: [], errors: [] };

      // ================================================================
      // ① 新規クライアントのプロンプトコピー & prompt-index.json 生成
      // ================================================================
      for (const a of adds) {
        const code = String(a.code || "").trim().toUpperCase();
        const behavior = String(a.behavior || "").trim().toUpperCase();
        const name = a.name || "";
        const spreadsheetId = a.spreadsheetId || "";

        if (!/^[A-Z0-9]{4}$/.test(code)) continue;
        if (!["TYPE-R", "TYPE-S", "BASE"].includes(behavior)) continue;

        const pairs = TEMPLATE_MAP[behavior] || [];

        // --- 各テンプレート JSON をコピー ---
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

        // =======================================================
        // prompt-index.json を生成する
        // =======================================================

        const createdAt = new Date().toISOString().substring(0, 10);
        const updatedAt = new Date().toISOString();

        const items = pairs.map(([src], i) => ({
          file: src.replace(/^texel-(s-|r-)?/, "texel-"), // プレーン化
          name: "",          // UI側で編集可能
          order: (i + 1) * 10,
          hidden: false,
          lock: false
        }));

        const indexObj = {
          version: 1,
          clientId: code,
          name,
          behavior,
          spreadsheetId,
          createdAt,
          updatedAt,
          items
        };

        const indexJson = JSON.stringify(indexObj, null, 2);

        const indexBlob = container.getBlockBlobClient(`client/${code}/prompt-index.json`);
        await indexBlob.upload(
          Buffer.from(indexJson, "utf8"),
          Buffer.byteLength(indexJson),
          { blobHTTPHeaders: { blobContentType: "application/json; charset=utf-8" } }
        );

        results.created.push({ code, dst: `client/${code}/prompt-index.json` });
      }

      // ================================================================
      // ② クライアントフォルダ削除
      // ================================================================
      for (const codeRaw of deletes) {
        const code = String(codeRaw || "").trim().toUpperCase();
        if (!/^[A-Z0-9]{4}$/.test(code)) continue;

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

// ======================= ストリーム→Buffer =========================
async function streamToBuffer(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on("data", d => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    readable.on("end", () => resolve(Buffer.concat(chunks)));
    readable.on("error", reject);
  });
}
