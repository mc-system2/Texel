const { app } = require("@azure/functions");
const { BlobServiceClient } = require("@azure/storage-blob");

const connectionString = process.env["AzureWebJobsStorage"];
const containerName = "prompts";

function validateIndexFilename(filename) {
  const f = String(filename || "");
  if (!/^client\/[A-Z0-9]{4}\/prompt-index\.json$/.test(f)) {
    throw new Error("filename must be like client/AB12/prompt-index.json");
  }
  return f;
}

app.http("LoadPromptIndex", {
  methods: ["GET"],
  authLevel: "function",
  handler: async (request, context) => {
    try {
      const filename = validateIndexFilename(request.query.get("filename"));
      const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
      const container = blobServiceClient.getContainerClient(containerName);
      const blockBlobClient = container.getBlockBlobClient(filename);

      const exists = await blockBlobClient.exists();
      if (!exists) {
        return { status: 404, jsonBody: { error: "Not Found" } };
      }

      const dl = await blockBlobClient.download(0);
      const etag = dl?.etag || null;
      const text = await streamToString(dl.readableStreamBody);

      let obj = {};
      try { obj = text ? JSON.parse(text) : {}; } catch { obj = {}; }

      return {
        status: 200,
        headers: etag ? { "etag": etag, "ETag": etag } : {},
        jsonBody: obj
      };
    } catch (err) {
      context.log("◆ LoadPromptIndex NG:", err);
      return { status: 500, jsonBody: { error: "読み込み中にエラーが発生しました", details: String(err?.message || err) } };
    }
  }
});

async function streamToString(readable) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    readable.on("data", (d) => chunks.push(Buffer.from(d)));
    readable.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    readable.on("error", reject);
  });
}
