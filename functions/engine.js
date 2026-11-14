/*
 * CHARM engine: the single source of truth for how readings become statuses.
 * Used by the Cloud Functions (server, authoritative alerts) and by the web app (display).
 * Plain ES5 + UMD so the same file runs in Node and in the browser without a build step.
 *
 * Edit this file in /shared only. `firebase deploy` copies it to functions/ and public/js/ (predeploy hooks).
 * Thresholds are demo values from the CHARM indicator playbook and need medical review.
 */
(function (root, factory) {
  var E = factory();
  if (typeof module === 'object' && module.exports) module.exports = E;
  else root.CHARM_ENGINE = E;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var MIN = 60000, H = 3600000, D = 86400000;

  /* Metrics shown in the app. stat = result of a periodic test (no time series). */
  var MDEF = {
    hr: { label: 'Heart rate', short: 'Heart', unit: 'bpm', dec: 0 },
    bp: { label: 'Blood pressure', short: 'BP', unit: 'mmHg', dec: 0 },
    spo2: { label: 'Blood oxygen (SpO₂)', short: 'SpO₂', unit: '%', dec: 0 },
    rr: { label: 'Respiratory rate', short: 'Breathing', unit: '/min', dec: 0 },
    temp: { label: 'Core body temperature', short: 'Temp', unit: '°C', dec: 1 },
    glu: { label: 'Blood glucose', short: 'Glucose', unit: 'mg/dL', dec: 0 },
    sleep: { label: 'Sleep', short: 'Sleep', unit: 'h', dec: 1 },
    mood: { label: 'Mood check-in', short: 'Mood', unit: '/10', dec: 0 },
    ex: { label: 'Exercise completion', short: 'Exercise', unit: '%', dec: 0 },
    dose: { label: 'Radiation dose budget', short: 'Dose', unit: '%', dec: 1 },
    vision: { label: 'Vision (SANS)', short: 'Vision', unit: '', dec: 0, stat: true },
    blood: { label: 'Blood and immune panel', short: 'Blood panel', unit: '', dec: 0, stat: true },
    rt: { label: 'Reaction time', short: 'Reaction', unit: 'ms', dec: 0, hidden: true }
  };
  var MKEYS = ['hr', 'bp', 'spo2', 'rr', 'temp', 'glu', 'sleep', 'mood', 'ex', 'dose', 'vision', 'blood'];
  var LKEYS = ['hr', 'bp', 'spo2', 'rr', 'temp', 'glu', 'sleep', 'mood', 'ex', 'dose'];
  var RKEYS = MKEYS.concat(['rt']); // every metric a reading can carry
  var ENVKEYS = { co2: { label: 'Cabin CO₂', unit: 'mmHg' }, pfu: { label: 'Space weather (protons ≥10 MeV)', unit: 'pfu' }, ctemp: { label: 'Cabin temperature', unit: '°C' } };

  /* CHARM common thresholds (demo values, need medical review). */
  var COMMON = {
    hr: { cLo: 50, cHi: 100, xLo: 40, xHi: 130 },
    spo2: { c: 94, x: 90 },
    rr: { cLo: 11, cHi: 21, xLo: 8, xHi: 25 },
    temp: { cLo: 35.9, cHi: 38.0, xLo: 35.0, xHi: 39.0 },
    bp: { sC: 140, sCL: 90, dC: 90, sX: 180, sXL: 80, dX: 120 },
    glu: { cLo: 70, cHi: 180, xLo: 54, xHi: 250 },
    sleep: { c: 6, x: 5 },
    mood: { c: 4, x: 3 },
    ex: { c: 75, x: 50 },
    dose: { c: 50, x: 80 }
  };
  /* Editable threshold fields (used by Settings and validated by the server). */
  var THF = {
    hr: [['cLo', 'Caution below'], ['cHi', 'Caution above'], ['xLo', 'Critical below'], ['xHi', 'Critical above']],
    spo2: [['c', 'Caution below'], ['x', 'Critical at or below']],
    rr: [['cLo', 'Caution at or below'], ['cHi', 'Caution at or above'], ['xLo', 'Critical at or below'], ['xHi', 'Critical at or above']],
    temp: [['cLo', 'Caution at or below'], ['cHi', 'Caution at or above'], ['xLo', 'Critical at or below'], ['xHi', 'Critical at or above']],
    sleep: [['c', 'Caution below (h)'], ['x', 'Critical below, 2 nights']],
    dose: [['c', 'Caution at (%)'], ['x', 'Critical at (%)']]
  };
  /* Plausible ranges. Values outside are rejected (sensor slip) and never raise an alert. */
  var PLAUS = { hr: [25, 230], spo2: [70, 100], rr: [4, 60], temp: [33, 42.5], bp: [60, 250], bp2: [30, 160], glu: [30, 500], sleep: [0, 16], mood: [0, 10], ex: [0, 200], dose: [0, 200], rt: [100, 3000], co2: [0, 30], pfu: [0, 1e7], ctemp: [5, 40] };

  /* How long a reading counts as current. Continuous sensors go stale fast; hand-entered values last longer.
     Stale data is never shown as green: it becomes NO DATA. */
  var FRESH = {
    hr: [15 * MIN, 6 * H], spo2: [15 * MIN, 6 * H], rr: [15 * MIN, 6 * H], temp: [30 * MIN, 8 * H], glu: [60 * MIN, 12 * H],
    bp: [40 * H, 40 * H], sleep: [36 * H, 36 * H], mood: [36 * H, 36 * H], ex: [48 * H, 48 * H], dose: [24 * H, 7 * D],
    vision: [14 * D, 14 * D], blood: [21 * D, 21 * D], rt: [72 * H, 72 * H]
  };
  var CONTINUOUS = { device: 1, demo: 1, import: 1 };
  /* 'record' = an imported clinical record (one measurement a day, e.g. NASA bed-rest morning vitals): current for 26 hours. */
  var DAILY = { hr: 1, spo2: 1, rr: 1, temp: 1, bp: 1, glu: 1 };
  function freshFor(k, src) {
    var f = FRESH[k] || [H, H];
    if (src === 'import') return Math.max(f[0], 180 * MIN);
    if (src === 'record') return DAILY[k] ? Math.max(f[1], 26 * H) : f[1];
    return CONTINUOUS[src] ? f[0] : f[1];
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /*
   * Personal offsets. A person whose pre-mission (baseline) average differs from the crew average gets their CAUTION
   * limits moved by the difference. CRITICAL limits never move (they mean danger for any body).
   * Crew averages: NASA bed-rest pre-phase means of 29 volunteers (data/reference/crew_average_baselines.csv).
   * cap  = largest automatic offset (1.5 x the between-person spread); a bigger difference is capped and flagged for review.
   * gap  = a caution limit always stays at least this far inside its critical limit.
   * Needs at least 5 baseline readings.
   */
  var CREW_AVG = { hr: { avg: 69.0, cap: 15, gap: 5, dec: 0 }, sbp: { avg: 116.0, cap: 11, gap: 5, dec: 0 }, dbp: { avg: 70.0, cap: 10, gap: 5, dec: 0 },
                   rr: { avg: 16.9, cap: 1.4, gap: 2, dec: 0 }, temp: { avg: 36.5, cap: 0.4, gap: 0.5, dec: 1 } };
  var MIN_BASE_N = 5;
  function personalOffsets(base) {
    var out = {};
    Object.keys(CREW_AVG).forEach(function (m) {
      var b = base && base[m], c = CREW_AVG[m];
      if (!b || typeof b.mean !== 'number' || !isFinite(b.mean) || (b.n || 0) < MIN_BASE_N) return;
      var raw = b.mean - c.avg, off = Math.max(-c.cap, Math.min(c.cap, raw)), p = Math.pow(10, c.dec);
      off = Math.round(off * p) / p;
      out[m] = { mean: b.mean, n: b.n, avg: c.avg, raw: Math.round(raw * 10) / 10, off: off, capped: Math.abs(raw) > c.cap };
    });
    return out;
  }
  function applyOffsets(pr, offs) {
    var shift = {};
    function mv(k, f, d, lo, hi) { // move pr[k][f] by d, kept inside [lo, hi]
      var v = pr[k][f] + d; v = Math.max(lo, Math.min(hi, v)); v = Math.round(v * 10) / 10;
      if (v !== pr[k][f]) { shift[k + '.' + f] = Math.round((v - pr[k][f]) * 10) / 10; pr[k][f] = v; }
    }
    var o;
    if ((o = offs.hr)) { mv('hr', 'cLo', o.off, pr.hr.xLo + CREW_AVG.hr.gap, pr.hr.cHi - 10); mv('hr', 'cHi', o.off, pr.hr.cLo + 10, pr.hr.xHi - CREW_AVG.hr.gap); pr.hr.b = o.mean; }
    if ((o = offs.rr)) { mv('rr', 'cLo', o.off, pr.rr.xLo + CREW_AVG.rr.gap, pr.rr.cHi - 4); mv('rr', 'cHi', o.off, pr.rr.cLo + 4, pr.rr.xHi - CREW_AVG.rr.gap); }
    if ((o = offs.temp)) { mv('temp', 'cLo', o.off, pr.temp.xLo + CREW_AVG.temp.gap, pr.temp.cHi - 1); mv('temp', 'cHi', o.off, pr.temp.cLo + 1, pr.temp.xHi - CREW_AVG.temp.gap); pr.temp.b = o.mean; }
    if ((o = offs.sbp)) { mv('bp', 'sCL', o.off, pr.bp.sXL + CREW_AVG.sbp.gap, pr.bp.sC - 20); mv('bp', 'sC', o.off, pr.bp.sCL + 20, pr.bp.sX - CREW_AVG.sbp.gap); }
    if ((o = offs.dbp)) { mv('bp', 'dC', o.off, 60, pr.bp.dX - CREW_AVG.dbp.gap); }
    return shift;
  }
  /* overrides: { hr: { cLo: { v: 45, by, when, why } } }. base: crew member's pre-mission baseline { hr: { mean, n, sd }, sbp, dbp, rr, temp }.
     Order: CHARM common -> personal offset (automatic) -> personal override (flight surgeon / CMO). */
  function profile(ovr, base) {
    var pr = clone(COMMON), o = ovr || {}, offs = personalOffsets(base);
    var shift = applyOffsets(pr, offs);
    Object.keys(o).forEach(function (k) { if (!pr[k]) return; Object.keys(o[k] || {}).forEach(function (f) { var x = o[k][f]; if (x && typeof x.v === 'number') pr[k][f] = x.v; }); });
    Object.defineProperty(pr, '_personal', { value: { offsets: offs, shift: shift }, enumerable: false });
    return pr;
  }
  /* Limits must stay in order: critical below <= caution below < caution above <= critical above. */
  function checkProfile(pr) {
    var bad = [];
    ['hr', 'rr', 'temp'].forEach(function (k) { var t = pr[k]; if (!(t.xLo <= t.cLo && t.cLo < t.cHi && t.cHi <= t.xHi)) bad.push(MDEF[k].label); });
    if (!(pr.spo2.c >= pr.spo2.x)) bad.push(MDEF.spo2.label);
    if (!(pr.sleep.c >= pr.sleep.x)) bad.push(MDEF.sleep.label);
    if (!(pr.dose.c <= pr.dose.x)) bad.push(MDEF.dose.label);
    return bad;
  }

  /* Validate one reading. Returns an error string or null. r = { pid, k, t, v, v2, irr, ctx, txt, l } */
  function validateReading(r, now) {
    if (!r || typeof r !== 'object') return 'not an object';
    if (RKEYS.indexOf(r.k) < 0) return 'unknown metric ' + r.k;
    if (typeof r.t !== 'number' || !isFinite(r.t)) return 'missing time';
    if (r.t > now + 5 * MIN) return 'time is in the future';
    if (r.t < now - 400 * D) return 'time is more than 400 days ago';
    if (MDEF[r.k].stat) { if ([0, 1, 2].indexOf(r.l) < 0) return 'result level must be 0, 1 or 2'; return null; }
    if (typeof r.v !== 'number' || !isFinite(r.v)) return 'missing value';
    var p = PLAUS[r.k]; if (p && (r.v < p[0] || r.v > p[1])) return 'implausible ' + r.k + ' ' + r.v;
    if (r.k === 'bp') { if (typeof r.v2 !== 'number' || r.v2 < PLAUS.bp2[0] || r.v2 > PLAUS.bp2[1] || r.v2 >= r.v) return 'implausible diastolic'; }
    if (r.ctx != null && ['rest', 'ex', 'sleep'].indexOf(r.ctx) < 0) return 'unknown context';
    return null;
  }
  function validateEnv(e, now) {
    if (!e || !ENVKEYS[e.k]) return 'unknown cabin metric';
    if (typeof e.t !== 'number' || e.t > now + 5 * MIN) return 'bad time';
    if (typeof e.v !== 'number' || !isFinite(e.v)) return 'missing value';
    var p = PLAUS[e.k]; if (p && (e.v < p[0] || e.v > p[1])) return 'implausible ' + e.k + ' ' + e.v;
    return null;
  }

  /* --- series helpers. A series is { k: [ readings sorted by t ] } --- */
  function sortSeries(list) {
    var s = {};
    (list || []).forEach(function (r) { (s[r.k] || (s[r.k] = [])).push(r); });
    Object.keys(s).forEach(function (k) { s[k].sort(function (a, b) { return a.t - b.t; }); });
    return s;
  }
  function lastIdx(arr, t) { // last index with arr[i].t <= t
    if (!arr || !arr.length || arr[0].t > t) return -1;
    var lo = 0, hi = arr.length - 1;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (arr[mid].t <= t) lo = mid; else hi = mid - 1; }
    return lo;
  }
  function lastReading(series, k, t) { var a = series && series[k], i = lastIdx(a, t); return i < 0 ? null : a[i]; }

  /* Value of metric k at time t, or null when there is no current reading (NO DATA). */
  function valueAt(series, k, t) {
    var arr = series && series[k], i = lastIdx(arr, t);
    if (i < 0) return null;
    var r = arr[i];
    if (t - r.t > freshFor(k, r.src)) return null;
    var out = { v: r.v, v2: r.v2, t: r.t, ref: r.ref || null, irr: !!r.irr, ex: r.ctx === 'ex', sl: r.ctx === 'sleep', imp: r.src === 'import', man: r.src === 'manual' || r.src === 'test', src: r.src, by: r.by || null, txt: r.txt || null, l: r.l };
    if ((k === 'hr' || k === 'spo2' || k === 'rr') && CONTINUOUS[r.src]) { // median of the last 3 sensor readings, so one spike doesn't alert
      var v = [];
      for (var j = i; j >= 0 && v.length < 3 && r.t - arr[j].t <= 6 * MIN; j--) if (CONTINUOUS[arr[j].src] && (arr[j].ctx === 'ex') === (r.ctx === 'ex')) v.push(arr[j].v); // never mix exercise and rest readings
      v.sort(function (a, b) { return a - b; }); out.v = v[Math.floor(v.length / 2)];
    }
    if (k === 'sleep' && i > 0 && r.t - arr[i - 1].t <= 36 * H) out.prev = arr[i - 1].v;
    return out;
  }

  function levelOf(k, val, th) {
    if (!val) return -1;
    if (MDEF[k] && MDEF[k].stat) return typeof val.l === 'number' ? val.l : 0;
    if (!th) return 0;
    var v = val.v;
    switch (k) {
      case 'hr': if (val.irr) return 2; if (val.ex) return v > 185 ? 2 : v > 170 ? 1 : 0; var sl = val.sl ? 10 : 0; if (v < th.xLo - sl + 2 * (sl > 0) || v > th.xHi) return 2; if (v < th.cLo - sl || v > th.cHi) return 1;
        if (th.b && !val.sl && v > th.b * 1.15 && !CONTINUOUS[val.src]) return 1; return 0; // resting measurement > 15 % above own baseline
      case 'spo2': if (v <= th.x) return 2; if (v < th.c) return 1; return 0;
      case 'rr': if (val.ex) return v >= 40 ? 2 : v >= 30 ? 1 : 0; var sr = val.sl ? 2 : 0; if (v <= th.xLo - sr || v >= th.xHi) return 2; if (v <= th.cLo - sr || v >= th.cHi) return 1; return 0;
      case 'temp': if (v >= th.xHi || v <= th.xLo) return 2; if (v >= th.cHi || v <= th.cLo) return 1; if (th.b && v >= th.b + 0.8) return 1; return 0;
      case 'bp': if (val.ex) return v >= 230 || val.v2 >= 120 ? 2 : v >= 210 ? 1 : 0; // during exercise blood pressure rises normally
        if (v >= th.sX || v < th.sXL || val.v2 >= th.dX) return 2; if (v >= th.sC || v < th.sCL || val.v2 >= th.dC) return 1; return 0;
      case 'glu': if (v < th.xLo || v > th.xHi) return 2; if (v < th.cLo || v > th.cHi) return 1; return 0;
      case 'sleep': if (v < th.x && val.prev != null && val.prev < th.x) return 2; if (v < th.c) return 1; return 0;
      case 'mood': if (v <= th.x) return 2; if (v <= th.c) return 1; return 0;
      case 'ex': if (v < th.x) return 2; if (v < th.c) return 1; return 0;
      case 'dose': if (v >= th.x) return 2; if (v >= th.c) return 1; return 0;
      default: return 0;
    }
  }
  function rank(l) { return l === 2 ? 3 : l === 1 ? 2 : l === -1 ? 1 : 0; }

  /* Status of one person at time t. Overall: worst metric; if nothing is abnormal but the wearable is silent, NO DATA. */
  function personStatus(series, th, t) {
    var out = { m: {}, lvl: 0, top: null };
    MKEYS.forEach(function (k) { var v = valueAt(series, k, t); out.m[k] = { val: v, l: levelOf(k, v, th[k]) }; });
    var best = null;
    LKEYS.forEach(function (k) { var l = out.m[k].l; if (l > 0 && (!best || rank(l) > rank(out.m[best].l))) best = k; });
    if (best) { out.lvl = out.m[best].l; out.top = best; }
    else if (out.m.hr.l === -1 && !hasAnyCurrent(out)) { out.lvl = -1; out.top = 'hr'; }
    else if (out.m.hr.l === -1 && wearableSilent(series, t)) { out.lvl = -1; out.top = 'hr'; }
    return out;
  }
  function hasAnyCurrent(st) { return LKEYS.some(function (k) { return st.m[k].l >= 0; }); }
  /* The wearable counts as silent when its last heart-rate reading came from a sensor (not typed in) and is stale. */
  function wearableSilent(series, t) { var r = lastReading(series, 'hr', t); return !!(r && CONTINUOUS[r.src] && t - r.t > freshFor('hr', r.src)); }

  function fmtV(k, val) {
    if (!val) return '—';
    if (k === 'bp') return Math.round(val.v) + '/' + Math.round(val.v2);
    if (val.txt) return val.txt;
    if (typeof val.v !== 'number') return '—';
    var d = (MDEF[k] || {}).dec || 0;
    return (Math.round(val.v * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d);
  }
  var WORD = { '2': 'CRITICAL', '1': 'CAUTION', '0': 'NORMAL', '-1': 'NO DATA' };

  /*
   * Alert transitions with hysteresis.
   * Raise: as soon as a metric gets worse. Clear: only after 3 checks in a row (15 min on the 5-minute tick) back in range,
   * so alerts don't flicker. mode = 'reading' (new data arrived: raises only) or 'tick' (scheduled: raises and clears).
   * state = { levels: {k: l}, low: {k: n}, hrSilent: bool }. Returns { events, state, changed }.
   */
  function transitions(pid, series, th, t, state, mode) {
    var st = personStatus(series, th, t), prev = state || {}, levels = Object.assign({}, prev.levels || {}), low = Object.assign({}, prev.low || {}), ev = [], changed = false;
    var silent = wearableSilent(series, t);
    if (silent && !prev.hrSilent) {
      var lr = lastReading(series, 'hr', t);
      ev.push({ t: t, pid: pid, k: 'hr', lv: -1, type: 'nodata', text: 'Wearable stopped reporting', sub: 'Heart rate, SpO₂, breathing and temperature · last reading ' + new Date(lr.t).toISOString().slice(11, 16) + ' GMT' });
      changed = true;
    } else if (!silent && prev.hrSilent && st.m.hr.l >= 0) {
      ev.push({ t: t, pid: pid, k: 'hr', lv: 0, type: 'clear', text: 'Wearable reporting again' }); changed = true;
    }
    LKEYS.forEach(function (k) {
      var l = st.m[k].l, cur = levels[k] || 0;
      if (l === -1) return; // no current reading: keep the alert state until data returns
      if (l > cur) {
        var v = st.m[k].val;
        ev.push({ t: v ? Math.max(v.t, t - 10 * MIN) : t, pid: pid, k: k, lv: l, type: 'raise', text: MDEF[k].label + ' ' + WORD[String(l)], sub: (k === 'hr' && v && v.irr ? 'Irregular rhythm detected · ' : '') + fmtV(k, v) + (MDEF[k].unit ? ' ' + MDEF[k].unit : '') });
        levels[k] = l; low[k] = 0; changed = true;
      } else if (l < cur) {
        if (mode === 'tick') {
          low[k] = (low[k] || 0) + 1;
          if (low[k] >= 3) { ev.push({ t: t, pid: pid, k: k, lv: l, type: 'clear', text: MDEF[k].label + (l === 0 ? ' back to NORMAL' : ' down to CAUTION'), sub: fmtV(k, st.m[k].val) + (MDEF[k].unit ? ' ' + MDEF[k].unit : '') }); levels[k] = l; low[k] = 0; }
          changed = true;
        }
      } else if (low[k]) { low[k] = 0; changed = true; }
    });
    return { events: ev, state: { levels: levels, low: low, hrSilent: silent, lvl: st.lvl, top: st.top, t: t }, changed: changed || st.lvl !== prev.lvl, status: st };
  }

  /* Cabin environment at time t from env readings { co2: [...], pfu: [...], ctemp: [...] }. */
  function envAt(envSeries, t) {
    var c = lastReading(envSeries, 'co2', t), p = lastReading(envSeries, 'pfu', t), ct = lastReading(envSeries, 'ctemp', t);
    var out = { co2: null, co2avg: null, co2l: -1, pfu: null, pfl: -1, temp: null, tl: -1 };
    if (c && t - c.t <= 2 * H) {
      var a = envSeries.co2, s = 0, n = 0; for (var i = lastIdx(a, t); i >= 0 && t - a[i].t <= H; i--) { s += a[i].v; n++; }
      out.co2 = c.v; out.co2avg = n ? s / n : c.v; out.co2l = c.v >= 4.5 ? 2 : out.co2avg >= 3.0 ? 1 : 0; out.co2t = c.t;
    }
    if (p && t - p.t <= 2 * H) { out.pfu = p.v; out.pfl = p.v >= 100 ? 2 : p.v >= 10 ? 1 : 0; out.pfut = p.t; out.pfsrc = p.src; }
    if (ct && t - ct.t <= 6 * H) { out.temp = ct.v; out.tl = ct.v < 18 || ct.v > 27 ? 1 : 0; out.tempt = ct.t; }
    return out;
  }
  function envTransitions(envSeries, t, state) {
    var e = envAt(envSeries, t), s = Object.assign({ co2l: 0, pfl: 0 }, state || {}), ev = [];
    if (e.co2l >= 0 && e.co2l !== s.co2l) { ev.push({ t: t, pid: null, k: 'co2', lv: e.co2l, type: e.co2l > s.co2l ? 'raise' : 'clear', text: e.co2l > s.co2l ? 'Cabin CO₂ ' + WORD[String(e.co2l)] + ' · affects all crew' : 'Cabin CO₂ back to ' + WORD[String(e.co2l)], sub: '1-hour average ' + e.co2avg.toFixed(1) + ' mmHg' }); s.co2l = e.co2l; }
    if (e.pfl >= 0 && e.pfl !== s.pfl) { ev.push({ t: t, pid: null, k: 'pfu', lv: e.pfl, type: e.pfl > s.pfl ? 'raise' : 'clear', text: e.pfl > s.pfl ? 'Solar particle event · NOAA S' + (e.pfu >= 1000 ? 2 : 1) : 'Solar particle event over', sub: 'Protons ≥10 MeV: ' + e.pfu.toFixed(0) + ' pfu' }); s.pfl = e.pfl; }
    return { events: ev, state: s };
  }

  /* Mission geometry. Mars transit: Hohmann transfer launched on Mission Day 1 (a = 1.262 AU, e = 0.2076). */
  function missionDay(t, launch) { return Math.floor((t - launch) / D) + 1; }
  function shipGeom(t, launch) {
    var md = (t - launch) / D + 1, a = 1.262, e = 0.2076, P = 517.8, M = 2 * Math.PI * (md - 1) / P, E = M;
    for (var i = 0; i < 14; i++) E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    var nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2)), r = a * (1 - e * Math.cos(E));
    var th = 2 * Math.PI * (md - 1) / 365.25, ma = (44 + 0.524 * (md - 1)) * Math.PI / 180;
    var sx = r * Math.cos(nu), sy = r * Math.sin(nu), ex = Math.cos(th), ey = Math.sin(th), au = Math.hypot(sx - ex, sy - ey);
    return { md: md, r: r, nu: nu, sx: sx, sy: sy, ex: ex, ey: ey, mx: 1.524 * Math.cos(ma), my: 1.524 * Math.sin(ma), au: au, km: au * 149597870.7, lt: au * 499.005 };
  }
  /* One-way signal time in seconds. */
  function oneWay(t, mission) {
    var env = (mission && mission.env) || 'mars';
    if (env === 'moon') return 1.28; if (env === 'iss') return 0.6;
    return shipGeom(t, (mission && mission.launch) || t).lt;
  }

  return {
    MIN: MIN, H: H, D: D, MDEF: MDEF, MKEYS: MKEYS, LKEYS: LKEYS, RKEYS: RKEYS, ENVKEYS: ENVKEYS, COMMON: COMMON, THF: THF, PLAUS: PLAUS, FRESH: FRESH,
    freshFor: freshFor, profile: profile, personalOffsets: personalOffsets, CREW_AVG: CREW_AVG, checkProfile: checkProfile, validateReading: validateReading, validateEnv: validateEnv,
    sortSeries: sortSeries, lastIdx: lastIdx, lastReading: lastReading, valueAt: valueAt, levelOf: levelOf, rank: rank,
    personStatus: personStatus, wearableSilent: wearableSilent, fmtV: fmtV, WORD: WORD, transitions: transitions,
    envAt: envAt, envTransitions: envTransitions, missionDay: missionDay, shipGeom: shipGeom, oneWay: oneWay, clone: clone
  };
});
