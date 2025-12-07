// SaveClientCatalog.js
const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');

const connectionString = process.env['AzureWebJobsStorage'];
const containerName = 'prompts';

app.http('SaveClientCatalog', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    context.log('◆ SaveClientCatalog - START');

    let body;
    try {
      body = await request.json();
    } catch {
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ error: 'リクエストボディが不正です（JSON必須）' })
      };
    }

    const filename = body?.filename || 'texel-client-catalog.json';
    const etagIfMatch = body?.etag || body?.ETag || null;
    const catalog = body?.catalog;

    if (!filename || !catalog) {
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ error: 'filename または catalog が不足しています' })
      };
    }

    // ざっくり妥当性チェック
    if (typeof catalog !== 'object' || catalog === null) {
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ error: 'catalog はオブジェクト(JSON)である必要があります' })
      };
    }
    if (!Array.isArray(catalog.clients)) {
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ error: 'catalog.clients は配列である必要があります' })
      };
    }

    try {
      const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
      const containerClient = blobServiceClient.getContainerClient(containerName);
      await containerClient.createIfNotExists();

      // 上書きする本文を確定（サーバ側で updatedAt を更新）
      const nowIso = new Date().toISOString();
      const toSave = {
        version: Number(catalog.version) || 1,
        updatedAt: nowIso,
        clients: catalog.clients
      };
      const text = JSON.stringify(toSave, null, 2);

      const blockBlobClient = containerClient.getBlockBlobClient(filename);

      // 条件付き（ETag一致時のみ）アップロード
      const options = {
        blobHTTPHeaders: { blobContentType: 'application/json; charset=utf-8' }
      };
      if (etagIfMatch) {
        options.conditions = { ifMatch: etagIfMatch };
      }

      await blockBlobClient.upload(text, Buffer.byteLength(text), options);

      // 新しい ETag を再取得して返す
      const props = await blockBlobClient.getProperties();
      const newEtag = props.etag;

      return {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'ETag': newEtag
        },
        body: JSON.stringify({ ok: true, etag: newEtag, updatedAt: toSave.updatedAt })
      };
    } catch (err) {
      // ETag 不一致 → 409
      if (err?.statusCode === 412) {
        return {
          status: 409,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ error: '競合しました。最新を読み込み直してください。(ETag mismatch)' })
        };
      }

      return {
        status: 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ error: '保存に失敗しました', details: err.message })
      };
    }
  }
});
