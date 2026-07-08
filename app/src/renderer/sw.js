const CACHE_NAME = 'kenchiku-boost-v3';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/renderer.js',
  '/manifest.json'
];

// Install: cache static assets（取得できないものがあっても失敗させない=best-effort）
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(STATIC_ASSETS.map((u) => cache.add(u).catch(() => null)))
    )
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// 静的アセット（JS/CSS/wasm/画像/フォント）判定。遅延ロードのチャンク(*.chunk.js)もここに入る。
function isStaticAsset(pathname) {
  return /\.(js|mjs|css|map|png|jpe?g|svg|gif|webp|ico|woff2?|ttf|eot|wasm)$/i.test(pathname);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // API: ネットワークのみ（キャッシュしない）。失敗時はJSONで503。
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(req).catch(() =>
        new Response(JSON.stringify({ error: 'オフラインです。ネットワーク接続を確認してください。' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // 静的アセット: キャッシュ優先（cache-first）。
  // 一度でも読み込めばキャッシュから即返すので、外出先トンネル(loca.lt)が一瞬切れても
  // AI見積などの遅延チャンク(533.chunk.js等)の読み込みが失敗せず、ページが開かなくなる問題を防ぐ。
  // ※ ネット失敗時に偽の503を返さない（スクリプトに503を返すとチャンク破損=画面が開かない原因になる）。
  if (isStaticAsset(url.pathname)) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        });
        // fetchが失敗した場合はそのままネットワークエラーを伝播（ブラウザが再試行できる）
      })
    );
    return;
  }

  // ナビゲーション/HTML等: ネットワーク優先、失敗時はキャッシュ（無ければ '/'）。
  event.respondWith(
    fetch(req)
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        return res;
      })
      .catch(() =>
        caches.match(req).then((cached) => cached || caches.match('/'))
      )
  );
});
