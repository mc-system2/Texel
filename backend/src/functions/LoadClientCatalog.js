// LoadClientCatalog.js
const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');
const crypto = require('crypto');

const connectionString = process.env["AzureWebJobsStorage"];
const containerName = "prompts";
const blobName = "texel-client-catalog.json";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, If-None-Match",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const md5 = (t) => crypto.createHash('md5').update(t, 'utf8').digest('hex');
const nowISO = () => new Date().toISOString();

app.http('LoadClientCatalog', {
  methods: ['GET', 'OPTIONS'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    if (request.method === 'OPTIONS') {
      return { status: 204, headers: corsHeaders };
    }

    context.log("◆ LoadClientCatalog - START");
    try {
      const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
      const containerClient = blobServiceClient.getContainerClient(containerName);
      const blobClient = containerClient.getBlobClient(blobName);

      const exists = await blobClient.exists();
      if (!exists) {
        const empty = { version: 1, updatedAt: nowISO(), clients: [] };
        const body = JSON.stringify(empty);
        return {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "ETag": `"cc-${md5(body)}"`
          },
          body
        };
      }

      const props = await blobClient.getProperties();
      const blobETag = props.etag; // 例: "0x8D…"
      const inm = request.headers.get('if-none-match');

      if (inm && blobETag && inm.replace(/^W\//, '') === blobETag) {
        return {
          status: 304,
          headers: {
            ...corsHeaders,
            "ETag": blobETag,
            "Cache-Control": "max-age=3600, must-revalidate"
          },
          body: null
        };
      }

      const res = await blobClient.download();
      const text = await streamToString(res.readableStreamBody);

      let json;
      try { json = JSON.parse(text); }
      catch { json = { version: 1, updatedAt: nowISO(), clients: [] }; }

      return {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "max-age=3600, must-revalidate",
          "ETag": blobETag || `"cc-${md5(text)}"`
        },
        body: JSON.stringify(json)
      };
    } catch (err) {
      context.log("◆ LoadClientCatalog error:", err);
      return {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "client-catalog load failed", details: err.message })
      };
    }
  }
});

function streamToString(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on("data", (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    readable.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    readable.on("error", reject);
  });
}
