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
    $app.innerHTML = header() +
      (note ? '<div class="note ok">' + note + '</div>' : '') +
      '<div id="outbox-status" class="status"></div>' +
      '<button class="big" data-go="book">Book a Hunt<small>By 5 pm the day before. Required before every hunt.</small></button>' +
      '<button class="big" data-go="hunt">Report Your Hunt<small>Every outing, within 48 hours, even if you saw nothing.</small></button>' +
      '<button class="big alt" data-go="harvest">Report Your Harvest<small>One report for each deer, the day you take it.</small></button>' +
      (me.track
        ? '<button class="big" style="background:#8A2E1F" data-go="after">Finished tracking on ' + esc(me.track.property) + '<small>Tap when you\'re done, found or not.</small></button>'
        : '<button class="big alt" data-go="before">Tracking After Dark<small>Before you go in after dark. Needs signal: Home Ground is alerted at once.</small></button>') +
      '<button class="big alt" data-go="stand">Stand &amp; Camera Log<small>Every placement, move or removal.</small></button>' +
      '<h2>Your properties</h2><div class="card">' +
      (me.properties && me.properties.length
        ? me.properties.map(p => '<div>' + esc(p.code) + (p.town ? ' · ' + esc(p.town) : '') + '</div>').join('')
        : '<span class="status">None assigned yet. Home Ground will email you when you have one.</span>') +
      '</div><p class="center"><button class="plain" id="out">Sign out</button></p>';
    const screens = { book: showBook, hunt: showHunt, harvest: showHarvest, before: showBefore, after: showAfter, stand: showStand };
    $app.querySelectorAll('[data-go]').forEach(b => b.onclick = () => screens[b.dataset.go]());
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
