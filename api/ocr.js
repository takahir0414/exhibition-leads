// Gemini無料枠は1分あたり20リクエストまで。全員が同時に読み取ると
// 上限を超えてGemini側が混雑し、応答遅延やエラー(502)につながるため、
// Gemini呼び出し前にこちら側で件数を数え、上限に近い場合は呼び出さずに
// 429(待ち時間つき)を即座に返す。これによりGemini側への同時アクセスの
// 集中を抑え、失敗を速く・確実に検知できるようにする。
const OCR_LIMIT_PER_MINUTE = 15;

function getRedisConfig() {
  const url =
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.KV_REST_API_URL ||
    process.env.REDIS_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.KV_REST_API_TOKEN ||
    process.env.REDIS_TOKEN;
  return { url, token };
}

async function redisCall(url, token, command) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Redis error');
  return data.result;
}

async function checkRateLimit() {
  const { url, token } = getRedisConfig();
  if (!url || !token) return { limited: false };
  const bucket = Math.floor(Date.now() / 60000);
  const key = `ocr-ratelimit:${bucket}`;
  try {
    const count = await redisCall(url, token, ['INCR', key]);
    if (count === 1) {
      await redisCall(url, token, ['EXPIRE', key, 65]);
    }
    if (count > OCR_LIMIT_PER_MINUTE) {
      const retryAfter = 60 - (Math.floor(Date.now() / 1000) % 60);
      return { limited: true, retryAfter };
    }
    return { limited: false };
  } catch (e) {
    return { limited: false };
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { image, mimeType } = req.body || {};
  if (!image) {
    res.status(400).json({ error: 'image is required' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'server not configured' });
    return;
  }

  const rateLimit = await checkRateLimit();
  if (rateLimit.limited) {
    res.status(429).json({
      error: '混み合っています(サーバー側の同時実行制限)',
      retryAfter: rateLimit.retryAfter,
    });
    return;
  }

  const prompt = `この名刺画像から以下の項目を抽出し、JSON形式のみで出力してください（説明文やコードブロック記法は不要、生のJSONのみ）。
{
  "company": "会社名",
  "name": "氏名",
  "department": "部署",
  "position": "役職",
  "phone": "電話番号（固定電話があれば優先、なければ携帯番号）",
  "email": "メールアドレス",
  "address": "住所"
}
読み取れない項目は空文字にしてください。`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let geminiRes;
    try {
      geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: prompt },
                { inline_data: { mime_type: mimeType || 'image/jpeg', data: image } },
              ],
            }],
          }),
          signal: controller.signal,
        }
      );
    } finally {
      clearTimeout(timeout);
    }

    const data = await geminiRes.json();
    if (!geminiRes.ok) {
      // 無料枠のレート制限に達した場合は429で返し、待ち時間をクライアントに伝える
      if (geminiRes.status === 429 || data.error?.status === 'RESOURCE_EXHAUSTED') {
        const retryInfo = data.error?.details?.find(d => d.retryDelay);
        const secondsMatch = (data.error?.message || '').match(/retry in ([\d.]+)s/i);
        const retryAfter = retryInfo
          ? parseFloat(retryInfo.retryDelay)
          : secondsMatch
          ? parseFloat(secondsMatch[1])
          : 20;
        res.status(429).json({ error: data.error?.message || 'rate limited', retryAfter });
        return;
      }
      res.status(502).json({ error: data.error?.message || 'Gemini API error' });
      return;
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      res.status(502).json({ error: 'no JSON in response' });
      return;
    }

    const parsed = JSON.parse(jsonMatch[0]);
    res.status(200).json(parsed);
  } catch (e) {
    if (e.name === 'AbortError') {
      res.status(429).json({ error: 'timeout(混雑中)', retryAfter: 10 });
      return;
    }
    res.status(500).json({ error: e.message });
  }
};
