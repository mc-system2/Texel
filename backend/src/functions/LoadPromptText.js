const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');

const connectionString = process.env["AzureWebJobsStorage"];
const containerName = "prompts";

app.http('LoadPromptText', {
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        context.log("◆ LoadPromptText Function - START");

        const filename = request.query.get('filename');
        context.log(`◆ 受信した filename: ${filename}`);

        if (!filename) {
            context.log("◆ エラー: filename がありません");
            return { status: 400, body: { error: "filename が必要です" } };
        }

        try {
            const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
            const containerClient = blobServiceClient.getContainerClient(containerName);
            const blobClient = containerClient.getBlobClient(filename);

            const exists = await blobClient.exists();
            if (!exists) {
                context.log("◆ ファイルが見つかりません");
                return { status: 404, body: { error: "指定されたファイルが存在しません" } };
            }
            
            const downloadBlockBlobResponse = await blobClient.download();
            const downloaded = await streamToString(downloadBlockBlobResponse.readableStreamBody);
            const parsedJson = JSON.parse(downloaded);
            
            context.log("◆ ダウンロード成功:", parsedJson);
            return {
                status: 200,
                headers: { "Content-Type": "application/json; charset=utf-8" },
                body: JSON.stringify(parsedJson)  // ★ここを修正
            };
        } catch (err) {
            context.log("◆ Blob取得エラー:", err);
            return { status: 500, body: { error: "プロンプト取得に失敗しました", details: err.message } };
        }
    }
});

async function streamToString(readableStream) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      readableStream.on("data", (data) => {
        chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
      });
      readableStream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      readableStream.on("error", reject);
    });
  }
  