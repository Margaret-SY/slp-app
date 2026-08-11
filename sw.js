/* 言语治疗工作台 · 离线缓存 Service Worker
   作用：首次联网打开后，之后断网也能打开；数据存在各设备浏览器本地。
   注意：本 SW 只缓存“程序外壳”，不缓存任何业务数据（数据在 localStorage）。 */
var CACHE = 'slp-v14';
var ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-180.png',
  './icon-512.png'
];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(ASSETS);
  }).catch(function () { /* 个别资源失败不阻断安装 */ }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.map(function (k) {
      if (k !== CACHE) return caches.delete(k);
    }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  // 导航请求：先联网拿最新页面并缓存，失败则回退到已缓存的页面（离线可用）
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (r) {
        var cp = r.clone();
        caches.open(CACHE).then(function (c) { c.put('./index.html', cp); });
        return r;
      }).catch(function () {
        return caches.match('./index.html');
      })
    );
    return;
  }

  // 其他静态资源：缓存优先，未命中再联网并缓存
  // 关键：API 请求（/api/）永远走 network，不读 SW 缓存也不写 SW 缓存。
  // 否则首次 SW 拦截到的失败 / 空 / 旧响应会一直返回，导致热点永远不更新。
  // 离线下返回空 JSON，让前端走「失败不锁死」逻辑，下次联网再重试。
  var url = (req.url || '');
  if (url.indexOf('/api/') >= 0) {
    e.respondWith(
      fetch(req).catch(function () {
        return new Response('{"items":[],"count":0,"_err":"offline"}',
          { headers: { 'Content-Type': 'application/json' } });
      })
    );
    return;
  }
  e.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return cached;
      return fetch(req).then(function (r) {
        if (r && r.ok) {
          var cp = r.clone();
          caches.open(CACHE).then(function (c) { c.put(req, cp); });
        }
        return r;
      });
    })
  );
});
