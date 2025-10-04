// Azure Functions のサンプル: 画像URLを受け取り、Base64変換して返す HTTPトリガー関数
const { BlobServiceClient } = require("@azure/storage-blob");
const axios = require("axios");
const { app } = require("@azure/functions");

app.http("ImageUrlToBase64", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    try {
      const { imageUrl } = await request.json();
      if (!imageUrl) {
        return { status: 400, body: "imageUrl is required" };
      }

      // 画像を取得
      const response = await axios.get(imageUrl, {
        responseType: "arraybuffer"
      });
      const contentType = response.headers["content-type"] || "image/jpeg";
      const base64Image = Buffer.from(response.data, "binary").toString("base64");

      return {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          base64: `data:${contentType};base64,${base64Image}`
        })
      };
    } catch (error) {
      context.error("画像のBase64変換中にエラー", error);
      return {
        status: 500,
        body: "画像のBase64変換に失敗しました"
      };
    }
  }
});
