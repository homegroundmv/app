/* Home Ground Facility app — core.
 *
 * Step one of splitting app.js, 9 November 2026 (Joe). app.js was 320KB in one file, which is
 * what made every deploy an all-or-nothing hand-carry through GitHub Desktop. This is the
 * safest layer to move first: constants and pure functions. NOTHING IN HERE TOUCHES THE DOM,
 * THE NETWORK, OR APP STATE. If a function in this file needs `document`, `fetch`, the settings
 * or the deer list, it is in the wrong file — put it back in app.js.
 *
 * Loaded by index.html BEFORE app.js, and cached by sw.js. app.js reads it from window.HG_CORE
 * and fails loudly if it is missing, because a half-loaded app is worse than one that says so.
 */
window.HG_CORE = (function () {
  'use strict';

  /* Shown next to Sign out. Twice on 7 November we lost time to not knowing which copy of the app
     a phone was actually running — a fix looks ineffective when the phone is still on yesterday's
     service worker, and there was no way to tell by looking. Keep this in step with VERSION in
     sw.js: it is the number somebody reads out over the phone. It had drifted to v68 while v69
     and v70 shipped, which is exactly the confusion it exists to prevent, so a test now fails if
     this and VERSION in sw.js disagree. */
  const APP_VERSION = 'v88';
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

  return { APP_VERSION, KEY, esc, pad, stamp, parse, uid, band, num, r1, fmt, isoDate, dayName, nowMin, fromHM, hm2, t12, when, hhmm, splitName, first, BAND_HEX, hexFor };
})();
