// Home Ground Facility app — keeps the app working with no signal, and shows push notifications.
// Bump VERSION whenever any app file changes so phones pick up the new copy.
const VERSION = 'hg-facility-v13';
const ICON = 'icon-192.png';
const SHELL = ['./', 'index.html', 'app.js', 'push.js', 'config.js', 'manifest.webmanifest',
  'logo.png', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

// Only clear this app's old copies: the hunter and landowner apps share this web address.
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('hg-facility-') && k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// App files: try the network first (so updates arrive), fall back to the saved copy offline.
// Calls to the Home Ground backend are never cached.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
  e.respondWith(
    fetch(e.request)
      .then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request).then(r => r || caches.match('index.html')))
  );
});

self.addEventListener('push', e => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch (err) { /* not JSON */ }
  const d = p.data || {}, n = p.notification || {};
  e.waitUntil(self.registration.showNotification(d.title || n.title || 'Home Ground Facility', {
    body: d.body || n.body || '', icon: ICON, badge: ICON, tag: d.tag || undefined, renotify: !!d.tag,
    requireInteraction: /^(URGENT|Help needed|Cooler full)/.test(d.title || ''), data: { url: d.url || self.registration.scope } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(w => w.url.indexOf(self.registration.scope) === 0);
    return open ? open.focus() : self.clients.openWindow(url);
  }));
});
