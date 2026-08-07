// Service worker minimal pour l'installabilité PWA.
// Stratégie : réseau d'abord (l'app a besoin de données fraîches : jobs, biblio),
// avec repli sur le cache de l'app-shell hors-ligne. On ne met JAMAIS en cache
// l'API ni les images de manga (contenu dynamique / lourd).

const CACHE = 'mangalib-shell-v3';
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

  // On ne touche pas à l'API ni aux médias distants (mangadex, etc.)
  if (url.pathname.startsWith('/api/') || url.origin !== self.location.origin) return;

  // Navigation (SPA) : réseau d'abord, repli index.html hors-ligne.
  if (request.mode === 'navigate') {
    e.respondWith(fetch(request).catch(() => caches.match('/index.html')));
    return;
  }

  // Boucles d'ambiance : l'URL est STABLE (/ambience/<label>.opus, pas de hash) → en
  // cache-first le son resterait figé après remplacement d'une piste. On passe donc en
  // stale-while-revalidate : on sert le cache tout de suite (rapide/offline) MAIS on
  // re-télécharge en arrière-plan pour rafraîchir la piste au prochain coup.
  if (url.pathname.startsWith('/ambience/')) {
    e.respondWith(
      caches.open(CACHE).then((c) =>
        c.match(request).then((hit) => {
          const net = fetch(request)
            .then((res) => { if (res.ok) c.put(request, res.clone()); return res; })
            .catch(() => hit);
          return hit || net;
        })
      )
    );
    return;
  }

  // Assets statiques : cache d'abord, sinon réseau (et on met en cache).
  e.respondWith(
    caches.match(request).then((hit) =>
      hit || fetch(request).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(request, copy)); }
        return res;
      }).catch(() => hit)
    )
  );
});
