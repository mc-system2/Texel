const { app } = require("@azure/functions");
const { BlobServiceClient } = require("@azure/storage-blob");

const connectionString = process.env["AzureWebJobsStorage"];
const defaultContainerName = "prompts";

app.http("ListBLOB", {
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    context.log("◆ ListBLOB Function - START");

    // LoadPromptText と同じコンテナ固定運用なら、container は基本不要
    const container =
      (request.query.get("container") ||
        (request.method === "POST" ? (await safeJson(request)).container : null) ||
        defaultContainerName
      ).trim();

    // どちらでも受けられるようにしておく（フロントは prefix/folder どちらでも来る可能性あり）
    const prefix =
      (request.query.get("prefix") ||
        (request.method === "POST" ? (await safeJson(request)).prefix : null) ||
        "").trim();

    const folder =
      (request.query.get("folder") ||
        (request.method === "POST" ? (await safeJson(request)).folder : null) ||
        "").trim();

    // prefix が空で folder があれば folder を prefix 化（末尾 / 付与）
    let effectivePrefix = prefix;
    if (!effectivePrefix && folder) {
      effectivePrefix = folder.endsWith("/") ? folder : `${folder}/`;
    }

    context.log(`◆ container: ${container}`);
    context.log(`◆ prefix: ${effectivePrefix || "(none)"}`);

    if (!connectionString) {
      context.log("◆ エラー: AzureWebJobsStorage がありません");
      return {
        status: 500,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "AzureWebJobsStorage が未設定です" }),
      };
    }

    try {
      const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
      const containerClient = blobServiceClient.getContainerClient(container);

      // コンテナが無いケースもログ出し（必要なら createIfNotExists ではなく明示エラー）
      const containerExists = await containerClient.exists();
      if (!containerExists) {
        context.log("◆ エラー: container が存在しません");
        return {
          status: 404,
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({ error: "container が存在しません", container }),
        };
      }

      const items = [];
      for await (const b of containerClient.listBlobsFlat({ prefix: effectivePrefix || undefined })) {
        items.push({
          name: b.name, // 例: client/A001/texel-custom-....json
          size: b.properties?.contentLength ?? null,
          lastModified: b.properties?.lastModified ?? null,
          etag: b.properties?.etag ?? null,
          contentType: b.properties?.contentType ?? null,
        });
      }

      context.log(`◆ listed items: ${items.length}`);

      return {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        // LoadPromptText.js と同様に body は JSON 文字列で返す運用に寄せる
        body: JSON.stringify({
          container,
          prefix: effectivePrefix,
          items,
        }),
      };
    } catch (err) {
      context.log("◆ ListBLOB エラー:", err);
      return {
        status: 500,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          error: "一覧取得に失敗しました",
          details: err?.message || String(err),
        }),
      };
    }
  },
});

// POST JSON を安全に読む（不正JSONでも落とさない）
async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}
