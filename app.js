/* Home Ground hunter app.
 * Screens: sign-in, home (with On stand / Leaving), Book a Hunt, Report Your Hunt, Harvest, tracking, Stand & Camera Log,
 * Find my stand (compass and distance to your own stands, cameras and truck).
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
  // fresh = a new fix right now (On stand, Leaving, Use my location); otherwise one up to a minute old is fine.
  function gps(fresh) {
    return new Promise(resolve => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        p => resolve({ lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), acc: Math.round(p.coords.accuracy), at: stamp() }),
        () => resolve(null), { enableHighAccuracy: true, timeout: fresh ? 20000 : 15000, maximumAge: fresh ? 0 : 60000 });
    });
  }
  // Is a GPS fix on the property? Uses the boundary sent at sign-in (only for your own assigned properties).
  // Same rule as the Registry: parcel lines are approximate, so a fix just outside the line counts as "at the line".
  const FT = 3.28084, WEAK_FT = 250, GRACE_FT = 75;
  function whereOn(code, g) {
    const accFt = Math.round(g.acc * FT);
    const p = (me.properties || []).find(x => x.code === code);
    const rings = p && p.bounds;
    if (!rings) return { status: 'unknown', accFt, weak: accFt > WEAK_FT };
    const kx = Math.cos(g.lat * Math.PI / 180) * 364000, ky = 364000;
    let inside = false, edge = Infinity;
    rings.forEach(ring => {
      const P = ring.map(q => [(q[0] - g.lng) * kx, (q[1] - g.lat) * ky]);
      for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
        const [xi, yi] = P[i], [xj, yj] = P[j];
        if ((yi > 0) !== (yj > 0) && xi + (xj - xi) * (0 - yi) / (yj - yi) > 0) inside = !inside;
        const dx = xj - xi, dy = yj - yi, L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, -(xi * dx + yi * dy) / L)) : 0;
        edge = Math.min(edge, Math.hypot(xi + t * dx, yi + t * dy));
      }
    });
    edge = Math.round(edge);
    const weak = accFt > WEAK_FT && !(inside && edge >= accFt);
    if (inside) return { status: 'inside', accFt, weak, edgeFt: edge };
    return { status: edge <= GRACE_FT + Math.min(accFt, WEAK_FT) ? 'edge' : 'outside', accFt, weak, edgeFt: edge };
  }
  function whereText(code, g) {
    const w = whereOn(code, g);
    const acc = ' (GPS ±' + w.accFt + ' ft)';
    if (w.status === 'inside') return { ok: !w.weak, w, text: 'You\'re on ' + code + acc + '.' + (w.weak ? ' The GPS is weak, so the office may ask.' : '') };
    if (w.status === 'edge') return { ok: !w.weak, w, text: 'You\'re at the edge of ' + code + acc + '. That\'s fine: parcel lines on the map are approximate.' };
    if (w.status === 'unknown') return { ok: !w.weak, w, text: 'Location recorded' + acc + '. The office will check it against ' + code + '.' };
    return { ok: false, w, text: 'Your phone puts you about ' + w.edgeFt + ' ft outside ' + code + acc + '.' };
  }
  // A "Use my location" button with a reason box if it can't get a fix. Returns a holder whose .g is the fix.
  function locField(label, hint) {
    return '<label>' + label + (hint ? ' <span class="hint">' + hint + '</span>' : '') + '</label>' +
      '<button type="button" class="big alt" id="loc-btn" style="margin:6px 0">Use my location</button><div id="loc-out"></div>' +
      '<div id="loc-why" hidden><label for="why">Couldn\'t get a location? Tell us why.</label><input id="why" type="text"></div>';
  }
  function wireLoc(outsideNote) {
    const hold = { g: null };
    const btn = document.getElementById('loc-btn'), out = document.getElementById('loc-out');
    btn.onclick = async () => {
      btn.disabled = true; btn.firstChild.textContent = 'Getting your location…';
      const g = await gps(true);
      btn.disabled = false;
      if (!g) {
        hold.g = null; btn.firstChild.textContent = 'Try again';
        out.innerHTML = '<div class="note bad">Couldn\'t get a location. Check that Location is on for this app (or your browser), step into the open, and try again.</div>';
        document.getElementById('loc-why').hidden = false;
        return;
      }
      hold.g = g; btn.firstChild.textContent = 'Update my location';
      show();
      document.getElementById('loc-why').hidden = true;
    };
    const show = () => {
      if (!hold.g) return;
      const prop = v('prop'), r = prop ? whereText(prop, hold.g) : { ok: true, text: 'Location recorded (GPS ±' + Math.round(hold.g.acc * FT) + ' ft).' };
      out.innerHTML = '<div class="note ' + (r.ok ? 'ok' : 'warn') + '">Got it. ' + esc(r.text) + (r.ok ? '' : ' ' + esc(outsideNote || '')) + '</div>';
    };
    const sel = document.getElementById('prop');
    if (sel) sel.addEventListener('change', show);
    return hold;
  }
  // Reads when and where a photo was taken from its EXIF data (JPEG only), before shrink() drops it.
  // Returns {takenMs, lat, lng} (any may be missing), or null when the file has none. Phones often strip
  // the location from photos picked from the library, so a missing location is normal.
  async function readExif(file) {
    try {
      const buf = await file.slice(0, 262144).arrayBuffer(), dv = new DataView(buf);
      if (dv.byteLength < 4 || dv.getUint16(0) !== 0xFFD8) return null;
      let off = 2, tiff = -1;
      while (off + 4 <= dv.byteLength) {
        const mk = dv.getUint16(off), len = dv.getUint16(off + 2);
        if (mk === 0xFFE1 && dv.getUint32(off + 4) === 0x45786966) { tiff = off + 10; break; }
        if (mk === 0xFFDA || (mk & 0xFF00) !== 0xFF00) break;
        off += 2 + len;
      }
      if (tiff < 0 || tiff + 8 > dv.byteLength) return null;
      const le = dv.getUint16(tiff) === 0x4949;
      const u16 = o => dv.getUint16(o, le), u32 = o => dv.getUint32(o, le);
      const ifd = start => {
        const out = {};
        if (start + 2 > dv.byteLength) return out;
        const n = u16(start);
        for (let i = 0; i < n; i++) {
          const e = start + 2 + i * 12;
          if (e + 12 > dv.byteLength) break;
          out[u16(e)] = { type: u16(e + 2), count: u32(e + 4), at: e + 8 };
        }
        return out;
      };
      const ascii = x => {
        if (!x) return '';
        const o = x.count <= 4 ? x.at : tiff + u32(x.at);
        let s = '';
        for (let i = 0; i < x.count - 1 && o + i < dv.byteLength; i++) s += String.fromCharCode(dv.getUint8(o + i));
        return s.trim();
      };
      const rats = x => {
        if (!x) return null;
        const o = tiff + u32(x.at), r = [];
        for (let i = 0; i < 3; i++) { const d = u32(o + i * 8 + 4); r.push(d ? u32(o + i * 8) / d : 0); }
        return r[0] + r[1] / 60 + r[2] / 3600;
      };
      const ifd0 = ifd(tiff + u32(tiff + 4)), out = {};
      if (ifd0[0x8769]) {
        const ex = ifd(tiff + u32(ifd0[0x8769].at));
        const m = ascii(ex[0x9003] || ex[0x9004]).match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
        if (m) {
          const zone = ascii(ex[0x9011]);
          out.takenMs = /^[+-]\d{2}:\d{2}$/.test(zone)
            ? Date.parse(m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] + zone)
            : new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
        }
      }
      if (ifd0[0x8825]) {
        const gp = ifd(tiff + u32(ifd0[0x8825].at));
        const lat = rats(gp[2]), lng = rats(gp[4]);
        if (lat && lng) {
          out.lat = +(ascii(gp[1]) === 'S' ? -lat : lat).toFixed(6);
          out.lng = +(ascii(gp[3]) === 'W' ? -lng : lng).toFixed(6);
        }
      }
      return Object.keys(out).length ? out : null;
    } catch (e) { return null; }
  }
  // A short note under a harvest photo: when it was taken, and whether that was on the property.
  function photoNote(meta, code, day) {
    if (!meta) return '';
    const bits = [], warn = [];
    if (meta.takenMs) {
      const t = new Date(meta.takenMs);
      bits.push('Taken ' + t.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '.');
      const shotDay = day ? new Date(day + 'T00:00:00').getTime() : Date.now();
      if (t.getTime() < shotDay - 3600000 || t.getTime() > shotDay + 3 * 86400000) warn.push('That isn\'t the day of the shot.');
    }
    if (meta.lat && code) {
      const w = whereOn(code, { lat: meta.lat, lng: meta.lng, acc: 0 });
      if (w.status === 'inside' || w.status === 'edge') bits.push('On ' + code + '.');
      else if (w.status === 'outside') {
        const d = w.edgeFt >= 2640 ? (w.edgeFt / 5280).toFixed(1) + ' miles' : w.edgeFt + ' ft';
        bits.push('About ' + d + ' from ' + code + '.');
        if (w.edgeFt > 1500) warn.push('That\'s far from the property.');
      }
    }
    if (!bits.length) return '';
    return '<div class="note ' + (warn.length ? 'warn' : 'ok') + '">' + esc(bits.concat(warn).join(' ')) +
      (warn.length ? ' ' + esc('Use photos of this deer. The office checks photo dates and places against your report.') : '') + '</div>';
  }
  // Legal shooting hours (MassWildlife): half an hour before sunrise to half an hour after sunset. Sunrise and
  // sunset for Martha's Vineyard from the standard sunrise equation (within a minute or two).
  function sunTimes(iso) {
    const [y, mo, d] = iso.split('-').map(Number), rad = Math.PI / 180, lat = 41.39, lng = -70.62;
    const J = Date.UTC(y, mo - 1, d, 12) / 864e5 + 2440587.5;
    const n = Math.ceil(J - 2451545.0 + 0.0008), Js = n - lng / 360;
    const M = (357.5291 + 0.98560028 * Js) % 360;
    const C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
    const L = (M + C + 180 + 102.9372) % 360;
    const Jt = 2451545.0 + Js + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * L * rad);
    const dec = Math.asin(Math.sin(L * rad) * Math.sin(23.4397 * rad));
    const w = Math.acos((Math.sin(-0.833 * rad) - Math.sin(lat * rad) * Math.sin(dec)) / (Math.cos(lat * rad) * Math.cos(dec))) / rad;
    const at = j => new Date((j - 2440587.5) * 864e5);
    return { rise: at(Jt - w / 360), set: at(Jt + w / 360) };
  }
  const minsOf = t => { const m = String(t || '').match(/^(\d{1,2}):(\d{2})/); return m ? +m[1] * 60 + +m[2] : null; };
  const clockOf = m => { const h = Math.floor(m / 60) % 24, mm = String(m % 60).padStart(2, '0'); return (h % 12 || 12) + ':' + mm + (h < 12 ? ' am' : ' pm'); };
  function legalWindow(iso) {
    const s = sunTimes(iso), local = d => d.getHours() * 60 + d.getMinutes();
    return { from: local(s.rise) - 30, to: local(s.set) + 30 };   // shown to the hunter as is
  }
  function legalGrace(iso) {   // 5 minutes either side: the sun times here can be a couple of minutes off
    const w = legalWindow(iso); return { from: w.from - 5, to: w.to + 5 };
  }
  // A time on today's date that hasn't happened yet (5 minutes' grace for a slow phone clock).
  const notYet = (iso, t) => iso === isoDate(new Date()) && minsOf(t) !== null && minsOf(t) > new Date().getHours() * 60 + new Date().getMinutes() + 5;
  function timeErrs(iso, tin, tout) {
    const e = [];
    if (notYet(iso, tin)) e.push('The time you got on stand hasn\'t happened yet. Check the time (and AM / PM).');
    if (notYet(iso, tout)) e.push('The time you left hasn\'t happened yet. Check the time (and AM / PM).');
    if (minsOf(tin) !== null && minsOf(tout) !== null && minsOf(tout) < minsOf(tin)) e.push('The time you left is before the time you got on stand.');
    return e;
  }
  /* Deer seasons. The server reads the dates from MassWildlife's website each week and sends them with the to-do list
   * (kept on the phone); this built-in list (checked 23 Oct 2026) is only used until then. Implements per season are
   * from MassWildlife's deer regulations. No hunting on Sundays. */
  const IMPLEMENTS = ['Archery', 'Shotgun', 'Primitive firearm'];
  const SEASONS_BUILT_IN = [
    ['Early season (Zones 13 & 14)', '2026-09-21', '2026-10-01', ['Archery', 'Primitive firearm']],
    ['Youth Deer Hunt (youth hunters only)', '2026-10-02', '2026-10-03', IMPLEMENTS],
    ['Archery season', '2026-10-05', '2026-11-28', ['Archery']],
    ['Shotgun season', '2026-11-30', '2026-12-12', IMPLEMENTS],
    ['Primitive firearms season', '2026-12-14', '2026-12-31', ['Archery', 'Primitive firearm']],
    ['Winter season (Zones 13 & 14)', '2027-01-01', '2027-02-13', ['Archery', 'Primitive firearm']]
  ].map(x => ({ name: x[0], from: x[1], to: x[2], tools: x[3] }));
  const seasonList = () => (me && Array.isArray(me.seasons) && me.seasons.length ? me.seasons : SEASONS_BUILT_IN);
  const lower = list => list.length === 1 ? list[0].toLowerCase() + ' only' : list.join(', ').toLowerCase().replace(/, ([^,]*)$/, ' or $1');
  // {closed: text} | {open: [seasons]} for a yyyy-mm-dd date.
  function seasonOn(iso) {
    if (!iso) return { open: [] };
    const [y, m, d] = iso.split('-').map(Number);
    if (new Date(y, m - 1, d).getDay() === 0) return { closed: 'That\'s a Sunday. Hunting isn\'t allowed on Sundays in Massachusetts. Check the date.' };
    const open = seasonList().filter(s => s.from <= iso && iso <= s.to);
    return open.length ? { open } : { closed: 'No deer season was open on ' + dayName(iso) + '. Check the date.' };
  }
  // Warning text for a harvest's date and implement, or ''.
  function seasonWarn(iso, impl) {
    const s = seasonOn(iso);
    if (s.closed) return s.closed;
    if (!impl || !s.open.length) return '';
    const tools = [].concat(...s.open.map(x => x.tools || []));
    if (tools.indexOf(impl) >= 0) return '';
    return impl + ' isn\'t legal on ' + dayName(iso) + ': ' + s.open.map(x => x.name + ' allows ' + lower(x.tools)).join('; ') + '. Check the implement you tapped.';
  }
  // One line for the home screen: the season open today (or the next one).
  function seasonLine() {
    const today = isoDate(new Date()), list = seasonList();
    const now = list.filter(s => s.from <= today && today <= s.to);
    if (now.length) return 'Open now: ' + now.map(s => s.name + ' (' + lower(s.tools) + ') through ' + dayName(s.to)).join('; ') + '.' +
      (new Date().getDay() === 0 ? ' No hunting today: it\'s Sunday.' : '');
    const next = list.filter(s => s.from > today)[0];
    return next ? 'No deer season open today. Next: ' + next.name + ' from ' + dayName(next.from) + '.' : '';
  }
  // Why this hunter can't book that date (Sunday, no season open, youth-only day), or ''.
  function seasonBookProblem(iso) {
    const s = seasonOn(iso);
    if (s.closed) return /Sunday/.test(s.closed) ? 'No hunting on Sundays in Massachusetts. Pick another day.' : 'No deer season is open on ' + dayName(iso) + '. Pick another day.';
    if (s.open.length && s.open.every(x => /youth/i.test(x.name)) && !me.youth) return dayName(iso) + ' is the Youth Deer Hunt: only youth hunters (12 to 17) can book.';
    return '';
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
        me = { hunter: out.hunter, pin, name: out.name, phone: out.phone, properties: out.properties, stands: out.stands || [], youth: !!out.youth, refreshed: Date.now() };
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
      me.properties = out.properties; me.name = out.name; me.phone = out.phone; me.youth = !!out.youth; me.refreshed = Date.now();
      if (Array.isArray(out.stands)) { me.stands = out.stands; settleStandEdits(); }
      save(me);
    } catch (e) {
      if (e.fatal) { me = null; save(null); showLogin(e.message); }
    }
  }

  function showHome(note) {
    if (typeof stopThread === 'function') stopThread();
    if (findStop) findStop();
    $app.innerHTML = header() +
      (note ? '<div class="note ok">' + note + '</div>' : '') +
      '<div id="outbox-status" class="status"></div>' +
      '<div id="season" class="status"></div>' +
      '<div id="todo"></div><div id="alerts"></div><div id="push"></div><div id="outing"></div>' +
      '<button class="big" data-go="book">Book a Hunt<small>At least an hour before you go. Required before every hunt.</small></button>' +
      '<button class="big" data-go="hunt">Report Your Hunt<small>Every outing, within 48 hours, even if you saw nothing.</small></button>' +
      '<p class="center" style="margin:-2px 0 12px"><button class="plain" data-go="harvest">Report another deer</button><br><span class="hint">Took more than one, or found a deer later? The hunt report opens this for you otherwise.</span></p>' +
      (me.track
        ? '<button class="big" style="background:#8A2E1F" data-go="track">Tracking on ' + esc(me.track.property) + '<small>Open the tracking screen: route, warnings, I\'m finished.</small></button>'
        : '<button class="big alt" data-go="before">Tracking After Dark<small>Before you go in after dark. Needs signal: Home Ground is alerted at once.</small></button>') +
      '<button class="big alt" data-go="stand">Stand &amp; Camera Log<small>Every placement, move or removal.</small></button>' +
      '<button class="big" data-go="find">Find my stand<small>Compass and distance to your stands and cameras, or back to your truck.</small></button>' +
      '<button class="big" style="background:#8A5A00" data-go="help">Need a hand?<small>Ask other Island hunters to help track or drag a deer, through the app.</small></button>' +
      '<button class="big alt" data-go="messages" id="msg-btn">Messages<small>Your landowners and help chats.</small></button>' +
      '<h2>Your properties</h2><div class="card">' +
      (me.properties && me.properties.length
        ? me.properties.map(p => '<div>' + esc(p.code) + (p.town ? ' · ' + esc(p.town) : '') + '</div>').join('')
        : '<span class="status">None assigned yet. Home Ground will email you when you have one.</span>') +
      '</div><h2>Your bookings</h2><div class="card" id="bookings"><span class="status">Loading…</span></div>' +
      '<h2>Your points</h2><div class="card" id="points"><span class="status">Loading…</span></div>' +
      '<p class="center"><button class="plain" id="out">Sign out</button></p>';
    const screens = { book: showBook, hunt: () => (me.outing && me.outing.left ? showLeaving() : showHunt()), harvest: () => showHarvest(), before: showBefore, after: showAfter, track: () => showTracking(), stand: showStand, find: () => showFind(), help: showHelp, messages: showMessages };
    $app.querySelectorAll('[data-go]').forEach(b => b.onclick = () => screens[b.dataset.go]());
    renderTodo(); loadTodo(); renderSeason();
    document.getElementById('out').onclick = async () => {
      const waiting = (await outbox('all')).length;
      if (waiting && !confirm(waiting + ' report(s) haven\'t sent yet. Sign out anyway? They\'ll be lost.')) return;
      for (const i of await outbox('all')) await outbox('delete', i.clientId);
      me = null; save(null); showLogin();
    };
    refreshStatus(); flush(); renderAlerts(); checkAlerts(); renderPoints(); loadPoints(); renderBookings(); loadBookings(); loadUnread(); renderPush(); renderOuting();
  }

  /* ---------- On stand / Leaving ----------
   * Tap On stand when you settle in and Leaving when you head out. Each tap records where the phone is
   * (no screenshots), and Leaving opens a short hunt report with the times already filled in. */
  const clock = hhmm => { const [h, m] = String(hhmm).split(':').map(Number); return isNaN(h) ? hhmm : ((h % 12) || 12) + ':' + pad(m) + (h < 12 ? ' am' : ' pm'); };
  function todaysBookings() {
    const today = isoDate(new Date());
    return [...new Set((bookingsCache || []).filter(b => b.date === today).map(b => b.property))];
  }
  function renderOuting() {
    const box = document.getElementById('outing');
    if (!box || !me) return;
    const o = me.outing;
    if (o && !o.left) {
      const old = o.date !== isoDate(new Date());
      box.innerHTML = '<div class="note ' + (o.ok === false ? 'warn' : 'ok') + '"><b>On stand on ' + esc(o.property) + '</b> since ' +
        (old ? esc(dayName(o.date)) + ', ' : '') + esc(clock(o.onTime)) + '.' + (o.text ? '<br>' + esc(o.text) : '') + '</div>' +
        '<button class="big" style="background:#8A2E1F" id="leave">' + (old ? 'File that hunt report' : 'Leaving') +
        '<small>' + (old ? 'You didn\'t tap Leaving. Fill in when you left.' : 'Tap before you head out. Your hunt report is mostly filled in for you.') + '</small></button>';
      document.getElementById('leave').onclick = () => leave(old);
    } else if (o && o.left) {
      box.innerHTML = '<button class="big" style="background:#8A2E1F" id="finish">Finish your hunt report<small>' + esc(o.property) + ', ' +
        esc(clock(o.onTime)) + (o.leftTime ? ' to ' + esc(clock(o.leftTime)) : '') + '. Takes a minute.</small></button>';
      document.getElementById('finish').onclick = () => showLeaving();
    } else {
      const booked = todaysBookings();
      box.innerHTML = (booked.length
        ? booked.map(p => '<button class="big" data-on="' + esc(p) + '">On stand · ' + esc(p) + '<small>Tap when you\'re settled in. Records where you are.</small></button>').join('')
        : '') +
        '<button class="big' + (booked.length ? ' alt' : '') + '" id="walkin">Start an unbooked hunt<small>Didn\'t book ahead? Start here before you go in. It goes on the calendar right away. Earns fewer points than a hunt booked ahead.</small></button>' +
        (booked.length ? '' : '<p class="status center" style="margin:0 0 6px">Booked, but it isn\'t showing? <button class="plain" id="on-any" style="padding:0">Check in anyway</button></p>');
      box.querySelectorAll('[data-on]').forEach(b => b.onclick = () => showCheckin(b.dataset.on));
      document.getElementById('walkin').onclick = () => showUnbooked();
      const any = document.getElementById('on-any');
      if (any) any.onclick = () => showCheckin('');
    }
  }
  // "Needs your attention": the hunter's flagged reports, each with a one-tap fix (or a short explanation).
  let todoCache = [];
  async function loadTodo() {
    if (!me || !navigator.onLine) return;
    try {
      const out = await call({ action: 'todo', hunter: me.hunter, pin: me.pin });
      todoCache = out.items || [];
      if (Array.isArray(out.seasons) && out.seasons.length && me) { me.seasons = out.seasons; save(me); renderSeason(); }
    } catch (e) { return; }
    renderTodo();
  }
  function renderSeason() {
    const box = document.getElementById('season');
    if (box) box.textContent = seasonLine();
  }
  function renderTodo() {
    const box = document.getElementById('todo');
    if (!box) return;
    if (!todoCache.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="card" style="border:2px solid #8A2E1F"><b>Needs your attention (' + todoCache.length + ')</b>' +
      todoCache.map((t, i) => '<div style="padding:8px 0;border-top:1px solid var(--line);margin-top:8px">' + esc(t.check) + ' · ' + esc(t.property) + ' · ' + esc(dayName(t.date)) +
        '<br><button class="plain" data-fix="' + i + '" style="padding:4px 0">Fix it</button></div>').join('') + '</div>';
    box.querySelectorAll('[data-fix]').forEach(b => b.onclick = () => showFix(todoCache[+b.dataset.fix]));
  }
  function showFix(t) {
    const photos = [];
    const field = {
      time: '<label for="fv">The right time of shot</label><input id="fv" type="time">',
      band: '<label for="fv">The right Home Ground band number for this deer</label><input id="fv" type="text">',
      conf: '<label for="fv">The right MassWildlife confirmation number for this deer</label><input id="fv" type="text" inputmode="numeric">',
      photos: photoField('fp', 'Photos of this deer', 'Band visible.'),
      impl: '<label>The implement you used</label>' + radios('fv-impl', IMPLEMENTS),
      harvest: '<button class="big" id="fh">File the missing harvest report<small>' + esc(t.property) + ', ' + esc(dayName(t.date)) + '</small></button>'
    }[t.fix] || '';
    $app.innerHTML = header() + '<h1>' + esc(t.check) + '</h1><p class="status">' + esc(t.property) + ' · ' + esc(dayName(t.date)) + '</p>' +
      '<div class="note warn">' + esc(t.ask) + '</div>' + (t.report ? '<p class="status">' + esc(t.report) + '</p>' : '') + field +
      (field ? '<p class="status" style="margin-top:14px">Or, if it\'s right as it is:</p>' : '') +
      '<label for="fx">Tell us what happened</label><textarea id="fx"></textarea>' +
      '<div id="err" class="err"></div><button class="submit" id="send">Send</button><p class="center"><button class="plain" id="back">Back</button></p>';
    document.getElementById('back').onclick = () => showHome();
    if (t.fix === 'photos') wirePhoto('fp', 'harvest', photos);
    const fh = document.getElementById('fh');
    if (fh) fh.onclick = () => showHarvest({ property: t.property, date: t.date });
    document.getElementById('send').onclick = async () => {
      const val = ((document.getElementById('fv') || {}).value || '').trim(), text = v('fx').trim(), err = document.getElementById('err');
      let kind = 'explain';
      if (t.fix === 'time' && val) kind = 'time';
      else if ((t.fix === 'band' || t.fix === 'conf') && val) kind = t.fix;
      else if (t.fix === 'photos' && photos.length) kind = 'photos';
      else if (t.fix === 'impl' && picked('fv-impl')) kind = 'impl';
      if (kind === 'explain' && !text) { err.textContent = field && t.fix !== 'harvest' ? 'Fix it above, or tell us what happened.' : 'Tell us what happened.'; return; }
      if (kind === 'time' && notYet(t.date, val)) { err.textContent = 'That time hasn\'t happened yet. Check AM / PM.'; return; }
      if (!navigator.onLine) { err.textContent = 'This needs signal. Try again when you have it.'; return; }
      const btn = document.getElementById('send');
      btn.disabled = true; btn.textContent = 'Sending…';
      try {
        const out = await call({ action: 'fix', hunter: me.hunter, pin: me.pin, key: t.key, kind, value: kind === 'impl' ? picked('fv-impl') : val, text, files: kind === 'photos' ? photos : [] });
        todoCache = todoCache.filter(x => x.key !== t.key);
        showHome('Thanks, that\'s sent.' + (out.still ? (out.stillWhat === 'implement' ? ' That implement still isn\'t legal that day, so the office will look at it.' : ' That time is still outside legal shooting hours, so the office will look at it.') : ''));
      } catch (e) { btn.disabled = false; btn.textContent = 'Send'; err.textContent = e.message || 'Couldn\'t send. Try again.'; }
    };
  }
  // Start an unbooked hunt: books the property for today right now (the server refuses it during a landowner pause,
  // when the property is full, or where the landowner asks for notice the day before), then checks in On stand.
  function showUnbooked() {
    const h = new Date().getHours();
    $app.innerHTML = header() + '<h1>Start an unbooked hunt</h1>' +
      '<p class="status">For a hunt you didn\'t book ahead. It goes on the calendar now, so the landowner and other hunters can see it, and then checks you in On stand. A hunt booked ahead earns more points.</p>' +
      propertySelect() +
      '<label>Which part of today?</label>' +
      (h < 12 ? '<label class="choice"><input type="radio" name="part" value="AM"' + (h < 10 ? ' checked' : '') + '> Morning (until noon)</label>' : '') +
      '<label class="choice"><input type="radio" name="part" value="PM"' + (h >= 10 && h < 12 ? '' : h >= 12 ? ' checked' : '') + '> Afternoon</label>' +
      (h < 12 ? '<label class="choice"><input type="radio" name="part" value="All day"' + (h >= 10 ? ' checked' : '') + '> Rest of the day</label>' : '') +
      '<div id="err" class="err"></div><button class="submit" id="send">Start hunt</button>' +
      '<p class="center"><button class="plain" id="back">Back</button></p>';
    document.getElementById('back').onclick = () => showHome();
    document.getElementById('send').onclick = async () => {
      const p = v('prop'), part = picked('part'), err = document.getElementById('err'), btn = document.getElementById('send');
      if (!p) { err.textContent = 'Choose a property.'; return; }
      if (!part) { err.textContent = 'Choose morning, afternoon or the rest of the day.'; return; }
      if (!navigator.onLine) { err.textContent = 'Starting an unbooked hunt needs signal. No signal? Call ' + CFG.OFFICE_PHONE + ' before you go in.'; return; }
      btn.disabled = true; btn.textContent = 'Checking ' + p + '…';
      try {
        await call({ action: 'walkin', hunter: me.hunter, pin: me.pin, property: p, slot: part, submittedOn: stamp(), clientId: uid() });
        try { await loadBookings(); } catch (e) { /* the check-in still works */ }
        showCheckin(p);
      } catch (e) {
        btn.disabled = false; btn.textContent = 'Start hunt';
        err.textContent = e.message || 'Couldn\'t start the hunt. Try again, or call ' + CFG.OFFICE_PHONE + '.';
      }
    };
  }
  function showCheckin(prop) {
    $app.innerHTML = header() + '<h1>On stand</h1>' +
      (prop ? '<p><b>' + esc(prop) + '</b></p>' : '<div class="note warn">Hunting needs a confirmed booking. If you have one, it may not have reached this phone yet: carry on and the office will check.</div>' + propertySelect()) +
      '<div id="ci"></div><div id="err" class="err"></div><button class="submit" id="send">' + (prop ? 'Getting your location…' : 'Check in') + '</button>' +
      '<p class="center"><button class="plain" id="back">Back</button></p>';
    document.getElementById('back').onclick = () => showHome();
    const btn = document.getElementById('send'), box = document.getElementById('ci');
    const commit = (p, g, text, ok, reason) => {
      const now = new Date(), o = { property: p, date: isoDate(now), onTime: nowTime(), text, ok, left: false };
      queue('On stand ' + p, { form: 'onstand', submittedOn: stamp(), gps: g,
        fields: { property: p, event: 'onstand', date: o.date, time: o.onTime, noLocationReason: reason || '' } });
      me.outing = o; save(me);
      showHome('On stand on ' + esc(p) + ' at ' + esc(clock(o.onTime)) + '. Good hunting. Tap Leaving before you head out.');
    };
    async function attempt() {
      const p = prop || v('prop');
      if (!p) { document.getElementById('err').textContent = 'Choose a property.'; return; }
      btn.disabled = true; btn.textContent = 'Getting your location…'; box.innerHTML = '';
      const g = await gps(true);
      btn.disabled = false;
      if (!g) {
        box.innerHTML = '<div class="note bad">Couldn\'t get a location. Check that Location is on for this app (or your browser) and try again.</div>' +
          '<label for="why">Or check in without it: tell us why</label><input id="why" type="text"><button class="plain" id="nofix">Check in without location</button>';
        btn.textContent = 'Try again';
        document.getElementById('nofix').onclick = () => {
          const why = v('why').trim();
          if (!why) { document.getElementById('err').textContent = 'Say why there\'s no location.'; return; }
          commit(p, null, 'No location: ' + why, false, why);
        };
        return;
      }
      const r = whereText(p, g);
      if (r.ok) return commit(p, g, r.text, true);
      box.innerHTML = '<div class="note warn">' + esc(r.text) + (r.w.status === 'outside' ? ' Stay inside the property line. If you\'re on the property, step into the open and try again.' : ' Step into the open and try again.') + '</div>' +
        '<button class="plain" id="anyway">Check in anyway (the office will look at it)</button>';
      btn.textContent = 'Try again';
      document.getElementById('anyway').onclick = () => commit(p, g, r.text, false);
    }
    btn.onclick = attempt;
    if (prop) attempt();
  }
  async function leave(old) {
    const o = me.outing;
    if (old) { o.left = true; o.leftTime = ''; save(me); return showLeaving(); }
    $app.innerHTML = header() + '<h1>Leaving</h1><p class="status">Getting your location…</p>';
    const g = await gps(true);
    o.left = true; o.leftTime = nowTime(); o.leftGps = g; save(me);
    queue('Leaving ' + o.property, { form: 'onstand', submittedOn: stamp(), gps: g,
      fields: { property: o.property, event: 'leaving', date: o.date, time: o.leftTime } });
    showLeaving();
  }
  function showLeaving() {
    const o = me.outing;
    if (!o) return showHome();
    const outcomes = ['Took a deer', 'Hit a deer but couldn\'t recover it', 'Saw deer, but no shot', 'Saw no deer'];
    $app.innerHTML = header() + '<h1>Hunt report</h1>' +
      '<p><b>' + esc(o.property) + '</b> · ' + esc(dayName(o.date)) + '</p>' +
      '<div class="row"><div><label for="tin">On stand</label><input id="tin" type="time" value="' + esc(o.onTime) + '"></div>' +
      '<div><label for="tout">Left</label><input id="tout" type="time" value="' + esc(o.leftTime || '') + '"></div></div>' +
      '<label>Outcome</label>' + radios('outcome', outcomes) +
      '<div id="took" hidden><label for="harv">How many did you harvest?</label><input id="harv" type="number" min="1" value="1">' +
      '<div class="note warn">Report Your Harvest opens next, for each deer.</div></div>' +
      '<h2>Deer seen <span class="hint">Enter 0 if none.</span></h2>' +
      '<div class="row4">' + [['does', 'Adult does'], ['bucks', 'Adult bucks'], ['fawns', 'Fawns / young of the year'], ['unsure', 'Couldn\'t tell']]
        .map(([id, l]) => '<div><label for="' + id + '">' + l + '</label><input id="' + id + '" type="number" min="0" inputmode="numeric" value="0"></div>').join('') + '</div>' +
      '<label for="notes">Anything we should know? <span class="hint">Optional</span></label><textarea id="notes"></textarea>' +
      '<label class="choice"><input id="agree" type="checkbox"> This report is accurate to the best of my knowledge.</label>' +
      foot('Send report');
    back();
    document.getElementById('back').onclick = () => showHome();
    document.querySelectorAll('input[name=outcome]').forEach(r => r.onchange = () => { document.getElementById('took').hidden = picked('outcome') !== 'Took a deer'; });
    document.getElementById('send').onclick = async () => {
      const outcome = picked('outcome'), e = [];
      if (!v('tin')) e.push('Enter when you got on stand.');
      if (!v('tout')) e.push('Enter when you left.');
      timeErrs(o.date, v('tin'), v('tout')).forEach(x => e.push(x));
      if (!outcome) e.push('Choose an outcome.');
      if (!document.getElementById('agree').checked) e.push('Tick the accuracy box.');
      if (fail(e)) return;
      document.getElementById('send').disabled = true;
      await queue('Hunt report for ' + usDate(o.date), {
        form: 'hunt', submittedOn: stamp(), gps: o.leftGps || null,
        fields: {
          property: o.property, date: usDate(o.date), timeIn: v('tin'), timeOut: v('tout'), outcome,
          harvested: outcome === 'Took a deer' ? v('harv') : '',
          does: v('does'), bucks: v('bucks'), fawns: v('fawns'), unsure: v('unsure'), notes: v('notes').trim(),
          onStand: o.onTime, leftAt: o.leftTime || 'Didn\'t tap Leaving'
        }
      });
      me.outing = null; save(me);
      if (outcome === 'Took a deer') showHarvest({ property: o.property, date: o.date, n: 1, of: Math.max(1, Math.min(10, Number(v('harv')) || 1)) });
      else showHome('Hunt report saved for ' + esc(o.property) + '. Thank you.' + (navigator.onLine ? '' : ' It will send as soon as you have signal.'));
    };
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
    const h = d.getHours(), m = d.getMinutes();
    return ((h % 12) || 12) + (m ? ':' + pad(m) : '') + (h < 12 ? ' am' : ' pm') + ' ' + d.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
  }
  function renderBookings(fresh) {
    const box = document.getElementById('bookings');
    if (!box) return;
    if (!bookingsCache) { try { const x = JSON.parse(localStorage.getItem(BOOKINGS_KEY) || 'null'); if (x && me && x.hunter === me.hunter) bookingsCache = x.list; } catch (e) { /* ignore */ } }
    renderOuting();
    if (!bookingsCache) { box.innerHTML = '<span class="status">Your bookings will show here when you have signal.</span>'; return; }
    if (!bookingsCache.length) { box.innerHTML = '<span class="status">No upcoming bookings.' + (fresh ? '' : ' (Last checked when you had signal.)') + '</span>'; return; }
    box.innerHTML = bookingsCache.map((b, i) => '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 0' + (i ? ';border-top:1px solid var(--line)' : '') + '">' +
      '<span><b>' + esc(dayName(b.date)) + '</b> · ' + esc(slotName(b.slot)) + '<br><span class="status">' + esc(b.property) + (b.stand ? ' · Stand ' + esc(b.stand) : '') + '</span></span>' +
      (b.canCancel ? '<button class="plain" data-cancel="' + i + '" style="color:var(--bad)">Cancel</button>' : '<span class="status">Started</span>') + '</div>' +
      (b.canCancel && b.freeUntil ? '<div class="status" style="margin:-4px 0 6px">' + (Date.now() < b.freeUntil ? 'Free to cancel until ' + freeText(b) : 'Cancelling now costs 1 point') + '</div>' : '')).join('') +
      '<p class="status" style="margin:8px 0 0">Can\'t make it? Cancel for free by 5 pm the day before a morning or all-day hunt, or by 9 am for an afternoon hunt (a booking made after that can be cancelled free for an hour), so the landowner knows and the time opens up for another hunter. Cancelling later (until the hunt starts) costs 1 point; a booking you don\'t cancel or report costs 3. You\'ll get a reminder 2 hours before free cancelling ends. To change a booking, cancel it and book again.</p>';
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

  // Booking window (Joe, 22 Oct; bookings are automatic): at least an hour before the hunt starts, so by 11 pm the night
  // before a morning or all-day hunt and by 11 am for an afternoon one. A property whose landowner asked for notice before
  // a hunter enters (book5pm, sent at sign-in) still closes at 5 pm the day before. The server checks the same rule.
  function bookCutoff(prop, iso, slot) {
    const [y, m, d] = iso.split('-').map(Number);
    const p = (me.properties || []).find(x => x.code === prop);
    if (p && p.book5pm) return new Date(y, m - 1, d - 1, 17).getTime();
    return new Date(y, m - 1, d, slot === 'PM' ? 11 : -1).getTime();
  }
  const cutoffWords = prop => {
    const p = (me.properties || []).find(x => x.code === prop);
    return p && p.book5pm ? prop + '\'s landowner asks for notice before a hunter enters, so it closes at 5 pm the day before.'
      : 'Bookings close an hour before the hunt starts: 11 pm the night before a morning or all-day hunt, 11 am for an afternoon one.';
  };
  function earliestBookable() {
    const d = new Date(); if (d.getHours() >= 11) d.setDate(d.getDate() + 1); return isoDate(d);
  }

  function showBook() {
    const min = earliestBookable();
    $app.innerHTML = header() + '<h1>Book a Hunt</h1>' +
      '<div class="note warn">Book at least an hour before the hunt starts: by 11 pm the night before a morning or all-day hunt, by 11 am for an afternoon one. A few landowners ask for notice before a hunter enters; those properties close at 5 pm the day before, and the calendar shows it. Bookings are confirmed automatically: you\'ll get a notification (or an email) within a minute or two of it going through. No confirmation, no hunt.</div>' +
      propertySelect() +
      '<div id="cal"></div>' +
      '<label for="day">Date of hunt</label><input id="day" type="date" min="' + isoDate(new Date()) + '" value="' + min + '">' +
      '<label for="time">Time of hunt</label><select id="time"><option value="">Choose…</option>' +
      '<option>AM</option><option>PM</option><option>All day</option></select>' +
      '<label for="stand">Stand ID <span class="hint">Optional. The stand or spot you plan to use.</span></label><input id="stand" type="text">' +
      '<label class="choice"><input id="agree" type="checkbox"> I understand I\'m not booked until I get Home Ground\'s confirmation. To cancel, I\'ll use Your bookings on the app\'s home screen: free by 5 pm the day before (9 am for an afternoon hunt), or within an hour of booking; later than that costs 1 point.</label>' +
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
      if (!f('time').value) err.push('Choose a time.');
      else if (prop && f('day').value && Date.now() > bookCutoff(prop, f('day').value, f('time').value === 'PM' ? 'PM' : 'AM')) {
        err.push('Too late to book that. ' + cutoffWords(prop) + ' Pick a later time.');
      }
      else if (prop && f('day').value) {
        const why = seasonBookProblem(f('day').value) || slotProblem(prop, f('day').value, f('time').value);
        if (why) err.push(why);
      }
      if (!f('agree').checked) err.push('Tick the box to confirm you understand.');
      if (err.length) { f('err').innerHTML = err.map(esc).join('<br>'); return; }
      await queue('Booking for ' + usDate(f('day').value), {
        form: 'booking', submittedOn: stamp(),
        fields: { property: prop, date: usDate(f('day').value), time: f('time').value, stand: f('stand').value.trim() }
      });
      showHome('Booking saved for ' + esc(prop) + ' on ' + esc(usDate(f('day').value)) +
        '. You\'ll get a confirmation notification once it goes through, and it will show under Your bookings.' + (navigator.onLine ? '' : ' It will send as soon as you have signal.'));
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
  function slotState(c, iso, slot, prop) {
    const d = new Date(iso + 'T12:00:00');
    if (prop && Date.now() > bookCutoff(prop, iso, slot)) return { kind: 'blocked', label: 'Closed' };
    const sp = seasonBookProblem(iso);
    if (sp) return { kind: 'blocked', label: /Sunday/.test(sp) ? 'Sunday' : /Youth/.test(sp) ? 'Youth only' : 'No season', note: sp };
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
    const start = new Date(isoDate(new Date()) + 'T12:00:00');
    let rows = '';
    for (let i = 0; i < 14; i++) {
      const d = new Date(start); d.setDate(d.getDate() + i);
      const iso = isoDate(d);
      const cell = sl => { const st = slotState(c, iso, sl, prop); const tap = st.kind === 'open';
        return '<button type="button" ' + (tap ? 'data-pick="' + iso + '|' + sl + '"' : 'disabled') + ' style="flex:1;border:0;border-radius:8px;padding:8px 6px;font-size:13px;text-align:left;' + style[st.kind] + '"><b>' + sl + '</b> ' + esc(st.label) + '</button>'; };
      rows += '<div style="display:flex;gap:6px;align-items:center;margin:4px 0"><div style="width:72px;font-size:14px;font-weight:600">' + DOW[d.getDay()] + ' ' + (d.getMonth() + 1) + '/' + d.getDate() + '</div>' + cell('AM') + cell('PM') + '</div>';
    }
    box.innerHTML = '<div class="card"><b>' + esc(prop) + ' · next two weeks</b><div class="status">Up to ' + c.max + ' hunter' + (c.max > 1 ? 's' : '') +
      ' at a time. Tap an open slot to pick it. Paused = the landowner has asked for no hunting. Closed = too late to book. Sundays, days with no deer season open, and Youth Deer Hunt days (youth hunters only) can\'t be booked. ' + cutoffWords(prop) +
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
    $app.innerHTML = header() + '<h1>Report Your Hunt</h1>' +
      '<p class="status">One report per outing, within 48 hours, including days you see nothing. Honest reports never cost you.</p>' +
      '<div class="note warn">Easier next time: tap <b>On stand</b> on the home screen when you settle in and <b>Leaving</b> when you head out. The report fills itself in, and a report without On stand gets a second look from the office.</div>' +
      propertySelect() +
      '<label for="day">Date</label><input id="day" type="date" value="' + isoDate(new Date()) + '" max="' + isoDate(new Date()) + '">' +
      '<div class="row"><div><label for="tin">Time in</label><input id="tin" type="time"></div>' +
      '<div><label for="tout">Time out</label><input id="tout" type="time" value="' + nowTime() + '"></div></div>' +
      '<label>Outcome</label>' + outcomes.map((o, i) => '<label class="choice"><input type="radio" name="outcome" value="' + esc(o) + '"> ' + esc(o) + '</label>').join('') +
      '<div id="took" hidden><label for="harv">How many did you harvest?</label><input id="harv" type="number" min="1" value="1">' +
      '<div class="note warn">Report Your Harvest opens next, for each deer.</div></div>' +
      '<h2>Deer seen <span class="hint">Every outing. Enter 0 if none.</span></h2>' +
      '<div class="row4">' + [['does', 'Adult does'], ['bucks', 'Adult bucks'], ['fawns', 'Fawns / young of the year'], ['unsure', 'Couldn\'t tell']]
        .map(([id, l]) => '<div><label for="' + id + '">' + l + '</label><input id="' + id + '" type="number" min="0" inputmode="numeric" value="0"></div>').join('') + '</div>' +
      '<label for="notes">Anything we should know? <span class="hint">Optional</span></label><textarea id="notes"></textarea>' +
      '<p class="status">The app records your phone\'s location when you send this report.</p>' +
      '<label class="choice"><input id="agree" type="checkbox"> This report is accurate to the best of my knowledge.</label>' +
      '<div id="err" class="err"></div><button class="submit" id="send">Send report</button>' +
      '<p class="center"><button class="plain" id="back">Back</button></p>';
    const f = id => document.getElementById(id);
    f('back').onclick = () => showHome();
    document.querySelectorAll('input[name=outcome]').forEach(r => r.onchange = () => { f('took').hidden = r.value !== 'Took a deer' || !r.checked; });
    f('send').onclick = async () => {
      const prop = f('prop') ? f('prop').value : '';
      const outcome = (document.querySelector('input[name=outcome]:checked') || {}).value || '';
      const err = [];
      if (!prop) err.push('Choose a property.');
      if (!f('day').value) err.push('Enter the date.');
      if (!f('tin').value) err.push('Enter your time in.');
      if (!f('tout').value) err.push('Enter your time out.');
      timeErrs(f('day').value, f('tin').value, f('tout').value).forEach(x => err.push(x));
      if (!outcome) err.push('Choose an outcome.');
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
          notes: f('notes').value.trim()
        }
      });
      if (outcome === 'Took a deer') showHarvest({ property: prop, date: f('day').value, n: 1, of: Math.max(1, Math.min(10, Number(f('harv').value) || 1)) });
      else showHome('Hunt report saved for ' + esc(prop) + '.' + (navigator.onLine ? '' : ' It will send as soon as you have signal.'));
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
        try {
          const meta = kind === 'harvest' ? await readExif(file) : null;
          const x = await shrink(file);
          store.push(Object.assign({ kind }, x, meta ? { taken: meta.takenMs || '', plat: meta.lat || '', plng: meta.lng || '' } : {}));
          th.innerHTML += '<img src="data:image/jpeg;base64,' + x.data + '" alt="">' + photoNote(meta, v('prop'), v('day'));
        }
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

  function showHarvest(pre) {
    pre = pre || {};
    const photo1 = [], photo2 = [];
    const donateRules = ['I recovered and field dressed the deer within 4 hours of the shot (or it stayed below 37 degrees).',
      'I\'ll drop it off whole and field dressed at the facility within 24 hours of the shot.',
      'It\'s reported to MassWildlife and tagged with my confirmation number.'];
    const multi = pre.of > 1 ? ' (deer ' + pre.n + ' of ' + pre.of + ')' : '';
    $app.innerHTML = header() + '<h1>Report Your Harvest' + multi + '</h1>' +
      '<p class="status">' + (pre.of > 1 ? 'Your hunt report says ' + pre.of + ' deer. Each one gets its own report, band, confirmation number and photos.' : 'One report for each deer, with its own band, confirmation number and photos.') + '</p>' + propertySelect() +
      '<div class="row"><div><label for="day">Date</label><input id="day" type="date" value="' + esc(pre.date || isoDate(new Date())) + '" max="' + isoDate(new Date()) + '"></div>' +
      '<div><label for="shot-time">Time of shot</label><input id="shot-time" type="time"></div></div>' +
      '<div id="legal" hidden><div class="note warn" id="legal-text"></div><label for="timewhy">If the time is right, say what happened</label><textarea id="timewhy"></textarea></div>' +
      '<label>Hunting implement</label>' + radios('impl', IMPLEMENTS) +
      '<div id="season-warn" hidden><div class="note warn" id="season-text"></div><label for="seasonwhy">If it\'s right, say what happened</label><textarea id="seasonwhy"></textarea></div>' +
      '<label>The deer</label>' + radios('deer', ['Antlered buck', 'Adult antlerless (doe)', 'Subadult antlerless (button buck or doe fawn)']) +
      '<label for="which">Deer from this outing</label><select id="which"><option>1st</option><option>2nd</option><option>3rd</option><option>4th or more</option></select>' +
      '<label for="conf">MassWildlife confirmation number</label><input id="conf" type="text" inputmode="numeric">' +
      '<label for="band">Home Ground band number</label><input id="band" type="text">' +
      '<label>Recovered after dark?</label>' + radios('dark', ['No', 'Yes']) +
      '<div id="dark-yes" hidden>' + checks('darkforms', ['I filed Before the Track.', 'I filed After the Track.']) + '</div>' +
      photoField('p1', 'Photo 1: the deer where it fell', 'Band visible.') +
      photoField('p2', 'Photo 2: band close-up', 'Optional.') +
      locField('Where the deer fell', 'Stand at the deer (or where it fell) and tap the button.') +
      '<label>Donate through Hunters Share the Harvest?</label>' + radios('donate', ['Yes, the whole deer', 'No']) +
      '<div id="donate-yes" hidden>' + checks('rules', donateRules) + '</div>' +
      '<label for="notes">Anything else? <span class="hint">Optional</span></label><textarea id="notes"></textarea>' +
      '<label class="choice"><input id="agree" type="checkbox"> This report is accurate to the best of my knowledge.</label>' + foot('Send harvest report');
    back();
    wirePhoto('p1', 'harvest', photo1); wirePhoto('p2', 'harvest', photo2);
    if (pre.property && document.getElementById('prop')) document.getElementById('prop').value = pre.property;
    if (pre.n) document.getElementById('which').selectedIndex = Math.min(pre.n, 4) - 1;
    const loc = wireLoc('If the deer crossed the line, say so in Anything else.');
    const outsideLegal = () => {
      const m = minsOf(v('shot-time')), day = v('day');
      if (m === null || !day) return '';
      const w = legalWindow(day);
      const g = legalGrace(day);
      return m < g.from || m > g.to ? 'Legal shooting hours that day were ' + clockOf(w.from) + ' to ' + clockOf(w.to) + '. Check the time of shot (and AM / PM).' : '';
    };
    const legalCheck = () => { const msg = outsideLegal(); document.getElementById('legal').hidden = !msg; document.getElementById('legal-text').textContent = msg; };
    document.getElementById('shot-time').addEventListener('change', legalCheck);
    document.getElementById('day').addEventListener('change', legalCheck);
    const outOfSeason = () => seasonWarn(v('day'), picked('impl'));
    const seasonCheck = () => { const msg = outOfSeason(); document.getElementById('season-warn').hidden = !msg; document.getElementById('season-text').textContent = msg; };
    document.getElementById('day').addEventListener('change', seasonCheck);
    document.querySelectorAll('input[name=impl]').forEach(r => r.addEventListener('change', seasonCheck));
    seasonCheck();
    document.querySelectorAll('input[name=dark]').forEach(r => r.onchange = () => { document.getElementById('dark-yes').hidden = picked('dark') !== 'Yes'; });
    document.querySelectorAll('input[name=donate]').forEach(r => r.onchange = () => { document.getElementById('donate-yes').hidden = picked('donate') !== 'Yes, the whole deer'; });
    document.getElementById('send').onclick = async () => {
      const e = [];
      if (!v('prop')) e.push('Choose a property.');
      if (!v('shot-time')) e.push('Enter the time of the shot.');
      else if (notYet(v('day'), v('shot-time'))) e.push('The time of shot hasn\'t happened yet. Check the time (and AM / PM).');
      else if (outsideLegal() && !v('timewhy').trim()) { legalCheck(); e.push('The time of shot is outside legal shooting hours. Fix the time, or say what happened.'); }
      if (!picked('impl')) e.push('Choose the hunting implement.');
      else if (outOfSeason() && !v('seasonwhy').trim()) { seasonCheck(); e.push('Check the date and implement: ' + outOfSeason() + ' Or, if it\'s right, say what happened.'); }
      if (!picked('deer')) e.push('Choose which kind of deer.');
      if (!v('conf').trim()) e.push('Enter the MassWildlife confirmation number.');
      if (!v('band').trim()) e.push('Enter the Home Ground band number.');
      if (!picked('dark')) e.push('Say whether it was recovered after dark.');
      if (picked('dark') === 'Yes' && !allTicked('darkforms')) e.push('After dark: file Before the Track and After the Track, then tick both.');
      if (!photo1.length) e.push('Add photo 1, the deer where it fell.');
      if (!loc.g && !v('why').trim()) e.push('Tap "Use my location" at the deer, or say why you couldn\'t.');
      if (!picked('donate')) e.push('Say whether you\'re donating it.');
      if (picked('donate') === 'Yes, the whole deer' && !allTicked('rules')) e.push('To donate, all three Share the Harvest boxes must be true.');
      if (!document.getElementById('agree').checked) e.push('Tick the accuracy box.');
      if (fail(e)) return;
      document.getElementById('send').disabled = true;
      await queue('Harvest report ' + v('band'), { form: 'harvest', submittedOn: stamp(), gps: loc.g,
        fields: { property: v('prop'), date: usDate(v('day')), shotTime: v('shot-time'), implement: picked('impl'), deerType: picked('deer'),
          which: v('which'), confirmation: v('conf').trim(), band: v('band').trim(), afterDark: picked('dark'),
          afterDarkForms: allPicked('darkforms').join(' '), donate: picked('donate'),
          donateChecks: picked('donate') === 'No' ? '' : allPicked('rules').length + ' of 3 confirmed',
          notes: v('notes').trim(), noLocationReason: loc.g ? '' : v('why').trim(), timeNote: outsideLegal() ? v('timewhy').trim() : '', seasonNote: outOfSeason() ? v('seasonwhy').trim() : '' },
        files: photo1.concat(photo2) });
      const saved = 'Harvest report saved for band ' + esc(v('band')) + '.' + (navigator.onLine ? '' : ' It will send as soon as you have signal.');
      if (pre.of && pre.n < pre.of) {
        showHarvest({ property: v('prop'), date: v('day'), n: pre.n + 1, of: pre.of });
        const top = document.querySelector('h1');
        if (top) top.insertAdjacentHTML('beforebegin', '<div class="note ok">' + saved + ' Now deer ' + (pre.n + 1) + ' of ' + pre.of + '.</div>');
      } else showHome(saved);
    };
  }

  function showBefore() {
    const rules = ['I\'m not carrying a weapon. My firearm or bow is unloaded and left behind.',
      'If this landowner asked for a text or call before anyone enters after dark, I\'ve done it.',
      'I\'ll stay on enrolled land unless I have the neighbor\'s permission or the Environmental Police\'s direction.'];
    $app.innerHTML = header() + '<h1>Before the Track</h1>' +
      '<div class="note warn">This alerts Home Ground right away. If you have no signal, call ' + esc(CFG.OFFICE_PHONE) + ' before you go in. Then keep the app open: it records your route and warns you if you leave enrolled land.</div>' + propertySelect() +
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
        me.track = { property: v('prop'), started: Date.now(), path: [] }; save(me);
        showTracking('Home Ground has been alerted. Track safely, no weapon. Keep this screen open while you track.');
      } catch (err) {
        btn.disabled = false; btn.textContent = 'Try again';
        fail([err.fatal ? err.message : 'Couldn\'t send. Call ' + CFG.OFFICE_PHONE + ' before you go in.']);
      }
    };
  }

  function showAfter() {
    const prop = me.track ? me.track.property : '';
    $app.innerHTML = header() + '<h1>After the Track</h1>' + propertySelect() +
      '<label for="fin">Time you finished</label><input id="fin" type="time" value="' + nowTime() + '">' +
      '<label>Outcome</label>' + radios('out', ['Recovered the deer', 'Didn\'t recover it, stopped tracking']) +
      '<label>Did the deer cross onto land outside the program?</label>' +
      radios('crossed', ['No', 'Yes, with the owner\'s permission', 'Yes, with the Environmental Police\'s direction', 'Yes, and I stopped at the line']) +
      '<p class="status">Your route and where you are now go with this.</p>' +
      '<label for="notes">Notes <span class="hint">Optional</span></label><textarea id="notes"></textarea>' +
      '<div class="note warn">Recovered it? Also file Report Your Harvest.</div>' + foot('Send: I\'m finished');
    if (prop && document.getElementById('prop')) document.getElementById('prop').value = prop;
    back();
    document.getElementById('send').onclick = async () => {
      const e = [];
      if (!v('prop')) e.push('Choose a property.');
      if (!picked('out')) e.push('Choose the outcome.');
      if (!picked('crossed')) e.push('Say whether the deer crossed outside the program.');
      if (fail(e)) return;
      document.getElementById('send').disabled = true;
      // While tracking, the route already has a fresh fix; otherwise ask for one.
      const t = me.track, fresh = t && t.lastFix && Date.now() - (t.lastFixAt || 0) < 60000;
      const where = fresh ? Object.assign({ at: stamp() }, t.lastFix) : await gps(true);
      const recovered = picked('out') === 'Recovered the deer';
      const path = (me.track && me.track.path) || [];
      if (where && path.length < 2000) path.push([where.lat, where.lng, where.acc, Date.now()]);
      const mins = me.track ? Math.round((Date.now() - me.track.started) / 60000) : 0;
      await queue('After the Track', { form: 'after', submittedOn: stamp(), gps: where, path,
        fields: { property: v('prop'), finished: v('fin'), outcome: picked('out'), crossed: picked('crossed'),
          route: path.length > 1 ? path.length + ' points over ' + mins + ' min' : 'Not recorded (app closed while tracking)',
          notes: v('notes').trim(), noLocationReason: where ? '' : 'Phone couldn\'t get a location' } });
      stopTrackWatch(); document.body.classList.remove('night');
      me.track = null; save(me);
      if (recovered) showHarvest({ property: v('prop') }); else showHome('Tracking finished. Thank you.' + (navigator.onLine ? '' : ' It will send as soon as you have signal.'));
    };
  }

  /* ---------- Tracking after dark: route recording and "outside enrolled land" warnings ----------
   * From Before the Track until After the Track, while the app is open, the phone keeps a point about every
   * 30 seconds (or every 50 ft walked). Each point is checked against your own properties' lines right
   * here on the phone. If you're past them, the app asks Home Ground "is this spot on enrolled land?" and
   * only gets yes or no back (it never learns whose land it is). Off enrolled land, or past your line with
   * no signal to check, the phone beeps, vibrates and shows a notification. The route is sent with After the
   * Track, so the office has the record the onX track used to give. */
  let trackWatch = null, trackWake = null, lastAsk = 0, lastAlert = 0, trackState = { status: 'starting' };
  const TRACK_EVERY_MS = 30000, TRACK_MOVE_FT = 50, ASK_EVERY_MS = 60000, ALERT_EVERY_MS = 120000;
  function startTrackWatch() {
    if (!me || !me.track || trackWatch != null || !navigator.geolocation) return;
    me.track.path = me.track.path || [];
    trackWatch = navigator.geolocation.watchPosition(onTrackFix, () => { trackState = { status: 'nogps' }; drawTracking(); },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  }
  function stopTrackWatch() {
    if (trackWatch != null) navigator.geolocation.clearWatch(trackWatch);
    trackWatch = null;
    if (trackWake) trackWake.release().catch(() => {});
    trackWake = null;
  }
  async function onTrackFix(p) {
    if (!me || !me.track) return stopTrackWatch();
    const g = { lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), acc: Math.round(p.coords.accuracy) };
    const path = me.track.path, last = path[path.length - 1], now = Date.now();
    const moved = last ? distBearing({ lat: last[0], lng: last[1] }, g).ft : Infinity;
    if (!last || now - last[3] >= TRACK_EVERY_MS || moved >= TRACK_MOVE_FT) {
      if (path.length < 2000) path.push([g.lat, g.lng, g.acc, now]);
      save(me);
    }
    me.track.lastFix = g; me.track.lastFixAt = now;
    await checkTrackSpot(g);
    drawTracking();
  }
  // Own properties first (on the phone); past those, ask the server (yes / no only), at most once a minute.
  async function checkTrackSpot(g) {
    const mine = (me.properties || []).filter(p => p.bounds);
    const checks = mine.map(p => ({ code: p.code, w: whereOn(p.code, g) }));
    const on = checks.find(c => c.w.status === 'inside' || c.w.status === 'edge');
    if (on) { trackState = { status: 'on', code: on.code, accFt: on.w.accFt }; return; }
    const nearest = checks.sort((a, b) => a.w.edgeFt - b.w.edgeFt)[0];
    const past = nearest ? { code: nearest.code, ft: nearest.w.edgeFt } : null;
    if (!navigator.onLine) { trackState = { status: 'past-offline', past }; return trackAlert(); }
    if (Date.now() - lastAsk < ASK_EVERY_MS && trackState.status !== 'starting' && trackState.status !== 'on') {
      if (trackState.status === 'off') trackAlert();
      return;
    }
    lastAsk = Date.now();
    try {
      const out = await call({ action: 'where', hunter: me.hunter, pin: me.pin, property: me.track.property, gps: g });
      if (out.enrolled === false) { trackState = { status: 'off', past }; trackAlert(); }
      else if (out.enrolled === true) trackState = { status: 'program', past };
      else trackState = { status: 'past-offline', past };
    } catch (e) { trackState = { status: 'past-offline', past }; trackAlert(); }
  }
  function trackAlert() {
    if (Date.now() - lastAlert < (me && me.track && me.track.ack ? 15 * 60000 : ALERT_EVERY_MS)) return;
    lastAlert = Date.now();
    const body = trackState.status === 'off'
      ? 'You\'ve left enrolled land. Stop unless you have the owner\'s permission or the Environmental Police\'s direction.'
      : 'You\'re past your property line and the app can\'t check other enrolled land (no signal). Stop unless you know you have permission.';
    try { navigator.vibrate && navigator.vibrate([400, 200, 400, 200, 400]); } catch (e) {}
    try {
      const A = window.AudioContext || window.webkitAudioContext;
      if (A) { const a = new A(), o = a.createOscillator(), v = a.createGain(); o.frequency.value = 880; v.gain.value = 0.25;
        o.connect(v); v.connect(a.destination); o.start(); o.stop(a.currentTime + 0.6); }
    } catch (e) {}
    try {
      if ('Notification' in window && Notification.permission === 'granted' && navigator.serviceWorker) {
        navigator.serviceWorker.ready.then(r => r.showNotification('Outside your permission area', { body, tag: 'hg-offland', renotify: true, icon: 'icon-192.png' }));
      }
    } catch (e) {}
  }
  function drawTracking() {
    const box = document.getElementById('track-status');
    if (!box || !me || !me.track) return;
    const t = me.track, s = trackState, g = t.lastFix, acc = g ? ' (GPS ±' + Math.round(g.acc * FT) + ' ft)' : '';
    const pastWords = s.past ? 'about ' + howFar(s.past.ft) + ' past ' + esc(s.past.code) + '\'s line' : 'outside your properties';
    const view = {
      starting: ['', 'Finding you…'],
      nogps: ['bad', 'No GPS. Check that Location is on for this app.'],
      on: ['ok', 'On ' + esc(s.code) + acc + '.'],
      program: ['ok', 'Past your property line (' + pastWords + '), but still on enrolled land' + acc + '.'],
      'past-offline': ['bad', '<b>Check where you are.</b> You\'re ' + pastWords + acc + ' and there\'s no signal to check other enrolled land. Stop unless you know you have permission.'],
      off: ['bad', '<b>You\'ve left enrolled land</b> (' + pastWords + ')' + acc + '. Stop unless you have the owner\'s permission or the Environmental Police\'s direction.']
    }[s.status] || ['', ''];
    const mins = Math.max(0, Math.round((Date.now() - t.started) / 60000));
    let walked = 0; for (let i = 1; i < (t.path || []).length; i++) walked += distBearing({ lat: t.path[i - 1][0], lng: t.path[i - 1][1] }, { lat: t.path[i][0], lng: t.path[i][1] }).ft;
    box.innerHTML = '<div class="note ' + view[0] + '" style="font-size:18px">' + view[1] + '</div>' +
      '<p class="status">Tracking ' + mins + ' min · ' + (t.path || []).length + ' points · about ' + howFar(walked) + ' walked</p>';
    drawAck();
  }
  // Off enrolled land: the hunter confirms who gave them permission to be there (logged for the office).
  function drawAck() {
    const box = document.getElementById('track-ack');
    if (!box || !me || !me.track) return;
    const t = me.track;
    if (t.ack) {
      const who = { owner: 'the landowner', authority: 'a ruling authority', police: 'the Environmental Police' }[t.ack.basis];
      const html = '<div class="note ok">Permission confirmed: from ' + esc(who) + ' at ' + esc(clock(t.ack.time)) + '. Warnings now every 15 minutes while you\'re off enrolled land.</div>';
      if (box.dataset.state !== 'acked') { box.innerHTML = html; box.dataset.state = 'acked'; }
      return;
    }
    if (trackState.status !== 'off') { if (box.dataset.state !== 'none') { box.innerHTML = ''; box.dataset.state = 'none'; } return; }
    if (box.dataset.state === 'ask') return;   // don't wipe a half-filled form
    box.dataset.state = 'ask';
    box.innerHTML = '<div class="card" style="border:2px solid #8A2E1F"><b>Have permission to track here?</b>' +
      '<p class="status">You\'re outside Home Ground\'s enrolled land. Go back unless someone with authority has said you can follow the deer here.</p>' +
      '<label class="choice"><input type="radio" name="basis" value="owner"> The landowner gave me permission</label>' +
      '<label class="choice"><input type="radio" name="basis" value="authority"> A ruling authority (town, police) gave me permission</label>' +
      '<label class="choice"><input type="radio" name="basis" value="police"> The Massachusetts Environmental Police gave me permission</label>' +
      '<label class="choice"><input type="checkbox" id="ackok"> I confirm I have this permission to track here. I understand Home Ground isn\'t responsible if I don\'t.</label>' +
      '<div id="ackerr" class="err"></div><button class="submit" id="acksend">Confirm permission</button></div>';
    document.getElementById('acksend').onclick = async () => {
      const basis = picked('basis'), err = document.getElementById('ackerr'), btn = document.getElementById('acksend');
      if (!basis) { err.textContent = 'Choose who gave you permission.'; return; }
      if (!document.getElementById('ackok').checked) { err.textContent = 'Tick the box to confirm.'; return; }
      if (!navigator.onLine) { err.textContent = 'No signal to send this. Go back to enrolled land, or call ' + CFG.OFFICE_PHONE + '.'; return; }
      btn.disabled = true; btn.textContent = 'Sending…';
      try {
        await call({ action: 'trackack', hunter: me.hunter, pin: me.pin, property: t.property, basis, gps: t.lastFix || null, clientId: uid() });
        t.ack = { basis, time: nowTime() }; save(me); drawAck();
      } catch (e) { btn.disabled = false; btn.textContent = 'Confirm permission'; err.textContent = e.message || 'Couldn\'t send. Try again.'; }
    };
  }
  function showTracking(note) {
    if (!me.track) return showHome();
    startTrackWatch();
    if (navigator.wakeLock && !trackWake) navigator.wakeLock.request('screen').then(w => { trackWake = w; }).catch(() => {});
    if (me.night) document.body.classList.add('night');
    $app.innerHTML = header() + (note ? '<div class="note ok">' + note + '</div>' : '') +
      '<h1>Tracking on ' + esc(me.track.property) + '</h1>' +
      '<p class="status">Keep this screen open. It records your route and warns you if you leave enrolled land. No weapon.</p>' +
      '<div id="track-status"><div class="note">Finding you…</div></div><div id="track-ack"></div>' +
      ('Notification' in window && Notification.permission === 'default' ? '<button class="big alt" id="notif">Turn on warnings<small>So the phone can alert you even if the screen dims.</small></button>' : '') +
      '<button class="big" style="background:#8A2E1F" id="done">I\'m finished<small>Found or not. Sends After the Track with your route.</small></button>' +
      '<button class="big alt" id="truck">Back to my truck<small>Compass and distance, if you marked where you parked.</small></button>' +
      '<p class="center"><button class="plain" id="night">' + (me.night ? 'Normal screen' : 'Red night screen') + '</button></p>' +
      '<p class="center"><button class="plain" id="back">Home</button></p>';
    drawTracking();
    if (me.track.lastFix) checkTrackSpot(me.track.lastFix).then(drawTracking);
    const tick = setInterval(() => { if (!document.getElementById('track-status')) return clearInterval(tick); drawTracking(); }, 30000);
    const n = document.getElementById('notif');
    if (n) n.onclick = async () => { try { await Notification.requestPermission(); } catch (e) {} n.remove(); };
    document.getElementById('done').onclick = () => showAfter();
    document.getElementById('truck').onclick = () => showFind('__truck');
    document.getElementById('back').onclick = () => { document.body.classList.remove('night'); showHome(); };
    document.getElementById('night').onclick = () => {
      me.night = !me.night; save(me);
      document.body.classList.toggle('night', me.night);
      document.getElementById('night').textContent = me.night ? 'Normal screen' : 'Red night screen';
    };
  }

  /* ---------- Stands and cameras: your IDs, nearest first, and Find my stand ----------
   * Tags are your hunter number plus a letter (H-112 -> 112-A, 112-B...). The server sends the stands and
   * cameras you have out (yours only) at sign-in; anything you log on this phone shows straight away, even
   * before it sends. Everything here works with no signal once it's on the phone. */
  const DECLINATION = -14.4;   // Martha's Vineyard: magnetic north is about 14.4 degrees west of true north
  const tagNum = () => String((me.hunter || '').match(/\d+/) || '').padStart(3, '0');
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  function myStands() {
    const out = {};
    (me.stands || []).forEach(s => { out[s.id] = Object.assign({}, s); });
    (me.standEdits || []).forEach(e => {
      if (e.op === 'remove') { delete out[e.id]; return; }
      const cur = out[e.id] || { id: e.id, kind: e.kind || 'Stand', prop: e.prop, placed: e.date };
      if (e.kind) cur.kind = e.kind;
      if (e.prop) cur.prop = e.prop;
      if (e.lat) { cur.lat = e.lat; cur.lng = e.lng; cur.accFt = e.accFt; }
      out[e.id] = cur;
    });
    return Object.keys(out).sort().map(k => out[k]);
  }
  // Drops phone-only changes once the server's list shows them (or after two weeks).
  function settleStandEdits() {
    const srv = {}; (me.stands || []).forEach(s => { srv[s.id] = s; });
    me.standEdits = (me.standEdits || []).filter(e => {
      if (Date.now() - e.at > 14 * 864e5) return false;
      const s = srv[e.id];
      if (e.op === 'remove') return !!s;
      return !(s && s.prop === e.prop && (!e.lat || (Math.abs(s.lat - e.lat) < 1e-5 && Math.abs(s.lng - e.lng) < 1e-5)));
    });
  }
  // Distance (feet) and true bearing (degrees) from fix a to point b.
  function distBearing(a, b) {
    const R = 20902231, r = x => x * Math.PI / 180;
    const p1 = r(a.lat), p2 = r(b.lat), dp = r(b.lat - a.lat), dl = r(b.lng - a.lng);
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    const ft = 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
    const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return { ft, deg: (Math.atan2(y, x) * 180 / Math.PI + 360) % 360 };
  }
  const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const compassWord = deg => POINTS[Math.round(deg / 45) % 8];
  const howFar = ft => ft < 90 ? Math.round(ft) + ' ft' : ft < 5280 * 0.6 ? Math.round(ft / 3) + ' yds' : (ft / 5280).toFixed(1) + ' mi';
  const kindWord = s => s.kind === 'Camera' ? 'camera' : 'stand';
  const placedWord = s => s.placed ? ' since ' + new Date(s.placed + 'T12:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';

  // Heading (0-360, clockwise from north) of the way the phone points: the top edge when it's held flat, the back
  // camera when it's held upright, whichever lies flatter. Works from the absolute alpha/beta/gamma angles.
  function tiltHeading(alpha, beta, gamma) {
    if (beta == null || gamma == null) return (360 - alpha) % 360;
    const r = Math.PI / 180, x = beta * r, y = gamma * r, z = alpha * r;
    const cX = Math.cos(x), cY = Math.cos(y), cZ = Math.cos(z), sX = Math.sin(x), sY = Math.sin(y), sZ = Math.sin(z);
    const topE = -sZ * cX, topN = cZ * cX;                                  // top edge of the phone
    const backE = -cZ * sY - sZ * sX * cY, backN = -sZ * sY + cZ * sX * cY;  // back camera
    const top = Math.hypot(topE, topN) >= Math.hypot(backE, backN);
    return (Math.atan2(top ? topE : backE, top ? topN : backN) * 180 / Math.PI + 360) % 360;
  }

  function showStand() {
    const camRules = ['Audio recording is turned off.',
      'It\'s pointed at a deer trail, not at a home, driveway, building or path, unless the landowner approved.',
      'If this landowner asked to approve placement, they\'ve approved it.'];
    const standRules = ['I wear a full-body harness whenever I\'m in my stand (tree saddles qualify).',
      'It\'s placed the way the landowner allows (no screw-in steps or permanent stands unless they\'ve said yes).',
      'I\'m standing at the stand as I log it, and it\'s on the property.',
      'No home or building in use is within 500 feet, unless its owner or occupant has given Home Ground permission (enrolled landowners and signed neighbor permissions count).'];
    $app.innerHTML = header() + '<h1>Stand &amp; Camera Log</h1>' + propertySelect() +
      '<label>What are you doing?</label>' + radios('act', ['Placing', 'Moving', 'Removing']) +
      '<div id="kind-box" hidden><label>What is it?</label>' + radios('kind', ['Stand', 'Camera']) + '</div>' +
      '<div id="id-box" hidden><label for="sid">Which one? <span class="hint" id="sid-hint"></span></label><select id="sid"></select>' +
      '<div id="sid-other" hidden><label for="sid-text">Tag as written on it</label><input id="sid-text" type="text" autocapitalize="characters"></div>' +
      '<div id="near"></div></div>' +
      locField('Where it is', 'Stand at the stand or camera and tap the button. It also sorts the list by distance.') +
      '<label>Who can know about this?</label>' + radios('share', ['Home Ground only', 'Home Ground and program hunters hunting next to me']) +
      '<div id="cam-box" hidden><label>For cameras</label>' + checks('camrules', camRules) + '</div>' +
      '<div id="stand-box" hidden><label>For stands</label>' + checks('standrules', standRules) + '</div>' +
      '<label for="notes">Notes <span class="hint">Optional</span></label><textarea id="notes"></textarea>' + foot('Send log');
    back();
    const loc = wireLoc('Stands and cameras must be on the property. If it is, step into the open and tap Update my location.');
    const num = tagNum();
    const draw = () => {
      const act = picked('act'), kind = picked('kind'), prop = v('prop'), mine = myStands();
      document.getElementById('kind-box').hidden = act !== 'Placing';
      document.getElementById('id-box').hidden = !act;
      const placing = act === 'Placing';
      document.getElementById('cam-box').hidden = !(placing && kind === 'Camera');
      document.getElementById('stand-box').hidden = !(placing && kind === 'Stand');
      if (!act) return;
      const sel = document.getElementById('sid'), was = sel.value;
      const where = s => (s.lat && loc.g ? ' · ' + howFar(distBearing(loc.g, s).ft) + ' ' + compassWord(distBearing(loc.g, s).deg) : '');
      let opts = [];
      if (placing) {
        document.getElementById('sid-hint').textContent = 'Grayed-out tags are already out.';
        opts = LETTERS.map(L => {
          const id = num + '-' + L, s = mine.find(x => x.id === id);
          return s ? { id, off: true, text: id + ' · out: ' + kindWord(s) + ' on ' + s.prop + placedWord(s) }
            : { id, off: false, text: id + ' · free' };
        });
        const first = opts.find(o => !o.off);
        if (first && !was) setTimeout(() => { if (!sel.value || sel.selectedOptions[0].disabled) sel.value = first.id; }, 0);
      } else {
        document.getElementById('sid-hint').textContent = loc.g ? 'Nearest first.' : 'Tap Use my location below to sort by distance.';
        let here = mine.filter(s => s.prop === prop), other = mine.filter(s => s.prop !== prop);
        if (loc.g) here = here.slice().sort((a, b) => (a.lat ? distBearing(loc.g, a).ft : 1e9) - (b.lat ? distBearing(loc.g, b).ft : 1e9));
        opts = [{ id: '', off: false, text: here.length ? 'Choose…' : 'Nothing logged as out on ' + (prop || 'this property') }]
          .concat(here.map(s => ({ id: s.id, off: false, text: s.id + ' · ' + kindWord(s) + placedWord(s) + (s.lat ? where(s) : ' · no location on file') })))
          .concat(other.map(s => ({ id: s.id, off: true, text: s.id + ' · on ' + s.prop })));
      }
      opts.push({ id: '__other', off: false, text: 'Other / old tag…' });
      sel.innerHTML = opts.map(o => '<option value="' + esc(o.id) + '"' + (o.off ? ' disabled' : '') + '>' + esc(o.text) + '</option>').join('');
      if (was && opts.some(o => o.id === was && !o.off)) sel.value = was;
      document.getElementById('sid-other').hidden = sel.value !== '__other';
      const near = document.getElementById('near');
      const located = mine.filter(s => s.lat && s.prop === prop);
      if (!placing && loc.g && located.length) {
        const n = located.map(s => ({ s, d: distBearing(loc.g, s) })).sort((a, b) => a.d.ft - b.d.ft)[0];
        near.innerHTML = '<div class="note ok">Nearest: <b>' + esc(n.s.id) + '</b> (' + kindWord(n.s) + '), ' + howFar(n.d.ft) + ' ' + compassWord(n.d.deg) +
          '. <button class="plain" id="go-find" style="padding:0">Find it with the compass</button></div>';
        document.getElementById('go-find').onclick = () => showFind(n.s.id);
      } else near.innerHTML = '';
    };
    document.querySelectorAll('input[name=act], input[name=kind]').forEach(c => c.onchange = draw);
    document.getElementById('prop') && document.getElementById('prop').addEventListener('change', draw);
    document.getElementById('sid').onchange = () => { document.getElementById('sid-other').hidden = v('sid') !== '__other'; };
    document.getElementById('loc-btn').addEventListener('click', () => { const t = setInterval(() => { const b = document.getElementById('loc-btn'); if (!b || !b.disabled) { clearInterval(t); if (b) draw(); } }, 300); });
    document.getElementById('send').onclick = async () => {
      const e = [], act = picked('act'), placing = act === 'Placing';
      const id = v('sid') === '__other' ? v('sid-text').trim().toUpperCase() : v('sid');
      const known = myStands().find(s => s.id === id);
      const kind = placing ? picked('kind') : (known ? known.kind : (/cam/i.test(v('notes')) ? 'Camera' : 'Stand'));
      if (!v('prop')) e.push('Choose a property.');
      if (!act) e.push('Choose Placing, Moving or Removing.');
      if (placing && !kind) e.push('Choose stand or camera.');
      if (!id) e.push('Choose which stand or camera.');
      if (act !== 'Removing' && !loc.g && !v('why').trim()) e.push('Tap "Use my location" at the stand or camera, or say why you couldn\'t.');
      if (!picked('share')) e.push('Choose who can know about this.');
      if (placing && kind === 'Camera' && !allTicked('camrules')) e.push('All camera boxes must be true.');
      if (placing && kind === 'Stand' && !allTicked('standrules')) e.push('All stand boxes must be true.');
      if (fail(e)) return;
      document.getElementById('send').disabled = true;
      const word = { Placing: 'placement', Moving: 'move', Removing: 'removal' }[act];
      await queue('Stand & Camera Log', { form: 'stand', submittedOn: stamp(), gps: loc.g,
        fields: { property: v('prop'), logging: kind + ' ' + word, ids: id, share: picked('share'),
          checks: placing ? 'Placement rules confirmed' : '', notes: v('notes').trim(),
          noLocationReason: loc.g || act === 'Removing' ? '' : v('why').trim() } });
      me.standEdits = (me.standEdits || []).concat([{ op: { Placing: 'place', Moving: 'move', Removing: 'remove' }[act], id, kind, prop: v('prop'),
        lat: loc.g ? loc.g.lat : null, lng: loc.g ? loc.g.lng : null, accFt: loc.g ? Math.round(loc.g.acc * FT) : null, date: isoDate(new Date()), at: Date.now() }]);
      save(me);
      showHome('Log saved for ' + esc(id) + '.' + (navigator.onLine ? '' : ' It will send as soon as you have signal.'));
    };
  }

  /* ---------- Find my stand: compass arrow and distance ---------- */
  let findStop = null;
  function showFind(target) {
    if (findStop) findStop();
    const list = myStands().filter(s => s.lat);
    const noLoc = myStands().filter(s => !s.lat);
    const truck = me.truck;
    $app.innerHTML = header() + '<h1>Find my stand</h1>' +
      '<p class="status">Pick where you\'re going. The arrow points the way and the distance counts down. Works with no signal.</p>' +
      '<label for="target">Go to</label><select id="target">' +
      (truck ? '<option value="__truck">My truck (marked ' + esc(truck.when) + ')</option>' : '') +
      list.map(s => '<option value="' + esc(s.id) + '">' + esc(s.id) + ' · ' + kindWord(s) + ' on ' + esc(s.prop) + '</option>').join('') +
      (list.length || truck ? '' : '<option value="">Nothing with a location yet</option>') + '</select>' +
      (noLoc.length ? '<p class="status">No location on file for ' + noLoc.map(s => esc(s.id)).join(', ') + '. Log a move at the stand with Use my location to add one.</p>' : '') +
      '<div id="compass" class="compass"><div class="dial"><div class="north" id="north">N</div>' +
      '<svg id="arrow" viewBox="0 0 100 100" aria-hidden="true"><path d="M50 6 L74 70 L50 58 L26 70 Z"/></svg></div>' +
      '<div class="dist" id="dist">Finding you…</div><div class="dir" id="dir"></div><div class="status" id="acc"></div></div>' +
      '<div id="compass-note"></div>' +
      '<button class="big alt" id="truck">' + (truck ? 'Re-mark my truck here' : 'Mark my truck here') + '<small>Tap where you park. The arrow can lead you back after dark.</small></button>' +
      '<p class="center"><button class="plain" id="night">' + (me.night ? 'Normal screen' : 'Red night screen') + '</button></p>' +
      '<p class="center"><button class="plain" id="back">Back</button></p>';
    if (me.night) document.body.classList.add('night');
    const sel = document.getElementById('target');
    if (target && [...sel.options].some(o => o.value === target)) sel.value = target;
    let fix = null, heading = null, gotHeading = false, wake = null, watch = null;
    const goal = () => sel.value === '__truck' ? me.truck : myStands().find(s => s.id === sel.value);
    const draw = () => {
      const g = goal(), dist = document.getElementById('dist');
      if (!dist) return;
      if (!g) { dist.textContent = 'Nothing to point at yet'; return; }
      if (!fix) return;
      const d = distBearing(fix, g), accFt = Math.round(fix.acc * FT);
      const close = d.ft <= Math.max(75, accFt * 1.5);
      dist.textContent = close ? 'You\'re close' : howFar(d.ft);
      document.getElementById('dir').textContent = close
        ? 'Within about ' + howFar(Math.max(d.ft, accFt)) + '. GPS can\'t do better under the trees: look for your tag.'
        : 'Head ' + compassWord(d.deg) + ' (' + Math.round(d.deg) + '°)';
      document.getElementById('acc').textContent = 'GPS ±' + accFt + ' ft' + (accFt > 60 ? ' (weak: step into the open if you can)' : '');
      const arrow = document.getElementById('arrow');
      arrow.classList.toggle('close', close);
      const turn = heading == null ? d.deg : d.deg - heading;
      arrow.style.transform = 'rotate(' + turn + 'deg)';
      document.getElementById('north').style.transform = 'rotate(' + (heading == null ? 0 : -heading) + 'deg) translateY(-118px)';
    };
    const onFix = p => { fix = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }; draw(); };
    if (navigator.geolocation) watch = navigator.geolocation.watchPosition(onFix,
      () => { const dd = document.getElementById('dist'); if (dd && !fix) dd.textContent = 'No GPS. Check Location is on for this app.'; },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
    // Compass: iPhone gives webkitCompassHeading; Android gives an absolute alpha (relative events are never used:
    // they have no north). Both read magnetic north, so DECLINATION turns it into true north to match GPS bearings.
    // tiltHeading keeps it right whether the phone is held flat or upright.
    const onTurn = e => {
      let h = null;
      if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;
      else if ((e.absolute || evt === 'deviceorientationabsolute') && typeof e.alpha === 'number') h = tiltHeading(e.alpha, e.beta, e.gamma);
      if (h == null) return;
      const screenAngle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
      h = (h + screenAngle + DECLINATION + 360) % 360;
      if (heading == null) heading = h;
      else { const diff = ((h - heading + 540) % 360) - 180; heading = (heading + diff * 0.25 + 360) % 360; }
      gotHeading = true; draw();
    };
    const evt = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
    const startCompass = () => window.addEventListener(evt, onTurn);
    const note = document.getElementById('compass-note');
    if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') {
      note.innerHTML = '<button class="big" id="perm">Turn on the compass<small>Your phone asks each time. Tap Allow.</small></button>';
      document.getElementById('perm').onclick = async () => {
        try { if (await DeviceOrientationEvent.requestPermission() === 'granted') { startCompass(); note.innerHTML = ''; } else note.innerHTML = '<div class="note warn">Compass not allowed. The arrow points as if the top of the phone faces north; the direction words still work.</div>'; }
        catch (err) { note.innerHTML = '<div class="note warn">Couldn\'t turn on the compass. The direction words still work.</div>'; }
      };
    } else startCompass();
    setTimeout(() => { if (!gotHeading && !document.getElementById('perm') && document.getElementById('compass-note')) document.getElementById('compass-note').innerHTML = '<div class="note warn">No compass reading from this phone. The arrow points as if the top of the phone faces north; use the direction words.</div>'; }, 4000);
    // Keep the screen on while finding (where supported).
    if (navigator.wakeLock) navigator.wakeLock.request('screen').then(w => { wake = w; }).catch(() => {});
    findStop = () => {
      if (watch != null) navigator.geolocation.clearWatch(watch);
      window.removeEventListener(evt, onTurn);
      if (wake) wake.release().catch(() => {});
      document.body.classList.remove('night');
      findStop = null;
    };
    sel.onchange = draw;
    document.getElementById('back').onclick = () => { findStop && findStop(); showHome(); };
    document.getElementById('night').onclick = () => {
      me.night = !me.night; save(me);
      document.body.classList.toggle('night', me.night);
      document.getElementById('night').textContent = me.night ? 'Normal screen' : 'Red night screen';
    };
    document.getElementById('truck').onclick = async () => {
      const b = document.getElementById('truck');
      b.disabled = true; b.firstChild.textContent = 'Getting your location…';
      const g = fix && fix.acc < 30 ? { lat: fix.lat, lng: fix.lng, acc: fix.acc } : await gps(true);
      if (!g) { b.disabled = false; b.firstChild.textContent = 'Couldn\'t get a location. Try again'; return; }
      me.truck = { lat: g.lat, lng: g.lng, acc: g.acc, when: new Date().toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) };
      save(me);
      findStop(); showFind(sel.value === '__truck' ? '__truck' : sel.value);
    };
  }

  async function queue(label, payload) {
    const clientId = uid();
    await outbox('put', { clientId, label, created: Date.now(), payload: Object.assign({ clientId }, payload) });
    flush();
  }

  /* ---------- start ---------- */
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (me && me.track) startTrackWatch();
  if (me) { showHome(); quietRefresh().then(() => { if (me && document.getElementById('outbox-status')) showHome(); }); } else showLogin();
})();
