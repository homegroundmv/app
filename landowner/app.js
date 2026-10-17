/* Home Ground landowner app.
 * Sign in with the property code + PIN from the Home Ground email. Shows booked hunts, the notices the
 * landowner asked for, this season's deer, and messages with the hunters assigned to the property.
 */
(function () {
  'use strict';
  const CFG = window.HG_CONFIG || {};
  const $app = document.getElementById('app');
  const STORE_KEY = 'hg-landowner';

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const dayName = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); };
  const slotName = s => ({ AM: 'Morning', PM: 'Afternoon' }[s] || 'All day');
  const when = t => { const d = new Date(t); return isNaN(d) ? t : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); };
  const load = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
  const keep = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } };
  let me = load(STORE_KEY);
  let homeCache = me ? load('hg-lo-home') : null;
  let threadTimer = null;
  const stopThread = () => { if (threadTimer) { clearInterval(threadTimer); threadTimer = null; } };

  async function call(body) {
    if (!CFG.BACKEND_URL) throw new Error('The app isn\'t connected yet.');
    let res;
    try {
      res = await fetch(CFG.BACKEND_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ app: 'landowner' }, me ? { property: me.property, pin: me.pin } : {}, body)), redirect: 'follow' });
    } catch (e) { const err = new Error(navigator.onLine ? 'Couldn\'t reach Home Ground.' : 'No signal.'); err.offline = true; throw err; }
    let out;
    try { out = await res.json(); } catch (e) { const err = new Error('Home Ground sent back something unexpected. Please email ' + CFG.OFFICE_EMAIL + '.'); err.fatal = true; throw err; }
    if (!out.ok) { const e = new Error(out.error || 'Something went wrong.'); e.fatal = true; throw e; }
    return out;
  }

  function header() {
    return '<header class="top"><img src="../icon-192.png" alt=""><div><div class="who">' + esc(me.property) + (me.town ? ' · ' + esc(me.town) : '') +
      '</div><div class="sub">' + (me.role === 'owner' ? 'Landowner' : 'Caretaker') + (me.name ? ': ' + esc(me.name) : '') + ' · Home Ground</div></div></header>';
  }

  function showLogin(msg) {
    stopThread();
    $app.innerHTML = '<img class="login-logo" src="../logo.png" alt="Home Ground. Change starts with YES">' +
      '<div class="card"><h1>Landowner sign in</h1>' +
      '<p class="status">Use the property code and PIN from your Home Ground email.</p>' +
      (msg ? '<div class="note bad">' + esc(msg) + '</div>' : '') +
      '<label for="pc">Property code</label><input id="pc" type="text" autocapitalize="characters" placeholder="MV-001">' +
      '<label for="pin">PIN</label><input id="pin" type="password" inputmode="numeric" maxlength="6" placeholder="4 digits">' +
      '<button class="submit" id="go">Sign in</button>' +
      '<p class="status center">Trouble signing in? Email ' + esc(CFG.OFFICE_EMAIL) + ' or call ' + esc(CFG.OFFICE_PHONE) + '.</p></div>';
    document.getElementById('go').onclick = async () => {
      const property = document.getElementById('pc').value.trim(), pin = document.getElementById('pin').value.trim();
      if (!property || !pin) return showLogin('Enter your property code and PIN.');
      const b = document.getElementById('go'); b.disabled = true; b.textContent = 'Signing in…';
      try {
        const out = await call({ action: 'login', property, pin });
        me = { property: out.property, pin, role: out.role, name: out.name, town: out.town };
        keep(STORE_KEY, me); homeCache = null; showHome();
      } catch (e) { showLogin(e.offline ? 'No signal. Signing in needs a connection.' : e.message); }
    };
  }

  function showHome() {
    stopThread();
    $app.innerHTML = header() + '<div id="banner"></div><div id="push"></div>' +
      '<button class="big" id="msgs-btn">Messages<small>Message the hunters assigned to your property.</small></button>' +
      '<h2>Upcoming hunts</h2><div class="card" id="upcoming"><span class="status">Loading…</span></div>' +
      '<h2>Notices</h2><div class="card" id="feed"><span class="status">Loading…</span></div>' +
      '<h2>This season</h2><div class="card" id="season"><span class="status">Loading…</span></div>' +
      '<button class="big" id="pause-btn">Pause hunting or block out dates<small id="pause-sub">Takes effect right away. Your hunters are told.</small></button>' +
      '<button class="big alt" id="set-btn">Settings<small>Your notices and what hunters see.</small></button>' +
      '<p class="status">Questions? Call ' + esc(CFG.OFFICE_PHONE) + ' or email ' + esc(CFG.OFFICE_EMAIL) + '.</p>' +
      '<p class="center"><button class="plain" id="out">Sign out</button></p>';
    document.getElementById('msgs-btn').onclick = showMessages;
    document.getElementById('set-btn').onclick = showSettings;
    document.getElementById('pause-btn').onclick = () => showPauses();
    document.getElementById('out').onclick = () => { me = null; keep(STORE_KEY, null); keep('hg-lo-home', null); showLogin(); };
    drawHome(homeCache, false); refreshHome(); renderPush();
  }

  const sendPushToken = (token, device) => call({ action: 'pushtoken', token, device });
  function renderPush() {
    const box = document.getElementById('push');
    if (!box || !window.HGPush) return;
    box.innerHTML = HGPush.panel();
    HGPush.wire(() => HGPush.enable(sendPushToken, 'hg-push-lo'));
    HGPush.refresh(sendPushToken, 'hg-push-lo');
  }

  function drawHome(h, fresh) {
    const up = document.getElementById('upcoming');
    if (!up) return;
    if (!h) { if (!fresh) ['upcoming', 'feed', 'season'].forEach(id => { document.getElementById(id).innerHTML = '<span class="status">' + (navigator.onLine ? 'Loading…' : 'This will show when you have signal.') + '</span>'; }); return; }
    up.innerHTML = h.upcoming.length ? h.upcoming.map((b, i) => '<div class="feed-item"><b>' + esc(dayName(b.date)) + '</b> · ' + esc(slotName(b.slot)) +
      '<br><span class="status">' + esc(b.hunter) + '</span></div>').join('') : '<span class="status">No hunts booked in the next 30 days.</span>';
    document.getElementById('feed').innerHTML = h.feed.length ? h.feed.slice(0, 15).map(f => '<div class="feed-item"><b>' + esc(f.type) + '</b> <span class="status">' + esc(when(f.at)) + '</span><br>' + esc(f.text) + '</div>').join('')
      : '<span class="status">No notices yet. You get the notices you asked for on your permission form (see Settings).</span>';
    document.getElementById('season').innerHTML = '<div style="font-size:30px;font-weight:700">' + esc(h.deer) + ' <span class="status" style="font-size:15px;font-weight:400">deer taken on your property this season</span></div>' +
      '<div class="status">' + esc(h.hunters) + ' hunter' + (h.hunters === 1 ? '' : 's') + ' assigned' + (/paused/i.test(h.status) ? ' · Hunting is paused' : '') + '</div>';
    const ps = document.getElementById('pause-sub');
    if (ps && h.pauses) ps.textContent = h.pauses.length ? h.pauses.length + ' pause' + (h.pauses.length === 1 ? '' : 's') + ' set. Tap to see, add or remove.' : 'Takes effect right away. Your hunters are told.';
    const mb = document.getElementById('msgs-btn');
    if (mb) mb.firstChild.textContent = h.unread ? 'Messages (' + h.unread + ' new)' : 'Messages';
    const ban = document.getElementById('banner');
    const ask = (!window.HGPush || HGPush.state() === 'off') && window.Notification && Notification.permission === 'default';
    ban.innerHTML = (!fresh && h ? '<p class="status">Last updated when you had signal.</p>' : '') +
      (ask ? '<p class="status"><button class="plain" id="notif">Show notices on this phone while the app is open</button></p>' : '');
    const n = document.getElementById('notif'); if (n) n.onclick = () => Notification.requestPermission().then(() => drawHome(h, fresh));
  }

  async function refreshHome() {
    if (!me || !navigator.onLine) return;
    try {
      const h = await call({ action: 'home' });
      const seen = load('hg-lo-seen') || [];
      const fresh = h.feed.filter(f => seen.indexOf(f.at + f.text) < 0);
      const pushed = window.HGPush && HGPush.state() === 'granted';   // pushes already showed them
      if (!pushed && seen.length && fresh.length && window.Notification && Notification.permission === 'granted' && navigator.serviceWorker) {
        const reg = await navigator.serviceWorker.getRegistration();
        fresh.slice(0, 3).forEach(f => reg && reg.showNotification(f.type + ' · ' + me.property, { body: f.text, icon: '../icon-192.png', tag: f.at + f.type }));
      }
      keep('hg-lo-seen', h.feed.map(f => f.at + f.text).slice(0, 60));
      homeCache = h; keep('hg-lo-home', h); drawHome(h, true);
    } catch (e) {
      if (e.fatal && /match|enrolled|PIN/.test(e.message)) { me = null; keep(STORE_KEY, null); return showLogin(e.message); }
      drawHome(homeCache, false);
    }
  }
  setInterval(() => { if (!document.hidden && document.getElementById('feed')) refreshHome(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && document.getElementById('feed')) refreshHome(); });

  async function showMessages() {
    stopThread();
    $app.innerHTML = header() + '<h1>Messages</h1><p class="status">Only the hunters assigned to ' + esc(me.property) + ' can message you, and only through this app. ' +
      'They never see your phone number or email. Messages are kept on record by Home Ground.</p>' +
      '<div class="card" id="threads"><span class="status">Loading…</span></div><p class="center"><button class="plain" id="back">Back</button></p>';
    document.getElementById('back').onclick = showHome;
    const box = document.getElementById('threads');
    try {
      const out = await call({ action: 'threads' });
      box.innerHTML = out.threads.length ? out.threads.map((t, i) => '<button class="plain" data-h="' + esc(t.hunter) + '" style="display:block;width:100%;text-align:left;text-decoration:none;color:inherit;padding:10px 0' + (i ? ';border-top:1px solid var(--line)' : '') + '">' +
        '<b>' + esc(t.name) + ' (' + esc(t.hunter) + ')</b>' + (t.unread ? ' <span class="pill wait">' + t.unread + ' new</span>' : '') +
        '<br><span class="status">' + (t.last ? esc(t.last) : 'No messages yet') + '</span></button>').join('')
        : '<span class="status">No hunters are assigned to your property yet.</span>';
      box.querySelectorAll('[data-h]').forEach(b => b.onclick = () => showThread(b.dataset.h));
    } catch (e) { box.innerHTML = '<span class="status">' + esc(e.offline ? 'Messages need signal.' : e.message) + '</span>'; }
  }

  async function showThread(hunter) {
    stopThread();
    $app.innerHTML = header() + '<h1 id="th-title">' + esc(hunter) + '</h1><div class="card" id="msgs"><span class="status">Loading…</span></div>' +
      '<textarea id="msg" maxlength="1000" placeholder="Write a message"></textarea><div id="err" class="err"></div>' +
      '<button class="submit" id="send">Send</button><p class="center"><button class="plain" id="back">Back to messages</button></p>';
    document.getElementById('back').onclick = () => { stopThread(); showMessages(); };
    const draw = async () => {
      try {
        const out = await call({ action: 'thread', hunter });
        const box = document.getElementById('msgs');
        if (!box) return stopThread();
        document.getElementById('th-title').textContent = out.name + ' (' + out.hunter + ')';
        box.innerHTML = out.messages.length ? out.messages.map(m => '<div class="bubble ' + (m.mine ? 'mine' : 'theirs') + '">' + esc(m.text) +
          '<div class="meta">' + esc(m.from === 'Owner' ? 'Landowner' : m.from === 'Caretaker' ? 'Caretaker' : out.name) + ' · ' + esc(when(m.at)) + '</div></div>').join('')
          : '<span class="status">No messages yet.</span>';
        box.scrollTop = box.scrollHeight;
      } catch (e) { const box = document.getElementById('msgs'); if (box) box.innerHTML = '<span class="status">' + esc(e.offline ? 'Messages need signal.' : e.message) + '</span>'; }
    };
    document.getElementById('send').onclick = async () => {
      const text = document.getElementById('msg').value.trim();
      if (!text) return;
      const b = document.getElementById('send'); b.disabled = true; b.textContent = 'Sending…';
      try { await call({ action: 'send', hunter, text, clientId: uid() }); document.getElementById('msg').value = ''; document.getElementById('err').textContent = ''; await draw(); }
      catch (e) { document.getElementById('err').textContent = e.offline ? 'No signal. Your message wasn\'t sent.' : e.message; }
      b.disabled = false; b.textContent = 'Send';
    };
    await draw();
    threadTimer = setInterval(() => { if (!document.hidden && navigator.onLine) draw(); }, 20000);
  }

  /* ---------- pause hunting / block out dates ---------- */
  const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  function pauseList(list) {
    return list && list.length ? list.map((p, i) => '<div class="feed-item"><b>' + esc(p.text.charAt(0).toUpperCase() + p.text.slice(1)) + '</b>' +
      (p.note ? '<br><span class="status">' + esc(p.note) + '</span>' : '') + '<br>' +
      (p.mine ? '<button class="plain" data-unpause="' + i + '" style="color:var(--bad)">Remove this pause</button>'
        : '<span class="status">Set by Home Ground. Call ' + esc(CFG.OFFICE_PHONE) + ' to change it.</span>') + '</div>').join('')
      : '<span class="status">No pauses set. Hunters can book any day allowed by your permission terms.</span>';
  }
  function showPauses(done) {
    stopThread();
    window.scrollTo(0, 0);
    const today = iso(new Date());
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const radio = (name, opts, pick) => opts.map(o => '<label class="choice"><input type="radio" name="' + name + '" value="' + o[0] + '"' + (o[0] === pick ? ' checked' : '') + '> ' + o[1] + '</label>').join('');
    $app.innerHTML = header() + '<h1>Pause hunting</h1>' + (done ? '<div class="note ok">' + esc(done) + '</div>' : '') +
      '<h2>Current pauses</h2><div class="card" id="plist">' + pauseList(homeCache && homeCache.pauses) + '</div>' +
      '<h2>Add a pause</h2><div class="card">' +
      '<label>What kind of pause?</label>' + radio('kind', [['dates', 'Specific dates'], ['weekly', 'The same days every week'], ['season', 'The rest of the season']], 'dates') +
      '<div id="k-dates"><div class="row"><div><label for="from">From</label><input id="from" type="date" min="' + today + '" value="' + today + '"></div>' +
      '<div><label for="to">To</label><input id="to" type="date" min="' + today + '" value="' + today + '"></div></div></div>' +
      '<div id="k-weekly" hidden><label>Which days?</label>' + days.map(d => '<label class="choice"><input type="checkbox" name="wd" value="' + d + '"> ' + d + '</label>').join('') +
      '<label for="until">Until <span class="hint">Leave blank for the rest of the season.</span></label><input id="until" type="date" min="' + today + '"></div>' +
      '<div id="k-season" hidden><label for="sfrom">Starting</label><input id="sfrom" type="date" min="' + today + '" value="' + today + '"></div>' +
      '<div id="k-time"><label>Time of day</label>' + radio('slot', [['All day', 'All day'], ['AM', 'Mornings only'], ['PM', 'Afternoons only']], 'All day') + '</div>' +
      '<label for="pnote">Note for your hunters <span class="hint">Optional, e.g. "Family visiting". No need to give a reason.</span></label><input id="pnote" type="text" maxlength="200">' +
      '<div id="err" class="err"></div><button class="submit" id="go">Pause hunting</button>' +
      '<p class="status">It takes effect right away. Any hunter booked in that time has their booking cancelled and is told, and all your hunters are notified.</p></div>' +
      '<p class="center"><button class="plain" id="wd-btn">Withdraw from the program</button></p>' +
      '<p class="center"><button class="plain" id="back">Back</button></p>';
    document.getElementById('back').onclick = showHome;
    document.getElementById('wd-btn').onclick = showWithdraw;
    const kind = () => (document.querySelector('input[name=kind]:checked') || {}).value;
    const sync = () => { ['dates', 'weekly', 'season'].forEach(k => { document.getElementById('k-' + k).hidden = kind() !== k; }); document.getElementById('k-time').hidden = kind() === 'season'; };
    document.querySelectorAll('input[name=kind]').forEach(r => r.onchange = sync);
    document.getElementById('from').onchange = e => { const t = document.getElementById('to'); if (t.value < e.target.value) t.value = e.target.value; t.min = e.target.value; };
    document.querySelectorAll('[data-unpause]').forEach(b => b.onclick = async () => {
      const p = homeCache.pauses[Number(b.dataset.unpause)];
      if (!confirm('Remove this pause? ' + p.text)) return;
      b.disabled = true; b.textContent = 'Removing…';
      try { const out = await call({ action: 'unpause', id: p.id }); homeCache.pauses = out.pauses; keep('hg-lo-home', homeCache); showPauses('Pause removed. Your hunters have been told.'); }
      catch (e) { b.disabled = false; b.textContent = e.offline ? 'No signal. Try again.' : e.message; }
    });
    document.getElementById('go').onclick = async () => {
      const k = kind(), err = document.getElementById('err'), btn = document.getElementById('go');
      const slot = (document.querySelector('input[name=slot]:checked') || {}).value || 'All day';
      const body = { action: 'pause', kind: k, slot: k === 'season' ? 'All day' : slot, note: document.getElementById('pnote').value.trim() };
      if (k === 'dates') { body.from = document.getElementById('from').value; body.to = document.getElementById('to').value; if (!body.from) { err.textContent = 'Pick a start date.'; return; } }
      if (k === 'weekly') { body.days = [...document.querySelectorAll('input[name=wd]:checked')].map(x => x.value); body.from = today; body.to = document.getElementById('until').value;
        if (!body.days.length) { err.textContent = 'Pick at least one day.'; return; } }
      if (k === 'season') body.from = document.getElementById('sfrom').value || today;
      btn.disabled = true; btn.textContent = 'Pausing…';
      try {
        const out = await call(body);
        if (homeCache) { homeCache.pauses = out.pauses; keep('hg-lo-home', homeCache); }
        showPauses('Paused: ' + out.text + '.' + (out.cancelled ? ' ' + out.cancelled + ' booked hunter' + (out.cancelled === 1 ? ' was' : 's were') + ' told and the booking cancelled.' : '') + ' Your hunters have been notified.');
      } catch (e) { btn.disabled = false; btn.textContent = 'Pause hunting'; err.textContent = e.offline ? 'No signal, so nothing was paused. Try again, or call ' + CFG.OFFICE_PHONE + '.' : e.message; }
    };
  }
  function showWithdraw() {
    $app.innerHTML = header() + '<h1>Withdraw from the program</h1>' +
      '<p>If you\'d like hunting on your property to end, let us know here. Joe will call you to confirm before anything changes, and to arrange for any stands or cameras to be removed at times that suit you.</p>' +
      '<p class="status">If you just need a break, a pause may be simpler: hunting stops right away and you can lift it any time.</p>' +
      '<label for="wnote">Anything you\'d like us to know? <span class="hint">Optional. No reason needed.</span></label><textarea id="wnote" maxlength="500"></textarea>' +
      '<div id="err" class="err"></div><button class="submit" id="go" style="background:var(--bad)">Send my request to Home Ground</button>' +
      '<p class="center"><button class="plain" id="back">Back</button></p>';
    document.getElementById('back').onclick = () => showPauses();
    document.getElementById('go').onclick = async () => {
      const b = document.getElementById('go'); b.disabled = true; b.textContent = 'Sending…';
      try { await call({ action: 'withdraw', note: document.getElementById('wnote').value.trim() });
        $app.innerHTML = header() + '<div class="note ok">Request sent. Joe will call you to confirm. Nothing changes until then.</div><p class="center"><button class="plain" id="back">Back to home</button></p>';
        document.getElementById('back').onclick = showHome; }
      catch (e) { b.disabled = false; b.textContent = 'Send my request to Home Ground'; document.getElementById('err').textContent = e.offline ? 'No signal. Try again, or call ' + CFG.OFFICE_PHONE + '.' : e.message; }
    };
  }

  function showSettings() {
    stopThread();
    const h = homeCache;
    const s = h ? h.settings : null;
    const owner = me.role === 'owner';
    const yn = v => v ? 'Yes' : 'No';
    $app.innerHTML = header() + '<h1>Settings</h1>' +
      (s ? '<h2>What your hunters see</h2><div class="card">' +
        '<label class="switch"><span>Show my first name to my hunters<br><span class="status">Now they see: ' + esc(s.label) + '</span></span><input type="checkbox" id="showName"' + (s.showName ? ' checked' : '') + (owner ? '' : ' disabled') + '></label>' +
        '<label class="switch"><span>Let my hunters message me<br><span class="status">You can always message them.</span></span><input type="checkbox" id="allowMessages"' + (s.allowMessages ? ' checked' : '') + (owner ? '' : ' disabled') + '></label>' +
        (owner ? '' : '<p class="status">Only the owner can change these.</p>') + '<div id="set-msg" class="status"></div></div>' +
        '<h2>Notices you asked for</h2><div class="card">' +
        '<div class="feed-item"><b>When a hunter is booked, and the morning of the hunt:</b> ' + yn(s.hunt) + (s.hunt && s.days ? ' (' + esc(s.days) + ')' : '') + '</div>' +
        '<div class="feed-item"><b>When a hunter goes in after dark to recover a deer:</b> ' + yn(s.dark) + '</div>' +
        '<div class="feed-item"><b>When a deer is harvested:</b> ' + yn(s.harvest) + '</div>' +
        '<div class="feed-item"><b>Notices are also emailed to:</b> ' + (s.emails.length ? esc(s.emails.join(', ')) : 'nobody') + '</div>' +
        '<p class="status">These come from your permission form. To change them, use the "UPDATE MY PREFERENCES" form on <a href="' + esc(CFG.WEBSITE) + '">' + esc(CFG.WEBSITE.replace(/^https?:\/\//, '')) + '</a> or email ' + esc(CFG.OFFICE_EMAIL) + '.</p></div>'
        : '<div class="note warn">Settings will show when you have signal.</div>') +
      '<p class="center"><button class="plain" id="back">Back</button></p>';
    document.getElementById('back').onclick = showHome;
    if (!s || !owner) return;
    ['showName', 'allowMessages'].forEach(id => {
      document.getElementById(id).onchange = async (ev) => {
        const box = document.getElementById('set-msg'); box.textContent = 'Saving…';
        try {
          const out = await call({ action: 'settings', [id]: ev.target.checked });
          homeCache = out; keep('hg-lo-home', out); showSettings();
          document.getElementById('set-msg').textContent = 'Saved.';
        } catch (e) { ev.target.checked = !ev.target.checked; box.textContent = e.offline ? 'No signal. Not saved.' : e.message; }
      };
    });
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (me) showHome(); else showLogin();
})();
