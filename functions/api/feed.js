// 言语治疗工作台 — 学习库热点订阅代理（Cloudflare Pages Functions）
// 文件路径：functions/api/feed.js
// 服务端抓取：
//   ① Bing News RSS（中文关键词，聚焦 技能/干预/研究/循证）
//   ② Europe PMC + OpenAlex（真实学术论文，标题+摘要+原文链接，分类「论文」；NCBI 封 CF 故不用）
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

  // 论文源：Europe PMC（EBI，生物医学，带摘要，对数据中心 IP 友好）+ OpenAlex（开放备份）
  // 注：PubMed(NCBI) 会封 Cloudflare 边缘 IP，故不用；这两个 API 专为程序化访问设计。
  function paperAll() {
    var tasks = [];
    pubmedKw.forEach(function (term) {
      tasks.push(epmcSearch(term));
      tasks.push(openalexSearch(term));
    });
    return Promise.all(tasks).then(function (lists) {
      var out = [];
      var seen = {};
      for (var i = 0; i < lists.length; i++) {
        var arr = lists[i] || [];
        for (var j = 0; j < arr.length; j++) {
          var it = arr[j];
          var key = it.link || it.title;
          if (key && !seen[key]) { seen[key] = 1; out.push(it); }
        }
      }
      return out;
    }).catch(function () { return []; });
  }

  function epmcSearch(term) {
    var u = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=' + encodeURIComponent(term) + '&format=json&pageSize=4&resultType=core';
    return fetch(u, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var res = (j.resultList && j.resultList.result) || [];
        var out = [];
        for (var i = 0; i < res.length && out.length < 4; i++) {
          var x = res[i];
          var title = clean(x.title || '');
          if (!title) continue;
          var abs = clean(x.abstractText || '').slice(0, 200);
          var doi = x.doi || '';
          var src = x.source || '';
          var id = x.id || '';
          var link = doi ? ('https://doi.org/' + doi) : ('https://europepmc.org/article/' + src + '/' + id);
          var yr = x.firstPublicationDate || x.pubYear || '';
          var jour = (x.journalInfo && x.journalInfo.journal && x.journalInfo.journal.title) || '文献';
          out.push({ title: title, link: link, desc: abs, source: 'EuropePMC·' + jour, date: yr, kw: term, cat: '论文', ts: Date.now() - i });
        }
        diag.push({ src: 'epmc', kw: term, err: null, got: out.length });
        return out;
      })
      .catch(function (e) { diag.push({ src: 'epmc', kw: term, err: String(e && e.message ? e.message : e), got: 0 }); return []; });
  }

  function openalexSearch(term) {
    var u = 'https://api.openalex.org/works?search=' + encodeURIComponent(term) + '&per_page=4&select=title,abstract_inverted_index,doi,publication_year,primary_location';
    return fetch(u, { headers: { 'User-Agent': UA } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var res = j.results || [];
        var out = [];
        for (var i = 0; i < res.length && out.length < 4; i++) {
          var x = res[i];
          var title = clean(x.title || '');
          if (!title) continue;
          var abs = clean(reconstructAbstract(x.abstract_inverted_index)).slice(0, 200);
          var doi = x.doi || '';
          var loc = (x.primary_location && x.primary_location.landing_page_url) || '';
          var link = doi ? ('https://doi.org/' + doi) : (loc || x.id);
          out.push({ title: title, link: link, desc: abs, source: 'OpenAlex', date: String(x.publication_year || ''), kw: term, cat: '论文', ts: Date.now() - i });
        }
        diag.push({ src: 'openalex', kw: term, err: null, got: out.length });
        return out;
      })
      .catch(function (e) { diag.push({ src: 'openalex', kw: term, err: String(e && e.message ? e.message : e), got: 0 }); return []; });
  }

  function reconstructAbstract(idx) {
    if (!idx) return '';
    var max = 0, w;
    for (w in idx) { var arr = idx[w]; for (var m = 0; m < arr.length; m++) if (arr[m] > max) max = arr[m]; }
    var a = new Array(max + 1);
    for (w in idx) { var pos = idx[w]; for (var n = 0; n < pos.length; n++) a[pos[n]] = w; }
    return (a.join(' ') || '').replace(/\s+/g, ' ').trim();
  }

  var tasks = [];
  bingKw.forEach(function (kw) {
    tasks.push(trySrc(kw, 'https://www.bing.com/news/search?q=' + encodeURIComponent(kw) + '&format=rss&setlang=zh-CN', 'bing'));
    tasks.push(trySrc(kw, 'https://news.google.com/rss/search?q=' + encodeURIComponent(kw) + '&hl=zh-CN&gl=CN&ceid=CN:zh-Hans', 'google'));
  });

  var newsRes, pmRes;
  try { newsRes = await Promise.all(tasks); } catch (e) { newsRes = []; }
  try { pmRes = await paperAll(); } catch (e) { pmRes = []; }

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
