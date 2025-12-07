const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');

const connectionString = process.env["AzureWebJobsStorage"];
const containerName   = "property-index";  // ← 変更

// 物件コードチェック用正規表現
const CODE_REGEX = /^F[A-Za-z0-9]{7}$/;

app.http('LoadFloorplanJson', {
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        context.log("◆ LoadFloorplanJson Function - START");

        // クエリパラメータから propertyCode を取得
        const propertyCode = request.query.get('propertyCode');
        context.log(`◆ 受信した propertyCode: ${propertyCode}`);

        // バリデーション
        if (!propertyCode || !CODE_REGEX.test(propertyCode)) {
            context.log("◆ エラー: propertyCode が不正");
            return {
                status: 400,
                body: { error: "propertyCode は英数8文字、先頭Fで指定してください" }
            };
        }

        // 実際のBlobファイル名
        const filename = `${propertyCode}.json`;

        try {
            context.log("◆ BlobServiceClient 初期化");
            const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
            const containerClient   = blobServiceClient.getContainerClient(containerName);
            const blobClient        = containerClient.getBlobClient(filename);

            context.log(`◆ Blob 存在チェック: ${filename}`);
            const exists = await blobClient.exists();
            if (!exists) {
                context.log("◆ 指定ファイルなし");
                return { status: 404, body: { error: "指定された物件コードのデータが見つかりません" } };
            }

            context.log("◆ Blob ダウンロード開始");
            const downloadResponse = await blobClient.download();
            const downloaded       = await streamToString(downloadResponse.readableStreamBody);

            context.log(`◆ 取得したデータ: ${downloaded}`);
            const jsonData = JSON.parse(downloaded);

            return {
                status: 200,
                headers: { "Content-Type": "application/json; charset=utf-8" },
                body: JSON.stringify(jsonData)
            };
        } catch (error) {
            context.log("◆ 取得失敗", error);
            return { status: 500, body: { error: "取得失敗", details: error.message } };
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
  
