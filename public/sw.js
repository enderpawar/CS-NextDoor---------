// Service Worker — nextdoor-cs
// ⚠️ 배포마다 버전 올릴 것 (구버전 캐시와 새 API 충돌 방지)
const CACHE = 'nextdoorcs-v5';

// opencv.js (~8MB) 반드시 포함 — WASM 오프라인 동작 필수
const PRECACHE = [
  '/',
  '/index.html',
  '/opencv.js',
  '/manifest.json',
  '/icons/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  // 이전 버전 캐시 모두 삭제
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  // /api/* 요청은 캐시 사용 안 함 — 항상 네트워크
  if (event.request.url.includes('/api/')) return;

  if (event.request.mode === 'navigate' || event.request.url.endsWith('/index.html')) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).catch(() =>
        // 네트워크 장애 폴백: index.html 반환 (SPA 라우팅 유지)
        caches.match('/index.html')
      );
    })
  );
});
