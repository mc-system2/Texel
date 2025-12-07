// LoadClientCatalog.js
const { app } = require("@azure/functions");
const { BlobServiceClient } = require("@azure/storage-blob");

const connectionString = process.env["AzureWebJobsStorage"];
const containerName = "prompts";

app.http("LoadClientCatalog", {
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    context.log("◆ LoadClientCatalog - START");

    const filename =
      request.query.get("filename") || "texel-client-catalog.json";

    try {
      const blobServiceClient =
        BlobServiceClient.fromConnectionString(connectionString);
      const containerClient =
        blobServiceClient.getContainerClient(containerName);
      const blobClient = containerClient.getBlobClient(filename);

      // -------------------------------------------------------
      // ① catalog が存在しない → client フォルダから自動復元
      // -------------------------------------------------------
      const exists = await blobClient.exists();
      if (!exists) {
        context.log(
          "◆ catalog が存在しないため、client/ フォルダから自動生成します"
        );

        const catalog = await rebuildCatalogFromPromptIndex(containerClient);

        return {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({ clients: catalog }),
        };
      }

      // -------------------------------------------------------
      // ② catalog が存在 → 通常読み込み
      // -------------------------------------------------------
      const props = await blobClient.getProperties();
      const etag = props.etag;

      const dl = await blobClient.download();
      const text = await streamToString(dl.readableStreamBody);

      let json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        return {
          status: 500,
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({
            error: "BLOBが不正なJSONです",
            details: String(e?.message || e),
          }),
        };
      }

      return {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          ETag: etag,
        },
        body: JSON.stringify(json),
      };
    } catch (err) {
      context.log("◆ LoadClientCatalog 例外:", err);
      return {
        status: 500,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "読み込みに失敗しました", details: err.message }),
      };
    }
  },
});

// --------------------------------------------------------
// stream → string
// --------------------------------------------------------
async function streamToString(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on("data", (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    readable.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    readable.on("error", reject);
  });
}

// --------------------------------------------------------
// ★ prompt-index.json から catalog を完全復元
// --------------------------------------------------------
async function rebuildCatalogFromPromptIndex(container) {
  const clients = [];

  // client/ 以下のフォルダを列挙する
  for await (const item of container.listBlobsByHierarchy("/", { prefix: "client/" })) {
    if (item.kind !== "prefix") continue; // client/XXXX/ の階層のみターゲット

    const parts = item.name.split("/");
    const code = parts[1]; // client/XXXX/

    if (!/^[A-Z0-9]{4}$/.test(code)) continue;

    // prompt-index.json が存在するか確認
    const indexBlob = container.getBlobClient(`client/${code}/prompt-index.json`);
    const exists = await indexBlob.exists();

    if (!exists) {
      // index が無い → 従来方式で最低限復元
      clients.push({
        code,
        name: "",
        behavior: detectBehavior(container, code),
        spreadsheetId: "",
        createdAt: "",
      });
      continue;
    }

    // prompt-index.json を読み込む
    const dl = await indexBlob.download();
    const text = await streamToString(dl.readableStreamBody);

    let index;
    try {
      index = JSON.parse(text);
    } catch {
      continue;
    }

    clients.push({
      code,
      name: index.name || "",
      behavior: index.behavior || "BASE",
      spreadsheetId: index.spreadsheetId || "",
      createdAt: index.createdAt || "",
    });
  }

  return clients;
}

// --------------------------------------------------------
// behavior 自動判定（旧ロジック）
// prompt-index.json が無いときのみ使用
// --------------------------------------------------------
async function detectBehavior(container, code) {
  let behavior = "BASE";

  for await (const blob of container.listBlobsFlat({
    prefix: `client/${code}/`,
  })) {
    const n = blob.name.toLowerCase();

    if (n.includes("texel-r-roomphoto.json")) return "TYPE-R";
    if (n.includes("texel-s-roomphoto.json")) return "TYPE-S";
  }

  return behavior;
}
