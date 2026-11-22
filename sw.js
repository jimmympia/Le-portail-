/* Portail Parents 2.3.131 — service worker : coque hors ligne, notifications push, jamais l'API en cache */
const CACHE = 'portail-parents-2-3-131';
const SHELL = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.indexOf('/api/') !== -1) return; // serveur central : toujours le réseau
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put('./index.html', copy)); return r; }).catch(() => caches.match('./index.html')));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return r; })));
});

/* ----- Notifications push ----- */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Portail Parents', {
    body: d.body || '', icon: 'icon-192.png', badge: 'icon-192.png', tag: d.tag || 'pp', renotify: true,
    data: { page: d.page || 'messages' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const page = (e.notification.data && e.notification.data.page) || 'messages';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) { c.postMessage({ type: 'pp-open', page }); return c.focus(); } }
    return self.clients.openWindow('./?open=' + encodeURIComponent(page));
  }));
});
