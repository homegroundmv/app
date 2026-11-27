// Deer Drop-Off Pre-Check: lets the page open from a phone's home screen with no signal.
// Bump VERSION whenever dropoff/index.html changes so phones pick up the new copy.
// Its scope is this folder only; the hunter app's worker (../sw.js) is left alone.
const VERSION = 'hg-dropoff-v14';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'logo-330.png', '../icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('hg-dropoff-') && k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Page files: network first (so a new version arrives on the next open), saved copy when offline.
// v14: and when the network has not answered in three seconds. A weak signal does not fail, it
// stalls, and the page sat blank with a good copy on the phone. The slow answer is still saved
// when it lands, so the next open has it.
// Calls to the Home Ground backend are another origin and are never touched or cached.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const saved = () => caches.match(e.request).then(r => r || caches.match('./'));
  e.respondWith(new Promise((resolve, reject) => {
    let answered = false;
    const answer = r => { if (!answered) { answered = true; resolve(r); } };
    const timer = setTimeout(() => saved().then(r => { if (r) answer(r); }), 3000);
    fetch(e.request)
      .then(res => { clearTimeout(timer); if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); } answer(res); })
      .catch(() => { clearTimeout(timer); saved().then(r => { if (answered) return; if (r) answer(r); else { answered = true; reject(new TypeError('offline, and nothing saved')); } }); });
  }));
});
