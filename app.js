/* Home Ground hunter app.
 * Screens: sign-in, home, Book a Hunt, Report Your Hunt.
 * Every submission goes into an outbox on the phone first and is sent when there is signal.
 */
(function () {
  'use strict';
  const CFG = window.HG_CONFIG || {};
  const $app = document.getElementById('app');
  const STORE_KEY = 'hg-hunter';

  /* ---------- small helpers ---------- */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const isoDate = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const nowTime = () => { const d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const usDate = iso => { const [y, m, d] = String(iso).split('-'); return y ? Number(m) + '/' + Number(d) + '/' + y : ''; };
  const stamp = () => { const d = new Date(); return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear() + ' ' + d.getHours() + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function load() { try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { return null; } }
  function save(v) { try { localStorage.setItem(STORE_KEY, JSON.stringify(v)); } catch (e) { /* private mode: keep in memory */ } }
  let me = load();

  /* ---------- backend ---------- */
  async function call(body) {
    if (!CFG.BACKEND_URL || /PASTE_/.test(CFG.BACKEND_URL)) throw new Error('The app isn\'t connected yet (backend address missing).');
    let res;
    try {
      res = await fetch(CFG.BACKEND_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow' });
    } catch (e) {
      const err = new Error(navigator.onLine ? 'Couldn\'t reach the Home Ground server.' : 'No signal.');
      err.offline = !navigator.onLine; throw err;
    }
    let out;
    try { out = await res.json(); }
    catch (e) { const err = new Error('The Home Ground server sent back something unexpected (status ' + res.status + '). Please tell the office.'); err.fatal = true; throw err; }
    if (!out.ok) { const e = new Error(out.error || 'Something went wrong.'); e.fatal = true; throw e; }
    return out;
  }

  /* ---------- outbox (IndexedDB, so photos fit) ---------- */
  function db() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open('hg-app', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('outbox', { keyPath: 'clientId' });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function outbox(mode, value) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction('outbox', mode === 'all' ? 'readonly' : 'readwrite');
      const st = tx.objectStore('outbox');
      const req = mode === 'all' ? st.getAll() : mode === 'put' ? st.put(value) : st.delete(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  let flushing = false;
  async function flush() {
    if (flushing || !me) return;
    flushing = true;
    try {
      const items = (await outbox('all')).sort((a, b) => a.created - b.created);
      for (const it of items) {
        try {
          await call(Object.assign({ action: 'submit', hunter: me.hunter, pin: me.pin }, it.payload));
          await outbox('delete', it.clientId);
        } catch (e) {
          if (e.fatal) { it.error = e.message; await outbox('put', it); }   // rejected: keep it and show why
          else break;                                                        // no signal: try again later
        }
      }
    } finally { flushing = false; refreshStatus(); }
  }
  window.addEventListener('online', flush);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) flush(); });
  setInterval(flush, 60000);

  async function refreshStatus() {
    const el = document.getElementById('outbox-status');
    if (!el) return;
    const items = await outbox('all');
    if (!items.length) { el.innerHTML = '<span class="pill">Everything sent</span>'; return; }
    const bad = items.filter(i => i.error);
    el.innerHTML = '<span class="pill wait">' + items.length + ' waiting to send</span>' +
      (navigator.onLine ? '' : ' <span class="status">No signal. They\'ll send on their own.</span>') +
      bad.map(i => '<div class="note bad">' + esc(i.label) + ' was not accepted: ' + esc(i.error) +
        ' <button class="plain" data-drop="' + esc(i.clientId) + '">Remove it</button></div>').join('');
    el.querySelectorAll('[data-drop]').forEach(b => b.onclick = async () => { await outbox('delete', b.dataset.drop); refreshStatus(); });
  }

  /* ---------- GPS and photos ---------- */
  function gps() {
    return new Promise(resolve => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        p => resolve({ lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), acc: Math.round(p.coords.accuracy), at: stamp() }),
        () => resolve(null), { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
    });
  }
  // Shrinks a photo to at most 1600 px on its long side (keeps uploads small on a weak signal).
  function shrink(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, 1600 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const data = c.toDataURL('image/jpeg', 0.82);
        URL.revokeObjectURL(img.src);
        resolve({ name: file.name.replace(/\.[^.]+$/, '') + '.jpg', type: 'image/jpeg', data: data.split(',')[1] });
      };
      img.onerror = () => reject(new Error('That file isn\'t a picture the app can read.'));
      img.src = URL.createObjectURL(file);
    });
  }

  /* ---------- screens ---------- */
  function header() {
    return '<header class="top"><img src="icon-192.png" alt=""><div><div class="who">' + esc(me.name) +
      '</div><div class="sub">' + esc(me.hunter) + ' · Home Ground</div></div></header>';
  }

  function showLogin(msg) {
    $app.innerHTML =
      '<img class="login-logo" src="logo.png" alt="Home Ground. Change starts with YES">' +
      '<div class="card"><h1>Sign in</h1>' +
      '<p class="status">Use the hunter number and app PIN from your Home Ground approval email.</p>' +
      (msg ? '<div class="note bad">' + esc(msg) + '</div>' : '') +
      '<label for="hn">Hunter number</label><input id="hn" type="text" autocapitalize="characters" placeholder="H-001">' +
      '<label for="pin">App PIN</label><input id="pin" type="password" inputmode="numeric" maxlength="6" placeholder="4 digits">' +
      '<button class="submit" id="go">Sign in</button>' +
      '<p class="status center">Trouble signing in? Email ' + esc(CFG.OFFICE_EMAIL) + '.</p></div>';
    document.getElementById('go').onclick = async () => {
      const btn = document.getElementById('go');
      const hunter = document.getElementById('hn').value.trim();
      const pin = document.getElementById('pin').value.trim();
      if (!hunter || !pin) return showLogin('Enter your hunter number and PIN.');
      btn.disabled = true; btn.textContent = 'Signing in…';
      try {
        const out = await call({ action: 'login', hunter, pin });
        me = { hunter: out.hunter, pin, name: out.name, phone: out.phone, properties: out.properties, refreshed: Date.now() };
        save(me); showHome();
      } catch (e) {
        showLogin(e.fatal ? e.message : e.offline ? 'No signal. The first sign-in needs a connection.' : e.message + ' Try again in a minute.');
      }
    };
  }

  async function quietRefresh() {
    // Keeps the property list current; does nothing without signal.
    if (!navigator.onLine) return;
    try {
      const out = await call({ action: 'login', hunter: me.hunter, pin: me.pin });
      me.properties = out.properties; me.name = out.name; me.phone = out.phone; me.refreshed = Date.now(); save(me);
    } catch (e) {
      if (e.fatal) { me = null; save(null); showLogin(e.message); }
    }
  }

  function showHome(note) {
    if (typeof stopThread === 'function') stopThread();
    $app.innerHTML = header() +
      (note ? '<div class="note ok">' + note + '</div>' : '') +
      '<div id="outbox-status" class="status"></div>' +
      '<div id="alerts"></div><div id="push"></div>' +
      '<button class="big" data-go="book">Book a Hunt<small>By 5 pm the day before. Required before every hunt.</small></button>' +
      '<button class="big" data-go="hunt">Report Your Hunt<small>Every outing, within 48 hours, even if you saw nothing.</small></button>' +
      '<button class="big alt" data-go="harvest">Report Your Harvest<small>One report for each deer, the day you take it.</small></button>' +
      (me.track
        ? '<button class="big" style="background:#8A2E1F" data-go="after">Finished tracking on ' + esc(me.track.property) + '<small>Tap when you\'re done, found or not.</small></button>'
        : '<button class="big alt" data-go="before">Tracking After Dark<small>Before you go in after dark. Needs signal: Home Ground is alerted at once.</small></button>') +
      '<button class="big alt" data-go="stand">Stand &amp; Camera Log<small>Every placement, move or removal.</small></button>' +
      '<button class="big" style="background:#8A5A00" data-go="help">Need a hand?<small>Ask other Island hunters to help track or drag a deer, through the app.</small></button>' +
      '<button class="big alt" data-go="messages" id="msg-btn">Messages<small>Your landowners and help chats.</small></button>' +
      '<h2>Your properties</h2><div class="card">' +
      (me.properties && me.properties.length
        ? me.properties.map(p => '<div>' + esc(p.code) + (p.town ? ' · ' + esc(p.town) : '') + '</div>').join('')
        : '<span class="status">None assigned yet. Home Ground will email you when you have one.</span>') +
      '</div><h2>Your bookings</h2><div class="card" id="bookings"><span class="status">Loading…</span></div>' +
      '<h2>Your points</h2><div class="card" id="points"><span class="status">Loading…</span></div>' +
      '<p class="center"><button class="plain" id="out">Sign out</button></p>';
    const screens = { book: showBook, hunt: showHunt, harvest: showHarvest, before: showBefore, after: showAfter, stand: showStand, help: showHelp, messages: showMessages };
    $app.querySelectorAll('[data-go]').forEach(b => b.onclick = () => screens[b.dataset.go]());
    document.getElementById('out').onclick = async () => {
      const waiting = (await outbox('all')).length;
      if (waiting && !confirm(waiting + ' report(s) haven\'t sent yet. Sign out anyway? They\'ll be lost.')) return;
      for (const i of await outbox('all')) await outbox('delete', i.clientId);
      me = null; save(null); showLogin();
    };
    refreshStatus(); flush(); renderAlerts(); checkAlerts(); renderPoints(); loadPoints(); renderBookings(); loadBookings(); loadUnread(); renderPush();
  }

  /* ---------- push notifications (works with the app closed once turned on) ---------- */
  const sendPushToken = (token, device) => call({ action: 'pushtoken', hunter: me.hunter, pin: me.pin, token, device });
  function renderPush() {
    const box = document.getElementById('push');
    if (!box || !window.HGPush) return;
    box.innerHTML = HGPush.panel();
    HGPush.wire(() => HGPush.enable(sendPushToken, 'hg-push-hunter'));
    HGPush.refresh(sendPushToken, 'hg-push-hunter');
  }

  /* ---------- messages with landowners (only for properties you're assigned to) ---------- */
  let threadTimer = null;
  const stopThread = () => { if (threadTimer) { clearInterval(threadTimer); threadTimer = null; } };
  const when = t => { const d = new Date(t); return isNaN(d) ? t : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); };
  async function loadUnread() {
    if (!me || !navigator.onLine) return;
    try {
      const [out, hc] = await Promise.all([call({ action: 'threads', hunter: me.hunter, pin: me.pin }),
        call({ action: 'helpchats', hunter: me.hunter, pin: me.pin }).catch(() => ({ chats: [] }))]);
      const n = (out.threads || []).reduce((t, x) => t + x.unread, 0) + (hc.chats || []).reduce((t, x) => t + x.unread, 0);
      const b = document.getElementById('msg-btn');
      if (b && n) b.firstChild.textContent = 'Messages (' + n + ' new)';
    } catch (e) { /* quiet */ }
  }
  async function showMessages() {
    stopThread();
    $app.innerHTML = header() + '<h1>Messages</h1>' +
      '<p class="status">Messages go through Home Ground and are kept on record. Landowners stay anonymous unless they choose to share their first name.</p>' +
      '<div id="helpchats"></div><div id="threads" class="card"><span class="status">Loading…</span></div><p class="center"><button class="plain" id="back">Back</button></p>';
    document.getElementById('back').onclick = () => showHome();
    const box = document.getElementById('threads');
    call({ action: 'helpchats', hunter: me.hunter, pin: me.pin }).then(out => {
      const hc = document.getElementById('helpchats');
      if (!hc || !out.chats.length) return;
      hc.innerHTML = '<h2>Help chats</h2><div class="card">' + out.chats.map((c, i) => '<button class="plain" data-hc="' + esc(c.requestId) + '" data-hh="' + esc(c.helper) + '" style="display:block;width:100%;text-align:left;text-decoration:none;color:inherit;padding:10px 0' + (i ? ';border-top:1px solid var(--line)' : '') + '">' +
        '<b>' + esc(c.name) + '</b> <span class="status">' + (c.asker ? 'offered to help you' : 'you offered to help') + '</span>' + (c.unread ? ' <span class="pill wait">' + c.unread + ' new</span>' : '') +
        '<br><span class="status">' + esc(c.last) + '</span></button>').join('') + '</div><h2>Landowners</h2>';
      hc.querySelectorAll('[data-hc]').forEach(b => b.onclick = () => showHelpChat(b.dataset.hc, b.dataset.hh));
    }).catch(() => {});
    try {
      const out = await call({ action: 'threads', hunter: me.hunter, pin: me.pin });
      const list = out.threads || [];
      box.innerHTML = list.length ? list.map((t, i) => '<button class="plain" data-t="' + esc(t.property) + '" style="display:block;width:100%;text-align:left;text-decoration:none;color:inherit;padding:10px 0' + (i ? ';border-top:1px solid var(--line)' : '') + '">' +
        '<b>' + esc(t.label) + '</b>' + (t.unread ? ' <span class="pill wait">' + t.unread + ' new</span>' : '') +
        '<br><span class="status">' + (t.last ? esc(t.last) : 'No messages yet') + '</span></button>').join('')
        : '<span class="status">You have no assigned properties yet.</span>';
      box.querySelectorAll('[data-t]').forEach(b => b.onclick = () => showThread(b.dataset.t));
    } catch (e) { box.innerHTML = '<span class="status">' + esc(e.offline ? 'Messages need signal.' : e.message) + '</span>'; }
  }
  async function showHelpChat(requestId, helper) {
    stopThread();
    $app.innerHTML = header() + '<h1 id="th-title">Help chat</h1><p class="status" id="th-about"></p><div id="msgs" class="card"><span class="status">Loading…</span></div>' +
      '<div id="compose"></div><p class="center"><button class="plain" id="back">Back</button></p>';
    document.getElementById('back').onclick = () => { stopThread(); showHome(); };
    let composed = false;
    const draw = async () => {
      try {
        const out = await call({ action: 'helpthread', hunter: me.hunter, pin: me.pin, requestId, helper });
        const box = document.getElementById('msgs');
        if (!box) return stopThread();
        document.getElementById('th-title').textContent = out.title;
        document.getElementById('th-about').textContent = out.about + (out.open ? '' : ' (request closed)');
        box.innerHTML = out.messages.map(m => m.system ? '<p class="status center">' + esc(m.text) + '</p>'
          : '<div class="bubble ' + (m.mine ? 'mine' : 'theirs') + '">' + esc(m.text) + '<div class="meta">' + esc(m.from) + ' · ' + esc(when(m.at)) + '</div></div>').join('');
        box.scrollTop = box.scrollHeight;
        if (!composed) {
          composed = true;
          const c = document.getElementById('compose');
          c.innerHTML = out.canSend
            ? '<textarea id="msg" maxlength="1000" placeholder="Where to meet, what you need, when you\'ll be there"></textarea><div id="err" class="err"></div><button class="submit" id="send">Send</button>' +
              '<p class="status">Share your phone number here only if you want to.</p>'
            : '<div class="note warn">This help chat has closed.</div>';
          const send = document.getElementById('send');
          if (send) send.onclick = async () => {
            const text = document.getElementById('msg').value.trim();
            if (!text) return;
            send.disabled = true; send.textContent = 'Sending…';
            try { await call({ action: 'helpsend', hunter: me.hunter, pin: me.pin, requestId, helper, text, clientId: uid() }); document.getElementById('msg').value = ''; document.getElementById('err').textContent = ''; await draw(); }
            catch (e) { document.getElementById('err').textContent = e.offline ? 'No signal. Your message wasn\'t sent.' : e.message; }
            send.disabled = false; send.textContent = 'Send';
          };
        }
      } catch (e) { const box = document.getElementById('msgs'); if (box) box.innerHTML = '<span class="status">' + esc(e.offline ? 'The help chat needs signal.' : e.message) + '</span>'; }
    };
    await draw();
    threadTimer = setInterval(() => { if (!document.hidden && navigator.onLine) draw(); }, 10000);
  }

  async function showThread(code) {
    stopThread();
    $app.innerHTML = header() + '<h1 id="th-title">' + esc(code) + '</h1><div id="msgs" class="card"><span class="status">Loading…</span></div>' +
      '<div id="compose"></div><p class="center"><button class="plain" id="back">Back to messages</button></p>';
    document.getElementById('back').onclick = () => { stopThread(); showMessages(); };
    let composed = false;
    const draw = async () => {
      try {
        const out = await call({ action: 'thread', hunter: me.hunter, pin: me.pin, property: code });
        document.getElementById('th-title').textContent = out.label;
        const box = document.getElementById('msgs');
        if (!box) return stopThread();
        box.innerHTML = out.messages.length ? out.messages.map(m => '<div class="bubble ' + (m.mine ? 'mine' : 'theirs') + '">' + esc(m.text) +
          '<div class="meta">' + (m.mine ? 'You' : esc(m.from)) + ' · ' + esc(when(m.at)) + '</div></div>').join('')
          : '<span class="status">No messages yet. Say hello, ask about parking, or let them know about your plans. Keep it about the property and the hunt.</span>';
        box.scrollTop = box.scrollHeight;
        if (!composed) {
          composed = true;
          const c = document.getElementById('compose');
          c.innerHTML = out.canSend
            ? '<textarea id="msg" maxlength="1000" placeholder="Write a message"></textarea><div id="err" class="err"></div><button class="submit" id="send">Send</button>'
            : '<div class="note warn">This landowner prefers messages through Home Ground. Email ' + esc(CFG.OFFICE_EMAIL) + '.</div>';
          const send = document.getElementById('send');
          if (send) send.onclick = async () => {
            const text = document.getElementById('msg').value.trim();
            if (!text) return;
            send.disabled = true; send.textContent = 'Sending…';
            try { await call({ action: 'send', hunter: me.hunter, pin: me.pin, property: code, text, clientId: uid() }); document.getElementById('msg').value = ''; await draw(); }
            catch (e) { document.getElementById('err').textContent = e.offline ? 'No signal. Your message wasn\'t sent. Try again when you have signal.' : e.message; }
            send.disabled = false; send.textContent = 'Send';
          };
        }
      } catch (e) { const box = document.getElementById('msgs'); if (box) box.innerHTML = '<span class="status">' + esc(e.offline ? 'Messages need signal.' : e.message) + '</span>'; }
    };
    await draw();
    threadTimer = setInterval(() => { if (!document.hidden && navigator.onLine) draw(); }, 20000);
  }

  /* ---------- your bookings, with Cancel ---------- */
  const BOOKINGS_KEY = 'hg-bookings';
  let bookingsCache = null;
  const dayName = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); };
  const slotName = s => ({ AM: 'Morning', PM: 'Afternoon' }[s] || 'All day');
  async function loadBookings() {
    if (!me || !navigator.onLine) return renderBookings();
    try {
      const out = await call({ action: 'bookings', hunter: me.hunter, pin: me.pin });
      bookingsCache = out.bookings || [];
      try { localStorage.setItem(BOOKINGS_KEY, JSON.stringify({ hunter: me.hunter, list: bookingsCache })); } catch (e) { /* ignore */ }
      renderBookings(true);
    } catch (e) { renderBookings(); }
  }
  /** "5 pm Tue 10/20" style text for when free cancelling ends. */
  function freeText(b) {
    const d = new Date(b.freeUntil);
    return (b.slot === 'PM' ? '9 am' : '5 pm') + ' ' + d.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
  }
  function renderBookings(fresh) {
    const box = document.getElementById('bookings');
    if (!box) return;
    if (!bookingsCache) { try { const x = JSON.parse(localStorage.getItem(BOOKINGS_KEY) || 'null'); if (x && me && x.hunter === me.hunter) bookingsCache = x.list; } catch (e) { /* ignore */ } }
    if (!bookingsCache) { box.innerHTML = '<span class="status">Your bookings will show here when you have signal.</span>'; return; }
    if (!bookingsCache.length) { box.innerHTML = '<span class="status">No upcoming bookings.' + (fresh ? '' : ' (Last checked when you had signal.)') + '</span>'; return; }
    box.innerHTML = bookingsCache.map((b, i) => '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 0' + (i ? ';border-top:1px solid var(--line)' : '') + '">' +
      '<span><b>' + esc(dayName(b.date)) + '</b> · ' + esc(slotName(b.slot)) + '<br><span class="status">' + esc(b.property) + (b.stand ? ' · Stand ' + esc(b.stand) : '') + '</span></span>' +
      (b.canCancel ? '<button class="plain" data-cancel="' + i + '" style="color:var(--bad)">Cancel</button>' : '<span class="status">Started</span>') + '</div>' +
      (b.canCancel && b.freeUntil ? '<div class="status" style="margin:-4px 0 6px">' + (Date.now() < b.freeUntil ? 'Free to cancel until ' + freeText(b) : 'Cancelling now costs 1 point') + '</div>' : '')).join('') +
      '<p class="status" style="margin:8px 0 0">Can\'t make it? Cancel for free by 5 pm the day before a morning or all-day hunt, or by 9 am for an afternoon hunt, so the landowner knows and the time opens up for another hunter. Cancelling later (until the hunt starts) costs 1 point; a booking you don\'t cancel or report costs 3. You\'ll get a reminder 2 hours before free cancelling ends. To change a booking, cancel it and book again.</p>';
    box.querySelectorAll('[data-cancel]').forEach(btn => btn.onclick = async () => {
      const b = bookingsCache[Number(btn.dataset.cancel)];
      const late = b.freeUntil && Date.now() >= b.freeUntil;
      if (!confirm('Cancel your booking on ' + b.property + ', ' + dayName(b.date) + ' (' + slotName(b.slot).toLowerCase() + ')?' +
        (late ? '\n\nFree cancelling ended ' + freeText(b) + ', so this costs 1 point. (Not cancelling and not going costs 3.)' : ''))) return;
      btn.disabled = true; btn.textContent = 'Cancelling…';
      try {
        await call({ action: 'cancel', hunter: me.hunter, pin: me.pin, property: b.property, date: b.date, slot: b.slot });
        bookingsCache = bookingsCache.filter(x => x !== b);
        try { localStorage.setItem(BOOKINGS_KEY, JSON.stringify({ hunter: me.hunter, list: bookingsCache })); } catch (e) { /* ignore */ }
        renderBookings(true);
        const note = document.createElement('div'); note.className = 'note ok';
        note.textContent = 'Cancelled: ' + b.property + ', ' + dayName(b.date) + ' (' + slotName(b.slot).toLowerCase() + '). Home Ground has been told.' +
          (late ? ' Late cancellation: 1 point.' : '');
        box.parentNode.insertBefore(note, box);
      } catch (e) {
        btn.disabled = false; btn.textContent = 'Cancel';
        const note = document.createElement('div'); note.className = 'note bad';
        note.textContent = e.offline ? 'No signal. Cancelling needs signal: try again before your hunt starts.' : 'Not cancelled: ' + e.message;
        box.parentNode.insertBefore(note, box);
      }
    });
  }

  /* ---------- points (worked out by the Registry every 15 minutes) ---------- */
  const POINTS_KEY = 'hg-points';
  function cachedPoints() { try { const x = JSON.parse(localStorage.getItem(POINTS_KEY) || 'null'); return x && me && x.hunter === me.hunter ? x.points : null; } catch (e) { return null; } }
  async function loadPoints() {
    if (!me || !navigator.onLine) return;
    try {
      const out = await call({ action: 'points', hunter: me.hunter, pin: me.pin });
      try { localStorage.setItem(POINTS_KEY, JSON.stringify({ hunter: me.hunter, points: out.points })); } catch (e) { /* ignore */ }
      renderPoints(out.points, true);
    } catch (e) { renderPoints(cachedPoints(), false); }
  }
  function renderPoints(p, fresh) {
    const box = document.getElementById('points');
    if (!box) return;
    if (p === undefined) p = cachedPoints();
    if (!p) { box.innerHTML = '<span class="status">' + (fresh ? 'No points yet. They start with your first report.' : 'Your points will show here when you have signal.') + '</span>'; return; }
    const sign = n => (n > 0 ? '+' : '') + n;
    box.innerHTML = '<div style="font-size:34px;font-weight:700">' + esc(p.total) + ' <span class="status" style="font-size:15px;font-weight:400">points</span></div>' +
      '<div class="status">This season ' + esc(p.thisSeason) + ' · Last season ' + esc(p.lastSeason) + ' · Loyalty bonus ' + esc(p.loyalty) + '</div>' +
      (p.recent && p.recent.length ? '<details style="margin-top:10px"><summary>Recent points</summary>' +
        p.recent.map(e => '<div style="display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-top:1px solid var(--line)"><span>' +
          esc(e.rule) + '<br><span class="status">' + esc(e.date) + (e.property ? ' · ' + esc(e.property) : '') + '</span></span><b style="white-space:nowrap' +
          (e.points < 0 ? ';color:var(--bad)' : '') + '">' + esc(sign(e.points)) + '</b></div>').join('') + '</details>' : '') +
      '<p class="status" style="margin:10px 0 0">Updated ' + esc(p.updated || '') + '. Points only decide access to land. Questions? Email ' + esc(CFG.OFFICE_EMAIL) + '.</p>';
  }

  function propertySelect() {
    const list = me.properties || [];
    if (!list.length) return '<div class="note warn">You have no assigned properties yet, so there\'s nothing to book or report.</div>';
    return '<label for="prop">Property</label><select id="prop">' +
      (list.length > 1 ? '<option value="">Choose…</option>' : '') +
      list.map(p => '<option value="' + esc(p.code) + '">' + esc(p.code) + (p.town ? ' · ' + esc(p.town) : '') + '</option>').join('') + '</select>';
  }

  // Booking window: by 5 pm the day before. After 5 pm the earliest bookable day is the day after tomorrow.
  function earliestBookable() {
    const d = new Date(); d.setDate(d.getDate() + (d.getHours() >= 17 ? 2 : 1)); return isoDate(d);
  }

  function showBook() {
    const min = earliestBookable();
    $app.innerHTML = header() + '<h1>Book a Hunt</h1>' +
      '<div class="note warn">Book by 5 pm the day before. You\'re not booked until Home Ground emails to confirm. No confirmation, no hunt.</div>' +
      propertySelect() +
      '<div id="cal"></div>' +
      '<label for="day">Date of hunt</label><input id="day" type="date" min="' + min + '" value="' + min + '">' +
      '<label for="time">Time of hunt</label><select id="time"><option value="">Choose…</option>' +
      '<option>AM</option><option>PM</option><option>All day</option></select>' +
      '<label for="stand">Stand ID <span class="hint">Optional. The stand or spot you plan to use.</span></label><input id="stand" type="text">' +
      '<label class="choice"><input id="agree" type="checkbox"> I understand I\'m not booked until Home Ground emails to confirm. To cancel, I\'ll use Your bookings on the app\'s home screen: free by 5 pm the day before (9 am for an afternoon hunt); later than that costs 1 point.</label>' +
      '<div id="err" class="err"></div><button class="submit" id="send">Send booking</button>' +
      '<p class="center"><button class="plain" id="back">Back</button></p>';
    document.getElementById('back').onclick = () => showHome();
    const propSel = document.getElementById('prop');
    if (propSel) { propSel.onchange = () => loadCalendar(propSel.value); loadCalendar(propSel.value); }
    document.getElementById('send').onclick = async () => {
      const f = id => document.getElementById(id);
      const prop = f('prop') ? f('prop').value : '';
      const err = [];
      if (!prop) err.push('Choose a property.');
      if (!f('day').value) err.push('Pick a date.');
      else if (f('day').value < earliestBookable()) err.push('That date is past the 5 pm cutoff. Pick a later day.');
      if (!f('time').value) err.push('Choose a time.');
      else if (prop && f('day').value) {
        const why = slotProblem(prop, f('day').value, f('time').value);
        if (why) err.push(why);
      }
      if (!f('agree').checked) err.push('Tick the box to confirm you understand.');
      if (err.length) { f('err').innerHTML = err.map(esc).join('<br>'); return; }
      await queue('Booking for ' + usDate(f('day').value), {
        form: 'booking', submittedOn: stamp(),
        fields: { property: prop, date: usDate(f('day').value), time: f('time').value, stand: f('stand').value.trim() }
      });
      showHome('Booking saved for ' + esc(prop) + ' on ' + esc(usDate(f('day').value)) +
        '. Watch your email for Home Ground\'s confirmation.' + (navigator.onLine ? '' : ' It will send as soon as you have signal.'));
    };
  }

  /* ---------- property calendar ---------- */
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const overlap = (a, b) => a === 'All day' || b === 'All day' || a === b;
  function calFor(prop) { return (me.cal || {})[prop] || null; }
  async function loadCalendar(prop) {
    const box = document.getElementById('cal');
    if (!box) return;
    if (!prop) { box.innerHTML = ''; return; }
    drawCalendar(prop);
    if (!navigator.onLine) return;
    try {
      const out = await call({ action: 'calendar', hunter: me.hunter, pin: me.pin, property: prop });
      me.cal = me.cal || {}; me.cal[prop] = out; save(me);
      const sel = document.getElementById('prop');
      if (sel && sel.value === prop) drawCalendar(prop);
    } catch (e) { if (!calFor(prop)) box.innerHTML = '<p class="status">Calendar not available right now. You can still book.</p>'; }
  }
  function slotState(c, iso, slot) {
    const d = new Date(iso + 'T12:00:00');
    const b = c.blackouts.find(x => iso >= x.from && iso <= x.to && (!x.days.length || x.days.indexOf(d.getDay()) >= 0) && overlap(x.slot, slot));
    if (b) return { kind: 'blocked', label: 'Paused', note: b.note };
    const taken = c.bookings.filter(x => x.date === iso && overlap(x.slot, slot));
    if (taken.some(x => x.mine)) return { kind: 'mine', label: 'You' };
    if (taken.length >= c.max) return { kind: 'full', label: 'Full · ' + taken.map(x => x.hunter).join(', ') };
    return { kind: 'open', label: taken.length ? taken.length + ' of ' + c.max + ' · ' + taken.map(x => x.hunter).join(', ') : 'Open' };
  }
  function slotProblem(prop, iso, time) {
    const c = calFor(prop);
    if (!c) return '';
    const slots = time === 'All day' ? ['AM', 'PM'] : [time];
    for (const sl of slots) {
      const st = slotState(c, iso, sl);
      if (st.kind === 'blocked') return 'The landowner has paused hunting then' + (st.note ? ' (' + st.note + ')' : '') + '. Pick another time.';
      if (st.kind === 'full') return prop + ' is full then. Pick another time.';
    }
    return '';
  }
  function drawCalendar(prop) {
    const box = document.getElementById('cal');
    const c = calFor(prop);
    if (!box) return;
    if (!c) { box.innerHTML = '<p class="status">Loading the calendar for ' + esc(prop) + '…</p>'; return; }
    const style = { open: 'background:#EEF0E0;color:#363C17', mine: 'background:#4B5320;color:#fff', full: 'background:#FCE8E6;color:#A12A1F', blocked: 'background:#EEE;color:#777;text-decoration:line-through' };
    const start = new Date(earliestBookable() + 'T12:00:00');
    let rows = '';
    for (let i = 0; i < 14; i++) {
      const d = new Date(start); d.setDate(d.getDate() + i);
      const iso = isoDate(d);
      const cell = sl => { const st = slotState(c, iso, sl); const tap = st.kind === 'open';
        return '<button type="button" ' + (tap ? 'data-pick="' + iso + '|' + sl + '"' : 'disabled') + ' style="flex:1;border:0;border-radius:8px;padding:8px 6px;font-size:13px;text-align:left;' + style[st.kind] + '"><b>' + sl + '</b> ' + esc(st.label) + '</button>'; };
      rows += '<div style="display:flex;gap:6px;align-items:center;margin:4px 0"><div style="width:72px;font-size:14px;font-weight:600">' + DOW[d.getDay()] + ' ' + (d.getMonth() + 1) + '/' + d.getDate() + '</div>' + cell('AM') + cell('PM') + '</div>';
    }
    box.innerHTML = '<div class="card"><b>' + esc(prop) + ' · next two weeks</b><div class="status">Up to ' + c.max + ' hunter' + (c.max > 1 ? 's' : '') +
      ' at a time. Tap an open slot to pick it. Paused = the landowner has asked for no hunting.' +
      (navigator.onLine ? '' : ' Shown as last seen; no signal.') + '</div>' + rows + '</div>';
    box.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => {
      const [iso, sl] = b.dataset.pick.split('|');
      document.getElementById('day').value = iso; document.getElementById('time').value = sl;
      document.getElementById('day').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  /* ---------- help requests and alerts ---------- */
  function showHelp() {
    $app.innerHTML = header() + '<h1>Need a hand?</h1>' +
      '<div class="note warn">This sends a notification to every active Island hunter and shows in their app. Only your property code and town are shared. Anyone free taps "I can help", and the two of you message each other in the app to sort out where to meet.</div>' +
      propertySelect() +
      '<label>What do you need?</label>' +
      ['Tracking', 'Dragging', 'Tracking and dragging'].map((x, i) => '<label class="choice"><input type="radio" name="needs" value="' + x + '"' + (i === 1 ? ' checked' : '') + '> ' + x + '</label>').join('') +
      '<label for="hnote">Anything helpers should know <span class="hint">Optional. No addresses.</span></label><textarea id="hnote" maxlength="300" placeholder="e.g. Big doe, about 200 yards in, meet at the road"></textarea>' +
      '<div id="err" class="err"></div><button class="submit" id="send">Send for help</button>' +
      '<p class="center"><button class="plain" id="back">Back</button></p>';
    document.getElementById('back').onclick = () => showHome();
    document.getElementById('send').onclick = async () => {
      const f = id => document.getElementById(id), btn = f('send');
      const prop = f('prop') ? f('prop').value : '';
      const needs = (document.querySelector('input[name=needs]:checked') || {}).value;
      if (!prop) { f('err').textContent = 'Choose the property.'; return; }
      btn.disabled = true; btn.textContent = 'Sending…';
      try {
        const out = await call({ action: 'help', hunter: me.hunter, pin: me.pin, clientId: uid(),
          fields: { property: prop, needs, note: f('hnote').value.trim() } });
        showHome('Help request sent to ' + (out.sentTo || 0) + ' hunter' + (out.sentTo === 1 ? '' : 's') + '. You\'ll be notified when someone offers to help. Close it once help is on the way.');
      } catch (e) {
        btn.disabled = false; btn.textContent = 'Send for help';
        f('err').textContent = e.offline ? 'No signal, so it couldn\'t send. Call or text a hunter you know, or the office at ' + CFG.OFFICE_PHONE + '.' : e.message;
      }
    };
  }

  let alertsCache = [];
  function seenAlerts() { try { return JSON.parse(localStorage.getItem('hg-seen-alerts') || '[]'); } catch (e) { return []; } }
  async function checkAlerts() {
    if (!me || !navigator.onLine || document.hidden) return;
    try {
      const out = await call({ action: 'alerts', hunter: me.hunter, pin: me.pin });
      alertsCache = out.alerts || [];
      const seen = seenAlerts(), fresh = alertsCache.filter(a => !a.mine && seen.indexOf(a.id) < 0);
      if (fresh.length) {
        if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
        const pushed = window.HGPush && HGPush.state() === 'granted';   // the push already showed it
        if (!pushed && window.Notification && Notification.permission === 'granted' && navigator.serviceWorker) {
          const reg = await navigator.serviceWorker.getRegistration();
          fresh.forEach(a => reg && reg.showNotification('Hunter needs help: ' + a.needs.toLowerCase(), { body: a.name + ' near ' + (a.town || a.property) + '. Open the app to say you can help.', icon: 'icon-192.png', tag: a.id }));
        }
        try { localStorage.setItem('hg-seen-alerts', JSON.stringify(seen.concat(fresh.map(a => a.id)).slice(-50))); } catch (e) { /* ignore */ }
      }
      renderAlerts();
    } catch (e) { /* quiet: alerts are a bonus, email is the backup */ }
  }
  function renderAlerts() {
    const box = document.getElementById('alerts');
    if (!box) return;
    const ask = (!window.HGPush || HGPush.state() === 'off') && window.Notification && Notification.permission === 'default'
      ? '<p class="status"><button class="plain" id="notif">Turn on alerts on this phone</button></p>' : '';
    box.innerHTML = alertsCache.map(a => a.mine
      ? '<div class="note warn"><b>Your help request is out</b> (' + esc(a.needs.toLowerCase()) + ', ' + esc(a.property) + ').<br>' +
        (a.helpers && a.helpers.length ? a.helpers.map(h => '<button class="plain" data-chat="' + esc(a.id) + '" data-helper="' + esc(h.id) + '">Message ' + esc(h.name) + ' (offered to help)</button>').join('<br>')
          : '<span class="status">No one has offered yet. You\'ll be notified when someone does.</span>') +
        '<br><button class="plain" data-done="' + esc(a.id) + '">Help found, close it</button></div>'
      : '<div class="note bad"><b>' + esc(a.name) + ' needs help ' + esc(a.needs.toLowerCase()) + '</b> near ' + esc(a.town || a.property) +
        (a.note ? '<br>' + esc(a.note) : '') + '<br>' +
        (a.offered ? '<button class="plain" data-chat="' + esc(a.id) + '" data-helper="' + esc(me.hunter) + '">Open your chat with ' + esc(a.name) + '</button>'
          : '<button class="plain" data-offer="' + esc(a.id) + '">I can help</button>') + '</div>').join('') + ask;
    box.querySelectorAll('[data-offer]').forEach(b => b.onclick = async () => {
      b.disabled = true; b.textContent = 'Letting them know…';
      try { await call({ action: 'helpoffer', hunter: me.hunter, pin: me.pin, requestId: b.dataset.offer }); showHelpChat(b.dataset.offer, me.hunter); }
      catch (e) { b.disabled = false; b.textContent = e.offline ? 'No signal. Try again.' : e.message; }
    });
    box.querySelectorAll('[data-chat]').forEach(b => b.onclick = () => showHelpChat(b.dataset.chat, b.dataset.helper));
    box.querySelectorAll('[data-done]').forEach(b => b.onclick = async () => {
      b.disabled = true;
      try { await call({ action: 'helpdone', hunter: me.hunter, pin: me.pin, requestId: b.dataset.done }); alertsCache = alertsCache.filter(a => a.id !== b.dataset.done); renderAlerts(); }
      catch (e) { b.disabled = false; b.textContent = 'Couldn\'t close it. Try again.'; }
    });
    const n = document.getElementById('notif');
    if (n) n.onclick = () => Notification.requestPermission().then(renderAlerts);
  }
  setInterval(checkAlerts, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkAlerts(); });

  function showHunt() {
    const outcomes = ['Took a deer', 'Hit a deer but couldn\'t recover it', 'Saw deer, but no shot', 'Saw no deer'];
    let files = [];
    $app.innerHTML = header() + '<h1>Report Your Hunt</h1>' +
      '<p class="status">One report per outing, within 48 hours, including days you see nothing. Honest reports never cost you.</p>' +
      propertySelect() +
      '<label for="day">Date</label><input id="day" type="date" value="' + isoDate(new Date()) + '" max="' + isoDate(new Date()) + '">' +
      '<div class="row"><div><label for="tin">Time in</label><input id="tin" type="time"></div>' +
      '<div><label for="tout">Time out</label><input id="tout" type="time" value="' + nowTime() + '"></div></div>' +
      '<label>Outcome</label>' + outcomes.map((o, i) => '<label class="choice"><input type="radio" name="outcome" value="' + esc(o) + '"> ' + esc(o) + '</label>').join('') +
      '<div id="took" hidden><label for="harv">How many did you harvest?</label><input id="harv" type="number" min="1" value="1">' +
      '<div class="note warn">Also file a Report Your Harvest for each deer (website for now).</div></div>' +
      '<h2>Deer seen <span class="hint">Every outing. Enter 0 if none.</span></h2>' +
      '<div class="row4">' + [['does', 'Adult does'], ['bucks', 'Adult bucks'], ['fawns', 'Fawns / young of the year'], ['unsure', 'Couldn\'t tell']]
        .map(([id, l]) => '<div><label for="' + id + '">' + l + '</label><input id="' + id + '" type="number" min="0" inputmode="numeric" value="0"></div>').join('') + '</div>' +
      '<label for="notes">Anything we should know? <span class="hint">Optional</span></label><textarea id="notes"></textarea>' +
      '<label for="shot">onX location screenshot <span class="hint">Your live GPS dot with the property information and the clock showing.</span></label>' +
      '<input id="shot" type="file" accept="image/*"><div id="thumbs" class="thumbs"></div>' +
      '<div id="noshot"><label for="why">Couldn\'t take a screenshot? Tell us why.</label><input id="why" type="text"></div>' +
      '<p class="status">The app also records your phone\'s location when you send this report.</p>' +
      '<label class="choice"><input id="agree" type="checkbox"> This report is accurate to the best of my knowledge.</label>' +
      '<div id="err" class="err"></div><button class="submit" id="send">Send report</button>' +
      '<p class="center"><button class="plain" id="back">Back</button></p>';
    const f = id => document.getElementById(id);
    f('back').onclick = () => showHome();
    document.querySelectorAll('input[name=outcome]').forEach(r => r.onchange = () => { f('took').hidden = r.value !== 'Took a deer' || !r.checked; });
    f('shot').onchange = async () => {
      files = [];
      f('thumbs').innerHTML = '';
      for (const file of f('shot').files) {
        try { const s = await shrink(file); files.push(s); f('thumbs').innerHTML += '<img src="data:image/jpeg;base64,' + s.data + '" alt="">'; }
        catch (e) { f('err').textContent = e.message; }
      }
      f('noshot').hidden = files.length > 0;
    };
    f('send').onclick = async () => {
      const prop = f('prop') ? f('prop').value : '';
      const outcome = (document.querySelector('input[name=outcome]:checked') || {}).value || '';
      const err = [];
      if (!prop) err.push('Choose a property.');
      if (!f('day').value) err.push('Enter the date.');
      if (!f('tin').value) err.push('Enter your time in.');
      if (!f('tout').value) err.push('Enter your time out.');
      if (!outcome) err.push('Choose an outcome.');
      if (!files.length && !f('why').value.trim()) err.push('Add your onX screenshot, or say why you couldn\'t.');
      if (!f('agree').checked) err.push('Tick the accuracy box.');
      if (err.length) { f('err').innerHTML = err.map(esc).join('<br>'); return; }
      f('send').disabled = true; f('send').textContent = 'Getting your location…';
      const where = await gps();
      await queue('Hunt report for ' + usDate(f('day').value), {
        form: 'hunt', submittedOn: stamp(), gps: where,
        fields: {
          property: prop, date: usDate(f('day').value), timeIn: f('tin').value, timeOut: f('tout').value, outcome,
          harvested: outcome === 'Took a deer' ? f('harv').value : '',
          does: f('does').value, bucks: f('bucks').value, fawns: f('fawns').value, unsure: f('unsure').value,
          notes: f('notes').value.trim(), noScreenshotReason: files.length ? '' : f('why').value.trim()
        },
        files: files.map(x => Object.assign({ kind: 'onx' }, x))
      });
      showHome('Hunt report saved for ' + esc(prop) + '.' + (navigator.onLine ? '' : ' It will send as soon as you have signal.') +
        (outcome === 'Took a deer' ? ' Remember to file Report Your Harvest for each deer.' : ''));
    };
  }

  /* ---------- stage 2 screens ---------- */

  // Shared bits: radio list, checkbox list, photo picker.
  const radios = (name, opts) => opts.map(o => '<label class="choice"><input type="radio" name="' + name + '" value="' + esc(o) + '"> ' + esc(o) + '</label>').join('');
  const checks = (name, opts) => opts.map(o => '<label class="choice"><input type="checkbox" name="' + name + '" value="' + esc(o) + '"> ' + esc(o) + '</label>').join('');
  const picked = name => (document.querySelector('input[name="' + name + '"]:checked') || {}).value || '';
  const allPicked = name => [...document.querySelectorAll('input[name="' + name + '"]:checked')].map(x => x.value);
  const allTicked = name => { const b = [...document.querySelectorAll('input[name="' + name + '"]')]; return b.length && b.every(x => x.checked); };
  function photoField(id, label, hint) {
    return '<label for="' + id + '">' + label + (hint ? ' <span class="hint">' + hint + '</span>' : '') + '</label>' +
      '<input id="' + id + '" type="file" accept="image/*"><div id="' + id + '-thumbs" class="thumbs"></div>';
  }
  function wirePhoto(id, kind, store, onChange) {
    const el = document.getElementById(id), th = document.getElementById(id + '-thumbs');
    el.onchange = async () => {
      store.length = 0; th.innerHTML = '';
      for (const file of el.files) {
        try { const x = await shrink(file); store.push(Object.assign({ kind }, x)); th.innerHTML += '<img src="data:image/jpeg;base64,' + x.data + '" alt="">'; }
        catch (e) { document.getElementById('err').textContent = e.message; }
      }
      if (onChange) onChange();
    };
  }
  const back = () => {
    document.getElementById('back').onclick = () => showHome();
    $app.onchange = () => { const e = document.getElementById('err'); if (e) e.textContent = ''; };   // clear old warnings as they fix things
  };
  const foot = (btn) => '<div id="err" class="err"></div><button class="submit" id="send">' + btn + '</button><p class="center"><button class="plain" id="back">Back</button></p>';
  const fail = list => { document.getElementById('err').innerHTML = list.map(esc).join('<br>'); return list.length > 0; };
  const v = id => (document.getElementById(id) || {}).value || '';

  function showHarvest() {
    const photo1 = [], photo2 = [], shot = [];
    const donateRules = ['I recovered and field dressed the deer within 4 hours of the shot (or it stayed below 37 degrees).',
      'I\'ll drop it off whole and field dressed at the facility within 24 hours of the shot.',
      'It\'s reported to MassWildlife and tagged with my confirmation number.'];
    $app.innerHTML = header() + '<h1>Report Your Harvest</h1>' +
      '<p class="status">One report for each deer, with its own band, confirmation number and photos.</p>' + propertySelect() +
      '<div class="row"><div><label for="day">Date</label><input id="day" type="date" value="' + isoDate(new Date()) + '" max="' + isoDate(new Date()) + '"></div>' +
      '<div><label for="shot-time">Time of shot</label><input id="shot-time" type="time"></div></div>' +
      '<label>Hunting implement</label>' + radios('impl', ['Archery', 'Shotgun', 'Primitive firearm']) +
      '<label>The deer</label>' + radios('deer', ['Antlered buck', 'Adult antlerless (doe)', 'Subadult antlerless (button buck or doe fawn)']) +
      '<label for="which">Deer from this outing</label><select id="which"><option>1st</option><option>2nd</option><option>3rd</option><option>4th or more</option></select>' +
      '<label for="conf">MassWildlife confirmation number</label><input id="conf" type="text" inputmode="numeric">' +
      '<label for="band">Home Ground band number</label><input id="band" type="text">' +
      '<label>Recovered after dark?</label>' + radios('dark', ['No', 'Yes']) +
      '<div id="dark-yes" hidden>' + checks('darkforms', ['I filed Before the Track.', 'I filed After the Track.']) + '</div>' +
      photoField('p1', 'Photo 1: the deer where it fell', 'Band visible.') +
      photoField('p2', 'Photo 2: band close-up', 'Optional.') +
      photoField('onx', 'onX location screenshot', 'Live GPS dot, property info and clock showing.') +
      '<div id="noshot"><label for="why">Couldn\'t take a screenshot? Tell us why.</label><input id="why" type="text"></div>' +
      '<label>Donate through Hunters Share the Harvest?</label>' + radios('donate', ['Yes, the whole deer', 'No']) +
      '<div id="donate-yes" hidden>' + checks('rules', donateRules) + '</div>' +
      '<label for="notes">Anything else? <span class="hint">Optional</span></label><textarea id="notes"></textarea>' +
      '<label class="choice"><input id="agree" type="checkbox"> This report is accurate to the best of my knowledge.</label>' + foot('Send harvest report');
    back();
    wirePhoto('p1', 'harvest', photo1); wirePhoto('p2', 'harvest', photo2);
    wirePhoto('onx', 'onx', shot, () => { document.getElementById('noshot').hidden = shot.length > 0; });
    document.querySelectorAll('input[name=dark]').forEach(r => r.onchange = () => { document.getElementById('dark-yes').hidden = picked('dark') !== 'Yes'; });
    document.querySelectorAll('input[name=donate]').forEach(r => r.onchange = () => { document.getElementById('donate-yes').hidden = picked('donate') !== 'Yes, the whole deer'; });
    document.getElementById('send').onclick = async () => {
      const e = [];
      if (!v('prop')) e.push('Choose a property.');
      if (!v('shot-time')) e.push('Enter the time of the shot.');
      if (!picked('impl')) e.push('Choose the hunting implement.');
      if (!picked('deer')) e.push('Choose which kind of deer.');
      if (!v('conf').trim()) e.push('Enter the MassWildlife confirmation number.');
      if (!v('band').trim()) e.push('Enter the Home Ground band number.');
      if (!picked('dark')) e.push('Say whether it was recovered after dark.');
      if (picked('dark') === 'Yes' && !allTicked('darkforms')) e.push('After dark: file Before the Track and After the Track, then tick both.');
      if (!photo1.length) e.push('Add photo 1, the deer where it fell.');
      if (!shot.length && !v('why').trim()) e.push('Add your onX screenshot, or say why you couldn\'t.');
      if (!picked('donate')) e.push('Say whether you\'re donating it.');
      if (picked('donate') === 'Yes, the whole deer' && !allTicked('rules')) e.push('To donate, all three Share the Harvest boxes must be true.');
      if (!document.getElementById('agree').checked) e.push('Tick the accuracy box.');
      if (fail(e)) return;
      document.getElementById('send').disabled = true;
      const where = await gps();
      await queue('Harvest report ' + v('band'), { form: 'harvest', submittedOn: stamp(), gps: where,
        fields: { property: v('prop'), date: usDate(v('day')), shotTime: v('shot-time'), implement: picked('impl'), deerType: picked('deer'),
          which: v('which'), confirmation: v('conf').trim(), band: v('band').trim(), afterDark: picked('dark'),
          afterDarkForms: allPicked('darkforms').join(' '), donate: picked('donate'),
          donateChecks: picked('donate') === 'No' ? '' : allPicked('rules').length + ' of 3 confirmed',
          notes: v('notes').trim(), noScreenshotReason: shot.length ? '' : v('why').trim() },
        files: photo1.concat(photo2, shot) });
      showHome('Harvest report saved for band ' + esc(v('band')) + '.' + (navigator.onLine ? '' : ' It will send as soon as you have signal.'));
    };
  }

  function showBefore() {
    const rules = ['I\'m not carrying a weapon. My firearm or bow is unloaded and left behind.',
      'If this landowner asked for a text or call before anyone enters after dark, I\'ve done it.',
      'I\'ll stay on enrolled land unless I have the neighbor\'s permission or the Environmental Police\'s direction.'];
    $app.innerHTML = header() + '<h1>Before the Track</h1>' +
      '<div class="note warn">This alerts Home Ground right away. If you have no signal, call ' + esc(CFG.OFFICE_PHONE) + ' before you go in.</div>' + propertySelect() +
      '<label for="start">Time you\'re starting</label><input id="start" type="time" value="' + nowTime() + '">' +
      '<label for="phone">Phone number to reach you right now</label><input id="phone" type="tel" value="' + esc(me.phone || '') + '">' +
      '<label for="beh">Deer behavior after the shot <span class="hint">Direction, blood, how it ran.</span></label><textarea id="beh"></textarea>' +
      '<label>Who\'s with you?</label>' + radios('company', ['I\'m alone', 'Others are helping me']) +
      '<div id="helpers-box" hidden><label for="helpers">Helpers\' names and at least one phone number</label><textarea id="helpers"></textarea></div>' +
      '<label for="parked">Where are you parked?</label><input id="parked" type="text">' +
      '<label>Please confirm</label>' + checks('rules', rules) + foot('Send and start tracking');
    back();
    document.querySelectorAll('input[name=company]').forEach(r => r.onchange = () => { document.getElementById('helpers-box').hidden = picked('company') !== 'Others are helping me'; });
    document.getElementById('send').onclick = async () => {
      const e = [];
      if (!v('prop')) e.push('Choose a property.');
      if (!v('phone').trim()) e.push('Enter a phone number we can reach you on now.');
      if (!v('beh').trim()) e.push('Describe the deer\'s behavior.');
      if (!picked('company')) e.push('Say who\'s with you.');
      if (picked('company') === 'Others are helping me' && !v('helpers').trim()) e.push('List your helpers and a phone number.');
      if (!v('parked').trim()) e.push('Say where you\'re parked.');
      if (!allTicked('rules')) e.push('All three boxes must be true before you go in.');
      if (fail(e)) return;
      const btn = document.getElementById('send'); btn.disabled = true; btn.textContent = 'Sending…';
      const where = await gps();
      const payload = { clientId: uid(), form: 'before', submittedOn: stamp(), gps: where,
        fields: { property: v('prop'), start: v('start'), phone: v('phone').trim(), behavior: v('beh').trim(), company: picked('company'),
          helpers: v('helpers').trim(), parked: v('parked').trim(), checks: 'All three confirmed' } };
      try {
        // Sent straight away, never queued: Home Ground must know before anyone goes in.
        await call(Object.assign({ action: 'submit', hunter: me.hunter, pin: me.pin }, payload));
        me.track = { property: v('prop'), started: Date.now() }; save(me);
        showHome('Home Ground has been alerted. Track safely, no weapon. Tap "Finished tracking" when you\'re done.');
      } catch (err) {
        btn.disabled = false; btn.textContent = 'Try again';
        fail([err.fatal ? err.message : 'Couldn\'t send. Call ' + CFG.OFFICE_PHONE + ' before you go in.']);
      }
    };
  }

  function showAfter() {
    const shot = [];
    const prop = me.track ? me.track.property : '';
    $app.innerHTML = header() + '<h1>After the Track</h1>' + propertySelect() +
      '<label for="fin">Time you finished</label><input id="fin" type="time" value="' + nowTime() + '">' +
      '<label>Outcome</label>' + radios('out', ['Recovered the deer', 'Didn\'t recover it, stopped tracking']) +
      '<label>Did the deer cross onto land outside the program?</label>' +
      radios('crossed', ['No', 'Yes, with the owner\'s permission', 'Yes, with the Environmental Police\'s direction', 'Yes, and I stopped at the line']) +
      photoField('trk', 'onX track screenshot', 'Your recorded track for this recovery.') +
      '<div id="noshot"><label for="why">Couldn\'t record or screenshot the track? Tell us why.</label><input id="why" type="text"></div>' +
      '<label for="notes">Notes <span class="hint">Optional</span></label><textarea id="notes"></textarea>' +
      '<div class="note warn">Recovered it? Also file Report Your Harvest.</div>' + foot('Send: I\'m finished');
    if (prop && document.getElementById('prop')) document.getElementById('prop').value = prop;
    back();
    wirePhoto('trk', 'track', shot, () => { document.getElementById('noshot').hidden = shot.length > 0; });
    document.getElementById('send').onclick = async () => {
      const e = [];
      if (!v('prop')) e.push('Choose a property.');
      if (!picked('out')) e.push('Choose the outcome.');
      if (!picked('crossed')) e.push('Say whether the deer crossed outside the program.');
      if (!shot.length && !v('why').trim()) e.push('Add your track screenshot, or say why you couldn\'t.');
      if (fail(e)) return;
      document.getElementById('send').disabled = true;
      const where = await gps();
      const recovered = picked('out') === 'Recovered the deer';
      await queue('After the Track', { form: 'after', submittedOn: stamp(), gps: where,
        fields: { property: v('prop'), finished: v('fin'), outcome: picked('out'), crossed: picked('crossed'),
          notes: v('notes').trim(), noScreenshotReason: shot.length ? '' : v('why').trim() }, files: shot });
      me.track = null; save(me);
      if (recovered) showHarvest(); else showHome('Tracking finished. Thank you.' + (navigator.onLine ? '' : ' It will send as soon as you have signal.'));
    };
  }

  function showStand() {
    const shot = [];
    const camRules = ['Audio recording is turned off.',
      'It\'s pointed at a deer trail, not at a home, driveway, building or path, unless the landowner approved.',
      'If this landowner asked to approve placement, they\'ve approved it.'];
    const standRules = ['I wear a full-body harness whenever I\'m in my stand (tree saddles qualify).',
      'It\'s placed the way the landowner allows (no screw-in steps or permanent stands unless they\'ve said yes).',
      'My onX screenshot shows the stand with the radius turned on and set to 167 yards.',
      'The radius doesn\'t take in an occupied dwelling on a property that isn\'t enrolled with Home Ground.'];
    $app.innerHTML = header() + '<h1>Stand &amp; Camera Log</h1>' + propertySelect() +
      '<label>I\'m logging <span class="hint">Tick all that apply.</span></label>' +
      checks('log', ['Stand placement', 'Stand move', 'Stand removal', 'Camera placement', 'Camera move', 'Camera removal']) +
      '<label for="ids">Stand or camera ID(s) <span class="hint">e.g. 112-A</span></label><input id="ids" type="text">' +
      photoField('loc', 'Screenshot of the location in onX', '') +
      '<div id="noshot"><label for="why">No screenshot? Tell us why.</label><input id="why" type="text"></div>' +
      '<label>Who can know about this?</label>' + radios('share', ['Home Ground only', 'Home Ground and program hunters hunting next to me']) +
      '<div id="cam-box" hidden><label>For cameras</label>' + checks('camrules', camRules) + '</div>' +
      '<div id="stand-box" hidden><label>For stands</label>' + checks('standrules', standRules) + '</div>' +
      '<label for="notes">Notes <span class="hint">Optional</span></label><textarea id="notes"></textarea>' + foot('Send log');
    back();
    wirePhoto('loc', 'stand', shot, () => { document.getElementById('noshot').hidden = shot.length > 0; });
    const placing = () => allPicked('log').filter(x => !/removal/.test(x));
    document.querySelectorAll('input[name=log]').forEach(c => c.onchange = () => {
      document.getElementById('cam-box').hidden = !placing().some(x => /Camera/.test(x));
      document.getElementById('stand-box').hidden = !placing().some(x => /Stand/.test(x));
    });
    document.getElementById('send').onclick = async () => {
      const e = [];
      const logging = allPicked('log');
      if (!v('prop')) e.push('Choose a property.');
      if (!logging.length) e.push('Tick what you\'re logging.');
      if (!v('ids').trim()) e.push('Enter the stand or camera ID.');
      if (!shot.length && !v('why').trim()) e.push('Add the onX screenshot, or say why you couldn\'t.');
      if (!picked('share')) e.push('Choose who can know about this.');
      if (placing().some(x => /Camera/.test(x)) && !allTicked('camrules')) e.push('All camera boxes must be true.');
      if (placing().some(x => /Stand/.test(x)) && !allTicked('standrules')) e.push('All stand boxes must be true.');
      if (fail(e)) return;
      document.getElementById('send').disabled = true;
      const where = await gps();
      await queue('Stand & Camera Log', { form: 'stand', submittedOn: stamp(), gps: where,
        fields: { property: v('prop'), logging: logging.join(', '), ids: v('ids').trim(), share: picked('share'),
          checks: placing().length ? 'Placement rules confirmed' : '', notes: v('notes').trim(),
          noScreenshotReason: shot.length ? '' : v('why').trim() }, files: shot });
      showHome('Log saved for ' + esc(v('ids')) + '.' + (navigator.onLine ? '' : ' It will send as soon as you have signal.'));
    };
  }

  async function queue(label, payload) {
    const clientId = uid();
    await outbox('put', { clientId, label, created: Date.now(), payload: Object.assign({ clientId }, payload) });
    flush();
  }

  /* ---------- start ---------- */
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (me) { showHome(); quietRefresh().then(() => { if (me && document.getElementById('outbox-status')) showHome(); }); } else showLogin();
})();
