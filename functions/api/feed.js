// 言语治疗工作台 — 学习库热点订阅代理（Cloudflare Pages Functions）
// 文件路径：functions/api/feed.js
// 服务端抓取 Google News RSS(中文关键词) + ScienceDaily 兜底，返回统一 JSON。
// 解决两件事：① 浏览器跨域(CORS) ② 国内网络无法直连 Google（函数在 Cloudflare 境外边缘执行，用户经 pages.dev 间接拿到）。

export async function onRequest(context) {
  var cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  // 覆盖用户列出的领域：语言/康复/保健/心理/行为/营养
  var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
  var keywords = ['儿童语言治疗', '儿童康复', '儿童保健', '儿童心理', '儿童行为', '儿童营养'];
  var diag = [];
  var tasks = keywords.map(function (kw) {
    var url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(kw) + '&hl=zh-CN&gl=CN&ceid=CN:zh-Hans';
    return fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9' } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function (xml) { var a = xml ? parseRSS(xml, kw) : []; diag.push({ kw: kw, err: null, got: a.length }); return a; })
      .catch(function (e) { diag.push({ kw: kw, err: String(e && e.message ? e.message : e), got: 0 }); return []; });
  });

  var results;
  try { results = await Promise.all(tasks); } catch (e) { results = []; diag.push({ kw: '__all__', err: String(e), got: 0 }); }

  var items = [];
  var seen = {};
  for (var i = 0; i < results.length; i++) {
    var arr = results[i] || [];
    for (var j = 0; j < arr.length; j++) {
      var it = arr[j];
      var key = it.link || it.title;
      if (key && !seen[key]) { seen[key] = 1; items.push(it); }
    }
  }

  var fallback = false;
  if (items.length === 0) {
    fallback = true;
    try {
      var r2 = await fetch('https://www.sciencedaily.com/rss/health_medicine.xml', { headers: { 'User-Agent': UA } });
      if (r2.ok) {
        var xml2 = await r2.text();
        var p2 = parseRSS(xml2, '国际医学前沿');
        for (var m = 0; m < p2.length; m++) {
          var k2 = p2[m].link || p2[m].title;
          if (k2 && !seen[k2]) { seen[k2] = 1; items.push(p2[m]); }
        }
      }
    } catch (e) { diag.push({ kw: '__fallback__', err: String(e), got: 0 }); }
  }

  items.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
  var out = items.slice(0, 40);
  return new Response(JSON.stringify({ ok: out.length > 0, count: out.length, items: out, fallback: fallback, diag: diag }), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }
  });
}

function parseRSS(xml, kw) {
  var out = [];
  if (!xml) return out;
  var blocks = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
  var limit = Math.min(blocks.length, 3);
  for (var i = 0; i < limit; i++) {
    var b = blocks[i];
    var title = clean(grab(b, 'title'));
    var link = clean(grab(b, 'link'));
    var pub = clean(grab(b, 'pubDate'));
    var desc = clean(grab(b, 'description')).slice(0, 160);
    var src = '';
    var sm = b.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
    if (sm) src = clean(sm[1]);
    var ts = 0;
    try { ts = pub ? Date.parse(pub) : 0; } catch (e) {}
    if (title) out.push({ title: title, link: link, desc: desc, source: src, date: pub, kw: kw, cat: '热点', ts: ts });
  }
  return out;
}
function grab(block, tag) {
  var m = block.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
  return m ? m[1] : '';
}
function clean(s) {
  if (!s) return '';
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
