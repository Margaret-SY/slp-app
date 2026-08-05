// 言语治疗工作台 — AI 润色代理（Cloudflare Pages Functions）
// 文件路径：functions/api/ai.js
// 浏览器把 {provider, apiKey, model, messages} POST 到这里，
// 函数转发到 DeepSeek（OpenAI 兼容），解决浏览器跨域(CORS)问题。
// 说明：apiKey 由用户在本机浏览器填写，经 https 传到本函数再转发，函数本身不存储密钥。

export async function onRequest(context) {
  var request = context.request;
  var cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: cors });
  }

  var body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: cors });
  }

  var provider = body.provider || 'deepseek';
  var apiKey = body.apiKey || '';
  var model = body.model || 'deepseek-chat';
  var messages = body.messages || [];

  if (!apiKey) {
    return new Response(JSON.stringify({ error: '缺少 API Key' }), { status: 400, headers: cors });
  }
  if (!messages.length) {
    return new Response(JSON.stringify({ error: 'messages 为空' }), { status: 400, headers: cors });
  }

  // 目前只接 DeepSeek（OpenAI 兼容）。以后可在此扩展其它厂商。
  var upstream = 'https://api.deepseek.com/chat/completions';
  var bodyObj = { model: model, messages: messages, stream: false };
  // deepseek-reasoner 不支持 temperature，传了会 400，故仅 chat 模型带该参数
  if (model !== 'deepseek-reasoner') { bodyObj.temperature = 0.7; }
  var upstreamBody = JSON.stringify(bodyObj);

  try {
    var resp = await fetch(upstream, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'Accept': 'application/json'
      },
      body: upstreamBody
    });
    var data = await resp.json();
    if (!resp.ok) {
      var msg = (data && data.error && data.error.message) ? data.error.message : ('上游错误 ' + resp.status);
      return new Response(JSON.stringify({ error: msg }), { status: resp.status, headers: cors });
    }
    var content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return new Response(JSON.stringify({ content: content || '' }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: '上游请求失败：' + (e && e.message ? e.message : e) }), {
      status: 502,
      headers: cors
    });
  }
}
