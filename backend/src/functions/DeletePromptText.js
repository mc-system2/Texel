// functions/DeletePromptText.js
// POST body: { "path": "client/A001/texel-123.json", "ifMatch": "<etag or *>" }
const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');

const connectionString = process.env["AzureWebJobsStorage"];
const containerName = "prompts";

app.http('DeletePromptText', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    context.log("◆ DeletePromptText Function - START");
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

    const { path, ifMatch } = body || {};
    if (!path) {
      return { status: 400, body: { error: "path は必須です" } };
    }

    try {
      const bsc = BlobServiceClient.fromConnectionString(connectionString);
      const container = bsc.getContainerClient(containerName);
      await container.createIfNotExists();

      const blob = container.getBlockBlobClient(path);

      if (!(await blob.exists())) {
        // 冪等に 204
        context.log(`◆ 既に存在しないため削除不要: ${path}`);
        return { status: 204 };
      }

      // ifMatch 指定時は ETag 一致を要求
      if (ifMatch && ifMatch !== "*") {
        const props = await blob.getProperties();
        const etag = props.etag;
        if (!etag || etag !== ifMatch) {
          return { status: 412, body: { error: "Precondition Failed (ETag mismatch)" } };
        }
      }

      await blob.delete();
      context.log(`◆ 削除成功: ${path}`);
      return { status: 204 };
    } catch (err) {
      context.log("◆ 削除失敗:", err);
      return { status: 500, body: { error: "削除中にエラーが発生しました", details: err.message } };
    }
  }
});
