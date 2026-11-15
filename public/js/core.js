/*
 * CHARM core: the server-side logic (validation, alert evaluation, Earth outbox, demo scenario).
 * It talks to storage only through a small `db` adapter, so the same code runs:
 *   - in Cloud Functions with Firestore (functions/index.js), and
 *   - in the browser with an in-memory store (public/js/localdb.js) for development without a server.
 *
 * Edit this file in /shared only. `firebase deploy` copies it to functions/ and public/js/.
 */
(function (root, factory) {
  var C;
  if (typeof module === 'object' && module.exports) { C = factory(require('./engine.js')); module.exports = C; }
  else { C = factory(root.CHARM_ENGINE); root.CHARM_CORE = C; }
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';
  var MIN = E.MIN, H = E.H, D = E.D;

  /* Starting roster. Profiles only: no health data. */
  var SEED_CREW = [
    { id: 'sarah', name: 'Sarah', role: 'Flight Engineer', agency: 'NASA', img: 'assets/sarah.png', order: 1 },
    { id: 'marcus', name: 'Marcus', role: 'Commander', agency: 'NASA', img: 'assets/marcus.png', order: 2 },
    { id: 'mei', name: 'Mei', role: 'Mission Specialist', agency: 'JAXA', img: 'assets/mei.png', order: 3 },
    { id: 'john', name: 'John', role: 'Crew Medical Officer', agency: 'CSA', img: 'assets/john.png', order: 4 },
    { id: 'elena', name: 'Elena', role: 'Mission Specialist', agency: 'ESA', img: 'assets/elena.png', order: 5 },
    { id: 'david', name: 'David', role: 'Pilot', agency: 'NASA', img: 'assets/david.png', face: 'assets/david-face.png', order: 6 },
    { id: 'robert', name: 'Robert', role: 'Mission Specialist', agency: 'NASA', img: 'assets/robert.png', face: 'assets/robert-face.png', order: 7 },
    { id: 'maya', name: 'Maya', role: 'Flight Engineer', agency: 'NASA', img: 'assets/maya.png', face: 'assets/maya-face.png', order: 8 },
    { id: 'amara', name: 'Amara', role: 'Payload Specialist', agency: 'NASA', img: 'assets/amara.png', face: 'assets/amara-face.png', order: 9 }
  ];
  var SOURCES = { manual: 1, test: 1, import: 1, record: 1 }; // what the app may send; 'demo' only via runDemo, 'device' via the device endpoint
  var EVENT_TYPES = { crew: 1, ack: 1, task: 1, msg: 1, emergency: 1 };

  function err(code, msg) { var e = new Error(msg); e.code = code; return e; }
  function str(v, max) { return typeof v === 'string' ? v.trim().slice(0, max || 200) : ''; }
  function dayStartUTC(t) { var d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }
  function slug(name) { return (name.trim().split(/\s+/)[0] || 'crew').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '') || 'crew'; }

  /* Every event also goes to the Earth outbox, except link changes and messages that came from Earth. */
  function outboxFor(ev) {
    if (ev.type === 'link' || ev.src === 'earth') return null;
    var prio = typeof ev.prio === 'number' ? ev.prio : (ev.type === 'raise' && ev.lv === E.CRI) || ev.type === 'emergency' ? 2 : ev.type === 'raise' || ev.type === 'nodata' ? 1 : 0;
    return { t: ev.t, pid: ev.pid || null, text: ev.text, sub: ev.sub || null, prio: prio, status: 'queued', evId: ev.id || null };
  }
  async function emit(db, events) {
    if (!events.length) return [];
    var saved = await db.addEvents(events);
    var ob = saved.filter(function (e) { return !e.replayed; }).map(outboxFor).filter(Boolean); // replayed history is not re-sent to Earth
    if (ob.length) await db.addOutbox(ob);
    await notify(db, saved);
    return saved;
  }

  /*
   * Phone alerts. CAUTION (orange) goes to the phone of the astronaut it is about (cabin alerts: every phone);
   * CRITICAL (red) and Emergency Mode go to every registered phone. Replayed history never sends.
   * A failure here never blocks the alert itself.
   */
  function pushId(token) { var h = 5381; for (var i = 0; i < token.length; i++) h = ((h * 33) ^ token.charCodeAt(i)) >>> 0; return 'p' + h.toString(36) + token.length.toString(36) + token.slice(-12).replace(/[^A-Za-z0-9_-]/g, ''); }
  async function notify(db, saved) {
    if (!db.listPush || !db.sendPush) return;
    try {
      var evs = saved.filter(function (e) { return !e.replayed && ((e.type === 'raise' && e.lv >= E.CAU) || e.type === 'emergency'); });
      if (!evs.length) return;
      var devs = await db.listPush(); if (!devs.length) return;
      var crew = await db.listCrew(), names = {}; crew.forEach(function (c) { names[c.id] = c.name; });
      for (var i = 0; i < evs.length; i++) {
        var ev = evs[i], lv = ev.type === 'emergency' ? E.CRI : ev.lv;
        var to = devs.filter(function (d) { return lv >= E.CRI || !ev.pid || d.pid === ev.pid; });
        if (!to.length) continue;
        var data = { l: String(lv >= E.CRI ? 3 : 2), pid: ev.pid || '', name: (ev.pid && names[ev.pid]) || '', k: ev.k || '', text: str(ev.text, 200), sub: str(ev.sub || '', 200), t: String(ev.t), id: ev.id || '', sim: ev.sim ? '1' : '' };
        var res = await db.sendPush(to.map(function (d) { return d.token; }), data);
        var bad = (res && res.invalid) || [];
        for (var j = 0; j < bad.length; j++) await db.delPush(pushId(bad[j]));
      }
    } catch (e) { if (typeof console !== 'undefined') console.warn('phone alert not sent:', e && e.message); }
  }

  async function bootstrap(db, now) {
    var m = await db.getMission();
    if (!m) { m = { name: 'CHARM mission', env: 'mars', launch: dayStartUTC(now), link: true, created: now }; await db.setMission(m); }
    var crew = await db.listCrew();
    // Adds any built-in crew member who is missing (also on a database created before new crew were added)
    var have = {}, gone = {}; crew.forEach(function (c) { have[c.id] = c; });
    (m.removed || []).forEach(function (id) { gone[id] = 1; }); // crew removed in Settings stay removed
    for (var i = 0; i < SEED_CREW.length; i++) {
      var sd = SEED_CREW[i], ex = have[sd.id];
      if (!ex && gone[sd.id]) continue;
      if (!ex) await db.setCrew(sd.id, Object.assign({ created: now }, sd));
      else if (ex.img !== sd.img || ex.face !== sd.face) await db.setCrew(sd.id, Object.assign({}, ex, { img: sd.img, face: sd.face || null }));
    }
    crew = await db.listCrew();
    return { mission: m, crew: crew };
  }

  async function crewDoc(db, pid) { var l = await db.listCrew(); for (var i = 0; i < l.length; i++) if (l[i].id === pid) return l[i]; return null; }
  async function thresholdsFor(db, pid) { var c = await crewDoc(db, pid), m = await db.getMission(); return E.profile(await db.getOverride(pid), c && c.baseline, pid, m && m.launch); }

  /* Re-evaluate one person. mode 'reading' raises only; 'tick' also clears (hysteresis). */
  async function evaluate(db, pid, now, mode) {
    var rs = await db.readings(pid, now - 4 * D, now);
    if (db.readingsK) { // longer history for the trend rules; if the index is still building, carry on with 4 days
      try { var have = {}; rs.forEach(function (r) { have[r.id] = 1; }); (await db.readingsK(pid, TREND_KEYS, now - 120 * D, now - 4 * D)).forEach(function (r) { if (!have[r.id]) rs.push(r); }); }
      catch (e) { if (typeof console !== 'undefined') console.warn('trend history not loaded:', e && e.message); }
    }
    var series = E.sortSeries(rs), th = await thresholdsFor(db, pid);
    var prev = await db.getStatus(pid);
    var res = E.transitions(pid, series, th, now, prev, mode);
    if (res.events.length) await emit(db, res.events.map(function (e) { e.src = 'auto'; return e; }));
    if (res.changed || !prev) await db.setStatus(pid, res.state);
    return res;
  }

  async function evaluateEnv(db, now) {
    var env = E.sortSeries(await db.env(now - 3 * H, now));
    var prev = await db.getEnvStatus();
    var res = E.envTransitions(env, now, prev);
    if (res.events.length) await emit(db, res.events.map(function (e) { e.src = 'env'; return e; }));
    await db.setEnvStatus(res.state);
  }

  /*
   * The scheduled tick (every 5 minutes): clears alerts that stayed back in range, notices silent wearables,
   * updates cabin alerts and moves the Earth outbox. earth = { external: bool } when a real ground station is configured.
   */
  async function tick(db, now, earth) {
    try { await pumpDemo(db, now); } catch (e) { if (typeof console !== 'undefined') console.warn('demo pump:', e && e.message); }
    var crew = await db.listCrew();
    for (var i = 0; i < crew.length; i++) await evaluate(db, crew[i].id, now, 'tick');
    await evaluateEnv(db, now);
    if (!earth || !earth.external) await loopbackEarth(db, now);
    return { crew: crew.length };
  }

  /*
   * Ground loopback, used until a real Earth station URL is configured:
   * records are "sent" while the link is up and count as acknowledged after one round trip at the current distance.
   */
  async function loopbackEarth(db, now) {
    var m = await db.getMission(); if (!m || m.link === false) return;
    var rtt = 2 * E.oneWay(now, m) * 1000;
    var items = await db.outbox(['queued', 'sent'], 400);
    for (var i = 0; i < items.length; i++) {
      var o = items[i];
      if (o.status === 'queued') await db.updateOutbox(o.id, { status: 'sent', sentT: now });
      else if (o.status === 'sent' && now - o.sentT >= rtt) await db.updateOutbox(o.id, { status: 'acked', ackT: now, ackBy: 'Ground loopback' });
    }
  }

  async function addReadings(db, d, meta) {
    var src = SOURCES[d.src] ? d.src : 'manual', list = Array.isArray(d.readings) ? d.readings.slice(0, 3000) : [];
    var crew = await db.listCrew(), ids = {}; crew.forEach(function (c) { ids[c.id] = 1; });
    var ok = [], rejected = [];
    list.forEach(function (r, i) {
      var e = !r || !ids[r.pid] ? 'unknown astronaut' : E.validateReading(r, meta.now);
      if (e) { rejected.push({ i: i, reason: e }); return; }
      var x = { pid: r.pid, k: r.k, t: Math.round(r.t), src: src, by: str(meta.by, 60) || null, created: meta.now };
      if (typeof r.v === 'number') x.v = r.k === 'temp' ? Math.round(r.v * 10) / 10 : Math.round(r.v * 100) / 100;
      if (typeof r.v2 === 'number') x.v2 = Math.round(r.v2);
      if (r.irr) x.irr = true;
      if (r.ctx) x.ctx = r.ctx;
      if (r.txt) x.txt = str(r.txt, 60);
      if (typeof r.l === 'number') x.l = r.l;
      if (r.x && typeof r.x === 'object') { x.x = {}; Object.keys(r.x).forEach(function (f) { if (r.x[f] != null) x.x[f] = r.x[f]; }); }
      x.sc = E.SCALE; // 4-level scale (NORMAL / ATTENTION / CAUTION / CRITICAL)
      if (r.ref) x.ref = str(r.ref, 80);
      if (r.sim) x.sim = true; // simulated filler: shown with a SIM tag, never used as a baseline
      if (d.batch) x.batch = str(d.batch, 80);
      ok.push(x);
    });
    if (ok.length) await db.addReadings(ok);
    var pids = {}; ok.forEach(function (r) { pids[r.pid] = 1; });
    var keys = Object.keys(pids);
    if (!d.noEval) for (var j = 0; j < keys.length; j++) await evaluate(db, keys[j], meta.now, 'reading');
    /* notes in an imported file (what the crew did) become crew events at their own time */
    var notes = (Array.isArray(d.notes) ? d.notes.slice(0, 500) : []).filter(function (n) { return n && ids[n.pid] && typeof n.t === 'number' && n.t <= meta.now + 5 * MIN && str(n.text, 240); });
    if (notes.length) await emit(db, notes.map(function (n) { return { t: Math.round(n.t), pid: n.pid, k: n.k || null, type: 'crew', text: str(n.text, 240), sub: str(n.sub, 200) || 'From imported file', src: 'crew', by: meta.by || null }; }));
    if (d.log && ok.length) await emit(db, [{ t: meta.now, pid: d.log.pid || (keys.length === 1 ? keys[0] : null), k: d.log.k || null, type: 'crew', text: str(d.log.text, 200), sub: str(d.log.sub, 200) || null, src: 'crew', by: meta.by || null }]);
    return { saved: ok.length, rejected: rejected };
  }

  var DEMO_BASE = {
    sarah: { hr: 64, spo2: 97.6, rr: 14, temp: 36.8, glu: 94, dose: 31.2, sleep: [7.1, 6.8], mood: 7, bp: [116, 74], ex: 100 },
    marcus: { hr: 61, spo2: 97.4, rr: 13.5, temp: 36.7, glu: 98, dose: 34.0, sleep: [5.3, 4.6], mood: 6, bp: [124, 81], ex: 60 },
    mei: { hr: 67, spo2: 97.8, rr: 16, temp: 36.9, glu: 92, dose: 28.6, sleep: [7.0, 6.3], mood: 8, bp: [113, 72], ex: 95 },
    john: { hr: 59, spo2: 97.9, rr: 13, temp: 36.7, glu: 96, dose: 30.1, sleep: [7.2, 6.7], mood: 7, bp: [121, 79], ex: 100 },
    elena: { hr: 53, spo2: 98.0, rr: 13, temp: 36.6, glu: 90, dose: 27.9, sleep: [7.0, 6.8], mood: 8, bp: [111, 70], ex: 95 },
    david: { hr: 62, spo2: 97.7, rr: 14, temp: 36.7, glu: 95, dose: 32.4, sleep: [6.9, 7.2], mood: 7, bp: [119, 77], ex: 90 },
    robert: { hr: 58, spo2: 97.3, rr: 13.5, temp: 36.6, glu: 101, dose: 33.1, sleep: [6.6, 6.9], mood: 7, bp: [126, 80], ex: 85 },
    maya: { hr: 66, spo2: 98.1, rr: 15, temp: 36.8, glu: 91, dose: 29.3, sleep: [7.4, 7.0], mood: 8, bp: [110, 69], ex: 100 },
    amara: { hr: 60, spo2: 98.2, rr: 14, temp: 36.7, glu: 93, dose: 28.9, sleep: [7.3, 7.1], mood: 9, bp: [114, 73], ex: 100 }
  };
  /*
   * Demo scenario: writes about 3 hours of records ending now, marked source "demo", for the video and judges.
   * Sarah develops a fast irregular heart rhythm (CRITICAL), Marcus is short on sleep (ATTENTION) and his
   * orthostatic blood-pressure test shows a drop (CAUTION),
   * Elena's watch stops reporting (NO DATA), cabin CO₂ drifts up (CAUTION).
   */
  async function runDemo(db, meta) {
    var now = Math.floor(meta.now / MIN) * MIN, crew = await db.listCrew(), have = {}, out = [], env = [];
    crew.forEach(function (c) { have[c.id] = 1; });
    var seed = 7; function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
    function g() { return (rnd() + rnd() + rnd() - 1.5) * 1.15; }
    var t0 = now - 3 * H, today6 = dayStartUTC(now) + 6 * H; if (today6 > now) today6 -= D;
    // the red-alert story is Sarah's; if Sarah was removed from the crew it moves to the first crew member who is still there
    var red = ['sarah', 'maya', 'david', 'amara', 'robert', 'mei', 'john'].filter(function (p) { return have[p]; })[0];
    Object.keys(DEMO_BASE).forEach(function (pid) {
      if (!have[pid]) return;
      var b = DEMO_BASE[pid], stop = pid === 'elena' ? now - 40 * MIN : now + 1;
      for (var t = t0; t <= now && t < stop; t += 5 * MIN) {
        var hr = b.hr + g() * 1.6, sp = b.spo2 + g() * 0.25, rr = b.rr + g() * 0.4, irr = false;
        if (pid === red && t > now - 25 * MIN) { var u = Math.min(1, (t - (now - 25 * MIN)) / (13 * MIN)); hr = b.hr + 3 + (122 - b.hr) * u + g(); if (t >= now - 12 * MIN) { hr = 141 + g() * 6; irr = true; sp = 93.7 + g() * 0.3; rr = 22.6 + g() * 0.6; } }
        out.push({ pid: pid, k: 'hr', t: t, v: Math.round(hr), irr: irr || undefined });
        out.push({ pid: pid, k: 'spo2', t: t, v: Math.round(Math.min(100, sp) * 10) / 10 });
        out.push({ pid: pid, k: 'rr', t: t, v: Math.round(rr * 10) / 10 });
        if ((t - t0) % (15 * MIN) === 0) out.push({ pid: pid, k: 'temp', t: t, v: Math.round((b.temp + g() * 0.05) * 10) / 10 });
        if ((t - t0) % (30 * MIN) === 0) out.push({ pid: pid, k: 'glu', t: t, v: Math.round(b.glu + g() * 4) });
        if ((t - t0) % H === 0) out.push({ pid: pid, k: 'dose', t: t, v: Math.round((b.dose + (t - t0) / H * 0.004) * 100) / 100 });
      }
      out.push({ pid: pid, k: 'sleep', t: today6 - D, v: b.sleep[0] });
      out.push({ pid: pid, k: 'sleep', t: today6, v: b.sleep[1] });
      out.push({ pid: pid, k: 'mood', t: Math.min(now - 2 * H, today6 + 2 * H), v: b.mood });
      out.push({ pid: pid, k: 'bp', t: Math.min(now - 2.5 * H, today6 + 1.5 * H), v: b.bp[0], v2: b.bp[1] });
      out.push({ pid: pid, k: 'ex', t: today6 - 12 * H, v: b.ex });
      if (pid === 'marcus') out.push({ pid: pid, k: 'ortho', t: now - 50 * MIN, x: { s1: 124, d1: 81, s2: 100, d2: 69, min: 3, syncope: false } });
    });
    for (var t2 = t0; t2 <= now; t2 += 10 * MIN) {
      var x = (t2 - t0) / (3 * H);
      env.push({ k: 'co2', t: t2, v: Math.round((2.2 + 1.5 * Math.max(0, x - 0.35) / 0.65 + g() * 0.08) * 100) / 100 });
      if ((t2 - t0) % (30 * MIN) === 0) env.push({ k: 'ctemp', t: t2, v: Math.round((22.3 + g() * 0.2) * 10) / 10 });
    }
    var rows = out.map(function (r) { var o = { pid: r.pid, k: r.k, t: r.t, v: r.v, src: 'demo', by: 'Demo scenario', created: meta.now, batch: 'demo-' + now }; if (r.v2 != null) o.v2 = r.v2; if (r.irr) o.irr = true; if (r.x) o.x = r.x; o.sc = E.SCALE; return o; });
    await db.addReadings(rows);
    await db.addEnv(env.map(function (e) { return { k: e.k, t: e.t, v: e.v, src: 'demo', created: meta.now }; }));
    await emit(db, [{ t: meta.now, pid: null, type: 'crew', text: 'Demo scenario loaded by ' + (str(meta.by, 60) || 'crew'), sub: rows.length + ' demo readings for the last 3 hours, marked DEMO', src: 'crew' }]);
    var ks = Object.keys(DEMO_BASE);
    for (var i = 0; i < ks.length; i++) if (have[ks[i]]) await evaluate(db, ks[i], meta.now, 'reading');
    await evaluateEnv(db, meta.now);
    return { saved: rows.length, env: env.length };
  }

  /*
   * ===== DEMO TOOLS (Settings › Demo tools). Not part of the real CHARM app: for the video and the judges only. =====
   * Everything written here is tagged: readings src 'demo' (live file stream) or 'demoalert' (generated alert), sim: true,
   * and every event says DEMO. State lives in system/demo (not readable by the app); mission.demoLive / mission.demoAlerts
   * tell the app what is running. pumpDemo() runs on every tick (5 min) and whenever an open app calls 'demoPump' (20 s).
   * Readings get fixed ids, so two pumps at the same time never store a row twice.
   */
  var DEMO_ALERT_MIN = 5;
  var TREND_KEYS = ['wt', 'blood', 'vision', 'fluid']; // rules that look back weeks (body mass, hemoglobin, vision self test)
  async function demoState(db) { return (db.getDemo && (await db.getDemo())) || { alerts: [] }; }
  async function demoMission(db, patch) { var m = (await db.getMission()) || {}; Object.keys(patch).forEach(function (k) { m[k] = patch[k]; }); await db.setMission(m); }
  function demoRow(r, pid, t, src, id, by, now) {
    var o = { pid: pid, k: r.k, t: t, src: src, sim: true, by: by || 'Demo tools', created: now, sc: E.SCALE, _id: id };
    if (r.x) o.x = r.x; else { o.v = r.v; if (r.v2 != null) o.v2 = r.v2; }
    if (r.irr) o.irr = true; if (r.ctx) o.ctx = r.ctx;
    return o;
  }
  async function demoLiveStart(db, d, meta) {
    var pid = str(d.pid, 40), c = await crewDoc(db, pid); if (!c) throw err('not-found', 'Unknown astronaut');
    var rows = (Array.isArray(d.rows) ? d.rows : []).slice(0, 6000).filter(function (r) { return r && typeof r.o === 'number' && r.o >= 0 && (r.note || E.RKEYS.indexOf(r.k) >= 0); })
      .map(function (r) { var o = { o: Math.round(r.o) }; if (r.note) { o.note = str(r.note, 240); return o; } o.k = r.k; if (r.x) o.x = r.x; else { o.v = r.v; if (r.v2 != null) o.v2 = r.v2; } if (r.irr) o.irr = true; if (r.ctx) o.ctx = r.ctx; return o; })
      .sort(function (a, b) { return a.o - b.o; });
    if (!rows.length) throw err('invalid-argument', 'The file has no usable rows');
    var speed = [1, 2, 5, 10].indexOf(d.speed) >= 0 ? d.speed : 1, startAt = Math.max(0, Math.min(rows[rows.length - 1].o, Math.round(d.startAt || 0)));
    var now = meta.now, id = 'L' + now.toString(36), span = rows[rows.length - 1].o + 5 * MIN, name = str(d.name, 80) || 'Demo file';
    // history before the start point goes in at once (in the past), the rest streams in as time passes
    var back = [], notes = [], next = 0;
    for (var i = 0; i < rows.length && rows[i].o < startAt; i++) {
      var tt = now - Math.round((startAt - rows[i].o) / speed);
      if (rows[i].note) notes.push({ id: 'dn' + id + '-0-' + i, t: tt, pid: pid, type: 'crew', text: rows[i].note, sub: 'DEMO · live demo file · ' + name, src: 'crew', sim: true, replayed: true });
      else back.push(demoRow(rows[i], pid, tt, 'demo', 'dl' + id + '-0-' + i, meta.by, now));
      next = i + 1;
    }
    var ok = back.filter(function (r) { return !E.validateReading(r, now); });
    if (ok.length) await db.addReadings(ok);
    if (notes.length) await db.addEvents(notes);
    var st = await demoState(db);
    st.live = { id: id, pid: pid, name: name, rows: rows, startAt: startAt, t0: now, speed: speed, loop: d.loop !== false, span: span, next: next, cycle: 0, by: meta.by || null };
    await db.setDemo(st);
    await demoMission(db, { demoLive: { id: id, pid: pid, name: name, speed: speed, started: now, loop: d.loop !== false, by: meta.by || null } });
    await emit(db, [{ t: now, pid: pid, type: 'crew', text: 'DEMO · live demo file started: ' + name, sub: 'Not real data · ' + c.name + ' · ' + speed + '× speed' + (d.loop !== false ? ' · repeats at the end' : '') + ' · started by ' + (meta.by || 'crew'), src: 'crew', sim: true, prio: 0 }]);
    await evaluate(db, pid, now, 'reading');
    return { ok: true, backfilled: ok.length, rows: rows.length };
  }
  async function demoLiveStop(db, meta) {
    var st = await demoState(db), lv = st.live; st.live = null; await db.setDemo(st);
    await demoMission(db, { demoLive: null });
    if (lv) await emit(db, [{ t: meta.now, pid: lv.pid, type: 'crew', text: 'DEMO · live demo file stopped: ' + lv.name, sub: 'Stopped by ' + (meta.by || 'crew'), src: 'crew', sim: true, prio: 0 }]);
    return { ok: true };
  }
  async function demoAlert(db, d, meta) {
    var pid = str(d.pid, 40), c = await crewDoc(db, pid); if (!c) throw err('not-found', 'Unknown astronaut');
    var k = str(d.k, 20), level = d.level, now = meta.now, th = await thresholdsFor(db, pid);
    var g = E.demoReading(k, level, th, now); if (!g) throw err('invalid-argument', 'This level is not possible for this measurement');
    var id = 'A' + now.toString(36) + Math.random().toString(36).slice(2, 5), until = now + DEMO_ALERT_MIN * MIN;
    var rows = g.abn.map(function (r, i) { return demoRow(r, pid, now - (r.back || 0), 'demoalert', 'da' + id + '-a' + i, meta.by, now); });
    await db.addReadings(rows);
    var st = await demoState(db); st.alerts = (st.alerts || []).filter(function (a) { return a.due > now - H; });
    st.alerts.push({ id: id, pid: pid, k: k, level: level, due: until, norm: g.norm, by: meta.by || null }); await db.setDemo(st);
    var m = (await db.getMission()) || {}, list = (m.demoAlerts || []).filter(function (a) { return a.until > now; });
    list.push({ id: id, pid: pid, k: k, l: level, until: until, text: g.text }); m.demoAlerts = list; await db.setMission(m);
    await emit(db, [{ t: now, pid: pid, k: k, type: 'crew', text: 'DEMO ALERT generated · ' + E.MDEF[k].label + ' ' + E.WORD[String(level)], sub: 'Not a real reading · ' + c.name + ' · demo value ' + g.text + ' · back to normal in ' + DEMO_ALERT_MIN + ' min · by ' + (meta.by || 'crew'), src: 'crew', sim: true, prio: 0 }]);
    await evaluate(db, pid, now, 'reading');
    return { ok: true, id: id, until: until, text: g.text };
  }
  async function pumpDemo(db, now) {
    if (!db.getDemo) return { rows: 0 };
    var st = await demoState(db), lv = st.live, wrote = 0, ended = [], changed = false;
    if (lv && lv.rows && lv.rows.length) {
      var fileNow = lv.startAt + (now - lv.t0) * lv.speed, out = [], notes = [];
      while (out.length + notes.length < 800) {
        if (lv.next >= lv.rows.length) { if (!lv.loop) break; lv.next = 0; lv.cycle++; }
        var r = lv.rows[lv.next], ft = r.o + lv.cycle * lv.span; if (ft > fileNow) break;
        var t = Math.min(now, lv.t0 + Math.round((ft - lv.startAt) / lv.speed)), key = lv.id + '-' + lv.cycle + '-' + lv.next;
        if (r.note) notes.push({ id: 'dn' + key, t: t, pid: lv.pid, type: 'crew', text: r.note, sub: 'DEMO · live demo file · ' + lv.name, src: 'crew', sim: true });
        else { var row = demoRow(r, lv.pid, t, 'demo', 'dl' + key, lv.by, now); if (!E.validateReading(row, now)) out.push(row); }
        lv.next++; changed = true;
      }
      if (out.length) await db.addReadings(out);
      if (notes.length) await emit(db, notes);
      wrote += out.length;
      if (out.length || notes.length) await evaluate(db, lv.pid, now, 'reading');
    }
    var due = (st.alerts || []).filter(function (a) { return a.due <= now; });
    for (var i = 0; i < due.length; i++) {
      var a = due[i];
      await db.addReadings(a.norm.map(function (r, j) { return demoRow(r, a.pid, a.due, 'demoalert', 'da' + a.id + '-n' + j, a.by, now); }));
      // a demo alert goes back to normal at once (real alerts need 3 checks in range): three checks in a row clear it
      for (var q = 0; q < 3; q++) await evaluate(db, a.pid, now, 'tick');
      await emit(db, [{ id: 'de' + a.id, t: Math.min(now, a.due), pid: a.pid, k: a.k, type: 'crew', text: 'DEMO ALERT ended · ' + E.MDEF[a.k].label + ' back to normal', sub: 'Demo values replaced by a normal value after ' + DEMO_ALERT_MIN + ' min', src: 'crew', sim: true, prio: 0 }]);
      ended.push(a.id); changed = true;
    }
    if (changed) {
      st.alerts = (st.alerts || []).filter(function (a) { return ended.indexOf(a.id) < 0; });
      await db.setDemo(st);
      if (ended.length) { var m = (await db.getMission()) || {}; m.demoAlerts = (m.demoAlerts || []).filter(function (x) { return ended.indexOf(x.id) < 0 && x.until > now - MIN; }); await db.setMission(m); }
    }
    return { rows: wrote, ended: ended.length };
  }

  /*
   * Replay alert logic over imported history, every 5 minutes from the first imported reading (at most 14 days back) to now,
   * so Alerts and history shows when each alert was raised and cleared, at the time it happened.
   */
  async function replay(db, d, meta) {
    var pids = Array.isArray(d.pids) ? d.pids.slice(0, 20) : [], out = 0;
    for (var i = 0; i < pids.length; i++) {
      var pid = pids[i]; if (!(await crewDoc(db, pid))) continue;
      var from = Math.max(typeof d.from === 'number' ? d.from : meta.now - D, meta.now - 14 * D), now = meta.now;
      var series = E.sortSeries(await db.readings(pid, from - 4 * D, now)), th = await thresholdsFor(db, pid);
      var state = null, evs = [];
      for (var t = Math.floor(from / (5 * MIN)) * 5 * MIN; t <= now; t += 5 * MIN) {
        var res = E.transitions(pid, series, th, t, state, 'tick'); state = res.state;
        res.events.forEach(function (e) { e.src = 'auto'; e.replayed = true; evs.push(e); });
      }
      var fin = E.transitions(pid, series, th, now, state, 'reading'); fin.events.forEach(function (e) { e.src = 'auto'; evs.push(e); });
      if (evs.length) await emit(db, evs.slice(-400));
      await db.setStatus(pid, fin.state); out += evs.length;
      // one summary record goes to Earth, so the flight surgeon sees what the imported history contained
      var raised = evs.filter(function (e) { return e.type === 'raise'; }), byLv = {};
      raised.forEach(function (e) { byLv[e.lv] = (byLv[e.lv] || 0) + 1; });
      var names = { 3: 'critical', 2: 'caution', 1: 'attention' }, parts = [3, 2, 1].filter(function (l) { return byLv[l]; }).map(function (l) { return byLv[l] + ' ' + names[l]; });
      await emit(db, [{ t: meta.now, pid: pid, type: 'crew', text: 'Imported history checked · ' + (raised.length ? raised.length + ' alert' + (raised.length > 1 ? 's' : '') + ' (' + parts.join(', ') + ')' : 'no alerts'), sub: 'Full timeline in Alerts and history', src: 'crew', prio: byLv[3] ? 2 : raised.length ? 1 : 0, by: meta.by || null }]);
    }
    return { events: out };
  }

  /* The single entry point the app calls. meta = { now, by }. */
  async function api(db, op, d, meta) {
    d = d || {}; meta = meta || {}; meta.now = meta.now || Date.now(); meta.by = str(d.by || meta.by, 60);
    switch (op) {
      case 'bootstrap': return bootstrap(db, meta.now);
      case 'addReadings': return addReadings(db, d, meta);
      case 'addEnv': {
        var items = (Array.isArray(d.items) ? d.items : []).slice(0, 2000), ok = [], bad = [];
        items.forEach(function (e, i) { var x = E.validateEnv(e, meta.now); if (x) bad.push({ i: i, reason: x }); else ok.push({ k: e.k, t: Math.round(e.t), v: e.v, src: SOURCES[d.src] ? d.src : 'manual', by: meta.by || null, created: meta.now }); });
        if (d.src === 'import') { // the same file imported twice, or 4 crew files with the same dates, must not duplicate points
          var keep = [];
          for (var q = 0; q < ok.length; q++) { var ex = await db.env(ok[q].t, ok[q].t); if (!ex.some(function (x) { return x.k === ok[q].k; })) keep.push(ok[q]); }
          ok = keep;
        }
        if (ok.length) await db.addEnv(ok);
        await evaluateEnv(db, meta.now);
        return { saved: ok.length, rejected: bad };
      }
      case 'addCrew': {
        var name = str(d.name, 60); if (!name) throw err('invalid-argument', 'Name is required');
        var crew = await db.listCrew(), used = {}; crew.forEach(function (c) { used[c.id] = c; });
        var full = name.toLowerCase();
        for (var c in used) if ((used[c].full || used[c].name).toLowerCase() === full) return { id: c, existed: true };
        var id = slug(name), n = 2; while (used[id]) id = slug(name) + (n++);
        var p = { id: id, name: name.split(/\s+/)[0], full: name, role: str(d.role, 60) || 'Crew member', agency: (str(d.agency, 12) || 'NASA').toUpperCase(), img: null, order: crew.length + 1, created: meta.now };
        await db.setCrew(id, p);
        var mr = await db.getMission(); if (mr && mr.removed && mr.removed.indexOf(id) >= 0) { mr.removed = mr.removed.filter(function (x) { return x !== id; }); await db.setMission(mr); }
        await emit(db, [{ t: meta.now, pid: id, type: 'crew', text: 'New crew member added: ' + p.full, sub: p.role + ' · ' + p.agency + (d.via ? ' · ' + str(d.via, 80) : ''), src: 'crew' }]);
        return { id: id, existed: false };
      }
      case 'logEvent': {
        if (!EVENT_TYPES[d.type]) throw err('invalid-argument', 'Unknown event type');
        var ev = { t: meta.now, pid: d.pid || null, k: d.k || null, type: d.type, text: str(d.text, 240), sub: str(d.sub, 240) || null, src: 'crew', by: meta.by || null };
        if (d.id) ev.id = str(d.id, 60);
        if (d.taskId) ev.taskId = str(d.taskId, 60);
        if (!ev.text) throw err('invalid-argument', 'Text is required');
        await emit(db, [ev]);
        return { ok: true };
      }
      case 'message': {
        var tx = str(d.text, 1000); if (!tx) throw err('invalid-argument', 'Message is empty');
        await emit(db, [{ t: meta.now, pid: d.pid || null, type: 'msg', text: 'Message to flight surgeon', sub: tx, src: 'crew', by: meta.by || null, prio: d.prio ? 2 : 0 }]);
        return { ok: true };
      }
      case 'setThresholds': {
        var pids = Array.isArray(d.pids) ? d.pids : [], ch = d.changes || {}, keys = Object.keys(ch), why = str(d.why, 200) || 'Set in CHARM';
        if (!pids.length || !keys.length) throw err('invalid-argument', 'Nothing to change');
        keys.forEach(function (key) { var a = key.split('.'); if (!E.THF[a[0]] || !E.THF[a[0]].some(function (f) { return f[0] === a[1]; }) || typeof ch[key] !== 'number' || !isFinite(ch[key])) throw err('invalid-argument', 'Bad threshold ' + key); });
        var problems = [], next = {};
        for (var i = 0; i < pids.length; i++) {
          var o = E.clone((await db.getOverride(pids[i])) || {});
          keys.forEach(function (key) { var a = key.split('.'); o[a[0]] = o[a[0]] || {}; o[a[0]][a[1]] = { v: ch[key], by: meta.by || 'Crew Medical Officer', when: meta.now, why: why }; });
          var cd = await crewDoc(db, pids[i]), bad = E.checkProfile(E.profile(o, cd && cd.baseline, pids[i])); if (bad.length) problems.push(pids[i] + ' (' + bad.join(', ') + ')');
          next[pids[i]] = o;
        }
        if (problems.length) throw err('failed-precondition', 'Limits would be out of order for ' + problems.join('; '));
        for (var p2 in next) { await db.setOverride(p2, next[p2]); await evaluate(db, p2, meta.now, 'reading'); }
        await emit(db, pids.map(function (pid) { return { t: meta.now, pid: pid, type: 'crew', text: 'Alert thresholds changed: ' + keys.map(function (k) { var a = k.split('.'); return E.MDEF[a[0]].short + ' ' + a[1] + ' = ' + ch[k]; }).join(', '), sub: why + ' · by ' + (meta.by || 'Crew Medical Officer'), src: 'crew' }; }));
        return { ok: true };
      }
      case 'resetThreshold': {
        var rp = Array.isArray(d.pids) ? d.pids : [], done = [];
        for (var j = 0; j < rp.length; j++) { var ov = (await db.getOverride(rp[j])) || {}; if (ov[d.k] && ov[d.k][d.f]) { delete ov[d.k][d.f]; await db.setOverride(rp[j], ov); done.push(rp[j]); } }
        if (done.length) await emit(db, done.map(function (pid) { return { t: meta.now, pid: pid, type: 'crew', text: 'Threshold reset to profile: ' + (E.MDEF[d.k] || {}).label + ' ' + d.f, sub: 'by ' + (meta.by || 'crew'), src: 'crew' }; }));
        return { reset: done.length };
      }
      case 'setMission': {
        var m = (await db.getMission()) || {};
        if (d.name != null) m.name = str(d.name, 80) || m.name;
        if (d.env != null) { if (['mars', 'moon', 'iss'].indexOf(d.env) < 0) throw err('invalid-argument', 'Unknown environment'); m.env = d.env; }
        if (d.launch != null) { if (typeof d.launch !== 'number' || d.launch > meta.now + 400 * D || d.launch < meta.now - 3000 * D) throw err('invalid-argument', 'Bad launch date'); m.launch = d.launch; }
        await db.setMission(m);
        await emit(db, [{ t: meta.now, pid: null, type: 'crew', text: 'Mission settings changed', sub: [m.name, m.env, new Date(m.launch).toISOString().slice(0, 10)].join(' · ') + ' · by ' + (meta.by || 'crew'), src: 'crew' }]);
        return { ok: true };
      }
      case 'setLink': {
        var mm = (await db.getMission()) || {}; mm.link = !!d.up; await db.setMission(mm);
        await db.addEvents([{ t: meta.now, pid: null, type: 'link', text: d.up ? 'Earth link restored · queue sending' : 'Earth link lost · records queue on board', sub: 'Set by ' + (meta.by || 'crew'), src: 'earth' }]);
        return { ok: true };
      }
      case 'runDemo': return runDemo(db, meta);
      case 'demoLiveStart': return demoLiveStart(db, d, meta);
      case 'demoLiveStop': return demoLiveStop(db, meta);
      case 'demoAlert': return demoAlert(db, d, meta);
      case 'demoPump': return pumpDemo(db, meta.now);
      case 'setBaseline': {
        var bc = await crewDoc(db, d.pid); if (!bc) throw err('not-found', 'Unknown astronaut');
        var B = {}, lim = { hr: [25, 230], sbp: [60, 250], dbp: [30, 160], rr: [4, 60], temp: [33, 42.5] };
        Object.keys(lim).forEach(function (m) { var x = d.base && d.base[m]; if (x && typeof x.mean === 'number' && x.mean >= lim[m][0] && x.mean <= lim[m][1] && x.n >= 1) B[m] = { mean: Math.round(x.mean * 100) / 100, n: Math.round(x.n), sd: typeof x.sd === 'number' ? Math.round(x.sd * 100) / 100 : null }; });
        if (!Object.keys(B).length) throw err('invalid-argument', 'No usable baseline values');
        B.set = meta.now; B.via = str(d.via, 120) || 'Set in CHARM'; B.by = meta.by || null;
        await db.setCrew(bc.id, Object.assign({}, bc, { baseline: B }));
        var offs = E.personalOffsets(B), parts = Object.keys(offs).map(function (m) { var o = offs[m]; return m.toUpperCase() + ' ' + o.mean.toFixed(m === 'temp' ? 1 : 0) + ' (' + (o.off > 0 ? '+' : '') + o.off + (o.capped ? ', capped' : '') + ')'; });
        await emit(db, [{ t: meta.now, pid: bc.id, type: 'crew', text: 'Personal baseline set · attention limits adjusted', sub: (parts.join(' · ') || 'fewer than 5 baseline readings: common limits kept') + ' · ' + B.via, src: 'crew', by: meta.by || null }]);
        await evaluate(db, bc.id, meta.now, 'reading');
        return { ok: true, offsets: offs };
      }
      case 'replay': return replay(db, d, meta);
      case 'pushRegister': {
        var tok = str(d.token, 4096); if (tok.length < 20) throw err('invalid-argument', 'Missing phone token');
        var who = d.pid === 'shared' ? 'shared' : (await crewDoc(db, d.pid)) ? d.pid : null; if (!who) throw err('invalid-argument', 'Unknown astronaut');
        await db.setPush(pushId(tok), { token: tok, pid: who, device: str(d.device, 80) || null, updated: meta.now });
        return { ok: true, pid: who };
      }
      case 'pushUnregister': { var tk = str(d.token, 4096); if (tk) await db.delPush(pushId(tk)); return { ok: true }; }
      case 'pushTest': {
        var tt = str(d.token, 4096); if (tt.length < 20) throw err('invalid-argument', 'Missing phone token');
        var lvT = d.l === 2 ? 2 : 3;
        var r = await db.sendPush([tt], { l: String(lvT), pid: '', name: 'Test', k: '', text: 'Test alert from CHARM: this phone gets ' + (lvT === 3 ? 'CRITICAL' : 'CAUTION') + ' alerts', sub: 'Nothing is wrong. Sent by ' + (meta.by || 'crew'), t: String(meta.now), id: '', sim: '' });
        if (r && r.invalid && r.invalid.length) { await db.delPush(pushId(tt)); throw err('failed-precondition', 'This phone is no longer registered. Turn alerts on again.'); }
        return { ok: true };
      }
      /*
       * Delete an astronaut's data (mode 'data': readings, alerts, logs, baseline, limits; the crew member stays)
       * or remove the astronaut from the system (mode 'all'). Irreversible, so the exact name must be typed.
       * One audit record (without health data) is kept and sent to Earth.
       */
      case 'removeCrew': {
        var rc = await crewDoc(db, d.pid); if (!rc) throw err('not-found', 'Unknown astronaut');
        var mode = d.mode === 'all' ? 'all' : 'data';
        if (str(d.confirm, 80).toLowerCase() !== String(rc.full || rc.name).toLowerCase() && str(d.confirm, 80).toLowerCase() !== String(rc.name).toLowerCase()) throw err('failed-precondition', 'Type the astronaut\'s name to confirm');
        var n = await db.purge(rc.id);
        if (mode === 'all') {
          await db.deleteCrew(rc.id);
          var mm2 = (await db.getMission()) || {}; mm2.removed = (mm2.removed || []).filter(function (x) { return x !== rc.id; }).concat([rc.id]); await db.setMission(mm2);
        } else {
          var keep = Object.assign({}, rc); delete keep.baseline; await db.setCrew(rc.id, keep);
        }
        var what = n.readings + ' readings, ' + n.events + ' alerts and logs, ' + n.outbox + ' Earth records';
        await emit(db, [{ t: meta.now, pid: null, type: 'crew', text: (mode === 'all' ? 'Crew member removed from CHARM: ' : 'All health data deleted: ') + (rc.full || rc.name), sub: 'Deleted ' + what + (meta.by ? ' · by ' + meta.by : ''), src: 'crew', by: meta.by || null }]);
        return { ok: true, mode: mode, deleted: n };
      }
      default: throw err('invalid-argument', 'Unknown operation ' + op);
    }
  }

  return { pushId: pushId, api: api, tick: tick, pumpDemo: pumpDemo, evaluate: evaluate, evaluateEnv: evaluateEnv, bootstrap: bootstrap, SEED_CREW: SEED_CREW, outboxFor: outboxFor };
});
