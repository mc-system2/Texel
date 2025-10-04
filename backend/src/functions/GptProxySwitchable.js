const { app } = require('@azure/functions');

app.http('GPTProxySwitcher', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    let body;
    try {
      body = await request.json();
    } catch {
      return {
        status: 400,
        body: JSON.stringify({ error: 'リクエストボディが不正です' }),
      };
    }

    // gptmode を取り出して削除（internal / external）
    const gptmode = body.gptmode || 'external';
    delete body.gptmode;

    // purpose を元に miniモデル使用判定
    const purpose = (body.purpose || '').toLowerCase();
    const useMini = ["text", "suggestion", "caption", "pdf", "memo", "hashtags", "suumo-catch", "suumo-comment", "athome-comment", "athome-appeal"].includes(purpose);
    delete body.purpose;


    context.log(`gptmode = ${gptmode}, purpose = ${purpose}, useMini = ${useMini}`);

    // ChatGPT APIに不要なフィールドを退避
    const spreadsheetId = body.spreadsheetId;
    const propertyCode = body.propertyCode;
    const userId    = body.userId;
    const userAgent = body.userAgent;
    const clientIp      = body.clientIp                            // ★ body 優先
                      || request.headers['x-client-ip']            // ★ 明示ヘッダ
                      || request.headers['x-forwarded-for'] || ''; // ★ Fallback    
    delete body.spreadsheetId;
    delete body.propertyCode;
    delete body.userId;
    delete body.userAgent;
    delete body.clientIp;

    // 選択されたモデルに応じて環境変数キーを組み立て
    const modePrefix = gptmode.toUpperCase();
    const suffix = useMini ? '_GPT_MINI' : '_GPT';

    const endpoint = process.env[`${modePrefix}${suffix}_ENDPOINT`];
    const apiKey = process.env[`${modePrefix}${suffix}_KEY`];

    context.log(`endpoint = ${endpoint}`);
    context.log(`apiKey = ${apiKey ? '(取得済み)' : '(なし)'}`);

    if (!endpoint || !apiKey) {
      return {
        status: 500,
        body: JSON.stringify({ error: `API設定 (${modePrefix}${suffix}) が不足しています` }),
      };
    }

    try {
      // ChatGPT API 呼び出し
      const upstream = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': apiKey,
        },
        body: JSON.stringify(body),
      });

      const result = await upstream.json();

      // ✅ GASログ送信（ログ出力付き）
      try {
        const gasPayload = {
          logType: 'gptAnalysis',
          spreadsheetId: spreadsheetId,
          propertyCode: propertyCode || '',
          clientIp,          // ← header 由来
          userId,            // ← body から来る
          model: result.model || '',
          prompt_tokens: result.usage?.prompt_tokens || 0,
          completion_tokens: result.usage?.completion_tokens || 0,
          total_tokens: result.usage?.total_tokens || 0,
          purpose  // ✅ GPT用途（text / image 等）
        };
        context.log("📤 GAS送信データ:", JSON.stringify(gasPayload));

        const gasResponse = await fetch(process.env['GAS_LOG_ENDPOINT'], {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(gasPayload)
        });

        const gasText = await gasResponse.text();
        context.log("✅ GASログ送信完了:", gasText);
      } catch (logErr) {
        context.log("⚠️ GASログ送信失敗:", logErr.message);
      }

      return {
        status: upstream.status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result),
      };
    } catch (err) {
      return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'プロキシ呼び出しに失敗しました',
          details: err.message,
        }),
      };
    }
  },
});
