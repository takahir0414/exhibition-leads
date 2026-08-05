// Upstash Redis REST APIを使い、全員が同じリードデータを共有する
function getRedisConfig() {
  const url =
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.REDIS_URL;
  const token =
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
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

const LEADS_KEY = 'exhibition-leads:v1';

module.exports = async (req, res) => {
  const { url, token } = getRedisConfig();
  if (!url || !token) {
    res.status(500).json({ error: 'storage not configured' });
    return;
  }

  try {
    if (req.method === 'GET') {
      const raw = await redisCall(url, token, ['GET', LEADS_KEY]);
      const leads = raw ? JSON.parse(raw) : [];
      res.status(200).json({ leads });
      return;
    }

    if (req.method === 'PUT') {
      const { leads } = req.body || {};
      if (!Array.isArray(leads)) {
        res.status(400).json({ error: 'leads array is required' });
        return;
      }
      await redisCall(url, token, ['SET', LEADS_KEY, JSON.stringify(leads)]);
      res.status(200).json({ ok: true, count: leads.length });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
