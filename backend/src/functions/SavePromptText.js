const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');

const connectionString = process.env["AzureWebJobsStorage"];
const containerName = "prompts";

// ★ 追加：保存直前に“必ずフラット化”する正規化関数
function toFlat(doc, outerParams) {
  const out = {};
  // 未知のトップレベルキーは維持（prompt/params 以外）
  if (doc && typeof doc === "object") {
    for (const k in doc) if (k !== "prompt" && k !== "params") out[k] = doc[k];
  }

  // ケースA: ネスト型 { prompt:{ prompt:<any>, params:<obj> }, params:<obj> }
  if (doc && typeof doc === "object" && doc.prompt && typeof doc.prompt === "object" && ("prompt" in doc.prompt)) {
    out.prompt = doc.prompt.prompt ?? "";
    const p1 = (doc.prompt.params && typeof doc.prompt.params === "object" && !Array.isArray(doc.prompt.params)) ? doc.prompt.params : {};
    const p2 = (doc.params && typeof doc.params === "object" && !Array.isArray(doc.params)) ? doc.params : {};
    const p3 = (outerParams && typeof outerParams === "object" && !Array.isArray(outerParams)) ? outerParams : {};
    // 内側 > doc.params > 外から渡された params の優先順
    out.params = Object.keys(p1).length ? p1 : (Object.keys(p2).length ? p2 : p3);
    if (!out.params) out.params = {};
    return out;
  }

  // ケースB: フラット型 { prompt:<any>, params:<obj> }
  if (doc && typeof doc === "object") {
    out.prompt = (doc.prompt !== undefined) ? doc.prompt : "";
    const p = (doc.params && typeof doc.params === "object" && !Array.isArray(doc.params)) ? doc.params : {};
    // 明示的に body.params が送られてきていたらそれを上書き優先
    out.params = (outerParams && typeof outerParams === "object" && !Array.isArray(outerParams))
      ? outerParams
      : p;
    return out;
  }

  // ケースC: 文字列だけ
  out.prompt = (doc == null) ? "" : String(doc);
  out.params = (outerParams && typeof outerParams === "object" && !Array.isArray(outerParams)) ? outerParams : {};
  return out;
}

app.http('SavePromptText', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    context.log("◆ SavePromptText Function - START");

    let body;
    try {
      body = await request.json();
      context.log("◆ 受信データ keys:", Object.keys(body || {}));
    } catch (err) {
      return { status: 400, body: { error: "リクエストボディが不正です" } };
    }

    const filename = (body?.filename || "").trim();
    const rawPrompt = body?.prompt;  // 文字列のこともあれば、オブジェクトのこともある
    const outerParams = body?.params;

    if (!filename || typeof rawPrompt === "undefined") {
      return { status: 400, body: { error: "filename または prompt が不足しています" } };
    }

    // 受け取った prompt を一旦 “値” に展開（文字列なら JSON.parse を試す）
    let incoming;
    if (typeof rawPrompt === "string") {
      try {
        incoming = JSON.parse(rawPrompt);
      } catch {
        incoming = rawPrompt; // 純テキスト
      }
    } else {
      incoming = rawPrompt;   // もともとオブジェクト
    }

    // ★ ここが肝：どんな入力でも必ずフラット形へ
    const objToSave = toFlat(incoming, outerParams);

    try {
      const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
      const containerClient = blobServiceClient.getContainerClient(containerName);
      await containerClient.createIfNotExists();

      const blockBlobClient = containerClient.getBlockBlobClient(filename);

      const jsonText = JSON.stringify(objToSave, null, 2);
      await blockBlobClient.upload(jsonText, Buffer.byteLength(jsonText, 'utf8'), {
        blobHTTPHeaders: { blobContentType: "application/json; charset=utf-8" }
      });

      context.log(`◆ 保存成功: ${filename}`);
      return { status: 200, body: { message: "保存成功", filename } };

    } catch (err) {
      context.log("◆ 保存失敗:", err);
      return { status: 500, body: { error: "保存中にエラーが発生しました", details: err.message } };
    }
  }
});
