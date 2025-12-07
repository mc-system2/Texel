// LoadClientCatalog.js
const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');

const connectionString = process.env['AzureWebJobsStorage'];
const containerName = 'prompts';

app.http('LoadClientCatalog', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    context.log('◆ LoadClientCatalog - START');

    const filename = request.query.get('filename') || 'texel-client-catalog.json';
    if (!filename) {
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ error: 'filename が必要です' })
      };
    }

    try {
      const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
      const containerClient = blobServiceClient.getContainerClient(containerName);
      const blobClient = containerClient.getBlobClient(filename);

      const exists = await blobClient.exists();
      if (!exists) {
        return {
          status: 404,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ error: '指定されたファイルが存在しません' })
        };
      }

      const props = await blobClient.getProperties();
      const etag = props.etag;

      const dl = await blobClient.download();
      const text = await streamToString(dl.readableStreamBody);

      // JSONとして妥当か一度だけ確認（壊れていてもそのまま文字列で返すとフロントが困るため）
      let json;
      try { json = JSON.parse(text); }
      catch (e) {
        return {
          status: 500,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ error: 'BLOBが不正なJSONです', details: String(e?.message || e) })
        };
      }

      return {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'ETag': etag
        },
        body: JSON.stringify(json)
      };
    } catch (err) {
      context.log('◆ Load 例外:', err);
      return {
        status: 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ error: '読み込みに失敗しました', details: err.message })
      };
    }
  }
});

async function streamToString(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on('data', d => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    readable.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    readable.on('error', reject);
  });
}
