// Service worker : app-shell hors-ligne + assets hashés en cache (rapidité), MAIS
// l'AUDIO d'ambiance (/ambience/*.opus) n'est JAMAIS mis en cache — toujours servi EN
// DIRECT depuis le serveur (le serveur fait foi). Ainsi un remplacement de piste est
// audible immédiatement, sans que l'utilisateur ait à vider quoi que ce soit.

const CACHE = 'mangalib-shell-v4';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // API et médias distants : on ne touche pas.
  if (url.pathname.startsWith('/api/') || url.origin !== self.location.origin) return;

  // AUDIO d'ambiance : TOUJOURS le serveur, jamais le cache (on force la revalidation et
  // on ne stocke rien). Repli sur un éventuel ancien cache uniquement si hors-ligne.
  if (url.pathname.startsWith('/ambience/')) {
    e.respondWith(fetch(request, { cache: 'no-cache' }).catch(() => caches.match(request)));
    return;
  }

  // Navigation (SPA) : réseau d'abord, repli index.html hors-ligne.
  if (request.mode === 'navigate') {
    e.respondWith(fetch(request).catch(() => caches.match('/index.html')));
    return;
  }

  // Assets statiques (hashés, immuables) : cache d'abord, sinon réseau (et on met en cache).
  e.respondWith(
    caches.match(request).then((hit) =>
      hit || fetch(request).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(request, copy)); }
        return res;
      }).catch(() => hit)
    )
  );
});
