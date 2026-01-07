const { app } = require("@azure/functions");
const { BlobServiceClient } = require("@azure/storage-blob");

const connectionString = process.env["AzureWebJobsStorage"];
const CONTAINER = "prompts";

/**
 * POST /api/SavePromptIndex
 * Body:
 *  - { filename: "client/A001/prompt-index.json", index: { ...pure index... }, etag?: "..." }
 *  - OR { filename, text: "{...pure index json...}", etag?: "..." }
 *
 * Always saves as pure JSON (no {prompt,params} wrapper).
 */
app.http("SavePromptIndex", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    try {
      const body = await request.json().catch(() => null);
      if (!body || !body.filename) {
        return { status: 400, body: { error: "filename is required" } };
      }
      const filename = body.filename;
      const etag = body.etag || body.eTag || body.ETag || null;

      let jsonText = null;
      if (typeof body.text === "string") {
        jsonText = body.text;
      } else if (typeof body.index === "object" && body.index) {
        // Strip accidental foreign keys defensively
        const idx = { ...body.index };
        delete idx.prompt;
        delete idx.params;
        jsonText = JSON.stringify(idx, null, 2);
      } else if (typeof body === "object" && body.version && body.items) {
        // Allow directly posting the index object
        const idx = { ...body };
        delete idx.prompt;
        delete idx.params;
        jsonText = JSON.stringify(idx, null, 2);
      } else {
        return { status: 400, body: { error: "index (object) or text (string) is required" } };
      }

      // Validate JSON
      try { JSON.parse(jsonText); } catch (e) {
        return { status: 400, body: { error: "Invalid JSON", details: e.message } };
      }

      const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
      const containerClient = blobServiceClient.getContainerClient(CONTAINER);
      const blockBlobClient = containerClient.getBlockBlobClient(filename);

      const options = {
        blobHTTPHeaders: { blobContentType: "application/json; charset=utf-8" }
      };
      if (etag) options.conditions = { ifMatch: etag };

      await blockBlobClient.upload(jsonText, Buffer.byteLength(jsonText, "utf8"), options);

      return { status: 200, body: { message: "saved", filename } };
    } catch (err) {
      context.log("SavePromptIndex error:", err);
      // Concurrency error
      if (err && (err.statusCode === 412 || err.code === "ConditionNotMet")) {
        return { status: 412, body: { error: "ETag mismatch", details: err.message } };
      }
      return { status: 500, body: { error: "Failed to save prompt index", details: err.message } };
    }
  }
});
