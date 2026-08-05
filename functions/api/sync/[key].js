// 言语治疗工作台 — 同源同步后端（Cloudflare Pages Functions）
// 文件路径：functions/api/sync/[key].js
// 部署：pages 项目绑 KV（变量名 SLP）即可，无需再管 worker.dev。

export async function onRequest(context) {
  var request = context.request;
  var env = context.env;
  var params = context.params;

  var key = params && params.key ? params.key : '';
  var cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (!key) {
    return new Response('missing key', { status: 400, headers: cors });
  }

  try {
    if (request.method === 'GET') {
      var v = await env.SLP.get(key);
      return new Response(v || '', {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    if (request.method === 'PUT' || request.method === 'POST') {
      var body = await request.text();
      if (!body) {
        return new Response('empty body', { status: 400, headers: cors });
      }
      await env.SLP.put(key, body);
      return new Response('ok', { status: 200, headers: cors });
    }
    return new Response('method not allowed', { status: 405, headers: cors });
  } catch (e) {
    return new Response('server error: ' + (e && e.message ? e.message : e), {
      status: 500,
      headers: cors
    });
  }
}
