const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');

const connectionString = process.env["AzureWebJobsStorage"];
const containerName = "prompts";

app.http('SavePromptText', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        context.log("◆ SavePromptText Function - START");

        let body;
        try {
            body = await request.json();
            context.log("◆ 受信データ:", JSON.stringify(body));
        } catch (err) {
            return { status: 400, body: { error: "リクエストボディが不正です" } };
        }

        const { filename, prompt, params } = body;

        if (!filename || typeof prompt === "undefined") {
            return { status: 400, body: { error: "filename または prompt が不足しています" } };
        }

        // ← ここを安全に修正（テキストもオブジェクトもOKに）
        let parsedPrompt;
        if (typeof prompt === "string") {
            try {
                // "{"で始まるなど、見た目がJSON文字列ならパースを試みる（旧資産・新UI両対応）
                parsedPrompt = JSON.parse(prompt);
            } catch (err) {
                // テキストとして使う
                parsedPrompt = prompt;
            }
        } else {
            parsedPrompt = prompt;
        }

        // パラメータ含めてラップ
        const objToSave = { prompt: parsedPrompt, params: params ?? {} };

        try {
            const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
            const containerClient = blobServiceClient.getContainerClient(containerName);
            await containerClient.createIfNotExists();

            const blockBlobClient = containerClient.getBlockBlobClient(filename);

            const jsonText = JSON.stringify(objToSave, null, 2);
            await blockBlobClient.upload(jsonText, Buffer.byteLength(jsonText), {
                blobHTTPHeaders: { blobContentType: "application/json; charset=utf-8" }
            });

            context.log(`◆ 保存成功: ${filename}`);
            return { status: 200, body: { message: "保存成功", filename: filename } };

        } catch (err) {
            context.log("◆ 保存失敗:", err);
            return { status: 500, body: { error: "保存中にエラーが発生しました", details: err.message } };
        }
    }
});
