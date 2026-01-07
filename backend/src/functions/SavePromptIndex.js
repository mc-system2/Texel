const { app } = require("@azure/functions");
const { BlobServiceClient } = require("@azure/storage-blob");

const connectionString = process.env["AzureWebJobsStorage"];
const containerName = "prompts";

function validateIndexFilename(filename) {
  const f = String(filename || "");
  // expected: client/XXXX/prompt-index.json
  if (!/^client\/[A-Z0-9]{4}\/prompt-index\.json$/.test(f)) {
    throw new Error("filename must be like client/AB12/prompt-index.json");
  }
  return f;
}

function normalizeIndexShape(idx) {
  if (!idx || typeof idx !== "object") throw new Error("index must be an object");
  if (!Array.isArray(idx.items)) idx.items = [];
  // Enforce forbidden keys
  if ("prompt" in idx) delete idx.prompt;
  if ("params" in idx) delete idx.params;

  // Minimal required keys
  if (typeof idx.version !== "number") idx.version = 1;
  if (typeof idx.clientId !== "string") idx.clientId = "";
  if (typeof idx.name !== "string") idx.name = "";
  if (typeof idx.behavior !== "string") idx.behavior = "";
  if (typeof idx.spreadsheetId !== "string") idx.spreadsheetId = "";
  if (typeof idx.createdAt !== "string") idx.createdAt = "";
  idx.updatedAt = new Date().toISOString();

  // Normalize items
  idx.items = idx.items.map((it) => ({
    file: String(it?.file || ""),
    name: typeof it?.name === "string" ? it.name : "",
    order: Number(it?.order || 0),
    hidden: !!it?.hidden,
    lock: !!it?.lock,
  })).filter(it => it.file);

  // Keep stable sort by order then file
  idx.items.sort((a,b) => (a.order - b.order) || a.file.localeCompare(b.file));
  return idx;
}

app.http("SavePromptIndex", {
  methods: ["POST"],
  authLevel: "function",
  handler: async (request, context) => {
    try {
      const body = await request.json();
      const filename = validateIndexFilename(body?.filename);
      const indexObj = normalizeIndexShape(body?.index);

      const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
      const container = blobServiceClient.getContainerClient(containerName);
      const blockBlobClient = container.getBlockBlobClient(filename);

      const jsonText = JSON.stringify(indexObj, null, 2);

      await blockBlobClient.upload(jsonText, Buffer.byteLength(jsonText, "utf8"), {
        blobHTTPHeaders: { blobContentType: "application/json; charset=utf-8" },
      });

      context.log(`◆ SavePromptIndex OK: ${filename}`);
      return {
        status: 200,
        jsonBody: { message: "保存成功", filename }
      };
    } catch (err) {
      context.log("◆ SavePromptIndex NG:", err);
      return { status: 500, jsonBody: { error: "保存中にエラーが発生しました", details: String(err?.message || err) } };
    }
  }
});
