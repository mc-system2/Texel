// functions/CopyPromptText.js
// POST body: { "src": "texel-prompt-template.json", "dst": "client/A001/texel-<ts>.json", "overwrite": false }
const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');

const connectionString = process.env["AzureWebJobsStorage"];
const containerName = "prompts";

app.http('CopyPromptText', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    context.log("◆ CopyPromptText Function - START");
    if (!connectionString) {
      return { status: 500, body: { error: "AzureWebJobsStorage is not set" } };
    }

    let body;
    try {
      body = await request.json();
      context.log("◆ 受信データ:", JSON.stringify(body));
    } catch (err) {
      return { status: 400, body: { error: "リクエストボディが不正です" } };
    }

    const { src, dst, overwrite } = body || {};
    if (!src || !dst) {
      return { status: 400, body: { error: "src および dst は必須です" } };
    }

    try {
      const bsc = BlobServiceClient.fromConnectionString(connectionString);
      const container = bsc.getContainerClient(containerName);
      await container.createIfNotExists();

      const srcBlob = container.getBlockBlobClient(src);
      const dstBlob = container.getBlockBlobClient(dst);

      // src 存在チェック
      if (!(await srcBlob.exists())) {
        return { status: 404, body: { error: `src が存在しません: ${src}` } };
      }

      // dst 既存チェック
      if (!overwrite && (await dstBlob.exists())) {
        return { status: 409, body: { error: `dst が既に存在します: ${dst}` } };
      }

      // 読み込み（バッファ化）
      const dl = await srcBlob.download();
      const buf = await streamToBuffer(dl.readableStreamBody);

      // JSONとしてアップロード（Content-Typeを継承 or 既定JSON）
      let ct = "application/json; charset=utf-8";
      try {
        const props = await srcBlob.getProperties();
        if (props?.contentType) ct = props.contentType;
      } catch (e) { /* noop */ }

      const up = await dstBlob.upload(buf, buf.length, {
        blobHTTPHeaders: { blobContentType: ct }
      });

      context.log(`◆ コピー成功: ${src} → ${dst}`);
      return {
        status: 200,
        headers: { ETag: up.etag },
        body: { ok: true, etag: up.etag, src, dst }
      };
    } catch (err) {
      context.log("◆ コピー失敗:", err);
      return { status: 500, body: { error: "コピー中にエラーが発生しました", details: err.message } };
    }
  }
});

// util
function streamToBuffer(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on("data", d => chunks.push(Buffer.from(d)));
    readable.on("end", () => resolve(Buffer.concat(chunks)));
    readable.on("error", reject);
  });
}
