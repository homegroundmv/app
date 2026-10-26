/* Home Ground Facility app (v2): processors' phones and the intake laptop.
 * Sign in with your staff number (P-001) and PIN.
 * Screens: Home (help alerts, clock in/out, your numbers), Cooler board, Check in a deer, Book your time,
 * Messages (team chat and direct), Need help, My numbers, Team numbers (managers),
 * Daily log, Donation report.
 * Deer actions and log entries are saved on the device first and sent when there's signal.
 * The deer's field band number is its ID all the way through.
 */
(function () {
  'use strict';
  const CFG = window.HG_CONFIG || {};
  const $app = document.getElementById('app');
  const KEY = 'hg-facility';

  /* ---------- helpers ---------- */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const stamp = d => { d = d || new Date(); return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear() + ' ' + d.getHours() + ':' + pad(d.getMinutes()); };
  const parse = s => { const m = String(s || '').match(/(\d+)\/(\d+)\/(\d{4})(?:\s+(\d+):(\d+)(?::(\d+))?)?/); return m ? new Date(+m[3], m[1] - 1, +m[2], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) : null; };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const band = s => String(s || '').trim().toUpperCase().replace(/\s+/g, '');
  const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
  const r1 = n => Math.round(n * 10) / 10;
  const fmt = n => r1(n).toLocaleString('en-US');
  const isoDate = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const dayName = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); };
  const t12 = hm => { const [h, m] = String(hm).split(':').map(Number); const ap = h >= 12 ? 'pm' : 'am'; const hh = h % 12 || 12; return hh + (m ? ':' + pad(m) : '') + ' ' + ap; };
  const when = t => { const d = parse(t); return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : esc(t); };
  // Intake band colour: the roll in the printer changes every day through a 5-colour cycle (Settings), so no two deer
  // in the cooler share a colour (a deer hangs at most 5 days).
  const BAND_HEX = { 'aqua': '#00B5B8', 'yellow': '#F5D000', 'orange': '#F57C00', 'day glow green': '#39E046', 'day glow pink': '#FF4FA8' };
  const hexFor = name => BAND_HEX[String(name || '').toLowerCase()] || '#999';
  function bandColour(when) {
    const s = S(), list = s.bandColours && s.bandColours.length ? s.bandColours : ['Aqua', 'Yellow', 'Orange', 'Day Glow Green', 'Day Glow Pink'];
    const d = when instanceof Date ? when : parse(when), b = String(s.bandStart || '2026-11-01').split('-').map(Number);
    if (!d || b.length < 3) return '';
    const days = Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(b[0], b[1] - 1, b[2])) / 864e5);
    return list[((days % list.length) + list.length) % list.length];
  }
  const colourOf = d => d['Band colour'] || bandColour(d.Intake);
  const swatch = name => name ? '<span class="dot" style="background:' + hexFor(name) + '"></span>' + esc(name) + ' band' : '';
  // Processing urgency from hours hung (Joe, 25 Oct): Low, Medium, High, Urgent at the start-by time, Overdue at the
  // maximum hold. Donated deer move up one level (they go first), but never to Overdue on that alone.
  const LEVELS = [['Low', '#5B7F3A'], ['Medium', '#C9A100'], ['High', '#E07000'], ['Urgent', '#C0392B'], ['Overdue', '#5A0F0F']];
  function urgency(d) {
    const s = S(), h = hoursHung(d), start = s.startBy || 96, max = s.maxHold || 120;
    let i = h >= max ? 4 : h >= start ? 3 : h >= start - 24 ? 2 : h >= start - 48 ? 1 : 0;
    if (d.Type === 'Donated' && i < 3) i++;
    return { level: LEVELS[i][0], colour: LEVELS[i][1], i, hours: h };
  }

  function load() { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; } }
  let st = load();          // { number, pin, staff, device, home, outbox:[], synced }
  st.outbox = st.outbox || [];
  st.device = st.device || uid();
  st.home = st.home || {};
  function save() { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* keep in memory */ } }
  save();
  const S = () => st.home.settings || { coolerCap: 30, coolerAlert: 80, startBy: 72, maxHold: 120, maxAtOnce: 6, slots: [], pieceRate: 125, minWage: 15, pkgSize: 2, fatDonated: 10, fatPrivate: 10, privatePrice: 250, porkAddOn: 20, porkInStock: true, pantries: [], helpHours: 4 };
  const isMgr = () => !!(st.staff && st.staff.manager);
  const isViewer = () => !!(st.staff && st.staff.viewer);

  /* ---------- backend ---------- */
  async function call(body) {
    if (!CFG.BACKEND_URL || /PASTE_/.test(CFG.BACKEND_URL)) { const e = new Error('The app isn\'t connected yet (backend address missing).'); e.fatal = true; throw e; }
    let res;
    try {
      res = await fetch(CFG.BACKEND_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ number: st.number, pin: st.pin, device: st.device }, body)), redirect: 'follow' });
    } catch (e) { const err = new Error(navigator.onLine ? 'Couldn\'t reach the server.' : 'No signal.'); err.offline = true; throw err; }
    let out;
    try { out = await res.json(); } catch (e) { const err = new Error('The server sent back something unexpected (status ' + res.status + ').'); err.fatal = true; throw err; }
    if (!out.ok) { const e = new Error(out.error || 'Something went wrong.'); e.fatal = true; throw e; }
    return out;
  }

  /* ---------- outbox: deer actions and log entries wait here until sent ---------- */
  function queue(action, fields, label) {
    st.outbox.push({ clientId: uid(), action, fields, at: stamp(), label, created: Date.now(), by: st.number });
    save(); flush();
  }
  let flushing = false;
  async function flush() {
    if (flushing || !st.pin) return;
    flushing = true;
    try {
      for (const it of st.outbox.slice()) {
        if (it.error) continue;
        if (it.by && it.by !== st.number) continue;   // someone else's entry (or demo vs real): it waits for them to sign in here again
        try {
          await call({ action: it.action, fields: it.fields, at: it.at, clientId: it.clientId });
          st.outbox = st.outbox.filter(x => x.clientId !== it.clientId);
        } catch (e) {
          if (e.fatal) it.error = e.message; else break;
        }
        save();
      }
      if (!st.outbox.some(x => !x.error && (!x.by || x.by === st.number))) await refresh(true);
    } finally { flushing = false; status(); }
  }
  async function refresh(quiet) {
    try {
      const out = await call({ action: 'home' });
      st.home = out; st.synced = stamp(); save();
      redraw();
      notifyNewAlerts();
    } catch (e) {
      if (e.fatal && /PIN|switched off/.test(e.message)) { signOut(e.message); return; }
      if (!quiet) toast(e.message);
    }
  }
  // Redraw only screens that just show data, never one with a form being filled in.
  function redraw() {
    if (current === 'home') showHome();
    if (current === 'board' && !document.querySelector('.form input, .form select')) showBoard();
    if (current === 'donate' && !document.querySelector('.form input, .form select, #lic2:focus')) showDonate();
    if (current === 'deer' && shownBand && !document.querySelector('.form input, .form select')) showDeer(shownBand);
  }
  window.addEventListener('online', flush);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) flush(); });
  setInterval(() => { if (!document.hidden && (current === 'home' || current === 'board' || current === 'donate')) { flush(); if (!flushing) refresh(true); } }, 45000);

  function status() {
    const el = document.getElementById('sync');
    if (!el) return;
    const waiting = st.outbox.filter(x => !x.error), bad = st.outbox.filter(x => x.error);
    el.innerHTML = (waiting.length ? '<span class="pill wait">' + waiting.length + ' waiting to send</span> ' +
      (navigator.onLine ? '' : '<span class="status">No signal. They\'ll send on their own.</span>')
      : '<span class="pill">Everything sent</span> <span class="status">Updated ' + esc(st.synced || '—') + '</span>') +
      bad.map(i => '<div class="note bad">' + esc(i.label) + ' was not accepted: ' + esc(i.error) +
        ' <button class="plain" data-drop="' + esc(i.clientId) + '">Remove it</button></div>').join('');
    el.querySelectorAll('[data-drop]').forEach(b => b.onclick = () => { st.outbox = st.outbox.filter(x => x.clientId !== b.dataset.drop); save(); status(); });
  }
  function toast(msg, ok) {
    const el = document.getElementById('msg');
    if (el) { el.innerHTML = '<div class="note ' + (ok ? 'ok' : 'bad') + '">' + esc(msg) + '</div>'; window.scrollTo(0, 0); }
  }

  // The deer as the server last sent them, with anything still waiting to send applied on top.
  function deerList() {
    const list = (st.home.deer || []).map(d => Object.assign({}, d));
    const by = b => list.find(d => band(d.Band) === b && d.Status !== 'Released');
    st.outbox.filter(x => !x.error).forEach(x => {
      const f = x.fields, b = band(f.band);
      if (!b) return;
      const d = by(b);
      if (x.action === 'intake' && !d) list.push({ Band: b, Intake: x.at, 'Hunter number': f.hunterNumber, 'Hunter name': f.hunterName || ((f.firstName || '') + ' ' + (f.lastName || '')).trim(), 'MassWildlife confirmation': f.confirmation, Deer: f.deer, Type: f.type, 'Pork fat added': f.porkFat ? 'Yes' : (f.type === 'Donated' ? 'Yes' : 'No'), Status: 'Hanging', pending: true });
      if (!d) return;
      d.pending = true;
      if (x.action === 'start') { d.Status = 'Processing'; d['Processing started'] = x.at; d['Processor number'] = f.processor || st.staff.number; d.Butcher = f.processorName || st.staff.name; d['Carcass weight (lb)'] = f.weight; }
      if (x.action === 'finish') { d.Status = 'Ready'; d['Pounds packaged'] = f.total; d.Packages = num(f.groundPackages) + num(f.intactPackages); }
      if (x.action === 'release') { d.Status = 'Released'; d.Released = x.at; d['Released to'] = f.to; }
    });
    return list;
  }

  /* ---------- frame ---------- */
  let current = '';
  let threadTimer = null;
  const stopThread = () => { if (threadTimer) { clearInterval(threadTimer); threadTimer = null; } };
  function frame(name, title, body, noBack) {
    stopThread();
    current = name;
    $app.innerHTML =
      '<header class="top"><img src="icon-192.png" alt=""><div><div class="who">' + esc(st.staff && st.staff.name) + ' · ' + esc(st.staff && st.staff.number) + '</div>' +
      '<div class="sub">Home Ground Facility · <button class="plain" id="out" style="padding:0">Sign out</button></div></div></header>' +
      (noBack ? '' : '<button class="plain" id="home-btn">← Home</button>') +
      (title ? '<h1>' + title + '</h1>' : '') +
      (st.staff && st.staff.demo ? '<div class="note warn"><b>Demo sign-in.</b> Practice data: nothing here goes into the real Facility Log.</div>' : '') +
      '<div id="sync" class="status"></div><div id="msg"></div>' + body;
    document.getElementById('out').onclick = () => signOut();
    const hb = document.getElementById('home-btn');
    if (hb) hb.onclick = () => showHome();
    status();
    window.scrollTo(0, 0);
  }
  function signOut(msg) { st.pin = ''; st.staff = null; st.home = {}; save(); showLogin(msg); }

  function showLogin(msg) {
    stopThread();
    current = 'login';
    $app.innerHTML = '<img class="login-logo" src="logo.png" alt="Home Ground. Change starts with YES">' +
      '<div class="card"><h1>Facility sign-in</h1>' + (msg ? '<div class="note bad">' + esc(msg) + '</div>' : '') +
      '<label for="num">Your staff number</label><input id="num" type="text" autocapitalize="characters" placeholder="P-001" value="' + esc(st.number || '') + '">' +
      '<label for="pin">Your PIN</label><input id="pin" type="password" inputmode="numeric" maxlength="6" placeholder="4 digits">' +
      '<button class="submit" id="go">Sign in</button></div>';
    const go = async () => {
      const btn = document.getElementById('go'); btn.disabled = true;
      st.number = document.getElementById('num').value.trim(); st.pin = document.getElementById('pin').value.trim();
      try { const out = await call({ action: 'login' }); st.staff = out.staff; st.number = out.staff.number; save(); showHome(); refresh().then(() => { if (pendingBand) { const b = pendingBand; pendingBand = null; showDeer(b); } }); flush(); }
      catch (e) { st.pin = ''; save(); showLogin(e.offline ? 'No signal. Sign-in needs a connection.' : e.message); }
    };
    document.getElementById('go').onclick = go;
    document.getElementById('pin').onkeydown = e => { if (e.key === 'Enter') go(); };
  }

  /* ---------- home ---------- */
  function hoursHung(d) { const t = parse(d.Intake); return t ? Math.max(0, (Date.now() - t) / 36e5) : 0; }
  function coolerCount() { return deerList().filter(d => d.Status === 'Hanging' || d.Status === 'Processing').length; }

  let homeNote = null;   // a confirmation stays on Home for 20 seconds, through background refreshes
  function showHome(note) {
    if (note) homeNote = { text: note, until: Date.now() + 20000 };
    else if (homeNote && Date.now() < homeNote.until) note = homeNote.text;
    const h = st.home, s = S(), m = h.mine || {}, inC = coolerCount();
    const next = (h.myShifts || [])[0];
    const clockCard = '<div class="card"><div class="deer"><div>' +
      (h.clockedIn ? '<b>Clocked in</b><div class="status">Since ' + esc(when(h.clockedIn)) + '</div>' : '<b>Not clocked in</b><div class="status">Clock in when you start work, including cleaning and training time.</div>') +
      (next ? '<div class="status">Next booking: ' + esc(dayName(next.date)) + ', ' + t12(next.starts) + '–' + t12(next.ends) + '</div>' : '') +
      '</div><button class="btn' + (h.clockedIn ? ' alt' : '') + '" id="clock">' + (h.clockedIn ? 'Clock out' : 'Clock in') + '</button></div><div id="clock-err" class="err"></div></div>';
    const tiles = '<div class="tiles">' +
      tile(m.deer || 0, 'Deer processed') + tile(m.donated || 0, 'Donated deer') +
      tile(fmt(m.packagedLb || 0), 'lb packaged') + tile(fmt(m.groundVenisonLb || 0), 'lb ground venison') + '</div>' +
      '<p class="status center">Your season so far · ' + esc(s.pkgSize) + ' lb packages, ' + esc(s.fatDonated) + '% pork fat</p>';
    if (isViewer()) {
      frame('home', '', '<div class="note ok">View-only sign-in: you can look at everything below, but nothing can be changed from this sign-in.</div>' +
        group('Check on things') +
        big('status', 'Facility status', 'Cooler, oldest deer, temperatures, who\'s here', 'view') +
        big('board', 'Cooler', inC + ' of ' + s.coolerCap + ' in the cooler' + (inC >= s.coolerCap ? ' · FULL' : ''), 'view') +
        group('Office') +
        big('martin', 'Donation report', 'Donated deer for Martin\'s sheet', 'alt') +
        big('payments', 'Hunter payments', 'Donation checks owed and sent, with mailing addresses', 'alt'), true);
      $app.querySelectorAll('[data-go]').forEach(b => b.onclick = () => GO[b.dataset.go]());
      return;
    }
    frame('home', '',
      (note ? '<div class="note ok">' + note + '</div>' : '') +
      '<div id="alerts">' + alertsHtml() + '</div><div id="push"></div>' + clockCard + tiles +
      group('Work') +
      big('intake', 'Check in a deer', 'Band, tag, hunter, print the intake band' + (bandColour(new Date()) ? ' · today\'s band: ' + bandColour(new Date()) : '')) +
      big('scan', 'Scan a band', 'Point at the QR code: see how urgent that deer is') +
      big('shifts', 'Book your time', 'Pick your own start and end · up to ' + s.maxAtOnce + ' at once') +
      big('daily', 'Daily log', 'Temperatures, cleaning, waste, complaints') +
      big('messages', 'Messages' + (h.unread ? ' (' + h.unread + ' new)' : ''), 'Team chat and direct messages') +
      big('help', 'Need help', 'Sends a notification to everyone on the team', 'red') +
      group('Check on things') +
      big('status', 'Facility status', 'Cooler, oldest deer, temperatures, who\'s here', 'view') +
      big('board', 'Cooler', inC + ' of ' + s.coolerCap + ' in the cooler' + (inC >= s.coolerCap ? ' · FULL' : ''), 'view') +
      big('numbers', 'My numbers', 'Deer, pounds, hours and pay this week', 'view') +
      (isMgr() ? big('team', 'Team numbers', 'Every processor, this week and the season', 'view') : '') +
      group('Office') +
      big('martin', 'Donation report', 'Copy new rows to paste into Martin\'s sheet', 'alt') +
      (isMgr() ? big('payments', 'Hunter payments', 'Donation checks owed and sent, with mailing addresses', 'alt') : ''), true);
    $app.querySelectorAll('[data-go]').forEach(b => b.onclick = () => GO[b.dataset.go]());
    document.getElementById('clock').onclick = async e => {
      const b = e.target; b.disabled = true;
      try { const out = await call({ action: 'clock', dir: h.clockedIn ? 'out' : 'in' }); st.home.clockedIn = out.clockedIn; st.home.week = out.week; save(); showHome(); }
      catch (x) { b.disabled = false; document.getElementById('clock-err').textContent = x.offline ? 'Clocking in or out needs signal. Tell Joe the time if you can\'t get signal.' : x.message; }
    };
    wireAlerts();
    renderPush();
  }
  const tile = (n, label) => '<div class="tile"><div class="n">' + esc(n) + '</div><div class="l">' + esc(label) + '</div></div>';
  const group = t => '<div class="grp">' + esc(t) + '</div>';
  (() => { const c = document.createElement('style');
    c.textContent = '.grp{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:20px 2px 4px}' +
      '.big.view{background:var(--card);color:var(--green-dark);border:2px solid var(--green)}.big.view small{opacity:.8}';
    document.head.appendChild(c); })();
  const big = (go, title, sub, cls) => '<button class="big' + (cls ? ' ' + cls : '') + '" data-go="' + go + '">' + esc(title) + '<small>' + esc(sub) + '</small></button>';

  function alertsHtml() {
    return (st.home.alerts || []).map(a => '<div class="card alert' + (/injury|food-safety|full/i.test(a.reason) ? ' red' : ' amber') + '">' +
      '<b>' + esc(a.mine ? 'You asked: ' : a.from === 'Home Ground' ? '' : a.name + ': ') + esc(a.reason) + '</b>' +
      (a.note ? '<div>' + esc(a.note) + '</div>' : '') +
      '<div class="status">' + esc(when(a.sent)) + (a.onWay.length ? ' · On the way: ' + esc(a.onWay.join(', ')) : '') + '</div>' +
      '<div class="actions">' + (!a.mine && a.onWay.indexOf(st.staff.name) < 0 ? '<button class="btn" data-ack="' + esc(a.id) + '">On my way</button>' : '') +
      (a.canClose ? '<button class="btn ghost" data-done="' + esc(a.id) + '">' + (a.mine ? 'Sorted, close it' : 'Close') + '</button>' : '') + '</div></div>').join('');
  }
  function wireAlerts() {
    const box = document.getElementById('alerts');
    if (!box) return;
    box.querySelectorAll('[data-ack],[data-done]').forEach(b => b.onclick = async () => {
      b.disabled = true;
      try { const out = await call(b.dataset.ack ? { action: 'helpack', id: b.dataset.ack } : { action: 'helpdone', id: b.dataset.done }); st.home.alerts = out.alerts; save(); box.innerHTML = alertsHtml(); wireAlerts(); }
      catch (e) { b.disabled = false; toast(e.offline ? 'Needs signal.' : e.message); }
    });
  }
  // If notifications aren't on, at least buzz and show one when a new request arrives while the app is open.
  function notifyNewAlerts() {
    let seen = [];
    try { seen = JSON.parse(localStorage.getItem('hg-fac-seen') || '[]'); } catch (e) { /* ignore */ }
    const fresh = (st.home.alerts || []).filter(a => !a.mine && seen.indexOf(a.id) < 0);
    if (!fresh.length) return;
    if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
    const pushed = window.HGPush && HGPush.state() === 'granted';
    if (!pushed && window.Notification && Notification.permission === 'granted' && navigator.serviceWorker) {
      navigator.serviceWorker.getRegistration().then(reg => fresh.forEach(a => reg && reg.showNotification(a.reason, { body: (a.from === 'Home Ground' ? '' : a.name + ': ') + (a.note || ''), icon: 'icon-192.png', tag: a.id })));
    }
    try { localStorage.setItem('hg-fac-seen', JSON.stringify(seen.concat(fresh.map(a => a.id)).slice(-80))); } catch (e) { /* ignore */ }
  }
  const sendPushToken = (token, device) => call({ action: 'pushtoken', token, device });
  function renderPush() {
    const box = document.getElementById('push');
    if (!box || !window.HGPush) return;
    box.innerHTML = HGPush.panel();
    HGPush.wire(() => HGPush.enable(sendPushToken, 'hg-push-facility'));
    HGPush.refresh(sendPushToken, 'hg-push-facility');
  }

  /* ---------- cooler board ---------- */
  function showBoard() {
    const s = S();
    const all = deerList();
    const hanging = all.filter(d => d.Status === 'Hanging').sort((a, b) => (a.Type === 'Donated' ? 0 : 1) - (b.Type === 'Donated' ? 0 : 1) || hoursHung(b) - hoursHung(a));
    const proc = all.filter(d => d.Status === 'Processing');
    const ready = all.filter(d => d.Status === 'Ready');
    const released = all.filter(d => d.Status === 'Released').slice(-10).reverse();
    const n = hanging.length + proc.length, full = n >= s.coolerCap;
    const card = deerCard;
    const section = (title, list, empty) => '<h2>' + title + ' (' + list.length + ')</h2>' + (list.length ? list.map(card).join('') : '<p class="status">' + empty + '</p>');
    frame('board', 'Cooler',
      '<div class="card"><b>In the cooler: ' + n + ' of ' + s.coolerCap + '</b>' +
      (full ? '<div class="note bad">Cooler is full. Hold private intakes until a deer is processed.</div>'
        : n >= Math.ceil(s.coolerCap * s.coolerAlert / 100) ? '<div class="note warn">Getting full. Process the oldest deer first.</div>' : '') +
      '<div class="status">Donated deer first, then oldest first. Amber: ' + s.startBy + ' hours hung, start processing. Red: ' + s.maxHold + ' hours, over the maximum hold: tell Joe.</div>' +
      '<button class="plain" id="reload">Refresh now</button></div>' +
      section('Hanging', hanging, 'Nothing hanging.') +
      section('Being processed', proc, 'Nothing on the table.') +
      section('Ready for pickup or delivery', ready, 'Nothing waiting.') +
      (released.length ? section('Released this week', released, '') : ''));
    document.getElementById('reload').onclick = () => refresh();
    $app.querySelectorAll('[data-band]').forEach(c => c.querySelectorAll('[data-a]').forEach(b => b.onclick = () => act(b.dataset.a, all.find(d => d.Band === c.dataset.band), c.querySelector('.form'))));
  }

  function deerCard(d) {
    const s = S();
    const h = hoursHung(d), bc = colourOf(d), u = d.Status === 'Hanging' ? urgency(d) : null;
    const cls = d.Status === 'Hanging' ? (h >= s.maxHold ? ' red' : h >= s.startBy ? ' amber' : '') : '';
    const mineOrMgr = d['Processor number'] === st.staff.number || isMgr();
    const act = isViewer() ? '' : d.Status === 'Hanging' ? '<button class="btn" data-a="start">Start processing</button>'
      : d.Status === 'Processing' ? (mineOrMgr ? (d.Type === 'Donated' && !d['First pack #'] ? '<button class="btn alt" data-a="grind">Get package numbers</button> ' : '') + '<button class="btn" data-a="finish">Finished</button>' : '')
      : d.Status === 'Ready' ? '<button class="btn alt" data-a="release">Release</button>' : '';
    return '<div class="card' + cls + (d.Type === 'Donated' ? ' donated' : '') + '" data-band="' + esc(d.Band) + '">' +
      '<div class="deer"><div><span class="band">' + esc(d.Band) + '</span> ' +
      '<span class="tag ' + (d.Type === 'Donated' ? 'don">DONATED' : 'prv">PRIVATE') + '</span>' + (d['DDP deer'] === 'Yes' ? '<span class="tag">DDP</span>' : '') +
      (d.Type !== 'Donated' && d['Pork fat added'] === 'Yes' ? '<span class="tag">+ PORK FAT</span>' : '') +
      (d.pending ? '<span class="pill wait">not sent yet</span>' : '') +
      (u ? '<span class="pill" style="background:' + u.colour + ';color:#fff;font-weight:700">' + u.level.toUpperCase() + '</span>' : '') +
      '<div class="status">' + (bc ? swatch(bc) + ' · ' : '') +
      'in ' + esc(d.Intake) + ' · ' + esc(d.Deer || '') + (d['Antler points'] ? ' (' + esc(d['Antler points']) + ' pts)' : '') + ' · ' + esc(d['Hunter number'] || d['Hunter name'] || '') +
      (d.Butcher ? ' · ' + esc(d.Butcher) + (d['Processor number'] ? ' (' + esc(d['Processor number']) + ')' : '') : '') +
      (d['Carcass weight (lb)'] ? ' · ' + esc(d['Carcass weight (lb)']) + ' lb carcass' : '') +
      (d['Pounds packaged'] ? ' · ' + esc(d['Pounds packaged']) + ' lb packaged' : '') + '</div></div>' +
      '<div class="hrs">' + (d.Status === 'Released' ? '' : Math.floor(h) + ' h') + '</div></div>' +
      (d.Cuts && d.Status !== 'Released' ? '<div class="note ok"><b>Cuts:</b> ' + esc(d.Cuts) + '</div>' : '') +
      (d['First pack #'] && d['Last pack #'] ? '<div class="note ok"><b>Package numbers ' + esc(d['First pack #']) + '–' + esc(d['Last pack #']) + '</b> (MassWildlife)</div>'
        : d['First pack #'] ? '<div class="note warn" style="font-size:17px">Label the 2 lb packages in order from <b>' + esc(d['First pack #']) + '</b>: ' + esc(d['First pack #']) + ', ' + esc(('000' + (parseInt(d['First pack #'], 10) + 1)).slice(-4)) + ', …</div>' : '') +
      (d.Status === 'Released' ? '<div class="status">Released ' + esc(d.Released) + ' to ' + esc(d['Released to']) + '</div>' : '') +
      '<div class="actions">' + act + (d.Status !== 'Released' && !isViewer() ? '<button class="btn ghost" data-a="print">Print band</button>' : '') + '</div><div class="form"></div></div>';
  }

  function act(kind, d, box, after) {
    if (kind === 'print') return printBand(d);
    if (kind === 'grind') return grind(d, box, after);
    const s = S();
    const fatPct = d.Type === 'Donated' ? s.fatDonated : (d['Pork fat added'] === 'Yes' ? s.fatPrivate : 0), fatOn = fatPct > 0, fat = fatPct / 100;
    const v = id => (document.getElementById(id) || {}).value || '';
    const forms = {
      start: () => '<div class="note warn" style="font-size:17px">Tag confirmation number: <b>' + esc(d['MassWildlife confirmation'] || 'none recorded') + '</b></div>' +
        '<label class="choice"><input id="f0" type="checkbox"> The confirmation number on the deer\'s tag matches</label>' +
        '<label class="choice"><input id="f8" type="checkbox"> Skinned and head removed at the station behind MHU #1</label>' +
        '<label class="choice"><input id="f9" type="checkbox"> Antimicrobial spray applied in MHU #1</label>' +
        (isMgr() ? '<label>Processor</label><select id="fp">' + (st.home.staff || []).map(x => '<option value="' + esc(x.number) + '"' + (x.number === st.staff.number ? ' selected' : '') + '>' + esc(x.name + ' (' + x.number + ')') + '</option>').join('') + '</select>'
          : '<p class="status">Processor: ' + esc(st.staff.name + ' (' + st.staff.number + ')') + '</p>') +
        '<label>Carcass weight (lb) <span class="hint">On the hanging scale: field dressed, skin and head off</span></label><input id="f1" type="number" inputmode="decimal" min="0" step="0.1">',
      finish: () => '<p class="status">Started ' + esc(d['Processing started'] || '') + ' · carcass ' + esc(d['Carcass weight (lb)'] || '?') + ' lb</p>' +
        '<div class="grid2"><div><label>Ground packages (' + esc(s.pkgSize) + ' lb)</label><input id="f1" type="number" inputmode="numeric" min="0" step="1"></div>' +
        (d.Type === 'Donated' ? '<input id="f2" type="hidden" value="0"><input id="f3" type="hidden" value="0"></div><p class="status">Donated deer: all grind, to the state standard, on the MassWildlife label.</p>'
          : '<div><label>Intact cut packages</label><input id="f2" type="number" inputmode="numeric" min="0" step="1" value="0"></div>' +
          '<div><label>Intact cuts total (lb)</label><input id="f3" type="number" inputmode="decimal" min="0" step="0.1" value="0"></div></div>') +
        '<div class="calc" id="calc"></div>' +
        (d.Type === 'Donated' && !d['First pack #'] ? '<div class="note bad">Tap <b>Get package numbers</b> before grinding, so the labels run in order.</div>' : '') +
        '<div class="note ' + (fatOn ? 'warn">Grind with <b>' + esc(fatPct) + '% pork fat</b>.' : 'ok">All-venison grind: <b>no pork fat</b>.') + '</div>' +
        (fatOn && d.Type !== 'Donated' ? '<label class="choice"><input id="f7" type="checkbox"> Out of pork fat: grind all venison and take the $' + esc(s.porkAddOn || 20) + ' off the hunter\'s price</label>' : '') +
        (d.Type === 'Private' ? '<label class="choice"><input id="f6" type="checkbox"> Grinder cleared before the next hunter\'s deer, so no meat is mixed</label>' : '') +
        '<p class="status">Same food-safety steps for every deer. Full clean-down of the grinder and equipment at least once a day (Daily log › End-of-day clean).</p>',
      release: () => '<label>Released to</label><select id="f1"><option value="">Choose…</option><option>Hunter pickup</option>' +
        (s.pantries || []).map(p => '<option>' + esc(p) + '</option>').join('') + '<option value="other">Other…</option></select>' +
        '<input id="f3" type="text" placeholder="Who?" hidden style="margin-top:8px">' +
        '<label>Pounds out</label><input id="f2" type="number" inputmode="decimal" min="0" value="' + esc(d['Pounds packaged'] || '') + '">' +
        (d.Type === 'Private' ? '<div class="note warn">Hunter pickup: collect <b>$' + esc(d['Hunter price ($)'] || s.privatePrice || 250) + '</b>' + (d['Pork fat added'] === 'Yes' ? ' (includes the pork fat add-on)' : '') + '.</div>' +
          '<div class="grid2"><div><label for="pm">Paid by</label><select id="pm"><option value="">Choose…</option>' + (s.payMethods || ['Cash', 'Card (Square)', 'Check']).map(m => '<option>' + esc(m) + '</option>').join('') + '</select></div>' +
          '<div><label for="pa">Amount collected ($)</label><input id="pa" type="number" inputmode="decimal" min="0" step="0.01" value="' + esc(d['Hunter price ($)'] || '') + '"></div></div>' +
          '<label for="pn">Receipt, check number or note <span class="hint">optional</span></label><input id="pn" type="text" maxlength="100">' +
          '<p class="status">Cash goes in an envelope for the safe at close-out. Never in a pocket or the truck.</p>' : ''),
    };
    box.innerHTML = forms[kind]() + '<div class="err" id="ferr"></div><button class="btn" id="fok" style="margin-top:12px">Save</button> <button class="btn ghost" id="fx">Cancel</button>';
    if (kind === 'release') document.getElementById('f1').onchange = e => { document.getElementById('f3').hidden = e.target.value !== 'other'; };
    const calc = () => {
      const drop = !!(document.getElementById('f7') || {}).checked, fr = drop ? 0 : fat;
      const pk = Math.round(num(v('f1'))), il = num(v('f3')), groundLb = pk * s.pkgSize;
      const ven = r1(groundLb * (1 - fr)), pork = r1(groundLb * fr), total = r1(groundLb + il), carcass = num(d['Carcass weight (lb)']);
      const el = document.getElementById('calc');
      if (el) el.innerHTML = 'Ground: <b>' + fmt(groundLb) + ' lb</b> (' + fmt(ven) + ' lb venison + ' + fmt(pork) + ' lb pork fat) · Intact: <b>' + fmt(il) + ' lb</b><br>' +
        'Total packaged: <b>' + fmt(total) + ' lb</b>' + (carcass ? ' · Venison yield: <b>' + Math.round((ven + il) / carcass * 100) + '%</b> of ' + fmt(carcass) + ' lb carcass' : '') +
        (d['First pack #'] && pk + num(v('f2')) > 0 ? '<br>Package numbers: <b>' + esc(d['First pack #']) + '–' + ('000' + (parseInt(d['First pack #'], 10) + pk + Math.round(num(v('f2'))) - 1)).slice(-4) + '</b>' : '');
      return { pk, il, total };
    };
    if (kind === 'finish') { ['f1', 'f2', 'f3'].forEach(id => { document.getElementById(id).oninput = calc; }); const f7 = document.getElementById('f7'); if (f7) f7.onchange = calc; calc(); }
    document.getElementById('fx').onclick = () => { box.innerHTML = ''; };
    document.getElementById('fok').onclick = () => {
      const err = m => { document.getElementById('ferr').textContent = m; };
      if (kind === 'start') {
        if (!document.getElementById('f0').checked) return err('Check the confirmation number on the tag first. If it doesn\'t match, stop and tell Joe.');
        if (!document.getElementById('f8').checked) return err('Skin it and remove the head at the station behind MHU #1, then tick the box.');
        if (!document.getElementById('f9').checked) return err('Apply the antimicrobial spray in MHU #1, then tick the box.');
        if (!(num(v('f1')) > 0)) return err('Weigh the carcass and enter the weight.');
        const p = isMgr() ? v('fp') : st.staff.number;
        const pn = ((st.home.staff || []).find(x => x.number === p) || st.staff).name;
        queue('start', { band: d.Band, processor: p, processorName: pn, weight: v('f1'), confirmationChecked: true, skinned: true, antimicrobial: true }, 'Start ' + d.Band);
      }
      if (kind === 'finish') {
        const c = calc(), ip = Math.round(num(v('f2')));
        if (!(c.pk + ip > 0)) return err('Enter the packages.');
        if (d.Type === 'Donated' && !d['First pack #']) return err('Get package numbers first (needs signal), so every label carries its MassWildlife number.');
        if (ip && !(c.il > 0)) return err('Weigh the intact cuts and enter the total.');
        if (d.Type === 'Private' && !document.getElementById('f6').checked) return err('Clear the grinder before the next hunter\'s deer goes through, then tick the box.');
        queue('finish', { band: d.Band, groundPackages: c.pk, intactPackages: ip, intactLb: c.il, total: c.total, grinderCleared: d.Type === 'Private', noPork: !!(document.getElementById('f7') || {}).checked }, 'Finish ' + d.Band);
      }
      if (kind === 'release') {
        const to = v('f1') === 'other' ? v('f3').trim() : v('f1');
        if (!to) return err('Say who it went to.');
        const pay = {};
        if (d.Type === 'Private') {
          pay.method = v('pm'); pay.paid = v('pa'); pay.payNote = v('pn');
          if (!pay.method) return err('Choose how the hunter paid.');
          if (pay.paid === '' || !(Number(pay.paid) >= 0)) return err('Enter the amount collected.');
          const due = Number(d['Hunter price ($)'] || 0);
          if (due && Number(pay.paid) !== due && !pay.payNote) return err('That isn\'t the $' + due + ' due. Say why in the note.');
        }
        queue('release', Object.assign({ band: d.Band, to, pounds: v('f2') }, pay), 'Release ' + d.Band);
      }
      (after || showBoard)();
    };
  }

  /* ---------- intake ---------- */
  const TURN_AWAY = ['No MassWildlife confirmation number, or the tag doesn\'t match', 'More than 24 hours since the shot',
    'Not field dressed within 4 hours (air above 37°F)', 'Spoiled: smell, green or slimy meat, flies or maggots',
    'Heavy gut contamination that can\'t be trimmed', 'Signs of illness: lesions, abscesses, very thin or sick-looking',
    'Road-killed, or already cut up or quartered', 'Other (say why in the notes)'];
  const CUTS = [['Backstraps', ['Whole', 'Steaks', 'Butterflied', 'Ground']], ['Tenderloins', ['Whole', 'Ground']],
    ['Hindquarters', ['Roasts', 'Steaks', 'Half roasts, half ground', 'Ground']], ['Shoulders', ['Roasts', 'Ground']],
    ['Steaks', ['3/4"', '1"', '1 1/4"']], ['Roasts', ['about 2 lb', 'about 3 lb']]];
  const cutsHtml = () => '<div id="cutbox" hidden><label>Cuts <span class="hint">from the hunter\'s signed cut sheet; neck, shanks and trim are always ground</span></label><div class="grid2">' +
    CUTS.map((c, i) => '<div><label for="cut' + i + '">' + esc(c[0]) + (i > 3 ? ' size' : '') + '</label><select id="cut' + i + '"><option value="">' + (i > 3 ? 'Not needed' : 'Ground') + '</option>' +
      c[1].filter(o => o !== 'Ground').map(o => '<option>' + esc(o) + '</option>').join('') + '</select></div>').join('') + '</div></div>';
  const readCuts = () => CUTS.map((c, i) => { const v = document.getElementById('cut' + i).value; return i > 3 ? (v ? c[0] + ' ' + v : '') : c[0] + ': ' + (v || 'Ground'); }).filter(Boolean).join('; ');
  function showIntake() {
    const s = S(), now = new Date();
    const todayBand = bandColour(new Date());
    frame('intake', 'Check in a deer',
      (todayBand ? '<div class="note ok" style="font-size:17px">' + swatch(todayBand) + ' today. Make sure the <b>' + esc(todayBand) + '</b> roll is in the band printer.</div>' : '') +
      '<div class="card">' +
      '<label>Is this an Island Access Program (IAP) deer?</label>' +
      '<label class="choice"><input type="radio" name="iap" value="Yes"> <span><b>Yes</b>: it has an IAP field band from the harvest</span></label>' +
      '<label class="choice"><input type="radio" name="iap" value="No"> <span><b>No</b>: the app gives it a Home Ground ID from the date of the shot</span></label>' +
      '<div id="bandbox" hidden><label for="band">IAP field band number <span class="hint">On the hock</span></label><input id="band" type="text" autocapitalize="characters"></div>' +
      '<div id="genbox" class="note ok" hidden>Home Ground ID: <b id="genid">enter the date of the shot below</b><br><span class="status">Printed on the intake band; it stays with the deer from intake to release.</span></div>' +
      '<label>Donated or private?</label>' +
      '<label class="choice"><input type="radio" name="type" value="Donated"> <span><b>Donated</b> (Share the Harvest). TFMV mails the hunter a check: $' + esc(s.payDoe || 150) + ' a doe, $' + esc(s.payBuck || 100) + ' a buck (any male deer).</span></label>' +
      '<label class="choice"><input type="radio" name="type" value="Private"> <span><b>Private</b>: processed for the hunter, $' + esc(s.privatePrice || 250) + '.</span></label>' +
      (s.porkInStock === false ? '<p class="status" id="porkbox" hidden>Pork fat add-on: not available right now. The grind will be all venison.</p>'
        : '<label class="choice" id="porkbox" hidden><input id="pork" type="checkbox"> <span>Add pork fat to the ground (' + esc(s.fatPrivate || 10) + '%), <b>+$' + esc(s.porkAddOn || 20) + '</b>. Local-farm pork fat, as available. Without it, the grind is all venison.</span></label>') +
      '<label for="deer">Deer</label><select id="deer"><option value="">Choose…</option><option>Doe</option><option>Button buck</option><option>Sub-legal adult male</option><option>Antlered buck</option></select>' +
      '<div id="ptsbox" hidden><label for="pts">Points <span class="hint">count every point 1 inch and longer</span></label><input id="pts" type="number" inputmode="numeric" min="1" max="40" step="1" style="max-width:140px"></div>' +
      '<div class="grid2">' +
      '<div><label for="fn">Hunter first name</label><input id="fn" type="text" autocomplete="off"></div>' +
      '<div><label for="ln">Hunter last name</label><input id="ln" type="text" autocomplete="off"></div>' +
      '<div><label for="lic">MassWildlife customer ID <span class="hint">5 to 8 digits</span></label><input id="lic" type="text" inputmode="numeric" maxlength="8" pattern="[0-9]*"></div>' +
      '<div><label for="ph">Hunter phone</label><input id="ph" type="tel"></div>' +
      '<div><label for="cf">MassWildlife confirmation number</label><input id="cf" type="text"></div>' +
      '<div id="sdbox" hidden><label for="sd">Date of the shot <span class="hint">for the Home Ground ID</span></label><input id="sd" type="date" value="' + isoDate(now) + '" max="' + isoDate(now) + '"></div>' +
      '</div>' +
      '<div id="addrbox" hidden><label for="ad1">Hunter mailing address <span class="hint">TFMV mails the donation check here</span></label><input id="ad1" type="text" autocomplete="street-address" placeholder="Street or PO box">' +
      '<div class="grid2"><div><label for="adt">Town</label><input id="adt" type="text"></div><div><label for="ads">State</label><input id="ads" type="text" value="MA" maxlength="2" autocapitalize="characters"></div>' +
      '<div><label for="adz">ZIP</label><input id="adz" type="text" inputmode="numeric" maxlength="10"></div></div></div>' +
      cutsHtml() +
      '<label class="choice"><input id="fd" type="checkbox"> Field dressed within 4 hours of the shot (or the air stayed below 37°F)</label>' +
      '<label class="choice"><input id="ddp" type="checkbox"> Taken under a deer damage permit (DDP)</label>' +
      '<p class="status">The deer hangs in the receiving cooler skin-on, head-on. It\'s skinned and the head removed at the station behind MHU #1 when processing starts.</p>' +
      '<label for="nt">Notes</label><textarea id="nt"></textarea>' +
      '<div class="err" id="err"></div><button class="submit" id="save">Check in and print band</button>' +
      '<button class="btn ghost" id="away" style="width:100%">Turn this deer away instead</button><div id="awaybox"></div></div>');
    const v = id => document.getElementById(id).value.trim();
    // Non-IAP deer: ID = date of the shot (MMDDYYYY) + a two-digit count for that day, e.g. 0908202601
    const genId = () => {
      const sd = v('sd'); if (!sd) return '';
      const [y, m, d] = sd.split('-'), pre = m + d + y;
      const used = deerList().map(x => band(x.Band)).concat(st.outbox.map(x => band((x.fields || {}).band)))
        .filter(x => x.length === 10 && x.indexOf(pre) === 0).map(x => parseInt(x.slice(8), 10) || 0);
      return pre + ('0' + (Math.max(0, ...used) + 1)).slice(-2);
    };
    document.getElementById('deer').onchange = () => { document.getElementById('ptsbox').hidden = v('deer') !== 'Antlered buck'; };
    if (!document.getElementById('mrow-css')) { const c = document.createElement('style'); c.id = 'mrow-css';
      c.textContent = '.mrow{width:100%;table-layout:fixed;border-collapse:collapse;margin:10px 0;font-size:15px}.mrow th{text-align:left;font-weight:600;font-size:14px;color:var(--muted);padding:7px 8px 7px 0;width:45%;vertical-align:top;white-space:normal}.mrow td{padding:7px 0;border-bottom:1px solid var(--line);text-align:left;white-space:normal;overflow-wrap:anywhere}.mrow th{border-bottom:1px solid var(--line)}';
      document.head.appendChild(c); }
    const iapNow = () => (document.querySelector('input[name=iap]:checked') || {}).value;
    const showId = () => { const g = document.getElementById('genid'); if (iapNow() === 'No') g.textContent = genId() || 'enter the date of the shot below'; };
    document.querySelectorAll('input[name=iap]').forEach(r => r.onchange = () => {
      document.getElementById('bandbox').hidden = iapNow() !== 'Yes'; document.getElementById('genbox').hidden = iapNow() !== 'No';
      document.getElementById('sdbox').hidden = iapNow() !== 'No'; showId(); });
    document.getElementById('sd').onchange = showId;
    document.querySelectorAll('input[name=type]').forEach(r => r.onchange = () => { document.getElementById('porkbox').hidden = r.value !== 'Private' || !r.checked; document.getElementById('addrbox').hidden = r.value !== 'Donated' || !r.checked; document.getElementById('cutbox').hidden = r.value !== 'Private' || !r.checked; });
    const err = m => { document.getElementById('err').textContent = m; };
    document.getElementById('save').onclick = () => {
      const type = (document.querySelector('input[name=type]:checked') || {}).value;
      const iap = iapNow();
      if (!iap) return err('Say whether it\'s an Island Access Program (IAP) deer.');
      if (iap === 'No' && !v('sd')) return err('Enter the date of the shot: the Home Ground ID comes from it.');
      const b = iap === 'Yes' ? band(v('band')) : genId();
      if (!b) return err('Enter the IAP field band number from the hock.');
      if (deerList().some(d => band(d.Band) === b && d.Status !== 'Released')) return err('Band ' + b + ' is already in the cooler.');
      if (!type) return err('Choose donated or private.');
      if (!v('deer')) return err('Choose doe, button buck, sub-legal adult male or antlered buck.');
      const pts = parseInt(v('pts'), 10);
      if (v('deer') === 'Antlered buck' && !(pts >= 1 && pts <= 40)) return err('Count the points 1 inch and longer and enter the number.');
      if (!v('fn') || !v('ln')) return err('Enter the hunter\'s first and last name.');
      const lic = v('lic').replace(/\D/g, '');
      if (lic && (lic.length < 5 || lic.length > 8)) return err('The MassWildlife customer ID is 5 to 8 digits.');
      if (type === 'Donated' && !lic) return err('Enter the hunter\'s MassWildlife customer ID. Martin needs it for donated deer.');
      if (type === 'Donated' && (!v('ad1') || !v('adt') || !v('adz'))) return err('Enter the hunter\'s mailing address (street, town and ZIP). TFMV mails the donation check there.');
      if (!v('cf')) return err('Enter the MassWildlife confirmation number. No confirmation number, no intake.');
      if (type === 'Donated' && !document.getElementById('fd').checked) return err('Donated deer must be field dressed within 4 hours of the shot.');
      if (type === 'Private' && coolerCount() >= S().coolerCap) return err('The cooler is full. Hold private deer until there\'s room.');
      const f = { band: b, iap: iap === 'Yes', type, deer: v('deer'), points: v('deer') === 'Antlered buck' ? pts : '', firstName: v('fn'), lastName: v('ln'), customerId: lic, hunterPhone: v('ph'), confirmation: v('cf'),
        cuts: type === 'Private' ? readCuts() : '',
        address: type === 'Donated' ? v('ad1') + ', ' + v('adt') + ', ' + (v('ads') || 'MA').toUpperCase() + ' ' + v('adz') : '',
        dressed4h: document.getElementById('fd').checked, ddp: document.getElementById('ddp').checked, skinned: false, notes: v('nt'),
        porkFat: type === 'Private' && !!document.getElementById('pork') && document.getElementById('pork').checked };
      queue('intake', f, 'Check-in ' + b);
      printBand({ Band: b, Intake: stamp(), Type: type, Deer: f.deer, 'MassWildlife confirmation': f.confirmation });
      showBoard();
      toast('Band ' + b + ' checked in.', true);
    };
    document.getElementById('away').onclick = () => {
      const box = document.getElementById('awaybox');
      box.innerHTML = '<label>Why is it being turned away?</label>' + TURN_AWAY.map(r => '<label class="choice"><input type="radio" name="why" value="' + esc(r) + '"> ' + esc(r) + '</label>').join('') +
        '<p class="status">Tell the hunter why and how to dispose of the deer. Never argue it at the door.</p><button class="btn alt" id="awayok">Log it as turned away</button>';
      document.getElementById('awayok').onclick = () => {
        const why = (document.querySelector('input[name=why]:checked') || {}).value;
        if (!why) return err('Choose the reason.');
        queue('reject', { firstName: v('fn'), lastName: v('ln'), hunterPhone: v('ph'), confirmation: v('cf'), deer: v('deer'),
          type: (document.querySelector('input[name=type]:checked') || {}).value || '', reason: why + (v('nt') ? ': ' + v('nt') : '') }, 'Turned away');
        showHome('Logged as turned away.');
      };
    };
  }

  // Intake band: band number, intake date large, donated/private, day-dot colour.
  // QR maker and reader (qr.js) load only when needed, then stay cached for offline use.
  let qrLib = null;
  function loadQR() {
    if (window.qrcode && window.jsQR) return Promise.resolve();
    return qrLib || (qrLib = new Promise((ok, no) => { const sc = document.createElement('script'); sc.src = 'qr.js'; sc.onload = ok; sc.onerror = () => { qrLib = null; no(new Error('Needs signal once to load the QR tools.')); }; document.head.appendChild(sc); }));
  }
  const deerLink = b => location.origin + location.pathname.replace(/[^/]*$/, '') + '#d=' + encodeURIComponent(band(b));
  // Intake band: ScanBand S 1-1/8" x 11-1/2" on the PDC printer (203 dpi), printed from Chrome on the intake laptop.
  function bandCss() {
    const s = S(), off = Number(s.bandOffset == null ? 2.5 : s.bandOffset), rot = s.bandRotate !== false;
    let c = document.getElementById('band-css'); if (!c) { c = document.createElement('style'); c.id = 'band-css'; document.head.appendChild(c); }
    c.textContent = '@media print{@page{size:1.125in 11.5in;margin:0}html,body{margin:0;padding:0;background:#fff}' +
      '#label{position:absolute;left:0;top:0;width:1.125in;height:11.5in;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#000}' +
      '#label .bw{position:absolute;width:7.4in;height:1.05in;display:flex;align-items:center;gap:.12in;' +
      (rot ? 'left:1.09in;top:' + off + 'in;transform-origin:0 0;transform:rotate(90deg)}' : 'left:.04in;top:' + off + 'in}') +
      '#label .bt{font-size:11pt;font-weight:800;letter-spacing:1px;padding:.04in .08in;border:2px solid #000;white-space:nowrap}' +
      '#label .bt.don{background:#000;color:#fff}#label .bi{font-size:24pt;font-weight:800;line-height:1;white-space:nowrap}' +
      '#label .bx{font-size:10pt;font-weight:700;line-height:1.25;white-space:nowrap}#label .bq{width:.95in;height:.95in;flex:0 0 auto}#label .bq svg{width:100%;height:100%}}';
  }
  async function printBand(d) {
    try { await loadQR(); } catch (e) { toast(e.message); return; }
    bandCss();
    const w = parse(d.Intake), bc = colourOf(d);
    const qr = window.qrcode(0, 'M'); qr.addData(deerLink(d.Band)); qr.make();
    document.getElementById('label').innerHTML = '<div class="bw">' +
      '<div class="bt' + (d.Type === 'Donated' ? ' don">DONATED' : '">PRIVATE') + '</div>' +
      '<div><div class="bi">' + esc(band(d.Band)) + '</div>' +
      '<div class="bx">IN ' + (w ? w.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase() + ' ' + (w.getMonth() + 1) + '/' + w.getDate() : '') +
      (bc ? ' · ' + esc(bc.toUpperCase()) : '') + '</div>' +
      '<div class="bx">' + esc((d.Deer || '').toUpperCase()) + (d['MassWildlife confirmation'] ? ' · ' + (/^mw/i.test(d['MassWildlife confirmation']) ? '' : 'MW ') + esc(d['MassWildlife confirmation']) : '') + '</div></div>' +
      '<div class="bq">' + qr.createSvgTag({ cellSize: 2, margin: 0, scalable: true }) + '</div></div>';
    setTimeout(() => window.print(), 80);
  }

  /* ---------- scan a band: QR from the band opens that deer with its processing urgency ---------- */
  let pendingBand = (location.hash.match(/[#&]d=([^&]+)/) || [])[1] || null;
  if (pendingBand) { pendingBand = band(decodeURIComponent(pendingBand)); history.replaceState(null, '', location.pathname + location.search); }
  let shownBand = null;
  function showDeer(b) {
    b = band(b); shownBand = b;
    const d = deerList().filter(x => band(x.Band) === b).pop();
    if (!d) {
      frame('deer', 'Band ' + esc(b), '<div class="card"><div class="note warn">This band isn\'t in the app\'s list. It may have been released over a week ago, or the list needs refreshing.</div>' +
        '<button class="btn" id="dr">Refresh and try again</button> <button class="btn ghost" id="ds">Scan another</button></div>');
      document.getElementById('dr').onclick = async () => { await refresh(); showDeer(b); };
      document.getElementById('ds').onclick = () => showScan();
      return;
    }
    const u = d.Status === 'Hanging' ? urgency(d) : null;
    const head = u ? '<div class="card" style="background:' + u.colour + ';color:#fff;text-align:center;padding:18px 12px">' +
        '<div style="font-size:34px;font-weight:800;letter-spacing:2px">' + u.level.toUpperCase() + '</div>' +
        '<div style="font-size:17px;margin-top:4px">' + Math.floor(u.hours) + ' hours hung' + (d.Type === 'Donated' ? ' · donated: goes first' : '') + '</div>' +
        '<div style="font-size:14px;opacity:.9;margin-top:4px">' + (u.i >= 4 ? 'Over the maximum hold: tell a manager now.' : u.i === 3 ? 'Past the start-by time: process next.' : u.i === 2 ? 'Process today.' : u.i === 1 ? 'Process when there\'s room.' : 'Let it hang at least overnight.') + '</div></div>'
      : '<div class="card"><b>' + esc(d.Status === 'Processing' ? 'Being processed' : d.Status === 'Ready' ? 'Processed: ready for pickup or delivery' : d.Status) + '</b></div>';
    frame('deer', 'Band ' + esc(band(d.Band)), head + deerCard(d) + '<button class="btn ghost" id="ds" style="width:100%;margin-top:8px">Scan another band</button>');
    const c = $app.querySelector('[data-band]');
    c.querySelectorAll('[data-a]').forEach(x => x.onclick = () => act(x.dataset.a, d, c.querySelector('.form'), () => showDeer(b)));
    document.getElementById('ds').onclick = () => showScan();
  }
  let scanStream = null;
  function stopScan() { if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; } }
  async function showScan() {
    frame('scan', 'Scan a band', '<div class="card"><p class="status">Point the camera at the QR code on the band.</p>' +
      '<video id="sv" playsinline muted style="width:100%;border-radius:12px;background:#000"></video><canvas id="sc" hidden></canvas><div id="sm"></div>' +
      '<label for="sb">Or type the band number</label><input id="sb" type="text" autocapitalize="characters"><button class="btn" id="sg" style="margin-top:8px">Open</button></div>');
    const msg = h => { document.getElementById('sm').innerHTML = h; };
    document.getElementById('sg').onclick = () => { const v = document.getElementById('sb').value.trim(); if (v) { stopScan(); showDeer(v); } };
    try {
      await loadQR();
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch (e) { msg('<div class="note warn">' + esc(/Permission|NotAllowed/i.test(e.name + e.message) ? 'Allow the camera for this app, or type the band number.' : e.message || 'No camera here: type the band number.') + '</div>'); return; }
    const v = document.getElementById('sv'), cv = document.getElementById('sc'), cx = cv.getContext('2d', { willReadFrequently: true });
    v.srcObject = scanStream; await v.play().catch(() => {});
    const tick = () => {
      if (current !== 'scan' || !scanStream) return stopScan();
      if (v.readyState >= 2 && v.videoWidth) {
        cv.width = v.videoWidth; cv.height = v.videoHeight; cx.drawImage(v, 0, 0);
        const r = window.jsQR(cx.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height, { inversionAttempts: 'dontInvert' });
        const m = r && String(r.data).match(/[#&]d=([^&]+)/);
        if (m) { stopScan(); return showDeer(decodeURIComponent(m[1])); }
        if (r) msg('<div class="note warn">That QR code isn\'t a Home Ground band.</div>');
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /* ---------- booking your time (start and end, first come first served) ---------- */
  const toMin = hm => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + (m || 0); };
  const fromMin = n => Math.floor(n / 60) + ':' + pad(n % 60);
  let bookDay = null, bookPick = null;
  function bookCss() {
    if (document.getElementById('book-css')) return;
    const st_ = document.createElement('style'); st_.id = 'book-css';
    st_.textContent = '.chips{display:flex;gap:6px;overflow-x:auto;padding:4px 0 8px;margin:0 -2px}' +
      '.chips button{flex:0 0 auto;border:1px solid var(--line);background:#fff;border-radius:10px;padding:8px 10px;font-size:14px;cursor:pointer;color:var(--ink);text-align:center;line-height:1.2}' +
      '.chips button.on{background:var(--green);color:#fff;border-color:var(--green)}.chips button small{display:block;font-size:11px;opacity:.8}' +
      '.tl{position:relative;height:34px;border-radius:8px;overflow:hidden;display:flex;border:1px solid var(--line);margin-top:6px}.tl i{flex:1;display:block}' +
      '.tl .win{position:absolute;top:0;bottom:0;border:3px solid var(--ink);border-radius:6px;pointer-events:none}' +
      '.tlx{position:relative;height:16px;font-size:11px;color:var(--muted)}.tlx span{position:absolute;transform:translateX(-50%)}' +
      '.key{display:flex;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-top:6px}.key b{display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:-2px;margin-right:4px}' +
      '.who{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 0;border-top:1px solid var(--line)}' +
      '.who .btn{padding:8px 12px;font-size:14px}.pickrow{display:flex;gap:10px}.pickrow label{flex:1}' +
      '.sugg .btn{display:block;width:100%;margin:8px 0;text-align:left}#bk-go:disabled{opacity:.35;cursor:default}';
    document.head.appendChild(st_);
  }
  const shade = (n, max, past) => past ? '#E4DED2' : n >= max ? '#C0392B' : n === 0 ? '#EEF0E0' : n >= max - 1 ? '#E0A526' : ['#D3D8B0', '#B3BB80', '#8C9652', '#69722F'][Math.min(3, Math.floor((n - 1) * 4 / Math.max(1, max - 2)))];

  async function showShifts(data, msg) {
    bookCss();
    frame('shifts', 'Book your time', '<div id="sched"><p class="status">Loading…</p></div>');
    const box = document.getElementById('sched');
    try { if (!data) data = await call({ action: 'shifts' }); }
    catch (e) { box.innerHTML = '<div class="note bad">' + esc(e.offline ? 'Booking needs signal.' : e.message) + '</div>'; return; }
    if (st.home && data.myShifts) { st.home.myShifts = data.myShifts; save(); }   // keep Home's "Next booking" current
    const o0 = toMin(data.open.start), o1 = toMin(data.open.end), step = data.step, max = data.max, n = Math.round((o1 - o0) / step);
    const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes(), todayIso = data.days[0].date;
    if (!data.days.some(d => d.date === bookDay)) bookDay = todayIso;
    const day = data.days.find(d => d.date === bookDay), isToday = bookDay === todayIso;
    const pastIdx = i => isToday && o0 + (i + 1) * step <= nowMin;
    const myDay = day.people.filter(p => p.mine);
    const firstStart = isToday ? Math.max(o0, Math.ceil((nowMin + 1) / step) * step) : o0;
    // default pick: keep the last one if it still makes sense, otherwise the first 4 hours that fit
    if (!bookPick || bookPick.date !== bookDay || toMin(bookPick.start) < firstStart) {
      const len = Math.min(4 * 60, o1 - firstStart);
      bookPick = { date: bookDay, start: fromMin(firstStart), end: fromMin(Math.max(firstStart + step, firstStart + len)) };
    }
    const mine = data.myShifts || [];
    const startOpts = [], endOpts = [];
    for (let t = firstStart; t < o1; t += step) startOpts.push(t);
    for (let t = firstStart + step; t <= o1; t += step) endOpts.push(t);
    const opt = (list, sel) => list.map(t => '<option value="' + fromMin(t) + '"' + (fromMin(t) === sel ? ' selected' : '') + '>' + t12(fromMin(t)) + '</option>').join('');
    const hours = []; for (let t = Math.ceil(o0 / 60) * 60; t <= o1; t += 120) hours.push(t);

    box.innerHTML =
      (msg ? '<div class="note ' + (msg.bad ? 'bad' : 'ok') + '">' + esc(msg.text) + '</div>' : '') +
      '<div class="card"><b>Your bookings</b>' + (mine.length ? mine.map(x => '<div class="who"><div>' + esc(dayName(x.date)) + ' · ' + t12(x.starts) + '–' + t12(x.ends) + '</div>' +
        '<button class="btn ghost" data-cancel="' + esc(x.id) + '">Cancel</button></div>').join('') : '<div class="status">None booked.</div>') +
      '<div class="status" style="margin-top:6px">Pick your own start and end time. First come, first served: no more than ' + max + ' processors booked at the same moment. Cancel any time before you start. Clock in when you arrive.</div></div>' +
      '<div class="chips">' + data.days.map(d => {
        const peak = Math.max(0, ...d.counts);
        return '<button data-day="' + d.date + '" class="' + (d.date === bookDay ? 'on' : '') + '">' + esc(dayName(d.date).split(',')[0]) + '<small>' + esc(dayName(d.date).split(', ')[1] || '') + '</small>' +
          '<small>' + (peak >= max ? 'full at times' : d.people.length ? d.people.length + ' booked' : 'open') + '</small></button>';
      }).join('') + '</div>' +
      '<div class="card"><b>' + esc(dayName(bookDay)) + '</b> <span class="status">' + t12(data.open.start) + ' to ' + t12(data.open.end) + '</span>' +
      '<div class="tl" id="tl">' + day.counts.map((c, i) => '<i style="background:' + shade(c, max, pastIdx(i)) + '" title="' + t12(fromMin(o0 + i * step)) + ': ' + c + ' of ' + max + '"></i>').join('') + '<div class="win" id="win"></div></div>' +
      '<div class="tlx">' + hours.map(t => '<span style="left:' + ((t - o0) / (o1 - o0) * 100) + '%">' + t12(fromMin(t)).replace(':00', '').replace(' ', '') + '</span>').join('') + '</div>' +
      '<div class="key"><span><b style="background:#EEF0E0"></b>open</span><span><b style="background:#8C9652"></b>some booked</span><span><b style="background:#E0A526"></b>1 place left</span><span><b style="background:#C0392B"></b>full</span></div>' +
      (day.people.length ? day.people.map(p => '<div class="who"><div>' + (p.mine ? '<b>You</b>' : esc(p.name)) + ' · ' + t12(p.starts) + '–' + t12(p.ends) + '</div>' +
        ((p.mine || isMgr()) && !(isToday && toMin(p.starts) <= nowMin) ? '<button class="btn ghost" data-cancel="' + esc(p.id) + '">Cancel</button>' : '') + '</div>').join('')
        : '<div class="status" style="margin-top:8px">Nobody booked yet.</div>') + '</div>' +
      (startOpts.length ? '<div class="card"><b>Book a time on ' + esc(dayName(bookDay)) + '</b>' +
        '<div class="pickrow"><label>Start<select id="bk-s">' + opt(startOpts, bookPick.start) + '</select></label><label>End<select id="bk-e">' + opt(endOpts, bookPick.end) + '</select></label></div>' +
        '<div id="bk-msg"></div><button class="btn wide" id="bk-go" style="width:100%;margin-top:10px">Book</button>' +
        (isMgr() ? '<button class="plain" id="bk-cover">Ask for cover for this time</button>' : '') + '<div id="bk-sugg" class="sugg"></div></div>'
        : '<div class="card"><div class="status">Booking for today has closed. Pick another day above.</div></div>');

    const go = async (b, body, done) => {
      if (b) b.disabled = true;
      try { const out = await call(body); if (done) done(out); }
      catch (e) { if (b) b.disabled = false; toast(e.offline ? 'Needs signal.' : e.message); }
    };
    const book = (b, pick) => go(b, { action: 'book', date: pick.date, start: pick.start, end: pick.end }, out => {
      if (out.conflict) {   // someone got there first: show the server's view and its alternatives
        bookDay = pick.date; bookPick = pick;
        showShifts(out, { bad: true, text: out.conflict.message + ' Pick one of the open times below.' });
        setTimeout(() => sugg(out.conflict.suggestions), 0);
        return;
      }
      bookPick = null;
      showShifts(out, { text: 'Booked: ' + dayName(out.booked.date) + ', ' + t12(out.booked.start) + '–' + t12(out.booked.end) + '.' });
    });
    box.querySelectorAll('[data-day]').forEach(b => b.onclick = () => { bookDay = b.dataset.day; showShifts(data); });
    box.querySelectorAll('[data-cancel]').forEach(b => b.onclick = () => { if (confirmCancel()) go(b, { action: 'cancel', id: b.dataset.cancel }, out => showShifts(out, { text: 'Cancelled.' })); });
    const sugg = list => {
      const el = document.getElementById('bk-sugg'); if (!el) return;
      el.innerHTML = list && list.length ? '<div class="status" style="margin-top:8px">Open times the same length:</div>' + list.map((x, i) =>
        '<button class="btn ghost" data-sg="' + i + '">Book ' + esc(x.date === bookDay ? 'this day' : dayName(x.date)) + ', ' + t12(x.start) + '–' + t12(x.end) + '</button>').join('')
        : list ? '<div class="status" style="margin-top:8px">No open time that long nearby. Try a shorter booking or another day.</div>' : '';
      el.querySelectorAll('[data-sg]').forEach(b => b.onclick = () => book(b, list[+b.dataset.sg]));
    };
    if (!startOpts.length) return;
    const sEl = document.getElementById('bk-s'), eEl = document.getElementById('bk-e'), mEl = document.getElementById('bk-msg'), gEl = document.getElementById('bk-go'), win = document.getElementById('win');
    // client-side check, same rules as the server (the server has the final say)
    const countsFor = d => { const dd = data.days.find(x => x.date === d); return dd ? dd.counts : null; };
    const fitsAt = (d, a, b) => {
      const c = countsFor(d); if (!c || a < o0 || b > o1) return false;
      if (d === todayIso && a <= nowMin) return false;
      const dd = data.days.find(x => x.date === d);
      if (dd.people.some(p => p.mine && a < toMin(p.ends) && b > toMin(p.starts))) return false;
      for (let t = a; t < b; t += step) if (c[Math.floor((t - o0) / step)] >= max) return false;
      return true;
    };
    const suggest = (a, b) => {
      const out = []; let before = null, after = null;
      for (let k = step; k <= o1 - o0 && !(before && after); k += step) {
        if (!before && fitsAt(bookDay, a - k, b - k)) before = { date: bookDay, start: fromMin(a - k), end: fromMin(b - k) };
        if (!after && fitsAt(bookDay, a + k, b + k)) after = { date: bookDay, start: fromMin(a + k), end: fromMin(b + k) };
      }
      if (before) out.push(before); if (after) out.push(after);
      const i0 = data.days.findIndex(x => x.date === bookDay);
      for (let i = i0 + 1; i < data.days.length && out.length < 3; i++) if (fitsAt(data.days[i].date, a, b)) out.push({ date: data.days[i].date, start: fromMin(a), end: fromMin(b) });
      return out;
    };
    const check = () => {
      let a = toMin(sEl.value), b = toMin(eEl.value);
      if (b <= a) { b = Math.min(o1, a + Math.max(60, toMin(bookPick.end) - toMin(bookPick.start))); eEl.value = fromMin(b); }
      bookPick = { date: bookDay, start: fromMin(a), end: fromMin(b) };
      win.style.left = ((a - o0) / (o1 - o0) * 100) + '%'; win.style.width = ((b - a) / (o1 - o0) * 100) + '%';
      const len = (b - a) / 60, own = myDay.find(p => a < toMin(p.ends) && b > toMin(p.starts));
      let full = []; for (let t = a; t < b; t += step) if (day.counts[Math.floor((t - o0) / step)] >= max) full.push(t);
      let peak = 0; for (let t = a; t < b; t += step) peak = Math.max(peak, day.counts[Math.floor((t - o0) / step)]);
      const lenTxt = (len === Math.floor(len) ? len : len.toFixed(2).replace(/0$/, '')) + ' hour' + (len === 1 ? '' : 's');
      let bad = '';
      if (len < data.minHrs) bad = 'The shortest booking is ' + data.minHrs + ' hour' + (data.minHrs === 1 ? '' : 's') + '.';
      else if (len > data.maxHrs) bad = 'The longest booking is ' + data.maxHrs + ' hours.';
      else if (own) bad = 'You already have ' + t12(own.starts) + '–' + t12(own.ends) + ' this day.';
      if (bad) { mEl.innerHTML = '<div class="note bad">' + esc(bad) + '</div>'; gEl.disabled = true; sugg(null); return; }
      if (full.length) {
        mEl.innerHTML = '<div class="note bad">Full from ' + t12(fromMin(full[0])) + ' to ' + t12(fromMin(full[full.length - 1] + step)) + ': already ' + max + ' processors booked. That time is blocked.</div>';
        gEl.disabled = true; sugg(suggest(a, b)); return;
      }
      mEl.innerHTML = '<div class="note ok">' + lenTxt + ' · open. Busiest point: ' + peak + ' of ' + max + ' booked' + (peak === max - 1 ? ' (you\'d take the last place)' : '') + '.</div>';
      gEl.disabled = false; sugg(null);
    };
    sEl.onchange = eEl.onchange = check; check();
    gEl.onclick = () => book(gEl, bookPick);
    const cov = document.getElementById('bk-cover');
    if (cov) cov.onclick = () => go(cov, { action: 'cover', date: bookPick.date, start: bookPick.start, end: bookPick.end }, out => { cov.textContent = 'Sent to ' + out.sent + ' phone' + (out.sent === 1 ? '' : 's'); });
  }
  const confirmCancel = () => true;
  /** Donated deer: reserve the next MassWildlife package number before grinding. */
  async function grind(d, box, after) {
    box.innerHTML = '<p class="status">Getting package numbers…</p>';
    try {
      const out = await call({ action: 'grind', band: d.Band });
      (st.home.deer || []).forEach(x => { if (band(x.Band) === band(out.band) && x.Status !== 'Released') x['First pack #'] = out.first; });
      st.home.packs = { next: st.home.packs && st.home.packs.next, grinder: { band: band(out.band), first: out.first } };
      save(); (after || showBoard)();
      toast('Label packages from ' + out.first + ', in order.', true);
    } catch (e) { box.innerHTML = '<div class="note bad">' + esc(e.offline ? 'Package numbers need signal. Try again when connected.' : e.message) + '</div>'; }
  }   // no browser dialogs: cancelling is one tap and can be re-booked

  /* ---------- messages ---------- */
  async function showMessages() {
    frame('messages', 'Messages', '<p class="status">Messages stay on the facility record. Keep them about the work.</p><div id="threads" class="card"><span class="status">Loading…</span></div>');
    const box = document.getElementById('threads');
    try {
      const out = await call({ action: 'threads' });
      box.innerHTML = out.threads.map((t, i) => '<button class="plain row-btn" data-ch="' + esc(t.channel) + '"' + (i ? ' style="border-top:1px solid var(--line)"' : '') + '>' +
        '<b>' + esc(t.label) + '</b>' + (t.unread ? ' <span class="pill wait">' + t.unread + ' new</span>' : '') +
        '<br><span class="status">' + (t.last ? esc(t.last) : 'No messages yet') + '</span></button>').join('');
      box.querySelectorAll('[data-ch]').forEach(b => b.onclick = () => showThread(b.dataset.ch));
    } catch (e) { box.innerHTML = '<span class="status">' + esc(e.offline ? 'Messages need signal.' : e.message) + '</span>'; }
  }
  async function showThread(ch) {
    frame('thread', '<span id="th-title">Messages</span>', '<div id="msgs" class="card msgs"><span class="status">Loading…</span></div>' +
      '<textarea id="msg-text" maxlength="1000" placeholder="Write a message"></textarea><div id="err" class="err"></div><button class="submit" id="send">Send</button>' +
      '<p class="center"><button class="plain" id="back">Back to messages</button></p>');
    document.getElementById('back').onclick = () => showMessages();
    const draw = async () => {
      try {
        const out = await call({ action: 'thread', channel: ch });
        const box = document.getElementById('msgs');
        if (!box) return stopThread();
        document.getElementById('th-title').textContent = out.label;
        box.innerHTML = out.messages.length ? out.messages.map(m => m.system ? '<p class="status center">' + esc(m.text) + '</p>'
          : '<div class="bubble ' + (m.mine ? 'mine' : 'theirs') + '">' + esc(m.text) + '<div class="meta">' + (m.mine ? 'You' : esc(m.from)) + ' · ' + esc(when(m.at)) + '</div></div>').join('')
          : '<span class="status">No messages yet.</span>';
        box.scrollTop = box.scrollHeight;
      } catch (e) { const box = document.getElementById('msgs'); if (box) box.innerHTML = '<span class="status">' + esc(e.offline ? 'Messages need signal.' : e.message) + '</span>'; }
    };
    const send = document.getElementById('send');
    send.onclick = async () => {
      const text = document.getElementById('msg-text').value.trim();
      if (!text) return;
      send.disabled = true; send.textContent = 'Sending…';
      try { await call({ action: 'send', channel: ch, text, clientId: uid() }); document.getElementById('msg-text').value = ''; document.getElementById('err').textContent = ''; await draw(); }
      catch (e) { document.getElementById('err').textContent = e.offline ? 'No signal. Your message wasn\'t sent.' : e.message; }
      send.disabled = false; send.textContent = 'Send';
    };
    await draw();
    threadTimer = setInterval(() => { if (!document.hidden && navigator.onLine) draw(); }, 10000);
  }

  /* ---------- need help ---------- */
  const REASONS = ['Need a hand on the line', 'Cooler near capacity', 'Equipment problem', 'Food-safety problem: stop and check', 'Injury: come now', 'Other'];
  function showHelp() {
    frame('help', 'Need help',
      '<div class="note warn">This sends a notification to everyone on the team and posts in the team chat. Anyone free taps "On my way". For a serious injury, call 911 first.</div>' +
      REASONS.map((r, i) => '<label class="choice"><input type="radio" name="why" value="' + esc(r) + '"' + (i ? '' : ' checked') + '> ' + esc(r) + '</label>').join('') +
      '<label for="hnote">Anything they should know <span class="hint">Optional</span></label><textarea id="hnote" maxlength="300" placeholder="e.g. Three deer at the red mark, grinder jammed"></textarea>' +
      '<div id="err" class="err"></div><button class="submit" id="send" style="background:var(--bad)">Send for help</button>');
    document.getElementById('send').onclick = async () => {
      const btn = document.getElementById('send');
      btn.disabled = true; btn.textContent = 'Sending…';
      try {
        const out = await call({ action: 'help', reason: (document.querySelector('input[name=why]:checked') || {}).value, note: document.getElementById('hnote').value.trim(), clientId: uid() });
        showHome('Help request sent to ' + (out.sentTo || 0) + ' teammate' + (out.sentTo === 1 ? '' : 's') + '. You\'ll be notified when someone is on the way. Close it once it\'s sorted.');
        refresh(true);
      } catch (e) {
        btn.disabled = false; btn.textContent = 'Send for help';
        document.getElementById('err').textContent = e.offline ? 'No signal, so it couldn\'t send. Shout, or call Joe at ' + (CFG.OFFICE_PHONE || '') + '.' : e.message;
      }
    };
  }

  /* ---------- numbers ---------- */
  function weekHtml(w) {
    const s = S();
    return '<div class="card"><b>This week</b> <span class="status">(since ' + esc(dayName(w.since)) + ')</span>' +
      '<div class="tiles">' + tile(w.deer, 'Deer processed') + tile(fmt(w.hours), 'Hours clocked') + tile('$' + fmt(w.pay), 'Piece pay') + tile(w.hours ? '$' + fmt(w.perHour) : '—', 'Per hour') + '</div>' +
      '<div class="status">$' + esc(s.pieceRate) + ' a deer. All clocked time counts, including cleaning, waiting and training.' +
      (w.topUp ? ' Home Ground tops you up to minimum wage: $' + fmt(w.topUp) + ' so far this week.' : '') +
      (w.overtime ? ' Overtime: ' + fmt(w.overtime) + ' hours over 40.' : '') + '</div></div>';
  }
  async function showNumbers() {
    frame('numbers', 'My numbers', '<div id="nums"><p class="status">Loading…</p></div>');
    const box = document.getElementById('nums');
    let out;
    try { out = await call({ action: 'stats' }); } catch (e) { out = { mine: st.home.mine, week: st.home.week }; if (!out.mine) { box.innerHTML = '<div class="note bad">' + esc(e.offline ? 'Needs signal.' : e.message) + '</div>'; return; } }
    const m = out.mine, s = S();
    box.innerHTML = weekHtml(out.week) +
      '<div class="card"><b>Season so far</b><div class="tiles">' +
      tile(m.deer, 'Deer processed') + tile(m.donated, 'Donated deer') + tile(fmt(m.packagedLb), 'lb packaged') + tile(fmt(m.groundVenisonLb), 'lb ground venison') +
      tile(m.groundPackages, s.pkgSize + ' lb packages') + tile(fmt(m.porkFatLb), 'lb pork fat') + tile(fmt(m.intactLb), 'lb intact cuts') + tile(m.avgYield ? m.avgYield + '%' : '—', 'Avg venison yield') +
      '</div><div class="status">Ground venison is calculated: packages × ' + esc(s.pkgSize) + ' lb, less the pork fat (' + esc(s.fatDonated) + '%).' +
      (m.avgMinutes ? ' Average ' + m.avgMinutes + ' minutes a deer.' : '') + '</div></div>';
  }
  async function showTeam() {
    frame('team', 'Team numbers', '<div id="team"><p class="status">Loading…</p></div>');
    const box = document.getElementById('team');
    try {
      const out = await call({ action: 'team' }), t = out.totals;
      box.innerHTML = '<div class="card"><b>Facility, season so far</b><div class="tiles">' + tile(t.deer, 'Deer processed') + tile(t.donated, 'Donated deer') +
        tile(fmt(t.packagedLb), 'lb packaged') + tile(fmt(t.groundVenisonLb), 'lb ground venison') + '</div><div class="status">' + fmt(t.porkFatLb) + ' lb pork fat used · ' + fmt(t.carcassLb) + ' lb carcass weight in</div></div>' +
        '<div class="card scroll"><table><thead><tr><th>Processor</th><th>Deer</th><th>Donated</th><th>lb packaged</th><th>lb ground venison</th><th>Yield</th><th>Week: deer</th><th>Week: hours</th><th>Week: $/hr</th><th>Top-up</th><th>OT</th></tr></thead><tbody>' +
        out.people.map(p => '<tr><td><b>' + esc(p.name) + '</b><br><span class="status">' + esc(p.number) + '</span></td><td>' + p.season.deer + '</td><td>' + p.season.donated + '</td><td>' + fmt(p.season.packagedLb) +
          '</td><td>' + fmt(p.season.groundVenisonLb) + '</td><td>' + (p.season.avgYield ? p.season.avgYield + '%' : '—') + '</td><td>' + p.week.deer + '</td><td>' + fmt(p.week.hours) +
          '</td><td>' + (p.week.hours ? '$' + fmt(p.week.perHour) : '—') + '</td><td' + (p.week.topUp ? ' class="warn"' : '') + '>' + (p.week.topUp ? '$' + fmt(p.week.topUp) : '') +
          '</td><td' + (p.week.overtime ? ' class="warn"' : '') + '>' + (p.week.overtime ? fmt(p.week.overtime) : '') + '</td></tr>').join('') +
        '</tbody></table></div><p class="status">Top-up: what\'s owed to bring piece pay up to minimum wage for hours clocked this week. OT: hours over 40. Also on the Processor Totals tab.</p>';
    } catch (e) { box.innerHTML = '<div class="note bad">' + esc(e.offline ? 'Needs signal.' : e.message) + '</div>'; }
  }

  /* ---------- daily log ---------- */
  const LOGS = [['Cooler temp (°F)', 'Reading in °F. Target 33–37, never above 41.'], ['Freezer temp (°F)', 'Reading in °F. 0 or colder, never above 10.'], ['Facility temp (°F)', 'MHU (processing trailer), reading in °F. Never above 42.'],
    ['Thermometer check', 'Ice-point reading in °F (should be 32). Mondays.'], ['Pre-op check', 'Done / problems found'], ['End-of-day clean', 'Done / problems found'],
    ['Weekly clean', 'Done / problems found'], ['Sanitizer test', 'Test-strip reading (ppm)'], ['Waste pickup', 'Hauler and bins taken'],
    ['Tight tank pumped', 'Company'], ['Complaint', 'Lot number, if known. Details in the note'],
    ['Cash deposit', 'Dollars in the envelope dropped in the safe. Note: number of payments and both sets of initials'],
    ['Bank deposit', 'Managers only. Dollars taken from the safe to the bank. Note: deposit slip number']];
  function showDaily() {
    frame('daily', 'Daily log',
      '<div class="card"><label for="lt">What are you logging?</label><select id="lt">' + LOGS.map(l => '<option value="' + esc(l[0]) + '">' + esc(l[0].replace('Facility temp', 'MHU temp')) + '</option>').join('') + '</select>' +
      '<div id="unitbox" hidden><label for="lu">Which one?</label><select id="lu"></select></div>' +
      '<label for="lv">Reading or result <span class="hint" id="lh"></span></label><input id="lv" type="text">' +
      '<label for="ln">Note</label><textarea id="ln"></textarea><div id="err" class="err"></div><button class="submit" id="save">Save to the log</button></div>' +
      '<p class="status">Log the freezer, hanging cooler, MHU #1 and MHU #2 at opening, midday and close. Freezer over 10°F, cooler over 41°F, or an MHU over 42°F alerts Joe straight away.</p>');
    const sel = document.getElementById('lt'), hint = () => {
      document.getElementById('lh').textContent = (LOGS.find(l => l[0] === sel.value) || [])[1] || '';
      const units = ({ 'Cooler temp (°F)': S().coolers, 'Freezer temp (°F)': S().freezers, 'Facility temp (°F)': S().trailers }[sel.value]) || [];
      document.getElementById('unitbox').hidden = !units.length;
      document.getElementById('lu').innerHTML = units.map(u => '<option>' + esc(u) + '</option>').join('');
    };
    sel.onchange = hint; hint();
    document.getElementById('save').onclick = () => {
      const type = sel.value, value = document.getElementById('lv').value.trim(), note = document.getElementById('ln').value.trim();
      if (/deposit/.test(type) && !(Number(value) > 0)) { document.getElementById('err').textContent = 'Enter the amount in dollars.'; return; }
      if (type === 'Bank deposit' && !isMgr()) { document.getElementById('err').textContent = 'Only a manager takes cash from the safe to the bank.'; return; }
      if (/temp|Thermometer/.test(type) && !isFinite(Number(value))) { document.getElementById('err').textContent = 'Enter the reading as a number.'; return; }
      if (!value && !note) { document.getElementById('err').textContent = 'Enter the reading or a note.'; return; }
      const hot = (type === 'Cooler temp (°F)' && Number(value) > 41) || (type === 'Freezer temp (°F)' && Number(value) > 10) || (type === 'Facility temp (°F)' && Number(value) > (S().trailerLimit || 42));
      queue('log', { type, value, note, unit: document.getElementById('unitbox').hidden ? '' : document.getElementById('lu').value }, type);
      showHome(type === 'Cash deposit' ? 'Cash deposit of $' + Number(value).toFixed(2) + ' logged. Make sure the envelope is through the slot.' : hot ? 'Saved. That reading is over the limit: Joe has been alerted. Check the door and the unit now.' : 'Saved to the log.');
    };
  }

  /* ---------- facility status ---------- */
  async function showStatus() {
    frame('status', 'Facility status', '<div id="fs">' + (st.lastStatus ? statusHtml(st.lastStatus, true) : '<p class="status">Loading…</p>') + '</div>');
    try {
      const out = await call({ action: 'status' });
      st.lastStatus = out.status; save();
      if (current === 'status') { document.getElementById('fs').innerHTML = statusHtml(out.status); wireStatus(); }
    } catch (e) {
      const box = document.getElementById('fs');
      if (box) box.insertAdjacentHTML('afterbegin', '<div class="note bad">' + esc(e.offline ? 'No signal. Showing the last status you loaded.' : e.message) + '</div>');
    }
    wireStatus();
  }
  function wireStatus() {
    const b = document.getElementById('fs-refresh'); if (b) b.onclick = () => showStatus();
    document.querySelectorAll('#fs [data-go2]').forEach(x => x.onclick = () => GO[x.dataset.go2]());
  }
  function statusHtml(x, stale) {
    const c = x.cooler, ago = h => h == null ? '' : h < 1 ? Math.round(h * 60) + ' min ago' : Math.floor(h) + ' h ago';
    const fill = c.inCooler >= c.capacity ? 'red' : c.pctFull >= c.alertPct ? 'amber' : '';
    const temp = (t, limit) => '<div class="trow' + (t.over ? ' bad' : t.overdue ? ' warnrow' : '') + '"><div><b>' + esc(t.unit) + '</b><div class="status">' +
      (t.at ? esc(when(t.at)) + ' · ' + ago(t.hoursAgo) + (t.by ? ' · ' + esc(t.by) : '') : 'No reading logged') +
      (t.over ? ' · OVER ' + limit + '°F' : t.overdue && t.at ? ' · reading overdue' : '') + '</div></div><div class="tval">' + (t.value !== '' ? esc(t.value) + '°' : '—') + '</div></div>';
    const up = (label, u) => '<div class="status">' + label + ': ' + (u ? esc(when(u.at)) + (u.by ? ' · ' + esc(u.by) : '') + (u.value && !/^done$/i.test(u.value) ? ' · ' + esc(u.value) : '') : 'not logged yet') + '</div>';
    const p = x.people;
    return '<p class="status">As of ' + esc(when(x.at)) + (stale ? ' (last loaded)' : '') + ' · <button class="plain" id="fs-refresh" style="padding:0">Refresh</button></p>' +
      (x.openHelp ? '<div class="note bad"><b>' + x.openHelp + ' open help request' + (x.openHelp > 1 ? 's' : '') + '.</b> See Home.</div>' : '') +
      '<div class="card' + (fill ? ' ' + fill : '') + '"><b>Cooler: ' + c.inCooler + ' of ' + c.capacity + ' (' + c.pctFull + '% full)</b>' +
      '<div class="tiles">' + tile(c.donatedHanging, 'Donated hanging') + tile(c.privateHanging, 'Private hanging') + tile(c.processing, 'Being processed') + tile(x.ready.deer, 'Packaged, waiting') + '</div>' +
      (c.pastMaxHold ? '<div class="note bad">' + c.pastMaxHold + ' over the ' + c.maxHold + '-hour maximum hold. Tell Joe now.</div>' : '') +
      (c.pastStartBy - c.pastMaxHold > 0 ? '<div class="note warn">' + (c.pastStartBy - c.pastMaxHold) + ' past ' + c.startBy + ' hours: process next.</div>' : '') +
      (x.ready.deer ? '<div class="status">' + fmt(x.ready.lb) + ' lb packaged and waiting for pickup or delivery (' + x.ready.donated + ' donated deer).</div>' : '') + '</div>' +
      '<div class="card' + (x.oldest && x.oldest.hours >= c.maxHold ? ' red' : x.oldest && x.oldest.hours >= c.startBy ? ' amber' : '') + '"><b>Longest hanging</b>' +
      (x.oldest ? '<div class="deer"><div><span class="band">' + esc(x.oldest.band) + '</span> <span class="tag ' + (x.oldest.type === 'Donated' ? 'don">DONATED' : 'prv">PRIVATE') + '</span>' +
        '<div class="status">In ' + esc(when(x.oldest.intake)) + (x.oldest.deer ? ' · ' + esc(x.oldest.deer) : '') + '</div></div><div class="hrs">' + x.oldest.hours + ' h</div></div>' : '<div class="status">Nothing hanging.</div>') + '</div>' +
      '<div class="card"><b>Last logged temperatures</b> <span class="status">freezer 0°F or colder, never above 10 · hanging cooler 33–37°F, never above 41</span>' +
      (x.temps.list || []).map(t => temp(t, t.limit)).join('') +
      (isViewer() ? '' : '<button class="plain" data-go2="daily">Log a reading</button>') + '</div>' +
      '<div class="card"><b>People</b><div class="tiles">' + tile(p.clockedIn.length, 'Clocked in now') + tile(p.onShift ? p.onShift.booked.length + ' of ' + p.max : '—', p.onShift ? 'Booked right now' : 'Nobody booked now') + '</div>' +
      (p.clockedIn.length ? '<div class="status">Clocked in: ' + esc(p.clockedIn.map(w => w.name + ' (since ' + when(w.since).split(' ').slice(-2).join(' ') + ')').join(', ')) + '</div>' : '') +
      (p.onShift && p.onShift.booked.length ? '<div class="status">Booked now: ' + esc(p.onShift.booked.join(', ')) + '</div>' : '') +
      (p.nextShift ? '<div class="status">Next in: ' + esc(p.nextShift.slot) + (p.nextShift.people > 1 ? ' and ' + (p.nextShift.people - 1) + ' more' : '') + ' at ' + t12(p.nextShift.starts) + '</div>' : '') + '</div>' +
      '<div class="card"><b>Today</b><div class="tiles">' + tile(x.today.in, 'Deer in') + tile(x.today.processed, 'Processed') + tile(fmt(x.today.lb), 'lb packaged') + tile(x.today.released, 'Released') + '</div>' +
      (x.today.turnedAway ? '<div class="status">' + x.today.turnedAway + ' turned away today.</div>' : '') + '</div>' +
      (x.cash ? cashHtml(x.cash) : '') +
      '<div class="card"><b>Cleaning and upkeep</b> <span class="status">last logged</span>' +
      up('End-of-day clean', x.upkeep.endOfDayClean) + up('Pre-op check', x.upkeep.preOp) + up('Sanitizer test', x.upkeep.sanitizer) +
      up('Thermometer check', x.upkeep.thermometer) + up('Waste pickup', x.upkeep.waste) + up('Tight tank pumped', x.upkeep.tightTank) + '</div>';
  }

  function cashHtml(m) {
    const $ = n => '$' + Number(n || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const gap = m.notInSafe;
    return '<div class="card' + (gap > 0 ? ' amber' : gap < 0 ? ' red' : '') + '"><b>Cash and payments</b> <span class="status">private deer</span>' +
      '<div class="tiles">' + tile($(m.today.cash), 'Cash taken today') + tile($(m.today.deposited), 'Cash into safe today') +
      tile($(m.inSafe), 'In the safe now') + tile($(m.today.card), 'Card today') + '</div>' +
      (gap > 0 ? '<div class="note warn"><b>' + $(gap) + ' in cash taken but not logged into the safe.</b> Count it, envelope it, drop it, and log a cash deposit.</div>'
        : gap < 0 ? '<div class="note bad"><b>Deposits are ' + $(-gap) + ' more than the cash recorded at pickup.</b> Check the releases and envelopes, and tell Joe.</div>'
        : '<div class="status">All cash taken is logged into the safe.</div>') +
      '<div class="status">Last bank run: ' + (m.lastBank ? esc(when(m.lastBank.at)) + ', ' + $(m.lastBank.amount) + (m.lastBank.by ? ' · ' + esc(m.lastBank.by) : '') : 'none yet') + '</div>' +
      '<div class="status">Season: cash ' + $(m.season.cash) + ' · card ' + $(m.season.card) + (m.season.check ? ' · check ' + $(m.season.check) : '') + ' · banked ' + $(m.season.banked) + '</div>' +
      (isViewer() ? '' : '<button class="plain" data-go2="daily">Log a cash deposit</button>') + '</div>';
  }

  /* ---------- Process a donated deer: Martin's columns, one deer at a time ---------- */
  let donateBand = null;
  function showDonate() {
    const all = deerList(), p = st.home.packs || {};
    const list = all.filter(d => d.Type === 'Donated' && (d.Status === 'Hanging' || d.Status === 'Processing'))
      .sort((a, b) => (a.Status === 'Processing' ? 0 : 1) - (b.Status === 'Processing' ? 0 : 1) || hoursHung(b) - hoursHung(a));
    const done = all.filter(d => d.Type === 'Donated' && d.Status === 'Ready').length;
    if (!list.some(d => d.Band === donateBand)) donateBand = list.length ? list[0].Band : null;
    const d = list.find(x => x.Band === donateBand);
    const pk = n => ('000' + n).slice(-4);
    const nextNote = p.grinder ? '<b>' + esc(p.grinder.band) + '</b> is on the grinder, labelled from <b>' + esc(p.grinder.first) + '</b>. The next deer\'s numbers follow on once it\'s finished.'
      : 'Next package number: <b style="font-size:20px">' + esc(p.next || '0001') + '</b> (follows on from the last donated deer, automatically)';
    let body = '<div class="card"><p class="status">Everything Martin\'s Share the Harvest sheet needs, for one donated deer at a time. ' +
      'Check-in fills the hunter details; the app fills the dates and package numbers.</p><div class="note ok">' + nextNote + '</div>' +
      (done ? '<p class="status">' + done + ' finished donated deer waiting to go to Martin: <button class="plain" data-go2="martin">Donation report</button></p>' : '') + '</div>';
    if (!list.length) body += '<div class="card"><p class="status">No donated deer in the cooler right now. Check one in first.</p><button class="btn" data-go2="intake">Check in a deer</button></div>';
    else {
      body += '<div class="chips">' + list.map(x => '<button data-pick="' + esc(x.Band) + '" class="' + (x.Band === donateBand ? 'on' : '') + '">' + esc(x.Band) +
        '<small>' + esc(x.Status === 'Processing' ? (x['First pack #'] ? 'grinding' : 'processing') : 'hanging') + '</small></button>').join('') + '</div>';
      const [fn, ...rest] = String(d['Hunter name'] || '').trim().split(/\s+/);
      const first = d['Hunter first name'] || (rest.length ? String(d['Hunter name']).trim().split(/\s+/).slice(0, -1).join(' ') : fn) || '';
      const last = d['Hunter last name'] || (rest.length ? rest[rest.length - 1] : '');
      const fp = d['First pack #'];
      const row = (k, val, note) => '<tr><th>' + esc(k) + '</th><td>' + (val ? '<b>' + esc(val) + '</b>' : '') + (note ? ' <span class="status">' + note + '</span>' : '') + '</td></tr>';
      body += '<div class="card"><b>' + esc(d.Band) + '</b> <span class="tag don">DONATED</span> <span class="status">' + esc(d.Deer || '') + '</span>' +
        '<table class="mrow">' +
        row('Customer ID', d['Customer ID'], d['Customer ID'] ? '' : '<span id="licbox"><input id="lic2" type="text" inputmode="numeric" maxlength="8" placeholder="5 to 8 digits"><button class="btn ghost" id="licsave" style="padding:8px 12px">Save</button></span>') +
        row('First Name', first) + row('Last Name', last) +
        row('Date Received', String(d.Intake || '').split(' ')[0]) +
        row('Confirmation/Seal #', d['MassWildlife confirmation']) +
        row('Date Packaged', '', 'filled in when you tap Finished') +
        row('First Pack #', fp, fp ? '' : 'next free number when you start grinding' + (p.grinder ? '' : ' (' + esc(p.next || '0001') + ')')) +
        row('Last Pack #', '', fp ? 'worked out from the package count' : '') +
        row('Donation Type', 'whole') +
        row('Invoice Date', '', 'the day it goes to Martin') + '</table>';
      const step = (n, t) => '<div class="grp" style="margin-top:14px">Step ' + n + ' · ' + t + '</div>';
      if (isViewer()) body += '';
      else if (d.Status === 'Hanging') body += step(1, 'Start processing') + '<button class="btn" data-a="start">Start processing</button>';
      else if (!fp) body += step(2, 'Before grinding') + '<p class="status">Get this deer\'s package numbers before the first package comes off the grinder.</p><button class="btn alt" data-a="grind">Get package numbers</button>';
      else body += step(3, 'Grind, label and finish') + '<div class="note warn" style="font-size:17px">Label the 2 lb packages in order from <b>' + esc(fp) + '</b>: ' + esc(fp) + ', ' + esc(pk(parseInt(fp, 10) + 1)) + ', …</div>' +
        '<p class="status">When the last package is labelled, tap Finished.</p><button class="btn" data-a="finish">Finished</button>';
      body += '<div class="form"></div></div>';
    }
    frame('donate', 'Process a donated deer', body);
    if (!document.getElementById('mrow-css')) { const c = document.createElement('style'); c.id = 'mrow-css';
      c.textContent = '.mrow{width:100%;table-layout:fixed;border-collapse:collapse;margin:10px 0;font-size:15px}.mrow th{text-align:left;font-weight:600;font-size:14px;color:var(--muted);padding:7px 8px 7px 0;width:45%;vertical-align:top;white-space:normal}.mrow td{padding:7px 0;border-bottom:1px solid var(--line);text-align:left;white-space:normal;overflow-wrap:anywhere}.mrow td input{width:100%;box-sizing:border-box;margin:0 0 6px}.mrow td .status{display:block}.mrow th{border-bottom:1px solid var(--line)}' +
        '.chips{display:flex;gap:6px;overflow-x:auto;padding:4px 0 8px}.chips button{flex:0 0 auto;border:1px solid var(--line);background:#fff;border-radius:10px;padding:8px 12px;font-size:15px;cursor:pointer;color:var(--ink);line-height:1.2}.chips button.on{background:var(--green);color:#fff;border-color:var(--green)}.chips button small{display:block;font-size:11px;opacity:.8}';
      document.head.appendChild(c); }
    $app.querySelectorAll('[data-go2]').forEach(b => b.onclick = () => GO[b.dataset.go2]());
    $app.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => { donateBand = b.dataset.pick; showDonate(); });
    if (!d) return;
    const box = $app.querySelector('.form');
    $app.querySelectorAll('[data-a]').forEach(b => b.onclick = () => act(b.dataset.a, d, box, showDonate));
    const ls = document.getElementById('licsave');
    if (ls) ls.onclick = async () => {
      const lic = (document.getElementById('lic2').value || '').replace(/\D/g, '');
      if (lic.length < 5 || lic.length > 8) return toast('The MassWildlife customer ID is 5 to 8 digits.');
      ls.disabled = true;
      try { await call({ action: 'setlicense', band: d.Band, license: lic });
        (st.home.deer || []).forEach(x => { if (band(x.Band) === band(d.Band) && x.Status !== 'Released') x['Customer ID'] = lic; }); save(); showDonate(); }
      catch (e) { ls.disabled = false; toast(e.offline ? 'Needs signal.' : e.message); }
    };
  }

  /* ---------- Martin's report: rows for his live MassWildlife sheet ---------- */
  async function showMartin(data, note) {
    frame('martin', 'Donation report', '<div id="mbox"><p class="status">Loading…</p></div>');
    const box = document.getElementById('mbox');
    try { if (!data) data = await call({ action: 'martin' }); }
    catch (e) { box.innerHTML = '<div class="note bad">' + esc(e.offline ? 'Needs signal. Try again when connected.' : e.message) + '</div>'; return; }
    const n = data.rows.length, tsv = data.rows.map(r => r.join('\t')).join('\n');
    box.innerHTML = (note ? '<div class="note ok">' + esc(note) + '</div>' : '') +
      '<div class="card"><b>' + (n ? n + ' donated deer to send' : 'Nothing new to send') + '</b>' +
      '<p class="status">Martin\'s sheet (2026HomeGround_DataEntry) is live: rows pasted in reach him right away. Invoice Date is today, ' + esc(data.today) + '. ' +
      data.sentCount + ' already sent' + (data.waiting ? ' · ' + data.waiting + ' donated deer still hanging or being processed' : '') + '.</p>' +
      (n ? '<div style="overflow-x:auto"><table class="mtab"><tr>' + data.header.map(h => '<th>' + esc(h) + '</th>').join('') + '</tr>' +
        data.rows.map(r => '<tr>' + r.map(c => '<td>' + esc(c) + '</td>').join('') + '</tr>').join('') + '</table></div>' +
        (isViewer() ? '' :
        '<ol class="status" style="padding-left:20px"><li>Tap <b>Copy rows</b>.</li><li>Open Martin\'s sheet, click the Customer ID cell of the first empty row, and paste.</li><li>Come back and tap <b>Mark as sent</b> so they aren\'t sent twice.</li></ol>' +
        '<button class="submit" id="mcopy">Copy ' + n + ' row' + (n === 1 ? '' : 's') + '</button>' +
        (isMgr() ? '<button class="btn ghost" id="msent" style="width:100%;margin-top:8px">I\'ve pasted them: mark as sent</button>' : '<p class="status">A manager marks them as sent.</p>')) : '') +
      '<div id="mout"></div></div>' +
      '<div class="card"><b>Everything</b><p class="status">All donated deer in Martin\'s layout, as a file that opens in Excel.</p><button class="btn ghost" id="dl">Download all</button></div>';
    if (!document.getElementById('mtab-css')) { const st_ = document.createElement('style'); st_.id = 'mtab-css';
      st_.textContent = '.mtab{border-collapse:collapse;font-size:13px;margin:8px 0;white-space:nowrap}.mtab th,.mtab td{border:1px solid var(--line);padding:4px 6px;text-align:left}.mtab th{background:var(--ok-bg)}';
      document.head.appendChild(st_); }
    const out = document.getElementById('mout');
    const cp = document.getElementById('mcopy');
    if (cp) cp.onclick = async () => {
      try { await navigator.clipboard.writeText(tsv); out.innerHTML = '<div class="note ok">Copied. Paste into Martin\'s sheet at the Customer ID column of the first empty row.</div>'; }
      catch (e) {
        out.innerHTML = '<p class="status">Copy didn\'t work on this device. Select the text below and copy it:</p><textarea id="mtsv" rows="4" style="width:100%">' + esc(tsv) + '</textarea>';
        const t = document.getElementById('mtsv'); t.focus(); t.select();
      }
    };
    const ms = document.getElementById('msent');
    if (ms) ms.onclick = async () => {
      ms.disabled = true;
      try { const r = await call({ action: 'martinsent', bands: data.bands }); showMartin(r, r.marked + ' marked as sent to Martin.'); }
      catch (e) { ms.disabled = false; toast(e.offline ? 'Needs signal.' : e.message); }
    };
    document.getElementById('dl').onclick = async () => {
      out.innerHTML = '<p class="status">Getting the latest…</p>';
      try {
        const all = await call({ action: 'donations' });
        const q = x => '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"';
        const csv = [all.header].concat(all.rows).map(r => r.map(q).join(',')).join('\r\n');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
        a.download = 'Home Ground donations ' + stamp().split(' ')[0].replace(/\//g, '-') + '.csv';
        document.body.appendChild(a); a.click(); a.remove();
        out.innerHTML = '<div class="note ok">' + all.rows.length + ' donated deer downloaded.</div>';
      } catch (e) { out.innerHTML = '<div class="note bad">' + esc(e.offline ? 'Needs signal. Try again when connected.' : e.message) + '</div>'; }
    };
  }

  function showPayments() {
    frame('payments', 'Hunter payments', '<div id="pay"><p class="status">Loading…</p></div>');
    const box = document.getElementById('pay');
    const money = n => '$' + fmt(n || 0);
    const draw = out => {
      const owed = out.payments.filter(p => p.status !== 'Paid'), paid = out.payments.filter(p => p.status === 'Paid');
      const canMark = isMgr();
      const row = (p, chk) => '<div class="trow">' + (chk ? '<label class="choice" style="margin:0"><input type="checkbox" data-band="' + esc(p.band) + '"> ' : '<div>') +
        '<span><b>' + esc(p.hunter || '(no name)') + '</b> · ' + money(p.amount) + ' · ' + esc(p.deer) + '<br><span class="status">' +
        esc(p.address || 'NO ADDRESS ON FILE') + (p.phone ? ' · ' + esc(p.phone) : '') + '<br>Band ' + esc(p.band) + ', in ' + esc(p.dateIn) +
        (p.status === 'Paid' ? ' · check sent ' + esc(p.sent) + (p.note ? ' (' + esc(p.note) + ')' : '') : '') + '</span></span>' + (chk ? '</label>' : '</div>') + '</div>';
      box.innerHTML = '<div class="tiles">' + '<div class="tile"><div class="n">' + money(out.owed) + '</div><div class="l">' + out.owedCount + (out.owedCount === 1 ? ' check' : ' checks') + ' owed</div></div>' +
        '<div class="tile"><div class="n">' + money(out.paid) + '</div><div class="l">' + out.paidCount + (out.paidCount === 1 ? ' check' : ' checks') + ' sent</div></div></div>' +
        '<div class="card"><p class="status">TFMV pays each donating hunter by check. Download the list for TFMV, then mark the deer paid once the checks go out.</p>' +
        '<button class="submit" id="pdl">Download owed checks for TFMV</button><div id="pout"></div></div>' +
        '<div class="card"><h3>Owed</h3>' + (owed.length ? owed.map(p => row(p, canMark)).join('') : '<p class="status">Nothing owed.</p>') +
        (canMark && owed.length ? '<label for="pnote">Check number or note <span class="hint">optional</span></label><input id="pnote" type="text" maxlength="100">' +
          '<div class="err" id="perr"></div><button class="btn" id="pmark">Mark ticked deer as paid</button>' : '') + '</div>' +
        (paid.length ? '<div class="card"><h3>Sent</h3>' + paid.map(p => row(p, false)).join('') + '</div>' : '');
      document.getElementById('pdl').onclick = () => {
        const q = x => '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"';
        const head = ['Hunter', 'Hunter number', 'Mailing address', 'Phone', 'Amount ($)', 'Deer', 'Band', 'MassWildlife confirmation', 'Date in'];
        const csv = [head].concat(owed.map(p => [p.hunter, p.hunterNumber, p.address, p.phone, p.amount, p.deer, p.band, p.confirmation, p.dateIn]))
          .map(r => r.map(q).join(',')).join('\r\n');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
        a.download = 'TFMV hunter checks ' + stamp().split(' ')[0].replace(/\//g, '-') + '.csv';
        document.body.appendChild(a); a.click(); a.remove();
        document.getElementById('pout').innerHTML = '<div class="note ok">' + owed.length + (owed.length === 1 ? ' check, ' : ' checks, ') + money(out.owed) + ', downloaded.</div>';
      };
      const mk = document.getElementById('pmark');
      if (mk) mk.onclick = async () => {
        const bands = Array.from(box.querySelectorAll('input[data-band]:checked')).map(x => x.dataset.band);
        if (!bands.length) { document.getElementById('perr').textContent = 'Tick the deer whose checks went out.'; return; }
        mk.disabled = true;
        try { const r = await call({ action: 'markpaid', bands, note: document.getElementById('pnote').value.trim() }); draw(r); toast(r.marked + ' marked paid.', true); }
        catch (e) { mk.disabled = false; document.getElementById('perr').textContent = e.offline ? 'Needs signal. Try again when connected.' : e.message; }
      };
    };
    call({ action: 'payments' }).then(draw).catch(e => { box.innerHTML = '<div class="note bad">' + esc(e.offline ? 'Needs signal. Try again when connected.' : e.message) + '</div>'; });
  }

  const GO = { payments: showPayments, status: showStatus, board: showBoard, intake: showIntake, shifts: () => showShifts(), messages: showMessages, help: showHelp,
    numbers: showNumbers, daily: showDaily, team: showTeam, martin: () => showMartin(), donate: showDonate, scan: () => showScan() };

  /* ---------- start ---------- */
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (st.pin && st.staff) {
    if (pendingBand) { const b = pendingBand; pendingBand = null; showDeer(b); refresh(true); } else { showHome(); refresh(true); }
    flush();
  } else showLogin(pendingBand ? 'Sign in to see band ' + pendingBand + '.' : '');
  window.addEventListener('hashchange', () => { const m = location.hash.match(/[#&]d=([^&]+)/); if (m && st.staff) { history.replaceState(null, '', location.pathname); showDeer(decodeURIComponent(m[1])); } });
})();
