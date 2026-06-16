/* ============================================================
   安全员B证 刷题 — 云同步 Worker
   存储：Cloudflare KV (binding: SYNC)
   接口：
     GET  /sync/:code   -> 读取该同步码下的数据（无则 {}）
     PUT  /sync/:code   -> 写入该同步码下的数据（JSON 体）
   同步码：4-64 位字母数字/下划线/连字符，既是标识也是访问凭据
   ============================================================ */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,PUT,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(body, status) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: status || 200,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

const MAX_BYTES = 256 * 1024; // 单个同步码最多 256KB

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(req.url);
    const m = url.pathname.match(/^\/sync\/([A-Za-z0-9_-]{4,64})$/);
    if (!m) return json({ error: "not_found" }, 404);
    const key = "s:" + m[1];

    if (req.method === "GET") {
      const v = await env.SYNC.get(key);
      return json(v || "{}");
    }

    if (req.method === "PUT") {
      const body = await req.text();
      if (body.length > MAX_BYTES) return json({ error: "too_large" }, 413);
      try { JSON.parse(body); } catch (e) { return json({ error: "bad_json" }, 400); }
      await env.SYNC.put(key, body);
      return json({ ok: true });
    }

    return json({ error: "method_not_allowed" }, 405);
  },
};
