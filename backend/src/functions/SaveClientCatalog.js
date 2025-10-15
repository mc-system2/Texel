// SaveClientCatalog.js
const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');

const connectionString = process.env["AzureWebJobsStorage"];
const containerName = "prompts";

app.http('SaveClientCatalog', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    context.log("◆ SaveClientCatalog - START");

    let body;
    try {
      body = await request.json();
    } catch {
      return { status: 400, body: { error: "JSON body が不正です" } };
    }

    const filename = (body?.filename || "").trim();
    const catalog  = body?.catalog;
    const ifMatch  = body?.etag || body?.IfMatch || null;

    if (!filename) return { status: 400, body: { error: "filename が必須です" } };
    if (!catalog || typeof catalog !== "object")
      return { status: 400, body: { error: "catalog が必須です（version/updatedAt/clients を含む）" } };

    // 形だけ検証
    if (!Array.isArray(catalog.clients)) {
      return { status: 400, body: { error: "catalog.clients は配列である必要があります" } };
    }

    try {
      const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
      const containerClient  = blobServiceClient.getContainerClient(containerName);
      await containerClient.createIfNotExists();

      const blockBlob = containerClient.getBlockBlobClient(filename);

      // JSONをそのまま保存（wrap しない）
      const jsonText = JSON.stringify(catalog, null, 2);

      const uploadOptions = {
        blobHTTPHeaders: { blobContentType: "application/json; charset=utf-8" }
      };

      // ETag 条件（If-Match）— 上書き競合対策
      if (ifMatch) uploadOptions.conditions = { ifMatch };

      await blockBlob.upload(jsonText, Buffer.byteLength(jsonText), uploadOptions);

      // 新しい ETag を取得
      const props = await blockBlob.getProperties();

      context.log("◆ 保存成功:", filename, "ETag:", props.etag);
      return {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: { ok: true, etag: props.etag, updatedAt: catalog.updatedAt }
      };
    } catch (err) {
      // 412: ETag 不一致（競合）
      if (err?.statusCode === 412) {
        return { status: 409, body: { error: "競合しました。最新を読み込み直してください。(ETag mismatch)" } };
      }
      context.log("◆ 保存失敗:", err);
      return { status: 500, body: { error: "保存に失敗しました", details: err.message } };
    }
  }
});
