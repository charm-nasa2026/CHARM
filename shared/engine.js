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
    wt: { label: 'Body mass', short: 'Mass', unit: 'kg', dec: 1 },
    ecg: { label: 'ECG rhythm review', short: 'ECG', unit: '', dec: 0, stat: true },
    ortho: { label: 'Orthostatic BP test', short: 'Orthostatic', unit: '', dec: 0, stat: true },
    urine: { label: 'Urine and kidney check', short: 'Kidney', unit: '', dec: 0, stat: true },
    ijv: { label: 'Neck vein ultrasound (IJV)', short: 'Neck vein', unit: '', dec: 0, stat: true },
    sym: { label: 'Symptom check', short: 'Symptoms', unit: '', dec: 0, stat: true },
    bone: { label: 'Bone turnover markers', short: 'Bone', unit: '', dec: 0, stat: true },
    /* condition-level alerts (CHARM_Exact_Alert_Thresholds, medic team). Computed from several signals; not entered directly. */
    c_inf: { label: 'Infection / systemic deterioration', short: 'Infection', unit: '', dec: 0, cond: true, hidden: true },
    c_af: { label: 'Atrial fibrillation / arrhythmia', short: 'Arrhythmia', unit: '', dec: 0, cond: true, hidden: true },
    c_orth: { label: 'Orthostatic hypotension', short: 'Orthostatic', unit: '', dec: 0, cond: true, hidden: true },
    c_kid: { label: 'Kidney stone risk', short: 'Kidney', unit: '', dec: 0, cond: true, hidden: true },
    c_sans: { label: 'SANS (eyes and optic disc)', short: 'SANS', unit: '', dec: 0, cond: true, hidden: true },
    c_vte: { label: 'Venous thrombosis (neck vein)', short: 'VTE', unit: '', dec: 0, cond: true, hidden: true },
    c_anem: { label: 'Fluid loss and space anemia', short: 'Anemia', unit: '', dec: 0, cond: true, hidden: true },
    c_resp: { label: 'Breathing / airway reaction', short: 'Airway', unit: '', dec: 0, cond: true, hidden: true },
    c_bleed: { label: 'Bleeding (injury)', short: 'Bleeding', unit: '', dec: 0, cond: true, hidden: true },
    c_vol: { label: 'Circulation strain (shock index)', short: 'Shock index', unit: '', dec: 0, cond: true, hidden: true },
    rt: { label: 'Reaction time', short: 'Reaction', unit: 'ms', dec: 0, hidden: true }
  };
  var EXAMK = ['ecg', 'ortho', 'urine', 'ijv', 'sym'];
  var CONDK = ['c_inf', 'c_af', 'c_orth', 'c_kid', 'c_sans', 'c_vte', 'c_anem', 'c_vol', 'c_bleed', 'c_resp'];
  var MKEYS = ['hr', 'bp', 'spo2', 'rr', 'temp', 'glu', 'sleep', 'mood', 'ex', 'dose', 'fluid', 'wt', 'vision', 'blood', 'bone'].concat(EXAMK).concat(CONDK);
  var LKEYS = ['c_bleed', 'c_af', 'c_resp', 'c_vol'].concat(CONDK.filter(function (k) { return ['c_vol', 'c_bleed', 'c_af', 'c_resp'].indexOf(k) < 0; })).concat(['hr', 'bp', 'spo2', 'rr', 'temp', 'glu', 'sleep', 'mood', 'ex', 'dose', 'wt', 'bone']); // what raises alerts; the first of equal levels is the headline, so a condition that explains the numbers comes first // what raises alerts (the first of equal levels is the headline: shock index before the infection screen)
  var RKEYS = MKEYS.filter(function (k) { return CONDK.indexOf(k) < 0; }).concat(['rt']); // every metric a reading can carry
  /* Alert levels. -1 NO DATA · 0 NORMAL (green) · 1 ATTENTION (yellow: one screening limit crossed)
     · 2 CAUTION (orange: medical criterion or multi-signal pattern) · 3 CRITICAL (red: urgent). */
  var ATT = 1, CAU = 2, CRI = 3, SCALE = 4;
  var ENVKEYS = { co2: { label: 'Cabin CO₂', unit: 'mmHg' }, pfu: { label: 'Space weather (protons ≥10 MeV)', unit: 'pfu' }, ctemp: { label: 'Cabin temperature', unit: '°C' } };

  /* CHARM common thresholds (demo values, need medical review). */
  var COMMON = {
    hr: { cLo: 50, cHi: 100, xLo: 40, xHi: 130 },
    spo2: { c: 96, u: 94, x: 91 }, // NEWS2: ATTENTION 94-95, CAUTION 92-93, CRITICAL at or below 91
    rr: { cLo: 11, cHi: 21, xLo: 8, xHi: 25 },
    temp: { cLo: 35.9, cHi: 38.1, xLo: 35.0, xHi: 39.0 }, // ATTENTION < 36.0 or > 38.0 (SIRS)
    bp: { sC: 140, sCL: 90, dC: 90, sX: 180, sXL: 80, dX: 120 },
    glu: { cLo: 70, cHi: 180, xLo: 54, xHi: 250 },
    sleep: { c: 6, x: 5 },
    mood: { c: 4, x: 3 },
    ex: { c: 75, x: 50 },
    dose: { c: 50, x: 80 },
    fluid: { c: 2.5 },
    blood: { hbLo: 12 }, // WHO anemia limit (women 12, men 13 g/dL; men set from the model data)
    /* body mass: % lost vs the highest 3-reading median in the window. ATTENTION > 2 % in 14 days, CAUTION > 5 % in 30 days
       (GLIM malnutrition criterion), CRITICAL > 10 % in 30 days. Needs at least 4 readings in 30 days. */
    wt: { a: 2, c: 5, x: 10 },
    /* infection screen (SIRS, orange). Personal offsets move these like the ATTENTION limits. qSOFA (red) is fixed. */
    inf: { tHi: 38.0, tLo: 36.0, hr: 90, rr: 20 }
  };
  /* Editable threshold fields (used by Settings and validated by the server). */
  var THF = {
    hr: [['cLo', 'Attention below'], ['cHi', 'Attention above'], ['xLo', 'Critical below'], ['xHi', 'Critical above']],
    spo2: [['c', 'Attention below'], ['u', 'Caution below'], ['x', 'Critical at or below']],
    rr: [['cLo', 'Attention at or below'], ['cHi', 'Attention at or above'], ['xLo', 'Critical at or below'], ['xHi', 'Critical at or above']],
    temp: [['cLo', 'Attention at or below'], ['cHi', 'Attention at or above'], ['xLo', 'Critical at or below'], ['xHi', 'Critical at or above']],
    sleep: [['c', 'Attention below (h)'], ['x', 'Critical below, 2 nights']],
    dose: [['c', 'Attention at (%)'], ['x', 'Critical at (%)']]
  };
  /* Plausible ranges. Values outside are rejected (sensor slip) and never raise an alert. */
  var PLAUS = { hr: [25, 230], spo2: [70, 100], rr: [4, 60], temp: [33, 42.5], bp: [60, 250], bp2: [30, 160], glu: [30, 500], sleep: [0, 16], mood: [0, 10], ex: [0, 200], dose: [0, 200], fluid: [0, 15], wt: [30, 200], rt: [100, 3000], co2: [0, 30], pfu: [0, 1e7], ctemp: [5, 40] };

  /* How long a reading counts as current. Continuous sensors go stale fast; hand-entered values last longer.
     Stale data is never shown as green: it becomes NO DATA. */
  var FRESH = {
    hr: [15 * MIN, 6 * H], spo2: [15 * MIN, 6 * H], rr: [15 * MIN, 6 * H], temp: [30 * MIN, 8 * H], glu: [60 * MIN, 12 * H],
    bp: [40 * H, 40 * H], sleep: [36 * H, 36 * H], mood: [36 * H, 36 * H], ex: [48 * H, 48 * H], dose: [24 * H, 7 * D],
    vision: [30 * D, 30 * D], blood: [21 * D, 21 * D], bone: [120 * D, 120 * D], rt: [72 * H, 72 * H], fluid: [36 * H, 36 * H], wt: [8 * D, 8 * D],
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
  /* Personal bands from the team's alert model (charm_model). Generated by tools/build_model_profiles.py: do not edit by hand.
     crew[pid].b[metric].rows = [[mission day, expected, low, high], ...] = the model's Caution band at rest (personal baseline
     + Earth->Space shift for that day). Day 0 = on Earth. Used only to ADD an ATTENTION; CHARM common and CRITICAL limits stay. */
  /* BEGIN MODEL */ var MODEL = {"version":"charm-baseline-2.0","z":2.5,"crew":{"sarah":{"src":"C3_C3C_7352","b":{"hr":{"n":16,"rows":[[0,75.7,54.0,97.5],[1,75.8,54.1,97.5],[2,75.9,54.2,97.6],[4,76.0,54.3,97.8],[7,76.3,54.4,98.1],[14,76.7,54.5,99.0],[21,77.2,54.5,99.9],[30,77.6,54.2,101.1],[45,78.3,53.5,103.1],[60,78.8,52.8,104.8],[90,79.5,51.6,107.4],[120,79.9,50.8,109.1],[150,80.2,50.2,110.2],[180,80.4,49.9,110.8],[240,80.5,49.5,111.5],[365,80.6,49.3,111.8]]},"sbp":{"n":16,"rows":[[0,104.5,89.1,119.8],[1,104.4,87.3,121.5],[2,104.3,85.8,122.9],[4,104.3,85.0,123.7],[7,104.3,85.0,123.8],[14,104.3,85.0,123.8],[21,104.3,85.0,123.8],[30,104.3,85.0,123.8],[45,104.3,85.0,123.8],[60,104.3,85.0,123.8],[90,104.3,85.0,123.8],[120,104.3,85.0,123.8],[150,104.3,85.0,123.8],[180,104.3,85.0,123.8],[240,104.3,85.0,123.8],[365,104.3,85.0,123.8]]},"dbp":{"n":16,"rows":[[0,57.0,34.1,79.8],[1,57.0,34.2,79.9],[2,57.1,34.2,79.9],[4,57.2,34.3,80.1],[7,57.3,34.3,80.3],[14,57.6,34.2,81.0],[21,57.9,33.9,81.9],[30,58.2,33.3,83.1],[45,58.6,32.2,85.0],[60,58.9,31.1,86.8],[90,59.4,29.3,89.4],[120,59.6,28.1,91.2],[150,59.8,27.3,92.3],[180,59.9,26.8,93.0],[240,60.0,26.4,93.6],[365,60.1,26.1,94.0]]},"rr":{"n":16,"rows":[[0,16.2,13.6,18.8],[1,16.2,13.3,19.1],[2,16.2,13.0,19.3],[4,16.2,12.9,19.5],[7,16.2,12.9,19.5],[14,16.2,12.9,19.5],[21,16.2,12.9,19.5],[30,16.2,12.9,19.5],[45,16.2,12.9,19.5],[60,16.2,12.9,19.5],[90,16.2,12.9,19.5],[120,16.2,12.9,19.5],[150,16.2,12.9,19.5],[180,16.2,12.9,19.5],[240,16.2,12.9,19.5],[365,16.2,12.9,19.5]]},"temp":{"n":16,"rows":[[0,36.7,35.9,37.4],[1,36.7,35.9,37.5],[2,36.7,36.0,37.5],[4,36.7,36.0,37.5],[7,36.8,36.0,37.6],[14,36.9,36.1,37.7],[21,36.9,36.1,37.8],[30,37.0,36.1,37.9],[45,37.1,36.1,38.0],[60,37.1,36.1,38.1],[90,37.2,36.1,38.2],[120,37.2,36.1,38.2],[150,37.2,36.1,38.2],[180,37.2,36.1,38.2],[240,37.2,36.1,38.2],[365,37.2,36.1,38.2]]}},"sex":"female"},"maya":{"src":"C3_C3C_7772","b":{"hr":{"n":16,"rows":[[0,75.2,53.6,96.8],[1,75.3,53.7,96.8],[2,75.4,53.8,96.9],[4,75.5,53.9,97.1],[7,75.7,54.0,97.4],[14,76.2,54.1,98.3],[21,76.6,54.1,99.2],[30,77.1,53.8,100.4],[45,77.8,53.1,102.4],[60,78.3,52.4,104.1],[90,79.0,51.2,106.7],[120,79.4,50.4,108.5],[150,79.7,49.8,109.5],[180,79.8,49.4,110.2],[240,80.0,49.1,110.8],[365,80.1,48.9,111.2]]},"sbp":{"n":16,"rows":[[0,111.5,92.3,130.6],[1,111.4,90.8,132.0],[2,111.3,89.5,133.1],[4,111.3,88.8,133.8],[7,111.3,88.7,134.0],[14,111.3,88.7,134.0],[21,111.3,88.7,134.0],[30,111.3,88.7,134.0],[45,111.3,88.7,134.0],[60,111.3,88.7,134.0],[90,111.3,88.7,134.0],[120,111.3,88.7,134.0],[150,111.3,88.7,134.0],[180,111.3,88.7,134.0],[240,111.3,88.7,134.0],[365,111.3,88.7,134.0]]},"dbp":{"n":16,"rows":[[0,72.1,54.4,89.7],[1,72.1,54.5,89.8],[2,72.2,54.5,89.8],[4,72.3,54.5,90.0],[7,72.4,54.5,90.3],[14,72.7,54.3,91.1],[21,73.0,53.8,92.1],[30,73.3,53.1,93.5],[45,73.7,51.6,95.8],[60,74.0,50.3,97.8],[90,74.5,48.1,100.8],[120,74.7,46.7,102.8],[150,74.9,45.8,104.0],[180,75.0,45.3,104.7],[240,75.1,44.8,105.5],[365,75.2,44.5,105.8]]},"rr":{"n":16,"rows":[[0,16.3,13.5,19.0],[1,16.3,13.3,19.3],[2,16.3,13.1,19.5],[4,16.3,12.9,19.7],[7,16.3,12.9,19.7],[14,16.3,12.9,19.7],[21,16.3,12.9,19.7],[30,16.3,12.9,19.7],[45,16.3,12.9,19.7],[60,16.3,12.9,19.7],[90,16.3,12.9,19.7],[120,16.3,12.9,19.7],[150,16.3,12.9,19.7],[180,16.3,12.9,19.7],[240,16.3,12.9,19.7],[365,16.3,12.9,19.7]]},"temp":{"n":16,"rows":[[0,36.9,36.3,37.5],[1,36.9,36.4,37.5],[2,36.9,36.4,37.5],[4,37.0,36.4,37.5],[7,37.0,36.4,37.6],[14,37.1,36.5,37.7],[21,37.1,36.5,37.8],[30,37.2,36.5,37.9],[45,37.3,36.5,38.1],[60,37.3,36.5,38.2],[90,37.4,36.5,38.3],[120,37.4,36.5,38.3],[150,37.4,36.5,38.3],[180,37.4,36.5,38.3],[240,37.4,36.5,38.3],[365,37.4,36.5,38.3]]}},"sex":"female"},"david":{"src":"C3_C3E_6043","b":{"hr":{"n":14,"rows":[[0,61.0,45.2,76.9],[1,61.1,45.2,77.0],[2,61.2,45.3,77.1],[4,61.3,45.4,77.3],[7,61.6,45.5,77.6],[14,62.0,45.5,78.6],[21,62.5,45.3,79.7],[30,62.9,44.8,81.1],[45,63.6,43.8,83.4],[60,64.1,42.8,85.4],[90,64.8,41.2,88.4],[120,65.2,41.0,90.3],[150,65.5,41.0,91.5],[180,65.7,41.0,92.3],[240,65.8,41.0,93.0],[365,65.9,41.0,93.4]]},"sbp":{"n":14,"rows":[[0,123.1,103.5,142.8],[1,123.0,102.0,144.1],[2,123.0,100.8,145.3],[4,123.0,100.1,146.0],[7,123.0,99.9,146.1],[14,123.0,99.9,146.1],[21,123.0,99.9,146.1],[30,123.0,99.9,146.1],[45,123.0,99.9,146.1],[60,123.0,99.9,146.1],[90,123.0,99.9,146.1],[120,123.0,99.9,146.1],[150,123.0,99.9,146.1],[180,123.0,99.9,146.1],[240,123.0,99.9,146.1],[365,123.0,99.9,146.1]]},"dbp":{"n":14,"rows":[[0,72.5,56.6,88.5],[1,72.6,56.7,88.5],[2,72.6,56.7,88.6],[4,72.7,56.7,88.7],[7,72.9,56.7,89.0],[14,73.2,56.4,89.9],[21,73.5,55.9,91.0],[30,73.8,55.0,92.5],[45,74.2,53.5,94.9],[60,74.5,52.0,97.0],[90,74.9,49.7,100.1],[120,75.2,48.3,102.2],[150,75.4,47.3,103.4],[180,75.5,46.8,104.2],[240,75.6,46.2,105.0],[365,75.6,45.9,105.3]]},"rr":{"n":14,"rows":[[0,17.9,15.0,20.8],[1,17.9,14.7,21.1],[2,17.9,14.5,21.3],[4,17.9,14.4,21.5],[7,17.9,14.4,21.5],[14,17.9,14.4,21.5],[21,17.9,14.4,21.5],[30,17.9,14.4,21.5],[45,17.9,14.4,21.5],[60,17.9,14.4,21.5],[90,17.9,14.4,21.5],[120,17.9,14.4,21.5],[150,17.9,14.4,21.5],[180,17.9,14.4,21.5],[240,17.9,14.4,21.5],[365,17.9,14.4,21.5]]},"temp":{"n":14,"rows":[[0,36.3,35.5,37.1],[1,36.3,35.5,37.1],[2,36.3,35.6,37.1],[4,36.4,35.6,37.2],[7,36.4,35.6,37.2],[14,36.5,35.7,37.3],[21,36.6,35.7,37.4],[30,36.6,35.7,37.6],[45,36.7,35.7,37.7],[60,36.7,35.7,37.8],[90,36.8,35.7,37.9],[120,36.8,35.7,37.9],[150,36.8,35.7,37.9],[180,36.8,35.7,37.9],[240,36.8,35.7,37.9],[365,36.8,35.7,37.9]]}},"sex":"male"},"elena":{"src":"C3_C3D_8615","b":{"hr":{"n":13,"rows":[[0,97.1,79.6,114.6],[1,97.2,79.7,114.7],[2,97.3,79.8,114.8],[4,97.4,79.9,115.0],[7,97.7,80.0,115.3],[14,98.1,80.0,116.3],[21,98.6,79.8,117.3],[30,99.0,79.4,118.6],[45,99.7,78.5,120.8],[60,100.2,77.6,122.8],[90,100.9,76.2,125.6],[120,101.3,75.2,127.5],[150,101.6,74.5,128.7],[180,101.7,74.1,129.4],[240,101.9,73.7,130.0],[365,102.0,73.5,130.0]]},"sbp":{"n":13,"rows":[[0,105.6,92.0,119.3],[1,105.6,89.9,121.2],[2,105.5,88.3,122.7],[4,105.5,87.4,123.6],[7,105.5,87.3,123.8],[14,105.5,87.3,123.8],[21,105.5,87.3,123.8],[30,105.5,87.3,123.8],[45,105.5,87.3,123.8],[60,105.5,87.3,123.8],[90,105.5,87.3,123.8],[120,105.5,87.3,123.8],[150,105.5,87.3,123.8],[180,105.5,87.3,123.8],[240,105.5,87.3,123.8],[365,105.5,87.3,123.8]]},"dbp":{"n":13,"rows":[[0,70.9,51.1,90.7],[1,71.0,51.2,90.7],[2,71.0,51.2,90.8],[4,71.1,51.3,91.0],[7,71.3,51.3,91.2],[14,71.6,51.1,92.0],[21,71.8,50.7,93.0],[30,72.1,50.0,94.2],[45,72.6,48.7,96.4],[60,72.9,47.5,98.2],[90,73.3,45.5,101.1],[120,73.6,44.2,103.0],[150,73.8,43.4,104.2],[180,73.9,42.8,104.9],[240,74.0,42.3,105.6],[365,74.0,42.1,106.0]]},"rr":{"n":13,"rows":[[0,17.0,12.9,21.1],[1,17.0,12.8,21.3],[2,17.1,12.6,21.5],[4,17.1,12.5,21.6],[7,17.1,12.5,21.6],[14,17.1,12.5,21.6],[21,17.1,12.5,21.6],[30,17.1,12.5,21.6],[45,17.1,12.5,21.6],[60,17.1,12.5,21.6],[90,17.1,12.5,21.6],[120,17.1,12.5,21.6],[150,17.1,12.5,21.6],[180,17.1,12.5,21.6],[240,17.1,12.5,21.6],[365,17.1,12.5,21.6]]},"temp":{"n":13,"rows":[[0,36.9,36.2,37.5],[1,36.9,36.2,37.5],[2,36.9,36.3,37.5],[4,36.9,36.3,37.6],[7,37.0,36.3,37.6],[14,37.0,36.4,37.7],[21,37.1,36.4,37.9],[30,37.2,36.4,38.0],[45,37.3,36.4,38.1],[60,37.3,36.4,38.2],[90,37.3,36.4,38.3],[120,37.4,36.4,38.3],[150,37.4,36.4,38.3],[180,37.4,36.4,38.3],[240,37.4,36.4,38.3],[365,37.4,36.4,38.3]]}},"sex":"female"},"john":{"src":"SIM_CSA-Astro-01","b":{"hr":{"n":12,"rows":[[0,73.7,46.3,101.2],[1,73.6,46.1,101.0],[2,73.7,46.2,101.1],[4,73.8,46.4,101.3],[7,74.1,46.5,101.6],[14,74.5,46.7,102.4],[21,75.0,46.7,103.2],[30,75.4,46.6,104.3],[45,76.1,46.2,106.0],[60,76.6,45.7,107.5],[90,77.3,44.8,109.8],[120,77.7,44.1,111.4],[150,78.0,43.6,112.3],[180,78.1,43.4,112.9],[240,78.3,43.1,113.5],[365,78.4,42.9,113.8]]},"sbp":{"n":12,"rows":[[0,116.9,102.2,131.5],[1,116.9,102.2,131.6],[2,116.9,102.2,131.6],[4,116.9,101.7,132.1],[7,116.9,101.5,132.2],[14,116.9,101.5,132.2],[21,116.9,101.5,132.2],[30,116.9,101.5,132.2],[45,116.9,101.5,132.2],[60,116.9,101.5,132.2],[90,116.9,101.5,132.2],[120,116.9,101.5,132.2],[150,116.9,101.5,132.2],[180,116.9,101.5,132.2],[240,116.9,101.5,132.2],[365,116.9,101.5,132.2]]},"dbp":{"n":12,"rows":[[0,73.5,58.9,88.1],[1,73.4,58.8,88.1],[2,73.5,58.9,88.1],[4,73.6,58.9,88.3],[7,73.7,58.9,88.6],[14,74.0,58.6,89.5],[21,74.3,58.0,90.7],[30,74.6,57.0,92.2],[45,75.0,55.3,94.7],[60,75.4,53.8,96.9],[90,75.8,51.4,100.2],[120,76.1,49.9,102.3],[150,76.2,48.9,103.5],[180,76.3,48.3,104.3],[240,76.4,47.8,105.1],[365,76.5,47.5,105.5]]},"rr":{"n":12,"rows":[[0,14.3,10.7,17.9],[1,14.3,10.7,17.9],[2,14.3,10.7,17.9],[4,14.3,10.6,17.9],[7,14.3,10.6,17.9],[14,14.3,10.6,17.9],[21,14.3,10.6,17.9],[30,14.3,10.6,17.9],[45,14.3,10.6,17.9],[60,14.3,10.6,17.9],[90,14.3,10.6,17.9],[120,14.3,10.6,17.9],[150,14.3,10.6,17.9],[180,14.3,10.6,17.9],[240,14.3,10.6,17.9],[365,14.3,10.6,17.9]]}}}}}; /* END MODEL */
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
    // Offsets only TIGHTEN a limit (team decision 15.11): a high-normal person still sees ATTENTION at the common limit
    // (e.g. systolic 155 is yellow even if it is usual for them). The flight surgeon can loosen a limit by hand (override).
    var up = function (o) { return Math.min(0, o.off); }, dn = function (o) { return Math.max(0, o.off); };
    var o;
    if ((o = offs.hr)) { mv('hr', 'cLo', dn(o), pr.hr.xLo + CREW_AVG.hr.gap, pr.hr.cHi - 10); mv('hr', 'cHi', up(o), pr.hr.cLo + 10, pr.hr.xHi - CREW_AVG.hr.gap); pr.hr.b = o.mean; }
    if ((o = offs.rr)) { mv('rr', 'cLo', dn(o), pr.rr.xLo + CREW_AVG.rr.gap, pr.rr.cHi - 4); mv('rr', 'cHi', up(o), pr.rr.cLo + 4, pr.rr.xHi - CREW_AVG.rr.gap); }
    if ((o = offs.temp)) { mv('temp', 'cLo', dn(o), pr.temp.xLo + CREW_AVG.temp.gap, pr.temp.cHi - 1); mv('temp', 'cHi', up(o), pr.temp.cLo + 1, pr.temp.xHi - CREW_AVG.temp.gap); pr.temp.b = o.mean; }
    if ((o = offs.sbp)) { mv('bp', 'sCL', dn(o), pr.bp.sXL + CREW_AVG.sbp.gap, pr.bp.sC - 20); mv('bp', 'sC', up(o), pr.bp.sCL + 20, pr.bp.sX - CREW_AVG.sbp.gap); }
    if ((o = offs.dbp)) { mv('bp', 'dC', up(o), 60, pr.bp.dX - CREW_AVG.dbp.gap); }
    // orange infection-screen numbers move too (user decision: personal offsets on yellow and orange; red stays fixed)
    if ((o = offs.hr)) mv('inf', 'hr', up(o), 70, pr.hr.xHi - CREW_AVG.hr.gap);
    if ((o = offs.rr)) mv('inf', 'rr', up(o), 14, 21);   // stays below the qSOFA red 22
    if ((o = offs.temp)) { mv('inf', 'tHi', up(o), 37.5, pr.temp.xHi - CREW_AVG.temp.gap); mv('inf', 'tLo', dn(o), pr.temp.xLo + CREW_AVG.temp.gap, 36.5); }
    return shift;
  }
  /* overrides: { hr: { cLo: { v: 45, by, when, why } } }. base: crew member's pre-mission baseline { hr: { mean, n, sd }, sbp, dbp, rr, temp }.
     Order: CHARM common -> personal offset (automatic) -> personal override (flight surgeon / CMO). */
  function profile(ovr, base, pid, launch) {
    var mk = pid && MODEL.crew[pid], pr = clone(COMMON), o = ovr || {}, offs = mk ? {} : personalOffsets(base); // the model replaces the crew-average offset
    var shift = applyOffsets(pr, offs);
    Object.keys(o).forEach(function (k) { if (!pr[k]) return; Object.keys(o[k] || {}).forEach(function (f) { var x = o[k][f]; if (x && typeof x.v === 'number') pr[k][f] = x.v; }); });
    if (mk && mk.sex === 'male') pr.blood = { hbLo: 13 };
    var used = {};
    if (mk) Object.keys(PM_ON).forEach(function (m) {
      var k = PM_ON[m][0];
      if (!mk.b[m] || PM_ON[m][1].some(function (f) { return o[k] && o[k][f]; })) return; // a hand-set limit (override) wins over the model
      if (!pr[k]._pm) Object.defineProperty(pr[k], '_pm', { value: { launch: typeof launch === 'number' ? launch : null, b: {} }, enumerable: false });
      pr[k]._pm.b[m] = mk.b[m].rows; used[m] = mk.b[m].n;
    });
    Object.defineProperty(pr, '_personal', { value: { offsets: offs, shift: shift, model: mk ? { src: mk.src, version: MODEL.version, used: used } : null }, enumerable: false });
    return pr;
  }
  /* metric -> [profile key, limit fields that, when set by hand, switch the model band off for that metric] */
  var PM_ON = { hr: ['hr', ['cLo', 'cHi']], sbp: ['bp', ['sC', 'sCL']], dbp: ['bp', ['dC']], rr: ['rr', ['cLo', 'cHi']], temp: ['temp', ['cLo', 'cHi']] };
  /* The model's band for mission day of time t: [expected, low, high], linear between grid days. */
  function modelBand(pm, m, t) {
    var rows = pm && pm.b[m]; if (!rows || !rows.length) return null;
    var d = pm.launch == null ? rows[rows.length - 1][0] : Math.max(0, missionDay(t, pm.launch));
    if (d <= rows[0][0]) return rows[0].slice(1);
    for (var i = 1; i < rows.length; i++) if (d <= rows[i][0]) {
      var a = rows[i - 1], b = rows[i], f = (d - a[0]) / (b[0] - a[0]);
      return [1, 2, 3].map(function (j) { return a[j] == null || b[j] == null ? null : Math.round((a[j] + f * (b[j] - a[j])) * 10) / 10; });
    }
    return rows[rows.length - 1].slice(1);
  }
  /* ATTENTION when a resting value is outside the person's model band ("unusual for you"). Never during exercise or sleep. */
  function pmLevel(th, m, v, val) {
    if (!th || !th._pm || !th._pm.b[m] || val.ex || val.sl || typeof v !== 'number') return 0;
    var b = modelBand(th._pm, m, val.t); if (!b) return 0;
    if ((b[1] != null && v < b[1]) || (b[2] != null && v > b[2])) {
      val.pm = 'unusual for this person (CHARM model: ' + (m === 'dbp' ? 'diastolic ' : m === 'sbp' ? 'systolic ' : '') + b[1] + '–' + b[2] + ' expected today)';
      return ATT;
    }
    return 0;
  }
  /* Limits must stay in order: critical below <= caution below < caution above <= critical above. */
  function checkProfile(pr) {
    var bad = [];
    ['hr', 'rr', 'temp'].forEach(function (k) { var t = pr[k]; if (!(t.xLo <= t.cLo && t.cLo < t.cHi && t.cHi <= t.xHi)) bad.push(MDEF[k].label); });
    if (!(pr.spo2.c >= pr.spo2.x) || (pr.spo2.u != null && !(pr.spo2.c >= pr.spo2.u && pr.spo2.u > pr.spo2.x))) bad.push(MDEF.spo2.label);
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
    ortho: { s1: [60, 250], d1: [30, 160], s2: [40, 250], d2: [20, 160], min: [0, 20], syncope: 'b', h1: [25, 230], h2: [25, 230] },
    urine: { vol: [0, 10], blood: 'b', us: ['none', 'stone', 'hydro'] },
    ijv: { vel: [0, 200], retro: 'b', thrombus: 'b' },
    vision: { trt: [-100, 400], frisen: [0, 5], refr: [-10, 10], folds: ['none', 'any', 'sharp'], flat: ['none', 'present', 'moderate'], self: ['none', 'same', 'worse'], stable: 'b' },
    sym: { inf: 'b', conf: 'b', faint: 'b', chest: 'b', palp: 'b', dizzy: ['none', 'mild', 'severe'], bleed: ['none', 'ongoing', 'controlled', 'active'], airway: ['none', 'irritation', 'wheeze', 'moderate', 'severe'], expo: 'b' },
    bone: { ntx: [0, 1000], oc: [0, 500], bsap: [0, 500], follow: 'b' },
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
      case 'ortho': if (x.syncope || (x.s2 && x.s2 <= 90)) return CRI; var ds = (x.s1 || 0) - (x.s2 || 0), dd = (x.d1 || 0) - (x.d2 || 0);
        if ((x.s1 && x.s2 && ds >= 20) || (x.d1 && x.d2 && dd >= 10)) return (x.min == null || x.min <= 3) ? CAU : ATT;
        return x.h1 && x.h2 && x.h2 - x.h1 >= 30 ? ATT : 0;
      case 'urine': if (x.us === 'stone' || x.us === 'hydro') return CRI; if (x.blood) return CAU; return x.vol != null && x.vol < 2.5 ? ATT : 0;
      case 'ijv': if (x.thrombus) return CRI; return (x.vel != null && x.vel < 10) || x.retro ? CAU : 0;
      case 'vision': var vc = (x.trt != null && x.trt >= 55) || (x.frisen != null && x.frisen >= 1) || x.folds === 'sharp' || x.flat === 'moderate';
        var ve = [x.trt != null && x.trt >= 20, x.refr != null && x.refr >= 0.75, x.folds === 'any' || x.folds === 'sharp', x.flat === 'present' || x.flat === 'moderate'].filter(Boolean).length;
        if (vc) return x.stable ? CAU : CRI; // scenario 3: an established finding reviewed as not rising is followed, not an emergency
        return ve >= 2 ? CAU : ve || x.self === 'worse' ? ATT : 0;
      case 'sym': if (x.bleed === 'active') return CRI; return x.inf || x.conf || x.faint || x.chest || x.palp || (x.dizzy && x.dizzy !== 'none') || x.bleed === 'controlled' || x.bleed === 'ongoing' || (x.airway && x.airway !== 'none') ? ATT : 0;
      case 'blood': var l = 0, up = function (v) { if (v > l) l = v; };
        if (x.wbc != null && (x.wbc > 12 || x.wbc < 4)) up(ATT);        // SIRS WBC criterion
        if (x.wbc != null && (x.wbc > 20 || x.wbc < 2)) up(CRI);
        if (x.hb != null) { if (x.hb < 8) up(CRI); else if (x.hb < 12) up(CAU); else if (x.hb > 18.5) up(ATT); }
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
      case 'ortho': return (x.s1 && x.d1 ? x.s1 + '/' + x.d1 : '?') + ' → ' + (x.s2 && x.d2 ? x.s2 + '/' + x.d2 : '?') + ' mmHg standing' + (x.h1 && x.h2 ? ' · HR ' + x.h1 + ' → ' + x.h2 : '') + (x.syncope ? ' · fainted' : '');
      case 'urine': if (x.vol != null) p.push(x.vol + ' L/24 h'); p.push(x.blood ? 'blood in urine' : 'no blood'); if (x.us && x.us !== 'none') p.push(x.us === 'stone' ? 'stone on ultrasound' : 'hydronephrosis'); return p.join(' · ');
      case 'ijv': if (x.vel != null) p.push(x.vel + ' cm/s'); if (x.retro) p.push('retrograde flow'); if (x.thrombus) p.push('thrombus seen'); return p.join(' · ') || 'Normal flow';
      case 'vision': if (x.trt != null) p.push('ΔTRT ' + (x.trt > 0 ? '+' : '') + x.trt + ' µm'); if (x.frisen) p.push('Frisén ' + x.frisen); if (x.refr) p.push('refraction ' + (x.refr > 0 ? '+' : '') + x.refr + ' D'); if (x.stable) p.push('reviewed: not rising'); if (x.folds && x.folds !== 'none') p.push(x.folds === 'sharp' ? 'sharp folds near macula' : 'folds'); if (x.flat && x.flat !== 'none') p.push(x.flat + ' globe flattening'); if (x.self === 'worse') p.push('self vision test worse than before flight'); else if (x.self === 'same') p.push('self vision test unchanged'); return p.join(' · ') || 'No change from baseline';
      case 'bone': if (x.ntx != null) p.push('NTX ' + x.ntx); if (x.oc != null) p.push('osteocalcin ' + x.oc); if (x.bsap != null) p.push('BSAP ' + x.bsap); if (x.follow) p.push('follow-up pending'); return p.join(' · ');
      case 'sym': if (x.inf) p.push('suspected infection'); if (x.conf) p.push('confusion'); if (x.faint) p.push('fainting'); if (x.chest) p.push('chest pain'); if (x.palp) p.push('palpitations'); if (x.dizzy === 'mild') p.push('lightheaded'); if (x.dizzy === 'severe') p.push('severe dizziness'); if (x.bleed === 'active') p.push('bleeding, not controlled'); if (x.bleed === 'controlled') p.push('bleeding controlled'); if (x.bleed === 'ongoing') p.push('bleeding, not yet controlled'); if (x.airway && x.airway !== 'none') p.push({ irritation: 'throat or eye irritation', wheeze: 'cough and wheeze', moderate: 'short of breath, speaks in phrases', severe: 'severe breathing difficulty' }[x.airway]); if (x.expo) p.push('airborne exposure reported'); return p.length ? p.join(' · ') : 'No symptoms';
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
    var out = { v: r.v, v2: r.v2, t: r.t, ref: r.ref || null, irr: !!r.irr, ex: r.ctx === 'ex', sl: r.ctx === 'sleep', imp: r.src === 'import', man: r.src === 'manual' || r.src === 'test', src: r.src, by: r.by || null, txt: r.txt || (r.x ? examText(k, r.x) : null), x: r.x || null, sim: !!r.sim || r.src === 'demo' || r.src === 'demoalert', fake: r.src === 'demoalert', l: typeof r.l === 'number' && r.sc !== SCALE && r.l === 2 ? CRI : r.l };
    if ((k === 'hr' || k === 'spo2' || k === 'rr') && CONTINUOUS[r.src]) { // median of the last 3 sensor readings, so one spike doesn't alert
      var v = [];
      for (var j = i; j >= 0 && v.length < 3 && r.t - arr[j].t <= 6 * MIN; j--) if (CONTINUOUS[arr[j].src] && (arr[j].ctx === 'ex') === (r.ctx === 'ex')) v.push(arr[j].v); // never mix exercise and rest readings
      v.sort(function (a, b) { return a - b; }); out.v = v[Math.floor(v.length / 2)];
    }
    if (k === 'sleep' && i > 0 && r.t - arr[i - 1].t <= 36 * H) out.prev = arr[i - 1].v;
    if (k === 'wt') massTrend(arr, i, out);
    if (k === 'vision' && i > 0) out.prevX = arr[i - 1].x || null;
    if (k === 'bone') { for (var bj = 0; bj <= i; bj++) if (arr[bj].x && typeof arr[bj].x.ntx === 'number') { out.ntx0 = arr[bj].x.ntx; break; } }
    if (k === 'blood') { for (var hj = 0; hj <= i; hj++) if (arr[hj].x && typeof arr[hj].x.hb === 'number') { out.hb0 = arr[hj].x.hb; out.hb0t = arr[hj].t; break; } }
    return out;
  }
  /* Body-mass trend: robust 3-reading medians, now vs the highest median in the last 14 and 30 days (% lost). */
  function massTrend(arr, i, out) {
    var t = arr[i].t, w = [];
    for (var j = i; j >= 0 && t - arr[j].t <= 30 * D; j--) w.unshift(arr[j]);
    if (w.length < 4) return;
    var med = [];
    for (var q = 2; q < w.length; q++) { var a = [w[q - 2].v, w[q - 1].v, w[q].v].sort(function (x, y) { return x - y; }); med.push({ t: w[q].t, v: a[1] }); }
    var now = med[med.length - 1].v, m14 = null, m30 = null;
    for (var z = 0; z < med.length - 1; z++) { var e = med[z]; if (m30 == null || e.v > m30) m30 = e.v; if (t - e.t <= 14 * D && (m14 == null || e.v > m14)) m14 = e.v; }
    if (m30) out.l30 = Math.round((1 - now / m30) * 1000) / 10;
    if (m14) out.l14 = Math.round((1 - now / m14) * 1000) / 10;
  }

  function levelOf(k, val, th) {
    if (!val) return -1;
    if (k === 'bone') return boneLevel(val);
    if (MDEF[k] && MDEF[k].stat) return val.x ? examLevel(k, val.x) : typeof val.l === 'number' ? val.l : 0;
    if (!th) return 0;
    var v = val.v;
    switch (k) {
      case 'hr': // a wearable irregular-rhythm flag is screening only (ATTENTION); AF needs an ECG review (CAUTION)
        if (val.irr) return Math.max(ATT, hrLevel(v, val, th));
        var hl = hrLevel(v, val, th); if (hl) return hl; if (pmLevel(th, 'hr', v, val)) return ATT;
        if (th.b && !val.sl && !val.ex && v > th.b * 1.15 && !CONTINUOUS[val.src]) return ATT; return 0; // resting measurement > 15 % above own baseline
      case 'spo2': if (v <= th.x) return CRI; if (th.u != null && v < th.u) return CAU; if (v < th.c) return ATT; return 0;
      case 'rr': if (val.ex) return v >= 40 ? CRI : v >= 30 ? ATT : 0; var sr = val.sl ? 2 : 0; if (v <= th.xLo - sr || v >= th.xHi) return CRI; if (v <= th.cLo - sr || v >= th.cHi) return ATT; return pmLevel(th, 'rr', v, val);
      case 'temp': if (v >= th.xHi || v <= th.xLo) return CRI; if (v >= th.cHi || v <= th.cLo) return ATT; if (th.b && v >= th.b + 0.8) return ATT; return pmLevel(th, 'temp', v, val);
      case 'bp': if (val.ex) return v >= 230 || val.v2 >= 120 ? CRI : v >= 210 ? ATT : 0; // during exercise blood pressure rises normally
        if (v >= th.sX || v < th.sXL || val.v2 >= th.dX) return CRI; if (v >= th.sC || v < th.sCL || val.v2 >= th.dC) return ATT; return pmLevel(th, 'sbp', v, val) || pmLevel(th, 'dbp', val.v2, val);
      case 'glu': if (v < th.xLo || v > th.xHi) return CRI; if (v < th.cLo) return CAU; if (v > th.cHi) return ATT; return 0; // alert scenario 5: < 70 ALERT, < 54 CRITICAL
      case 'sleep': if (v < th.x && val.prev != null && val.prev < th.x) return CRI; if (v < th.c) return ATT; return 0;
      case 'mood': if (v <= th.x) return CRI; if (v <= th.c) return ATT; return 0;
      case 'ex': if (v < th.x) return CRI; if (v < th.c) return ATT; return 0;
      case 'dose': if (v >= th.x) return CRI; if (v >= th.c) return ATT; return 0;
      case 'fluid': return v < th.c ? ATT : 0;
      case 'wt': if (val.l30 != null && val.l30 > th.x) return CRI; if (val.l30 != null && val.l30 > th.c) return CAU; if (val.l14 != null && val.l14 > th.a) return ATT; return 0;
      default: return 0;
    }
  }
  /*
   * DEMO TOOLS ONLY (Settings › Demo tools): values that make a chosen metric reach a chosen level for one person, and
   * the normal values that bring it back. Never used for real data. Returns null when that level does not exist for the metric.
   * Result: { level, abn: [readings], norm: [readings], text } (readings without pid / time / source).
   */
  var DEMO_NORMAL = { hr: 72, spo2: 98, rr: 15, temp: 36.7, glu: 95, sleep: 7.5, mood: 7, ex: 100, dose: 20, fluid: 3.0, bp: 118 };
  var DEMO_STEP = { hr: [1, 1], spo2: [-1, 1], rr: [1, 1], temp: [0.1, 1], glu: [1, 1], sleep: [-0.1, 1], mood: [-1, 1], ex: [-1, 1], dose: [1, 1], fluid: [-0.1, 1], bp: [1, 1] };
  var DEMO_EXAM = {
    ecg: { 0: { irr: false }, 1: { irr: true }, 2: { irr: true, noP: true, sec: 60 }, 3: { irr: true, noP: true, sec: 60, unstable: true } },
    ortho: { 0: { s1: 120, d1: 78, s2: 117, d2: 80, min: 3 }, 1: { s1: 124, d1: 80, s2: 100, d2: 68, min: 5 }, 2: { s1: 124, d1: 80, s2: 100, d2: 68, min: 3 }, 3: { s1: 124, d1: 80, s2: 92, d2: 60, min: 2, syncope: true } },
    urine: { 0: { vol: 2.8, blood: false, us: 'none' }, 1: { vol: 2.0, blood: false, us: 'none' }, 2: { vol: 2.6, blood: true, us: 'none' }, 3: { vol: 2.6, blood: true, us: 'stone' } },
    ijv: { 0: { vel: 22, retro: false, thrombus: false }, 2: { vel: 8, retro: false, thrombus: false }, 3: { vel: 8, retro: false, thrombus: true } },
    vision: { 0: { trt: 0 }, 1: { trt: 25 }, 3: { trt: 60 } },
    sym: { 0: { inf: false, conf: false, faint: false, chest: false }, 1: { inf: true } },
    blood: { 0: { hb: 14, wbc: 6.5, plt: 250, lym: 1800 }, 1: { hb: 14, wbc: 13.5, plt: 250, lym: 1800 }, 3: { hb: 7.4, wbc: 6.5, plt: 250, lym: 1800 } }
  };
  var DEMO_KEYS = ['hr', 'bp', 'spo2', 'rr', 'temp', 'glu', 'sleep', 'mood', 'ex', 'dose', 'fluid', 'ecg', 'ortho', 'urine', 'ijv', 'vision', 'sym', 'blood'];
  function demoReading(k, level, th, t) {
    if (DEMO_KEYS.indexOf(k) < 0 || [1, 2, 3].indexOf(level) < 0 || !th) return null;
    if (DEMO_EXAM[k]) { var ex = DEMO_EXAM[k]; if (!ex[level] || examLevel(k, ex[level]) !== level) return null; return { level: level, abn: [{ k: k, x: clone(ex[level]) }], norm: [{ k: k, x: clone(ex[0]) }], text: examText(k, ex[level]) }; }
    var tk = th[k]; if (!tk) return null;
    var n = DEMO_NORMAL[k], d2 = 76, pm = tk._pm;
    if (pm) { var bm = modelBand(pm, k === 'bp' ? 'sbp' : k, t); if (bm && bm[0] != null) n = bm[0]; if (k === 'bp') { var bd = modelBand(pm, 'dbp', t); if (bd && bd[0] != null) d2 = Math.round(bd[0]); } }
    var dec = k === 'temp' || k === 'sleep' || k === 'fluid' ? 1 : 0, rnd = function (v) { var f = Math.pow(10, dec); return Math.round(v * f) / f; };
    var mk = function (v) { var o = { k: k, v: rnd(v) }; if (k === 'bp') o.v2 = d2; return o; };
    var lv = function (v) { var r = mk(v), val = { v: r.v, v2: r.v2, t: t }; if (k === 'sleep' && level === 3) val.prev = r.v; return levelOf(k, val, tk); };
    n = rnd(n); if (lv(n) !== 0) n = DEMO_NORMAL[k]; if (lv(n) !== 0) return null;
    var st = DEMO_STEP[k][0], lim = PLAUS[k] || [-1e9, 1e9], dirs = [st, -st];
    for (var di = 0; di < 2; di++) {
      for (var v = n, i = 0; i < 400; i++) {
        v = rnd(v + dirs[di]); if (v < lim[0] || v > lim[1]) break;
        var l = lv(v); if (l === level) { var deeper = rnd(v + dirs[di] * 2); if (deeper >= lim[0] && deeper <= lim[1] && lv(deeper) === level) v = deeper; return demoOut(k, level, mk(v), mk(n)); }
        if (l > level) break;   // passed the level (e.g. this metric goes straight from ATTENTION to CRITICAL)
      }
    }
    return null;
  }
  function demoOut(k, level, a, n) {
    var abn = [a], norm = [n];
    if (k === 'sleep' && level === 3) abn = [Object.assign({ back: D }, a), a];   // CRITICAL sleep needs two short nights
    return { level: level, abn: abn, norm: norm, text: fmtV(k, a) + (MDEF[k].unit ? ' ' + MDEF[k].unit : '') };
  }
  function demoLevels(k, th, t) { return [1, 2, 3].filter(function (l) { return !!demoReading(k, l, th, t); }); }
  /* Bone turnover (scenario: chronic bone health). Demo rule, not a validated cutoff: urine NTX 30 % or more above the
     first (pre-mission) value = ATTENTION, kept while clinician follow-up is pending. Markers alone never give BMD. */
  function boneLevel(val) {
    var x = val.x; if (!x) return typeof val.l === 'number' ? val.l : 0;
    if (x.ntx != null && val.ntx0 && x.ntx >= val.ntx0 * 1.3) return ATT;
    return x.follow ? ATT : 0;
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
    var q = []; if (rr != null && rr >= 22) q.push('breathing ' + Math.round(rr)); if (sb != null && sb <= 100) q.push('systolic ' + Math.round(sb)); if (sy.conf) q.push('new confusion');
    var tb = th.temp && th.temp.b, warm = tp != null && tb && tp >= tb + 0.8, fever = tp != null && tp > 38.0;
    // Scenario 3. CRITICAL: qSOFA >= 2 with an infection sign; ALERT: >= 2 SIRS signs, or temperature > 38.0 alone; WATCH: one sign, or 0.8 °C above own normal
    var ex0 = x('ecg'), rhythmSign = (m.hr.val && m.hr.val.irr) || (ex0 && ex0.irr);
    var bleedOnly = (sy.bleed === 'active' || sy.bleed === 'controlled' || sy.bleed === 'ongoing' || rhythmSign || (sy.airway && sy.airway !== 'none' && sy.expo)) && !sy.inf && !(tp != null && (tp > I.tHi || tp < I.tLo)) && !(b.wbc != null && (b.wbc > 12 || b.wbc < 4));
    if (bleedOnly) m.c_inf = cond(0, (sy.airway && sy.airway !== 'none' && sy.expo ? 'No infection pattern: fast heart and breathing go with the reported airborne exposure' : rhythmSign && !sy.bleed ? 'No infection pattern: fast heart and breathing go with the irregular rhythm' : 'No infection pattern: fast heart and breathing are explained by the reported bleeding'), crit, '', 'INF-BLEED');
    else if (q.length >= 2 && (sy.inf || crit.length)) m.c_inf = cond(CRI, 'Infection with warning signs – urgent', q.concat(crit), '1) Lie down; a crewmate stays. 2) Vitals and SpO2 every 15 min. 3) Flight surgeon now. 4) Flight surgeon decides treatment from the medical kit.', 'INF-QSOFA');
    else if (crit.length >= 2 || fever) m.c_inf = cond(CAU, 'Signs of infection', crit, '1) Rest and drink. 2) Vitals and SpO2 every 4 h. 3) Mask, distance, clean shared surfaces. 4) Blood count if available. 5) Tell the CMO; flight surgeon reviews today. 6) Medication only per protocol.', 'INF-SIRS');
    else if (crit.length === 1 || warm || sy.inf) m.c_inf = cond(ATT, crit.length || warm ? 'Watch: one sign of infection' : 'Watch: symptoms of infection reported', crit.length ? crit : warm ? ['temperature ' + tp + ' °C, 0.8 °C or more above own normal'] : ['crew symptom check: suspected infection'], '1) Re-measure temperature, HR and RR in 4 h. 2) Rest and drink.', 'INF-WATCH');
    else m.c_inf = cond(0, 'No infection pattern', crit, 'Combine temperature, heart rate, breathing and WBC; log symptoms if infection is suspected.', 'INF-SCREEN');
    // 2. Atrial fibrillation (scenario 6, AHA 2025 tachyarrhythmia algorithm). A wearable irregular pulse is a SCREENING flag (WATCH);
    //    an irregular pulse with palpitations and a resting HR > 100 needs an ECG (CAUTION); a clinician-reviewed ECG decides AF (CAUTION);
    //    CRITICAL only with instability: hypotension (systolic < 90), fainting, confusion, chest pain or severe dizziness - never from HR alone.
    var e = x('ecg'), el = e ? examLevel('ecg', e) : 0, hvA = m.hr.val, irrP = hvA && hvA.irr && !hvA.ex;
    var unst = (sy.faint || sy.chest || sy.conf || sy.dizzy === 'severe' || (sb != null && sb < 90));
    if (el >= CAU) m.c_af = cond(unst ? CRI : CAU, unst ? 'Unstable rhythm – low blood pressure or severe symptoms' : 'Clinician-reviewed ECG: atrial fibrillation – close monitoring', [examText('ecg', e)].concat(hvA ? ['heart rate ' + Math.round(hvA.v)] : []).concat(unst && sb != null ? ['systolic ' + Math.round(sb)] : []).concat(sy.dizzy && sy.dizzy !== 'none' ? [sy.dizzy === 'severe' ? 'severe dizziness' : 'lightheaded'] : []),
      unst ? '1) Responding crew and CMO now. 2) ABC check; continuous HR, BP, rhythm, SpO2. 3) Approved onboard tachyarrhythmia emergency protocol. 4) Flight surgeon. CHARM does not choose drugs or settings.' : '1) Keep at rest. 2) Continuous rhythm and vital signs. 3) CMO directs the evaluation per the approved protocol.', unst ? 'AF-UNSTABLE' : 'AF-ECG');
    else if (irrP && (el === 0 || !e || !e.irr) && sy.palp && hvA.v > 100) m.c_af = cond(CAU, 'Persistent irregular rhythm – ECG required', ['irregular pulse (screening)', 'palpitations', 'heart rate ' + Math.round(hvA.v)].concat(sy.dizzy && sy.dizzy !== 'none' ? ['lightheaded'] : []), '1) Record a quality ECG / rhythm strip. 2) Repeat BP, HR, SpO2 and symptoms. 3) Tell the CMO; stop exertion.', 'AF-ECG-NEEDED');
    else if (irrP && (!e || !e.irr)) m.c_af = cond(ATT, 'Irregular pulse – verify the signal (screening only)', ['irregular pulse from the wearable'].concat(sy.palp ? ['palpitations'] : []), '1) Rest and repeat HR and BP. 2) Check the sensor fit. 3) ECG if it comes back.', 'AF-SCREEN');
    else m.c_af = el ? cond(el, 'Irregular rhythm on ECG', [examText('ecg', e)], 'Repeat the ECG for at least 30 seconds and check for P waves.', 'AF-IRREG') : cond(0, 'No rhythm finding', [], '', 'AF');
    // a heart rate explained by a clinician-reviewed AF is rated by the AF rule (stable vs unstable), not by the rate alone
    if (el >= CAU && m.hr.l === CRI) m.hr.l = CAU;
    // 3. Orthostatic hypotension: lying/sitting vs standing within 3 minutes; fainting = red
    // Scenario 1 (landing day). CRITICAL: standing systolic <= 90 (or fainting); ALERT: drop >= 20/10 within 3 min; WATCH: HR +30 without a drop, or fluid loss
    var o = x('ortho'), ol = o ? examLevel('ortho', o) : 0; if (sy.faint && ol >= CAU) ol = CRI;
    var wv = m.wt && m.wt.val, fl1 = v('fluid'), loss = [];
    if (wv && ((wv.l14 != null && wv.l14 > 2) || (wv.l30 != null && wv.l30 > 2))) loss.push('body mass down ' + Math.max(wv.l14 || 0, wv.l30 || 0) + ' %');
    if (fl1 != null && fl1 < 2.5) loss.push('fluid intake ' + fl1 + ' L/day');
    if (ol === CRI) m.c_orth = cond(CRI, 'Very low blood pressure – lie down now', [examText('ortho', o)], '1) Lie flat, legs up. 2) A crewmate stays. 3) Flight surgeon now. 4) Do not stand until cleared.', o && o.syncope ? 'ORTH-SYNCOPE' : 'ORTH-LOW');
    else if (ol === CAU) m.c_orth = cond(CAU, 'Blood pressure drops when you stand', [examText('ortho', o)], '1) Sit or lie down, legs up. 2) Do not stand alone; get up slowly with a crewmate. 3) Fluids and salt per protocol. 4) Repeat the stand test in 15–30 min. 5) Tell the CMO; flight surgeon if no better.', 'ORTH-DROP');
    else if (ol === ATT || loss.length) m.c_orth = cond(ATT, 'Watch: fluid loss before landing', (o && ol ? [examText('ortho', o)] : []).concat(loss), '1) Fluids and salt per protocol before landing. 2) Repeat the stand test tomorrow.', 'ORTH-WATCH');
    else m.c_orth = cond(0, 'No orthostatic finding', [], '', 'ORTH');
    // 4. Kidney stone risk: hydration (yellow) vs urinary / ultrasound findings
    var u = x('urine'), ul = u ? examLevel('urine', u) : 0, fl = v('fluid'), why4 = [];
    if (u) why4.push(examText('urine', u)); if (fl != null && fl < 2.5) { why4.push('fluid intake ' + fl + ' L/day'); if (ul < ATT) ul = ATT; }
    m.c_kid = ul ? cond(ul, ul === CRI ? 'Kidney stone or obstruction on ultrasound' : ul === CAU ? 'Blood in urine' : 'Below the 2.5 L/day hydration target', why4,
      ul === CRI ? 'Medical review and renal-stone protocol.' : ul === CAU ? 'Urinalysis and kidney assessment; consider kidney ultrasound.' : 'Increase fluids if medically appropriate; repeat the 24-hour urine check.', ul === CRI ? 'KID-US' : ul === CAU ? 'KID-BLOOD' : 'KID-HYDRATION') : cond(0, 'No kidney finding', why4, '', 'KID');
    // 5. SANS: NASA thresholds
    // Scenario A: weekly self vision test worse than pre-flight = WATCH; 2 tests in a row = ALERT. OCT / exam thresholds as before.
    var vi = x('vision'), vl = vi ? examLevel('vision', vi) : (m.vision.l > 0 ? m.vision.l : 0), pv = m.vision.val && m.vision.val.prevX;
    var self2 = vi && vi.self === 'worse' && pv && pv.self === 'worse';
    if (self2 && vl < CAU) vl = CAU;
    m.c_sans = vl ? cond(vl, vl === CRI ? 'Clinically concerning SANS finding' : self2 ? 'Vision is changing (possible SANS)' : vl === CAU && vi && vi.stable ? 'SANS established – reviewed, not rising' : vl === CAU ? 'Two or more early SANS signs – suspected developing SANS' : vi && vi.self === 'worse' && vl === ATT ? 'Watch: vision test changed' : 'Earliest NASA SANS indication', [vi ? examText('vision', vi) : (m.vision.val && m.vision.val.txt) || 'Eye exam result'].concat(self2 ? ['worse on 2 tests in a row'] : []),
      vl === CRI ? 'Ophthalmic medical review; follow the mission SANS protocol.' : self2 ? '1) Repeat the self vision test in 1 week. 2) Keep CO2 low in the sleep station. 3) Flight surgeon reviews; eye exam per NASA SANS schedule.' : vl === CAU && vi && vi.stable ? '1) Continue duty with optical correction. 2) OCT and refraction at set intervals. 3) Any new rise re-opens the alert.' : vl === CAU ? '1) Notify the CMO. 2) Plus-power or adjustable glasses; larger screen text. 3) Repeat OCT, refraction and fundus. 4) Send images to Earth.' : vi && vi.self === 'worse' ? '1) Repeat the self vision test next week.' : 'Repeat OCT and eye exam; trend against baseline.', vl === CRI ? 'SANS-CONCERN' : self2 ? 'SANS-SELF2' : vl === CAU ? 'SANS-2SIGNS' : 'SANS-EARLY') : cond(0, 'No SANS finding', [], '', 'SANS');
    // 6. Venous thrombosis (neck vein)
    var j = x('ijv'), jl = j ? examLevel('ijv', j) : 0;
    m.c_vte = jl ? cond(jl, jl === CRI ? 'Venous thrombus seen' : 'Neck-vein stasis or retrograde flow', [examText('ijv', j)],
      jl === CRI ? 'Immediate medical review and VTE protocol.' : 'Repeat the Doppler ultrasound; compare with the prior scan; request medical review.', jl === CRI ? 'VTE-THROMBUS' : 'VTE-FLOW') : cond(0, 'No neck-vein finding', [], '', 'VTE');
    // Scenario B: fluid loss and space anemia. CRITICAL Hb < 8; ALERT Hb below WHO (women 12, men 13) or down >= 10 % vs own first value;
    // WATCH Hb up >= 5 % vs own first value while body mass is down > 2 % or fluid intake < 2.5 L/day (concentrated blood)
    var bv = m.blood && m.blood.val, hb = b.hb, hb0 = bv && bv.hb0, who = th.blood && th.blood.hbLo || 12, an = [];
    if (hb != null) {
      if (hb < 8) m.c_anem = cond(CRI, 'Severe anemia – medical review now', ['hemoglobin ' + hb + ' g/dL'], '1) Rest lying down. 2) Flight surgeon now. 3) HR, BP and SpO2 every 15 min.', 'ANEM-SEVERE');
      else if (hb < who || (hb0 && hb <= hb0 * 0.9)) m.c_anem = cond(CAU, 'Low hemoglobin (space anemia)', ['hemoglobin ' + hb + ' g/dL' + (hb < who ? ' (below ' + who + ')' : '') + (hb0 ? ' · your first value ' + hb0 : '')], '1) Rest; get up slowly. 2) Nutrition plan per protocol. 3) Repeat the blood test. 4) Flight surgeon reviews the trend.', 'ANEM-LOW');
      else if (hb0 && hb >= hb0 * 1.05 && loss.length) m.c_anem = cond(ATT, 'Watch: fluid loss – hemoglobin may look normal', ['hemoglobin ' + hb + ' (your first value ' + hb0 + ')'].concat(loss), '1) Drink to your fluid target. 2) Eat to your calorie and protein plan. 3) CHARM keeps the trend.', 'ANEM-CONC');
      else m.c_anem = cond(0, 'No anemia pattern', [], '', 'ANEM');
    } else m.c_anem = cond(0, 'No blood count', [], '', 'ANEM');
    // Scenario 4 (dehydration): shock index = heart rate / systolic BP, both at rest and taken within 30 min.
    // CRITICAL >= 1.3 · CAUTION >= 1.0 · ATTENTION >= 0.9, or >= 0.8 with a fluid deficit
    var hv = m.hr.val, bv2 = m.bp.val;
    if (hv && bv2 && !hv.ex && !bv2.ex && bv2.v > 0 && Math.abs(hv.t - bv2.t) <= 30 * MIN) {
      var si = Math.round(hv.v / bv2.v * 100) / 100, sw = ['shock index ' + si.toFixed(2) + ' (HR ' + Math.round(hv.v) + ' ÷ systolic ' + Math.round(bv2.v) + ')'].concat(si >= 0.8 ? loss : []);
      if (si >= 1.3) m.c_vol = cond(CRI, 'Shock index very high – possible low blood volume or shock', sw, '1) CMO to the astronaut now; ABC check. 2) Lie down, continuous HR, BP, RR, SpO2. 3) Rule out bleeding, infection, heart rhythm. 4) Fluids only per the approved protocol. 5) Flight surgeon now.', 'VOL-SHOCK');
      else if (si >= 1.0) m.c_vol = cond(CAU, 'Shock index above 1 – the heart is working hard to hold blood pressure', sw, '1) Stop activity, rest secured. 2) Tell the CMO. 3) Oral rehydration if alert and not vomiting. 4) Repeat HR and BP in 5 min.', 'VOL-HIGH');
      else if (si >= 0.9 || (si >= 0.8 && loss.length)) m.c_vol = cond(ATT, 'Watch: heart rate rising against blood pressure', sw, '1) Stop strenuous activity and rest. 2) Drink (oral rehydration). 3) Repeat HR and BP in 5 min.', 'VOL-WATCH');
      else m.c_vol = cond(0, 'Shock index normal', sw, '', 'VOL');
    } else m.c_vol = cond(0, 'No recent heart rate and blood pressure pair', [], '', 'VOL');
    // Severe bleeding (scenario 5). Life-threatening bleeding = Stop the Bleed (American College of Surgeons); blood-loss signs =
    // ATLS hemorrhage classes: class II HR 100-120, class III HR > 120 with falling blood pressure; shock index >= 1 (4x mortality).
    var bl = sy.bleed, hrv = hv && !hv.ex ? hv.v : null, sbv = bv2 ? bv2.v : null, si2 = hrv != null && sbv ? hrv / sbv : null;
    var dz = sy.dizzy === 'severe' || sy.faint || sy.conf, bw = [bl === 'active' ? 'life-threatening bleeding (crew report)' : bl === 'ongoing' ? 'bleeding not yet controlled (crew report)' : 'bleeding controlled (crew report)'];
    if (sy.dizzy && sy.dizzy !== 'none') bw.push(sy.dizzy === 'severe' ? 'near-fainting' : 'lightheaded');
    if (hrv != null) bw.push('heart rate ' + Math.round(hrv)); if (sbv != null) bw.push('systolic ' + Math.round(sbv)); if (si2 != null) bw.push('shock index ' + si2.toFixed(2));
    if (bl === 'active') m.c_bleed = cond(CRI, 'Life-threatening bleeding – stop the bleed now', bw, '1) Gloves on. 2) Firm direct pressure with both hands. 3) Limb: tourniquet 5–8 cm above the wound, not on a joint; tighten until the bleeding stops; note the time. Elsewhere: pack the wound and press. 4) CMO and flight surgeon now.', 'BLEED-ACTIVE');
    // bleeding reported, not yet controlled (medic team scenario): WATCH; CAUTION with HR >= 100 or lightheadedness (ATLS class II);
    // CRITICAL with systolic < 90, HR > 120 or near-fainting / confusion (circulatory instability), never from HR alone below 120
    else if (bl === 'ongoing' && ((sbv != null && sbv < 90) || (hrv != null && hrv > 120) || dz)) m.c_bleed = cond(CRI, 'Bleeding with low blood pressure – emergency response', bw, '1) Activate the mission medical emergency protocol; responding crew and CMO now. 2) Keep firm pressure or the tourniquet on. 3) Lie flat, warm; continuous BP, HR, RR. 4) Flight surgeon.', 'BLEED-UNSTABLE');
    else if (bl === 'ongoing' && ((hrv != null && hrv >= 100) || sy.dizzy === 'mild')) m.c_bleed = cond(CAU, 'Persistent bleeding – possible circulatory compromise', bw, '1) CMO reassesses now. 2) Keep pressure; pack or tourniquet if it soaks through. 3) HR, BP, RR every 5 min.', 'BLEED-PERSIST');
    else if (bl === 'ongoing') m.c_bleed = cond(ATT, 'External bleeding reported – assess', bw, '1) Tell the CMO. 2) Gloves on; firm pressure on the wound. 3) Pause the task; repeat HR, BP, RR.', 'BLEED-REPORTED');
    else if (bl === 'controlled' && ((hrv != null && hrv > 120) || (sbv != null && sbv < 90) || (si2 != null && si2 >= 1) || dz)) m.c_bleed = cond(CRI, 'Bleeding controlled, but signs of shock (ATLS class III)', bw, '1) Lie flat, legs up, keep warm. 2) Continuous HR, BP, SpO2. 3) IV fluids only per the approved protocol. 4) Flight surgeon now.', 'BLEED-SHOCK');
    else if (bl === 'controlled' && ((hrv != null && hrv >= 100) || (si2 != null && si2 >= 0.9) || sy.dizzy === 'mild')) m.c_bleed = cond(CAU, 'Bleeding controlled – signs of blood loss (ATLS class II)', bw, '1) Keep the tourniquet or pressure on; do not loosen it. 2) HR and BP every 5 min. 3) Drink if alert. 4) Tell the CMO; flight surgeon reviews.', 'BLEED-LOSS');
    else if (bl === 'controlled') m.c_bleed = cond(ATT, 'Bleeding controlled – keep watching', bw, '1) Check the dressing and the tourniquet time. 2) HR and BP every 15 min. 3) Flight surgeon plans the wound care.', 'BLEED-WATCH');
    else m.c_bleed = cond(0, 'No bleeding reported', [], '', 'BLEED');
    // Airway reaction after an airborne exposure (medic team scenario; NAEPP exacerbation grades). The exposure and symptoms are crew reports.
    var aw = sy.airway, spv = v('spo2'), rrv = v('rr'), ra = [];
    if (aw && aw !== 'none') {
      ra.push({ irritation: 'throat or eye irritation', wheeze: 'cough and wheeze', moderate: 'short of breath, speaks in phrases', severe: 'cannot finish sentences' }[aw]); if (sy.expo) ra.push('airborne exposure reported');
      if (hrv != null) ra.push('heart rate ' + Math.round(hrv)); if (rrv != null) ra.push('breathing ' + Math.round(rrv) + '/min'); if (spv != null) ra.push('SpO2 ' + spv + ' %');
      if (aw === 'severe' || (spv != null && spv <= 88)) m.c_resp = cond(CRI, 'Severe breathing difficulty – emergency response', ra, '1) CMO now; activate the onboard respiratory-emergency protocol. 2) Sit her upright, anchored. 3) Oxygen only per protocol. 4) Flight surgeon while the link is up.', 'RESP-SEVERE');
      else if (aw === 'moderate' || (aw === 'wheeze' && ((hrv != null && hrv > 100) || (rrv != null && rrv > 20) || (spv != null && spv < 95)))) m.c_resp = cond(CAU, 'Possible allergic or irritant airway reaction – medical review', ra, '1) Pause work; leave the affected area if feasible. 2) CMO assesses breathing effort and speech. 3) Repeat RR and SpO2 often.', 'RESP-WHEEZE');
      else m.c_resp = cond(ATT, 'Possible airborne exposure – watch the symptoms', ra, '1) Report to the medical and environmental officers. 2) Leave the affected area if feasible. 3) Repeat HR, RR, SpO2.', 'RESP-WATCH');
    } else m.c_resp = cond(0, 'No airway reaction reported', [], '', 'RESP');
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
        ev.push({ t: v && v.t ? Math.max(v.t, t - 10 * MIN) : t, pid: pid, k: k, lv: l, sim: !!(v && v.sim), type: 'raise', text: MDEF[k].label + ' ' + WORD[String(l)], sub: MDEF[k].cond ? (v.txt + (v.why && v.why.length ? ': ' + v.why.join(', ') : '') + ' · ' + v.next) : (k === 'hr' && v && v.irr ? 'Irregular rhythm detected · ' : '') + fmtV(k, v) + (MDEF[k].unit ? ' ' + MDEF[k].unit : '') + (v && v.pm ? ' · ' + v.pm : '') + (k === 'wt' && v ? ' · ' + (v.l30 != null ? v.l30 + ' % lost in 30 days' : '') : '') });
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
      out.co2 = c.v; out.co2avg = n ? s / n : c.v; out.co2l = out.co2avg > 3.0 ? CAU : out.co2avg > 2.3 ? ATT : 0; out.co2t = c.t; // scenario 4: > 2.3 WATCH, > 3.0 ALERT (1-hour mean)
    }
    if (p && t - p.t <= 2 * H) { out.pfu = p.v; out.pfl = p.v >= 1000 ? CRI : p.v >= 100 ? CAU : p.v >= 10 ? ATT : 0; out.ps = p.v >= 1000 ? 3 : p.v >= 100 ? 2 : p.v >= 10 ? 1 : 0; out.pfut = p.t; out.pfsrc = p.src; } // scenario 2: NOAA S1 / S2 / S3+
    if (ct && t - ct.t <= 6 * H) { out.temp = ct.v; out.tl = ct.v < 18 || ct.v > 27 ? ATT : 0; out.tempt = ct.t; }
    return out;
  }
  function envTransitions(envSeries, t, state) {
    var e = envAt(envSeries, t), s = Object.assign({ co2l: 0, pfl: 0 }, state || {}), ev = [];
    if (e.co2l >= 0 && e.co2l !== s.co2l) { ev.push({ t: t, pid: null, k: 'co2', lv: e.co2l, type: e.co2l > s.co2l ? 'raise' : 'clear', text: e.co2l > s.co2l ? 'Cabin CO₂ ' + WORD[String(e.co2l)] + ' · affects all crew' : 'Cabin CO₂ back to ' + WORD[String(e.co2l)], sub: '1-hour average ' + e.co2avg.toFixed(1) + ' mmHg' }); s.co2l = e.co2l; }
    if (e.pfl >= 0 && e.pfl !== s.pfl) { ev.push({ t: t, pid: null, k: 'pfu', lv: e.pfl, type: e.pfl > s.pfl ? 'raise' : 'clear', text: e.pfl > s.pfl ? (e.pfl === CRI ? 'Radiation storm – go to shelter now · NOAA S' + e.ps : e.pfl === CAU ? 'Solar radiation storm – prepare · NOAA S2' : 'Watch: minor solar radiation storm · NOAA S1') : e.pfl > 0 ? 'Solar radiation storm down to NOAA S' + e.ps : 'Solar particle event over', sub: 'Protons ≥10 MeV: ' + e.pfu.toFixed(0) + ' pfu' }); s.pfl = e.pfl; }
    return { events: ev, state: s };
  }

  /* Mission geometry. Mars transit: Hohmann transfer launched on Mission Day 1 (a = 1.262 AU, e = 0.2076). */
  function missionDay(t, launch) { return Math.floor((t - launch) / D) + 1; }
  /* Mars transit: a fast conic transfer of TRANSFER_DAYS (about 6 months) from Earth (perihelion, 1 AU) to Mars (1.524 AU),
     launched on Mission Day 1; the eccentricity is solved once so the flight time is exactly TRANSFER_DAYS (Kepler's equation).
     After arrival the ship stays with Mars. Earth and Mars move on circular orbits (365.25 and 686.98 days).
     One-way light time = Earth–ship distance / speed of light (1 AU = 499.005 light-seconds). */
  var TRANSFER_DAYS = 180, TR = (function () {
    function tof(e) {
      var a = 1 / (1 - e), cn = Math.max(-1, Math.min(1, ((1 + e) / 1.524 - 1) / e)), nu = Math.acos(cn);
      var Ee = 2 * Math.atan(Math.sqrt((1 - e) / (1 + e)) * Math.tan(nu / 2)), M = Ee - e * Math.sin(Ee);
      return { t: M / (2 * Math.PI) * 365.25 * Math.pow(a, 1.5), nu: nu, a: a };
    }
    var lo = 0.2077, hi = 0.95;
    for (var i = 0; i < 80; i++) { var mid = (lo + hi) / 2; if (tof(mid).t > TRANSFER_DAYS) lo = mid; else hi = mid; }
    var e = (lo + hi) / 2, r = tof(e);
    return { e: e, a: r.a, nu: r.nu, P: 365.25 * Math.pow(r.a, 1.5) };
  })();
  function shipGeom(t, launch) {
    var md = (t - launch) / D + 1, d = Math.max(0, md - 1), dd = Math.min(d, TRANSFER_DAYS), e = TR.e, a = TR.a;
    var M = 2 * Math.PI * dd / TR.P, Ee = M;
    for (var i = 0; i < 20; i++) Ee = Ee - (Ee - e * Math.sin(Ee) - M) / (1 - e * Math.cos(Ee));
    var nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(Ee / 2), Math.sqrt(1 - e) * Math.cos(Ee / 2)), r = a * (1 - e * Math.cos(Ee));
    var th = 2 * Math.PI * d / 365.25, ma = TR.nu - 2 * Math.PI * (TRANSFER_DAYS - d) / 686.98;
    var mx = 1.524 * Math.cos(ma), my = 1.524 * Math.sin(ma), arrived = d >= TRANSFER_DAYS;
    var sx = arrived ? mx : r * Math.cos(nu), sy = arrived ? my : r * Math.sin(nu); if (arrived) { r = 1.524; nu = ma; }
    var ex = Math.cos(th), ey = Math.sin(th), au = Math.hypot(sx - ex, sy - ey);
    return { md: md, r: r, nu: nu, sx: sx, sy: sy, ex: ex, ey: ey, mx: mx, my: my, au: au, km: au * 149597870.7, lt: au * 499.005, arrived: arrived, transferDays: TRANSFER_DAYS };
  }
  function oneWay(t, mission) {
    var env = (mission && mission.env) || 'mars';
    if (env === 'moon') return 1.28; if (env === 'iss') return 0.6;
    return shipGeom(t, (mission && mission.launch) || t).lt;
  }

  return {
    MIN: MIN, H: H, D: D, MDEF: MDEF, MKEYS: MKEYS, LKEYS: LKEYS, RKEYS: RKEYS, ENVKEYS: ENVKEYS, COMMON: COMMON, THF: THF, PLAUS: PLAUS, FRESH: FRESH,
    freshFor: freshFor, profile: profile, MODEL: MODEL, modelBand: modelBand, demoReading: demoReading, demoLevels: demoLevels, DEMO_KEYS: DEMO_KEYS, examLevel: examLevel, examText: examText, validateExam: validateExam, EXAMF: EXAMF, EXAMK: EXAMK, CONDK: CONDK, ATT: ATT, CAU: CAU, CRI: CRI, SCALE: SCALE, personalOffsets: personalOffsets, CREW_AVG: CREW_AVG, checkProfile: checkProfile, validateReading: validateReading, validateEnv: validateEnv,
    sortSeries: sortSeries, lastIdx: lastIdx, lastReading: lastReading, valueAt: valueAt, levelOf: levelOf, rank: rank,
    personStatus: personStatus, wearableSilent: wearableSilent, fmtV: fmtV, WORD: WORD, transitions: transitions,
    envAt: envAt, envTransitions: envTransitions, missionDay: missionDay, shipGeom: shipGeom, TRANSFER_DAYS: TRANSFER_DAYS, oneWay: oneWay, clone: clone
  };
});
