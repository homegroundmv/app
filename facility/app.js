/* Home Ground Facility app (v2): processors' phones and the intake laptop.
 * Sign in with your staff number (P-001) and PIN.
 * Screens: Home (help alerts, clock in/out, your numbers), Cooler board, Check in a deer, Shift
 * schedule, Messages (team chat and direct), Need help, My numbers, Team numbers (managers),
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
  // Day-dot colours, food-service standard (Mon blue … Sun black): the colour of the intake day.
  const DOTS = [['Sunday', 'Black', '#111'], ['Monday', 'Blue', '#1E5BD8'], ['Tuesday', 'Yellow', '#F2C200'],
    ['Wednesday', 'Red', '#D22'], ['Thursday', 'Brown', '#7A4A1E'], ['Friday', 'Green', '#2A9A3A'], ['Saturday', 'Orange', '#F07A00']];
  const dotFor = s => { const d = parse(s); return d ? DOTS[d.getDay()] : null; };

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
    st.outbox.push({ clientId: uid(), action, fields, at: stamp(), label, created: Date.now() });
    save(); flush();
  }
  let flushing = false;
  async function flush() {
    if (flushing || !st.pin) return;
    flushing = true;
    try {
      for (const it of st.outbox.slice()) {
        if (it.error) continue;
        try {
          await call({ action: it.action, fields: it.fields, at: it.at, clientId: it.clientId });
          st.outbox = st.outbox.filter(x => x.clientId !== it.clientId);
        } catch (e) {
          if (e.fatal) it.error = e.message; else break;
        }
        save();
      }
      if (!st.outbox.some(x => !x.error)) await refresh(true);
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
  }
  window.addEventListener('online', flush);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) flush(); });
  setInterval(() => { if (!document.hidden && (current === 'home' || current === 'board')) { flush(); if (!flushing) refresh(true); } }, 45000);

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
      if (x.action === 'intake' && !d) list.push({ Band: b, Intake: x.at, 'Hunter number': f.hunterNumber, 'Hunter name': f.hunterName, 'MassWildlife confirmation': f.confirmation, Deer: f.deer, Type: f.type, 'Pork fat added': f.porkFat ? 'Yes' : (f.type === 'Donated' ? 'Yes' : 'No'), Status: 'Hanging', pending: true });
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
      try { const out = await call({ action: 'login' }); st.staff = out.staff; st.number = out.staff.number; save(); showHome(); refresh(); flush(); }
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
      (next ? '<div class="status">Next shift: ' + esc(dayName(next.date)) + ', ' + esc(next.slot) + ' ' + t12(next.starts) + '–' + t12(next.ends) + '</div>' : '') +
      '</div><button class="btn' + (h.clockedIn ? ' alt' : '') + '" id="clock">' + (h.clockedIn ? 'Clock out' : 'Clock in') + '</button></div><div id="clock-err" class="err"></div></div>';
    const tiles = '<div class="tiles">' +
      tile(m.deer || 0, 'Deer processed') + tile(m.donated || 0, 'Donated deer') +
      tile(fmt(m.packagedLb || 0), 'lb packaged') + tile(fmt(m.groundVenisonLb || 0), 'lb ground venison') + '</div>' +
      '<p class="status center">Your season so far · ' + esc(s.pkgSize) + ' lb packages, ' + esc(s.fatDonated) + '% pork fat</p>';
    if (isViewer()) {
      frame('home', '', '<div class="note ok">View-only sign-in: you can look at everything below, but nothing can be changed from this sign-in.</div>' +
        big('status', 'Facility status', 'Cooler, oldest deer, temperatures, who\'s here') +
        big('board', 'Cooler', inC + ' of ' + s.coolerCap + ' in the cooler' + (inC >= s.coolerCap ? ' · FULL' : '')) +
        big('martin', 'Donation report', 'Download the donated-deer list', 'alt') +
        big('payments', 'Hunter payments', 'Donation checks owed and sent, with mailing addresses', 'alt'), true);
      $app.querySelectorAll('[data-go]').forEach(b => b.onclick = () => GO[b.dataset.go]());
      return;
    }
    frame('home', '',
      (note ? '<div class="note ok">' + note + '</div>' : '') +
      '<div id="alerts">' + alertsHtml() + '</div><div id="push"></div>' + clockCard + tiles +
      big('status', 'Facility status', 'Cooler, oldest deer, temperatures, who\'s here') +
      big('board', 'Cooler', inC + ' of ' + s.coolerCap + ' in the cooler' + (inC >= s.coolerCap ? ' · FULL' : '')) +
      big('intake', 'Check in a deer', 'Band, tag, skinning, print the intake band') +
      big('shifts', 'Shift schedule', 'Book or cancel your shifts · up to ' + s.maxAtOnce + ' at a time') +
      big('messages', 'Messages' + (h.unread ? ' (' + h.unread + ' new)' : ''), 'Team chat and direct messages') +
      big('help', 'Need help', 'Sends a notification to everyone on the team', 'red') +
      big('numbers', 'My numbers', 'Deer, pounds, hours and pay this week') +
      big('daily', 'Daily log', 'Temperatures, cleaning, waste, complaints', 'alt') +
      (isMgr() ? big('team', 'Team numbers', 'Every processor, this week and the season', 'alt') : '') +
      big('martin', 'Donation report', 'Download for Martin', 'alt') +
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
    const card = d => {
      const h = hoursHung(d), dot = dotFor(d.Intake);
      const cls = d.Status === 'Hanging' ? (h >= s.maxHold ? ' red' : h >= s.startBy ? ' amber' : '') : '';
      const mineOrMgr = d['Processor number'] === st.staff.number || isMgr();
      const act = isViewer() ? '' : d.Status === 'Hanging' ? '<button class="btn" data-a="start">Start processing</button>'
        : d.Status === 'Processing' ? (mineOrMgr ? '<button class="btn" data-a="finish">Finished</button>' : '')
        : d.Status === 'Ready' ? '<button class="btn alt" data-a="release">Release</button>' : '';
      return '<div class="card' + cls + (d.Type === 'Donated' ? ' donated' : '') + '" data-band="' + esc(d.Band) + '">' +
        '<div class="deer"><div><span class="band">' + esc(d.Band) + '</span> ' +
        '<span class="tag ' + (d.Type === 'Donated' ? 'don">DONATED' : 'prv">PRIVATE') + '</span>' + (d['DDP deer'] === 'Yes' ? '<span class="tag">DDP</span>' : '') +
        (d.Type !== 'Donated' && d['Pork fat added'] === 'Yes' ? '<span class="tag">+ PORK FAT</span>' : '') +
        (d.pending ? '<span class="pill wait">not sent yet</span>' : '') +
        '<div class="status">' + (dot ? '<span class="dot" style="background:' + dot[2] + '"></span>' + dot[1] + ' dot · ' : '') +
        'in ' + esc(d.Intake) + ' · ' + esc(d.Deer || '') + ' · ' + esc(d['Hunter number'] || d['Hunter name'] || '') +
        (d.Butcher ? ' · ' + esc(d.Butcher) + (d['Processor number'] ? ' (' + esc(d['Processor number']) + ')' : '') : '') +
        (d['Carcass weight (lb)'] ? ' · ' + esc(d['Carcass weight (lb)']) + ' lb carcass' : '') +
        (d['Pounds packaged'] ? ' · ' + esc(d['Pounds packaged']) + ' lb packaged' : '') + '</div></div>' +
        '<div class="hrs">' + (d.Status === 'Released' ? '' : Math.floor(h) + ' h') + '</div></div>' +
        (d.Status === 'Released' ? '<div class="status">Released ' + esc(d.Released) + ' to ' + esc(d['Released to']) + '</div>' : '') +
        '<div class="actions">' + act + (d.Status !== 'Released' && !isViewer() ? '<button class="btn ghost" data-a="print">Print band</button>' : '') + '</div><div class="form"></div></div>';
    };
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

  function act(kind, d, box) {
    if (kind === 'print') return printBand(d);
    const s = S();
    const fatPct = d.Type === 'Donated' ? s.fatDonated : (d['Pork fat added'] === 'Yes' ? s.fatPrivate : 0), fatOn = fatPct > 0, fat = fatPct / 100;
    const v = id => (document.getElementById(id) || {}).value || '';
    const forms = {
      start: () => '<div class="note warn" style="font-size:17px">Tag confirmation number: <b>' + esc(d['MassWildlife confirmation'] || 'none recorded') + '</b></div>' +
        '<label class="choice"><input id="f0" type="checkbox"> The confirmation number on the deer\'s tag matches</label>' +
        (isMgr() ? '<label>Processor</label><select id="fp">' + (st.home.staff || []).map(x => '<option value="' + esc(x.number) + '"' + (x.number === st.staff.number ? ' selected' : '') + '>' + esc(x.name + ' (' + x.number + ')') + '</option>').join('') + '</select>'
          : '<p class="status">Processor: ' + esc(st.staff.name + ' (' + st.staff.number + ')') + '</p>') +
        '<label>Carcass weight (lb) <span class="hint">On the hanging scale: field dressed, skin and head off</span></label><input id="f1" type="number" inputmode="decimal" min="0" step="0.1">',
      finish: () => '<p class="status">Started ' + esc(d['Processing started'] || '') + ' · carcass ' + esc(d['Carcass weight (lb)'] || '?') + ' lb</p>' +
        '<div class="grid2"><div><label>Ground packages (' + esc(s.pkgSize) + ' lb)</label><input id="f1" type="number" inputmode="numeric" min="0" step="1"></div>' +
        '<div><label>Intact cut packages</label><input id="f2" type="number" inputmode="numeric" min="0" step="1" value="0"></div>' +
        '<div><label>Intact cuts total (lb)</label><input id="f3" type="number" inputmode="decimal" min="0" step="0.1" value="0"></div>' +
        '<div><label>Trim discarded (lb) <span class="hint">optional</span></label><input id="f4" type="number" inputmode="decimal" min="0" step="0.1"></div></div>' +
        '<div class="calc" id="calc"></div>' +
        '<div class="note ' + (fatOn ? 'warn">Grind with <b>' + esc(fatPct) + '% pork fat</b>.' : 'ok">All-venison grind: <b>no pork fat</b>.') + '</div>' +
        (fatOn && d.Type !== 'Donated' ? '<label class="choice"><input id="f7" type="checkbox"> Out of pork fat: grind all venison and take the $' + esc(s.porkAddOn || 20) + ' off the hunter\'s price</label>' : '') +
        '<label class="choice"><input id="f5" type="checkbox"> Allergen labels on every package (alpha-gal)' + (fatOn ? '; ground also says "Contains pork"' : '') + '</label>' +
        '<label class="choice"><input id="f6" type="checkbox"> Knives, hooks, luggers and grinder sanitized after this deer</label>',
      release: () => '<label>Released to</label><select id="f1"><option value="">Choose…</option><option>Hunter pickup</option>' +
        (s.pantries || []).map(p => '<option>' + esc(p) + '</option>').join('') + '<option value="other">Other…</option></select>' +
        '<input id="f3" type="text" placeholder="Who?" hidden style="margin-top:8px">' +
        '<label>Pounds out</label><input id="f2" type="number" inputmode="decimal" min="0" value="' + esc(d['Pounds packaged'] || '') + '">' +
        (d['Hunter price ($)'] ? '<div class="note warn">Hunter pickup: collect <b>$' + esc(d['Hunter price ($)']) + '</b>' + (d['Pork fat added'] === 'Yes' ? ' (includes the pork fat add-on)' : '') + '.</div>' : ''),
    };
    box.innerHTML = forms[kind]() + '<div class="err" id="ferr"></div><button class="btn" id="fok" style="margin-top:12px">Save</button> <button class="btn ghost" id="fx">Cancel</button>';
    if (kind === 'release') document.getElementById('f1').onchange = e => { document.getElementById('f3').hidden = e.target.value !== 'other'; };
    const calc = () => {
      const drop = !!(document.getElementById('f7') || {}).checked, fr = drop ? 0 : fat;
      const pk = Math.round(num(v('f1'))), il = num(v('f3')), groundLb = pk * s.pkgSize;
      const ven = r1(groundLb * (1 - fr)), pork = r1(groundLb * fr), total = r1(groundLb + il), carcass = num(d['Carcass weight (lb)']);
      const el = document.getElementById('calc');
      if (el) el.innerHTML = 'Ground: <b>' + fmt(groundLb) + ' lb</b> (' + fmt(ven) + ' lb venison + ' + fmt(pork) + ' lb pork fat) · Intact: <b>' + fmt(il) + ' lb</b><br>' +
        'Total packaged: <b>' + fmt(total) + ' lb</b>' + (carcass ? ' · Venison yield: <b>' + Math.round((ven + il) / carcass * 100) + '%</b> of ' + fmt(carcass) + ' lb carcass' : '');
      return { pk, il, total };
    };
    if (kind === 'finish') { ['f1', 'f3'].forEach(id => { document.getElementById(id).oninput = calc; }); const f7 = document.getElementById('f7'); if (f7) f7.onchange = calc; calc(); }
    document.getElementById('fx').onclick = () => { box.innerHTML = ''; };
    document.getElementById('fok').onclick = () => {
      const err = m => { document.getElementById('ferr').textContent = m; };
      if (kind === 'start') {
        if (!document.getElementById('f0').checked) return err('Check the confirmation number on the tag first. If it doesn\'t match, stop and tell Joe.');
        if (!(num(v('f1')) > 0)) return err('Weigh the carcass and enter the weight.');
        const p = isMgr() ? v('fp') : st.staff.number;
        const pn = ((st.home.staff || []).find(x => x.number === p) || st.staff).name;
        queue('start', { band: d.Band, processor: p, processorName: pn, weight: v('f1'), confirmationChecked: true }, 'Start ' + d.Band);
      }
      if (kind === 'finish') {
        const c = calc(), ip = Math.round(num(v('f2')));
        if (!(c.pk + ip > 0)) return err('Enter the packages.');
        if (ip && !(c.il > 0)) return err('Weigh the intact cuts and enter the total.');
        if (!document.getElementById('f5').checked) return err('Allergen labels must go on every package before it leaves the table.');
        if (!document.getElementById('f6').checked) return err('Sanitize knives, hooks, luggers and the grinder before the next deer, then tick the box.');
        queue('finish', { band: d.Band, groundPackages: c.pk, intactPackages: ip, intactLb: c.il, trimLb: v('f4'), total: c.total, allergen: true, sanitized: true, noPork: !!(document.getElementById('f7') || {}).checked }, 'Finish ' + d.Band);
      }
      if (kind === 'release') {
        const to = v('f1') === 'other' ? v('f3').trim() : v('f1');
        if (!to) return err('Say who it went to.');
        queue('release', { band: d.Band, to, pounds: v('f2') }, 'Release ' + d.Band);
      }
      showBoard();
    };
  }

  /* ---------- intake ---------- */
  const TURN_AWAY = ['No MassWildlife confirmation number, or the tag doesn\'t match', 'More than 24 hours since the shot',
    'Not field dressed within 4 hours (air above 37°F)', 'Spoiled: smell, green or slimy meat, flies or maggots',
    'Heavy gut contamination that can\'t be trimmed', 'Signs of illness: lesions, abscesses, very thin or sick-looking',
    'Road-killed, or already cut up or quartered', 'Other (say why in the notes)'];
  function showIntake() {
    const s = S(), now = new Date();
    frame('intake', 'Check in a deer',
      '<div class="card">' +
      '<label for="band">Field band number <span class="hint">On the hock. No band? Use a new one from the box.</span></label><input id="band" type="text" autocapitalize="characters">' +
      '<label>Donated or private?</label>' +
      '<label class="choice"><input type="radio" name="type" value="Donated"> <span><b>Donated</b> (Share the Harvest). TFMV mails the hunter a check: $' + esc(s.payDoe || 150) + ' a doe or button buck, $' + esc(s.payBuck || 100) + ' an antlered buck.</span></label>' +
      '<label class="choice"><input type="radio" name="type" value="Private"> <span><b>Private</b>: processed for the hunter, $' + esc(s.privatePrice || 250) + '.</span></label>' +
      (s.porkInStock === false ? '<p class="status" id="porkbox" hidden>Pork fat add-on: not available right now. The grind will be all venison.</p>'
        : '<label class="choice" id="porkbox" hidden><input id="pork" type="checkbox"> <span>Add pork fat to the ground (' + esc(s.fatPrivate || 10) + '%), <b>+$' + esc(s.porkAddOn || 20) + '</b>. Local-farm pork fat, as available. Without it, the grind is all venison.</span></label>') +
      '<label for="deer">Deer</label><select id="deer"><option value="">Choose…</option><option>Doe</option><option>Button buck</option><option>Antlered buck</option></select>' +
      '<div class="grid2"><div><label for="hn">Hunter number <span class="hint">if enrolled</span></label><input id="hn" type="text" autocapitalize="characters" placeholder="H-001"></div>' +
      '<div><label for="nm">Hunter name</label><input id="nm" type="text"></div>' +
      '<div><label for="ph">Hunter phone</label><input id="ph" type="tel"></div>' +
      '<div><label for="cf">MassWildlife confirmation number</label><input id="cf" type="text"></div>' +
      '<div><label for="sd">Date of the shot</label><input id="sd" type="date" value="' + isoDate(now) + '" max="' + isoDate(now) + '"></div>' +
      '<div><label for="stm">Time of the shot</label><input id="stm" type="time"></div></div>' +
      '<div id="addrbox" hidden><label for="ad1">Hunter mailing address <span class="hint">TFMV mails the donation check here</span></label><input id="ad1" type="text" autocomplete="street-address" placeholder="Street or PO box">' +
      '<div class="grid2"><div><label for="adt">Town</label><input id="adt" type="text"></div><div><label for="ads">State</label><input id="ads" type="text" value="MA" maxlength="2" autocapitalize="characters"></div>' +
      '<div><label for="adz">ZIP</label><input id="adz" type="text" inputmode="numeric" maxlength="10"></div></div></div>' +
      '<div id="age" class="status"></div>' +
      '<label class="choice"><input id="fd" type="checkbox"> Field dressed within 4 hours of the shot (or the air stayed below 37°F)</label>' +
      '<label class="choice"><input id="ddp" type="checkbox"> Taken under a deer depredation permit (DDP)</label>' +
      '<label class="choice"><input id="sk" type="checkbox"> Skinned and head removed by Home Ground before hanging</label>' +
      '<label for="nt">Notes</label><textarea id="nt"></textarea>' +
      '<div class="err" id="err"></div><button class="submit" id="save">Check in and print band</button>' +
      '<button class="btn ghost" id="away" style="width:100%">Turn this deer away instead</button><div id="awaybox"></div></div>');
    const v = id => document.getElementById(id).value.trim();
    const shotAt = () => { if (!v('sd') || !v('stm')) return null; const [y, m, d] = v('sd').split('-').map(Number), [hh, mm] = v('stm').split(':').map(Number); return new Date(y, m - 1, d, hh, mm); };
    const ageNote = () => {
      const t = shotAt(), el = document.getElementById('age');
      if (!t) { el.textContent = ''; return 0; }
      const h = (Date.now() - t) / 36e5;
      el.innerHTML = h > 24 ? '<div class="note bad">' + Math.floor(h) + ' hours since the shot. Over 24 hours: Share the Harvest won\'t take it as a donation.</div>' : Math.max(0, Math.floor(h)) + ' hours since the shot.';
      return h;
    };
    ['sd', 'stm'].forEach(id => { document.getElementById(id).onchange = ageNote; });
    document.querySelectorAll('input[name=type]').forEach(r => r.onchange = () => { document.getElementById('porkbox').hidden = r.value !== 'Private' || !r.checked; document.getElementById('addrbox').hidden = r.value !== 'Donated' || !r.checked; });
    const err = m => { document.getElementById('err').textContent = m; };
    document.getElementById('save').onclick = () => {
      const type = (document.querySelector('input[name=type]:checked') || {}).value;
      const b = band(v('band'));
      if (!b) return err('Enter the band number.');
      if (deerList().some(d => band(d.Band) === b && d.Status !== 'Released')) return err('Band ' + b + ' is already in the cooler.');
      if (!type) return err('Choose donated or private.');
      if (!v('deer')) return err('Choose doe, button buck or antlered buck.');
      if (!v('nm') && !v('hn')) return err('Enter the hunter\'s name or number.');
      if (type === 'Donated' && (!v('ad1') || !v('adt') || !v('adz'))) return err('Enter the hunter\'s mailing address (street, town and ZIP). TFMV mails the donation check there.');
      if (!v('cf')) return err('Enter the MassWildlife confirmation number. No confirmation number, no intake.');
      const t = shotAt();
      if (!t) return err('Enter the date and time of the shot.');
      const h = ageNote();
      if (type === 'Donated' && h > 24) return err('Over 24 hours since the shot. It can\'t be accepted as a donation: turn it away, or check it in as private if Joe agrees.');
      if (type === 'Donated' && !document.getElementById('fd').checked) return err('Donated deer must be field dressed within 4 hours of the shot.');
      if (!document.getElementById('sk').checked) return err('Home Ground skins and removes the head before any deer hangs. Tick the box once it\'s done.');
      if (type === 'Private' && coolerCount() >= S().coolerCap) return err('The cooler is full. Hold private deer until there\'s room.');
      const f = { band: b, type, deer: v('deer'), hunterNumber: v('hn'), hunterName: v('nm'), hunterPhone: v('ph'), confirmation: v('cf'),
        address: type === 'Donated' ? v('ad1') + ', ' + v('adt') + ', ' + (v('ads') || 'MA').toUpperCase() + ' ' + v('adz') : '',
        shotAt: stamp(t), dressed4h: document.getElementById('fd').checked, ddp: document.getElementById('ddp').checked, skinned: true, notes: v('nt'),
        porkFat: type === 'Private' && !!document.getElementById('pork') && document.getElementById('pork').checked };
      queue('intake', f, 'Check-in ' + b);
      printBand({ Band: b, Intake: stamp(), Type: type, Deer: f.deer, 'Hunter number': f.hunterNumber });
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
        queue('reject', { hunterName: v('nm'), hunterPhone: v('ph'), confirmation: v('cf'), deer: v('deer'),
          type: (document.querySelector('input[name=type]:checked') || {}).value || '', reason: why + (v('nt') ? ': ' + v('nt') : '') }, 'Turned away');
        showHome('Logged as turned away.');
      };
    };
  }

  // Intake band: band number, intake date large, donated/private, day-dot colour.
  function printBand(d) {
    const dot = dotFor(d.Intake), w = parse(d.Intake);
    document.getElementById('label').innerHTML =
      '<div class="lt">' + (d.Type === 'Donated' ? 'DONATED' : 'PRIVATE') + ' · HOME GROUND</div>' +
      '<div class="ld">IN ' + (w ? (w.getMonth() + 1) + '/' + w.getDate() : '') + '</div>' +
      '<div class="lb">' + esc(d.Band) + ' · ' + esc(d.Deer || '') + ' · ' + esc(d['Hunter number'] || '') + '</div>' +
      '<div>' + (dot ? dot[0] + ': ' + dot[1].toUpperCase() + ' DOT' : '') + '</div>';
    setTimeout(() => window.print(), 50);
  }

  /* ---------- shift schedule ---------- */
  async function showShifts(data) {
    frame('shifts', 'Shift schedule', '<div id="sched"><p class="status">Loading…</p></div>');
    const box = document.getElementById('sched');
    try { if (!data) data = await call({ action: 'shifts' }); }
    catch (e) { box.innerHTML = '<div class="note bad">' + esc(e.offline ? 'The schedule needs signal.' : e.message) + '</div>'; return; }
    const mine = data.myShifts || [];
    box.innerHTML = '<div class="card"><b>Your shifts</b>' + (mine.length ? mine.map(x => '<div class="status">' + esc(dayName(x.date)) + ' · ' + esc(x.slot) + ' ' + t12(x.starts) + '–' + t12(x.ends) + '</div>').join('') : '<div class="status">None booked.</div>') +
      '<div class="status" style="margin-top:6px">Up to ' + data.max + ' processors at a time. Tap Book to take a shift; cancel any time before it starts. Clock in when you arrive.</div></div>' +
      data.days.map(day => '<h2>' + esc(dayName(day.date)) + '</h2>' + day.slots.map(sl => {
        const n = sl.people.length, me = sl.people.find(p => p.mine), full = n >= data.max;
        const cls = sl.past ? 'past' : me ? 'mine' : full ? 'full' : n ? 'some' : 'open';
        const btn = sl.past ? '' : me ? '<button class="btn ghost" data-cancel="' + esc(me.id) + '">Cancel</button>'
          : full ? '<span class="pill wait">Full</span>' : '<button class="btn" data-book="' + esc(day.date + '|' + sl.slot) + '">Book</button>';
        return '<div class="slot ' + cls + '"><div><b>' + esc(sl.slot) + '</b> ' + t12(sl.starts) + '–' + t12(sl.ends) +
          '<div class="status">' + n + ' of ' + data.max + (n ? ': ' + esc(sl.people.map(p => p.mine ? 'You' : p.name).join(', ')) : '') + '</div></div><div>' + btn +
          (isMgr() && !sl.past && !full ? ' <button class="plain" data-cover="' + esc(day.date + '|' + sl.slot) + '">Ask for cover</button>' : '') + '</div></div>';
      }).join('')).join('');
    const go = async (b, body, done) => {
      b.disabled = true;
      try { const out = await call(body); if (done) done(out); else showShifts(out); }
      catch (e) { b.disabled = false; toast(e.offline ? 'Needs signal.' : e.message); }
    };
    box.querySelectorAll('[data-book]').forEach(b => b.onclick = () => { const [date, slot] = b.dataset.book.split('|'); go(b, { action: 'book', date, slot }); });
    box.querySelectorAll('[data-cancel]').forEach(b => b.onclick = () => { if (confirmCancel()) go(b, { action: 'cancel', id: b.dataset.cancel }); });
    box.querySelectorAll('[data-cover]').forEach(b => b.onclick = () => { const [date, slot] = b.dataset.cover.split('|'); go(b, { action: 'cover', date, slot }, out => { b.textContent = 'Sent to ' + out.sent + ' phone' + (out.sent === 1 ? '' : 's'); }); });
  }
  const confirmCancel = () => true;   // no browser dialogs: cancelling is one tap and can be re-booked

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
    ['Tight tank pumped', 'Company'], ['Complaint', 'Lot number, if known. Details in the note']];
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
      if (/temp|Thermometer/.test(type) && !isFinite(Number(value))) { document.getElementById('err').textContent = 'Enter the reading as a number.'; return; }
      if (!value && !note) { document.getElementById('err').textContent = 'Enter the reading or a note.'; return; }
      const hot = (type === 'Cooler temp (°F)' && Number(value) > 41) || (type === 'Freezer temp (°F)' && Number(value) > 10) || (type === 'Facility temp (°F)' && Number(value) > (S().trailerLimit || 42));
      queue('log', { type, value, note, unit: document.getElementById('unitbox').hidden ? '' : document.getElementById('lu').value }, type);
      showHome(hot ? 'Saved. That reading is over the limit: Joe has been alerted. Check the door and the unit now.' : 'Saved to the log.');
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
      '<div class="card"><b>People</b><div class="tiles">' + tile(p.clockedIn.length, 'Clocked in now') + tile(p.onShift ? p.onShift.booked.length + ' of ' + p.max : '—', p.onShift ? 'Booked: ' + p.onShift.slot : 'No shift now') + '</div>' +
      (p.clockedIn.length ? '<div class="status">Clocked in: ' + esc(p.clockedIn.map(w => w.name + ' (since ' + when(w.since).split(' ').slice(-2).join(' ') + ')').join(', ')) + '</div>' : '') +
      (p.onShift && p.onShift.booked.length ? '<div class="status">On the ' + esc(p.onShift.slot.toLowerCase()) + ' shift: ' + esc(p.onShift.booked.join(', ')) + ' · ends ' + t12(p.onShift.ends) + '</div>' : '') +
      (p.nextShift ? '<div class="status">Next: ' + esc(p.nextShift.slot) + ' at ' + t12(p.nextShift.starts) + ', ' + p.nextShift.people + ' of ' + p.max + ' booked</div>' : '') + '</div>' +
      '<div class="card"><b>Today</b><div class="tiles">' + tile(x.today.in, 'Deer in') + tile(x.today.processed, 'Processed') + tile(fmt(x.today.lb), 'lb packaged') + tile(x.today.released, 'Released') + '</div>' +
      (x.today.turnedAway ? '<div class="status">' + x.today.turnedAway + ' turned away today.</div>' : '') + '</div>' +
      '<div class="card"><b>Cleaning and upkeep</b> <span class="status">last logged</span>' +
      up('End-of-day clean', x.upkeep.endOfDayClean) + up('Pre-op check', x.upkeep.preOp) + up('Sanitizer test', x.upkeep.sanitizer) +
      up('Thermometer check', x.upkeep.thermometer) + up('Waste pickup', x.upkeep.waste) + up('Tight tank pumped', x.upkeep.tightTank) + '</div>';
  }

  /* ---------- Martin's report ---------- */
  function showMartin() {
    frame('martin', 'Donation report', '<div class="card"><p class="status">Every donated deer, in the layout for Martin\'s spreadsheet. Downloads as a file that opens in Excel.</p><button class="submit" id="dl">Download for Martin</button><div id="mout"></div></div>');
    document.getElementById('dl').onclick = async () => {
      const box = document.getElementById('mout');
      box.innerHTML = '<p class="status">Getting the latest…</p>';
      try {
        const out = await call({ action: 'donations' });
        const q = x => '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"';
        const csv = [out.header].concat(out.rows).map(r => r.map(q).join(',')).join('\r\n');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
        a.download = 'Home Ground donations ' + stamp().split(' ')[0].replace(/\//g, '-') + '.csv';
        document.body.appendChild(a); a.click(); a.remove();
        box.innerHTML = '<div class="note ok">' + out.rows.length + ' donated deer downloaded.</div>';
      } catch (e) { box.innerHTML = '<div class="note bad">' + esc(e.offline ? 'Needs signal. Try again when connected.' : e.message) + '</div>'; }
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
    numbers: showNumbers, daily: showDaily, team: showTeam, martin: showMartin };

  /* ---------- start ---------- */
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (st.pin && st.staff) { showHome(); refresh(true); flush(); } else showLogin();
})();
