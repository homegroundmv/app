// Deer Drop-Off Pre-Check: lets the page open from a phone's home screen with no signal.
// Bump VERSION whenever dropoff/index.html changes so phones pick up the new copy.
// Its scope is this folder only; the hunter app's worker (../sw.js) is left alone.
const VERSION = 'hg-dropoff-v12';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', '../logo.png', '../icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('hg-dropoff-') && k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Page files: network first (so a new version arrives on the next open), saved copy when offline.
// Calls to the Home Ground backend are another origin and are never touched or cached.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => { if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); } return res; })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./')))
  );
});
