// Upstash Redis REST APIを使い、全員が同じリードデータを共有する。
// 1件ずつHash（フィールド=リードID）で保持することで、件数が増えても
// 1回のリクエストサイズが肥大化しないようにしている（全件をまとめて
// 保存する方式だと、件数が増えるほどリクエストが大きくなり、上限を
// 超えた時点で同期が失敗してしまうため）。
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

const LEADS_KEY = 'exhibition-leads:hash:v1';

module.exports = async (req, res) => {
  const { url, token } = getRedisConfig();
  if (!url || !token) {
    res.status(500).json({ error: 'storage not configured' });
    return;
  }

  try {
    if (req.method === 'GET') {
      const raw = await redisCall(url, token, ['HGETALL', LEADS_KEY]);
      const leads = [];
      if (Array.isArray(raw)) {
        for (let i = 0; i < raw.length; i += 2) {
          try {
            leads.push(JSON.parse(raw[i + 1]));
          } catch (e) {
            // 壊れたレコードはスキップ
          }
        }
      }
      res.status(200).json({ leads });
      return;
    }

    if (req.method === 'POST') {
      const { lead } = req.body || {};
      if (!lead || !lead.id) {
        res.status(400).json({ error: 'lead with id is required' });
        return;
      }
      await redisCall(url, token, ['HSET', LEADS_KEY, lead.id, JSON.stringify(lead)]);
      res.status(200).json({ ok: true });
      return;
    }

    if (req.method === 'DELETE') {
      const id = req.query?.id;
      if (!id) {
        res.status(400).json({ error: 'id is required' });
        return;
      }
      await redisCall(url, token, ['HDEL', LEADS_KEY, id]);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
