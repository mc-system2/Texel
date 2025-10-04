const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');

const connectionString = process.env["AzureWebJobsStorage"];
const containerName   = "property-index";  // ← 変更

// 物件コードチェック用正規表現
const CODE_REGEX = /^F[A-Za-z0-9]{7}$/;

app.http('SaveFloorplanJson', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        context.log("◆ SaveFloorplanJson Function - START");

        let body;
        try {
            body = await request.json();
            context.log("◆ 受信したリクエストボディ:", JSON.stringify(body));
        } catch (err) {
            context.log("◆ リクエストボディのJSON変換失敗:", err);
            return { status: 400, body: { error: "リクエストボディが不正です" } };
        }

        // propertyCode と data を取得
        const { propertyCode, data } = body;
        context.log("◆ 受信した propertyCode:", propertyCode);
        context.log("◆ 受信した data:", JSON.stringify(data));

        // バリデーション
        if (!propertyCode || !CODE_REGEX.test(propertyCode)) {
            context.log("◆ エラー: propertyCode が不正");
            return {
                status: 400,
                body: { error: "propertyCode は英数8文字、先頭Fで指定してください" }
            };
        }
        if (data == null) {
            context.log("◆ 必須データ不足 - data が null");
            return {
                status: 400,
                body: { error: "保存する data が不足しています" }
            };
        }

        // 保存先ファイル名
        const filename = `${propertyCode}.json`;

        try {
            context.log("◆ BlobServiceClient を初期化");
            const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);

            context.log(`◆ コンテナ取得／作成チェック: ${containerName}`);
            const containerClient = blobServiceClient.getContainerClient(containerName);
            await containerClient.createIfNotExists();
            context.log("◆ コンテナ確認完了");

            context.log(`◆ Blob名: ${filename}`);
            const blockBlobClient = containerClient.getBlockBlobClient(filename);

            const jsonData = JSON.stringify(data);
            context.log(`◆ アップロード開始 (サイズ: ${Buffer.byteLength(jsonData)} bytes)`);

            await blockBlobClient.upload(jsonData, Buffer.byteLength(jsonData), {
                blobHTTPHeaders: { blobContentType: "application/json; charset=utf-8" }
            });

            context.log("◆ アップロード成功");
            return { status: 200, body: { message: "保存成功" } };
        } catch (error) {
            context.log("◆ アップロード失敗:", error);
            return { status: 500, body: { error: "保存失敗", details: error.message } };
        }
    }
});
