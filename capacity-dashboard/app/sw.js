// TaskStation PWA Service Worker。
// 方針: アプリシェル（同一オリジン=leo:7010 の HTML/JS/CSS/アイコン）は **ネットワーク優先＋
// キャッシュフォールバック**（作業ツリー直配信で頻繁に更新されるため、オンライン時は常に最新、
// オフライン時は直近キャッシュで起動）。API（別オリジン leo:7005）は素通し（キャッシュしない）。
// データのオフライン同期は対象外（シェル起動＋スタンドアロン化が目的）。
const CACHE = "ts-shell-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // API 等のクロスオリジンは素通し（SWは介入しない）

  e.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) {
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch {
      const cached = await caches.match(req, { ignoreSearch: false });
      if (cached) return cached;
      // ナビゲーションはアプリシェル（index.html）へフォールバック
      if (req.mode === "navigate") {
        const shell = (await caches.match("./index.html")) || (await caches.match("./")) || (await caches.match("index.html"));
        if (shell) return shell;
      }
      return new Response("オフラインです（このリソースはキャッシュされていません）", {
        status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  })());
});
