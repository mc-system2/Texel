const { app } = require("@azure/functions");
const { BlobServiceClient } = require("@azure/storage-blob");

const connectionString = process.env["AzureWebJobsStorage"];
const CONTAINER = "prompts";

/**
 * GET /api/LoadPromptIndex?filename=client%2FA001%2Fprompt-index.json
 * - Returns the raw (pure) prompt-index.json (no {prompt,params} wrapper).
 */
app.http("LoadPromptIndex", {
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    try {
      const url = new URL(request.url);
      const filename = url.searchParams.get("filename");
      if (!filename) {
        return { status: 400, body: { error: "filename is required" } };
      }

      const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
      const containerClient = blobServiceClient.getContainerClient(CONTAINER);
      const blobClient = containerClient.getBlobClient(filename);

      const exists = await blobClient.exists();
      if (!exists) return { status: 404, body: { error: "Not Found", filename } };

      const download = await blobClient.download();
      const chunks = [];
      for await (const c of download.readableStreamBody) chunks.push(c);
      const text = Buffer.concat(chunks).toString("utf8");

      return {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: text
      };
    } catch (err) {
      context.log("LoadPromptIndex error:", err);
      return { status: 500, body: { error: "Failed to load prompt index", details: err.message } };
    }
  }
});
