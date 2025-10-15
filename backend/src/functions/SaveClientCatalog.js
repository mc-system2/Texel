// SaveClientCatalog.js
const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');
const crypto = require('crypto');

const connectionString = process.env["AzureWebJobsStorage"];
const containerName = "prompts";
const blobName = "texel-client-catalog.json";

// 任意：保存APIを守るキー（設定しなければ無認証）
const ADMIN_API_KEY = process.env["ADMIN_API_KEY"] || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const nowISO = () => new Date().toISOString();
const md5 = (t) => crypto.createHash('md5').update(t, 'utf8').digest('hex');

function normalizeBehavior(b) {
  const v = String(b || "").toUpperCase();
  return v === "R" ? "R" : v === "S" ? "S" : ""; // "" | R | S
}
function extractSheetId(input) {
  const v = (input || "").trim();
  if (!v) return "";
  const m = v.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]{10,})/);
  if (m) return m[1];
  const m2 = v.match(/[?&]id=([a-zA-Z0-9-_]{10,})/);
  if (m2) return m2[1];
  return /^[a-zA-Z0-9-_]{10,}$/.test(v) ? v : "";
}
function validateAndNormalizeCatalog(input) {
  const errors = [];
  const version = Number(input?.version ?? 1);
  const updatedAt = String(input?.updatedAt || nowISO());
  const list = Array.isArray(input?.clients) ? input.clients : [];
  const map = new Map();

  for (const raw of list) {
    const code = String(raw?.code || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(code)) {
      errors.push(`invalid code: "${raw?.code}"`);
      continue;
    }
    const row = {
      code,
      name: String(raw?.name || ""),
      behavior: normalizeBehavior(raw?.behavior),
      spreadsheetId: extractSheetId(raw?.spreadsheetId || raw?.sheetId || ""),
      createdAt: raw?.createdAt ? String(raw.createdAt) : ""
    };
    map.set(code, row); // 重複は後勝ち
  }

  const clients = Array.from(map.values());
  return { ok: errors.length === 0, data: { version, updatedAt, clients }, errors };
}

app.http('SaveClientCatalog', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    if (request.method === 'OPTIONS') {
      return { status: 204, headers: corsHeaders };
    }

    context.log("◆ SaveClientCatalog - START");

    if (ADMIN_API_KEY) {
      const key = request.headers.get('x-api-key') || "";
      if (key !== ADMIN_API_KEY) {
        return {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({ error: "unauthorized" })
        };
      }
    }

    let incoming;
    try {
      incoming = await request.json();
    } catch {
      return {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "invalid json body" })
      };
    }

    // 受け入れ形式：
    //  - { version, updatedAt, clients: [...] }
    //  - { clients: [...] }
    //  - [ ... ] （素の配列）
    const payload = Array.isArray(incoming)
      ? { version: 1, updatedAt: nowISO(), clients: incoming }
      : incoming;

    const checked = validateAndNormalizeCatalog(payload);
    if (!checked.ok) {
      return {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "validation failed", details: checked.errors })
      };
    }

    const toSave = { ...checked.data, updatedAt: nowISO() };
    const jsonText = JSON.stringify(toSave, null, 2);

    try {
      const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
      const containerClient = blobServiceClient.getContainerClient(containerName);
      await containerClient.createIfNotExists();
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);

      const resp = await blockBlobClient.upload(jsonText, Buffer.byteLength(jsonText), {
        blobHTTPHeaders: { blobContentType: "application/json; charset=utf-8" }
      });

      const etag = resp.etag || `"cc-${md5(jsonText)}"`;

      context.log(`◆ 保存成功: ${blobName}`);
      return {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "ETag": etag },
        body: JSON.stringify({ message: "ok", etag, clients: toSave.clients.length })
      };
    } catch (err) {
      context.log("◆ 保存失敗:", err);
      return {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "client-catalog save failed", details: err.message })
      };
    }
  }
});
