// 言语治疗工作台 — 学习库热点订阅代理（Cloudflare Pages Functions）
// 文件路径：functions/api/feed.js
// 服务端抓取：
//   ① Bing News RSS（中文关键词，聚焦 技能/干预/研究/循证）
//   ② PubMed E-utilities（真实学术论文，标题+摘要+原文链接，分类「论文」）
//   ③ Google News（兜底，常被 503 封锁，失败即忽略）
//   ④ ScienceDaily（英文健康兜底，保证不空军）
// 解决：① 浏览器跨域(CORS) ② 国内网络无法直接访问（函数在 Cloudflare 境外边缘执行，用户经 pages.dev 间接拿到）。

export async function onRequest(context) {
  var cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
  // Bing 关键词：聚焦技能 / 干预 / 研究 / 循证，而非泛新闻
  var bingKw = ['儿童语言治疗 技能', '儿童康复 干预 研究', '孤独症 干预 论文', '言语矫治 技术', '儿童语言 发育 循证', '儿童保健 指南'];
  // PubMed 查询：真实学术论文（英文，覆盖言语/语言/孤独症/发育）
  var pubmedKw = ['pediatric speech therapy', 'child language disorder', 'autism intervention', 'childhood apraxia of speech', 'preschool language development'];
  var diag = [];

  function trySrc(kw, url, label) {
    return fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9' } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function (xml) {
        if (/^\s*<!doctype|<html/i.test(xml)) throw new Error('HTML-not-RSS');
        var a = xml ? parseRSS(xml, kw) : [];
        diag.push({ src: label, kw: kw, err: null, got: a.length });
        return a;
      })
      .catch(function (e) { diag.push({ src: label, kw: kw, err: String(e && e.message ? e.message : e), got: 0 }); return []; });
  }

  // PubMed：每个关键词先 esearch 拿 id，再一次性 efetch 解析（减少请求数，避免限流）
  function pubmedAll() {
    return Promise.all(pubmedKw.map(function (term) {
      var u = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=4&term=' + encodeURIComponent(term);
      return fetch(u, { headers: { 'User-Agent': UA } })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var ids = (j.esearchresult && j.esearchresult.idlist) || [];
          return ids.map(function (id) { return { id: id, term: term }; });
        })
        .catch(function () { return []; });
    })).then(function (lists) {
      var flat = [];
      lists.forEach(function (l) { flat = flat.concat(l); });
      if (!flat.length) { diag.push({ src: 'pubmed', kw: '__all__', err: null, got: 0 }); return []; }
      var idStr = flat.map(function (x) { return x.id; }).join(',');
      var fUrl = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&retmode=xml&id=' + idStr;
      return fetch(fUrl, { headers: { 'User-Agent': UA } }).then(function (r) { return r.text(); }).then(function (xml) {
        var arts = xml.match(/<PubmedArticle>[\s\S]*?<\/PubmedArticle>/gi) || [];
        var map = {}; flat.forEach(function (x) { map[x.id] = x.term; });
        var out = [];
        for (var i = 0; i < arts.length && out.length < 16; i++) {
          var a = arts[i];
          var pmid = clean(grab(a, 'PMID'));
          var title = clean(grab(a, 'ArticleTitle'));
          var abs = clean(grab(a, 'AbstractText')).slice(0, 200);
          var jour = clean(grab(a, 'Title'));
          var year = clean(grab(a, 'Year'));
          if (title && pmid) out.push({ title: title, link: 'https://pubmed.ncbi.nlm.nih.gov/' + pmid + '/', desc: abs, source: 'PubMed·' + jour, date: year, kw: map[pmid] || '论文', cat: '论文', ts: Date.now() - i });
        }
        diag.push({ src: 'pubmed', kw: '__all__', err: null, got: out.length });
        return out;
      }).catch(function (e) { diag.push({ src: 'pubmed', kw: '__all__', err: String(e), got: 0 }); return []; });
    }).catch(function () { return []; });
  }

  var tasks = [];
  bingKw.forEach(function (kw) {
    tasks.push(trySrc(kw, 'https://www.bing.com/news/search?q=' + encodeURIComponent(kw) + '&format=rss&setlang=zh-CN', 'bing'));
    tasks.push(trySrc(kw, 'https://news.google.com/rss/search?q=' + encodeURIComponent(kw) + '&hl=zh-CN&gl=CN&ceid=CN:zh-Hans', 'google'));
  });

  var newsRes, pmRes;
  try { newsRes = await Promise.all(tasks); } catch (e) { newsRes = []; }
  try { pmRes = await pubmedAll(); } catch (e) { pmRes = []; }

  var items = [];
  var seen = {};
  function pushArr(arr) {
    for (var j = 0; j < arr.length; j++) {
      var it = arr[j];
      var key = it.link || it.title;
      if (key && !seen[key]) { seen[key] = 1; items.push(it); }
    }
  }
  for (var i = 0; i < newsRes.length; i++) pushArr(newsRes[i] || []);
  pushArr(pmRes || []);

  var fallback = false;
  if (items.length === 0) {
    fallback = true;
    try {
      var r2 = await fetch('https://www.sciencedaily.com/rss/health_medicine.xml', { headers: { 'User-Agent': UA } });
      if (r2.ok) {
        var x2 = await r2.text();
        var p2 = parseRSS(x2, '国际医学前沿');
        for (var m = 0; m < p2.length; m++) {
          var k2 = p2[m].link || p2[m].title;
          if (k2 && !seen[k2]) { seen[k2] = 1; items.push(p2[m]); }
        }
      }
    } catch (e) { diag.push({ src: 'sciencedaily', kw: '__fb__', err: String(e), got: 0 }); }
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
  var limit = Math.min(blocks.length, 2);
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
