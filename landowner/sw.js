// Home Ground landowner app — keeps the app shell available with no signal.
// Bump VERSION whenever any landowner app file changes so phones pick up the new copy.
const VERSION = 'hg-landowner-v2';
const ICON = '../icon-192.png';
const SHELL = ['./', 'index.html', 'app.js', 'config.js', 'manifest.webmanifest', '../push.js', '../logo.png', '../icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('hg-landowner-') && k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// App files: network first (so updates arrive), the saved copy offline. Backend calls are never cached.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(res => {
    const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); return res;
  }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
});

// Push notifications from Home Ground (Firebase). Shown even when the app is closed.
self.addEventListener('push', e => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch (err) { /* not JSON */ }
  const d = p.data || {}, n = p.notification || {};
  e.waitUntil(self.registration.showNotification(d.title || n.title || 'Home Ground', {
    body: d.body || n.body || '', icon: ICON, badge: ICON, tag: d.tag || undefined, data: { url: d.url || self.registration.scope } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(w => w.url.indexOf(self.registration.scope) === 0);
    return open ? open.focus() : self.clients.openWindow(url);
  }));
});
