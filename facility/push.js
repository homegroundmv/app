/* Home Ground push notifications (Firebase Cloud Messaging), shared by the hunter and landowner apps.
 * Turns notifications on for this phone and keeps the phone's token current with Home Ground.
 * Needs FIREBASE and VAPID_KEY in config.js; until then the apps work exactly as before.
 */
(function () {
  'use strict';
  const CFG = window.HG_CONFIG || {};
  const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  const device = () => isIOS ? 'iPhone' : /android/i.test(navigator.userAgent) ? 'Android' : 'Computer';
  const get = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const put = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } };

  function load(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector('script[src="' + src + '"]')) return resolve();
      const s = document.createElement('script');
      s.src = src; s.onload = resolve;
      s.onerror = () => reject(new Error('Couldn\'t load notifications. Check your signal and try again.'));
      document.head.appendChild(s);
    });
  }
  async function token() {
    await load(SDK + 'firebase-app-compat.js');
    await load(SDK + 'firebase-messaging-compat.js');
    if (!window.firebase.apps.length) window.firebase.initializeApp(CFG.FIREBASE);
    const reg = await navigator.serviceWorker.ready;
    return window.firebase.messaging().getToken({ vapidKey: CFG.VAPID_KEY, serviceWorkerRegistration: reg });
  }
  /** off (not set up yet) | install (iPhone: add to Home Screen first) | unsupported | default | granted | denied */
  function state() {
    if (!(CFG.FIREBASE && CFG.FIREBASE.apiKey && CFG.VAPID_KEY)) return 'off';
    if (isIOS && !standalone()) return 'install';
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !window.Notification) return 'unsupported';
    return Notification.permission;
  }
  /** Asks permission (must follow a tap), gets this phone's token and hands it to send(token, device). */
  async function enable(send, key) {
    const p = await Notification.requestPermission();
    if (p !== 'granted') throw new Error('Notifications weren\'t allowed. You can turn them on later in your phone\'s settings.');
    const t = await token();
    if (!t) throw new Error('This phone didn\'t give a notification address. Try again.');
    await send(t, device());
    put(key + '-token', t); put(key + '-sent', String(Date.now()));
    return t;
  }
  /** On every open: if notifications are on, re-send the token when it changed or once a week. Quiet on failure. */
  async function refresh(send, key) {
    if (state() !== 'granted' || !navigator.onLine) return;
    try {
      const t = await token();
      if (t && (t !== get(key + '-token') || Date.now() - Number(get(key + '-sent') || 0) > 7 * 864e5)) {
        await send(t, device()); put(key + '-token', t); put(key + '-sent', String(Date.now()));
      }
    } catch (e) { /* try again next open */ }
  }
  /** The piece of a home screen that explains or offers notifications. */
  function panel(onEnable) {
    const s = state();
    if (s === 'off' || s === 'granted') return '';
    if (s === 'install') return '<div class="note warn">To get notifications on this iPhone, add the app to your Home Screen: tap <b>Share</b>, then <b>Add to Home Screen</b>, and open it from there.</div>';
    if (s === 'unsupported') return '<p class="status">This phone\'s browser can\'t show notifications. You\'ll still get emails.</p>';
    if (s === 'denied') return '<p class="status">Notifications are turned off for this app. To turn them on, allow notifications for it in your phone\'s settings.</p>';
    return '<button class="big alt" id="push-on">Turn on notifications<small>Get notices and messages on this phone, even when the app is closed.</small></button><div id="push-err" class="err"></div>';
  }
  function wire(onEnable) {
    const b = document.getElementById('push-on');
    if (!b) return;
    b.onclick = async () => {
      b.disabled = true; b.firstChild.textContent = 'Turning on…';
      try { await onEnable(); b.outerHTML = '<div class="note ok">Notifications are on for this phone.</div>'; }
      catch (e) { b.disabled = false; b.firstChild.textContent = 'Turn on notifications'; const er = document.getElementById('push-err'); if (er) er.textContent = e.message; }
    };
  }
  window.HGPush = { state, enable, refresh, panel, wire };
})();
