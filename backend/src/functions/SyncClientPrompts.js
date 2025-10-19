// /functions/SyncClientPrompts.js
const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');

const connectionString = process.env["AzureWebJobsStorage"];
const CONTAINER = "prompts";

// テンプレート → 宛先
const TEMPLATE_MAP = {
  "TYPE-S": [
    ["prompt/texel-s-suumo-catch.json",   (c)=>`prompt/${c}/texel-suumo-catch.json`],
    ["prompt/texel-s-suumo-comment.json", (c)=>`prompt/${c}/texel-suumo-comment.json`],
    ["prompt/texel-s-roomphoto.json",     (c)=>`prompt/${c}/texel-roomphoto.json`],
    ["prompt/texel-s-suggestion.json",    (c)=>`prompt/${c}/texel-suggestion.json`],
  ],
  "TYPE-R": [
    ["prompt/texel-r-athome-appeal.json",   (c)=>`prompt/${c}/texel-athome-appeal.json`],
    ["prompt/texel-r-athome-comment.json",  (c)=>`prompt/${c}/texel-athome-comment.json`],
    ["prompt/texel-r-roomphoto.json",       (c)=>`prompt/${c}/texel-roomphoto.json`],
    ["prompt/texel-r-suggestion.json",      (c)=>`prompt/${c}/texel-suggestion.json`],
    ["prompt/texel-r-suumo-catch.json",     (c)=>`prompt/${c}/texel-suumo-catch.json`],
    ["prompt/texel-r-suumo-comment.json",   (c)=>`prompt/${c}/texel-suumo-comment.json`],
  ],
  // ★ NEW: BASE は -r/-s なしの素のテンプレートを使用
  "BASE": [
    ["prompt/texel-athome-appeal.json",   (c)=>`prompt/${c}/texel-athome-appeal.json`],
    ["prompt/texel-athome-comment.json",  (c)=>`prompt/${c}/texel-athome-comment.json`],
    ["prompt/texel-roomphoto.json",       (c)=>`prompt/${c}/texel-roomphoto.json`],
    ["prompt/texel-suggestion.json",      (c)=>`prompt/${c}/texel-suggestion.json`],
    ["prompt/texel-suumo-catch.json",     (c)=>`prompt/${c}/texel-suumo-catch.json`],
    ["prompt/texel-suumo-comment.json",   (c)=>`prompt/${c}/texel-suumo-comment.json`],
  ]
};

app.http('SyncClientPrompts', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    let body;
    try { body = await request.json(); }
    catch { return { status: 400, body: { error: "JSONボディが必要です" } }; }

    const adds = Array.isArray(body.adds) ? body.adds : [];
    const deletes = Array.isArray(body.deletes) ? body.deletes : [];

    try {
      const blobSvc = BlobServiceClient.fromConnectionString(connectionString);
      const container = blobSvc.getContainerClient(CONTAINER);
      await container.createIfNotExists();

      const results = { created: [], skipped: [], deleted: [], errors: [] };

      // 1) 初期コピー
      for (const a of adds) {
        const code = String(a.code || "").trim().toUpperCase();
        const behavior = String(a.behavior || "").trim().toUpperCase(); // "TYPE-R"|"TYPE-S"|"BASE"
        if (!/^[A-Z0-9]{4}$/.test(code)) continue;
        if (!["TYPE-R","TYPE-S","BASE"].includes(behavior)) continue;

        const pairs = TEMPLATE_MAP[behavior] || [];
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
      }

      // 2) フォルダ削除
      for (const codeRaw of deletes) {
        const code = String(codeRaw || "").trim().toUpperCase();
        if (!/^[A-Z0-9]{4}$/.test(code)) continue;
        const prefix = `prompt/${code}/`;
        for await (const blob of container.listBlobsFlat({ prefix })) {
          await container.deleteBlob(blob.name);
          results.deleted.push({ name: blob.name });
        }
      }

      return { status: 200, body: results };

    } catch (err) {
      return { status: 500, body: { error: "SyncClientPrompts 失敗", details: err.message } };
    }
  }
});

async function streamToBuffer(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on('data', (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    readable.on('end', () => resolve(Buffer.concat(chunks)));
    readable.on('error', reject);
  });
}
