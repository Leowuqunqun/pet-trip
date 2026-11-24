/* 带狗去哪儿 · 离线兜底（2026-11-23）
 *
 * 为什么要有：营地、山里、海边信号经常没有，打开就是白屏；而且没有 fetch handler
 * 的 service worker 浏览器不给「添加到主屏幕」。这两件事都值得一个 SW。
 *
 * 缓存策略是故意分开的：
 *   页面 / 数据   → 网络优先（先要新的，超时或断网才用上次的）
 *                   —— 页面如果走缓存优先，改完你永远看不到新的，这正是本项目的头号事故。
 *   图片/样式/脚本 → 缓存优先（这些改得少，第二次打开快很多）
 *   第三方瓦片     → 完全不碰（跨域、量大，缓存了反而拖慢首屏）
 */
const VERSION = "pp-shell-v2";
const SHELL = ["./", "index.html", "manifest.json", "icon-192.png", "icon-512.png"];
const NET_TIMEOUT = 3500;        // 网络优先最多等这么久，超过就当没网
const IMG_CAP = 400;             // 图片缓存条数上限，超了从最旧的开始砍

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(VERSION)
      .then(function (c) { return Promise.all(SHELL.map(function (u) {
        return c.add(new Request(u, { cache: "no-cache" })).catch(function () {});
      })); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== VERSION; })
                               .map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
      .then(trimImages)
  );
});

async function trimImages() {
  try {
    const c = await caches.open(VERSION);
    const keys = await c.keys();
    const imgs = keys.filter(function (r) { return /\.(png|jpe?g|webp|svg)$/i.test(new URL(r.url).pathname); });
    if (imgs.length <= IMG_CAP) return;
    for (const r of imgs.slice(0, imgs.length - IMG_CAP)) await c.delete(r);
  } catch (e) { /* 清缓存失败不影响页面 */ }
}

async function networkFirst(req) {
  const c = await caches.open(VERSION);
  try {
    const net = fetch(req);
    const timeout = new Promise(function (_, rej) {
      setTimeout(function () { rej(new Error("timeout")); }, NET_TIMEOUT);
    });
    const res = await Promise.race([net, timeout]);
    if (res && res.ok) c.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = (await c.match(req, { ignoreSearch: true })) ||
                (await c.match("index.html"));
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req) {
  const c = await caches.open(VERSION);
  const hit = await c.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok) c.put(req, res.clone());
  return res;
}

self.addEventListener("fetch", function (e) {
  const req = e.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;      // 瓦片/CDN 一律不碰

  const isDoc = req.mode === "navigate" || /\/$|index\.html$/.test(url.pathname);
  /* spots-detail.json 也必须走这条：2026-11-24 拆包后详情来源是单独的文件，
     原来只匹配 spots.json → 点开详情时离线直接失败（山里没信号正是它的用处）。 */
  const isData = /spots(-detail)?\.json$/.test(url.pathname);
  if (isDoc || isData) { e.respondWith(networkFirst(req)); return; }
  if (/\.(png|jpe?g|webp|svg|css|js|woff2?)$/i.test(url.pathname)) {
    e.respondWith(cacheFirst(req));
  }
});
