// functions/DeleteClientFolder.js
// POST body: { "prefix": "client/A001/" }

const { app } = require("@azure/functions");
const { BlobServiceClient } = require("@azure/storage-blob");

const connectionString = process.env["AzureWebJobsStorage"];
const containerName = "prompts";

app.http("DeleteClientFolder", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    context.log("◆ DeleteClientFolder Function - START");

    if (!connectionString) {
      return { status: 500, body: { error: "AzureWebJobsStorage が未設定です" } };
    }

    let body;
    try {
      body = await request.json();
      context.log("◆ 受信データ:", JSON.stringify(body));
    } catch {
      return { status: 400, body: { error: "リクエストボディが不正です" } };
    }

    const { prefix } = body || {};
    if (!prefix) {
      return { status: 400, body: { error: "prefix は必須です (例: client/A001/)" } };
    }

    try {
      const bsc = BlobServiceClient.fromConnectionString(connectionString);
      const container = bsc.getContainerClient(containerName);
      await container.createIfNotExists();

      const blobs = container.listBlobsFlat({ prefix });

      let deleteCount = 0;
      for await (const blob of blobs) {
        const blobClient = container.getBlobClient(blob.name);
        await blobClient.delete();
        deleteCount++;
        context.log(`削除: ${blob.name}`);
      }

      return {
        status: 200,
        body: { message: "フォルダ削除完了", prefix, deleted: deleteCount }
      };
    } catch (err) {
      context.log("◆ 削除失敗:", err);
      return {
        status: 500,
        body: { error: "削除中にエラーが発生しました", details: err.message }
      };
    }
  }
});
