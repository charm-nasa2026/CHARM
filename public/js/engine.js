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
    fluid: { label: 'Fluid intake', short: 'Fluids', unit: 'L/day', dec: 1 },
    ecg: { label: 'ECG rhythm review', short: 'ECG', unit: '', dec: 0, stat: true },
    ortho: { label: 'Orthostatic BP test', short: 'Orthostatic', unit: '', dec: 0, stat: true },
    urine: { label: 'Urine and kidney check', short: 'Kidney', unit: '', dec: 0, stat: true },
    ijv: { label: 'Neck vein ultrasound (IJV)', short: 'Neck vein', unit: '', dec: 0, stat: true },
    sym: { label: 'Symptom check', short: 'Symptoms', unit: '', dec: 0, stat: true },
    /* condition-level alerts (CHARM_Exact_Alert_Thresholds, medic team). Computed from several signals; not entered directly. */
    c_inf: { label: 'Infection / systemic deterioration', short: 'Infection', unit: '', dec: 0, cond: true, hidden: true },
    c_af: { label: 'Atrial fibrillation / arrhythmia', short: 'Arrhythmia', unit: '', dec: 0, cond: true, hidden: true },
    c_orth: { label: 'Orthostatic hypotension', short: 'Orthostatic', unit: '', dec: 0, cond: true, hidden: true },
    c_kid: { label: 'Kidney stone risk', short: 'Kidney', unit: '', dec: 0, cond: true, hidden: true },
    c_sans: { label: 'SANS (eyes and optic disc)', short: 'SANS', unit: '', dec: 0, cond: true, hidden: true },
    c_vte: { label: 'Venous thrombosis (neck vein)', short: 'VTE', unit: '', dec: 0, cond: true, hidden: true },
    rt: { label: 'Reaction time', short: 'Reaction', unit: 'ms', dec: 0, hidden: true }
  };
  var EXAMK = ['ecg', 'ortho', 'urine', 'ijv', 'sym'];
  var CONDK = ['c_inf', 'c_af', 'c_orth', 'c_kid', 'c_sans', 'c_vte'];
  var MKEYS = ['hr', 'bp', 'spo2', 'rr', 'temp', 'glu', 'sleep', 'mood', 'ex', 'dose', 'fluid', 'vision', 'blood'].concat(EXAMK).concat(CONDK);
  var LKEYS = ['hr', 'bp', 'spo2', 'rr', 'temp', 'glu', 'sleep', 'mood', 'ex', 'dose'].concat(CONDK); // what raises alerts
  var RKEYS = MKEYS.filter(function (k) { return CONDK.indexOf(k) < 0; }).concat(['rt']); // every metric a reading can carry
  /* Alert levels. -1 NO DATA · 0 NORMAL (green) · 1 ATTENTION (yellow: one screening limit crossed)
     · 2 CAUTION (orange: medical criterion or multi-signal pattern) · 3 CRITICAL (red: urgent). */
  var ATT = 1, CAU = 2, CRI = 3, SCALE = 4;
  var ENVKEYS = { co2: { label: 'Cabin CO₂', unit: 'mmHg' }, pfu: { label: 'Space weather (protons ≥10 MeV)', unit: 'pfu' }, ctemp: { label: 'Cabin temperature', unit: '°C' } };

  /* CHARM common thresholds (demo values, need medical review). */
  var COMMON = {
    hr: { cLo: 50, cHi: 100, xLo: 40, xHi: 130 },
    spo2: { c: 94, x: 90 },
    rr: { cLo: 11, cHi: 21, xLo: 8, xHi: 25 },
    temp: { cLo: 35.9, cHi: 38.1, xLo: 35.0, xHi: 39.0 }, // ATTENTION < 36.0 or > 38.0 (SIRS)
    bp: { sC: 140, sCL: 90, dC: 90, sX: 180, sXL: 80, dX: 120 },
    glu: { cLo: 70, cHi: 180, xLo: 54, xHi: 250 },
    sleep: { c: 6, x: 5 },
    mood: { c: 4, x: 3 },
    ex: { c: 75, x: 50 },
    dose: { c: 50, x: 80 },
    fluid: { c: 2.5 },
    /* infection screen (SIRS, orange). Personal offsets move these like the ATTENTION limits. qSOFA (red) is fixed. */
    inf: { tHi: 38.0, tLo: 36.0, hr: 90, rr: 20 }
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
  var PLAUS = { hr: [25, 230], spo2: [70, 100], rr: [4, 60], temp: [33, 42.5], bp: [60, 250], bp2: [30, 160], glu: [30, 500], sleep: [0, 16], mood: [0, 10], ex: [0, 200], dose: [0, 200], fluid: [0, 15], rt: [100, 3000], co2: [0, 30], pfu: [0, 1e7], ctemp: [5, 40] };

  /* How long a reading counts as current. Continuous sensors go stale fast; hand-entered values last longer.
     Stale data is never shown as green: it becomes NO DATA. */
  var FRESH = {
    hr: [15 * MIN, 6 * H], spo2: [15 * MIN, 6 * H], rr: [15 * MIN, 6 * H], temp: [30 * MIN, 8 * H], glu: [60 * MIN, 12 * H],
    bp: [40 * H, 40 * H], sleep: [36 * H, 36 * H], mood: [36 * H, 36 * H], ex: [48 * H, 48 * H], dose: [24 * H, 7 * D],
    vision: [30 * D, 30 * D], blood: [21 * D, 21 * D], rt: [72 * H, 72 * H], fluid: [36 * H, 36 * H],
    ecg: [7 * D, 7 * D], ortho: [7 * D, 7 * D], urine: [7 * D, 7 * D], ijv: [30 * D, 30 * D], sym: [24 * H, 24 * H]
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
    // orange infection-screen numbers move too (user decision: personal offsets on yellow and orange; red stays fixed)
    if ((o = offs.hr)) mv('inf', 'hr', o.off, 70, pr.hr.xHi - CREW_AVG.hr.gap);
    if ((o = offs.rr)) mv('inf', 'rr', o.off, 14, 21);   // stays below the qSOFA red 22
    if ((o = offs.temp)) { mv('inf', 'tHi', o.off, 37.5, pr.temp.xHi - CREW_AVG.temp.gap); mv('inf', 'tLo', o.off, pr.temp.xLo + CREW_AVG.temp.gap, 36.5); }
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
    if (MDEF[r.k].stat) {
      if (r.x != null) return validateExam(r.k, r.x);
      if ([0, 1, 2, 3].indexOf(r.l) < 0) return 'result level must be 0 to 3'; return null;
    }
    if (typeof r.v !== 'number' || !isFinite(r.v)) return 'missing value';
    var p = PLAUS[r.k]; if (p && (r.v < p[0] || r.v > p[1])) return 'implausible ' + r.k + ' ' + r.v;
    if (r.k === 'bp') { if (typeof r.v2 !== 'number' || r.v2 < PLAUS.bp2[0] || r.v2 > PLAUS.bp2[1] || r.v2 >= r.v) return 'implausible diastolic'; }
    if (r.ctx != null && ['rest', 'ex', 'sleep'].indexOf(r.ctx) < 0) return 'unknown context';
    return null;
  }
  /* Exam results (fields per exam). Numbers optional; flags are true/false. */
  var EXAMF = {
    ecg: { irr: 'b', noP: 'b', sec: [0, 3600], unstable: 'b' },
    ortho: { s1: [60, 250], d1: [30, 160], s2: [40, 250], d2: [20, 160], min: [0, 20], syncope: 'b' },
    urine: { vol: [0, 10], blood: 'b', us: ['none', 'stone', 'hydro'] },
    ijv: { vel: [0, 200], retro: 'b', thrombus: 'b' },
    vision: { trt: [-100, 400], frisen: [0, 5], refr: [-10, 10], folds: ['none', 'any', 'sharp'], flat: ['none', 'present', 'moderate'] },
    sym: { inf: 'b', conf: 'b', faint: 'b', chest: 'b' },
    blood: { hb: [2, 25], hct: [10, 75], wbc: [0, 200], plt: [0, 3000], lym: [0, 50000] }
  };
  function validateExam(k, x) {
    var f = EXAMF[k]; if (!f || typeof x !== 'object') return 'no exam fields for ' + k;
    for (var n in x) {
      var spec = f[n], v = x[n]; if (!spec) return 'unknown field ' + n; if (v == null) continue;
      if (spec === 'b') { if (typeof v !== 'boolean') return n + ' must be yes or no'; }
      else if (typeof spec[0] === 'string') { if (spec.indexOf(v) < 0) return n + ' must be ' + spec.join(' / '); }
      else if (typeof v !== 'number' || !isFinite(v) || v < spec[0] || v > spec[1]) return 'implausible ' + n + ' ' + v;
    }
    return null;
  }
  /* Level of one exam result (CHARM_Exact_Alert_Thresholds). */
  function examLevel(k, x) {
    if (!x) return 0;
    switch (k) {
      case 'ecg': if (x.irr && x.noP && (x.sec || 0) >= 30) return x.unstable ? CRI : CAU; return x.irr ? ATT : 0;
      case 'ortho': if (x.syncope) return CRI; var ds = (x.s1 || 0) - (x.s2 || 0), dd = (x.d1 || 0) - (x.d2 || 0);
        return (x.s1 && x.s2 && ds >= 20) || (x.d1 && x.d2 && dd >= 10) ? ((x.min == null || x.min <= 3) ? CAU : ATT) : 0;
      case 'urine': if (x.us === 'stone' || x.us === 'hydro') return CRI; if (x.blood) return CAU; return x.vol != null && x.vol < 2.5 ? ATT : 0;
      case 'ijv': if (x.thrombus) return CRI; return (x.vel != null && x.vel < 10) || x.retro ? CAU : 0;
      case 'vision': if ((x.trt != null && x.trt >= 55) || (x.frisen != null && x.frisen >= 1) || x.folds === 'sharp' || x.flat === 'moderate') return CRI;
        return (x.trt != null && x.trt >= 20) || (x.refr != null && x.refr >= 0.75) || x.folds === 'any' || x.flat === 'present' ? ATT : 0;
      case 'sym': return x.inf || x.conf || x.faint || x.chest ? ATT : 0;
      case 'blood': var l = 0, up = function (v) { if (v > l) l = v; };
        if (x.wbc != null && (x.wbc > 12 || x.wbc < 4)) up(ATT);        // SIRS WBC criterion
        if (x.wbc != null && (x.wbc > 20 || x.wbc < 2)) up(CRI);
        if (x.hb != null) { if (x.hb < 8) up(CRI); else if (x.hb < 12 || x.hb > 18.5) up(ATT); }
        if (x.plt != null) { if (x.plt < 50 || x.plt > 1000) up(CRI); else if (x.plt < 150 || x.plt > 450) up(ATT); }
        if (x.lym != null) { if (x.lym < 500) up(CRI); else if (x.lym < 1000) up(ATT); }
        return l;
      default: return 0;
    }
  }
  function examText(k, x) {
    if (!x) return null; var p = [];
    switch (k) {
      case 'ecg': return (x.irr ? 'Irregular' : 'Regular') + ' rhythm' + (x.irr ? (x.noP ? ' · no P waves' : ' · P waves seen') : '') + (x.sec ? ' · ' + x.sec + ' s' : '') + (x.unstable ? ' · unstable' : '');
      case 'ortho': return (x.s1 && x.d1 ? x.s1 + '/' + x.d1 : '?') + ' → ' + (x.s2 && x.d2 ? x.s2 + '/' + x.d2 : '?') + ' mmHg standing' + (x.syncope ? ' · fainted' : '');
      case 'urine': if (x.vol != null) p.push(x.vol + ' L/24 h'); p.push(x.blood ? 'blood in urine' : 'no blood'); if (x.us && x.us !== 'none') p.push(x.us === 'stone' ? 'stone on ultrasound' : 'hydronephrosis'); return p.join(' · ');
      case 'ijv': if (x.vel != null) p.push(x.vel + ' cm/s'); if (x.retro) p.push('retrograde flow'); if (x.thrombus) p.push('thrombus seen'); return p.join(' · ') || 'Normal flow';
      case 'vision': if (x.trt != null) p.push('ΔTRT ' + (x.trt > 0 ? '+' : '') + x.trt + ' µm'); if (x.frisen) p.push('Frisén ' + x.frisen); if (x.refr) p.push('refraction ' + (x.refr > 0 ? '+' : '') + x.refr + ' D'); if (x.folds && x.folds !== 'none') p.push(x.folds === 'sharp' ? 'sharp folds near macula' : 'folds'); if (x.flat && x.flat !== 'none') p.push(x.flat + ' globe flattening'); return p.join(' · ') || 'No change from baseline';
      case 'sym': if (x.inf) p.push('suspected infection'); if (x.conf) p.push('confusion'); if (x.faint) p.push('fainting'); if (x.chest) p.push('chest pain'); return p.length ? p.join(' · ') : 'No symptoms';
      case 'blood': if (x.hb != null) p.push('Hb ' + x.hb); if (x.wbc != null) p.push('WBC ' + x.wbc); if (x.plt != null) p.push('Plt ' + x.plt); if (x.lym != null) p.push('Lymph ' + x.lym); return p.join(' · ');
    }
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
    var out = { v: r.v, v2: r.v2, t: r.t, ref: r.ref || null, irr: !!r.irr, ex: r.ctx === 'ex', sl: r.ctx === 'sleep', imp: r.src === 'import', man: r.src === 'manual' || r.src === 'test', src: r.src, by: r.by || null, txt: r.txt || (r.x ? examText(k, r.x) : null), x: r.x || null, sim: !!r.sim || r.src === 'demo', l: typeof r.l === 'number' && r.sc !== SCALE && r.l === 2 ? CRI : r.l };
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
    if (MDEF[k] && MDEF[k].stat) return val.x ? examLevel(k, val.x) : typeof val.l === 'number' ? val.l : 0;
    if (!th) return 0;
    var v = val.v;
    switch (k) {
      case 'hr': // a wearable irregular-rhythm flag is screening only (ATTENTION); AF needs an ECG review (CAUTION)
        if (val.irr) return Math.max(ATT, hrLevel(v, val, th));
        var hl = hrLevel(v, val, th); if (hl) return hl;
        if (th.b && !val.sl && !val.ex && v > th.b * 1.15 && !CONTINUOUS[val.src]) return ATT; return 0; // resting measurement > 15 % above own baseline
      case 'spo2': if (v <= th.x) return CRI; if (v < th.c) return ATT; return 0;
      case 'rr': if (val.ex) return v >= 40 ? CRI : v >= 30 ? ATT : 0; var sr = val.sl ? 2 : 0; if (v <= th.xLo - sr || v >= th.xHi) return CRI; if (v <= th.cLo - sr || v >= th.cHi) return ATT; return 0;
      case 'temp': if (v >= th.xHi || v <= th.xLo) return CRI; if (v >= th.cHi || v <= th.cLo) return ATT; if (th.b && v >= th.b + 0.8) return ATT; return 0;
      case 'bp': if (val.ex) return v >= 230 || val.v2 >= 120 ? CRI : v >= 210 ? ATT : 0; // during exercise blood pressure rises normally
        if (v >= th.sX || v < th.sXL || val.v2 >= th.dX) return CRI; if (v >= th.sC || v < th.sCL || val.v2 >= th.dC) return ATT; return 0;
      case 'glu': if (v < th.xLo || v > th.xHi) return CRI; if (v < th.cLo || v > th.cHi) return ATT; return 0;
      case 'sleep': if (v < th.x && val.prev != null && val.prev < th.x) return CRI; if (v < th.c) return ATT; return 0;
      case 'mood': if (v <= th.x) return CRI; if (v <= th.c) return ATT; return 0;
      case 'ex': if (v < th.x) return CRI; if (v < th.c) return ATT; return 0;
      case 'dose': if (v >= th.x) return CRI; if (v >= th.c) return ATT; return 0;
      case 'fluid': return v < th.c ? ATT : 0;
      default: return 0;
    }
  }
  function hrLevel(v, val, th) { var sl = val.sl ? 10 : 0; if (val.ex) return v > 185 ? CRI : v > 170 ? ATT : 0; if (v < th.xLo - sl + 2 * (sl > 0) || v > th.xHi) return CRI; if (v < th.cLo - sl || v > th.cHi) return ATT; return 0; }
  function rank(l) { return l === CRI ? 4 : l === CAU ? 3 : l === ATT ? 2 : l === -1 ? 1 : 0; }

  /* Status of one person at time t. Overall: worst metric; if nothing is abnormal but the wearable is silent, NO DATA. */
  function personStatus(series, th, t) {
    var out = { m: {}, lvl: 0, top: null };
    MKEYS.forEach(function (k) { if (MDEF[k].cond) return; var v = valueAt(series, k, t); out.m[k] = { val: v, l: levelOf(k, v, th[k]) }; });
    conditions(out, th, t);
    var best = null;
    LKEYS.forEach(function (k) { var l = out.m[k].l; if (l > 0 && (!best || rank(l) > rank(out.m[best].l))) best = k; });
    if (best) { out.lvl = out.m[best].l; out.top = best; }
    else if (out.m.hr.l === -1 && !hasAnyCurrent(out)) { out.lvl = -1; out.top = 'hr'; }
    else if (out.m.hr.l === -1 && wearableSilent(series, t)) { out.lvl = -1; out.top = 'hr'; }
    return out;
  }
  /*
   * Condition-level alerts (medic team: CHARM_Exact_Alert_Thresholds.pdf). Related signals are combined into one alert.
   * Each condition: { l, txt (what was found), why: [signals], next (recommended next step), rule id }.
   */
  function cond(l, txt, why, next, rule) { return { val: l > 0 || why.length ? { v: null, txt: txt, why: why, next: next, rule: rule, t: null } : null, l: l }; }
  function conditions(st, th, t) {
    var m = st.m, x = function (k) { return m[k] && m[k].val && m[k].val.x; }, v = function (k) { return m[k] && m[k].val ? m[k].val.v : null; };
    // 1. Infection / systemic deterioration: SIRS (orange) and qSOFA (red) need a suspected infection
    var sy = x('sym') || {}, b = x('blood') || {}, I = th.inf || COMMON.inf, crit = [];
    var tp = v('temp'), hr = v('hr'), rr = v('rr'), sb = v('bp');
    if (tp != null && (tp > I.tHi || tp < I.tLo)) crit.push('temperature ' + tp + ' °C');
    if (hr != null && hr > I.hr && !(m.hr.val && m.hr.val.ex)) crit.push('heart rate ' + Math.round(hr));
    if (rr != null && rr > I.rr) crit.push('breathing ' + Math.round(rr) + '/min');
    if (b.wbc != null && (b.wbc > 12 || b.wbc < 4)) crit.push('WBC ' + b.wbc);
    var q = []; if (rr != null && rr >= 22) q.push('breathing ≥22'); if (sb != null && sb <= 100) q.push('systolic ≤100'); if (sy.conf) q.push('confusion');
    if (sy.inf && q.length >= 2) m.c_inf = cond(CRI, 'qSOFA ' + q.length + '/3 with suspected infection', q, 'Urgent medical review and increased monitoring.', 'INF-QSOFA');
    else if (sy.inf && crit.length >= 2) m.c_inf = cond(CAU, 'SIRS ' + crit.length + '/4 with suspected infection', crit, 'Medical assessment; find the source; repeat key measurements.', 'INF-SIRS');
    else m.c_inf = cond(0, crit.length ? crit.length + '/4 infection-screen signals' : 'No infection pattern', crit, 'Combine temperature, heart rate, breathing and WBC; log symptoms if infection is suspected.', 'INF-SCREEN');
    // 2. Atrial fibrillation: ECG review decides; resting HR > 100 alone is ATTENTION on the heart-rate metric
    var e = x('ecg'), el = e ? examLevel('ecg', e) : 0, unst = e && el >= CAU && (sy.faint || sy.chest || sy.conf || (sb != null && sb < 90));
    m.c_af = el ? cond(unst ? CRI : el, el >= CAU ? 'ECG meets the clinical AF criterion' + (unst ? ' with instability' : '') : 'Irregular rhythm on ECG', [examText('ecg', e)],
      el >= CAU ? (unst ? 'Urgent medical assessment per mission medical protocol.' : 'Medical review; assess rhythm, blood pressure and symptoms.') : 'Repeat the ECG for at least 30 seconds and check for P waves.', unst ? 'AF-UNSTABLE' : el >= CAU ? 'AF-ECG' : 'AF-IRREG') : cond(0, 'No ECG finding', [], '', 'AF');
    // 3. Orthostatic hypotension: lying/sitting vs standing within 3 minutes; fainting = red
    var o = x('ortho'), ol = o ? examLevel('ortho', o) : 0; if (sy.faint && ol >= CAU) ol = CRI;
    m.c_orth = ol ? cond(ol, ol === CRI ? 'Fainting with postural blood-pressure drop' : 'Orthostatic blood-pressure drop', [examText('ortho', o)],
      ol === CRI ? 'Urgent medical assessment.' : 'Sit or lie down; repeat BP and HR; review fluids; medical review if it persists.', ol === CRI ? 'ORTH-SYNCOPE' : 'ORTH-DROP') : cond(0, 'No orthostatic finding', [], '', 'ORTH');
    // 4. Kidney stone risk: hydration (yellow) vs urinary / ultrasound findings
    var u = x('urine'), ul = u ? examLevel('urine', u) : 0, fl = v('fluid'), why4 = [];
    if (u) why4.push(examText('urine', u)); if (fl != null && fl < 2.5) { why4.push('fluid intake ' + fl + ' L/day'); if (ul < ATT) ul = ATT; }
    m.c_kid = ul ? cond(ul, ul === CRI ? 'Kidney stone or obstruction on ultrasound' : ul === CAU ? 'Blood in urine' : 'Below the 2.5 L/day hydration target', why4,
      ul === CRI ? 'Medical review and renal-stone protocol.' : ul === CAU ? 'Urinalysis and kidney assessment; consider kidney ultrasound.' : 'Increase fluids if medically appropriate; repeat the 24-hour urine check.', ul === CRI ? 'KID-US' : ul === CAU ? 'KID-BLOOD' : 'KID-HYDRATION') : cond(0, 'No kidney finding', why4, '', 'KID');
    // 5. SANS: NASA thresholds
    var vi = x('vision'), vl = vi ? examLevel('vision', vi) : (m.vision.l > 0 ? m.vision.l : 0);
    m.c_sans = vl ? cond(vl, vl === CRI ? 'Clinically concerning SANS finding' : 'Earliest NASA SANS indication', [vi ? examText('vision', vi) : (m.vision.val && m.vision.val.txt) || 'Eye exam result'],
      vl === CRI ? 'Ophthalmic medical review; follow the mission SANS protocol.' : 'Repeat OCT and eye exam; trend against baseline.', vl === CRI ? 'SANS-CONCERN' : 'SANS-EARLY') : cond(0, 'No SANS finding', [], '', 'SANS');
    // 6. Venous thrombosis (neck vein)
    var j = x('ijv'), jl = j ? examLevel('ijv', j) : 0;
    m.c_vte = jl ? cond(jl, jl === CRI ? 'Venous thrombus seen' : 'Neck-vein stasis or retrograde flow', [examText('ijv', j)],
      jl === CRI ? 'Immediate medical review and VTE protocol.' : 'Repeat the Doppler ultrasound; compare with the prior scan; request medical review.', jl === CRI ? 'VTE-THROMBUS' : 'VTE-FLOW') : cond(0, 'No neck-vein finding', [], '', 'VTE');
  }
  function hasAnyCurrent(st) { return LKEYS.some(function (k) { return !MDEF[k].cond && st.m[k].l >= 0; }); }
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
  var WORD = { '3': 'CRITICAL', '2': 'CAUTION', '1': 'ATTENTION', '0': 'NORMAL', '-1': 'NO DATA' };

  /*
   * Alert transitions with hysteresis.
   * Raise: as soon as a metric gets worse. Clear: only after 3 checks in a row (15 min on the 5-minute tick) back in range,
   * so alerts don't flicker. mode = 'reading' (new data arrived: raises only) or 'tick' (scheduled: raises and clears).
   * state = { levels: {k: l}, low: {k: n}, hrSilent: bool }. Returns { events, state, changed }.
   */
  function transitions(pid, series, th, t, state, mode) {
    var st = personStatus(series, th, t), prev = state && state.sc === SCALE ? state : {}, levels = Object.assign({}, prev.levels || {}), low = Object.assign({}, prev.low || {}), ev = [], changed = false;
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
        ev.push({ t: v && v.t ? Math.max(v.t, t - 10 * MIN) : t, pid: pid, k: k, lv: l, sim: !!(v && v.sim), type: 'raise', text: MDEF[k].label + ' ' + WORD[String(l)], sub: MDEF[k].cond ? (v.txt + (v.why && v.why.length ? ': ' + v.why.join(', ') : '') + ' · ' + v.next) : (k === 'hr' && v && v.irr ? 'Irregular rhythm detected · ' : '') + fmtV(k, v) + (MDEF[k].unit ? ' ' + MDEF[k].unit : '') });
        levels[k] = l; low[k] = 0; changed = true;
      } else if (l < cur) {
        if (mode === 'tick') {
          low[k] = (low[k] || 0) + 1;
          if (low[k] >= 3) { ev.push({ t: t, pid: pid, k: k, lv: l, type: 'clear', text: MDEF[k].label + (l === 0 ? ' back to NORMAL' : ' down to ' + WORD[String(l)]), sub: MDEF[k].cond ? (st.m[k].val ? st.m[k].val.txt : '') : fmtV(k, st.m[k].val) + (MDEF[k].unit ? ' ' + MDEF[k].unit : '') }); levels[k] = l; low[k] = 0; }
          changed = true;
        }
      } else if (low[k]) { low[k] = 0; changed = true; }
    });
    return { events: ev, state: { sc: SCALE, levels: levels, low: low, hrSilent: silent, lvl: st.lvl, top: st.top, t: t }, changed: changed || st.lvl !== prev.lvl, status: st };
  }

  /* Cabin environment at time t from env readings { co2: [...], pfu: [...], ctemp: [...] }. */
  function envAt(envSeries, t) {
    var c = lastReading(envSeries, 'co2', t), p = lastReading(envSeries, 'pfu', t), ct = lastReading(envSeries, 'ctemp', t);
    var out = { co2: null, co2avg: null, co2l: -1, pfu: null, pfl: -1, temp: null, tl: -1 };
    if (c && t - c.t <= 2 * H) {
      var a = envSeries.co2, s = 0, n = 0; for (var i = lastIdx(a, t); i >= 0 && t - a[i].t <= H; i--) { s += a[i].v; n++; }
      out.co2 = c.v; out.co2avg = n ? s / n : c.v; out.co2l = c.v >= 4.5 ? CRI : out.co2avg >= 3.0 ? ATT : 0; out.co2t = c.t;
    }
    if (p && t - p.t <= 2 * H) { out.pfu = p.v; out.pfl = p.v >= 100 ? CRI : p.v >= 10 ? ATT : 0; out.pfut = p.t; out.pfsrc = p.src; }
    if (ct && t - ct.t <= 6 * H) { out.temp = ct.v; out.tl = ct.v < 18 || ct.v > 27 ? ATT : 0; out.tempt = ct.t; }
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
    freshFor: freshFor, profile: profile, examLevel: examLevel, examText: examText, validateExam: validateExam, EXAMF: EXAMF, EXAMK: EXAMK, CONDK: CONDK, ATT: ATT, CAU: CAU, CRI: CRI, SCALE: SCALE, personalOffsets: personalOffsets, CREW_AVG: CREW_AVG, checkProfile: checkProfile, validateReading: validateReading, validateEnv: validateEnv,
    sortSeries: sortSeries, lastIdx: lastIdx, lastReading: lastReading, valueAt: valueAt, levelOf: levelOf, rank: rank,
    personStatus: personStatus, wearableSilent: wearableSilent, fmtV: fmtV, WORD: WORD, transitions: transitions,
    envAt: envAt, envTransitions: envTransitions, missionDay: missionDay, shipGeom: shipGeom, oneWay: oneWay, clone: clone
  };
});
