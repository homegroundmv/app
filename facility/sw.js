// Home Ground Facility app — keeps the app working with no signal, and shows push notifications.
// Bump VERSION whenever any app file changes so phones pick up the new copy.
const VERSION = 'hg-facility-v129';
const ICON = 'icon-192.png';
const SHELL = ['./', 'index.html', 'app.js', 'core.js', 'push.js', 'config.js', 'manifest.webmanifest',
  'logo.png', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'qr.js'];

/* A new version is saved as a complete set or not at all: addAll() fails if any one file fails or
   comes back as an error page, and the version already on the phone carries on. Each file is
   fetched with the browser's own HTTP cache bypassed. Without that, GitHub Pages' caching headers
   can hand back yesterday's app.js for several minutes after an update (6 November), and from
   v120 that stale file would be saved under the new version's name and served from then on. */
const fresh = u => new Request(u, { cache: 'reload' });
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(fresh))).then(() => self.skipWaiting()));
});

// Only clear this app's old copies: the hunter and landowner apps share this web address.
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('hg-facility-') && k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/* App files: the saved copy first, the network only for a file that is not saved (v120, picked
   by Joe on 18 November). Calls to the Home Ground backend are never cached.

   This used to try the network first for every file and fall back to the saved copy only when
   the network FAILED. A weak signal does not fail, it stalls: the app sat blank while a 430 KB
   app.js crawled in, with a good copy on the phone the whole time. Now the app opens from the
   phone at once, signal or not.

   Updates arrive the way they already did: the browser checks sw.js when the app opens, a new
   version installs as a complete set (above), takes over, and the app shows "A newer version of
   the app is ready". Until someone taps Reload now, or opens the app again, the phone runs the
   version it has. That set is never a mix of old and new files.

   Two things the old code got wrong along the way:
   - It saved WHATEVER the network answered. A 404 or 503 page from GitHub was saved as app.js,
     and served as app.js the next time the phone had no signal. Only a good answer is saved now.
   - A file with no saved copy was answered with index.html. For a script that is a page of HTML
     run as code. Only the opening of the app itself falls back to index.html now. */
const CODE = /\.(js|html)$|\/$/i;
const good = res => !!res && res.ok && res.type === 'basic';
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
  // Opening the app, with or without something after a "?", is always index.html.
  const nav = e.request.mode === 'navigate';
  e.respondWith(caches.open(VERSION).then(c =>
    (nav ? c.match('index.html') : c.match(e.request)).then(hit => hit ||
      fetch(CODE.test(url.pathname) ? new Request(e.request, { cache: 'reload' }) : e.request).then(res => {
        if (good(res)) c.put(nav ? 'index.html' : e.request, res.clone());
        return res;
      }))));
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
