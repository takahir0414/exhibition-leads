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
    const geminiRes = await fetch(
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
      }
    );

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
    res.status(500).json({ error: e.message });
  }
};
