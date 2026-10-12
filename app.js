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
    const res = await fetch(CFG.BACKEND_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) });
    const out = await res.json();
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
        me = { hunter: out.hunter, pin, name: out.name, properties: out.properties, refreshed: Date.now() };
        save(me); showHome();
      } catch (e) {
        showLogin(e.fatal ? e.message : 'No signal. The first sign-in needs a connection.');
      }
    };
  }

  async function quietRefresh() {
    // Keeps the property list current; does nothing without signal.
    if (!navigator.onLine) return;
    try {
      const out = await call({ action: 'login', hunter: me.hunter, pin: me.pin });
      me.properties = out.properties; me.name = out.name; me.refreshed = Date.now(); save(me);
    } catch (e) {
      if (e.fatal) { me = null; save(null); showLogin(e.message); }
    }
  }

  function showHome(note) {
    $app.innerHTML = header() +
      (note ? '<div class="note ok">' + note + '</div>' : '') +
      '<div id="outbox-status" class="status"></div>' +
      '<button class="big" data-go="book">Book a Hunt<small>By 5 pm the day before. Required before every hunt.</small></button>' +
      '<button class="big" data-go="hunt">Report Your Hunt<small>Every outing, within 48 hours, even if you saw nothing.</small></button>' +
      '<button class="big alt" disabled>Report Your Harvest<small>Coming soon. Use the website for now.</small></button>' +
      '<button class="big alt" disabled>Tracking After Dark<small>Coming soon. Use the website for now.</small></button>' +
      '<button class="big alt" disabled>Stand &amp; Camera Log<small>Coming soon. Use the website for now.</small></button>' +
      '<h2>Your properties</h2><div class="card">' +
      (me.properties && me.properties.length
        ? me.properties.map(p => '<div>' + esc(p.code) + (p.town ? ' · ' + esc(p.town) : '') + '</div>').join('')
        : '<span class="status">None assigned yet. Home Ground will email you when you have one.</span>') +
      '</div><p class="center"><button class="plain" id="out">Sign out</button></p>';
    $app.querySelectorAll('[data-go]').forEach(b => b.onclick = () => (b.dataset.go === 'book' ? showBook() : showHunt()));
    document.getElementById('out').onclick = async () => {
      const waiting = (await outbox('all')).length;
      if (waiting && !confirm(waiting + ' report(s) haven\'t sent yet. Sign out anyway? They\'ll be lost.')) return;
      for (const i of await outbox('all')) await outbox('delete', i.clientId);
      me = null; save(null); showLogin();
    };
    refreshStatus(); flush();
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
      '<label for="day">Date of hunt</label><input id="day" type="date" min="' + min + '" value="' + min + '">' +
      '<label for="time">Time of hunt</label><select id="time"><option value="">Choose…</option>' +
      '<option>AM</option><option>PM</option><option>All day</option></select>' +
      '<label for="stand">Stand ID <span class="hint">Optional. The stand or spot you plan to use.</span></label><input id="stand" type="text">' +
      '<label class="choice"><input id="agree" type="checkbox"> I understand I\'m not booked until Home Ground emails to confirm. To change or cancel, I\'ll email ' + esc(CFG.OFFICE_EMAIL) + '.</label>' +
      '<div id="err" class="err"></div><button class="submit" id="send">Send booking</button>' +
      '<p class="center"><button class="plain" id="back">Back</button></p>';
    document.getElementById('back').onclick = () => showHome();
    document.getElementById('send').onclick = async () => {
      const f = id => document.getElementById(id);
      const prop = f('prop') ? f('prop').value : '';
      const err = [];
      if (!prop) err.push('Choose a property.');
      if (!f('day').value) err.push('Pick a date.');
      else if (f('day').value < earliestBookable()) err.push('That date is past the 5 pm cutoff. Pick a later day.');
      if (!f('time').value) err.push('Choose a time.');
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

  async function queue(label, payload) {
    const clientId = uid();
    await outbox('put', { clientId, label, created: Date.now(), payload: Object.assign({ clientId }, payload) });
    flush();
  }

  /* ---------- start ---------- */
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (me) { showHome(); quietRefresh().then(() => { if (me && document.getElementById('outbox-status')) showHome(); }); } else showLogin();
})();
