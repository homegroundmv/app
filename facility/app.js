/* Home Ground Facility app (v2): processors' phones and the intake laptop.
 * Sign in with your staff number (P-001) and PIN.
 * Screens: Home (help alerts, clock in/out, your numbers), Cooler board, Check in a deer, Book your time
 * (processing or skinning), Messages (team chat and direct), Need help, My numbers, Team numbers (managers),
 * Log book, Donation report, and the three Friesla sanitation records:
 * Pre-op SSOP, Operational SSOP and Sanitation corrective action.
 * Deer actions and log entries are saved on the device first and sent when there's signal.
 * Every deer gets a Home Ground ID at intake, printed on the intake band, and that is its ID all
 * the way through. Nothing is on the deer before it reaches the building (hunter bands dropped 27 Oct).
 */
(function () {
  'use strict';
  const CFG = window.HG_CONFIG || {};
  /* Shown next to Sign out. Twice on 7 November we lost time to not knowing which copy of the app
     a phone was actually running — a fix looks ineffective when the phone is still on yesterday's
     service worker, and there was no way to tell by looking. Keep this in step with VERSION in
     sw.js: it is the number somebody reads out over the phone. */
  const APP_VERSION = 'v66';
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
  const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
  const fromHM = n => Math.floor(n / 60) + ':' + pad(n % 60);
  const hm2 = hm => { const [h, m] = String(hm).split(':').map(Number); return pad(h) + ':' + pad(m || 0); };
  const t12 = hm => { const [h, m] = String(hm).split(':').map(Number); const ap = h >= 12 ? 'pm' : 'am'; const hh = h % 12 || 12; return hh + (m ? ':' + pad(m) : '') + ' ' + ap; };
  const when = t => { const d = parse(t); return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : esc(t); };
  // "11/3/2026 17:05" to "17:05", the half of a stamp the clock screens care about.
  const hhmm = s => { const m = String(s || '').match(/\b(\d{1,2}):(\d{2})\b/); return m ? m[1] + ':' + m[2] : ''; };
  /* Rows checked in before the name was split in two carry only the one "Hunter name". The
     correction form has to open on those as well, or the deer that most need correcting are the
     ones that cannot be.
     Last word is the surname, matching how the backend splits the same string. */
  const splitName = n => { const p = String(n || '').trim().split(/\s+/); return p.length < 2 ? { first: p[0] || '', last: '' } : { first: p.slice(0, -1).join(' '), last: p[p.length - 1] }; };
  const first = n => String(n || '').trim().split(/\s+/)[0] || '';
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
  /* The roll in the printer changes every day, so on a band a colour IS a date. Standing at the
     cooler holding a band, the question is the other way round from intake: not "what colour today"
     but "this one is Aqua — when did it come in, and how long has it hung?" This is that lookup,
     today first, with the deer actually in the cooler counted against each colour so it reads as
     the cooler rather than as a reference card. */
  let bandFilter = '';
  function bandKey() {
    const s = S(), list = s.bandColours && s.bandColours.length ? s.bandColours : ['Aqua', 'Yellow', 'Orange', 'Day Glow Green', 'Day Glow Pink'];
    const inCooler = deerList().filter(d => d.Status === 'Hanging' || d.Status === 'Processing');
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - i);
      const name = bandColour(d);
      const mine = inCooler.filter(x => colourOf(x) === name);
      const hrs = mine.map(hoursHung);
      out.push({ name, i, iso: isoDate(d), date: dayName(isoDate(d)),
        when: i === 0 ? 'today' : i === 1 ? 'yesterday' : '', n: mine.length,
        oldest: hrs.length ? Math.max.apply(null, hrs) : null,
        // A deer past the maximum hold has been there a full cycle, so its band is the same colour
        // as today's roll. Say so on the row rather than letting two days look like one.
        stale: mine.filter(x => hoursHung(x) >= list.length * 24).length });
    }
    return out;
  }
  function bandKeyHtml() {
    const s = S(), rows = bandKey();
    return '<div class="card"><b>Band colours</b> <span class="status">what is on the roll each day \u00b7 tap one to show just those deer</span>' +
      rows.map(r => {
        const cls = r.oldest === null ? '' : r.oldest >= s.maxHold ? ' bad' : r.oldest >= s.startBy ? ' warnrow' : '';
        const on = bandFilter === r.name;
        return '<div class="trow' + cls + '" data-bandkey="' + esc(r.name) + '" style="cursor:pointer' + (on ? ';background:var(--ok-bg)' : '') + '">' +
          '<div><b>' + swatch(r.name) + (on ? ' \u2713' : '') + '</b><div class="status">' +
          esc(r.when ? r.when + ' \u00b7 ' + r.date : r.date) +
          (r.n ? ' \u00b7 oldest ' + Math.floor(r.oldest) + ' h' + (r.oldest >= s.maxHold ? ' \u00b7 OVER THE MAXIMUM HOLD' : r.oldest >= s.startBy ? ' \u00b7 start next' : '') : ' \u00b7 none in the cooler') +
          (r.stale ? ' \u00b7 ' + r.stale + ' of these is a full cycle old, so it carries today\'s colour' : '') +
          '</div></div><div class="tval">' + (r.n || '\u2014') + '</div></div>';
      }).join('') + '</div>';
  }
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
  st.hunters = st.hunters || { at: 0, list: [] };
  function save() { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* keep in memory */ } }
  save();
  const S = () => st.home.settings || { coolerCap: 30, coolerAlert: 80, startBy: 72, maxHold: 120, maxAtOnce: 6, slots: [], pieceRate: 125, minWage: 15, pkgSize: 2, fatDonated: 10, fatPrivate: 10, privatePrice: 250, porkAddOn: 20, porkInStock: true, pantries: [], helpHours: 4, skinRate: 25, skinHourly: 25, otherHourly: 25, intakeFee: 10, maxSkinners: 5, mhu1Cap: 12, loneGrace: 30, preopItems: [], opItems: [], closeItems: [] };
  const isMgr = () => !!(st.staff && st.staff.manager);
  // Who a hunter is likely to text or ring: the published number reaches a manager or intake staff.
  const atDoor = () => isMgr() || /intake/i.test((st.staff && st.staff.role) || '');
  const isViewer = () => !!(st.staff && st.staff.viewer);

  /* ---------- backend ---------- */
  /* ---------- screens that can open on what we already know ----------

     Joe, 7 November: "it's almost every tab I click on... donation report, sanitation records,
     etc.. there's a lag with all of them." Every screen that fetches opens on "Loading…" and
     waits for Apps Script, and that wait is a fixed cost per request — it is there whatever the
     screen is doing.

     So a screen that only READS opens on the last answer we were given, straight away, and
     redraws itself when the fresh one lands. Nothing here is guessed or computed: it is the
     server's own last reply, held for a few hours. Every write still goes to the server and
     waits, because a write that lied would be far worse than a slow one — this makes looking
     instant and leaves doing honest.

     The list is explicit. An action not on it is never served from a cache, so anything added
     later is slow-but-correct rather than fast-but-wrong. */
  const CACHEABLE = ['desk', 'fees', 'oncall', 'drops', 'priority', 'martin', 'records', 'ssop',
    'stats', 'team', 'shifts', 'shiftlog', 'supplies', 'threads', 'status', 'sensors',
    'donations', 'tocollect', 'temprecord', 'deeredits', 'hunters'];
  const CACHE_TTL = 6 * 36e5;
  // Some of these are asked per deer, per channel or per day, so the key has to carry that.
  const cacheKey = b => b.action + '|' + [b.band, b.channel, b.date, b.days, b.kind].map(x => x == null ? '' : x).join('|');
  const cacheGet = b => {
    const c = (st.screens || {})[cacheKey(b)];
    return (c && Date.now() - c.at < CACHE_TTL) ? c : null;
  };
  const cachePut = (b, out) => {
    st.screens = st.screens || {};
    st.screens[cacheKey(b)] = { at: Date.now(), d: out };
    // Keep it small: a phone does not need every screen it has ever opened.
    const keys = Object.keys(st.screens);
    if (keys.length > 24) keys.sort((x, y) => st.screens[x].at - st.screens[y].at).slice(0, keys.length - 24)
      .forEach(k => { delete st.screens[k]; });
    try { save(); } catch (e) {}
  };
  /* Compared WITHOUT the timing fields the server stamps on every reply, which differ every time
     by definition. Left in, every refresh would look like changed data, redraw the screen, fetch
     again, and so on — a loop that would hammer the backend from every phone in the building. */
  const sameAnswer = (a, b) => {
    const strip = o => { const c = Object.assign({}, o); delete c.ms; delete c.lockMs; delete c.fromCache; return c; };
    try { return JSON.stringify(strip(a)) === JSON.stringify(strip(b)); } catch (e) { return false; }
  };
  /* And a belt for the braces: one background refresh per screen per twenty seconds, whatever
     else happens. If some field in a payload is genuinely volatile, the worst case is a screen
     that refreshes a little often, not a phone sitting in a fetch loop. */
  const refreshedAt = {};

  async function call(body) {
    /* Served from the last answer, with a refresh started behind it. The screen that asked gets
       its data in the same tick, so it paints at once; when the real answer differs, the screen
       is drawn again — unless a finger is on it, which the quiet-redraw rules already handle. */
    if (body && CACHEABLE.indexOf(body.action) >= 0 && !body.__fresh) {
      const hit = cacheGet(body);
      if (hit) {
        const k = cacheKey(body), asked = current;
        if (!refreshedAt[k] || Date.now() - refreshedAt[k] > 20000) {
          refreshedAt[k] = Date.now();
          call(Object.assign({ __fresh: true }, body))
            .then(fresh => { if (!sameAnswer(fresh, hit.d) && current === asked) redraw(true); })
            .catch(() => { /* the screen is already up; a failed refresh is not worth a message */ });
        }
        return Object.assign({ fromCache: hit.at }, hit.d);
      }
    }
    if (!CFG.BACKEND_URL || /PASTE_/.test(CFG.BACKEND_URL)) { const e = new Error('The app isn\'t connected yet (backend address missing).'); e.fatal = true; throw e; }
    let res;
    /* A time limit, so a request that never comes back becomes a message with a button on it
       rather than a panel that sits on "Loading…" for ever. Sixty seconds is deliberately long:
       the backend waits up to 25 for the document lock before it even starts work, and a write
       that is merely slow must not be given up on. A timed-out write is treated as unreachable,
       not refused — we do not know whether it landed, so it stays in the queue and is sent again,
       where the client ID stops it being written twice. */
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), 60000) : null;
    const t0 = Date.now();
    try {
      res = await fetch(CFG.BACKEND_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ number: st.number, pin: st.pin, device: st.device }, body)),
        redirect: 'follow', signal: ctl ? ctl.signal : undefined });
    } catch (e) {
      const timedOut = ctl && ctl.signal.aborted;
      const err = new Error(timedOut ? 'The server took too long to answer. Nothing is lost — it will be sent again.'
        : navigator.onLine ? 'Couldn\'t reach the server.' : 'No signal.');
      err.offline = true; throw err;
    } finally { if (timer) clearTimeout(timer); }
    let out;
    try { out = await res.json(); } catch (e) { const err = new Error('The server sent back something unexpected (status ' + res.status + ').'); err.fatal = true; throw err; }
    if (!out.ok) { const e = new Error(out.error || 'Something went wrong.'); e.fatal = true; throw e; }
    /* Keep the last slow request, so "it took fifteen seconds" can be answered with where the
       fifteen seconds went instead of a guess. The server reports its own time and how much of
       it was spent queueing behind another request; whatever is left over is the trip there and
       back, which is the phone's signal and Apps Script waking up. */
    const total = Date.now() - t0;
    if (total > 2500) {
      st.slow = { action: body.action || '?', total: total, ms: Number(out.ms) || 0,
        lockMs: Number(out.lockMs) || 0, at: Date.now() };
      try { save(); } catch (e) {}
    }
    if (body && CACHEABLE.indexOf(body.action) >= 0) cachePut(body, out);
    /* Anything that writes throws the lot away. A forfeit, a release, a payment — any of them can
       change a screen somewhere else, and working out which would be a list nobody maintains. A
       write is rare next to a read, so the cost is one honest fetch afterwards; the alternative is
       a counter still showing a deer that has just been handed over. */
    else if (body && body.action && body.action !== 'login' && body.action !== 'home') {
      st.screens = {};
      Object.keys(refreshedAt).forEach(k => { delete refreshedAt[k]; });
      try { save(); } catch (e) {}
    }
    return out;
  }

  /* ---------- outbox: deer actions and log entries wait here until sent ---------- */
  function queue(action, fields, label) {
    st.outbox.push({ clientId: uid(), action, fields, at: stamp(), label, created: Date.now(), by: st.number });
    /* Thrown away the moment the action is queued, not when it finishes sending. Screens are
       redrawn immediately after a tap — openCheckout calls showDesk() on the next line — and the
       send is still in flight at that point, so a cache left standing would repaint the deer that
       was just handed over as still waiting. */
    st.screens = {};
    Object.keys(refreshedAt).forEach(k => { delete refreshedAt[k]; });
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
      /* If the facility has not changed since the last poll there is nothing to repaint, and
         repainting anyway is how a background refresh eats a tap for no gain at all. The outbox
         counts as part of the picture, because a queued action that has just landed changes what
         the screen should say even when the server payload is identical. */
      const sig = sigOf(out) + '|' + st.outbox.length;
      const same = sig === homeSig;
      homeSig = sig;
      st.home = out; st.synced = stamp(); save();
      if (!(quiet && same)) redraw(quiet);
      notifyNewAlerts();
    } catch (e) {
      if (e.fatal && /PIN|switched off/.test(e.message)) { signOut(e.message); return; }
      if (!quiet) toast(e.message);
    }
  }
  /* The hunter roster: name, MassWildlife customer ID, phone and mailing address for everyone the
     log has seen. Fetched rarely and cached, so the counter still gets suggestions with no signal.
     It never fills a field on its own — a wrong ID filled quietly is worse than typing one. */
  async function loadHunters(force) {
    const age = Date.now() - (st.hunters.at || 0);
    if (!force && st.hunters.list.length && age < 6 * 36e5) return st.hunters.list;
    try {
      const out = await call({ action: 'hunters' });
      st.hunters = { at: Date.now(), list: out.hunters || [] };
      save();
    } catch (e) { /* offline or refused: the cache is still better than nothing */ }
    return st.hunters.list;
  }
  function hunterMatches(first, last) {
    const f = String(first || '').trim().toLowerCase(), l = String(last || '').trim().toLowerCase();
    if (f.length + l.length < 2) return [];
    return (st.hunters.list || []).filter(h => {
      const hf = String(h.first || '').toLowerCase(), hl = String(h.last || '').toLowerCase();
      const okL = !l || hl.indexOf(l) === 0, okF = !f || hf.indexOf(f) === 0;
      return okL && okF;
    }).slice(0, 6);
  }
  // '1 Main St, Vineyard Haven, MA 02568' back into the four fields it was built from.
  function splitAddress(a) {
    const m = String(a || '').trim().match(/^(.*),\s*([^,]+),\s*([A-Za-z]{2})\s+([\d-]+)$/);
    return m ? { street: m[1].trim(), town: m[2].trim(), state: m[3].toUpperCase(), zip: m[4] } : null;
  }

  /* ---- redrawing without fighting the person holding the phone ----

     Every 45 seconds the app refetches and rebuilds the screen with innerHTML. That is fine when
     nobody is touching it and awful when somebody is: the node under the finger is replaced
     mid-tap so the tap lands on nothing, and frame() scrolls back to the top, so a processor
     reading down the board gets yanked to the first card. Both read as "the app is laggy" and
     both produce the same response — tap it again, harder (Joe, 7 November).

     So a background redraw now: waits until the screen has been left alone for a few seconds,
     does nothing at all if the data came back the same, and keeps the scroll position. A redraw
     the person asked for by tapping something is unaffected. */
  let lastTouch = 0, pointerDown = false, homeSig = '', redrawing = false;
  // Cheap, order-independent enough for "did anything change?", and far cheaper than diffing.
  const sigOf = o => { const s = JSON.stringify(o) || ''; let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return s.length + ':' + h; };
  /* The window that matters is tiny: a finger that is DOWN, plus the moment between lifting it
     and the click being dispatched. That is when replacing the DOM throws the tap away. Holding
     off for seconds afterwards would be a different bug — the screen would sit on stale figures
     right after the action that changed them. */
  ['pointerdown', 'touchstart', 'mousedown'].forEach(ev =>
    document.addEventListener(ev, () => { pointerDown = true; lastTouch = Date.now(); }, true));
  ['pointerup', 'touchend', 'touchcancel', 'mouseup', 'pointercancel', 'click', 'keydown'].forEach(ev =>
    document.addEventListener(ev, () => { pointerDown = false; lastTouch = Date.now(); }, true));
  const QUIET_MS = 350;

  let deferred = null;
  function redraw(quiet) {
    /* A quiet redraw yields to the person using the screen — but it comes back, rather than
       dropping the update on the floor and leaving stale figures up until the next poll. */
    if (quiet && (pointerDown || Date.now() - lastTouch < QUIET_MS)) {
      if (!deferred) deferred = setTimeout(() => { deferred = null; redraw(true); }, QUIET_MS);
      return;
    }
    if (deferred) { clearTimeout(deferred); deferred = null; }
    redrawing = !!quiet;
    try {
      if (current === 'home') showHome();
      else if (current === 'board' && !document.querySelector('.form input, .form select') && !boardQuery) showBoard();
      else if (current === 'donate' && !document.querySelector('.form input, .form select, #lic2:focus')) showDonate();
      else if (current === 'deer' && shownBand && !document.querySelector('.form input, .form select')) showDeer(shownBand);
      /* The fetched screens redraw themselves by being opened again, which is what happens when
         the real answer arrives behind the cached one. Never while something is half typed. */
      else if (GO[current] && !document.querySelector('input:focus, select:focus, textarea:focus')) GO[current]();
    } finally { redrawing = false; }
  }
  // Exposed so the tests can fire the 45-second poll's redraw without waiting 45 seconds for it.
  window.__hgRedraw = redraw;
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
        ' <button class="plain" data-drop="' + esc(i.clientId) + '">Remove it</button></div>').join('') +
      /* Shown only after something was actually slow, and only for a few minutes. It is for
         telling somebody what happened, not decoration. */
      (st.slow && Date.now() - st.slow.at < 300000
        ? '<div class="note warn" style="margin-top:6px;font-size:13px">Last slow screen: <b>' + esc(st.slow.action) + '</b> took ' +
          (st.slow.total / 1000).toFixed(1) + 's · server ' + (st.slow.ms / 1000).toFixed(1) + 's' +
          (st.slow.lockMs > 300 ? ' (waiting on another request ' + (st.slow.lockMs / 1000).toFixed(1) + 's)' : '') +
          ' · connection ' + (Math.max(0, st.slow.total - st.slow.ms) / 1000).toFixed(1) + 's</div>'
        : '');
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
      if (['preop', 'opssop', 'corrective', 'log', 'reject'].indexOf(x.action) >= 0) return;
      if (!b) return;
      const d = by(b);
      if (x.action === 'intake' && !d) list.push({ Band: b, Intake: x.at, 'Hunter number': f.hunterNumber, 'Hunter name': f.hunterName || ((f.firstName || '') + ' ' + (f.lastName || '')).trim(), 'MassWildlife confirmation': f.confirmation, Deer: f.deer, Type: f.type, 'Intake weight (lb)': f.intakeWeight, 'Weighed as': f.weighedAs, 'Pork fat added': f.porkFat ? 'Yes' : (f.type === 'Donated' ? 'Yes' : 'No'),
        // Carried so a check-in made with no signal still shouts about the rack on the card the
        // skinner is about to read — that is the whole point of asking at the door.
        'Skull kept': f.skull === true ? 'Yes' : f.skull === false ? 'No' : '',
        Status: 'Hanging', pending: true });
      if (!d) return;
      d.pending = true;
      if (x.action === 'move') { d.Location = f.to; }
      if (x.action === 'skin') { d['Skinner'] = f.skinner || st.staff.number; d['Skinner name'] = f.skinnerName || st.staff.name; d['Skinned at'] = x.at; d['Skinned at station'] = 'Yes'; }
      if (x.action === 'start') {
        if (f.skinned && !d['Skinner']) { d['Skinner'] = f.skinner || f.processor || st.staff.number; d['Skinner name'] = f.processorName || st.staff.name; d['Skinned at'] = x.at; }
        d.Status = 'Processing'; d['Processing started'] = x.at; d['Processor number'] = f.processor || st.staff.number; d.Butcher = f.processorName || st.staff.name; d['Carcass weight (lb)'] = f.weight; }
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
      '<div class="sub">Home Ground Facility ' + esc(APP_VERSION) + ' · <button class="plain" id="out" style="padding:0">Sign out</button></div></div></header>' +
      (noBack ? '' : '<button class="plain" id="home-btn">← Home</button>') +
      (title ? '<h1>' + title + '</h1>' : '') +
      (st.staff && st.staff.demo ? '<div class="note warn"><b>Demo sign-in.</b> Practice data: nothing here goes into the real Facility Log.</div>' : '') +
      '<div id="sync" class="status"></div><div id="msg"></div>' + body;
    document.getElementById('out').onclick = () => signOut();
    const hb = document.getElementById('home-btn');
    if (hb) hb.onclick = () => showHome();
    status();
    /* Jump to the top when the person navigated here, and never when the 45-second poll is
       repainting the screen they are already reading. Being thrown back to the first card while
       working down the board is one of the things that made the app feel like it was fighting
       back (Joe, 7 November). */
    if (redrawing) { const y = window.scrollY; requestAnimationFrame(() => window.scrollTo(0, y)); }
    else window.scrollTo(0, 0);
  }
  // The cached front desk goes too: on a shared iPad the next person must not open to the last
  // person's counter, however briefly, and the manager-only controls are drawn from it.
  function signOut(msg) { st.pin = ''; st.staff = null; st.home = {}; st.deskCache = null; st.screens = {}; st.slow = null; save(); showLogin(msg); }

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
  /* A finish time for a one-tap clock-in: the end of today's booking, otherwise four hours from now.
     The lone-worker watchdog needs one, but asking for it on every clock-in was the friction that
     made people skip the clock (Joe, 7 November). It is shown on the clock card and can be changed. */
  function finishGuess() {
    const now = nowMin(), b = st.home && st.home.bookedEnd;
    const bm = /^\d{1,2}:\d{2}$/.test(String(b || '')) ? Number(String(b).split(':')[0]) * 60 + Number(String(b).split(':')[1]) : 0;
    return fromHM(bm > now + 15 ? bm : Math.min(23 * 60 + 45, now + 240));
  }
  // Clock in with no questions. Used by the clock card and by the nudge on Skin it / Start processing.
  async function clockInNow() {
    const out = await call({ action: 'clock', dir: 'in', expected: finishGuess() });
    st.home.clockedIn = out.clockedIn; st.home.week = out.week;
    st.home.expectedOut = out.expectedOut || ''; st.home.clockKind = out.kind || '';
    if (out.onSite) st.home.onSite = out.onSite;
    save();
    return out;
  }
  function coolerCount() { return deerList().filter(d => d.Status === 'Hanging' || d.Status === 'Processing').length; }

  /* ---------- home: what needs doing, then the day, then everything else ----------
   * The three commonest actions (start, finish, release) live on the Cooler board, so a home
   * screen that only lists buttons puts the work two screens down. This one leads with the one
   * thing to do now — and when a deer is on your table, with that deer and its button.
   */
  function leadDeer() {
    const list = deerList();
    const mine = list.find(d => d.Status === 'Processing' && d['Processor number'] === st.staff.number);
    if (mine) return { d: mine, kind: 'mine' };
    const hanging = list.filter(d => d.Status === 'Hanging')
      .sort((a, b) => (a.Type === 'Donated' ? 0 : 1) - (b.Type === 'Donated' ? 0 : 1) || hoursHung(b) - hoursHung(a));
    const next = hanging.find(d => urgency(d).i >= 2);        // High, Urgent or Overdue
    return next ? { d: next, kind: 'next' } : null;
  }
  function leadCard(lead) {
    const d = lead.d, u = urgency(d), s = S();
    const donatedNoPack = d.Type === 'Donated' && !d['First pack #'];
    const act = lead.kind === 'mine'
      ? (donatedNoPack ? '<button class="btn alt" data-la="grind">Get package numbers</button> ' : '') +
        '<button class="btn" data-la="finish">Finished</button>'
      : '<button class="btn" data-la="start">Start processing</button>';
    return '<div class="lead' + (lead.kind === 'mine' ? ' on' : '') + '" data-band="' + esc(d.Band) + '">' +
      '<div class="lh">' + (lead.kind === 'mine' ? 'On your table' : 'Start this one next') + '</div>' +
      '<div class="lb">' + esc(d.Band) + ' <span class="tag ' + (d.Type === 'Donated' ? 'don">DONATED' : 'prv">PRIVATE') + '</span>' +
      (lead.kind === 'next' ? '<span class="pill" style="background:' + u.colour + ';color:#fff;font-weight:700">' + u.level.toUpperCase() + '</span>' : '') + '</div>' +
      '<div class="ls">' + esc(d.Deer || 'Deer') + ' · ' + Math.floor(hoursHung(d)) + ' hours hung' +
      (lead.kind === 'mine'
        ? (d['Processing started'] ? ' · started ' + esc(when(d['Processing started'])) : '') +
          (d['Intake weight (lb)'] ? ' · ' + esc(d['Intake weight (lb)']) + ' lb in' + (d['Weighed as'] === 'Not dressed' ? ' (not dressed)' : '') : '') +
        (d['Carcass weight (lb)'] ? ' · ' + esc(d['Carcass weight (lb)']) + ' lb carcass' : '') +
          (d['First pack #'] ? ' · packages from ' + esc(d['First pack #']) : '')
        : ' · in ' + esc(when(d.Intake))) + '</div>' +
      (lead.kind === 'mine' && donatedNoPack ? '<div class="note bad" style="margin:8px 0 0">Get package numbers before the grinder, so every label runs in order.</div>' : '') +
      '<div class="actions">' + act + '</div><div class="form"></div></div>';
  }

  let homeNote = null;   // a confirmation stays on Home for 20 seconds, through background refreshes
  function showHome(note) {
    if (note) homeNote = { text: note, until: Date.now() + 20000 };
    else if (homeNote && Date.now() < homeNote.until) note = homeNote.text;
    const h = st.home, s = S(), m = h.mine || {}, inC = coolerCount();
    const next = (h.myShifts || [])[0];
    const here = (h.onSite || []).filter(x => x.number !== st.staff.number);
    const alone = !!h.clockedIn && !here.length;
    const preop = h.preopToday || {};
    const held = (preop.held || []).length;
    const processing = deerList().some(d => d.Status === 'Processing');

    if (isViewer()) {
      frame('home', '', '<div class="note ok">View-only sign-in: you can look at everything below, but nothing can be changed from this sign-in.</div>' +
        group('Check on things') +
        big('board', 'Deer Board', inC + ' of ' + s.coolerCap + ' in the cooler' + (inC >= s.coolerCap ? ' · FULL' : ''), 'view') +
        big('status', 'Facility status', 'Cooler, oldest deer, temperatures, who\'s here', 'view') +
        big('records', 'Sanitation records', 'Pre-op, operational and corrective actions signed today', 'view') +
        group('Office') +
        big('martin', 'Donation report', 'Donated deer for Martin\'s sheet', 'alt'), true);
      $app.querySelectorAll('[data-go]').forEach(b => b.onclick = () => GO[b.dataset.go]());
      return;
    }

    const lead = h.clockedIn ? leadDeer() : null;
    const clockStrip = h.clockedIn
      ? '<div class="card strip"><div class="deer"><div><b>Clocked in' + (isMgr() ? ' · ' + ((h.clockKind || 'Other') === 'Other' ? 'management' : 'skinning/processing') : '') + '</b>' +
        '<div class="status">Since ' + esc(when(h.clockedIn)) + (h.expectedOut ? ' · finishing by ' + t12(h.expectedOut) : '') +
        (next ? ' · next booking ' + esc(dayName(next.date).split(',')[0]) + ' ' + t12(next.starts) : '') + '</div>' +
        (here.length ? '<div class="status">Also here: ' + esc(here.map(x => x.name).join(', ')) + '</div>' : '') +
        '</div><button class="btn alt" id="clock">Clock out</button></div>' +
        (alone ? '<div class="note warn"><b>You are the only one clocked in.</b> Keep your phone on you.</div>' : '') +
        (h.expectedOut ? '<div class="status">You get a nudge ' + esc(s.loneGrace || 30) + ' minutes after ' + t12(h.expectedOut) +
          ' if you have not clocked out, and the managers hear at ' + esc(s.mgrGrace || 60) + ' minutes.</div>' : '') +
        /* What you are doing right now, and a tap to change it — managers only (Joe, 7 November).
           A processor's pay is the deer: $125 a deer processed and $25 a deer skinned, read off
           the board, so a processor just clocks in and out. A manager's day is two jobs paid two
           ways — management by the hour, skinning and processing by the deer — so a manager says
           which one the hours belong to. */
        (isMgr() ? '<div class="kindsw"><span class="status">Right now:</span>' +
          [['Other', 'Management'], ['Processing', 'Skinning/Processing']].map(k =>
            '<button type="button" data-kind="' + k[0] + '"' +
            (((h.clockKind || 'Other') === k[0] || (k[0] === 'Processing' && h.clockKind === 'Skinning')) ? ' class="on"' : '') + '>' + esc(k[1]) + '</button>').join('') +
          '</div>' : '') +
        '<button class="plain" id="still">Still here: change my finish time</button>' +
        '<button class="plain" id="fixclock">Correct a clock-out time</button><div id="clock-err" class="err"></div></div>'
      : '<div class="card"><div class="deer"><div><b>Not clocked in</b>' +
        '<div class="status">Clock in when you start work, including cleaning and training time.</div>' +
        (next ? '<div class="status">Next booking: ' + esc(dayName(next.date)) + ', ' + t12(next.starts) + '–' + t12(next.ends) + (next.kind === 'Skinning' ? ' (skinning)' : '') + '</div>' : '') +
        '</div><button class="btn" id="clock">Clock in</button></div>' +
        '<button class="plain" id="fixclock">Correct a clock-out time</button><div id="clock-err" class="err"></div></div>';

    const mine = '<button class="seasonline" data-go="numbers"><span>Your season: <b>' + esc(m.deer || 0) + '</b> deer · <b>' +
      esc(m.skinned || 0) + '</b> skinned · <b>' + esc(fmt(m.packagedLb || 0)) + '</b> lb</span><span class="ch">›</span></button>';

    // Pre-op is a gate, so it says what to do. It only turns red once a deer is on the table without it.
    const preopCls = held ? 'red' : preop.done ? 'view' : processing ? 'red' : '';
    /* The close-out reads like the pre-op record: a tick when it is signed, the time and initials
       underneath, and red with the lines named when something was left. Without this nobody can
       tell from the home screen whether the place was closed out, which was the point of having
       the record at all. `big()` escapes the subtitle, so it is plain text here. */
    const closeout = h.closeoutToday || {};
    const closeoutLeft = (closeout.notDone || []).length;
    const closeoutSub = closeout.done
      ? (closeoutLeft
          ? closeoutLeft + ' not done: ' + (closeout.notDone || []).join(', ')
          : 'Closed out ' + (closeout.time || '') + ' by ' + (closeout.initials || ''))
      : 'Waste out, drains clear. The last thing before you lock up';
    const closeoutCls = closeoutLeft ? 'red' : closeout.done ? 'view' : '';
    // Unsigned pre-op moves to the top of Now and out of Today, so it is never below the work it
    // has to come before. A held line is a different problem and stays where it is, in red.
    const preopFirst = !preop.done && !held;
    const preopSub = preop.done
      ? (held ? held + ' line' + (held === 1 ? '' : 's') + ' still not released — do not use it' : 'Signed ' + esc(preop.time || '') + ' by ' + esc(preop.initials || ''))
      : processing ? 'A deer is on the table — sign this now'
      : 'Start here — sign it before the first deer. Sixteen lines, A or U';

    /* ---- the home screen, in the order the day actually runs ----

       One screen used to serve everybody, so it carried every tile in a fixed order, and the
       result was both duplicated and wrong for most people: "Check in a deer" sat on Home AND
       inside the Front desk, and a processor who never touches the counter opened to it every
       morning (Joe, 6 November).

       Now the sequence is the same for everyone — clock in, start of shift, the work, as it
       happens, the office — and only the ORDER of the two work tiles changes with the role,
       because the first thing on the screen should be the thing that person is about to do.
       Checking a deer in lives at the Front desk and nowhere else: one door for the counter,
       one for the floor. */

    const doorFirst = atDoor() && !isMgr();      // Intake: the counter IS the job
    const boardTile = big('board', 'Deer Board',
      (preop.done ? '' : 'After pre-op · ') + inC + ' of ' + s.coolerCap + ' in the cooler' +
      (inC >= s.coolerCap ? ' · FULL' : '') + ' · skin, start, package, finish');
    /* The door is one job even though it is four actions, so it gets one tile and holds all four.
       Whoever is covering the counter should not have to work out which of four screens the hunter
       standing in front of them belongs to. */
    const deskTile = big('desk', 'Front desk',
      'Deer in, deer out, drop-offs and money — everything at the counter' +
      (h.storage && h.storage.hanging ? ' · ' + h.storage.hanging + ' to collect' : '') +
      (bandColour(new Date()) ? ' · today’s band: ' + bandColour(new Date()) : ''), 'alt');

    const more =
      group('Booking') +
      big('shifts', 'Book your time', 'Processing · up to ' + s.maxAtOnce + ' at once') +
      big('skinning', 'Book skinning time', 'Skinned in MHU #1' + (h.skinRoom ? ' · hanging space for ' + h.skinRoom.room + ' more' : ''), 'alt') +
      big('oncall', 'On call', (h.drops && h.drops.onCall ? first(h.drops.onCall.name) + ' today' : 'Nobody on call today') + ' · who covers an unclaimed drop-off', (h.drops && h.drops.onCall) ? 'view' : 'red') +
      group('Numbers and records') +
      big('status', 'Facility status', 'Temperatures, who\'s here, the oldest deer', 'view') +
      big('records', 'Today\'s records', 'Read back what has been signed today', 'view') +
      big('numbers', 'My numbers', 'Deer, pounds, hours and pay this week', 'view') +
      (isMgr() ? big('team', 'Team numbers', 'Every processor, this week and the season', 'view') : '') +
      (isMgr() ? big('sensors', 'Sensors', 'Cold storage and both MHUs · live temperatures and the record', 'view') : '') +
      big('fees', 'Cold storage', 'Hang-only deer · what is owed, what is past collection', 'alt') +
      (isMgr() ? big('speed', 'Speed test', 'Where the waiting actually goes — run it if a screen feels slow', 'view') : '');

    const isIntake = /intake/i.test((st.staff && st.staff.role) || '');
    const office = (isMgr() || isIntake)
      ? group('Managers') +
        big('martin', 'Donation report', 'Rows for Martin’s sheet', 'alt') +
        big('daily', 'Log book', 'Sanitizer, thermometer, complaints, tight tank, cash')
      : '';

    /* "Tell someone" — the three tiles whose job is to reach another person, behind one tap so the
       work above them is not buried. The count rides on the header, because a group that hides an
       unread message is worse than no group. Need help is deliberately NOT in here: it is the
       injury and food-safety-stop button and it stays one tap away, in the open. */
    const tellBadge = (h.unread ? ' (' + h.unread + ' new)' : '') +
      (h.openSupplies ? ' · ' + h.openSupplies + ' to order' : '');
    const tell =
      '<button class="morebtn" id="tellbtn"><span id="tellarrow">' + (st.tellOpen ? '▾' : '▸') + '</span> Tell someone' + tellBadge + '</button>' +
      '<div id="tellbox"' + (st.tellOpen ? '' : ' hidden') + '>' +
      big('supplies', 'Running low on something?', h.openSupplies
        ? h.openSupplies + (h.openSupplies === 1 ? ' thing waiting' : ' things waiting') + ' · tell the managers what we need'
        : 'Bags, gloves, sanitizer — two taps and the managers know', h.openSupplies ? 'red' : 'alt') +
      big('messages', 'Messages' + (h.unread ? ' (' + h.unread + ' new)' : ''), 'Team chat and direct messages') +
      /* Everybody, not just managers: the person who finds the problem is usually at the bench,
         and the operational sanitation screen sends them straight here. */
      big('corrective', 'Corrective action', 'Write up a problem and what you did about it', 'alt') +
      '</div>';

    frame('home', '',
      (note ? '<div class="note ok">' + note + '</div>' : '') +
      '<div id="alerts">' + alertsHtml() + dropCardsHtml() + '</div><div id="push"></div>' +
      (lead ? leadCard(lead) : '') + clockStrip + mine +

      // Pre-op is a gate: until it is signed it IS the start of the day, and it sits above the
      // work it has to come before. Once signed it drops into the day's run, ticked.
      (preopFirst ? group('Start of shift') + big('preop', 'Pre-op sanitation', preopSub, preopCls) : '') +

      group('The work') +
      (doorFirst ? deskTile + boardTile : boardTile + deskTile) +
      big('scan', 'Scan a band', 'Taking a deer out of the cooler — opens the move, or the collection') +

      group('As it happens') +
      (preopFirst ? '' : big('preop', 'Pre-op sanitation' + (preop.done && !held ? ' ✓' : ''), preopSub, preopCls)) +
      big('opssop', 'Operational sanitation', 'Every line C, N or N/A. At least once a day') +
      big('closeout', 'End-of-shift close-out' + (closeout.done && !closeoutLeft ? ' \u2713' : ''), closeoutSub, closeoutCls) +
      big('help', 'Need help', 'Sends a notification to everyone on the team', 'red') +

      tell +
      office +
      '<button class="morebtn" id="morebtn"><span id="morearrow">' + (st.moreOpen ? '▾' : '▸') + '</span> Everything else</button>' +
      '<div id="morebox"' + (st.moreOpen ? '' : ' hidden') + '>' + more + '</div>', true);

    $app.querySelectorAll('[data-go]').forEach(b => b.onclick = () => GO[b.dataset.go]());
    wireDrops(document.getElementById('alerts'));
    const tb = document.getElementById('tellbtn');
    if (tb) tb.onclick = () => { st.tellOpen = !st.tellOpen; save();
      document.getElementById('tellbox').hidden = !st.tellOpen;
      document.getElementById('tellarrow').textContent = st.tellOpen ? '▾' : '▸'; };
    const mb = document.getElementById('morebtn');
    mb.onclick = () => { st.moreOpen = !st.moreOpen; save();
      document.getElementById('morebox').hidden = !st.moreOpen;
      document.getElementById('morearrow').textContent = st.moreOpen ? '▾' : '▸'; };

    if (lead) {
      const card = $app.querySelector('.lead'), box = card.querySelector('.form');
      card.querySelectorAll('[data-la]').forEach(b => b.onclick = () => act(b.dataset.la, lead.d, box, showHome));
    }

    const clockErr = msg => { const e = document.getElementById('clock-err'); if (e) e.innerHTML = msg; };
    const sendClock = async (b, body) => {
      if (b) b.disabled = true;
      try {
        const out = await call(body);
        st.home.clockedIn = out.clockedIn; st.home.week = out.week;
        st.home.expectedOut = out.expectedOut || ''; st.home.clockKind = out.kind || '';
        if (out.onSite) st.home.onSite = out.onSite;
        save(); showHome();
      } catch (x) {
        if (b) b.disabled = false;
        clockErr(esc(x.offline ? 'Clocking in or out needs signal. Tell Joe the time if you can\'t get signal.' : x.message));
      }
    };
    // A finish time is asked for on every clock-in: it is the only thing that lets anyone know to check on you.
    const askFinish = (title, hint, go) => {
      const guess = (next && next.ends) || h.bookedEnd || fromHM(Math.min(21 * 60, nowMin() + 240));
      clockErr('<div class="card" style="margin:10px 0 0;text-align:left"><label for="eo">' + esc(title) + '</label>' +
        '<input id="eo" type="time" value="' + esc(hm2(guess)) + '">' +
        '<p class="status">' + esc(hint) + '</p><div id="eoerr" class="err"></div>' +
        '<button class="btn" id="eook">Save</button> <button class="btn ghost" id="eox">Cancel</button></div>');
      document.getElementById('eox').onclick = () => showHome();
      document.getElementById('eook').onclick = () => {
        const t = document.getElementById('eo').value;
        if (!/^\d{1,2}:\d{2}$/.test(t)) { document.getElementById('eoerr').textContent = 'Give the time you expect to finish.'; return; }
        go(t, document.getElementById('eook'));
      };
    };
    document.getElementById('clock').onclick = e => {
      const b = e.target;
      if (h.clockedIn) return sendClock(b, { action: 'clock', dir: 'out' });
      // One tap. The finish time is filled in and shown on the card, with "change my finish time" under it.
      sendClock(b, { action: 'clock', dir: 'in', expected: finishGuess() });
    };
    const still = document.getElementById('still');
    /* Forgetting to clock out is the normal failure, not the rare one, and the honest fix is to
       let people say when they actually left. It is pay data, so nothing is silent: the row keeps
       what the clock recorded, and the managers get told about every correction. */
    $app.querySelectorAll('[data-kind]').forEach(b => b.onclick = async () => {
      if (b.classList.contains('on')) return;
      $app.querySelectorAll('[data-kind]').forEach(x => { x.disabled = true; });
      try {
        const out = await call({ action: 'switchkind', kind: b.dataset.kind });
        st.home.clockKind = out.kind; st.home.clockedIn = out.clockedIn; st.home.week = out.week; save();
        showHome(out.unchanged ? '' : 'Now on ' + (out.kind === 'Other' ? 'management' : 'skinning/processing') + ' time.');
      } catch (e) {
        $app.querySelectorAll('[data-kind]').forEach(x => { x.disabled = false; });
        clockErr('<div class="err">' + esc(e.offline ? 'Needs signal to switch.' : e.message) + '</div>');
      }
    });
    const fixc = document.getElementById('fixclock');
    if (fixc) fixc.onclick = async () => {
      fixc.disabled = true;
      let shifts = [];
      try { shifts = (await call({ action: 'shiftlog', days: 14 })).shifts || []; }
      catch (e) { fixc.disabled = false; return clockErr('<div class="err">' + esc(e.offline ? 'Needs signal.' : e.message) + '</div>'); }
      fixc.disabled = false;
      const done = shifts.filter(x => x.clockOut);
      if (!done.length) return clockErr('<div class="status">No finished shifts in the last fortnight to correct.</div>');
      clockErr('<div class="card" style="margin:10px 0 0;text-align:left"><label for="cs">Which shift</label><select id="cs">' +
        done.map((x, i) => '<option value="' + i + '">' + esc(x.clockIn) + ' – ' + esc(hhmm(x.clockOut)) +
          ' (' + esc(x.hours || '0') + ' h)' + (x.autoClosed ? ' — closed automatically' : '') +
          (x.corrected ? ' — already corrected' : '') + '</option>').join('') + '</select>' +
        '<label for="co">What time did you actually leave?</label><input id="co" type="time">' +
        '<label for="cwhy">Why <span class="hint">goes on the record beside the change</span></label><input id="cwhy" type="text" placeholder="Forgot to clock out, left after the last deer">' +
        '<p class="status">The time the clock recorded is kept alongside this, and the managers are told.</p>' +
        '<div id="coerr" class="err"></div><button class="btn" id="cook">Save the correction</button> <button class="btn ghost" id="cox">Cancel</button></div>');
      document.getElementById('cox').onclick = () => showHome();
      document.getElementById('cook').onclick = async () => {
        const pick = done[+document.getElementById('cs').value], t = document.getElementById('co').value;
        const why = (document.getElementById('cwhy').value || '').trim();
        const e2 = m => { document.getElementById('coerr').textContent = m; };
        if (!/^\d{1,2}:\d{2}$/.test(t)) return e2('Give the time you actually left.');
        if (!why) return e2('Say why it is being changed. The reason is the record.');
        const b2 = document.getElementById('cook'); b2.disabled = true;
        try {
          const out = await call({ action: 'correctclock', clockIn: pick.clockIn, out: t, reason: why });
          showHome('Clock-out changed to ' + t12(hhmm(out.clockOut)) + ' — ' + out.hours + ' h.');
        } catch (x) { b2.disabled = false; e2(x.offline ? 'Needs signal.' : x.message); }
      };
    };
    if (still) still.onclick = () => askFinish('New finish time', 'Clears the overdue alert and starts the clock again from the new time.',
      async (t, bb) => {
        bb.disabled = true;
        try { const out = await call({ action: 'extend', expected: t }); st.home.expectedOut = out.expectedOut; save(); showHome('Finish time changed to ' + t12(out.expectedOut) + '.'); }
        catch (x) { bb.disabled = false; document.getElementById('eoerr').textContent = x.offline ? 'Needs signal.' : x.message; }
      });
    wireAlerts();
    renderPush();
  }
  const tile = (n, label) => '<div class="tile"><div class="n">' + esc(n) + '</div><div class="l">' + esc(label) + '</div></div>';
  const group = t => '<div class="grp">' + esc(t) + '</div>';
  (() => { const c = document.createElement('style');
    c.textContent = '.kindsw{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:8px 0 2px}' +
      '.kindsw>span{margin-right:2px}' +
      '.kindsw button{font:inherit;font-size:14px;padding:7px 13px;border-radius:99px;border:1px solid var(--line);' +
      'background:var(--card,transparent);color:var(--ink,inherit);cursor:pointer}' +
      '.kindsw button.on{background:var(--green-dark);color:#fff;border-color:var(--green-dark);font-weight:700}' +
      '.kindsw button:disabled{opacity:.5}' +
      '.grp{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:20px 2px 4px}' +
      /* Buttons inside a card need room of their own. Without this they butt straight up against
         the text above and below them, which on a phone reads as one covering the other. */
      '.deskrow{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}' +
      '.deskrow .btn{flex:1 1 180px;text-align:center}' +
      // Loud on purpose: it is the one thing on a card that cannot be put right afterwards.
      '.tag.skull{background:#8A4B08;color:#fff}' +
      /* ---- making a tap feel like a tap (Joe, 7 November) ----
         "pressing on a button does not lead to instantaneous results. a lot of times we are
         clicking the same tab repeatedly thinking it didn't click on the first try."

         Two causes, both here. Nothing on this app had a pressed state, so between the finger
         landing and the next screen painting there was no evidence at all that the tap had
         registered — and the next screen often waits on Apps Script, which is not fast. And
         without touch-action the browser holds every tap back a fraction of a second in case it
         turns into a double-tap zoom, which on a cold bench reads as the app ignoring you.

         The pressed state costs one frame and is the single biggest change here. */
      'button,.big,.btn,.trow[data-out],.trow[data-pay],.seasonline,.morebtn{touch-action:manipulation;-webkit-tap-highlight-color:transparent}' +
      '.big:active,.btn:active,.submit:active,.tabs button:active,.morebtn:active{transform:scale(.985);filter:brightness(.88)}' +
      '.plain:active,.seasonline:active{opacity:.55}' +
      '.trow[data-out]:active,.trow[data-pay]:active{background:var(--ok-bg,#EEF0E0)}' +
      '.big,.btn,.submit,.plain,.morebtn,.seasonline{transition:transform .06s ease,filter .06s ease,opacity .06s ease}' +
      '.big.view{background:var(--card);color:var(--green-dark);border:2px solid var(--green)}.big.view small{opacity:.8}' +
      // the lead card: the one thing to do now, with its own button, so the commonest action is one tap
      '.lead{background:#fff;border:3px solid var(--green);border-radius:16px;padding:14px 16px 16px;margin:12px 0}' +
      '.lead.on{border-color:var(--brown)}' +
      '.lead .lh{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}' +
      '.lead .lb{font-size:26px;font-weight:800;line-height:1.15;margin:2px 0 2px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}' +
      '.lead .ls{font-size:15px;color:var(--muted);line-height:1.35}' +
      '.lead .actions button{margin-top:12px;width:100%;padding:16px;font-size:18px}' +
      '.lead .actions button+button{margin-top:8px}' +
      '.card.strip{padding:12px 14px}' +
      // the season line: a piece-rate worker should see their count, but not above the work
      '.seasonline{display:flex;align-items:center;width:100%;text-align:left;background:none;border:0;' +
      'padding:10px 2px;margin:2px 0 0;font:inherit;font-size:15px;color:var(--muted);cursor:pointer}' +
      '.seasonline b{color:var(--green-dark);font-size:17px}' +
      '.seasonline .ch{margin-left:auto;font-size:20px;color:var(--line)}' +
      // everything else: one tap down, not a second screen
      '.morebtn{display:block;width:100%;text-align:left;background:none;border:0;border-top:1px solid var(--line);' +
      'margin:22px 0 0;padding:16px 2px;font:inherit;font-size:16px;font-weight:700;color:var(--green-dark);cursor:pointer}' +
      '.morebtn span{display:inline-block;width:18px;color:var(--muted)}';
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
  const RANK = { 'Donated': 1, 'Private': 2, 'Cold storage': 3 };
  const rankOf = d => RANK[d && d.Type] || 9;
  const rankName = r => ({ 1: 'donated', 2: 'custom processing', 3: 'cold storage' })[r] || 'other';
  // Within 24 hours of the maximum hold, rank stops mattering: this one is next either way.
  const urgentDeer = d => d.Type !== 'Cold storage' && hoursHung(d) >= (S().maxHold || 120) - 24;
  /* An unpaid custom-processing deer sits half a rank down, behind every private deer that has
     settled. Joe, 6 November: the longer they wait to pay, the longer it takes to process. No
     penalty and no surcharge — the hunters who have paid simply go first. */
  const unpaidDeer = d => { const o = owedOn(d); return !!(o && !o.settled); };
  const orderOf = d => urgentDeer(d) ? 0 : rankOf(d) + (unpaidDeer(d) ? 0.5 : 0);
  const sortKey = d => orderOf(d) * 1e6 - hoursHung(d);
  /* Deer of a higher priority than this one that are still waiting. Computed here rather than
     asked of the server, because the warning has to land before the action is queued \u2014 a
     queued start that bounces off the server tells the processor nothing until much later. */
  function aheadOf(d, all) {
    if (!d || d.Type === 'Cold storage' || urgentDeer(d)) return [];
    /* Two reasons a deer is ahead of this one, and an early version of this got the first
       backwards: a carcass near the maximum hold goes first WHATEVER its rank \u2014 being urgent
       makes it more entitled, not less \u2014 and a higher-rank deer goes first among the rest. */
    return (all || []).filter(x => x.Status === 'Hanging' && x.Band !== d.Band &&
      x.Type !== 'Cold storage' && (urgentDeer(x) || orderOf(x) < orderOf(d)))
      .sort((a, b) => sortKey(a) - sortKey(b));
  }

  const undoName = step => ({ skin: 'skinning', start: 'start processing', grind: 'package numbers',
    finish: 'finished', release: 'release' })[step] || step;

  /* Undo asks for a reason before it does anything, and says plainly what it is about to reverse.
     The heavy ones (finish, release) say what will NOT be reversed too \u2014 a release that took
     $300 does not hand the money back, and somebody has to know that before they tap it. */
  function askUndo(d, box, after) {
    const u = d.undo;
    if (!u || !u.step) return;
    if (!u.allowed) { toast(u.why, false); return; }
    const host = box;
    if (!host) return;
    host.innerHTML = '<div class="card"><b>Undo: ' + esc(undoName(u.step)) + '</b>' +
      '<div class="status">' + esc(u.label) + '</div>' +
      '<div class="note' + (u.heavy ? ' warn' : '') + '">This ' + esc(u.undoes) + '.' +
      (u.step === 'release' ? ' <b>It does not refund anything that was paid.</b>' : '') +
      (u.step === 'finish' ? ' <b>The first package number is kept</b>, so labels already written still match.' : '') +
      '</div>' +
      '<label for="uwhy">Why <span class="hint">goes on the deer and in the log</span></label>' +
      '<input id="uwhy" type="text" autocomplete="off" placeholder="Tapped the wrong deer">' +
      '<div class="err" id="uerr"></div>' +
      '<button class="submit" id="uok">Undo it</button> <button class="btn ghost" id="ux">Keep it as it is</button></div>';
    document.getElementById('ux').onclick = () => { host.innerHTML = ''; };
    document.getElementById('uok').onclick = async () => {
      const why = document.getElementById('uwhy').value.trim();
      if (!why) { document.getElementById('uerr').textContent = 'Say why. An undo with no reason is a hole in the record.'; return; }
      const b = document.getElementById('uok'); b.disabled = true; b.textContent = 'Undoing\u2026';
      try {
        const out = await call({ action: 'undo', fields: { band: d.Band, step: u.step, reason: why } });
        host.innerHTML = '';
        toast((out && out.note) || 'Undone.', true);
        if (after) after(); else showBoard();
        refresh(true);
      } catch (e) {
        b.disabled = false; b.textContent = 'Undo it';
        document.getElementById('uerr').textContent = e.offline ? 'Needs signal to undo.' : e.message;
      }
    };
  }

  /* Where a deer physically is. Until 7 November the board had one "Hanging" list, which lumped
     the receiving cooler in with both MHUs, and it ran in priority order rather than by place
     (Joe). Location is now a field set by "Move to"; a deer that has never been moved falls
     back to what has been done to it: skin-on in the cooler, skinned in MHU-1, on the table in
     MHU-2. Cold storage never leaves the cooler. */
  /* In the order hanging space actually fills (Joe, 7 November). Skin-on carcasses wait in the
     receiving cooler container. One is pulled, skinned in the front section of MHU-1, rinsed with
     hot water and sprayed with carcass wash, then hung in the COOLER PORTION OF MHU-2. Only when
     that is full do skinned deer go into the cooler portion of MHU-1. Each unit's non-cooler
     portion is where processors work, which is why MHU-1 is kept clearer: it is the room you skin
     in. Listing them Cooler, MHU-2, MHU-1 puts the likeliest destination at the top of the move
     list and reads down the board in the order a deer travels. */
  const PLACES = ['Cooler', 'MHU-2', 'MHU-1'];
  const RELEASED_SHOWN = 10;       // how many released deer the board lists; the count is the true total
  const placeOf = d => {
    if (d.Type === 'Cold storage') return 'Cooler';
    if (PLACES.indexOf(d.Location) >= 0) return d.Location;
    /* Never moved, so read it from what has been done to it: skin on means it is still in the
       receiving cooler, and once skinned it hangs in MHU-2. This used to guess MHU-1 for a skinned
       deer, which was the wrong unit — MHU-2 fills first. */
    return (d.Status === 'Processing' || d['Skinner']) ? 'MHU-2' : 'Cooler';
  };
  let boardQuery = '';             // what is typed in the board's search box
  /* Where a deer is in the process, in words, for the search box. */
  function stageOf(d) {
    if (d.Status === 'Voided') return 'Voided' + (d['Void reason'] ? ': ' + d['Void reason'] : '');
    if (d.Status === 'Released') return 'Released ' + (d.Released || '') + (d['Released to'] ? ' to ' + d['Released to'] : '');
    if (d.Status === 'Ready') return 'Packaged, ready for pickup or delivery' + (d['First pack #'] ? ' · packs ' + d['First pack #'] + '–' + (d['Last pack #'] || '') : '');
    if (d.Status === 'Processing') return 'Being processed' + (d.Butcher ? ' by ' + d.Butcher : '') + ' · started ' + (d['Processing started'] || '');
    if (d.Type === 'Cold storage') return 'Cold storage only, waiting for the hunter';
    return (d['Skinner'] ? 'Skinned' + (d['Skinner name'] ? ' by ' + d['Skinner name'] : '') + ', waiting to be processed' : 'Checked in, skin on, waiting to be skinned');
  }
  const whereOf = d => d.Status === 'Hanging' || d.Status === 'Processing' ? placeOf(d) : d.Status === 'Ready' ? 'Out of the cooler' : '';
  // Hunter ID, confirmation number, name or band — any part of any of them, case and spaces ignored.
  function searchDeer(q) {
    const k = String(q || '').toLowerCase().replace(/\s+/g, '');
    if (k.length < 2) return [];
    return deerList().filter(d => ['Hunter number', 'MassWildlife confirmation', 'Hunter name', 'Band']
      .some(f => String(d[f] || '').toLowerCase().replace(/\s+/g, '').indexOf(k) >= 0))
      .sort((a, b) => (a.Status === 'Released' || a.Status === 'Voided') - (b.Status === 'Released' || b.Status === 'Voided') || hoursHung(b) - hoursHung(a));
  }
  /* The board carries this week's deer; the server searches the whole season. Local hits show at
     once, the server's follow a moment later for anything older (Joe, 7 November). */
  let farHits = { q: '', deer: [], busy: false };
  function searchHtml(q) {
    if (String(q || '').replace(/\s+/g, '').length < 2) return '';
    const near = searchDeer(q), seen = new Set(near.map(d => band(d.Band)));
    const far = farHits.q === q ? farHits.deer.filter(d => !seen.has(band(d.Band))).map(d => Object.assign({ far: true }, d)) : [];
    const hits = near.concat(far);
    const busy = farHits.busy && farHits.q === q ? '<p class="status">Looking through the rest of the season…</p>' : '';
    if (!hits.length) return busy || '<p class="status">No deer matches “' + esc(q) + '”.</p>';
    return hits.slice(0, 20).map(d => {
      const bc = colourOf(d), w = whereOf(d);
      return (d.far ? '<div class="hit">' : '<button type="button" class="hit" data-hit="' + esc(d.Band) + '">') +
        '<span class="dot" style="background:' + (bc ? hexFor(bc) : '#fff') + '"></span>' +
        '<span class="dwho"><b>' + esc(d['Hunter name'] || '—') + (w ? ' · ' + esc(w) : '') + '</b>' +
        '<span class="status">' + esc(stageOf(d)) + '</span>' +
        '<span class="status">' + esc(d['Hunter number'] || '') + ' · ' + esc(d['MassWildlife confirmation'] || 'no confirmation #') + ' · ' + esc(d.Type || '') +
        (d.far ? ' · band ' + esc(d.Band) : '') + '</span></span>' + (d.far ? '</div>' : '</button>');
    }).join('') + (hits.length > 20 ? '<p class="status">' + (hits.length - 20) + ' more: type more of it.</p>' : '') + busy;
  }
  const boardOpen = new Set();     // which dropdowns are open, kept through the 45-second redraws
  const boardDeer = new Set();     // which deer rows are expanded to their full card

  // One line per deer: band colour, hunter, confirmation, hours — and the flags that change what you do.
  function deerRow(d) {
    const s = S(), h = hoursHung(d), bc = colourOf(d), isCold = d.Type === 'Cold storage', owe = owedOn(d);
    const flags =
      (d.Status === 'Processing' ? '<span class="tag">ON THE TABLE</span>' : '') +
      (!isCold && h >= s.maxHold ? '<span class="tag red">OVER MAX HOLD</span>'
        : !isCold && urgentDeer(d) ? '<span class="tag red">NEAR MAX HOLD</span>'
        : !isCold && h >= s.startBy ? '<span class="tag amb">START NEXT</span>' : '') +
      (owe && !owe.settled ? '<span class="tag red">UNPAID</span>' : '') +
      (d['Skull kept'] === 'Yes' ? '<span class="tag skull">SKULL</span>' : '') +
      (d.pending ? '<span class="pill wait">not sent yet</span>' : '');
    const open = boardDeer.has(d.Band);
    return '<div class="drow' + (open ? ' open' : '') + '"><button type="button" class="drowbtn" data-row="' + esc(d.Band) + '">' +
      '<span class="dot" style="background:' + (bc ? hexFor(bc) : '#fff') + '" title="' + esc(bc || '') + '"></span>' +
      '<span class="dwho"><b>' + esc(d['Hunter name'] || d['Hunter number'] || '—') + '</b>' +
      '<span class="status">' + esc(d['MassWildlife confirmation'] || 'no confirmation #') + (flags ? ' ' : '') + '</span>' + flags + '</span>' +
      '<span class="dh">' + Math.floor(h) + ' h</span></button>' +
      (open ? deerCard(d) : '') + '</div>';
  }
  // Longest hanging on top, whatever the type or payment — the flags say the rest (Joe, 7 November).
  const byAge = list => list.slice().sort((a, b) => hoursHung(b) - hoursHung(a));
  /* `note` replaces the right-hand summary text. The Released list uses it: "oldest 300 h" is
     meaningless for a deer that has already gone home. */
  function drop(key, title, list, inner, cap, note) {
    const open = boardOpen.has(key);
    const oldest = list.length ? Math.floor(Math.max.apply(null, list.map(hoursHung))) : 0;
    const right = note != null ? note : (list.length ? 'oldest ' + oldest + ' h' : 'empty');
    return '<details class="drop" data-drop="' + esc(key) + '"' + (open ? ' open' : '') + '><summary><span><b>' + esc(title) + '</b> · ' +
      list.length + (cap ? ' of ' + cap : '') + '</span><span class="status">' + esc(right) + '</span></summary>' +
      '<div class="dropin">' + (inner != null ? inner : (list.length ? byAge(list).map(deerRow).join('') : '<p class="status">Nothing here.</p>')) + '</div></details>';
  }

  function showBoard() {
    const s = S();
    const all = deerList();
    const keep = list => bandFilter ? list.filter(d => colourOf(d) === bandFilter) : list;
    const inside = keep(all.filter(d => d.Status === 'Hanging' || d.Status === 'Processing'));
    const at = p => inside.filter(d => placeOf(d) === p);
    const cooler = at('Cooler'), m1 = at('MHU-1'), m2 = at('MHU-2');
    const hanging = all.filter(d => d.Status === 'Hanging').sort((a, b) => sortKey(a) - sortKey(b));
    const ready = all.filter(d => d.Status === 'Ready');
    /* Everything that has gone out, most recently released first — not by age, which for a deer
       that has left the building only says how long it hung. Shown even when empty: a category
       that disappears reads as a category that does not exist (Joe, 7 November). */
    const released = all.filter(d => d.Status === 'Released')
      .sort((a, b) => (parse(b.Released) || 0) - (parse(a.Released) || 0));
    const n = all.filter(d => d.Status === 'Hanging' || d.Status === 'Processing').length, full = n >= s.coolerCap;
    const ofType = t => cooler.filter(d => d.Type === t);
    const coolerInner =
      drop('Cooler/Donated', 'Donated', ofType('Donated')) +
      drop('Cooler/Private', 'Private', ofType('Private')) +
      drop('Cooler/Cold storage', 'Cold storage only', ofType('Cold storage'));
    frame('board', 'Deer Board',
      '<div class="card"><b>In the cooler and MHUs: ' + n + ' of ' + s.coolerCap + '</b>' +
      (full ? '<div class="note bad">Cooler is full. Hold private intakes until a deer is processed.</div>'
        : n >= Math.ceil(s.coolerCap * s.coolerAlert / 100) ? '<div class="note warn">Getting full. Process the oldest deer first.</div>' : '') +
      (() => {
        const up = hanging.filter(d => d.Type !== 'Cold storage')[0];
        if (!up) return '<div class="status">Nothing waiting to be processed.</div>';
        return '<div class="note' + (urgentDeer(up) ? ' bad' : ' ok') + '"><b>Next up: ' + esc(up['Hunter name'] || up.Band) + '</b> · ' +
          esc(placeOf(up)) + ' · ' + esc(rankName(rankOf(up))) + ' · ' + Math.round(hoursHung(up)) + ' h hung' +
          (urgentDeer(up) ? ' — <b>near the maximum hold, so it goes first whatever its priority</b>'
            : unpaidDeer(up) ? ' — <b>unpaid</b>, so it cannot be started until the money is in' : '') +
          '</div>';
      })() +
      '<div class="status">Each list runs longest-hanging first. Tap a deer for its card. Amber: ' + s.startBy + ' hours hung, start processing. Red: over the maximum hold, tell Joe.</div>' +
      '<button class="plain" id="reload">Refresh now</button></div>' +
      '<div class="card"><label for="bsearch">Find a deer <span class="hint">hunter ID, confirmation # or name</span></label>' +
      '<input id="bsearch" type="text" enterkeyhint="search" autocomplete="off" value="' + esc(boardQuery) + '" placeholder="1690575, MY4M3P or Bellabuono">' +
      '<div id="bhits">' + searchHtml(boardQuery) + '</div></div>' +
      bandKeyHtml() +
      (bandFilter ? '<div class="note ok">Showing ' + esc(bandFilter) + ' bands only. <button class="plain" id="clearband" style="padding:0">Show them all</button></div>' : '') +
      drop('Cooler', 'Cooler', cooler, coolerInner) +
      drop('MHU-2', 'MHU-2', m2, null, s.mhu2Cap || 20) +
      drop('MHU-1', 'MHU-1', m1, null, s.mhu1Cap || 20) +
      drop('Ready', 'Ready for pickup or delivery', ready) +
      drop('Released', 'Released', released,
        released.length ? released.slice(0, RELEASED_SHOWN).map(d => deerRow(d)).join('')
          : '<p class="status">Nothing has gone out yet.</p>',
        null,
        released.length > RELEASED_SHOWN ? 'last ' + RELEASED_SHOWN + ' of ' + released.length
          : released.length ? 'most recent first' : 'none yet'));
    document.getElementById('reload').onclick = () => refresh();
    $app.querySelectorAll('[data-bandkey]').forEach(r => r.onclick = () => {
      bandFilter = bandFilter === r.dataset.bandkey ? '' : r.dataset.bandkey; showBoard();
    });
    const cb = document.getElementById('clearband');
    if (cb) cb.onclick = () => { bandFilter = ''; showBoard(); };
    const bs = document.getElementById('bsearch'), bh = document.getElementById('bhits');
    const wireHits = () => bh.querySelectorAll('[data-hit]').forEach(x => x.onclick = () => showDeer(x.dataset.hit));
    let timer = null;
    const paint = () => { if (bs.value === boardQuery) { bh.innerHTML = searchHtml(boardQuery); wireHits(); } };
    bs.oninput = () => {
      boardQuery = bs.value; clearTimeout(timer);
      const q = boardQuery;
      if (q.replace(/\s+/g, '').length >= 2) {
        farHits = { q: q, deer: [], busy: true };
        timer = setTimeout(() => call({ action: 'finddeer', q: q })
          .then(out => { if (farHits.q === q) farHits = { q: q, deer: (out && out.deer) || [], busy: false }; paint(); })
          .catch(() => { if (farHits.q === q) farHits.busy = false; paint(); }), 450);
      }
      paint();
    };
    wireHits();
    $app.querySelectorAll('details.drop').forEach(x => x.addEventListener('toggle', e => {
      e.stopPropagation(); if (x.open) boardOpen.add(x.dataset.drop); else boardOpen.delete(x.dataset.drop);
    }));
    $app.querySelectorAll('[data-row]').forEach(r => r.onclick = () => {
      const b = r.dataset.row; if (boardDeer.has(b)) boardDeer.delete(b); else boardDeer.add(b); showBoard();
    });
    $app.querySelectorAll('[data-band]').forEach(c => c.querySelectorAll('[data-a]').forEach(b => b.onclick = () => act(b.dataset.a, all.find(d => d.Band === c.dataset.band), c.querySelector('.form'))));
  }

  /* What is still owed on a privately processed deer.

     From 6 November custom processing is paid before the deer is cut, not when it is collected
     (Joe). The old way had the facility doing a day of skilled work on spec and then, if the money
     never came, holding a hunter's own venison over it — the worst of both ends. Asking at the
     door costs nothing and settles it. */
  function owedOn(d) {
    if (!d || d.Type !== 'Private') return null;
    const price = Number(d['Hunter price ($)'] || S().privatePrice || 300) || 0;
    const paid = Number(d['Paid ($)'] || 0) || 0;
    const owing = Math.max(0, Math.round((price - paid) * 100) / 100);
    return { price: price, paid: paid, owing: owing, settled: owing <= 0 };
  }

  function deerCard(d) {
    const s = S();
    const h = hoursHung(d), bc = colourOf(d), isCold = d.Type === 'Cold storage';
    const owe = owedOn(d), live = d.Status !== 'Released' && d.Status !== 'Voided';
    const u = d.Status === 'Hanging' && !isCold ? urgency(d) : null;
    // Cold storage is not waiting to be processed, so the processing clock would mislabel it. Its
    // own limit is the Society's: five days, longer while there is room — a hunter to ring.
    const cls = d.Status !== 'Hanging' ? '' : isCold ? (h >= (s.coldDays || 5) * 24 ? ' amber' : '')
      : (h >= s.maxHold ? ' red' : h >= s.startBy ? ' amber' : '');
    const mineOrMgr = d['Processor number'] === st.staff.number || isMgr();
    const act = isViewer() ? '' : d.Status === 'Hanging' ? (isCold ? '<button class="btn" data-a="release">Hunter collected it</button>'
      : (d['Skinner'] ? '' : '<button class="btn alt" data-a="skin">Skin it</button> ') + '<button class="btn" data-a="start">Start processing</button>')
      : d.Status === 'Processing' ? (mineOrMgr ? (d.Type === 'Donated' && !d['First pack #'] ? '<button class="btn alt" data-a="grind">Get package numbers</button> ' : '') + '<button class="btn" data-a="finish">Finished</button>' : '')
      : d.Status === 'Ready' ? '<button class="btn alt" data-a="release">Release</button>' : '';
    // A duplicate or a mistaken entry is not deleted, it is voided: the row stays and says so.
    const moveBtn = !isViewer() && !isCold && (d.Status === 'Hanging' || d.Status === 'Processing')
      ? ' <button class="btn ghost" data-a="move">Move to…</button>' : '';
    const voidBtn = !isViewer() && isMgr() && d.Status !== 'Voided'
      ? ' <button class="btn ghost" data-a="void">Void this check-in</button>' : '';
    /* A typo in what the hunter said at the door is a typo, not a different deer. Correcting it is
       an amendment — the Edits tab keeps what it was, what it became, who changed it and why — so
       people fix the record instead of working around it. */
    const canEdit = !isViewer() && (isMgr() || /intake/i.test((st.staff || {}).role || ''));
    const editBtn = canEdit && d.Status !== 'Voided'
      ? ' <button class="btn ghost" data-a="edit">Correct the record</button>' : '';
    /* One step back. Every action here commits the instant it is tapped, which is right at a cold
       bench \u2014 but until 6 November almost none of them could be reversed, and the only way out
       was Void, which marks the whole deer as something that never happened. A mis-tapped start
       that also took a package number silently blocked the grinder for every other donated deer. */
    const undoBtn = (!isViewer() && d.undo && d.undo.step)
      ? ' <button class="btn ghost" data-a="undo"' + (d.undo.allowed ? '' : ' disabled title="' + esc(d.undo.why) + '"') +
        '>Undo: ' + esc(undoName(d.undo.step)) + '</button>' : '';
    // Money on a private deer, offered wherever the deer is: at the door, on the hook, on the
    // bench. It is first in the row because it is the thing that unblocks everything after it.
    const payBtn = (!isViewer() && owe && !owe.settled && live)
      ? '<button class="btn alt" data-a="pay">Take $' + owe.owing + '</button> ' : '';
    return '<div class="card' + cls + (d.Type === 'Donated' ? ' donated' : '') + '" data-band="' + esc(d.Band) + '">' +
      '<div class="deer"><div><span class="band">' + esc(d.Band) + '</span> ' +
      '<span class="tag ' + (d.Type === 'Donated' ? 'don">DONATED' : 'prv">' + (isCold ? 'COLD STORAGE' : 'PRIVATE')) + '</span>' + (d['DDP deer'] === 'Yes' ? '<span class="tag">DDP</span>' : '') +
      (d.Type !== 'Donated' && d['Pork fat added'] === 'Yes' ? '<span class="tag">+ PORK FAT</span>' : '') +
      (d['Skull kept'] === 'Yes' ? '<span class="tag skull">KEEP THE SKULL</span>' : '') +
      (d.pending ? '<span class="pill wait">not sent yet</span>' : '') +
      (u ? '<span class="pill" style="background:' + u.colour + ';color:#fff;font-weight:700">' + u.level.toUpperCase() + '</span>' : '') +
      '<div class="status">' + (bc ? swatch(bc) + ' · ' : '') +
      'in ' + esc(d.Intake) + ' · ' + esc(d.Deer || '') + (d['Antler points'] ? ' (' + esc(d['Antler points']) + ' pts)' : '') + ' · ' + esc(d['Hunter number'] || d['Hunter name'] || '') +
      (d['Skinner name'] ? ' · skinned by ' + esc(d['Skinner name']) : '') +
      (d.Butcher ? ' · ' + esc(d.Butcher) + (d['Processor number'] ? ' (' + esc(d['Processor number']) + ')' : '') : '') +
      (d['Intake weight (lb)'] ? ' · ' + esc(d['Intake weight (lb)']) + ' lb in' + (d['Weighed as'] === 'Not dressed' ? ' (not dressed)' : '') : '') +
      (d['Carcass weight (lb)'] ? ' · ' + esc(d['Carcass weight (lb)']) + ' lb carcass' : '') +
      (d['Pounds packaged'] ? ' · ' + esc(d['Pounds packaged']) + ' lb packaged' : '') + '</div></div>' +
      '<div class="hrs">' + (d.Status === 'Released' ? '' : Math.floor(h) + ' h') + '</div></div>' +
      (d.Status === 'Voided' ? '<div class="note bad"><b>Voided</b>' + (d['Void reason'] ? ': ' + esc(d['Void reason']) : '') +
        (d['Voided by'] ? ' · ' + esc(d['Voided by']) : '') + '</div>' : '') +
      (d.Cuts && d.Status !== 'Released' ? '<div class="note ok"><b>Cuts:</b> ' + esc(d.Cuts) + '</div>' : '') +
      /* Loud, and on every card, because it is read by whoever is about to take the head off and
         the cost of missing it cannot be undone. It stays visible after release too, so a hunter
         who comes back for the rack can be answered from the record. */
      (d['Skull kept'] === 'Yes'
        ? '<div class="note warn" style="font-size:17px"><b>Keep the skull and antlers.</b> ' +
          (d.Status === 'Released' ? 'It went with the deer.' :
            'Tag the head with ' + esc(band(d.Band)) + ' at the skinning station and set it aside — it does not go in the waste barrel.') +
          '</div>' : '') +
      (owe && live && !owe.settled
        ? '<div class="note bad" style="font-size:17px"><b>$' + owe.owing + ' owing</b>' +
          (owe.paid ? ' of $' + owe.price + ' ($' + owe.paid + ' paid)' : '') +
          '. Custom processing is paid before it is cut' +
          (d.Status === 'Hanging' ? ' — it cannot be started until it is.' : '.') + '</div>'
        : owe && live && owe.settled
          ? '<div class="note ok">Custom processing paid: <b>$' + owe.paid + '</b>' +
            (d['Payment method'] ? ' · ' + esc(d['Payment method']) : '') + '</div>' : '') +
      (d['First pack #'] && d['Last pack #'] ? '<div class="note ok"><b>Package numbers ' + esc(d['First pack #']) + '–' + esc(d['Last pack #']) + '</b> (MassWildlife)</div>'
        : d['First pack #'] ? '<div class="note warn" style="font-size:17px">Label the 2 lb packages in order from <b>' + esc(d['First pack #']) + '</b>: ' + esc(d['First pack #']) + ', ' + esc(('000' + (parseInt(d['First pack #'], 10) + 1)).slice(-4)) + ', …</div>' : '') +
      (d.Status === 'Released' ? '<div class="status">Released ' + esc(d.Released) + ' to ' + esc(d['Released to']) + '</div>' : '') +
      '<div class="actions">' + payBtn + act + moveBtn + (live && !isViewer() ? '<button class="btn ghost" data-a="print">Print band</button>' : '') + editBtn + undoBtn + voidBtn + '</div><div class="form"></div></div>';
  }

  /* Starting work while clocked out is how hours go missing: nobody forgets to clock in on purpose,
     they forget because the deer is in front of them. So the two actions that mean "I am working
     now" ask first, with one tap to clock in and carry on. A manager recording someone else's
     skinning, or anyone who really is not on the clock, can carry on without (Joe, 7 November). */
  let clockNudged = false;
  function act(kind, d, box, after) {
    if ((kind === 'skin' || kind === 'start') && !isViewer() && !st.home.clockedIn && !clockNudged && box) {
      box.innerHTML = '<div class="note warn" style="font-size:17px"><b>You\'re not clocked in.</b> Clock in now and carry on?</div>' +
        '<div class="err" id="cnerr"></div>' +
        '<button class="btn" id="cnin">Clock in and carry on</button> <button class="btn ghost" id="cnskip">Carry on without</button>';
      document.getElementById('cnskip').onclick = () => { clockNudged = true; act(kind, d, box, after); clockNudged = false; };
      document.getElementById('cnin').onclick = async e => {
        e.target.disabled = true;
        try { await clockInNow(); act(kind, d, box, after); }
        catch (x) { e.target.disabled = false; document.getElementById('cnerr').textContent = x.offline ? 'Clocking in needs signal. Carry on without and tell Joe the time.' : x.message; }
      };
      return;
    }
    if (kind === 'print') return printBand(d);
    if (kind === 'grind') return grind(d, box, after);
    if (kind === 'undo') return askUndo(d, box, after);
    const s = S();
    const fatPct = d.Type === 'Donated' ? s.fatDonated : (d['Pork fat added'] === 'Yes' ? s.fatPrivate : 0), fatOn = fatPct > 0, fat = fatPct / 100;
    // Donated deer have their package numbers reserved before grinding, so the last label written
    // is known and the count follows from it. Everything else is still counted.
    const firstPack = parseInt(d['First pack #'], 10) || 0;
    const byLast = d.Type === 'Donated' && firstPack > 0;
    // Donated, on the bench, and no number drawn yet. The one state the finish form cannot answer.
    const needsPack = d.Type === 'Donated' && !firstPack;
    const owe = owedOn(d), isCold = d.Type === 'Cold storage';
    const v = id => (document.getElementById(id) || {}).value || '';
    const opts = (list, cur) => ['<option value=""></option>'].concat(list.map(x =>
      '<option' + (String(cur) === x ? ' selected' : '') + '>' + esc(x) + '</option>')).join('');
    const forms = {
      /* Only what was said at the door. The band is absent on purpose: it is printed on the
         carcass and every lot number is built from it, so a wrong band is a void and a fresh
         check-in. The weights, times, packages and tickboxes are absent too — those are
         measurements made by doing the work, not answers that can be mistyped. */
      edit: () => '<p class="status">Corrects what was taken down at check-in. Every change is kept with what it was before, your name and the reason. The band cannot be changed here — a wrong band is a void and a new check-in.</p>' +
        '<div class="grid2"><div><label for="e_firstName">First name</label><input id="e_firstName" type="text" value="' + esc(d['Hunter first name'] || splitName(d['Hunter name']).first) + '"></div>' +
        '<div><label for="e_lastName">Last name</label><input id="e_lastName" type="text" value="' + esc(d['Hunter last name'] || splitName(d['Hunter name']).last) + '"></div></div>' +
        '<div class="grid2"><div><label for="e_customerId">Licence number</label><input id="e_customerId" type="text" inputmode="numeric" value="' + esc(d['Customer ID'] || '') + '"></div>' +
        '<div><label for="e_phone">Phone</label><input id="e_phone" type="text" inputmode="tel" value="' + esc(d['Hunter phone'] || '') + '"></div></div>' +
        '<label for="e_confirmation">MassWildlife confirmation</label><input id="e_confirmation" type="text" autocapitalize="characters" value="' + esc(d['MassWildlife confirmation'] || '') + '">' +
        (d['Sent to Martin'] ? '<p class="note warn">This deer is already on MassWildlife’s sheet. Changing the licence, the name or the confirmation number makes his copy wrong, so it gets flagged for correcting rather than pasted again.</p>' : '') +
        '<label for="e_email">Email</label><input id="e_email" type="email" inputmode="email" autocapitalize="off" value="' + esc(d['Hunter email'] || '') + '">' +
        '<label for="e_address">Mailing address</label><input id="e_address" type="text" value="' + esc(d['Hunter mailing address'] || '') + '">' +
        '<div class="grid2"><div><label for="e_deer">Deer</label><select id="e_deer">' + opts(['Doe', 'Button buck', 'Sub-legal adult male', 'Antlered buck'], d['Deer']) + '</select></div>' +
        '<div><label for="e_points">Antler points</label><input id="e_points" type="number" inputmode="numeric" min="0" step="1" value="' + esc(d['Antler points'] || '') + '"></div></div>' +
        // A hunter changes his mind about the rack, and he is usually standing there when he does.
        (/antlered/i.test(d['Deer'] || '') && d.Type !== 'Cold storage'
          ? '<label for="e_skull">Skull and antlers</label><select id="e_skull">' +
            opts(['Yes', 'No'], d['Skull kept']) + '</select>' +
            '<p class="status">Yes keeps the head for the hunter. Once it has gone out with the waste, changing this to Yes does not bring it back.</p>'
          : '') +
        '<div class="grid2"><div><label for="e_takenWith">Taken with</label><select id="e_takenWith">' + opts(['Archery', 'Shotgun slug', 'Muzzleloader', 'Not known'], d['Taken with']) + '</select></div>' +
        '<div><label for="e_ammunition">Ammunition</label><select id="e_ammunition">' + opts(['Lead', 'Non-lead', 'Not known'], d['Ammunition']) + '</select></div></div>' +
        '<label for="e_notes">Notes</label><input id="e_notes" type="text" value="' + esc(d['Notes'] || '') + '">' +
        '<label for="er">Why <span class="hint">goes on the record beside the change</span></label><input id="er" type="text" placeholder="Licence read back off the hunter’s card">',
      void: () => '<p class="status">The row stays on the record and is marked voided, with your name and the reason on it. It stops counting in the cooler, on this board, in the totals and on the Donation report. Nothing is deleted.</p>' +
        (d['First pack #'] && d['Last pack #'] ? '<p class="note bad">This deer was packaged: <b>' + esc(d['First pack #']) + ' to ' + esc(d['Last pack #']) + '</b>. Voiding it frees those package numbers, and nothing renumbers the deer that came after. Fix the numbering by hand before the next drop-off.</p>' : '') +
        '<label for="vr">Why</label><input id="vr" type="text" placeholder="Duplicate of 1017202601, checked in twice">',
      /* There used to be a warning here that a skin-on carcass should not go into MHU-2. That was
         wrong: unskinned carcasses go into MHU-2 by design, and MHU-2 is filled before MHU-1
         (Joe, 7 November). A warning nobody should heed teaches people to dismiss the ones that
         matter, so it is gone rather than softened. */
      move: () => '<p class="status">Where is ' + esc(d['Hunter name'] || band(d.Band)) + ' now? Records who moved it and when.</p>' +
        PLACES.filter(p => p !== placeOf(d)).map(p => '<label class="choice"><input type="radio" name="mv" value="' + p + '"> <span><b>' + p + '</b></span></label>').join(''),
      skin: () => (d['Skull kept'] === 'Yes'
          ? '<div class="note warn" style="font-size:17px"><b>This hunter wants the skull and antlers.</b> ' +
            'Tag the head with ' + esc(band(d.Band)) + ' and set it aside before you carry on.</div>' : '') +
        '<p class="status">Records who skinned this deer. The $' + esc(s.skinRate || 25) +
        ' skinning premium goes to whoever is named here, whether or not they process it.</p>' +
        (isMgr() ? '<label>Skinned by</label><select id="sk">' + (st.home.staff || []).map(x => '<option value="' + esc(x.number) + '"' + (x.number === st.staff.number ? ' selected' : '') + '>' + esc(x.name + ' (' + x.number + ')') + '</option>').join('') + '</select>'
          : '<p class="status">Skinned by: <b>' + esc(st.staff.name + ' (' + st.staff.number + ')') + '</b></p>') +
        '<label class="choice"><input id="k1" type="checkbox"> Skinned and head removed inside MHU #1</label>' +
        '<label class="choice"><input id="k2" type="checkbox"> Antimicrobial spray applied</label>',
      /* Money on a private deer, taken wherever the deer happens to be. The same two ways as every
         other charge in the app: hand it to Square on this device, or write down how they paid.
         Part payment is allowed because a hunter putting half down at the door is better than a
         hunter putting nothing down, and the deer simply stays unstarted until the rest arrives. */
      pay: () => {
        const o = owe || { price: 0, paid: 0, owing: 0 };
        return '<div class="note ' + (o.owing > 0 ? 'bad' : 'ok') + '" style="font-size:17px">' +
          '<b>$' + o.owing + ' owing</b> of $' + o.price + ' for custom processing' +
          (d['Pork fat added'] === 'Yes' ? ' (includes the pork fat add-on)' : '') +
          (o.paid ? ' · $' + o.paid + ' already paid' : '') + '</div>' +
          '<p class="status">' + esc(d['Hunter name'] || 'The hunter') + ' · ' + esc(band(d.Band)) + '</p>' +
          (squareReady()
            ? '<button class="btn" id="psq">Take $' + o.owing + ' on Square</button>' +
              '<div class="status">Hands the amount to Square on this device and brings the receipt back. Or record it by hand:</div>'
            : '') +
          '<label for="pm2">How are they paying?</label><select id="pm2"><option value="">Choose…</option>' +
          (s.payMethods || ['Cash', 'Card (Square)', 'Check']).map(m => '<option>' + esc(m) + '</option>').join('') + '</select>' +
          '<label for="pa2">Amount taken ($) <span class="hint">leave as is unless they are paying part of it</span></label>' +
          '<input id="pa2" type="number" inputmode="decimal" min="0" step="0.01" value="' + esc(o.owing) + '">' +
          '<p class="status">Cash goes in an envelope for the safe at close-out. Never in a pocket or the truck.</p>';
      },
      start: () => (owe && !owe.settled
        ? '<div class="note bad" style="font-size:17px"><b>$' + owe.owing + ' is still owing on this deer.</b> ' +
          'Custom processing is paid before it is cut. Take the payment first — the button is on the card above.' +
          (isMgr()
            ? '<label for="fup">Or start it anyway, and say why <span class="hint">goes on the record and to the other managers</span></label>' +
              '<input id="fup" type="text" placeholder="Card machine down, paying Thursday">'
            : '<br>If it has to go on now, a manager can start it with a reason.') + '</div>'
        : '') +
        (d['Skull kept'] === 'Yes' && !d['Skinner']
          ? '<div class="note warn" style="font-size:17px"><b>This hunter wants the skull and antlers.</b> ' +
            'The head comes off here — tag it with ' + esc(band(d.Band)) + ' and set it aside, do not bin it.</div>' : '') +
        '<div class="note warn" style="font-size:17px">Tag confirmation number: <b>' + esc(d['MassWildlife confirmation'] || 'none recorded') + '</b></div>' +
        '<label class="choice"><input id="f0" type="checkbox"> The confirmation number on the deer\'s tag matches</label>' +
        (d['Skinner name'] ? '<div class="note ok">Skinned by <b>' + esc(d['Skinner name']) + '</b>' + (d['Skinned at'] ? ' · ' + esc(d['Skinned at']) : '') + '. The skinning premium is theirs.</div><input id="f8" type="checkbox" checked hidden>'
          : '<label class="choice"><input id="f8" type="checkbox"> Skinned and head removed inside MHU #1 <span class="hint">You get the $' + esc(s.skinRate || 25) + ' skinning premium for it</span></label>') +
        (d['Antimicrobial spray'] === 'Yes' ? '<input id="f9" type="checkbox" checked hidden>'
          : '<label class="choice"><input id="f9" type="checkbox"> Antimicrobial spray applied in MHU #1</label>') +
        (isMgr() ? '<label>Processor</label><select id="fp">' + (st.home.staff || []).map(x => '<option value="' + esc(x.number) + '"' + (x.number === st.staff.number ? ' selected' : '') + '>' + esc(x.name + ' (' + x.number + ')') + '</option>').join('') + '</select>'
          : '<p class="status">Processor: ' + esc(st.staff.name + ' (' + st.staff.number + ')') + '</p>') +
        '<label>Carcass weight (lb) <span class="hint">On the hanging scale: field dressed, skin and head off</span></label><input id="f1" type="number" inputmode="decimal" min="0" step="0.1">' +
        // Somewhere to say "we didn't weigh it". Without one, a number gets invented, and an
        // invented number is worse than a blank because the yield figure is built on it.
        '<label class="choice"><input id="f1na" type="checkbox"> Not weighed <span class="hint">No scale reading for this deer. Leaves the weight and the yield blank rather than guessing.</span></label>',
      // Donated deer get their numbers before grinding, so by the time this form opens the first
      // number is known and the last one is on the bench in front of them.
      finish: () => '<p class="status">Started ' + esc(d['Processing started'] || '') + ' · carcass ' + esc(d['Carcass weight (lb)'] || '?') + ' lb</p>' +
        // A processor at the end of a donated deer knows the number on the last label they wrote.
        // Counting the packages back is a second, avoidable chance to get it wrong, so ask for the
        // thing they are holding and work the count out from it. Private deer have no package
        // numbers, so they are still counted.
        /* A donated deer with no package number yet used to fall back to the bag-count field,
           silently, which is the field this design exists to avoid. Graham found it on 6 November
           and learned to tap around the screen until the right prompt appeared. It is not a
           fallback now: the form says what is missing and gets the number from here. */
        (needsPack
          ? '<div class="note bad"><b>No package numbers on this deer yet.</b> Get them before you ' +
            'label anything, so the numbers run in order on the state\u2019s sheet.</div>' +
            /* Said before the button is tapped rather than after it fails. One donated deer holds
               the sequence at a time, and the one thing the processor needs to know is which. */
            (() => {
              const g = (st.home.packs || {}).grinder;
              return (g && g.band && band(g.band) !== band(d.Band))
                ? '<div class="note warn"><b>' + esc(band(g.band)) + ' is on the grinder</b> with packages from ' +
                  esc(g.first) + '. Numbers run in order, one donated deer at a time, so finish that one ' +
                  'first and this deer picks up where it left off.' +
                  '<button class="plain" id="fother" style="margin-top:6px">Open ' + esc(band(g.band)) + '</button></div>'
                : '';
            })() +
            '<button class="btn" id="fgp">Get package numbers</button>' +
            '<p class="status">Then come back here and enter the number on your last label.</p>'
          : '') +
        '<div class="grid2"' + (needsPack ? ' hidden' : '') + '><div>' + (byLast
          ? '<label>Last package number <span class="hint">the number on the last label you wrote</span></label><input id="f1" type="number" inputmode="numeric" min="0" step="1" placeholder="' + esc(d['First pack #']) + '\u2026">'
          : '<label>Ground packages (' + esc(s.pkgSize) + ' lb)</label><input id="f1" type="number" inputmode="numeric" min="0" step="1">') + '</div>' +
        (d.Type === 'Donated' ? '<input id="f2" type="hidden" value="0"><input id="f3" type="hidden" value="0"></div><p class="status">Donated deer: all grind, to the state standard, on the MassWildlife label.</p>'
          : '<div><label>Intact cut packages</label><input id="f2" type="number" inputmode="numeric" min="0" step="1" value="0"></div>' +
          '<div><label>Intact cuts total (lb)</label><input id="f3" type="number" inputmode="decimal" min="0" step="0.1" value="0"></div></div>') +
        '<div class="calc" id="calc"></div>' +
        (d.Type === 'Donated' && !d['First pack #'] ? '<div class="note bad">Tap <b>Get package numbers</b> before grinding, so the labels run in order.</div>' : '') +
        '<div class="note ' + (fatOn ? 'warn">Grind with <b>' + esc(fatPct) + '% pork fat</b>.' : 'ok">All-venison grind: <b>no pork fat</b>.') + '</div>' +
        (fatOn && d.Type !== 'Donated' ? '<label class="choice"><input id="f7" type="checkbox"> Out of pork fat: grind all venison and take the $' + esc(s.porkAddOn || 20) + ' off the hunter\'s price</label>' : '') +
        // The one hazard in this process that reaches a food pantry as an undeclared allergen. It is
        // asked here, at the bench, by the person who applied the stickers — not assumed afterwards.
        // CCP 4. The wording follows how the deer was taken, because a broadhead and a lead slug
        // are not the same hazard and asking the same question about both teaches people to tick
        // without reading.
        '<label for="f4">Trim discarded (lb)</label><input id="f4" type="number" inputmode="decimal" min="0" step="0.1">' +
        '<label class="choice"><input id="fw" type="checkbox"> ' +
        (/archery/i.test(d['Taken with'] || '')
          ? 'Wound channel trimmed out, and no broadhead fragments in the meat'
          : 'No meat within 6 inches of the wound channel went into the grind' +
            (/^lead$/i.test(d['Ammunition'] || '') ? ', and this was a <b>lead</b> projectile' : '')) + '</label>' +
        '<label class="choice"><input id="f5" type="checkbox"> Allergen sticker on every package' +
        (fatOn ? ', and \u201cContains pork\u201d where pork fat was added' : '') + '</label>' +
        (d.Type === 'Private' ? '<label class="choice"><input id="f6" type="checkbox"> Grinder cleared before the next hunter\'s deer, so no meat is mixed</label>' : '') +
        '<p class="status">Same food-safety steps for every deer. Full clean-down of the grinder and equipment at least once a day, signed off on the next morning\'s pre-op record.</p>',
      release: () => (d['Skull kept'] === 'Yes'
          ? '<div class="note warn" style="font-size:17px"><b>The skull and antlers go with him.</b> ' +
            'It is tagged ' + esc(band(d.Band)) + '. Do not let him leave without it.</div>' : '') +
        '<label>Released to</label><select id="f1"><option value="">Choose…</option><option' + (isCold ? ' selected' : '') + '>Hunter pickup</option>' +
        (s.pantries || []).map(p => '<option>' + esc(p) + '</option>').join('') + '<option value="other">Other…</option></select>' +
        '<input id="f3" type="text" placeholder="Who?" hidden style="margin-top:8px">' +
        '<label>Pounds out</label><input id="f2" type="number" inputmode="decimal" min="0" value="' + esc(d['Pounds packaged'] || '') + '">' +
        /* Paid up front from 6 November, so by the time a private deer reaches this form the money
           is usually already in. Asking for it again is how a payment gets recorded twice. */
        (owe && owe.settled ? '<div class="note ok">Paid in full: <b>$' + owe.paid + '</b>' +
          (d['Payment method'] ? ' · ' + esc(d['Payment method']) : '') + '. Nothing to collect.</div>' : '') +
        (d.Type === 'Private' && owe && !owe.settled ? '<div class="note warn">Hunter pickup: collect <b>$' + esc(owe.owing) + '</b>' + (owe.paid ? ' still owing of $' + esc(owe.price) : '') + (d['Pork fat added'] === 'Yes' ? ' (price includes the pork fat add-on)' : '') + '.</div>' +
          '<div class="grid2"><div><label for="pm">Paid by</label><select id="pm"><option value="">Choose…</option>' + (s.payMethods || ['Cash', 'Card (Square)', 'Check']).map(m => '<option>' + esc(m) + '</option>').join('') + '</select></div>' +
          '<div><label for="pa">Amount collected ($)</label><input id="pa" type="number" inputmode="decimal" min="0" step="0.01" value="' + esc(owe.owing) + '"></div></div>' +
          '<label for="pn">Receipt, check number or note <span class="hint">optional</span></label><input id="pn" type="text" maxlength="100">' +
          '<p class="status">Cash goes in an envelope for the safe at close-out. Never in a pocket or the truck.</p>' : ''),
    };
    box.innerHTML = forms[kind]() + '<div class="err" id="ferr"></div><button class="btn" id="fok" style="margin-top:12px">' +
      (kind === 'void' ? 'Void it' : kind === 'edit' ? 'Save the correction' : kind === 'pay' ? 'Record the payment' : 'Save') +
      '</button> <button class="btn ghost" id="fx">Cancel</button>';
    /* Cancel is bound FIRST, before anything that can throw. It used to be bound after the
       field wiring below, so a single missing element took the whole binding run down with it and
       left somebody holding a form with no way out. A way out is the one control that must never
       depend on the rest of the screen being right. */
    document.getElementById('fx').onclick = () => { box.innerHTML = ''; };
    const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el[ev] = fn; };
    if (kind === 'release') on('f1', 'onchange', e => {
      const f3 = document.getElementById('f3'); if (f3) f3.hidden = e.target.value !== 'other'; });
    /* Square leaves the app, so whatever is needed to finish has to be handed over before it goes.
       Only the band: the amount is read back off the deer when the queued action lands, so a
       payment and a price that moved while Square was open cannot disagree. */
    on('psq', 'onclick', () => {
      const ok = squareStart({ amount: (owe || {}).owing, band: band(d.Band), hunter: d['Hunter name'] || '',
        action: 'paydeer', label: 'Processing payment', fields: { band: band(d.Band) } });
      if (!ok) document.getElementById('ferr').textContent = 'Square is not set up on this device. Record it by hand instead.';
    });
    const calc = () => {
      const drop = !!(document.getElementById('f7') || {}).checked, fr = drop ? 0 : fat;
      const entered = Math.round(num(v('f1')));
      // With the last number entered, the count is the span including both ends.
      const pk = byLast ? (entered >= firstPack ? entered - firstPack + 1 : 0) : entered;
      const il = num(v('f3')), groundLb = pk * s.pkgSize;
      const ven = r1(groundLb * (1 - fr)), pork = r1(groundLb * fr), total = r1(groundLb + il), carcass = num(d['Carcass weight (lb)']);
      const el = document.getElementById('calc');
      if (el) el.innerHTML = (byLast ? '<b>' + pk + ' package' + (pk === 1 ? '' : 's') + '</b> · ' : '') +
        'Ground: <b>' + fmt(groundLb) + ' lb</b> (' + fmt(ven) + ' lb venison + ' + fmt(pork) + ' lb pork fat) · Intact: <b>' + fmt(il) + ' lb</b><br>' +
        'Total packaged: <b>' + fmt(total) + ' lb</b>' + (carcass ? ' · Venison yield: <b>' + Math.round((ven + il) / carcass * 100) + '%</b> of ' + fmt(carcass) + ' lb carcass' : '') +
        (d['First pack #'] && pk + num(v('f2')) > 0 ? '<br>Package numbers: <b>' + esc(d['First pack #']) + '–' + ('000' + (firstPack + pk + Math.round(num(v('f2'))) - 1)).slice(-4) + '</b>' : '');
      return { pk, il, total };
    };
    if (kind === 'finish') {
      ['f1', 'f2', 'f3'].forEach(id => on(id, 'oninput', calc));
      on('f7', 'onchange', calc);
      /* Draw the number from inside the form and re-open it, so the processor never has to go
         looking for the button on another screen. */
      on('fother', 'onclick', () => { const g = (st.home.packs || {}).grinder; if (g && g.band) showDeer(band(g.band)); });
      on('fgp', 'onclick', () => grind(d, box, () => {
        /* grind() writes the new number into the cached list, not into this closure's copy of the
           deer, so take it across before re-opening \u2014 otherwise the form rebuilds still
           believing there is no number and asks for it again. */
        const fresh = (st.home.deer || []).find(x => band(x.Band) === band(d.Band) && x.Status !== 'Released');
        if (fresh && fresh['First pack #']) d['First pack #'] = fresh['First pack #'];
        act('finish', d, box, after);
      }));
      try { calc(); } catch (e) { /* a sum that will not add up must not strand the form */ }
    }
    document.getElementById('fok').onclick = () => {
      const err = m => { document.getElementById('ferr').textContent = m; };
      if (kind === 'edit') {
        const why = v('er').trim();
        if (!why) return err('Say why it is being corrected. The reason goes on the record.');
        const fields = ['firstName', 'lastName', 'customerId', 'phone', 'email', 'address', 'confirmation', 'deer', 'points', 'takenWith', 'ammunition', 'notes'];
        const changes = {};
        fields.forEach(k => { changes[k] = v('e_' + k).trim(); });
        // Only sent when the question was on the form at all, so a correction to a doe cannot
        // write a skull answer onto a deer that never had one.
        if (document.getElementById('e_skull')) changes.skull = v('e_skull').trim();
        if (!changes.firstName && !changes.lastName) return err('A deer needs a hunter’s name on it.');
        // Live, like a void: the duplicate check and the Martin flag both need the whole log, and
        // replaying a blind correction from a phone that was offline is how records get worse.
        const btn = document.getElementById('fok');
        btn.disabled = true;
        call({ action: 'editdeer', band: d.Band, changes: changes, reason: why, clientId: 'edit-' + d.Band + '-' + Date.now() })
          .then(out => {
            box.innerHTML = '';
            if (!out.changed) { toast('Nothing changed.'); return; }
            toast(out.changed + (out.changed === 1 ? ' change saved' : ' changes saved') + ' on ' + d.Band);
            if (out.martin) toast('Flagged: MassWildlife’s copy of this row needs correcting.', true);
            refresh(); if (after) after();
          })
          .catch(e => { btn.disabled = false; err(e.offline ? 'Needs signal to correct a record.' : e.message); });
        return;
      }
      if (kind === 'void') {
        const why = v('vr').trim();
        if (!why) return err('Say why. The row stays, so the reason is the record.');
        // Not queued: voiding needs a manager and a live check, and it is rare enough to wait for
        // signal rather than replay blind from a phone that was offline.
        const btn = document.getElementById('fok');
        btn.disabled = true;
        call({ action: 'voiddeer', band: d.Band, reason: why })
          .then(() => { box.innerHTML = ''; toast('Voided ' + d.Band); refresh(); if (after) after(); })
          .catch(e => { btn.disabled = false; err(e.offline ? 'Needs signal to void a check-in.' : e.message); });
        return;
      }
      if (kind === 'move') {
        const pick = document.querySelector('input[name="mv"]:checked');
        if (!pick) return err('Choose where it went.');
        queue('move', { band: d.Band, to: pick.value }, 'Move ' + d.Band + ' to ' + pick.value);
        toast((d['Hunter name'] || d.Band) + ' moved to ' + pick.value + '.', true);
      }
      if (kind === 'skin') {
        if (!document.getElementById('k1').checked) return err('Skin it and remove the head inside MHU #1, then tick the box.');
        if (!document.getElementById('k2').checked) return err('Apply the antimicrobial spray, then tick the box.');
        const who = isMgr() ? v('sk') : st.staff.number;
        const wn = ((st.home.staff || []).find(x => x.number === who) || st.staff).name;
        queue('skin', { band: d.Band, skinner: who, skinnerName: wn, antimicrobial: true }, 'Skin ' + d.Band);
      }
      if (kind === 'pay') {
        const m = v('pm2'), amt = Number(v('pa2'));
        if (!m) return err('Choose how they paid.');
        if (!(amt > 0)) return err('Enter the amount taken.');
        if (owe && amt > owe.owing + 0.005) return err('That is more than the $' + owe.owing + ' owing.');
        queue('paydeer', { band: d.Band, method: m, amount: amt }, 'Payment ' + d.Band);
        toast('$' + amt + ' recorded against ' + d.Band + '.', true);
      }
      if (kind === 'start') {
        /* The one hard block on this screen. Priority, below, is a judgement the person at the
           bench may fairly override; whether the hunter has paid is not a judgement. */
        if (owe && !owe.settled) {
          if (!isMgr()) return err('$' + owe.owing + ' is still owing. Take the payment first, or ask a manager to start it.');
          if (!v('fup').trim()) return err('$' + owe.owing + ' is still owing. Say why it is being started unpaid.');
        }
        if (!document.getElementById('f0').checked) return err('Check the confirmation number on the tag first. If it doesn\'t match, stop and tell Joe.');
        if (!document.getElementById('f8').checked) return err('Skin it and remove the head inside MHU #1, then tick the box.');
        if (!document.getElementById('f9').checked) return err('Apply the antimicrobial spray in MHU #1, then tick the box.');
        const naW = document.getElementById('f1na').checked, wv = num(v('f1'));
        if (!naW) {
          if (!(wv > 0)) return err('Weigh the carcass and enter the weight, or tick Not weighed.');
          // 1 lb and 880 lb both reached the log on 4 November. One slipped finger either way.
          if (wv < 15 || wv > 250) return err(v('f1') + ' lb is outside the range a deer carcass falls in (15–250 lb). Check the scale, or tick Not weighed.');
        }
        const p = isMgr() ? v('fp') : st.staff.number;
        const pn = ((st.home.staff || []).find(x => x.number === p) || st.staff).name;
        /* Priority, asked once and recorded if overridden. Not a block: a processor at six in the
           morning with a good reason and no manager on site should not be stuck. But an override
           nobody can see is the same as no rule at all, so going ahead writes it to the Log. */
        const ahead = aheadOf(d, deerList());
        if (ahead.length && !window.confirm(
          ahead.length + ' deer ' + (ahead.length === 1 ? 'is' : 'are') + ' ahead of ' + d.Band +
          ' in the queue:\n\n' + ahead.slice(0, 4).map(x =>
            '  ' + x.Band + ' \u2014 ' + rankName(rankOf(x)) + ', ' + Math.round(hoursHung(x)) + ' h' +
            (urgentDeer(x) ? ' (near the maximum hold)' : '')).join('\n') +
          (ahead.length > 4 ? '\n  \u2026and ' + (ahead.length - 4) + ' more' : '') +
          '\n\nStart ' + d.Band + ' anyway? This is recorded.')) {
          return err('Start ' + ahead[0].Band + ' instead, or confirm the override.');
        }
        queue('start', { band: d.Band, processor: p, processorName: pn, weight: naW ? 'N/A' : v('f1'), notWeighed: naW, confirmationChecked: true, skinned: true, antimicrobial: true, ack: ahead.length > 0,
          unpaidReason: (owe && !owe.settled) ? v('fup').trim() : '' }, 'Start ' + d.Band);
      }
      if (kind === 'finish') {
        if (needsPack) return err('Tap Get package numbers first. A donated deer is labelled from the state\u2019s sequence, not from a bag count.');
        const c = calc(), ip = Math.round(num(v('f2')));
        if (byLast && Math.round(num(v('f1'))) > 0 && Math.round(num(v('f1'))) < firstPack) {
          return err('The last package number can\'t be below ' + d['First pack #'] + ', which is where this deer started.');
        }
        if (!(c.pk + ip > 0)) return err(byLast ? 'Enter the number on the last label.' : 'Enter the packages.');
        if (d.Type === 'Donated' && !d['First pack #']) return err('Get package numbers first (needs signal), so every label carries its MassWildlife number.');
        if (ip && !(c.il > 0)) return err('Weigh the intact cuts and enter the total.');
        if (!document.getElementById('fw').checked) return err(/archery/i.test(d['Taken with'] || '') ? 'Trim the wound channel out and check for broadhead fragments, then tick the box.' : 'Trim 6 inches around the wound channel out of the grind, then tick the box. Fragments travel further than the damage you can see.');
        if (!(Number(v('f4')) >= 0) || v('f4') === '') return err('Weigh the trim you discarded and enter it.');
        if (!document.getElementById('f5').checked) return err('Put the allergen sticker on every package, then tick the box. No package leaves without one.');
        if (d.Type === 'Private' && !document.getElementById('f6').checked) return err('Clear the grinder before the next hunter\'s deer goes through, then tick the box.');
        queue('finish', { band: d.Band, groundPackages: c.pk, lastPack: byLast ? Math.round(num(v('f1'))) : '', intactPackages: ip, intactLb: c.il, total: c.total, allergen: true, woundTrim: true, trim: num(v('f4')), grinderCleared: d.Type === 'Private', noPork: !!(document.getElementById('f7') || {}).checked }, 'Finish ' + d.Band);
      }
      if (kind === 'release') {
        const to = v('f1') === 'other' ? v('f3').trim() : v('f1');
        if (!to) return err('Say who it went to.');
        const pay = {};
        // Only when there is still something to collect. A private deer paid at the door reaches
        // this form settled, and asking again is how a payment gets written down twice.
        if (d.Type === 'Private' && owe && !owe.settled) {
          pay.method = v('pm'); pay.paid = v('pa'); pay.payNote = v('pn');
          if (!pay.method) return err('Choose how the hunter paid.');
          if (pay.paid === '' || !(Number(pay.paid) >= 0)) return err('Enter the amount collected.');
          if (Number(pay.paid) !== owe.owing && !pay.payNote) return err('That isn\'t the $' + owe.owing + ' owing. Say why in the note.');
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
      '<label>Did this deer come through the Island Access Program?</label>' +
      '<label class="choice"><input type="radio" name="iap" value="Yes"> <span><b>Yes</b>: the hunter is enrolled and took it on an enrolled property</span></label>' +
      '<label class="choice"><input type="radio" name="iap" value="No"> <span><b>No</b>: any other hunter</span></label>' +
      '<div class="note ok">Home Ground ID: <b id="genid">enter the date of the shot below</b><br><span class="status">Every deer gets one here, printed on the intake band. It stays with the deer from intake to release.</span></div>' +
      '<label>What is happening to this deer?</label>' +
      '<label class="choice"><input type="radio" name="type" value="Donated"> <span><b>Donated</b> (Share the Harvest). TFMV mails the hunter a check: $' + esc(s.payDoe || 150) + ' a doe, $' + esc(s.payBuck || 100) + ' a buck (any male deer).</span></label>' +
      '<label class="choice"><input type="radio" name="type" value="Private"> <span><b>Private</b>: processed for the hunter, $' + esc(s.privatePrice || 250) + '.</span></label>' +
      '<label class="choice"><input type="radio" name="type" value="Cold storage"> <span><b>Cold storage only</b>: the hunter hangs it and collects it. Not processed. <b>$' + esc(s.coldFee || 35) + '</b>, covering ' + esc(s.coldDays || 7) + ' days \u2014 then $' + esc(s.coldWeekFee || 50) + ' a week. Free if they donate a deer this season.</span></label>' +
      '<div id="feebox" hidden></div>' +
      '<div id="privbox" hidden></div>' +
      (s.porkInStock === false ? '<p class="status" id="porkbox" hidden>Pork fat add-on: not available right now. The grind will be all venison.</p>'
        : '<label class="choice" id="porkbox" hidden><input id="pork" type="checkbox"> <span>Add pork fat to the ground (' + esc(s.fatPrivate || 10) + '%), <b>+$' + esc(s.porkAddOn || 20) + '</b>. Local-farm pork fat, as available. Without it, the grind is all venison.</span></label>') +
      '<label for="deer">Deer</label><select id="deer"><option value="">Choose…</option><option>Doe</option><option>Button buck</option><option>Sub-legal adult male</option><option>Antlered buck</option></select>' +
      '<div id="ptsbox" hidden><label for="pts">Points <span class="hint">count every point 1 inch and longer</span></label><input id="pts" type="number" inputmode="numeric" min="1" max="40" step="1" style="max-width:140px"></div>' +
      /* Antlered bucks only, and deliberately not a tickbox. The head comes off at the skinning
         station and otherwise goes out with the waste, so an unanswered question reads as "no"
         and a rack ends up in the barrel. A rack in the barrel does not come back. Asking the
         hunter while he is standing there costs two seconds (Joe, 7 November). */
      '<div id="skullbox" hidden><label>Does he want the skull and antlers back?</label>' +
      '<label class="choice"><input type="radio" name="skull" value="Yes"> <span><b>Yes</b> — keep the head. It is tagged with the band and set aside at the skinning station.</span></label>' +
      '<label class="choice"><input type="radio" name="skull" value="No"> <span><b>No</b> — the head goes out with the waste.</span></label></div>' +
      // Only the hunter knows this, so it is asked at the door. It decides how hard the wound
      // channel is trimmed later, and it is the one thing that makes the lead question answerable.
      '<div class="grid2"><div><label for="tw">Taken with</label><select id="tw"><option value="">Choose\u2026</option><option>Archery</option><option>Shotgun slug</option><option>Muzzleloader</option><option>Not known</option></select></div>' +
      '<div id="ammobox" hidden><label for="am">Ammunition <span class="hint">lead or copper/solid</span></label><select id="am"><option value="">Choose\u2026</option><option>Lead</option><option>Non-lead</option><option>Not known</option></select></div></div>' +
      '<div class="grid2">' +
      '<div><label for="fn">Hunter first name</label><input id="fn" type="text" autocomplete="off"></div>' +
      '<div><label for="ln">Hunter last name</label><input id="ln" type="text" autocomplete="off"></div>' +
      '<div><label for="lic">MassWildlife customer ID <span class="hint">5 to 8 digits</span></label><input id="lic" type="text" inputmode="numeric" maxlength="8" pattern="[0-9]*"></div>' +
      '<div><label for="ph">Hunter phone</label><input id="ph" type="tel"></div>' +
      '<div><label for="cf">MassWildlife confirmation number</label><input id="cf" type="text"></div>' +
      '<div><label for="sd">Date of the shot <span class="hint">the Home Ground ID is built from it</span></label><input id="sd" type="date" value="' + isoDate(now) + '" max="' + isoDate(now) + '"></div>' +
      '</div>' +
      // Filled in as the name is typed, from hunters the log has already seen. Nothing is entered
      // until it is tapped.
      '<div id="hbox"></div>' +
      // Shown only when the number entered is already on another deer. A seal number belongs to one
      // animal, so this is a mistake nearly every time, but not always: a hunter's lines on somebody
      // else's sheet can repeat, and a backfill has to be able to go through on purpose.
      '<div id="cfdupbox" hidden><label class="choice"><input id="cfdup" type="checkbox"> Use this confirmation number anyway. I have checked the sheet.</label></div>' +
      // Normal check-in is a deer at the door, so this stays out of the way. A deer carried over
      // from an existing cooler arrived days ago, and hours hung has to run from then.
      '<label class="choice"><input id="earlier" type="checkbox"> This deer was already in the cooler before today</label>' +
      '<div id="arrbox" hidden><label for="arr">Arrived at the cooler <span class="hint">hours hung is counted from here</span></label>' +
      '<input id="arr" type="datetime-local"></div>' +
      '<div id="addrbox" hidden><label for="ad1">Hunter mailing address <span class="hint">TFMV mails the donation check here</span></label><input id="ad1" type="text" autocomplete="street-address" placeholder="Street or PO box">' +
      '<div class="grid2"><div><label for="adt">Town</label><input id="adt" type="text"></div><div><label for="ads">State</label><input id="ads" type="text" value="MA" maxlength="2" autocapitalize="characters"></div>' +
      '<div><label for="adz">ZIP</label><input id="adz" type="text" inputmode="numeric" maxlength="10"></div></div>' +
      /* A required field nobody can satisfy gets defeated, not obeyed: every donated row checked in
         before 4 November carries "Na, Na, MA 555555". A deer dropped off out of hours arrives
         without its hunter, so this will keep happening. Record the absence as a fact instead. */
      '<label class="choice"><input id="adna" type="checkbox"> No address to hand <span class="hint">Held on Patrick’s sheet or coming later. Leaves it blank and flags it on the payment list, rather than putting something made up on a cheque.</span></label>' +
      /* TFMV runs hunter payments through payroll, so a cheque waits on a W-4. Sending the link
         while the hunter is standing at the counter beats chasing them for it in January. We send
         the link and nothing else — the completed form goes to TFMV, never to us. */
      '<label for="hem">Hunter email <span class="hint">so we can send the tax form Tick Free MV needs before paying</span></label><input id="hem" type="email" inputmode="email" autocomplete="email" autocapitalize="off">' +
      '<label class="choice"><input id="taxf" type="checkbox" checked> Email them the tax form <span class="hint">A link to the W-4, copied to Tick Free MV. They fill it in and send it back to TFMV, not to us.</span></label></div>' +
      cutsHtml() +
      // Weighed at the door, hide and head on. Not the carcass weight, which is taken at the
      // hanging scale after skinning: two different numbers that must never be mistaken for each
      // other, so each says on its own label what it is.
      '<div class="grid2"><div><label for="iw">Weight (lb) <span class="hint">as it came in, hide and head on</span></label><input id="iw" type="number" inputmode="decimal" min="0" max="500" step="0.1"></div>' +
      '<div><label for="wa">Weighed as</label><select id="wa"><option value="Field dressed">Field dressed</option><option value="Not dressed">Not dressed</option></select></div></div>' +
      '<label class="choice"><input id="fd" type="checkbox"> Field dressed within 4 hours of the shot (or the air stayed below 37°F)</label>' +
      '<label class="choice"><input id="ddp" type="checkbox"> Taken under a deer damage permit (DDP)</label>' +
      '<p class="status">The deer hangs in the receiving cooler skin-on, head-on. It\'s skinned and the head removed inside MHU #1 when processing starts.</p>' +
      '<label for="nt">Notes</label><textarea id="nt"></textarea>' +
      '<div class="err" id="err"></div><button class="submit" id="save">Check in and print band</button>' +
      '<button class="btn ghost" id="away" style="width:100%">Turn this deer away instead</button><div id="awaybox"></div></div>');
    const v = id => document.getElementById(id).value.trim();
    // Every deer: ID = date of the shot (MMDDYYYY) + a two-digit count for that day, e.g. 0908202601
    const genId = () => {
      const sd = v('sd'); if (!sd) return '';
      const [y, m, d] = sd.split('-'), pre = m + d + y;
      const used = deerList().map(x => band(x.Band)).concat(st.outbox.map(x => band((x.fields || {}).band)))
        .filter(x => x.length === 10 && x.indexOf(pre) === 0).map(x => parseInt(x.slice(8), 10) || 0);
      return pre + ('0' + (Math.max(0, ...used) + 1)).slice(-2);
    };
    /* The skull question only arises where the head is going to come off. A hang-only deer is
       never skinned here — it goes back to the hunter whole, antlers and all — so asking would
       invite a "No" that could get a rack binned that was never ours to bin. */
    const skullAsked = () => v('deer') === 'Antlered buck' &&
      ((document.querySelector('input[name=type]:checked') || {}).value || '') !== 'Cold storage';
    const syncSkull = () => {
      const show = skullAsked();
      document.getElementById('ptsbox').hidden = v('deer') !== 'Antlered buck';
      document.getElementById('skullbox').hidden = !show;
      // Changing away clears the answer, so it cannot be saved against a doe because somebody
      // picked the wrong line and then corrected it.
      if (!show) document.querySelectorAll('input[name=skull]').forEach(r => { r.checked = false; });
    };
    document.getElementById('deer').onchange = syncSkull;
    if (!document.getElementById('mrow-css')) { const c = document.createElement('style'); c.id = 'mrow-css';
      c.textContent = '.mrow{width:100%;table-layout:fixed;border-collapse:collapse;margin:10px 0;font-size:15px}.mrow th{text-align:left;font-weight:600;font-size:14px;color:var(--muted);padding:7px 8px 7px 0;width:45%;vertical-align:top;white-space:normal}.mrow td{padding:7px 0;border-bottom:1px solid var(--line);text-align:left;white-space:normal;overflow-wrap:anywhere}.mrow th{border-bottom:1px solid var(--line)}';
      document.head.appendChild(c); }
    const iapNow = () => (document.querySelector('input[name=iap]:checked') || {}).value;
    const showId = () => { document.getElementById('genid').textContent = genId() || 'enter the date of the shot below'; };

    /* A hunter the log has already seen fills himself in as his name is typed: customer ID, phone,
       email and mailing address, straight into the fields, no tap.

       It used to wait for a tap on a suggestion, on the reasoning that a wrong ID filled quietly is
       worse than one typed. Three weeks of check-ins says otherwise \u2014 Joe, 6 November: not one of
       them filled anything, because the suggestion sat below the fold under the shot date and
       nobody tapped what they never saw. A safeguard nobody reaches is not a safeguard. Gabe
       Bellabuono has been through this door seven times and his eight-digit ID has been typed in
       from a phone screen seven times.

       What is kept: it only fills a field that is empty, it never touches the confirmation number,
       the date, the deer or the weights, it says in plain words whose record it came from, one tap
       takes it all back out, and a hunter carrying two different customer IDs in the log still
       fills nothing \u2014 that is the one case where the log does not know the answer. */
    let autoFrom = null, autoIds = [];
    loadHunters().then(() => suggestHunters());

    function clearAuto() {
      autoIds.forEach(id => { const el = document.getElementById(id); if (el) el.value = id === 'ads' ? 'MA' : ''; });
      autoIds = []; autoFrom = null;
    }
    // Fills blanks only. A field the counter typed into is theirs, and one we filled earlier is
    // ours to correct \u2014 which is what lets a half-typed name that matched the wrong hunter undo
    // itself as the rest of the name arrives.
    function put(id, val) {
      const el = document.getElementById(id);
      if (!el || !val) return;
      if (el.value.trim() && autoIds.indexOf(id) < 0) return;
      el.value = val;
      if (autoIds.indexOf(id) < 0) autoIds.push(id);
    }
    function fillFrom(h) {
      const split = (h.otherIds || []).length;          // two IDs on file: the log is not sure, so nor are we
      put('fn', h.first); put('ln', h.last);
      if (!split) put('lic', h.id);
      put('ph', h.phone); put('hem', h.email);
      const a = splitAddress(h.address);
      if (a) { put('ad1', a.street); put('adt', a.town); put('ads', a.state); put('adz', a.zip); }
      autoFrom = h;
      return split;
    }

    function suggestHunters() {
      const box = document.getElementById('hbox');
      if (!box) return;
      // Anything we filled from a hunter who no longer matches what is typed goes back out first,
      // so a wrong ID cannot survive the rest of the name being typed.
      if (autoFrom) {
        const still = hunterMatches(v('fn'), v('ln')).some(h => h.name === autoFrom.name);
        if (!still) clearAuto();
      }
      const hits = hunterMatches(v('fn'), v('ln'));
      if (!hits.length) { box.innerHTML = ''; return; }

      if (hits.length === 1) {
        const h = hits[0], split = fillFrom(h);
        box.innerHTML =
          '<div class="note ok"><b>' + esc(h.name) + '</b> \u2014 filled in from ' +
          (h.lastSeen ? 'the check-in on ' + esc(h.lastSeen) : 'the last check-in') + '. ' +
          h.deer + (h.deer === 1 ? ' deer' : ' deer') + ' through here. ' +
          'Check the customer ID against their licence before you save.' +
          '<button class="plain" id="hundo" style="margin-top:6px">Not them \u2014 clear it</button></div>' +
          (split
            ? '<div class="note bad">' + esc(h.name) + ' has more than one customer ID in the log: <b>' +
              esc([h.id].concat(h.otherIds).join('</b> and <b>')) + '</b>. One is a typo, so the ID has ' +
              'been left blank. Ask them which it is, and fix the other rows.</div>'
            : '');
        const u = document.getElementById('hundo');
        if (u) u.onclick = () => { clearAuto(); box.innerHTML = ''; };
        return;
      }

      // More than one. The log cannot choose between them and neither can we, so it stays a tap.
      clearAuto();
      box.innerHTML = '<p class="status">More than one hunter matches \u2014 tap the right one:</p>' +
        hits.map((h, i) =>
          '<button class="btn ghost" data-h="' + i + '" style="width:100%;text-align:left">' +
          '<b>' + esc(h.name) + '</b>' + (h.id ? ' \u00b7 ' + esc(h.id) : ' \u00b7 no customer ID on file') +
          '<br><span class="status">' + h.deer + (h.deer === 1 ? ' deer' : ' deer') +
          (h.lastSeen ? ', last on ' + esc(h.lastSeen) : '') +
          (h.address ? ' \u00b7 ' + esc(h.address) : '') + '</span></button>').join('');
      box.querySelectorAll('[data-h]').forEach(b => b.onclick = () => {
        const h = hits[+b.dataset.h];
        fillFrom(h);
        box.innerHTML = '<div class="note ok">Filled in from ' + esc(h.name) + '\u2019s last check-in. ' +
          'Check the customer ID against their licence before you save.</div>';
      });
    }
    ['fn', 'ln'].forEach(id => { const el = document.getElementById(id); if (el) el.oninput = suggestHunters; });
    document.querySelectorAll('input[name=iap]').forEach(r => r.onchange = showId);
    document.getElementById('sd').onchange = showId;
    document.getElementById('tw').onchange = e => {
      const fire = e.target.value === 'Shotgun slug' || e.target.value === 'Muzzleloader';
      document.getElementById('ammobox').hidden = !fire;
      if (!fire) document.getElementById('am').value = '';
    };
    // Revealed only when asked for, and pre-filled with the shot date so a backfill is one tap and
    // a time rather than a whole date typed in again.
    document.getElementById('earlier').onchange = e => {
      const box = document.getElementById('arrbox'), arr = document.getElementById('arr');
      box.hidden = !e.target.checked;
      if (e.target.checked && !arr.value) arr.value = (v('sd') || isoDate(now)) + 'T12:00';
    };
    /* Custom processing is settled at the door from 6 November. The deer is still taken either
       way — a hunter is never turned round over money — but it hangs rather than going on the
       bench, and that is said here, in front of them, rather than discovered later. */
    function showPrivBox() {
      const pb = document.getElementById('privbox');
      if (!pb) return;
      const pork = document.getElementById('pork');
      const price = Number(s.privatePrice || 300) + ((pork && pork.checked) ? Number(s.porkAddOn || 20) : 0);
      const keep = (document.getElementById('ppay') || {}).value || '';
      pb.innerHTML =
        '<div class="note warn" style="font-size:17px"><b>$' + price + ' for custom processing</b>' +
        ((pork && pork.checked) ? ', including the pork fat add-on' : '') +
        '. <b>Due before it is cut.</b> We will still take the deer and hang it, but it does not go ' +
        'on the bench until it is paid — and the deer that have paid go first.</div>' +
        '<label for="ppay">Paying now?</label><select id="ppay">' +
        '<option value="">Not yet — due before processing starts</option>' +
        (s.payMethods || ['Cash', 'Card (Square)', 'Check']).map(x =>
          '<option' + ('Paying now — ' + x === keep ? ' selected' : '') + '>Paying now — ' + esc(x) + '</option>').join('') +
        '</select>' +
        '<p class="status">On the card reader: choose Card (Square) here to write it down, or open the ' +
        'deer straight after and tap <b>Take $' + price + '</b> to hand the amount to Square itself.</p>';
      if (keep) pb.querySelector('#ppay').value = keep;
    }
    document.querySelectorAll('input[name=type]').forEach(r => r.onchange = () => {
      const t = (document.querySelector('input[name=type]:checked') || {}).value;
      document.getElementById('porkbox').hidden = t !== 'Private';
      document.getElementById('addrbox').hidden = t !== 'Donated';
      document.getElementById('cutbox').hidden = t !== 'Private';
      const fb = document.getElementById('feebox');
      fb.hidden = t !== 'Cold storage';
      const pb = document.getElementById('privbox');
      pb.hidden = t !== 'Private';
      if (t === 'Private') showPrivBox();
      if (t === 'Cold storage') checkFee();
      syncSkull();
    });
    // The add-on moves the price, so the figure the hunter is being quoted has to move with it.
    { const pk = document.getElementById('pork'); if (pk) pk.onchange = showPrivBox; }
    /* Two things to settle at the counter before a hang-only deer is taken, and they are separate
       questions. Is there room for it at all — donated and private deer come first, and above the
       squeeze this one does not come in at all. And what does the hunter owe, which is nothing if
       they have donated this season. Both are checked live, so whoever is on the door says a
       number rather than a guess. */
    let feeState = null;
    async function checkFee() {
      const fb = document.getElementById('feebox');
      const s = S();
      fb.innerHTML = '<p class="status">Checking the cooler…</p>';
      try {
        const out = await call({ action: 'coldgate' });
        feeState = out;
        const gate = !out.ok
          ? '<div class="note bad"><b>The cooler is ' + out.pct + '% full and is not taking hang-only deer.</b> ' +
            'Donated and privately processed deer still come in. Offer them donation or private processing, ' +
            'or ask them to come back. If they say no, log it as turned away.</div>'
          : out.gated
            ? '<div class="note warn"><b>The cooler is ' + out.pct + '% full.</b> A manager has to approve a hang-only deer at this point.</div>'
            : '';
        const forfeitAt = (s.coldDays || 7) + (s.coldForfeitDays || 7);
        const late = out.open === false;
        fb.innerHTML = gate +
          '<div class="note"><b>$' + (s.coldFee || 50) + '</b> covers ' + (s.coldDays || 7) + ' days, then $' +
          (s.coldWeekFee || 50) + ' a week. They get a text on day ' + (s.coldRemindDays || 5) +
          ' to collect within 48 hours. <b>Free if they donate a deer this season.</b></div>' +
          (late && s.coldPassCallout
            ? '<div class="note warn"><b>Outside posted hours, so the $' + (s.calloutFee || 40) +
              ' call-out is added</b> — somebody came in specially for this deer. Tick below if it was not a special trip.' +
              '<label class="choice"><input type="checkbox" id="nocallout"> <span>Not a call-out — we were here anyway</span></label></div>'
            : '') +
          /* Payment is DUE at collection, not now. "Bill it and chase them" was the wrong frame:
             it made an unpaid deer sound like a debt going bad on the day it arrived, when in
             fact nothing is late until they come back for it. They may pay early if they want to. */
          '<label for="feemethod">Paying now? <span class="hint">Optional — it is due when they collect the deer</span></label>' +
          '<select id="feemethod">' +
          '<option value="">Due at collection</option>' +
          (s.payMethods || ['Cash', 'Card (Square)', 'Check']).map(x => '<option>Paying now — ' + esc(x) + '</option>').join('') +
          '</select>' +
          '<p class="status">Say it out loud at the counter: uncollected after ' + forfeitAt +
          ' days and the deer is donated. It is on the drop-off slip and they have to agree to it, ' +
          'or it does not bind.</p>';
      } catch (e) {
        fb.innerHTML = '<p class="status">Couldn\'t check the cooler' + (e.offline ? ' (no signal)' : '') +
          '. Take the deer — the charge is raised automatically and Cold storage will show it.</p>';
        feeState = null;
      }
    }
    ['fn', 'ln', 'lic'].forEach(id => { const el = document.getElementById(id); if (el) el.onblur = () => {
      if (((document.querySelector('input[name=type]:checked') || {}).value) === 'Cold storage') checkFee(); }; });
    const err = m => { document.getElementById('err').textContent = m; };
    document.getElementById('save').onclick = () => {
      const type = (document.querySelector('input[name=type]:checked') || {}).value;
      const iap = iapNow();
      if (!iap) return err('Say whether it\'s an Island Access Program (IAP) deer.');
      if (!v('sd')) return err('Enter the date of the shot: the Home Ground ID is built from it.');
      const b = genId();
      if (!b) return err('Enter the date of the shot: the Home Ground ID is built from it.');
      if (deerList().some(d => band(d.Band) === b && d.Status !== 'Released')) return err('Band ' + b + ' is already in the cooler.');
      if (!type) return err('Choose donated, private or cold storage only.');
      if (!v('deer')) return err('Choose doe, button buck, sub-legal adult male or antlered buck.');
      const pts = parseInt(v('pts'), 10);
      if (v('deer') === 'Antlered buck' && !(pts >= 1 && pts <= 40)) return err('Count the points 1 inch and longer and enter the number.');
      const skullPick = (document.querySelector('input[name=skull]:checked') || {}).value;
      if (skullAsked() && !skullPick) {
        return err('Ask him whether he wants the skull and antlers back. Once the head goes out with the waste it is gone, so this one is not left blank.');
      }
      if (!v('fn') || !v('ln')) return err('Enter the hunter\'s first and last name.');
      const lic = v('lic').replace(/\D/g, '');
      if (lic && (lic.length < 5 || lic.length > 8)) return err('The MassWildlife customer ID is 5 to 8 digits.');
      if (type === 'Donated' && !lic) return err('Enter the hunter\'s MassWildlife customer ID. Martin needs it for donated deer.');
      const noAddr = (document.getElementById('adna') || {}).checked;
      if (type === 'Donated' && !noAddr && (!v('ad1') || !v('adt') || !v('adz'))) return err('Enter the hunter\'s mailing address (street, town and ZIP), or tick "No address to hand". TFMV mails the donation check there.');
      if (!v('tw')) return err('Say how the deer was taken. It decides how hard the wound channel is trimmed.');
      if ((v('tw') === 'Shotgun slug' || v('tw') === 'Muzzleloader') && !v('am')) return err('Lead or non-lead? Ask the hunter \u2014 it changes how the meat is trimmed.');
      if (!v('cf')) return err('Enter the MassWildlife confirmation number. No confirmation number, no intake.');
      /* The confirmation number is the state's seal for one animal. Backfilling a season off another
         processor's sheet is where this goes wrong: a hunter's name appears several times, the first
         number under it gets used twice, and nobody finds out until packages have shipped under a
         duplicated seal. Caught here it costs five seconds. Caught later it costs a phone call to
         MassWildlife. The list includes check-ins still queued offline, so it holds without signal. */
      const cfv = v('cf').trim().toUpperCase();
      const cfdup = document.getElementById('cfdup'), cfbox = document.getElementById('cfdupbox');
      const clash = deerList().find(d => String(d['MassWildlife confirmation'] || '').trim().toUpperCase() === cfv);
      if (clash && !(cfdup && cfdup.checked)) {
        if (cfbox) cfbox.hidden = false;
        return err('Confirmation ' + v('cf') + ' is already on band ' + band(clash.Band) + ' (' +
          (clash['Hunter name'] || 'no name recorded') + '). A seal number belongs to one deer. Check the sheet \u2014 ' +
          'if this hunter brought in more than one, each has its own number.');
      }
      if (type === 'Donated' && !document.getElementById('fd').checked) return err('Donated deer must be field dressed within 4 hours of the shot.');
      if (type !== 'Donated' && coolerCount() >= S().coolerCap) return err('The cooler is full. Hold private and cold-storage deer until there\'s room.');
      const noCall = document.getElementById('nocallout');
      const f = { band: b, iap: iap === 'Yes', type, deer: v('deer'), points: v('deer') === 'Antlered buck' ? pts : '', firstName: v('fn'), lastName: v('ln'), customerId: lic, hunterPhone: v('ph'), confirmation: v('cf'), takenWith: v('tw'), ammunition: v('am'),
        skull: skullAsked() ? skullPick === 'Yes' : undefined,
        notCallout: !!(noCall && noCall.checked),
        cuts: type === 'Private' ? readCuts() : '',
        address: (type === 'Donated' && !noAddr) ? v('ad1') + ', ' + v('adt') + ', ' + (v('ads') || 'MA').toUpperCase() + ' ' + v('adz') : '',
        hunterEmail: v('hem').trim(),
        // Only meaningful on a donated deer, and only if we actually have somewhere to send it.
        sendTaxForm: type === 'Donated' && !!(document.getElementById('taxf') || {}).checked && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v('hem').trim()),
        shotDate: v('sd'),
        arrived: document.getElementById('earlier').checked ? v('arr') : '',
        dressed4h: document.getElementById('fd').checked, ddp: document.getElementById('ddp').checked, skinned: false,
        notes: (v('nt') + (clash ? ' [confirmation also on band ' + band(clash.Band) + ', entered on purpose]' : '')).trim(),
        intakeWeight: v('iw'), weighedAs: document.getElementById('wa').value,
        porkFat: type === 'Private' && !!document.getElementById('pork') && document.getElementById('pork').checked };
      queue('intake', f, 'Check-in ' + b);
      /* The hunter roster is cached for six hours, which is fine for a hunter who was here last
         week and useless for the one standing in front of you with a second deer. A check-in is
         exactly the event that makes the cache wrong, so refresh it on the spot. */
      loadHunters(true).catch(() => {});
      /* Paying is a separate transaction from the deer and is never a condition of taking it in.
         The charge is raised by the check-in itself, so an unpaid deer is a row on the Cold
         storage screen rather than an argument at the counter. This only fires when they paid
         there and then, and it is queued like everything else so a dead signal doesn't lose it. */
      const meth = document.getElementById('feemethod');
      if (type === 'Cold storage' && meth && meth.value) {
        // The option text carries the method after an em dash; send the method itself.
        queue('payfee', { band: b, method: meth.value.replace(/^.*—\s*/, '') }, 'Storage charge ' + b);
      }
      /* Queued behind the check-in, not with it, for the same reason the storage charge is: the
         deer and the money are two facts, and one of them failing must not take the other down. */
      const pmeth = document.getElementById('ppay');
      if (type === 'Private' && pmeth && pmeth.value) {
        queue('paydeer', { band: b, method: pmeth.value.replace(/^.*—\s*/, '') }, 'Processing payment ' + b);
      }
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
  /* What a scan is FOR, from 8 November: taking a deer out of the cooler (Joe). Urgency is read
     off the band colour and the board, so the scan no longer needs to be a lookup.

     It opens the deer's own card with the right form already open rather than writing anything by
     itself. That matters: bands hang inches apart in a dim cooler and a camera grabs whichever it
     sees first, so the hunter's name, the type and where it is now are on screen above the form,
     and a person still presses Save. It also keeps one door for the money — a cold-storage deer
     goes out through the release form, which asks who collected it, rather than a second quiet
     path around the front desk. */
  const outAction = d => {
    if (!d || d.Status === 'Released' || d.Status === 'Voided') return '';
    if (d.Type === 'Cold storage') return d.Status === 'Hanging' ? 'release' : '';
    if (d.Status === 'Ready') return 'release';
    if (d.Status === 'Hanging' || d.Status === 'Processing') return 'move';
    return '';
  };

  function showDeer(b, fromScan) {
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
    // Arrived from a scan: open the form for what you are plainly about to do. Clicking the real
    // button rather than calling act() keeps the clock-in nudge and everything else that hangs
    // off it.
    if (fromScan) {
      const auto = outAction(d);
      const btn = auto && c.querySelector('[data-a="' + auto + '"]');
      if (btn) btn.click();
    }
  }
  let scanStream = null;
  function stopScan() { if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; } }
  async function showScan() {
    frame('scan', 'Scan a band', '<div class="card"><p class="status">Point the camera at the QR code on the band. For a deer coming out of the cooler this opens the move straight away; a hang-only deer opens the collection form. Check the name before you save \u2014 bands hang close together.</p>' +
      '<video id="sv" playsinline muted style="width:100%;border-radius:12px;background:#000"></video><canvas id="sc" hidden></canvas><div id="sm"></div>' +
      '<label for="sb">Or type the band number</label><input id="sb" type="text" autocapitalize="characters"><button class="btn" id="sg" style="margin-top:8px">Open</button></div>');
    const msg = h => { document.getElementById('sm').innerHTML = h; };
    document.getElementById('sg').onclick = () => { const v = document.getElementById('sb').value.trim(); if (v) { stopScan(); showDeer(v, true); } };
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
        if (m) { stopScan(); return showDeer(decodeURIComponent(m[1]), true); }
        if (r) msg('<div class="note warn">That QR code isn\'t a Home Ground band.</div>');
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /* ---------- booking your time (start and end, first come first served) ---------- */
  const toMin = hm => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + (m || 0); };
  const fromMin = n => Math.floor(n / 60) + ':' + pad(n % 60);
  let bookDay = null, bookPick = null, bookKind = 'Processing';
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

  const s2 = S;
  async function showShifts(data, msg, kind) {
    bookCss();
    if (kind) bookKind = kind === 'Skinning' ? 'Skinning' : 'Processing';
    const skinning = bookKind === 'Skinning';
    frame('shifts', skinning ? 'Book skinning time' : 'Book your time', '<div id="sched"><p class="status">Loading…</p></div>');
    const box = document.getElementById('sched');
    try { if (!data) data = await call({ action: 'shifts', kind: bookKind }); }
    catch (e) { box.innerHTML = '<div class="note bad">' + esc(e.offline ? 'Booking needs signal.' : e.message) + '</div>'; return; }
    if (data.kind) bookKind = data.kind;
    if (st.home && data.myShifts) { st.home.myShifts = data.myShifts; save(); }   // keep Home's "Next booking" current
    if (st.home && data.skinRoom) { st.home.skinRoom = data.skinRoom; save(); }
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

    const room = data.skinRoom || { room: 0, cap: 0, hanging: 0 };
    box.innerHTML =
      '<div class="tabs"><button data-kind="Processing"' + (skinning ? '' : ' class="on"') + '>Processing</button>' +
      '<button data-kind="Skinning"' + (skinning ? ' class="on"' : '') + '>Skinning</button></div>' +
      (msg ? '<div class="note ' + (msg.bad ? 'bad' : 'ok') + '">' + esc(msg.text) + '</div>' : '') +
      /* The limit on skinning ahead is hanging space for the skinned carcass, which is MHU-2's
         cooler portion first and MHU-1's after it — not MHU #1 alone, which is what this used to
         say. The split is shown because the person reading it is deciding where to put the next
         one. */
      (skinning ? '<div class="note ' + (room.room <= 0 ? 'bad' : room.room <= 2 ? 'warn' : 'ok') + '">' +
        (room.room <= 0 ? '<b>Nowhere to hang another carcass.</b> MHU-2 and MHU-1 are holding ' + room.hanging +
            ' between them. Nothing more can be skinned ahead until some are processed.'
          : 'Hanging space: <b>' + room.hanging + ' of ' + room.cap + '</b> used' +
            (room.mhu2 === undefined ? '' : ' (MHU-2 ' + room.mhu2 + ', MHU-1 ' + room.mhu1 + ')') +
            ' · room for ' + room.room + ' more.') + '</div>' : '') +
      '<div class="card"><b>Your bookings</b>' + (mine.length ? mine.map(x => '<div class="who"><div>' + esc(dayName(x.date)) + ' · ' + t12(x.starts) + '–' + t12(x.ends) +
        (x.kind === 'Skinning' ? ' <span class="tag">SKINNING</span>' : '') + '</div>' +
        '<button class="btn ghost" data-cancel="' + esc(x.id) + '">Cancel</button></div>').join('') : '<div class="status">None booked.</div>') +
      '<div class="status" style="margin-top:6px">Pick your own start and end time. First come, first served: no more than ' + max + ' ' +
      (skinning ? 'skinners' : 'processors') + ' booked at the same moment' +
      (skinning ? ', and skinning places are separate from processing places' : '') +
      '. Cancel any time before you start. Clock in when you arrive.' +
      (skinning ? ' Skinning is paid at $' + esc(s2().skinRate || 25) + ' a deer skinned.' : '') +
      '</div></div>' +
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
      (startOpts.length && !(skinning && room.room <= 0) ? '<div class="card"><b>Book ' + (skinning ? 'skinning time' : 'a time') + ' on ' + esc(dayName(bookDay)) + '</b>' +
        '<div class="pickrow"><label>Start<select id="bk-s">' + opt(startOpts, bookPick.start) + '</select></label><label>End<select id="bk-e">' + opt(endOpts, bookPick.end) + '</select></label></div>' +
        '<div id="bk-msg"></div><button class="btn wide" id="bk-go" style="width:100%;margin-top:10px">Book</button>' +
        (isMgr() ? '<button class="plain" id="bk-cover">Ask for ' + (skinning ? 'skinners' : 'cover') + ' for this time</button>' : '') + '<div id="bk-sugg" class="sugg"></div></div>'
        : skinning && room.room <= 0 ? '<div class="card"><div class="status">Book processing time instead: that is what frees MHU #1 up.</div></div>'
        : '<div class="card"><div class="status">Booking for today has closed. Pick another day above.</div></div>');
    box.querySelectorAll('[data-kind]').forEach(b => b.onclick = () => { if (b.dataset.kind !== bookKind) { bookKind = b.dataset.kind; bookPick = null; showShifts(); } });

    const go = async (b, body, done) => {
      if (b) b.disabled = true;
      try { const out = await call(body); if (done) done(out); }
      catch (e) { if (b) b.disabled = false; toast(e.offline ? 'Needs signal.' : e.message); }
    };
    const book = (b, pick) => go(b, { action: 'book', date: pick.date, start: pick.start, end: pick.end, kind: bookKind }, out => {
      if (out.conflict) {   // someone got there first: show the server's view and its alternatives
        bookDay = pick.date; bookPick = pick;
        showShifts(out, { bad: true, text: out.conflict.message + ' Pick one of the open times below.' }, bookKind);
        setTimeout(() => sugg(out.conflict.suggestions), 0);
        return;
      }
      bookPick = null;
      showShifts(out, { text: (bookKind === 'Skinning' ? 'Skinning booked: ' : 'Booked: ') + dayName(out.booked.date) + ', ' + t12(out.booked.start) + '–' + t12(out.booked.end) + '.' }, bookKind);
    });
    box.querySelectorAll('[data-day]').forEach(b => b.onclick = () => { bookDay = b.dataset.day; showShifts(data, null, bookKind); });
    box.querySelectorAll('[data-cancel]').forEach(b => b.onclick = () => { if (confirmCancel()) go(b, { action: 'cancel', id: b.dataset.cancel }, out => showShifts(out, { text: 'Cancelled.' }, out.kind)); });
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
    if (cov) cov.onclick = () => go(cov, { action: 'cover', date: bookPick.date, start: bookPick.start, end: bookPick.end, kind: bookKind }, out => { cov.textContent = 'Sent to ' + out.sent + ' phone' + (out.sent === 1 ? '' : 's'); });
  }
  const confirmCancel = () => true;
  /** Donated deer: reserve the next MassWildlife package number before grinding.

      This used to replace the whole form with a red box when it failed, which left Graham on
      6 November standing at the bench with a deer he could not finish and a panel with no buttons
      on it: the only escape was to leave the deer and come back, which dropped him straight into
      the same branch again. A failure has to leave a way forward, always. So: the error, a Try
      again, a way back to the finish form, and — when another donated deer really is holding the
      numbers — its band and a button straight to it, because "finish that one first" is no use to
      somebody who cannot see which one it is. */
  async function grind(d, box, after) {
    const back = () => act('finish', d, box, after);
    box.innerHTML = '<p class="status">Getting package numbers…</p>' +
      '<button class="btn ghost" id="gx" style="margin-top:10px">Cancel</button>';
    { const x = document.getElementById('gx'); if (x) x.onclick = back; }
    try {
      const out = await call({ action: 'grind', band: d.Band });
      (st.home.deer || []).forEach(x => { if (band(x.Band) === band(out.band) && x.Status !== 'Released') x['First pack #'] = out.first; });
      st.home.packs = { next: st.home.packs && st.home.packs.next, grinder: { band: band(out.band), first: out.first } };
      save(); (after || showBoard)();
      toast('Label packages from ' + out.first + ', in order.', true);
    } catch (e) {
      // The backend names the blocking deer in its message; pull the band back out of it so the
      // way to that deer can be one tap rather than a hunt through the board.
      const m = /Band (\d{10}) is on the grinder/.exec(e.message || '');
      box.innerHTML = '<div class="note bad">' +
        esc(e.offline ? 'Package numbers need signal — they are drawn from the state’s sequence, so they cannot be given out offline. The deer stays on the bench; try again when you are connected.' : e.message) +
        '</div>' +
        (m ? '<button class="btn" id="gother">Open ' + esc(m[1]) + '</button> ' : '') +
        '<button class="btn" id="gretry">Try again</button> ' +
        '<button class="btn ghost" id="gback">Back to finishing ' + esc(band(d.Band)) + '</button>';
      const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
      on('gother', () => showDeer(m[1]));
      on('gretry', () => grind(d, box, after));
      on('gback', back);
    }
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


  /* ---------- drop-offs: a deer on its way ----------
   * Hunters dropping deer off are not Home Ground members and never will be: no app, no account.
   * They text the published number, and somebody has to meet them. This is the bit of the app that
   * makes sure that somebody exists.
   *
   * Raise it, everyone gets it, first to want it takes it. Nobody takes it and after a few minutes
   * it is the on-call person's by name — because "whoever is interested" is a good way to fill a
   * job and a bad way to guarantee one.
   */
  function dropCardsHtml() {
    const d = st.home.drops;
    if (!d || !(d.open || []).length) return '';
    return d.open.map(x => {
      const who = x.hunter || x.phone || 'A hunter';
      const claimed = x.status === 'Claimed';
      return '<div class="card alert ' + (claimed ? 'amber' : 'red') + '">' +
        '<b>' + (claimed ? (x.mine ? 'You are meeting ' : esc(first(x.claimedName)) + ' is meeting ') : 'Deer coming in: ') + esc(who) + '</b>' +
        (x.deer || x.comingAt ? '<div>' + esc([x.deer, x.comingAt].filter(Boolean).join(' · ')) + '</div>' : '') +
        (x.note ? '<div>' + esc(x.note) + '</div>' : '') +
        '<div class="status">' + esc(x.minsAgo === null ? '' : x.minsAgo < 2 ? 'just now' : x.minsAgo + ' min ago') +
        ' · raised by ' + esc(x.raisedBy) +
        (x.phone && (claimed ? x.mine : true) ? ' · <a href="tel:' + esc(x.phone.replace(/[^\d+]/g, '')) + '">' + esc(x.phone) + '</a>' : '') +
        (x.escalated && !claimed ? ' · <b>nobody has taken this</b>' : '') +
        (claimed && x.callout ? ' · call-out' : '') + '</div>' +
        '<div class="actions">' +
        (!claimed ? '<button class="btn" data-claim="' + esc(x.id) + '">I\'ll take it</button>' : '') +
        (x.mine || d.manager ? '<button class="btn ghost" data-dropcancel="' + esc(x.id) + '">Cancel</button>' : '') +
        '</div>' +
        (!claimed && !d.onSite ? '<div class="status">Not clocked in, so this would be a call-out: $' + d.calloutFee + ' flat.</div>' : '') +
        '</div>';
    }).join('');
  }
  function wireDrops(box) {
    (box || $app).querySelectorAll('[data-claim],[data-dropcancel]').forEach(b => b.onclick = async () => {
      b.disabled = true;
      const cancelling = !!b.dataset.dropcancel;
      let why = '';
      if (cancelling) { why = prompt('Why is it being cancelled?', 'Hunter didn\'t come') || ''; if (!why) { b.disabled = false; return; } }
      try {
        const out = await call(cancelling ? { action: 'canceldrop', id: b.dataset.dropcancel, why: why } : { action: 'claimdrop', id: b.dataset.claim });
        st.home.drops = out; save();
        showHome(cancelling ? 'Cancelled.' : 'It\'s yours. Check the deer in when it arrives and this closes itself.');
        refresh(true);
      } catch (e) { b.disabled = false; toast(e.offline ? 'Needs signal.' : e.message); }
    });
  }

  /** Raise one: a hunter has texted or rung. Anyone on staff can, because they might text anyone. */
  function showRaiseDrop() {
    const d = st.home.drops || {};
    const w = d.nextWindow;
    frame('raisedrop', 'A deer is coming in',
      '<div class="note ok">This notifies everyone on the team. Whoever is free takes it. If nobody does within ' +
      (d.escalateAfter || 10) + ' minutes it goes to whoever is on call' + (d.onCall ? ' (' + esc(first(d.onCall.name)) + ' today)' : ', and if nobody is on call, to the managers') + '.</div>' +
      (d.inWindow ? '<div class="note ok">Inside the posted drop-off hours, so somebody should already be there.</div>'
        : w ? '<div class="note warn">Outside the posted hours. Whoever goes gets the $' + d.calloutFee + ' call-out fee.' +
          ' If the deer can wait, the next window is ' + esc(w.day) + ' ' + t12(w.start) + ' to ' + t12(w.end) + '.</div>' : '') +
      '<label for="dhunter">Hunter\'s name</label><input id="dhunter" maxlength="60" autocomplete="off">' +
      '<label for="dphone">Their number <span class="hint">So whoever goes can reach them</span></label><input id="dphone" type="tel" maxlength="24" autocomplete="off">' +
      '<label for="dwhen">When are they coming? <span class="hint">Optional</span></label><input id="dwhen" maxlength="40" placeholder="e.g. in 20 minutes, or 5:30" autocomplete="off">' +
      '<label for="ddeer">Deer <span class="hint">Optional</span></label><input id="ddeer" maxlength="40" placeholder="e.g. doe, or 2 deer" autocomplete="off">' +
      '<label for="dsrc">How did they reach us?</label><select id="dsrc">' +
      ['Text', 'Phone call', 'In person', 'Email'].map(x => '<option>' + x + '</option>').join('') + '</select>' +
      '<label for="dnote">Anything else <span class="hint">Optional</span></label><textarea id="dnote" maxlength="300"></textarea>' +
      '<div id="err" class="err"></div><button class="submit" id="draise">Tell the team</button>');
    document.getElementById('draise').onclick = async () => {
      const b = document.getElementById('draise');
      const f = { hunter: document.getElementById('dhunter').value.trim(), phone: document.getElementById('dphone').value.trim(),
        comingAt: document.getElementById('dwhen').value.trim(), deer: document.getElementById('ddeer').value.trim(),
        source: document.getElementById('dsrc').value, note: document.getElementById('dnote').value.trim() };
      if (!f.hunter && !f.phone) { document.getElementById('err').textContent = 'Give their name or their number, so whoever goes knows who to look for.'; return; }
      b.disabled = true; b.textContent = 'Sending…';
      try { const out = await call({ action: 'raisedrop', fields: f }); st.home.drops = out; save();
        showHome('The team has been told. You\'ll see who takes it.'); refresh(true); }
      catch (e) { b.disabled = false; b.textContent = 'Tell the team';
        document.getElementById('err').textContent = e.offline ? 'No signal, so nobody was told. Ring someone.' : e.message; }
    };
  }

  /* What the last 30 days say about whether any of this is working. Each share gets the reading
     that matters, because a number on its own invites the wrong fix: a high call-out share is
     answered by booking shifts, not by paying more per trip. */
  function last30Html(d) {
    const n = d.last30;
    if (!n || !n.drops) return '';
    const pc = a => Math.round((a / n.drops) * 100);
    const co = pc(n.callouts), es = pc(n.escalated);
    return '<div class="note ' + (co >= 34 || es >= 25 ? 'warn' : 'ok') + '" style="margin:8px 0">' +
      '<b>Last 30 days: ' + n.drops + ' drop-off' + (n.drops === 1 ? '' : 's') + '.</b>' +
      '<div class="status">' + n.callouts + ' were call-outs (' + co + '%)' +
      (co >= 34 ? ' \u2014 most deer are arriving when nobody is booked. Shift cover fixes that, not a bigger call-out fee.' : '.') + '</div>' +
      '<div class="status">' + n.escalated + ' went unclaimed and escalated (' + es + '%)' +
      (es >= 25 ? ' \u2014 nobody is getting in the truck. That is what the $' + d.calloutFee + ' is meant to buy.' : '.') + '</div></div>';
  }

  /* Whether the posted windows on a day already have somebody booked. A day rostered for standby
     that is also fully covered is being paid for twice. */
  function coverHtml(x) {
    if (!x.cover) return '';
    const gap = (x.uncovered || []).map(u => t12(u.start) + '\u2013' + t12(u.end)).join(', ');
    if (x.cover === 'full') return '<div class="status">Covered by booked shifts' + (x.rostered ? ' \u2014 standby not needed' : '') + '.</div>';
    if (x.cover === 'part') return '<div class="status">Part-covered \u2014 no shifts booked ' + esc(gap) + '.</div>';
    return '<div class="status">No shifts booked' + (gap ? ' ' + esc(gap) : '') + '.</div>';
  }

  /** The on-call rota: a name against every day, so "nobody clicked" cannot happen. */
  async function showOnCall() {
    frame('oncall', 'On call', '<div id="oc"><p class="status">Loading…</p></div>');
    let d;
    try { d = await call({ action: 'oncall' }); }
    catch (e) { document.getElementById('oc').innerHTML = '<div class="note bad">' + esc(e.offline ? 'Needs signal.' : e.message) + '</div>'; return; }
    const box = document.getElementById('oc');
    const gaps = d.gaps === undefined ? d.days.filter(x => !x.number).length : d.gaps;
    box.innerHTML =
      '<div class="card"><b>What on call means</b><div class="status">If a deer needs checking in and nobody else takes it within a few minutes, it is yours. Standby is $' + d.standby +
      ' for the day whether or not a deer comes, and if you do go out it is the $' + d.calloutFee + ' call-out fee instead of the intake fee.' +
      (d.windows.length ? ' Posted drop-off hours are ' + esc(d.windows.map(w => t12(w.start) + '–' + t12(w.end)).join(', ')) + '.' : '') + '</div></div>' +
      (d.backstop
        ? '<div class="note ' + (d.backstop.firedLast30 > 3 ? 'warn' : 'ok') + '"><b>Backstop: ' + esc(d.backstop.name) + '.</b> ' +
          'Any day with nobody rostered falls to ' + esc(first(d.backstop.name)) + '. ' +
          (d.backstop.firedLast30
            ? 'That has happened <b>' + d.backstop.firedLast30 + ' time' + (d.backstop.firedLast30 === 1 ? '' : 's') + ' in the last 30 days</b>. ' +
              (d.backstop.firedLast30 > 3 ? 'The rota is doing the opposite of its job \u2014 fill the days in.' : '')
            : 'It has not had to happen in the last 30 days.') + '</div>'
        : gaps ? '<div class="note ' + (d.days[0].number ? 'warn' : 'bad') + '"><b>' + gaps + ' of the next 14 days ' + (gaps === 1 ? 'has' : 'have') + ' nobody on call.</b> An unclaimed deer on those days falls to the managers.</div>' : '') +
      (gaps && d.backstop ? '<div class="status" style="margin:8px 0">' + gaps + ' of the next 14 days ' + (gaps === 1 ? 'has' : 'have') + ' nobody rostered.</div>' : '') +
      last30Html(d) +
      '<div class="card">' + d.days.map(x =>
        '<div class="trow"><div><b>' + esc(dayName(x.date)) + '</b>' +
        coverHtml(x) +
        (x.name ? '' : '<div class="status">' + (d.backstop ? esc(first(d.backstop.name)) + ' by default' : 'nobody') + '</div>') + '</div>' +
        (d.manager ? '<select data-oc="' + esc(x.date) + '"><option value="">— nobody —</option>' +
          d.staff.map(p => '<option value="' + esc(p.number) + '"' + (p.number === x.number ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') + '</select>'
          : '<div class="tval" style="font-size:16px">' + esc(x.name ? first(x.name) : '—') + '</div>') +
        '</div>').join('') + '</div>';
    box.querySelectorAll('select[data-oc]').forEach(sel => sel.onchange = async () => {
      sel.disabled = true;
      try { await call({ action: 'setoncall', date: sel.dataset.oc, number: sel.value }); showOnCall(); }
      catch (e) { sel.disabled = false; toast(e.offline ? 'Needs signal.' : e.message); }
    });
  }


  /* ---------- the Agricultural Society's cooler fee ----------
   * A seasonal fee, $20 for Society members and $50 otherwise, waived by donating a deer. It is
   * the Society's money, not Home Ground's, so it is counted and handed over on its own and never
   * appears in the Home Ground cash figures.
   */
  /* ---------- handing a payment to Square ----------
     The counter has Square Point of Sale on the same iPad. Without this, somebody types the
     amount into Square by hand and then types the method into this app by hand, and the two
     records only agree if nobody fat-fingers anything. With it, the amount goes across, the
     transaction ID comes back, and the Square payment and the deer are tied together for good —
     which is what makes the 1099-K reconciliation mechanical rather than a January afternoon.

     Mechanics: we leave the app entirely (a URL scheme), Square takes the payment, and Square
     reopens us at the callback URL with the result in ?data=. On iOS that reload can be a cold
     start, so NOTHING may be held in memory across the jump — what we need to finish the job is
     written to localStorage first, and the band also rides along in Square's own `state` field
     as a belt-and-braces copy.

     The whole thing is dormant unless a Square application ID is set, and every path falls back
     to the manual method, because a reader that will not talk is not a reason to hold up a
     hunter at the counter. */

  const SQ_PENDING = 'hg-square-pending';

  function squareReady() {
    const s = S();
    return !!(s && s.squareAppId);
  }

  function squareStart(job) {
    const s = S();
    if (!s.squareAppId) return false;
    // Square wants the smallest currency unit, as a string.
    const cents = String(Math.round(Number(job.amount) * 100));
    if (!(Number(cents) > 0)) return false;
    try { localStorage.setItem(SQ_PENDING, JSON.stringify(Object.assign({ at: Date.now() }, job))); }
    catch (e) { /* private mode: the state field below still carries the band */ }
    const data = {
      amount_money: { amount: cents, currency_code: 'USD' },
      callback_url: s.link || location.href.split('?')[0],
      client_id: s.squareAppId,
      version: '1.3',
      notes: (job.band || '') + (job.hunter ? ' · ' + job.hunter : ''),
      state: job.band || '',
      options: { supported_tender_types: ['CREDIT_CARD'], auto_return: true },
    };
    if (s.squareLocationId) data.location_id = s.squareLocationId;
    window.location = 'square-commerce-v1://payment/create?data=' + encodeURIComponent(JSON.stringify(data));
    return true;
  }

  /* Called once on boot. If Square sent us back, finish what was started before we left. */
  function squareReturn() {
    const q = new URLSearchParams(location.search);
    const raw = q.get('data');
    if (!raw) return null;
    // Clear it from the address bar so a refresh does not replay the payment.
    try { history.replaceState({}, '', location.pathname); } catch (e) {}
    let out = {};
    try { out = JSON.parse(raw); } catch (e) { return null; }
    let job = {};
    try { job = JSON.parse(localStorage.getItem(SQ_PENDING) || '{}'); } catch (e) {}
    try { localStorage.removeItem(SQ_PENDING); } catch (e) {}
    const band = job.band || out.state || '';
    if (out.status !== 'ok') {
      const why = {
        payment_canceled: 'The payment was cancelled in Square.',
        not_logged_in: 'Nobody is signed in to Square on this device.',
        no_network_connection: 'Square had no signal.',
        could_not_perform: 'Square has an unfinished transaction open — clear it and try again.',
        user_not_active: 'That Square location has not enabled card processing.',
        user_id_mismatch: 'The Square location signed in here is not the one in Settings.',
        data_invalid: 'Square rejected the request. Check the application ID and that the Web Callback URL in the Square Developer Console matches the Facility app link exactly.',
      }[out.error_code] || ('Square said: ' + (out.error_code || 'something went wrong') + '.');
      return { ok: false, band: band, job: job, message: why + (band ? ' Nothing was recorded against ' + band + '.' : '') };
    }
    // Offline Mode returns no transaction_id, only the device-generated one. Keep whichever came.
    const id = out.transaction_id || out.client_transaction_id || '';
    return { ok: true, band: band, job: job, squareId: id,
      offline: !out.transaction_id && !!out.client_transaction_id };
  }

  /* Finish a returned Square payment: queue it the same way a hand-keyed one would be, so an
     offline queue, a duplicate guard and the audit line all behave identically. */
  function squareFinish(r) {
    if (!r) return;
    if (!r.ok) { toast(r.message, false); return; }
    const job = r.job || {};
    const f = Object.assign({}, job.fields || {}, { method: 'Card (Square)', squareId: r.squareId });
    queue(job.action || 'payfee', f, (job.label || 'Payment') + ' ' + (r.band || ''));
    toast('Square payment taken' + (r.offline ? ' (offline — it will settle when Square has signal)' : '') +
      '. ' + (r.band || '') + ' recorded.', true);
  }

  /* ---------- front desk ----------
     Four jobs that are one job: a deer arriving, a deer leaving, a drop-off to claim, and money.
     They lived on four screens, which works for somebody who has used the app all season and
     does not work for whoever is covering the counter on the Saturday of shotgun week. Nothing
     here is a new action — it is the same ones, in the order the person at the desk meets them. */
  /* The front desk is drawn from the last copy we were sent, straight away, and then redrawn when
     the fresh one lands. Joe, 7 November: "clicking front desk and still having a lag for how long
     it takes to page to load." The pressed state made the tap feel heard; this is the rest of it.

     A screen that appears instantly with figures a minute old, marked as such, beats a spinner —
     the counter is usually looking for the hunter's name in the collect list, and that does not
     change between one minute and the next. Nothing is acted on from the cached copy: every tap
     from here goes to the server as it always did. */
  async function showDesk() {
    frame('desk', 'Front desk', '<div id="dk"><p class="status">Loading…</p></div>');
    let d;
    try { d = await call({ action: 'desk' }); }
    catch (e) { document.getElementById('dk').innerHTML = '<div class="note bad">' + esc(e.offline ? 'Needs signal.' : e.message) + '</div>'; return; }
    drawDesk(d, d.fromCache || 0);
  }

  function drawDesk(d, cachedAt) {
    frame('desk', 'Front desk', '<div id="dk"></div>');
    const box = document.getElementById('dk');
    const money = n => '$' + (Math.round(n * 100) / 100);

    const row = x => {
      const tone = x.forfeitDue ? 'bad' : x.overdue ? 'warn' : '';
      const priv = x.kind === 'private';
      const detail = priv
        ? 'processed \u00b7 ready since ' + esc(x.since) + (x.lb ? ' \u00b7 ' + x.lb + ' lb' : '')
        : 'in ' + x.daysHeld + ' day' + (x.daysHeld === 1 ? '' : 's') +
          (x.overdue ? ' \u00b7 <b>' + Math.floor(x.overdueDays) + ' past collection</b>'
                     : ' \u00b7 collect by ' + esc(x.collectBy));
      return '<div class="trow' + (tone ? ' ' + tone : '') + '" data-out="' + esc(x.band) + '">' +
        '<div><b>' + esc(x.band) + '</b> <span class="hint">' + (priv ? 'processing' : 'cold storage') + '</span>' +
        (x.colour ? ' \u00b7 ' + esc(x.colour) : '') +
        '<div class="status">' + esc(x.hunter || 'no name') + ' \u00b7 ' + esc(x.deer || 'deer') +
        ' \u00b7 ' + detail + '</div></div>' +
        '<div class="tval" style="font-size:17px">' + (x.waived ? '\u2014' : money(x.owing)) + '</div></div>';
    };

    box.innerHTML =
      (cachedAt
        ? '<div class="status" style="margin:0 2px 8px">Last loaded ' +
          (Date.now() - cachedAt < 60000 ? 'a moment ago' : Math.round((Date.now() - cachedAt) / 60000) + ' min ago') +
          ' · checking for changes…</div>'
        : '') +
      '<div class="card">' +
      (d.open
        ? '<div class="note ok"><b>Posted hours — open.</b> A deer arriving now is not a call-out.</div>'
        : '<div class="note warn"><b>Outside posted hours.</b> Anyone coming in for a deer now is a call-out: Home Ground pays ' +
          money(d.calloutFee) + (d.passCallout ? ', and it is added to a hang-only hunter\'s charge.' : '.') +
          (d.nextWindow ? ' Next open: ' + esc(d.nextWindow.day + ' ' + d.nextWindow.start) + '.' : '') + '</div>') +
      '<div class="tiles">' + tile(d.today.in, 'In today') + tile(d.today.out, 'Out today') +
      tile(d.cooler.inCooler + '/' + d.cooler.cap, 'Cooler') + tile(d.collect.length, 'To collect') + '</div>' +
      (d.gate && !d.gate.ok
        ? '<div class="note bad">Cooler at ' + d.gate.pct + '% — <b>no more hang-only deer.</b> Donated and private still come in.</div>'
        : d.gate && d.gate.gated
          ? '<div class="note warn">Cooler at ' + d.gate.pct + '% — a manager has to approve a hang-only deer.</div>'
          : '') +
      '</div>' +

      /* From here down, the screen runs in the order the counter meets it: somebody on their way,
         somebody at the door, the money on deer already here, then a deer going back out. It used
         to run arrivals, departures, drop-offs, which asked whoever was covering the door on a
         Saturday to hold the sequence in their head rather than read it off the screen. */

      group('1 · On their way') +
      (d.drops.length
        ? '<div class="card"><b>Open drop-offs (' + d.drops.length + ')</b>' +
          '<div class="status">Somebody texted the line and is on their way. ' +
          (d.onCall ? 'On call today: ' + esc(d.onCall.name || d.onCall.number) + '.' : 'Nobody is on call today.') + '</div>' +
          d.drops.map(o => '<div class="trow"><div><b>' + esc(o.hunter || 'A hunter') + '</b>' +
            '<div class="status">' + esc(o.when || '') + (o.callout ? ' · call-out' : '') +
            (o.claimedName ? ' · ' + esc(o.claimedName) + ' is going' : ' · nobody has claimed it') + '</div></div></div>').join('') +
          '<div class="deskrow"><button class="btn alt" data-go2="raisedrop">Another one is coming in</button>' +
          '<button class="btn ghost" data-go2="oncall">On call and drop-offs</button></div></div>'
        : '<div class="card"><p class="status">Nobody has texted the line. ' +
          (d.onCall ? 'On call today: ' + esc(d.onCall.name || d.onCall.number) + '.' : 'Nobody is on call today.') + '</p>' +
          '<div class="deskrow"><button class="btn alt" data-go2="raisedrop">A deer is coming in</button>' +
          '<button class="btn ghost" data-go2="oncall">On call and drop-offs</button></div></div>') +

      /* The buttons now sit in their own row with space around them. They used to run straight on
         from the heading with no margin at all, so on a phone they jammed against the text above
         and below and read as though they were covering it (Joe, 6 November). */
      group('2 · At the door') +
      '<div class="card"><b>A deer is here</b>' +
      '<div class="status">Donated and privately processed deer are never turned away. Only hang-only deer wait for space.</div>' +
      '<div class="deskrow"><button class="btn" data-go2="intake">Check a deer in</button></div></div>' +

      /* Money still out on deer that are here. It sits above the collection list because this is
         the one the counter can do something about while the hunter is still in front of them. */
      ((d.unpaid || []).length
        ? group('3 · Still owing') +
          '<div class="card"><b>Waiting on payment (' + d.unpaid.length + ')</b>' +
          '<div class="status">Custom processing is paid before the deer is cut. Tap one to take the money.</div>' +
          d.unpaid.map(x => '<div class="trow" data-pay="' + esc(x.band) + '"><div><b>' + esc(x.hunter || 'no name') + '</b>' +
            '<div class="status">' + esc(x.band) + ' · ' + esc(x.deer || 'deer') + ' · ' +
            (x.status === 'Processing' ? 'on the bench' : x.hours + ' h hung') +
            (x.paid ? ' · ' + money(x.paid) + ' of ' + money(x.price) + ' paid' : '') + '</div></div>' +
            '<div class="tval" style="font-size:17px">' + money(x.owing) + '</div></div>').join('') +
          '</div>'
        : '') +

      group(((d.unpaid || []).length ? '4' : '3') + ' \u00b7 Going back out') +
      '<div class="card"><b>Collecting a deer (' + d.collect.length + ')</b>' +
      (d.collect.length
        ? '<div class="status">Tap the deer they came for \u2014 cold storage and finished processing together, longest waiting first.</div>' + d.collect.map(row).join('')
        : '<p class="status">Nothing waiting to be collected.</p>') +
      '</div>' +

      '<div class="card"><b>What things cost</b><div class="status">' +
      'Cold storage ' + money(d.fee) + ' for ' + d.coldDays + ' days, then ' + money(d.weekFee) + ' a week. ' +
      'Private processing ' + money(d.privatePrice) + ', paid before the deer is cut. Donating is free and waives cold storage. ' +
      (d.passCallout ? 'Outside posted hours adds ' + money(d.calloutFee) + ' per trip.' : '') +
      '</div></div>' +
      '<div id="outbox"></div>';

    box.querySelectorAll('.trow[data-out]').forEach(el => { el.onclick = () => openCheckout(el.dataset.out, d); });
    box.querySelectorAll('.trow[data-pay]').forEach(el => { el.onclick = () => showDeer(el.dataset.pay); });
    box.querySelectorAll('[data-go2]').forEach(el => { el.onclick = () => GO[el.dataset.go2](); });
  }

  /* Handing a deer over. The money is due here, and this is the only place it is asked for — but
     it is deliberately not a gate. Refusing to hand back a hunter's own carcass over $50 is a lien
     claim, and not one worth making at a counter with other hunters watching. A manager can let it
     go unpaid with a reason. What cannot happen is the question going unasked. */
  /* Handing a deer over — a hang-only one the hunter collects whole, or a privately processed one
     with $250 on it. Same door, same three questions: who is taking it, has the money been
     settled, and release it. They used to live on two screens, which split the counter's job for
     no reason anyone standing at it would recognise.

     The money is due here, and this is deliberately not a gate. Refusing to hand back a hunter's
     own carcass over a fee is a lien claim, and not one worth making at a counter with other
     hunters watching. A manager can let it go unpaid with a reason. What cannot happen is the
     question going unasked. */
  function openCheckout(band, d) {
    const x = d.collect.filter(r => r.band === band)[0];
    if (!x) return;
    const money = n => '$' + (Math.round(n * 100) / 100);
    const ob = document.getElementById('outbox');
    const owes = !x.waived && x.owing > 0;
    const priv = x.kind === 'private';

    const breakdown = priv
      ? '<div class="note"><b>' + money(x.due) + '</b> — custom processing' +
        (x.porkFat ? ', pork fat added' : '') +
        (x.lb ? ' · ' + x.lb + ' lb packaged' : '') +
        (x.paid ? ' · ' + money(x.paid) + ' already paid' : '') +
        '<br><b>' + (owes ? money(x.owing) + ' due now' : 'Settled') + '</b></div>' +
        (x.cuts ? '<div class="status"><b>Cut sheet:</b> ' + esc(x.cuts) + '</div>' : '')
      : x.waived
        ? '<div class="note ok"><b>Nothing to pay.</b> They donated a deer this season.</div>'
        : '<div class="note"><b>' + money(x.due) + '</b> — ' + money(x.base) + ' storage' +
          (x.weeks > 1 ? ' (' + x.weeks + ' weeks)' : '') +
          (x.calloutDue ? ' plus ' + money(x.calloutDue) + ' call-out' + (x.callouts > 1 ? ' ×' + x.callouts : '') : '') +
          (x.paid ? ' · ' + money(x.paid) + ' already paid' : '') +
          '<br><b>' + (owes ? money(x.owing) + ' due now' : 'Settled') + '</b></div>';

    ob.innerHTML = '<div class="card"><b>Checking out ' + esc(band) + '</b>' +
      '<div class="status">' + (priv ? '<b>Custom processing</b>' : '<b>Cold storage</b>') + ' · ' +
      esc(x.hunter || 'no name') + ' · ' + esc(x.deer || 'deer') +
      (x.confirmation ? ' · ' + esc(x.confirmation) : '') +
      (priv ? ' · finished ' + esc(x.since) : ' · in ' + x.daysHeld + ' days') + '</div>' +
      (x.skull ? '<div class="note warn" style="font-size:17px"><b>The skull and antlers go with him.</b> ' +
        'It is tagged ' + esc(band) + ' at the skinning station. Do not let him leave without it.</div>' : '') +
      breakdown +
      (!priv && !d.open && d.passCallout
        ? '<label class="choice"><input type="checkbox" id="ocnc"> <span>This collection is <b>not</b> a call-out — we were here anyway</span></label>'
        : '') +
      '<label for="octo">Who is collecting it?</label><input id="octo" type="text" autocomplete="off" value="' + esc(x.hunter || '') + '">' +
      (priv ? '<label for="oclb">Pounds going out <span class="hint">Leave as is unless it was reweighed</span></label>' +
        '<input id="oclb" type="number" inputmode="decimal" value="' + esc(x.lb || '') + '">' : '') +
      (owes
        ? (squareReady()
            ? '<button class="btn" id="ocsq">Take ' + money(x.owing) + ' on Square</button>' +
              '<div class="status">Hands the amount to Square on this device and brings the receipt back. Or record it by hand:</div>'
            : '') +
          '<label for="ocm">How are they paying?</label><select id="ocm"><option value="">Choose…</option>' +
          (d.methods || ['Cash', 'Card (Square)', 'Check']).map(m => '<option>' + esc(m) + '</option>').join('') + '</select>' +
          (d.manager
            ? '<label class="choice"><input type="checkbox" id="ocu"> <span>Let it go <b>unpaid</b> — I will chase it</span></label>' +
              '<input id="ocur" type="text" placeholder="Why it is going out unpaid" hidden>'
            : '<p class="status">If they cannot pay, a manager has to release it.</p>')
        : '') +
      '<div class="err" id="ocerr"></div>' +
      '<button class="submit" id="ocgo">Check ' + esc(band) + ' out</button></div>';

    const u = document.getElementById('ocu');
    if (u) u.onchange = () => { document.getElementById('ocur').hidden = !u.checked; };

    const err = m => { document.getElementById('ocerr').textContent = m; };
    const gather = () => {
      const to = document.getElementById('octo').value.trim();
      if (!to) { err('Say who collected it. The record has to name a person.'); return null; }
      const f = { band: band, to: to };
      const nc = document.getElementById('ocnc');
      if (nc && nc.checked) f.callout = false;
      const lb = document.getElementById('oclb');
      if (lb && lb.value) f.pounds = lb.value;
      return f;
    };

    /* The Square path leaves the app, so everything needed to finish has to be handed over now.
       We send the whole check-out, not just the payment — when Square returns, the deer goes out
       in one queued action rather than a payment that half-happened. */
    const sq = document.getElementById('ocsq');
    if (sq) sq.onclick = () => {
      const f = gather();
      if (!f) return;
      const ok = squareStart({ amount: x.owing, band: band, hunter: x.hunter,
        action: 'checkout', label: 'Check-out', fields: f });
      if (!ok) err('Square is not set up on this device. Record it by hand instead.');
    };

    document.getElementById('ocgo').onclick = () => {
      const f = gather();
      if (!f) return;
      if (owes) {
        const unpaid = document.getElementById('ocu');
        if (unpaid && unpaid.checked) {
          const why = document.getElementById('ocur').value.trim();
          if (!why) return err('Say why it is going out unpaid.');
          f.unpaid = true; f.unpaidReason = why;
        } else {
          const m = document.getElementById('ocm').value;
          if (!m) return err('Choose how they paid, or mark it unpaid.');
          f.method = m;
        }
      }
      queue('checkout', f, 'Check-out ' + band);
      toast(band + ' checked out.', true);
      showDesk();
    };
  }

  /* Cold storage, as money rather than as deer. One row per hanging hang-only deer: how long it
     has been here, what the hunter owes today, and how close it is to being forfeited. Replaced
     the Agricultural Society's season-fee screen on 6 Nov — their fee was for their cooler; this
     is Home Ground's cooler, insured and staffed by Home Ground, so the charge is Home Ground's. */
  async function showFees() {
    frame('fees', 'Cold storage', '<div id="fb"><p class="status">Loading…</p></div>');
    let d;
    try { d = await call({ action: 'fees' }); }
    catch (e) { document.getElementById('fb').innerHTML = '<div class="note bad">' + esc(e.offline ? 'Needs signal.' : e.message) + '</div>'; return; }
    const box = document.getElementById('fb');
    const money = n => '$' + (Math.round(n * 100) / 100);
    const row = x => {
      const tone = x.forfeitDue ? 'bad' : x.overdue ? 'warn' : '';
      const state = x.waived ? 'free — donated this season'
        : x.settled ? 'paid'
        : x.overdue ? Math.floor(x.overdueDays) + ' day' + (Math.floor(x.overdueDays) === 1 ? '' : 's') + ' past collection'
        : 'collect by ' + x.collectBy;
      return '<div class="trow' + (tone ? ' ' + tone : '') + '" data-band="' + esc(x.band) + '">' +
        '<div><b>' + esc(x.band) + '</b> · ' + esc(x.hunter || 'no name') +
        '<div class="status">in ' + x.daysHeld + ' day' + (x.daysHeld === 1 ? '' : 's') + ' · ' + esc(state) +
        (x.phone ? ' · <a href="tel:' + esc(String(x.phone).replace(/[^\d+]/g, '')) + '">' + esc(x.phone) + '</a>' : ' · no phone on file') +
        (x.attempts ? ' · ' + x.attempts + ' attempt' + (x.attempts === 1 ? '' : 's') + ' logged' : '') +
        '</div></div>' +
        '<div class="tval" style="font-size:17px">' + (x.waived ? '—' : money(x.owing)) + '</div></div>';
    };
    box.innerHTML =
      '<div class="card"><b>What cold storage costs</b><div class="status">' +
      money(d.fee) + ' a deer, covering ' + d.coldDays + ' days. ' + money(d.weekFee) +
      ' for each week after that, or part of one. The hunter is texted on day ' + d.remindDays +
      ' to collect within 48 hours. Donating a deer this season makes it free; private processing includes it.</div>' +
      '<div class="tiles">' + tile(d.deer.length, 'Hanging now') + tile(money(d.owingTotal), 'Owing') +
      tile(d.overdueCount, 'Past collection') + tile(money(d.takenThisSeason), 'Taken this season') + '</div>' +
      (d.gate && !d.gate.ok
        ? '<div class="note bad">The cooler is ' + d.gate.pct + '% full. <b>No more hang-only deer</b> until it comes down. Donated and private still come in.</div>'
        : d.gate && d.gate.gated
          ? '<div class="note warn">The cooler is ' + d.gate.pct + '% full. A manager has to approve each hang-only deer.</div>'
          : '') + '</div>' +
      (d.deer.length
        ? '<div class="card"><b>In the cooler now (' + d.deer.length + ')</b>' +
          '<div class="status">Longest first. Tap one to log a call, take payment or forfeit it.</div>' +
          d.deer.map(row).join('') + '</div>'
        : '<div class="card"><b>In the cooler now</b><p class="status">No hang-only deer hanging.</p></div>') +
      (d.forfeitReady
        ? '<div class="note bad"><b>' + d.forfeitReady + ' deer can be forfeited.</b> Three logged attempts to reach the hunter are needed first, ' +
          'and it only binds because the drop-off slip says so.</div>'
        : '') +
      '<div id="actbox"></div>';

    // One row open at a time: the actions need the band and there is no sense in several forms.
    box.querySelectorAll('.trow[data-band]').forEach(el => { el.onclick = () => openStorage(el.dataset.band, d); });
  }

  function openStorage(band, d) {
    const x = d.deer.filter(r => r.band === band)[0];
    if (!x) return;
    const ab = document.getElementById('actbox');
    const money = n => '$' + (Math.round(n * 100) / 100);
    ab.innerHTML = '<div class="card"><b>' + esc(band) + '</b> · ' + esc(x.hunter || 'no name') +
      '<div class="status">In ' + x.daysHeld + ' days. ' +
      (x.waived ? 'Free: they donated this season.' : money(x.owing) + ' owing of ' + money(x.due) + '.') +
      ' Forfeiture at ' + x.forfeitAt + ' days.</div>' +
      '<button class="btn" id="sc">Log an attempt to reach them</button>' +
      (!x.waived && x.owing > 0 ? '<label for="smeth">Take payment</label><select id="smeth">' +
        '<option value="">How did they pay?</option>' +
        (d.methods || ['Cash', 'Card (Square)', 'Check']).map(m => '<option>' + esc(m) + '</option>').join('') +
        '</select><button class="btn" id="sp">Mark ' + money(x.owing) + ' paid</button>' : '') +
      (d.manager && x.forfeitDue
        ? '<label for="fwhy">Forfeit this deer <span class="hint">It becomes a donated deer and what is owed is written off</span></label>' +
          '<input id="fwhy" type="text" placeholder="What happened">' +
          '<button class="submit" id="ff">Forfeit ' + esc(band) + ' to donation</button>'
        : x.forfeitDue ? '<p class="status">A manager forfeits a deer.</p>' : '') +
      '<div class="err" id="serr"></div></div>';
    const go = async (fields, action) => {
      const e = document.getElementById('serr'); e.textContent = '';
      try { await call({ action: action, fields: fields }); showFees(); }
      catch (err) { e.textContent = err.offline ? 'Needs signal.' : err.message; }
    };
    document.getElementById('sc').onclick = () => go({ band: band, how: 'called' }, 'storagecontact');
    const sp = document.getElementById('sp');
    if (sp) sp.onclick = () => {
      const m = document.getElementById('smeth').value;
      if (!m) { document.getElementById('serr').textContent = 'Say how they paid.'; return; }
      queue('payfee', { band: band, method: m }, 'Storage charge ' + band);
      showFees();
    };
    const ff = document.getElementById('ff');
    if (ff) ff.onclick = () => go({ band: band, note: document.getElementById('fwhy').value.trim() }, 'forfeit');
  }

  /* ---------- numbers ---------- */
  function weekHtml(w) {
    const s = S();
    const row = (label, val, note) => '<div class="trow"><div><b>' + esc(label) + '</b>' + (note ? '<div class="status">' + esc(note) + '</div>' : '') + '</div><div class="tval">' + esc(val) + '</div></div>';
    const total = w.total === undefined ? w.pay : w.total;
    return '<div class="card"><b>This week</b> <span class="status">(since ' + esc(dayName(w.since)) + ')</span>' +
      '<div class="tiles">' + tile(w.deer, 'Deer processed') + tile(w.skinned === undefined ? '—' : w.skinned, 'Deer skinned') +
      tile(fmt(w.hours), 'Hours clocked') + tile(w.hours ? '$' + fmt(w.perHour) : '—', 'Per hour') + '</div>' +
      row('Processing', '$' + fmt(w.pay), w.deer + ' deer at $' + s.pieceRate) +
      (w.skinPay ? row('Skinning', '$' + fmt(w.skinPay), (w.skinned || 0) + ' deer at $' + (s.skinRate || 25)) : '') +
      (w.intakePay ? row('At the door', '$' + fmt(w.intakePay), (w.paidIntakes === undefined ? (w.intakes || 0) : w.paidIntakes) + ' deer at $' + (s.intakeFee || 10) +
        (w.turnedAway ? ', including ' + w.turnedAway + ' turned away' : '')) : '') +
      (w.otherPay ? row('Other time', '$' + fmt(w.otherPay), fmt(w.otherHours) + ' h at $' + (s.otherHourly || 25) + ' (cleaning, training, no booking)') : '') +
      row('This week', '$' + fmt(total), '') +
      '<div class="status" style="margin-top:8px">All clocked time counts, including cleaning, waiting and training.' +
      (w.topUp ? ' Home Ground tops you up to minimum wage: $' + fmt(w.topUp) + ' so far this week.' : '') +
      /* Overtime used to say only how many hours you had gone over, which told nobody what was
         owed. With a monthly figure and a piece rate in the same week the rate is the weighted
         average of everything earned, not the hourly — so it is worth showing. */
      (w.overtime ? ' <b>Overtime: ' + fmt(w.overtime) + ' hours over 40' +
        (w.overtimePay ? ', $' + fmt(w.overtimePay) + ' owed on top at a $' + fmt(w.regularRate) + ' regular rate' : '') + '.</b>' : '') +
      (w.owed && w.owed !== w.total ? ' Due this week including top-up and overtime: <b>$' + fmt(w.owed) + '</b>.' : '') + '</div></div>';
  }
  async function showNumbers() {
    frame('numbers', 'My numbers', '<div id="nums"><p class="status">Loading…</p></div>');
    const box = document.getElementById('nums');
    let out;
    try { out = await call({ action: 'stats' }); } catch (e) { out = { mine: st.home.mine, week: st.home.week }; if (!out.mine) { box.innerHTML = '<div class="note bad">' + esc(e.offline ? 'Needs signal.' : e.message) + '</div>'; return; } }
    const m = out.mine, s = S();
    box.innerHTML = weekHtml(out.week) +
      '<div class="card"><b>Season so far</b><div class="tiles">' +
      tile(m.deer, 'Deer processed') + tile(m.skinned === undefined ? '—' : m.skinned, 'Deer skinned') +
      tile(m.checkedIn === undefined ? '—' : m.checkedIn, 'Checked in') + tile(m.turnedAway || 0, 'Turned away') +
      tile(m.donated, 'Donated deer') + tile(fmt(m.packagedLb), 'lb packaged') +
      tile(fmt(m.groundVenisonLb), 'lb ground venison') +
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
        '<div class="card scroll"><table><thead><tr><th>Processor</th><th>Deer</th><th>Skinned</th><th>At the door</th><th>Turned away</th><th>Donated</th><th>lb packaged</th><th>lb ground venison</th><th>Yield</th><th>Week: deer</th><th>Week: skinned</th><th>Week: door</th><th>Week: hours</th><th>Week: pay</th><th>Week: $/hr</th><th>Top-up</th><th>OT</th></tr></thead><tbody>' +
        out.people.map(p => '<tr><td><b>' + esc(p.name) + '</b><br><span class="status">' + esc(p.number) + '</span></td><td>' + p.season.deer + '</td><td>' + (p.season.skinned || 0) + '</td><td>' + (p.season.checkedIn || 0) + '</td><td>' + (p.season.turnedAway || 0) + '</td><td>' + p.season.donated + '</td><td>' + fmt(p.season.packagedLb) +
          '</td><td>' + fmt(p.season.groundVenisonLb) + '</td><td>' + (p.season.avgYield ? p.season.avgYield + '%' : '—') + '</td><td>' + p.week.deer + '</td><td>' + (p.week.skinned || 0) + '</td><td>' + (p.week.intakes || 0) + '</td><td>' + fmt(p.week.hours) +
          '</td><td>$' + fmt(p.week.total === undefined ? p.week.pay : p.week.total) +
          '</td><td>' + (p.week.hours ? '$' + fmt(p.week.perHour) : '—') + '</td><td' + (p.week.topUp ? ' class="warn"' : '') + '>' + (p.week.topUp ? '$' + fmt(p.week.topUp) : '') +
          '</td><td' + (p.week.overtime ? ' class="warn"' : '') + '>' +
          (p.week.overtime ? fmt(p.week.overtime) + (p.week.overtimePay ? '<br><span class="status">$' + fmt(p.week.overtimePay) + '</span>' : '') : '') + '</td></tr>').join('') +
        '</tbody></table></div><p class="status">Week: pay is processing, skinning, the door and other clocked time. Top-up: what\'s owed to bring it up to minimum wage for hours clocked this week. OT: hours over 40. The full split is on the Processor Totals tab.</p>';
    } catch (e) { box.innerHTML = '<div class="note bad">' + esc(e.offline ? 'Needs signal.' : e.message) + '</div>'; }
  }

  /* ---------- daily log ---------- */
  /* What is left after the sanitation records took the cleaning checks and the sensors took the
     temperatures (Joe, 1 Nov). Two of these are here because nothing else captures them: the
     sanitizer CONCENTRATION, which the SSOP requires in writing but its forms only record as a
     temperature, and complaints. Bank deposit is managers only — the cash chain is
     taken at release → into the safe → safe to bank, and Facility Status reconciles all three. */
  const LOGS = [
    ['Sanitizer test', 'Test-strip reading (ppm). The SSOP requires the concentration, not just the temperature'],
    ['Thermometer check', 'Ice-point reading in °F (should be 32). Check the sensors against it too'],
    ['Complaint', 'Lot number, if known. Details in the note'],
    ['Tight tank pumped', 'Company'],
    ['Cash deposit', 'Dollars in the envelope dropped in the safe. Note: number of payments and both sets of initials'],
    ['Bank deposit', 'Managers only. Dollars taken from the safe to the bank. Note: deposit slip number']];
  const myLogs = () => LOGS.filter(l => l[0] !== 'Bank deposit' || isMgr());
  function showDaily() {
    frame('daily', 'Log book',
      '<div class="card"><label for="lt">What are you logging?</label><select id="lt">' + myLogs().map(l => '<option value="' + esc(l[0]) + '">' + esc(l[0]) + '</option>').join('') + '</select>' +
      '<div id="unitbox" hidden><label for="lu">Which one?</label><select id="lu"></select></div>' +
      '<label for="lv">Reading or result <span class="hint" id="lh"></span></label><input id="lv" type="text">' +
      '<label for="ln">Note</label><textarea id="ln"></textarea><div id="err" class="err"></div><button class="submit" id="save">Save to the log</button></div>' +
      '<p class="status">Cleaning and the pre-op check have their own signed records: Home › <b>Pre-op sanitation</b> and <b>Operational sanitation</b>. Cooler, freezer and MHU temperatures are monitored continuously by the sensors.</p>');
    const sel = document.getElementById('lt'), hint = () => {
      document.getElementById('lh').textContent = (myLogs().find(l => l[0] === sel.value) || [])[1] || '';
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
    // Two kinds of row: one a sensor is reporting, and one somebody wrote down. A sensor row says
    // how long ago it last spoke, because a stale sensor reading looks exactly like a good one.
    const sago = m => (m === null || m === undefined) ? '' : m < 2 ? 'just now' : m < 90 ? m + ' min ago' : ago(m / 60);
    const temp = (t, limit) => {
      const bad = t.over || t.silent || t.offline;
      if (t.sensor) return '<div class="trow' + (t.over ? ' bad' : bad ? ' warnrow' : '') + '"><div><b>' + esc(t.unit) + '</b><div class="status">' +
        esc(sago(t.minsAgo === undefined ? null : t.minsAgo)) + ' · ' + esc(t.reads === 'Probe' ? 'probe' : 'sensor body') +
        (t.humidity !== null && t.humidity !== undefined ? ' · ' + t.humidity + '% RH' : '') +
        (t.over ? ' · OVER ' + limit + '°F' : '') +
        (t.offline ? ' · SENSOR OFFLINE' : t.silent ? ' · SENSOR QUIET' : '') +
        (t.lowBattery ? ' · battery ' + t.battery + '%' : '') + '</div></div>' +
        '<div class="tval">' + (t.value !== '' && t.value !== null ? esc(t.value) + '°' : '—') + '</div></div>';
      return '<div class="trow' + (t.over ? ' bad' : t.overdue ? ' warnrow' : '') + '"><div><b>' + esc(t.unit) + '</b><div class="status">' +
        (t.at ? esc(when(t.at)) + ' · ' + ago(t.hoursAgo) + (t.by ? ' · ' + esc(t.by) : '') : 'No reading logged') +
        (t.over ? ' · OVER ' + limit + '°F' : t.overdue && t.at ? ' · reading overdue' : '') + '</div></div><div class="tval">' + (t.value !== '' ? esc(t.value) + '°' : '—') + '</div></div>';
    };
    const up = (label, u) => '<div class="status">' + label + ': ' + (u ? esc(when(u.at)) + (u.by ? ' · ' + esc(u.by) : '') + (u.value && !/^done$/i.test(u.value) ? ' · ' + esc(u.value) : '') : 'not logged yet') + '</div>';
    const p = x.people;
    return '<p class="status">As of ' + esc(when(x.at)) + (stale ? ' (last loaded)' : '') + ' · <button class="plain" id="fs-refresh" style="padding:0">Refresh</button></p>' +
      (x.openHelp ? '<div class="note bad"><b>' + x.openHelp + ' open help request' + (x.openHelp > 1 ? 's' : '') + '.</b> See Home.</div>' : '') +
      (x.ssop ? '<div class="card' + (!x.ssop.preop.done || (x.ssop.preop.held || []).length ? ' red' : '') + '"><b>Sanitation records, today</b>' +
        (x.ssop.preop.done
          ? '<div class="status">Pre-op signed ' + esc(x.ssop.preop.time || '') + ' by ' + esc(x.ssop.preop.initials || '') +
            ((x.ssop.preop.unacceptable || []).length ? ' · ' + x.ssop.preop.unacceptable.length + ' line(s) unacceptable' : ' · all lines acceptable') + '</div>' +
            ((x.ssop.preop.held || []).length ? '<div class="note bad"><b>Not released: ' + esc(x.ssop.preop.held.join(', ')) + '.</b> Nothing should be using it.</div>' : '')
          : '<div class="note bad"><b>No pre-op sanitation record today.</b> It is the gate: fill it in before any deer is touched.</div>') +
        '<div class="status">Operational sanitation walks logged: ' + x.ssop.opForms + ' · corrective action records: ' + x.ssop.corrective + '</div>' +
        '<button class="plain" data-go2="records">Read today\'s records</button>' +
        (isViewer() ? '' : ' <button class="plain" data-go2="preop">Fill in the pre-op record</button>') + '</div>' : '') +
      (x.skinning ? '<div class="card' + (x.skinning.room <= 0 ? ' amber' : '') + '"><b>Skinning</b>' +
        '<div class="tiles">' + tile(x.skinning.skinnedToday, 'Skinned today') + tile(x.skinning.hanging + ' of ' + x.skinning.cap, 'Skinned, hanging') +
        tile(x.skinning.bookedNow, 'Skinners booked now') + tile(x.skinning.room, 'Room in MHU #1') + '</div>' +
        (x.skinning.room <= 0 ? '<div class="note warn">MHU #1 is at its skinned-deer capacity. No more skin-ahead bookings until some are processed.</div>' : '') + '</div>' : '') +
      '<div class="card' + (fill ? ' ' + fill : '') + '"><b>Cooler: ' + c.inCooler + ' of ' + c.capacity + ' (' + c.pctFull + '% full)</b>' +
      '<div class="tiles">' + tile(c.donatedHanging, 'Donated hanging') + tile(c.privateHanging, 'Private hanging') +
      (c.coldStorage !== undefined ? tile(c.coldStorage, 'Cold storage') : '') +
      tile(c.processing, 'Being processed') + tile(x.ready.deer, 'Packaged, waiting') + '</div>' +
      (c.coldOverdue ? '<div class="note warn">' + c.coldOverdue + ' cold-storage deer past ' + c.coldDays + ' days. Ring the hunters \u2014 the Society allows longer while there is room.</div>' : '') +
      (c.pastMaxHold ? '<div class="note bad">' + c.pastMaxHold + ' over the ' + c.maxHold + '-hour maximum hold. Tell Joe now.</div>' : '') +
      (c.pastStartBy - c.pastMaxHold > 0 ? '<div class="note warn">' + (c.pastStartBy - c.pastMaxHold) + ' past ' + c.startBy + ' hours: process next.</div>' : '') +
      (x.ready.deer ? '<div class="status">' + fmt(x.ready.lb) + ' lb packaged and waiting for pickup or delivery (' + x.ready.donated + ' donated deer).</div>' : '') + '</div>' +
      '<div class="card' + (x.oldest && x.oldest.hours >= c.maxHold ? ' red' : x.oldest && x.oldest.hours >= c.startBy ? ' amber' : '') + '"><b>Longest hanging</b>' +
      (x.oldest ? '<div class="deer"><div><span class="band">' + esc(x.oldest.band) + '</span> <span class="tag ' + (x.oldest.type === 'Donated' ? 'don">DONATED' : 'prv">PRIVATE') + '</span>' +
        '<div class="status">In ' + esc(when(x.oldest.intake)) + (x.oldest.deer ? ' · ' + esc(x.oldest.deer) : '') + '</div></div><div class="hrs">' + x.oldest.hours + ' h</div></div>' : '<div class="status">Nothing hanging.</div>') + '</div>' +
      (() => {
        const list = (x.temps.list || []), sn = x.temps.sensors || {};
        // A space with a Temp Stick on it always shows, because the sensor is always reporting.
        // A space without one shows only once somebody has written a reading down, so the freezers
        // stay out of the way until they exist (Joe, 1 Nov: three Pro units, no freezer sensors yet).
        const show = list.filter(t => t.sensor || t.at);
        return '<div class="card"><b>Temperatures</b> <span class="status">cold storage 33–37°F, never above 41 · MHUs never above 42 · freezer 0°F or colder, never above 10</span>' +
          (show.length ? show.map(t => temp(t, t.limit)).join('') : '') +
          (!sn.on ? '<div class="note warn" style="margin-top:8px"><b>The sensors are not connected.</b> Temperatures have to be logged by hand in the Log book until they are.</div>'
            : sn.unassigned ? '<div class="note warn" style="margin-top:8px"><b>' + sn.unassigned + ' sensor' + (sn.unassigned > 1 ? 's are' : ' is') + ' reporting but not placed.</b>' +
              (isMgr() ? ' <button class="plain" data-go2="sensors">Say where ' + (sn.unassigned > 1 ? 'they are' : 'it is') + '</button>' : ' A manager needs to say where in Sensors.') + '</div>'
            : !show.length ? '<div class="status" style="margin-top:8px">No readings yet.</div>' : '') +
          (sn.on && sn.reporting ? '<div class="status" style="margin-top:8px">' + sn.reporting + ' space' + (sn.reporting > 1 ? 's' : '') + ' monitored continuously · ' +
            '<button class="plain" data-go2="temprecord" style="padding:0">the temperature record</button></div>' : '') + '</div>';
      })() +
      '<div class="card"><b>People</b><div class="tiles">' + tile(p.clockedIn.length, 'Clocked in now') + tile(p.onShift ? p.onShift.booked.length + ' of ' + p.max : '—', p.onShift ? 'Booked right now' : 'Nobody booked now') + '</div>' +
      (p.clockedIn.length ? '<div class="status">Clocked in: ' + esc(p.clockedIn.map(w => w.name + ' (since ' + when(w.since).split(' ').slice(-2).join(' ') + ')').join(', ')) + '</div>' : '') +
      (p.alone ? '<div class="note warn"><b>' + esc(p.alone.name) + ' is on their own.</b>' +
        (p.alone.expected ? ' Expects to finish by ' + t12(p.alone.expected) + '.' : ' No finish time given.') + '</div>' : '') +
      (p.onShift && p.onShift.booked.length ? '<div class="status">Booked now: ' + esc(p.onShift.booked.join(', ')) + '</div>' : '') +
      (p.nextShift ? '<div class="status">Next in: ' + esc(p.nextShift.slot) + (p.nextShift.people > 1 ? ' and ' + (p.nextShift.people - 1) + ' more' : '') + ' at ' + t12(p.nextShift.starts) + '</div>' : '') + '</div>' +
      '<div class="card"><b>Today</b><div class="tiles">' + tile(x.today.in, 'Deer in') + tile(x.today.processed, 'Processed') + tile(fmt(x.today.lb), 'lb packaged') + tile(x.today.released, 'Released') + '</div>' +
      (x.today.turnedAway ? '<div class="status">' + x.today.turnedAway + ' turned away today.</div>' : '') + '</div>' +
      (x.cash ? cashHtml(x.cash) : '') +
      (x.storage && x.storage.hanging ?
        '<div class="card"><b>Cold storage</b> <span class="status">hang-only deer</span>' +
        '<div class="tiles">' + tile(x.storage.hanging, 'Hanging') + tile('$' + x.storage.owing, 'Owing') + '</div>' +
        (x.storage.overdue ? '<div class="note warn">' + x.storage.overdue + ' past collection' +
          (x.storage.forfeitReady ? ', ' + x.storage.forfeitReady + ' can be forfeited' : '') + '.</div>' : '') +
        '<div class="status"><button class="plain" data-go2="fees" style="padding:0">Cold storage</button></div></div>' : '') +
      '<div class="card"><b>Cleaning and upkeep</b> <span class="status">last logged</span>' +
      up('Sanitizer test', x.upkeep.sanitizer) + up('Thermometer check', x.upkeep.thermometer) +
      // Nightly, and the one on this card that is a food safety step rather than housekeeping.
      up('Waste out of cold storage', x.upkeep.wasteOut) +
      up('Tight tank pumped', x.upkeep.tightTank) + '</div>';
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
      // Martin, 1 Nov: a deer goes on his sheet as it comes in, and "the rest of the data" is
      // filled in after packaging. So the second pass is three cells on a row that is already
      // there — F, G and H — not a row to paste. Without this card a deer sent at intake simply
      // vanished from this screen and its packaging never reached him.
      (() => {
        const pk = data.packaging || [];
        if (!pk.length) return '<div class="card"><b>Packaging to fill in</b>' +
          '<p class="status">Nothing waiting.' + (data.waiting ? ' ' + data.waiting + ' donated deer ' + (data.waiting === 1 ? 'is' : 'are') + ' on his sheet and not packaged yet — they appear here when they are finished.' : '') + '</p></div>';
        const row = x => '<div class="trow">' +
          (isMgr() ? '<label class="choice" style="margin:0"><input type="checkbox" data-pk="' + esc(x.band) + '" checked> ' : '<div>') +
          '<b>' + esc(x.customerId || '(no Customer ID)') + '</b> ' + esc(x.hunter) +
          '<div class="status">in ' + esc(x.dateIn) + ' \u00b7 seal ' + esc(x.confirmation || '\u2014') + ' \u00b7 on his sheet ' + esc(x.sent) + '</div>' +
          '<div class="status"><b>F</b> Date Packaged <b>' + esc(x.datePackaged) + '</b> \u00b7 ' +
          '<b>G</b> First Pack # <b>' + esc(x.firstPack || '\u2014') + '</b> \u00b7 ' +
          '<b>H</b> Last Pack # <b>' + esc(x.lastPack || '\u2014') + '</b></div>' +
          (isMgr() ? '</label>' : '</div>') + '</div>';
        return '<div class="card"><b>Packaging to fill in (' + pk.length + ')</b>' +
          '<p class="status">These are already on Martin\'s sheet from check-in. Find each row by its Customer ID and type the three values into columns <b>F</b>, <b>G</b> and <b>H</b>. Don\'t paste the whole row again — it would go in twice.</p>' +
          pk.map(row).join('') +
          (isViewer() ? '' : isMgr()
            ? '<button class="btn ghost" id="pksent" style="width:100%;margin-top:8px">I\'ve filled these in: mark them done</button>'
            : '<p class="status">A manager marks them as filled in.</p>') +
          '<div id="pkout"></div></div>';
      })() +
      /* The W-4 chase, moved here on 7 November when Hunter payments was retired. TFMV cannot pay
         a donating hunter until he has filed one, and the form goes automatically at check-in —
         but only when an email was taken, and a deer dropped off out of hours arrives without its
         hunter. So the ones nobody can email are listed separately: that is a phone call, not a
         button, and lumping the two together is how the second kind never gets done. */
      (() => {
        const tx = data.tax || [];
        if (!tx.length) return '<div class="card"><b>Tax forms</b><p class="status">Every donating hunter has had the W-4. Nothing to chase.</p></div>';
        const can = tx.filter(x => x.email), cant = tx.filter(x => !x.email);
        return '<div class="card"><b>W-4 not sent (' + tx.length + ')</b>' +
          '<p class="status">Tick Free MV cannot pay a hunter until this is filed. One form covers the season.</p>' +
          (can.length
            ? can.map(x => '<div class="trow"><div><b>' + esc(x.hunter || 'no name') + '</b>' +
                '<div class="status">' + esc(x.band) + ' · in ' + esc(x.dateIn) + ' · ' + esc(x.email) + '</div></div>' +
                (isViewer() ? '' : '<button class="btn ghost" data-tax="' + esc(x.band) + '">Send it</button>') + '</div>').join('')
            : '') +
          (cant.length
            ? '<div class="note warn" style="margin-top:8px"><b>' + cant.length +
              (cant.length === 1 ? ' hunter has' : ' hunters have') + ' no email on file.</b> Nothing can be sent to them — ' +
              'ring them, or catch them at the counter, and put the address on the record with <b>Correct the record</b>.' +
              cant.map(x => '<div class="status">' + esc(x.hunter || 'no name') + ' · ' + esc(x.band) +
                (x.phone ? ' · ' + esc(x.phone) : ' · no phone either') + '</div>').join('') + '</div>'
            : '') +
          '<div id="taxout"></div></div>';
      })() +
      '<div class="card"><b>Everything</b><p class="status">All donated deer in Martin\'s layout, as a file that opens in Excel.</p><button class="btn ghost" id="dl">Download all</button></div>';
    if (!document.getElementById('mtab-css')) { const st_ = document.createElement('style'); st_.id = 'mtab-css';
      st_.textContent = '.mtab{border-collapse:collapse;font-size:13px;margin:8px 0;white-space:nowrap}.mtab th,.mtab td{border:1px solid var(--line);padding:4px 6px;text-align:left}.mtab th{background:var(--ok-bg)}';
      document.head.appendChild(st_); }
    const out = document.getElementById('mout');
    // Each hunter is sent his own form, one tap at a time, so a failure names the hunter it
    // failed for rather than leaving a batch half done with no way to tell which half.
    $app.querySelectorAll('[data-tax]').forEach(b => b.onclick = async () => {
      const tout = document.getElementById('taxout');
      b.disabled = true; b.textContent = 'Sending…';
      try {
        const r = await call({ action: 'taxform', band: b.dataset.tax, clientId: 'tax-' + b.dataset.tax + '-' + Date.now() });
        b.textContent = 'Sent';
        if (tout) tout.innerHTML = '<div class="note ok">W-4 sent to ' + esc(r.to || 'the hunter') + '.</div>';
      } catch (e) {
        b.disabled = false; b.textContent = 'Send it';
        if (tout) tout.innerHTML = '<div class="note bad">' + esc(e.offline ? 'Needs signal.' : e.message) + '</div>';
      }
    });
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
    const pks = document.getElementById('pksent');
    if (pks) pks.onclick = async () => {
      const bands = Array.prototype.map.call(box.querySelectorAll('[data-pk]:checked'), c => c.dataset.pk);
      if (!bands.length) { document.getElementById('pkout').innerHTML = '<div class="note warn">Tick the ones you filled in first.</div>'; return; }
      pks.disabled = true;
      try { const r = await call({ action: 'martinpackaged', bands: bands }); showMartin(r, r.marked + ' marked as filled in on Martin\'s sheet.'); }
      catch (e) { pks.disabled = false; toast(e.offline ? 'Needs signal.' : e.message); }
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

  /* Hunter payments was a screen here: what TFMV owed each donating hunter, and whether the
     cheque had gone out. Retired 7 November. Home Ground does not make those payments and has
     no sight of when TFMV makes them, so the status column was always a guess. The one part
     worth keeping — chasing the W-4 TFMV needs before it can pay anybody — moved onto the
     Donation report, which is the screen that already faces Martin and TFMV. */

  /* Running low. Anyone raises one; managers mark it ordered or received. Deliberately asks for
     almost nothing — the item, how bad it is, and optionally a word — because the price, the
     supplier and who pays belong on the purchases list, which is a job done sitting down. */
  function showSupplies(note) {
    frame('supplies', 'Running low', '<div id="sup"><p class="status">Loading…</p></div>');
    const box = document.getElementById('sup');
    const URG = ['Running low', 'We are out'];
    const draw = out => {
      const quick = out.quick || [], list = out.supplies || [];
      const open = list.filter(x => x.status === 'Open'), done = list.filter(x => x.status !== 'Open');
      box.innerHTML = (note ? '<div class="note ok">' + esc(note) + '</div>' : '') +
        '<div class="card"><b>What are we low on?</b>' +
        '<div class="chips" style="display:flex;flex-wrap:wrap;gap:6px;margin:10px 0">' +
        quick.map(q => '<button type="button" class="btn ghost" data-q="' + esc(q) + '" style="padding:8px 12px">' + esc(q) + '</button>').join('') +
        '</div>' +
        '<label for="sitem">Or type it</label><input id="sitem" type="text" maxlength="80" placeholder="Something else we need">' +
        '<label for="snote">Anything to add <span class="hint">optional</span></label><input id="snote" type="text" maxlength="200" placeholder="Down to two boxes">' +
        '<label for="surg">How bad</label><select id="surg">' + URG.map(u => '<option>' + esc(u) + '</option>').join('') + '</select>' +
        '<div class="err" id="serr"></div><button class="submit" id="sgo">Tell the managers</button></div>' +
        '<div class="card"><h3>Waiting</h3>' + (open.length ? open.map(rowHtml).join('') : '<p class="status">Nothing outstanding.</p>') + '</div>' +
        (done.length ? '<div class="card"><h3>Sorted recently</h3>' + done.map(rowHtml).join('') + '</div>' : '');
      box.querySelectorAll('[data-q]').forEach(b => b.onclick = () => { document.getElementById('sitem').value = b.dataset.q; document.getElementById('sitem').focus(); });
      document.getElementById('sgo').onclick = async () => {
        const item = (document.getElementById('sitem').value || '').trim();
        if (!item) { document.getElementById('serr').textContent = 'Tap one above, or type what we need.'; return; }
        const btn = document.getElementById('sgo'); btn.disabled = true;
        try {
          const r = await call({ action: 'raisesupply', fields: { item: item, note: document.getElementById('snote').value.trim(), urgency: document.getElementById('surg').value },
            clientId: 'sup-' + Date.now() });
          showSupplies(r.already ? (r.upgraded ? item + ' was already flagged — now marked as out.' : item + ' is already on the list.') : item + ': the managers know.');
        } catch (e) { btn.disabled = false; document.getElementById('serr').textContent = e.offline ? 'Needs signal — try again when you have a bar.' : e.message; }
      };
      box.querySelectorAll('[data-sup]').forEach(sel => sel.onchange = async () => {
        sel.disabled = true;
        try { const r = await call({ action: 'setsupply', id: sel.dataset.sup, status: sel.value }); draw(Object.assign({ quick: quick }, r)); }
        catch (e) { sel.disabled = false; toast(e.offline ? 'Needs signal.' : e.message); }
      });
    };
    const rowHtml = x => '<div class="trow"><div><span><b>' + esc(x.item) + '</b>' +
      (x.urgency === 'We are out' ? ' <span class="pill" style="background:var(--red,#A12A1F);color:#fff">OUT</span>' : '') +
      '<br><span class="status">' + esc(x.by || 'Someone') + ', ' + esc(when(x.when)) +
      (x.note ? ' · ' + esc(x.note) : '') +
      (x.status !== 'Open' ? '<br>' + esc(x.status) + (x.actionedBy ? ' by ' + esc(x.actionedBy) : '') + (x.actioned ? ' · ' + esc(x.actioned) : '') : '') +
      '</span></span></div>' +
      (isMgr() ? '<div><select data-sup="' + esc(x.id) + '" aria-label="What happened to ' + esc(x.item) + '">' +
        ['Open', 'Ordered', 'Received', 'Not needed'].map(s => '<option' + (s === x.status ? ' selected' : '') + '>' + esc(s) + '</option>').join('') +
        '</select></div>' : '') + '</div>';
    call({ action: 'supplies' }).then(draw)
      .catch(e => { box.innerHTML = '<div class="note bad">' + esc(e.offline ? 'Needs signal. Try again when connected.' : e.message) + '</div>'; });
  }

  /* ---------- where the waiting actually goes ----------

     Three times on 6 November I named a cause for a slow screen before measuring one, and was
     wrong three times. This measures instead.

     `ping` reaches the backend and returns without touching the spreadsheet, so its round trip is
     everything outside our control: the trip to Google, the redirect an Apps Script web app
     answers with, and the time Apps Script spends loading and compiling the backend before a line
     of it runs. A real screen's time, minus that, is the only part worth working on. The two
     numbers say which of us to blame, and there is no arguing with them. */
  async function showSpeed() {
    frame('speed', 'Speed test', '<div id="sp"><p class="status">Timing the connection…</p></div>');
    const box = document.getElementById('sp');
    const ms = async body => { const t = Date.now(); let server = 0;
      try { const o = await call(Object.assign({ __fresh: true }, body)); server = Number(o.ms) || 0; }
      catch (e) { return { err: e.message }; }
      return { total: Date.now() - t, server: server }; };
    const s = n => (n / 1000).toFixed(1) + 's';

    // Twice each: the first of anything pays for waking the script up, and that is not the
    // number anybody experiences all day.
    const warm = await ms({ action: 'ping' });
    if (warm.err) { box.innerHTML = '<div class="note bad">' + esc(warm.err) + '</div>'; return; }
    const pingR = await ms({ action: 'ping' });
    await ms({ action: 'desk' });
    const deskR = await ms({ action: 'desk' });
    await ms({ action: 'home' });
    const homeR = await ms({ action: 'home' });

    const overhead = pingR.total;
    const row = (what, r) => '<div class="trow"><div><b>' + esc(what) + '</b>' +
      '<div class="status">' + s(r.server) + ' of work in the script</div></div>' +
      '<div class="tval" style="font-size:17px">' + s(r.total) + '</div></div>';
    const ourShare = Math.max(0, (deskR.total - overhead));

    box.innerHTML =
      '<div class="card"><b>A round trip that does nothing</b>' +
      '<div class="status">Reaches the backend and comes straight back without opening the spreadsheet. ' +
      'This is the floor: the trip to Google, the redirect, and Apps Script loading the code. Nothing we write can go below it.</div>' +
      '<div class="trow"><div><b>Doing nothing at all</b></div><div class="tval" style="font-size:19px">' + s(overhead) + '</div></div></div>' +
      '<div class="card"><b>Real screens</b>' + row('Front desk', deskR) + row('Home', homeR) +
      '<div class="status" style="margin-top:8px">Of the front desk’s ' + s(deskR.total) + ', <b>' + s(overhead) +
      '</b> is the floor above and <b>' + s(ourShare) + '</b> is ours — the spreadsheet work and the data coming back.</div></div>' +
      '<div class="note ' + (overhead > ourShare ? 'warn' : 'ok') + '">' +
      (overhead > ourShare
        ? '<b>Most of the wait is the platform, not the app.</b> Making the app do less would save at most ' + s(ourShare) +
          ', and the ' + s(overhead) + ' floor would remain. Tell Joe this number rather than that a screen feels slow.'
        : '<b>Most of the wait is the app, and that can be worked on.</b> Send Joe these figures.') + '</div>';
  }

  const GO = { supplies: () => showSupplies(), status: showStatus, speed: showSpeed, board: showBoard, intake: showIntake, shifts: () => showShifts(), messages: showMessages, help: showHelp,
    numbers: showNumbers, daily: showDaily, team: showTeam, martin: () => showMartin(), donate: showDonate, scan: () => showScan(),
    preop: showPreop, opssop: showOpSsop, corrective: () => showCorrective(), records: showRecords,
    closeout: showCloseOut,
    skinning: () => showShifts(null, null, 'Skinning'),
    sensors: showSensors, temprecord: () => showTempRecord(),
    raisedrop: showRaiseDrop, oncall: showOnCall, fees: showFees, desk: showDesk };


  /* ---------- the three sanitation records ----------
   * Friesla's SSOP (Chris DePalma, 28 Oct; Martin signed off on the language 29 Oct), mirrored from Forms.xlsx
   * line for line and box for box:
   *   Pre-Op SSOP   "Pre-Operational Sanitation Record"              — A / U, then Recleaned, Resanitized,
   *                                                                     Reinspected, Released for anything U.
   *                 Friesla's master is headed "MVTF Slaughter Pre-Op Sanitation Record". Home Ground
   *                 takes in deer that were killed and field dressed in the woods, so nothing is
   *                 slaughtered here and the word is dropped. Every line of the check still applies:
   *                 pre-operational sanitation is a food-establishment requirement, not a slaughter one.
   *   Op SSOP       "MVTF Processing Operational Sanitation Record"  — C / N / N-A
   *   Corrective    "MVTF Sanitation Corrective Action Form"         — Parts I, II and III
   * The lines come from Settings, so a line can be added or reworded without a new app version.
   */
  const PREOP_FALLBACK = ['Trolleys', 'Splitting saw', 'Sinks', 'S-hooks', 'Knives', 'Hand saw', 'Utensils',
    'Switches and controls', 'Knife sanitizer', 'Aprons', 'Boots', 'Employee clothing', 'Walls', 'Floor and ceiling',
    'Cooler', 'Sanitizer temp'];
  const OP_FALLBACK = ['Employee clothing', 'Hand soap and towels', 'Hand washing procedures', 'Equipment',
    'Condensation', 'Floors', 'Walls', 'Ceilings', 'Knife sanitizer temp', 'Saw sanitizer temp',
    'Knives', 'Aprons', 'Boots', 'Garbage bins', 'Water pooling', 'Bleeding area', 'Insect control'];
  /* The close-out list is a Settings value, so Joe can change it without a deploy. This is only the
     fallback for a phone that has never had a payload. */
  const CLOSE_FALLBACK = ['Waste bins emptied and taken to the dumpster', 'Nothing left in the trash cooler overnight',
    'Floor drain grates lifted and scrubbed', 'Drain strainers emptied and scrubbed', 'Sink strainers emptied and scrubbed',
    'Sinks and hand sinks cleaned and restocked', 'Equipment broken down and left disassembled',
    'Knives and saws cleaned and sanitized', 'Meat lugs washed and racked', 'Floors squeegeed with no standing water',
    'Cooler and MHU doors shut'];
  /* Pre-op is three lists now: what both units share, then MHU #1 (the rail, skinning and sanitary
     dressing) and MHU #2 (band saw, grinder, stuffer, sealer). Keyed "unit|item" because the same
     name can sit in both rooms, and a flat list meant signing for a band saw that is not in the
     room you are standing in. */
  const preopKeys = () => {
    const s = S(), both = (s.preopItems && s.preopItems.length) ? s.preopItems : PREOP_FALLBACK;
    const keys = both.map(i => '|' + i);
    (s.preopMhu1 || []).forEach(i => keys.push('MHU #1|' + i));
    (s.preopMhu2 || []).forEach(i => keys.push('MHU #2|' + i));
    return keys;
  };
  const preopLabel = k => String(k).split('|').slice(1).join('|');
  const preopGroup = k => String(k).split('|')[0] || 'Both units';
  const opItems = () => { const x = S().opItems; return x && x.length ? x : OP_FALLBACK; };
  const closeItems = () => { const x = S().closeItems; return x && x.length ? x : CLOSE_FALLBACK; };
  const nowHM = () => { const d = new Date(); return d.getHours() + ':' + pad(d.getMinutes()); };
  const myInitials = () => String((st.staff && st.staff.name) || '').trim().split(/\s+/)
    .map(w => (w[0] || '').toUpperCase()).join('').slice(0, 4);
  const FIXES = [['recleaned', 'Recleaned'], ['resanitized', 'Resanitized'], ['reinspected', 'Reinspected'], ['released', 'Released']];
  /* Home Ground operates the establishment and keeps these records, so they carry the Home Ground
     mark and the form's own title. The symbol alone, not the tagline lockup: a sanitation record an
     inspector reads is not the place for "Change starts with YES". */
  const masthead = title => '<div class="mast"><img src="icon-192.png" alt=""><div>' +
    '<div class="co">Home Ground Inc.</div><div class="ft">' + esc(title) + '</div>' +
    '<div class="pl">MV Agricultural Society, West Tisbury</div></div></div>';

  function ssopCss() {
    if (document.getElementById('ssop-css')) return;
    const c = document.createElement('style'); c.id = 'ssop-css';
    c.textContent =
      '.mast{display:flex;align-items:center;gap:12px;padding:0 0 12px;border-bottom:2px solid var(--green);margin-bottom:4px}' +
      '.mast img{width:46px;height:46px;flex:none}' +
      '.mast .co{font-size:15px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--green-dark);line-height:1.2}' +
      '.mast .ft{font-size:16px;font-weight:700;line-height:1.25;margin-top:1px}' +
      '.mast .pl{font-size:13px;color:var(--muted);margin-top:1px}' +
      '.line{display:flex;align-items:center;gap:10px;padding:9px 0;border-top:1px solid var(--line)}' +
      '.line .nm{flex:1;font-weight:600;font-size:16px;line-height:1.25}' +
      '.seg{display:flex;gap:5px;flex:none}' +
      '.seg button{border:1px solid var(--line);background:#fff;border-radius:9px;min-width:44px;height:42px;' +
      'font-size:15px;font-weight:800;color:var(--muted);cursor:pointer;padding:0 6px}' +
      '.seg button.on.good{background:var(--green);color:#fff;border-color:var(--green)}' +
      '.seg button.on.bad{background:var(--bad);color:#fff;border-color:var(--bad)}' +
      '.seg button.on.na{background:#8A8372;color:#fff;border-color:#8A8372}' +
      '.fix{background:var(--bad-bg);border-radius:10px;padding:6px 12px 12px;margin:0 0 8px}' +
      '.fix .fl{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:6px}' +
      '.fix .fl label{display:flex;align-items:center;gap:6px;margin:4px 0;font-weight:600;font-size:15px}' +
      '.fix .fl input{width:22px;height:22px;margin:0}' +
      '.fix input[type=text]{margin-top:6px}' +
      '.sign{display:grid;grid-template-columns:1fr 1fr;gap:10px}' +
      '.tally{font-size:15px;color:var(--muted);margin:10px 0 2px}' +
      '.part{border:1px solid var(--line);border-radius:12px;padding:0 14px 12px;margin:12px 0;background:#fff}' +
      '.part>h3{font-size:17px;margin:14px 0 2px}.part>p.why{font-size:14px;color:var(--muted);margin:2px 0 0}' +
      '.yn{display:flex;gap:8px;margin:8px 0 0}' +
      '.yn button{border:1px solid var(--line);background:#fff;border-radius:9px;min-width:64px;height:42px;font-size:16px;font-weight:700;color:var(--muted);cursor:pointer}' +
      '.yn button.on{background:var(--green);color:#fff;border-color:var(--green)}' +
      '.rec{border-top:1px solid var(--line);padding:10px 0}.rec b{font-size:16px}' +
      '.rec .ln{font-size:15px;color:var(--muted)}.rec .ln.n{color:var(--bad);font-weight:700}';
    document.head.appendChild(c);
  }

  /* One builder for both per-line records: the only differences are the buttons and the follow-up boxes. */
  function lineRecord(cfg) {
    ssopCss();
    const items = cfg.items(), state = {};
    /* Items stay a flat array of unique keys, so state, selectors and the tally are untouched.
       A record that wants sections supplies label() and group(): the pre-op one does, because the
       two units hold different equipment; the operational one does not and renders exactly as
       before. */
    const label = cfg.label || (it => it);
    const groupOf = cfg.group || (() => '');
    items.forEach(it => { state[it] = { status: '', note: '' }; FIXES.forEach(f => { state[it][f[0]] = false; }); });
    const row = (it, i) => (groupOf(it) && groupOf(it) !== (i ? groupOf(items[i - 1]) : null)
        ? '<div class="grp" style="margin-top:' + (i ? '18px' : '2px') + '">' + esc(groupOf(it)) + '</div>' : '') +
      '<div class="line" data-it="' + esc(it) + '"><div class="nm">' + esc(label(it)) + '</div>' +
      '<div class="seg">' + cfg.choices.map(ch => '<button type="button" data-set="' + ch[0] + '" class="' + ch[2] + '">' + esc(ch[1]) + '</button>').join('') + '</div></div>' +
      '<div class="fix" data-fix="' + esc(it) + '" hidden>' + cfg.fixHtml(it) + '</div>';
    frame(cfg.name, '',
      '<div class="card">' + masthead(cfg.formTitle) + '<div class="sign"><div><label for="sd">Date</label><input id="sd" type="text" value="' + esc(stamp().split(' ')[0]) + '" readonly></div>' +
      '<div><label for="stm">Time</label><input id="stm" type="time" value="' + esc(nowHM().replace(/^(\d):/, '0$1:')) + '"></div></div>' +
      '<label for="sin">Your initials</label><input id="sin" type="text" maxlength="4" autocapitalize="characters" value="' + esc(myInitials()) + '">' +
      '<p class="status">' + cfg.intro + '</p></div>' +
      '<div class="card"><button class="btn ghost" id="allgood" style="width:100%">' + esc(cfg.allLabel) + '</button>' +
      '<p class="status" style="margin-top:8px">Walk the room first. Your initials go on this record: ' + esc(cfg.allWhy) + '</p>' +
      '<div style="margin-top:10px">' + items.map(row).join('') + '</div>' +
      '<div class="tally" id="tally"></div><div class="err" id="serr"></div>' +
      '<button class="submit" id="ssave">' + esc(cfg.saveLabel) + '</button></div>');
    const box = $app;
    const tally = () => {
      const done = items.filter(it => state[it].status).length;
      const bad = items.filter(it => state[it].status === cfg.badValue);
      const held = bad.filter(it => cfg.heldTest(state[it]));
      document.getElementById('tally').innerHTML = done + ' of ' + items.length + ' marked' +
        (bad.length ? ' · <b style="color:var(--bad)">' + bad.length + ' ' + esc(cfg.badWord) + '</b>' : '') +
        (held.length ? ' · <b style="color:var(--bad)">' + held.length + ' ' + esc(cfg.heldWord) + '</b>' : '');
    };
    const paint = it => {
      const line = box.querySelector('[data-it="' + CSS.escape(it) + '"]');
      line.querySelectorAll('[data-set]').forEach(b => b.classList.toggle('on', b.dataset.set === state[it].status));
      const fx = box.querySelector('[data-fix="' + CSS.escape(it) + '"]');
      if (fx) fx.hidden = state[it].status !== cfg.badValue;
      tally();
    };
    items.forEach(it => {
      box.querySelector('[data-it="' + CSS.escape(it) + '"]').querySelectorAll('[data-set]').forEach(b => {
        b.onclick = () => { state[it].status = state[it].status === b.dataset.set ? '' : b.dataset.set; paint(it); };
      });
      const fx = box.querySelector('[data-fix="' + CSS.escape(it) + '"]');
      if (!fx) return;
      fx.querySelectorAll('[data-f]').forEach(cb => { cb.onchange = () => { state[it][cb.dataset.f] = cb.checked; tally(); }; });
      const nt = fx.querySelector('[data-note]');
      if (nt) nt.oninput = () => { state[it].note = nt.value; };
    });
    document.getElementById('allgood').onclick = () => {
      items.forEach(it => { if (!state[it].status) { state[it].status = cfg.goodValue; paint(it); } });
    };
    items.forEach(paint);
    document.getElementById('ssave').onclick = () => {
      const err = m => { document.getElementById('serr').textContent = m; };
      const initials = document.getElementById('sin').value.trim().toUpperCase();
      if (!initials) return err('Put your initials on the record.');
      const blank = items.filter(it => !state[it].status);
      // Names, not keys — the key carries the unit prefix and nobody should ever see it.
      if (blank.length) return err('Still to mark: ' + blank.slice(0, 4).map(label).join(', ') + (blank.length > 4 ? ' and ' + (blank.length - 4) + ' more' : '') + '.');
      const bad = items.filter(it => state[it].status === cfg.badValue);
      const held = bad.filter(it => cfg.heldTest(state[it]));
      // A record can want more than "every line marked" — the close-out wants a reason on any line
      // that was not done. Caught here as well as on the server, so the answer is instant.
      const extra = cfg.extraCheck ? cfg.extraCheck(items, state, label) : '';
      if (extra) return err(extra);
      queue(cfg.action, { initials, time: document.getElementById('stm').value, items: state }, cfg.title);
      // The callback writes a message a person reads, so it gets names rather than keys.
      cfg.done(bad.map(label), held.map(label));
    };
  }

  function showPreop() {
    lineRecord({
      name: 'preop', title: 'Pre-op sanitation', formTitle: 'Pre-Operational Sanitation Record', action: 'preop',
      items: preopKeys, label: preopLabel, group: preopGroup,
      choices: [['A', 'A', 'good'], ['U', 'U', 'bad']],
      goodValue: 'A', badValue: 'U', badWord: 'unacceptable', heldWord: 'not released',
      heldTest: x => !x.released,
      intro: 'Before any deer is touched. A = acceptable, U = unacceptable. Anything marked U has to be recleaned, resanitized, reinspected and released before it is used.',
      allLabel: 'Mark every line A', allWhy: 'change any line you found a problem with.',
      saveLabel: 'Sign and save the record',
      fixHtml: () => '<b>Actions for rejected equipment</b><div class="fl">' +
        FIXES.map(f => '<label><input type="checkbox" data-f="' + f[0] + '"> ' + f[1] + '</label>').join('') + '</div>' +
        '<input type="text" data-note placeholder="What was wrong?" maxlength="200">',
      done: (bad, held) => showHome(!bad.length ? 'Pre-op record signed. Nothing unacceptable.'
        : held.length ? 'Record saved. <b>' + held.length + ' line' + (held.length === 1 ? '' : 's') + ' not released yet: ' + esc(held.join(', ')) +
          '.</b> Do not use it until it is recleaned, resanitized, reinspected and released, and fill in a corrective action record.'
        : 'Record saved. ' + bad.length + ' line' + (bad.length === 1 ? '' : 's') + ' recleaned and released. Fill in a corrective action record for it.'),
    });
  }

  function showOpSsop() {
    lineRecord({
      name: 'opssop', title: 'Operational sanitation', formTitle: 'Processing Operational Sanitation Record', action: 'opssop',
      items: opItems,
      choices: [['C', 'C', 'good'], ['N', 'N', 'bad'], ['N/A', 'N/A', 'na']],
      goodValue: 'C', badValue: 'N', badWord: 'noncompliant', heldWord: 'to write up',
      heldTest: () => true,
      intro: 'At least once every day the facility runs, and as often after that as you walk it. C = compliant, N = noncompliant, N/A = does not apply. Each walk is its own record.',
      allLabel: 'Mark every line C', allWhy: 'change any line you found a problem with.',
      saveLabel: 'Sign and save the record',
      fixHtml: () => '<b>Noncompliant</b><p class="status" style="margin:2px 0 0">Say what you found, then fill in a corrective action record.</p>' +
        '<input type="text" data-note placeholder="What did you find?" maxlength="200">',
      done: bad => showHome(!bad.length ? 'Operational sanitation record signed. All compliant.'
        : 'Record saved. <b>' + bad.length + ' noncompliant: ' + esc(bad.join(', ')) + '.</b> Fill in a corrective action record now.'),
    });
  }

  /* End-of-shift close-out. The third use of lineRecord. Done / No / N/A rather than C / N / N/A,
     because this is a list of jobs rather than a judgement of conditions, and a line marked No has
     to say why: waste or a drain left overnight is the thing the pest control programme exists to
     prevent, so "no" on its own is not a record of anything. */
  function showCloseOut() {
    lineRecord({
      name: 'closeout', title: 'Close-out', formTitle: 'End-of-Shift Close-Out Record', action: 'closeout',
      items: closeItems,
      choices: [['Done', 'Done', 'good'], ['No', 'No', 'bad'], ['N/A', 'N/A', 'na']],
      goodValue: 'Done', badValue: 'No', badWord: 'not done', heldWord: 'to write up',
      heldTest: () => true,
      intro: 'Last thing before you lock up. Walk it, do it, then mark it. Anything marked No needs a reason, and the managers are told straight away.',
      allLabel: 'Mark every line Done', allWhy: 'change any line you did not get to.',
      saveLabel: 'Sign and close out',
      fixHtml: () => '<b>Not done</b><p class="status" style="margin:2px 0 0">Say why. Waste or a drain left overnight needs a corrective action record too.</p>' +
        '<input type="text" data-note placeholder="Why not?" maxlength="200">',
      extraCheck: (items, state, label) => {
        const why = items.filter(it => state[it].status === 'No' && !String(state[it].note || '').trim());
        return why.length ? 'Say why it was not done: ' + why.map(label).join(', ') + '.' : '';
      },
      done: bad => showHome(!bad.length ? 'Closed out. Everything done \u2014 thank you.'
        : 'Close-out saved. <b>' + bad.length + ' not done: ' + esc(bad.join(', ')) + '.</b> The managers have been told. Fill in a corrective action record if waste or a drain was left.'),
    });
  }

  /* Sanitation Corrective Action Form: Parts I, II and III, as on the paper. */
  function showCorrective(linked) {
    ssopCss();
    const ta = (id, ph) => '<textarea id="' + id + '" maxlength="1000" placeholder="' + esc(ph || '') + '"></textarea>';
    const yn = id => '<div class="yn" data-yn="' + id + '"><button type="button" data-v="Yes">Yes</button><button type="button" data-v="No">No</button></div>';
    frame('corrective', '',
      '<div class="card">' + masthead('Sanitation Corrective Action Form') + '<div class="sign"><div><label for="cd">Date</label><input id="cd" type="text" value="' + esc(stamp().split(' ')[0]) + '" readonly></div>' +
      '<div><label for="ct">Time</label><input id="ct" type="time" value="' + esc(nowHM().replace(/^(\d):/, '0$1:')) + '"></div></div>' +
      '<label for="ci">Your initials</label><input id="ci" type="text" maxlength="4" autocapitalize="characters" value="' + esc(myInitials()) + '">' +
      /* The form asked what you did about it and never what it was. The SOP has named this since
         5 November: Part 1 records "what was found, what was done, what prevents it returning".
         It sits above the parts because it is the first thing you know (Joe, 7 November). */
      '<label for="cf">What was found?</label><p class="why">The problem itself, in your words. Where it was and what you saw.</p>' +
      '<textarea id="cf" maxlength="1000" placeholder="Mouse droppings behind the hand sink"></textarea>' +
      '<label>Which part of the form is this?</label>' +
      '<label class="choice"><input type="checkbox" id="pI"> <span><b>Part I</b> — the building and the site<div class="hint">Walls, floors, ceilings and other surfaces food does not touch</div></span></label>' +
      '<label class="choice"><input type="checkbox" id="pII"> <span><b>Part II</b> — pre-op sanitation, no product involved<div class="hint">Found before any deer was on the table</div></span></label>' +
      '<label class="choice"><input type="checkbox" id="pIII"> <span><b>Part III</b> — operational sanitation, or pre-op with product involved<div class="hint">Meat may have been affected</div></span></label>' +
      (linked ? '<p class="status">Linked to ' + esc(linked) + '.</p>' : '') + '</div>' +
      '<div class="part" id="bI" hidden><h3>Part I — building and site</h3>' +
      '<label>Immediate corrective measures</label><p class="why">What did you do to correct it?</p>' + ta('i1') +
      '<label>Further planned actions</label><p class="why">How do you prevent it happening again?</p>' + ta('i2') + '</div>' +
      '<div class="part" id="bII" hidden><h3>Part II — pre-op, no product involved</h3>' +
      '<label>Immediate corrective measures</label><p class="why">What did you do to correct it?</p>' + ta('ii1') +
      '<label>Further planned actions</label><p class="why">How do you prevent it happening again?</p>' + ta('ii2') + '</div>' +
      '<div class="part" id="bIII" hidden><h3>Part III — product may be involved</h3>' +
      '<label>1. What is the final disposition of the product?</label>' + ta('iii1', 'Held, re-worked, condemned, released…') +
      '<label>2. Were sanitary conditions restored?</label>' + yn('iii2') +
      '<label>How?</label>' + ta('iii3') +
      '<label>3. Were measures taken to prevent recurrence?</label>' + yn('iii4') +
      '<label>What were the measures?</label>' + ta('iii5') +
      '<label>4. Was the SSOP re-evaluated and modified?</label>' + yn('iii6') +
      '<label>Explain</label>' + ta('iii7') + '</div>' +
      '<div class="err" id="cerr"></div><button class="submit" id="csave">Sign and save the record</button>' +
      '<p class="status">Joe and the other managers get this on their phones as soon as it is saved.</p>');
    const ynv = {};
    $app.querySelectorAll('[data-yn]').forEach(g => g.querySelectorAll('[data-v]').forEach(b => {
      b.onclick = () => { const k = g.dataset.yn; ynv[k] = ynv[k] === b.dataset.v ? '' : b.dataset.v;
        g.querySelectorAll('[data-v]').forEach(x => x.classList.toggle('on', x.dataset.v === ynv[k])); };
    }));
    const show = () => { ['I', 'II', 'III'].forEach(k => { document.getElementById('b' + k).hidden = !document.getElementById('p' + k).checked; }); };
    ['I', 'II', 'III'].forEach(k => { document.getElementById('p' + k).onchange = show; });
    show();
    document.getElementById('csave').onclick = () => {
      const err = m => { document.getElementById('cerr').textContent = m; };
      const v = id => (document.getElementById(id).value || '').trim();
      const initials = v('ci').toUpperCase();
      if (!initials) return err('Put your initials on the record.');
      if (!v('cf')) return err('Say what was found. The record has to state the problem, not only the fix.');
      const parts = ['I', 'II', 'III'].filter(k => document.getElementById('p' + k).checked);
      if (!parts.length) return err('Choose which part of the form this is.');
      if (parts.indexOf('I') >= 0 && !v('i1')) return err('Part I: say what you did to correct it.');
      if (parts.indexOf('II') >= 0 && !v('ii1')) return err('Part II: say what you did to correct it.');
      if (parts.indexOf('III') >= 0) {
        if (!v('iii1')) return err('Part III: give the final disposition of the product.');
        if (!ynv.iii2) return err('Part III: were sanitary conditions restored?');
        if (ynv.iii2 === 'Yes' && !v('iii3')) return err('Part III: say how sanitary conditions were restored.');
        if (!ynv.iii4) return err('Part III: were measures taken to prevent recurrence?');
        if (ynv.iii4 === 'Yes' && !v('iii5')) return err('Part III: say what the measures were.');
        if (!ynv.iii6) return err('Part III: was the SSOP re-evaluated and modified?');
      }
      queue('corrective', { initials, time: v('ct'), parts, linked: linked || '', found: v('cf'),
        i1: v('i1'), i2: v('i2'), ii1: v('ii1'), ii2: v('ii2'),
        iii1: v('iii1'), iii2: ynv.iii2 || '', iii3: v('iii3'), iii4: ynv.iii4 || '', iii5: v('iii5'),
        iii6: ynv.iii6 || '', iii7: v('iii7') }, 'Corrective action');
      showHome('Corrective action record saved. The managers have it.');
    };
  }

  /* Read the day's records back: what an inspector asks to see. */
  async function showRecords() {
    ssopCss();
    frame('records', 'Sanitation records', '<div id="rc"><p class="status">Loading…</p></div>');
    let out;
    try { out = await call({ action: 'ssop' }); }
    catch (e) { document.getElementById('rc').innerHTML = '<div class="note bad">' + esc(e.offline ? 'Needs signal.' : e.message) + '</div>'; return; }
    const lines = (f, showFix) => f.lines.map(l => '<div class="ln' + (/^(U|N|No)$/.test(l.status) ? ' n' : '') + '">' +
      esc(l.status) + ' · ' + esc(l.item) + (l.note ? ' — ' + esc(l.note) : '') +
      (showFix && /^U$/.test(l.status) ? ' [' + FIXES.filter(x => l[x[0]]).map(x => x[1]).join(', ') + (l.released ? '' : ' — NOT RELEASED') + ']' : '') + '</div>').join('');
    const form = (f, showFix) => '<div class="rec"><b>' + esc(f.time || '') + ' · ' + esc(f.initials) + '</b>' +
      '<div class="status">' + esc(f.staff) + '</div>' + lines(f, showFix) + '</div>';
    const corr = c => '<div class="rec"><b>' + esc(c.time) + ' · Part ' + esc(c.parts) + ' · ' + esc(c.initials) + '</b>' +
      (c.found ? '<div class="ln n">Found: ' + esc(c.found) + '</div>' : '') +
      ['i1', 'i2', 'ii1', 'ii2', 'iii1', 'iii3', 'iii5', 'iii7'].filter(k => c[k]).map(k => '<div class="ln">' + esc(c[k]) + '</div>').join('') +
      (c.iii2 ? '<div class="ln">Sanitary conditions restored: ' + esc(c.iii2) + ' · Prevent recurrence: ' + esc(c.iii4) + ' · SSOP re-evaluated: ' + esc(c.iii6) + '</div>' : '') + '</div>';
    document.getElementById('rc').innerHTML =
      '<p class="status">' + esc(out.date) + '</p>' +
      '<div class="card">' + masthead('Pre-Operational Sanitation Record') +
      (out.preop.length ? out.preop.map(f => form(f, true)).join('') : '<div class="note bad">No pre-op record today. Nothing should be on the table until there is one.</div>') + '</div>' +
      '<div class="card">' + masthead('Processing Operational Sanitation Record') +
      (out.op.length ? out.op.map(f => form(f, false)).join('') : '<p class="status">No record yet today.</p>') + '</div>' +
      '<div class="card">' + masthead('End-of-Shift Close-Out Record') +
      ((out.closeout && out.closeout.length) ? out.closeout.map(f => form(f, false)).join('') : '<p class="status">Not closed out yet today.</p>') + '</div>' +
      '<div class="card">' + masthead('Sanitation Corrective Action Form') +
      (out.corrective.length ? out.corrective.map(corr).join('') : '<p class="status">None today.</p>') + '</div>';
  }


  /* ---------- Temp Stick sensors ----------
   * Three Temp Stick Pro units with external probes (Joe ordered them 1 Nov 2026): one in cold
   * storage and one in each MHU. No freezer sensors — the freezers are not sited yet, so freezer
   * temperatures stay hand-logged in the Log book until they are.
   *
   * The sensors send their own texts and emails, and those stay on: they are the fast path. This
   * screen exists for the three things the sensors cannot do for themselves — say which physical
   * space each one is in, show whether each is actually still talking, and prove it was cold.
   */
  async function showSensors() {
    frame('sensors', 'Sensors', '<div id="sn"><p class="status">Loading…</p></div>');
    let out;
    try { out = await call({ action: 'sensors' }); }
    catch (e) { document.getElementById('sn').innerHTML = '<div class="note bad">' + esc(e.offline ? 'Needs signal.' : e.message) + '</div>'; return; }
    const box = document.getElementById('sn');
    const chip = (s) => s.offline ? '<span class="tag prv">OFFLINE</span>' : s.silent ? '<span class="tag prv">QUIET</span>'
      : s.over ? '<span class="tag prv">OVER LIMIT</span>' : '<span class="tag don">OK</span>';
    const mins = m => m === null ? 'never' : m < 2 ? 'just now' : m < 90 ? m + ' min ago' : Math.round(m / 60) + ' h ago';
    const one = s => '<div class="card' + (s.over || s.offline || s.silent ? ' red' : '') + '">' +
      '<b>' + esc(s.space || s.name) + '</b> ' + chip(s) +
      '<div class="status">' + esc(s.name) + ' · ' + esc(s.id) + (s.space ? '' : ' · <b>not placed yet</b>') + '</div>' +
      '<div class="tiles">' + tile(s.f === null ? '—' : s.f + '°', 'Now' + (s.limit !== null ? ' (max ' + s.limit + '°)' : '')) +
      tile(s.humidity === null ? '—' : s.humidity + '%', 'Humidity') +
      tile(s.battery === null ? '—' : s.battery + '%', 'Battery') +
      tile(mins(s.minsAgo), 'Last heard') + '</div>' +
      (s.reads === 'Body' ? '<div class="note warn"><b>No probe reading.</b> This is reporting the air around the sensor body, not inside the unit. Check the probe is plugged in and switched on in the Temp Stick app.</div>' : '') +
      (s.lowBattery ? '<div class="note warn">Battery at ' + s.battery + '%. Change it before the sensor stops reporting.</div>' : '') +
      (s.silent && !s.offline ? '<div class="note bad">Nothing heard for ' + mins(s.minsAgo) + '. Log temperatures by hand until it is back.</div>' : '') +
      (out.manager ? '<div style="margin-top:8px"><label>Where is it?</label>' +
        '<select data-sid="' + esc(s.id) + '"><option value="">— not placed —</option>' +
        out.spaces.map(sp => '<option value="' + esc(sp.space) + '"' + (sp.space === s.space ? ' selected' : '') + (sp.covered && sp.space !== s.space ? ' disabled' : '') + '>' +
          esc(sp.space) + ' (never above ' + sp.limit + '°F)' + (sp.covered && sp.space !== s.space ? ' — taken' : '') + '</option>').join('') +
        '</select></div>' : (s.space ? '' : '<div class="status">A manager needs to say where this one is.</div>'));
    const waiting = out.spaces.filter(sp => !sp.covered);
    box.innerHTML =
      (!out.keySet ? '<div class="note bad"><b>No API key set.</b> Put the Temp Stick key in the script\'s properties as TEMPSTICK_KEY. Until then nothing is read automatically and temperatures have to be logged by hand.</div>'
        : !out.on ? '<div class="note warn"><b>Monitoring is switched off</b> in Settings (Temp Stick monitoring). Nothing is being recorded.</div>' : '') +
      (out.sensors.length ? out.sensors.map(one).join('')
        : '<div class="card"><p class="status">No sensor has reported yet. A new Temp Stick shows up here within about 15 minutes of being set up on WiFi — there is nothing to type in, it finds itself.</p></div>') +
      (waiting.length ? '<div class="card"><b>No sensor yet</b><div class="status">' + esc(waiting.map(sp => sp.space).join(', ')) +
        '. These still need a temperature written down in the Log book.</div></div>' : '') +
      '<div class="card"><b>The record</b><div class="status">Every reading is summarised into one row a day for each space — low, high, average, and how long it was above the limit. That is the record an inspector asks for, and it lives in the Facility Log, not in the Temp Stick account.</div>' +
      '<button class="btn" id="sn-rec">The temperature record</button></div>';
    box.querySelectorAll('select[data-sid]').forEach(sel => sel.onchange = async () => {
      const id = sel.dataset.sid, space = sel.value;
      sel.disabled = true;
      try { await call({ action: 'assignsensor', id: id, space: space }); showSensors(); }
      catch (e) { sel.disabled = false; toast(e.message, false); }
    });
    const rb = document.getElementById('sn-rec'); if (rb) rb.onclick = () => showTempRecord();
  }

  /** The permanent temperature record: one row a day per space. Printable, and it is the answer to
      "show me it was cold", which a live dashboard cannot give. */
  async function showTempRecord(days) {
    const n = days || 30;
    frame('temprecord', 'Temperature record', '<div id="tr"><p class="status">Loading…</p></div>');
    let out;
    try { out = await call({ action: 'temprecord', days: n }); }
    catch (e) { document.getElementById('tr').innerHTML = '<div class="note bad">' + esc(e.offline ? 'Needs signal.' : e.message) + '</div>'; return; }
    const byDate = {};
    (out.rows || []).forEach(r => { (byDate[r.date] = byDate[r.date] || []).push(r); });
    const dates = Object.keys(byDate).sort().reverse();
    const row = r => '<div class="trow' + (r.runOver >= 240 ? ' bad' : r.minsOver ? ' warnrow' : '') + '">' +
      '<div><b>' + esc(r.space) + '</b><div class="status">' +
      r.readings + ' readings · low ' + r.low + '° · average ' + r.avg + '°' +
      (r.minsOver ? ' · <b>' + r.minsOver + ' min above ' + r.limit + '°</b>' + (r.runOver ? ' (longest run ' + (r.runOver >= 60 ? Math.round(r.runOver / 60 * 10) / 10 + ' h' : r.runOver + ' min') + ')' : '') : ' · never above ' + r.limit + '°') +
      (r.offline ? ' · ' + r.offline + ' uploaded late' : '') + '</div></div>' +
      '<div class="tval">' + r.high + '°</div></div>';
    document.getElementById('tr').innerHTML =
      '<div class="card">' + masthead('Temperature Record') +
      '<div class="status">The high of each day is the number on the right. A day is flagged when any reading went above the space\'s limit, and flagged red when it stayed above it for four hours or more, which is the point the procedure says a manager decides what is kept.</div></div>' +
      (dates.length ? dates.map(d => '<div class="card"><b>' + esc(d) + '</b>' + byDate[d].map(row).join('') + '</div>').join('')
        : '<div class="card"><p class="status">Nothing recorded yet. A day appears here once a sensor has been placed and has reported for it.</p></div>') +
      (dates.length >= 1 ? '<div class="card"><button class="btn alt" id="tr-more">Show the last ' + (n >= 365 ? 400 : n >= 90 ? 365 : 90) + ' days</button></div>' : '');
    const mb = document.getElementById('tr-more');
    if (mb) mb.onclick = () => showTempRecord(n >= 365 ? 400 : n >= 90 ? 365 : 90);
  }

  /* ---------- start ---------- */
  /* Register, and say so when a newer copy has taken over.

     An update used to arrive silently, which meant nobody could tell whether a phone was running
     the fix or yesterday's app — on 6 November that cost two rounds of "it still does it" against
     a version that no longer existed. The reload is offered rather than taken: a processor may be
     halfway through a check-in, and throwing that away to be a few minutes more current is the
     wrong trade. Checked again whenever the app is brought back to the front, which on an iPad at
     a bench is many times a day. */
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(reg => {
      if (!reg) return;
      const check = () => { try { reg.update(); } catch (e) {} };
      document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
      setInterval(check, 15 * 60000);
    }).catch(() => {});
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      const el = document.getElementById('msg');
      if (!el) { return; }
      el.innerHTML = '<div class="note ok"><b>A newer version of the app is ready.</b> ' +
        'Nothing is lost by reloading — anything waiting to send goes with it.' +
        '<button class="btn" id="swgo" style="margin-top:8px">Reload now</button></div>';
      const b = document.getElementById('swgo');
      if (b) b.onclick = () => { reloading = true; location.reload(); };
      window.scrollTo(0, 0);
    });
  }
  /* Square may have just reopened us with a payment result. Read it before anything draws, so a
     cold start after the jump still finishes the job rather than losing it. */
  const sqBack = (() => { try { return squareReturn(); } catch (e) { return null; } })();
  if (st.pin && st.staff) {
    if (sqBack) { showDesk(); refresh(true); setTimeout(() => squareFinish(sqBack), 400); }
    else if (pendingBand) { const b = pendingBand; pendingBand = null; showDeer(b); refresh(true); }
    else { showHome(); refresh(true); }
    flush();
  } else showLogin(pendingBand ? 'Sign in to see band ' + pendingBand + '.' : '');
  window.addEventListener('hashchange', () => { const m = location.hash.match(/[#&]d=([^&]+)/); if (m && st.staff) { history.replaceState(null, '', location.pathname); showDeer(decodeURIComponent(m[1])); } });
})();
