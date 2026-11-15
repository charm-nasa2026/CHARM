// Run: node --test test/   (no dependencies)
const test = require('node:test'), assert = require('node:assert');
const E = require('../shared/engine.js'), C = require('../shared/core.js'), MemDB = require('../shared/memdb.js');
const MIN = 60000, H = 3600000;
const NOW = Date.UTC(2026, 10, 14, 14, 0);

test('bootstrap seeds 9 crew profiles with no readings', async () => {
  const db = new MemDB(); await C.api(db, 'bootstrap', {}, { now: NOW });
  const crew = await db.listCrew();
  assert.deepStrictEqual(crew.map(c => c.name), ['Sarah', 'Marcus', 'Mei', 'John', 'Elena', 'David', 'Robert', 'Maya', 'Amara']);
  assert.strictEqual(db.readingsL.length, 0);
  assert.strictEqual(db.events.length, 0);
  const m = await db.getMission(); assert.strictEqual(E.missionDay(NOW, m.launch), 1);
});

test('bootstrap adds new built-in crew to an existing database', async () => {
  const db = new MemDB();
  for (const c of C.SEED_CREW.slice(0, 5)) await db.setCrew(c.id, Object.assign({}, c));
  await C.api(db, 'bootstrap', {}, { now: NOW });
  const crew = await db.listCrew();
  assert.strictEqual(crew.length, 9);
  assert.strictEqual(crew.find(c => c.id === 'amara').face, 'assets/amara-face.png');
});

test('empty crew member is NO DATA, never green', async () => {
  const st = E.personStatus({}, E.profile(null), NOW);
  assert.strictEqual(st.lvl, -1);
});

test('manual readings validate, store and drive status', async () => {
  const db = new MemDB(); await C.api(db, 'bootstrap', {}, { now: NOW });
  const r = await C.api(db, 'addReadings', { src: 'manual', readings: [
    { pid: 'sarah', k: 'bp', t: NOW - 10 * MIN, v: 150, v2: 85 },
    { pid: 'sarah', k: 'hr', t: NOW - 10 * MIN, v: 400 },          // implausible
    { pid: 'nobody', k: 'hr', t: NOW, v: 60 },                       // unknown crew
    { pid: 'sarah', k: 'glu', t: NOW + H, v: 90 }                    // future
  ], by: 'John' }, { now: NOW });
  assert.strictEqual(r.saved, 1); assert.strictEqual(r.rejected.length, 3);
  const ev = db.events.filter(e => e.type === 'raise');
  assert.strictEqual(ev.length, 1); assert.strictEqual(ev[0].k, 'bp'); assert.strictEqual(ev[0].lv, 1);
  assert.strictEqual(db.outboxL.length, 1);
});

test('hysteresis: raise at once, clear only after 3 ticks back in range', async () => {
  const db = new MemDB(); await C.api(db, 'bootstrap', {}, { now: NOW });
  const add = (t, v) => C.api(db, 'addReadings', { src: 'import', readings: [{ pid: 'mei', k: 'temp', t, v }] }, { now: t });
  await add(NOW, 38.4);
  assert.strictEqual(db.events.filter(e => e.type === 'raise' && e.k === 'temp').length, 1);
  await add(NOW + 5 * MIN, 37.0);
  await C.tick(db, NOW + 5 * MIN); await C.tick(db, NOW + 10 * MIN);
  assert.strictEqual(db.events.filter(e => e.type === 'clear' && e.k === 'temp').length, 0);
  await add(NOW + 14 * MIN, 37.0);
  await C.tick(db, NOW + 15 * MIN);
  assert.strictEqual(db.events.filter(e => e.type === 'clear' && e.k === 'temp').length, 1);
});

test('thresholds: personal override changes the level, bad order is refused', async () => {
  const db = new MemDB(); await C.api(db, 'bootstrap', {}, { now: NOW });
  await C.api(db, 'addReadings', { src: 'manual', readings: [{ pid: 'elena', k: 'hr', t: NOW, v: 46 }] }, { now: NOW });
  assert.ok(db.events.some(e => e.type === 'raise' && e.k === 'hr'));
  await C.api(db, 'setThresholds', { pids: ['elena'], changes: { 'hr.cLo': 44, 'hr.xLo': 38 }, why: 'athlete' }, { now: NOW + MIN });
  const o = await db.getOverride('elena'); assert.strictEqual(o.hr.cLo.v, 44);
  await assert.rejects(C.api(db, 'setThresholds', { pids: ['elena', 'mei'], changes: { 'hr.cLo': 30 } }, { now: NOW }), /out of order/);
});

test('demo scenario reproduces the story', async () => {
  const db = new MemDB(); await C.api(db, 'bootstrap', {}, { now: NOW });
  const r = await C.api(db, 'runDemo', { by: 'Yarin' }, { now: NOW });
  assert.ok(r.saved > 500);
  assert.ok(db.readingsL.every(x => x.src === 'demo'));
  const lv = {};
  for (const id of ['sarah', 'marcus', 'mei', 'john', 'elena']) {
    const s = E.sortSeries(await db.readings(id, NOW - 4 * 24 * H, NOW));
    lv[id] = E.personStatus(s, E.profile(await db.getOverride(id)), NOW);
  }
  assert.strictEqual(lv.sarah.lvl, 3); assert.ok(lv.sarah.m.hr.val.irr);
  assert.strictEqual(lv.marcus.lvl, 2); assert.strictEqual(lv.marcus.top, 'c_orth'); assert.strictEqual(lv.marcus.m.sleep.l, 1);
  assert.strictEqual(lv.elena.lvl, -1);
  assert.strictEqual(lv.john.lvl, 0);
  assert.ok(db.events.some(e => e.pid === 'sarah' && e.type === 'raise' && e.lv === 3));
  await C.tick(db, NOW + 5 * MIN);
  assert.ok(db.events.some(e => e.pid === 'elena' && e.type === 'nodata'));
  assert.ok(db.events.some(e => e.k === 'co2'));
  const crit = db.outboxL.filter(o => o.prio === 2); assert.ok(crit.length >= 1);
});

test('earth loopback: sent while link is up, acked after one round trip', async () => {
  const db = new MemDB(); await C.api(db, 'bootstrap', {}, { now: NOW });
  await C.api(db, 'message', { text: 'hello', pid: 'john' }, { now: NOW });
  await C.tick(db, NOW + MIN);
  assert.strictEqual(db.outboxL[0].status, 'sent');
  await C.tick(db, NOW + 2 * MIN);
  assert.strictEqual(db.outboxL[0].status, 'acked'); // Mission Day 1: ship is still close to Earth
  await C.api(db, 'setLink', { up: false }, { now: NOW + 3 * MIN });
  await C.api(db, 'message', { text: 'second', pid: 'john' }, { now: NOW + 3 * MIN });
  await C.tick(db, NOW + 4 * MIN);
  assert.strictEqual(db.outboxL[1].status, 'queued');
});

test('new crew member via addCrew, duplicate names reuse the record', async () => {
  const db = new MemDB(); await C.api(db, 'bootstrap', {}, { now: NOW });
  const a = await C.api(db, 'addCrew', { name: 'Nathan Gagnon', agency: 'csa', role: 'Flight Engineer' }, { now: NOW });
  assert.strictEqual(a.id, 'nathan');
  const b = await C.api(db, 'addCrew', { name: 'Nathan Gagnon' }, { now: NOW });
  assert.strictEqual(b.existed, true);
  assert.strictEqual((await db.listCrew()).find(c => c.id === 'nathan').agency, 'CSA');
});

test('personal offsets only tighten caution limits, never critical, with cap and gap', () => {
  const pr = E.profile(null, { hr: { mean: 98.4, n: 13 }, sbp: { mean: 103.9, n: 16 }, temp: { mean: 36.9, n: 16 } });
  assert.strictEqual(pr.hr.cHi, 100);            // a high baseline never loosens the upper limit (team decision 15.11)
  assert.strictEqual(pr.hr.cLo, 65);             // +29 capped at +15 tightens the lower limit
  assert.strictEqual(pr.hr.xHi, 130);            // critical unchanged
  assert.strictEqual(pr.hr.xLo, 40);
  assert.strictEqual(pr.bp.sCL, 90);             // a low baseline never loosens the lower limit either
  assert.strictEqual(pr._personal.offsets.hr.capped, true);
  const low = E.profile(null, { hr: { mean: 52, n: 10 } });
  assert.strictEqual(low.hr.cLo, 50);            // low baseline: the lower limit is not loosened
  assert.strictEqual(low.hr.cHi, 85);            // ...and the upper limit tightens by -15
  const few = E.profile(null, { hr: { mean: 52, n: 3 } });
  assert.strictEqual(few.hr.cLo, 50);            // fewer than 5 baseline readings: no offset
  const hiBp = E.profile(null, { sbp: { mean: 130, n: 10 } });
  assert.strictEqual(hiBp.bp.sC, 140);           // usual 130: 155 must still be ATTENTION
  assert.strictEqual(E.levelOf('bp', { v: 155, v2: 80, t: NOW }, hiBp.bp), E.ATT);
});

test('CHARM model bands: ATTENTION when unusual for the person, never looser than common, off when overridden', () => {
  assert.ok(E.MODEL.crew.sarah && E.MODEL.crew.sarah.b.sbp, 'model block has Sarah');
  const launch = NOW - 59 * 86400e3;                                   // mission day 60
  const pr = E.profile(null, null, 'sarah', launch);
  const b = E.modelBand(pr.bp._pm, 'sbp', NOW);
  assert.ok(b && b[2] < 140, 'Sarah systolic band is tighter than the common 140');
  const val = { v: Math.ceil(b[2] + 1), v2: 70, t: NOW };
  assert.strictEqual(E.levelOf('bp', val, pr.bp), E.ATT);               // unusual for her
  assert.ok(/CHARM model/.test(val.pm));
  assert.strictEqual(E.levelOf('bp', { v: Math.floor(b[2] - 1), v2: 70, t: NOW }, pr.bp), 0);
  assert.strictEqual(E.levelOf('bp', { v: 185, v2: 70, t: NOW }, pr.bp), E.CRI);  // critical unchanged
  assert.strictEqual(E.levelOf('bp', { v: Math.ceil(b[2] + 1), v2: 70, t: NOW, ex: true }, pr.bp), 0); // not during exercise
  const ov = E.profile({ bp: { sC: { v: 150, by: 'Flight surgeon' } } }, null, 'sarah', launch);
  assert.ok(!ov.bp._pm || !ov.bp._pm.b.sbp, 'a hand-set systolic limit switches the model band off');
  assert.strictEqual(E.profile(null, null, 'marcus', launch).hr._pm, undefined); // no personal vitals in the model data
});

test('SpO2 uses NEWS2 bands; body mass is followed over 14 and 30 days', () => {
  const th = E.profile().spo2;
  assert.strictEqual(E.levelOf('spo2', { v: 96, t: NOW }, th), 0);
  assert.strictEqual(E.levelOf('spo2', { v: 95, t: NOW }, th), E.ATT);
  assert.strictEqual(E.levelOf('spo2', { v: 93, t: NOW }, th), E.CAU);
  assert.strictEqual(E.levelOf('spo2', { v: 91, t: NOW }, th), E.CRI);
  const D = 86400e3, mk = (loss30) => { const s = []; for (let d = 30; d >= 0; d -= 2) s.push({ k: 'wt', t: NOW - d * D, v: 80 * (1 - loss30 / 100 * (30 - d) / 30), src: 'manual' }); return E.sortSeries(s); };
  const lvl = (loss) => { const v = E.valueAt(mk(loss), 'wt', NOW); return E.levelOf('wt', v, E.profile().wt); };
  assert.strictEqual(lvl(1), 0);
  assert.strictEqual(lvl(4.5), E.ATT);           // > 2 % in 14 days
  assert.strictEqual(lvl(7), E.CAU);             // > 5 % in 30 days
  assert.strictEqual(lvl(12), E.CRI);            // > 10 % in 30 days
});

test('setBaseline stores the baseline and alerts use personal limits', async () => {
  const db = new MemDB(); await C.api(db, 'bootstrap', {}, { now: NOW });
  await C.api(db, 'setBaseline', { pid: 'elena', base: { hr: { mean: 98, n: 13 } }, via: 'test' }, { now: NOW });
  await C.api(db, 'addReadings', { src: 'record', readings: [{ pid: 'elena', k: 'hr', t: NOW - 60000, v: 104 }] }, { now: NOW });
  const st = await db.getStatus('elena');
  assert.strictEqual(st.levels.hr, 1);           // 104 is above the common 100: ATTENTION even though her usual HR is high
  await C.api(db, 'addReadings', { src: 'record', readings: [{ pid: 'elena', k: 'hr', t: NOW - 30000, v: 135 }] }, { now: NOW });
  assert.strictEqual((await db.getStatus('elena')).levels.hr, 3);   // critical 130 is the same for everyone
});

test('daily clinical records stay current for 26 hours; import replay logs raise and clear in the past', async () => {
  const db = new MemDB(); await C.api(db, 'bootstrap', {}, { now: NOW });
  await C.api(db, 'addReadings', { src: 'record', readings: [{ pid: 'mei', k: 'hr', t: NOW - 20 * 3600e3, v: 70 }] }, { now: NOW });
  const s = E.personStatus(E.sortSeries(await db.readings('mei', NOW - 5 * 86400e3, NOW)), E.profile(), NOW);
  assert.strictEqual(s.m.hr.l, 0);
  const rs = []; for (let m = 0; m <= 180; m += 5) rs.push({ pid: 'john', k: 'hr', t: NOW - (180 - m) * 60000, v: m >= 30 && m < 60 ? 140 : 70 });
  await C.api(db, 'addReadings', { src: 'import', noEval: true, readings: rs, notes: [{ pid: 'john', t: NOW - 140 * 60000, text: 'Rested, ECG recorded' }] }, { now: NOW });
  await C.api(db, 'replay', { pids: ['john'], from: NOW - 180 * 60000 }, { now: NOW });
  const ev = db.events.filter(e => e.pid === 'john');
  const raise = ev.find(e => e.type === 'raise' && e.k === 'hr'), clear = ev.find(e => e.type === 'clear' && e.k === 'hr');
  assert.ok(raise && clear && raise.t < clear.t && clear.t < NOW - 60 * 60000);
  assert.ok(ev.some(e => e.text === 'Rested, ECG recorded'));
  assert.strictEqual((await db.getStatus('john')).levels.hr, 0);
});

test('medic thresholds: exam results and condition alerts (4 levels)', () => {
  const p = E.profile(), at = (list) => E.personStatus(E.sortSeries(list.map(r => Object.assign({ pid: 'x', t: NOW - 60000, src: 'manual', sc: 4 }, r))), p, NOW);
  // AF: ECG >= 30 s irregular, no P waves -> CAUTION; with fainting -> CRITICAL
  assert.strictEqual(at([{ k: 'ecg', x: { irr: true, noP: true, sec: 60 } }]).m.c_af.l, 2);
  assert.strictEqual(at([{ k: 'ecg', x: { irr: true, noP: true, sec: 60 } }, { k: 'sym', x: { faint: true } }]).m.c_af.l, 3);
  // orthostatic: systolic drop 20 within 3 min -> CAUTION; fainting -> CRITICAL
  assert.strictEqual(at([{ k: 'ortho', x: { s1: 120, d1: 75, s2: 99, d2: 70, min: 3 } }]).m.c_orth.l, 2);
  assert.strictEqual(at([{ k: 'ortho', x: { s1: 120, d1: 75, s2: 110, d2: 70, min: 3, syncope: true } }]).m.c_orth.l, 3);
  // infection (alert scenario 3): 2 SIRS signs -> CAUTION; qSOFA 2 with an infection sign -> CRITICAL; one sign -> ATTENTION
  const v = [{ k: 'temp', v: 38.4 }, { k: 'hr', v: 104 }, { k: 'rr', v: 18 }];
  assert.strictEqual(at(v).m.c_inf.l, 2);
  assert.strictEqual(at([{ k: 'hr', v: 95 }]).m.c_inf.l, 1);
  assert.strictEqual(at([{ k: 'temp', v: 38.3 }]).m.c_inf.l, 2);              // temperature > 38.0 alone
  assert.strictEqual(at([{ k: 'rr', v: 24 }, { k: 'bp', v: 96, v2: 60 }]).m.c_inf.l, 3); // qSOFA 2 (RR > 20 is itself a SIRS sign)
  assert.strictEqual(at(v.concat([{ k: 'sym', x: { inf: true } }])).m.c_inf.l, 2);
  assert.strictEqual(at([{ k: 'rr', v: 24 }, { k: 'bp', v: 96, v2: 60 }, { k: 'sym', x: { inf: true } }]).m.c_inf.l, 3);
  // kidney: fluid < 2.5 L -> ATTENTION; blood in urine -> CAUTION; stone -> CRITICAL
  assert.strictEqual(at([{ k: 'fluid', v: 1.8 }]).m.c_kid.l, 1);
  assert.strictEqual(at([{ k: 'urine', x: { blood: true } }]).m.c_kid.l, 2);
  assert.strictEqual(at([{ k: 'urine', x: { us: 'stone' } }]).m.c_kid.l, 3);
  // SANS: dTRT 20 -> ATTENTION, 55 -> CRITICAL; VTE: < 10 cm/s -> CAUTION, thrombus -> CRITICAL
  assert.strictEqual(at([{ k: 'vision', x: { trt: 22 } }]).m.c_sans.l, 1);
  assert.strictEqual(at([{ k: 'vision', x: { trt: 60 } }]).m.c_sans.l, 3);
  assert.strictEqual(at([{ k: 'ijv', x: { vel: 8 } }]).m.c_vte.l, 2);
  assert.strictEqual(at([{ k: 'ijv', x: { thrombus: true } }]).m.c_vte.l, 3);
  // orthostatic (scenario 1): standing systolic <= 90 -> CRITICAL; HR +30 without a drop -> ATTENTION
  assert.strictEqual(at([{ k: 'ortho', x: { s1: 105, d1: 70, s2: 88, d2: 62, min: 2 } }]).m.c_orth.l, 3);
  assert.strictEqual(at([{ k: 'ortho', x: { s1: 120, d1: 75, s2: 118, d2: 78, min: 3, h1: 70, h2: 104 } }]).m.c_orth.l, 1);
  // glucose (scenario 5): < 70 CAUTION, < 54 CRITICAL
  assert.strictEqual(at([{ k: 'glu', v: 63 }]).m.glu.l, 2); assert.strictEqual(at([{ k: 'glu', v: 50 }]).m.glu.l, 3);
  // anemia (scenario B): Hb < 12 CAUTION, < 8 CRITICAL
  assert.strictEqual(at([{ k: 'blood', x: { hb: 11.5 } }]).m.c_anem.l, 2); assert.strictEqual(at([{ k: 'blood', x: { hb: 7.5 } }]).m.c_anem.l, 3);
  // SANS self test (scenario A): worse once -> ATTENTION, twice in a row -> CAUTION
  assert.strictEqual(at([{ k: 'vision', x: { self: 'worse' } }]).m.c_sans.l, 1);
  const two = E.personStatus(E.sortSeries([{ k: 'vision', t: NOW - 8 * 864e5, x: { self: 'worse' }, src: 'manual' }, { k: 'vision', t: NOW - 60000, x: { self: 'worse' }, src: 'manual' }]), p, NOW);
  assert.strictEqual(two.m.c_sans.l, 2);
  // personal offsets move the orange infection-screen numbers too, never the red qSOFA
  const pe = E.profile(null, { hr: { mean: 98, n: 13 } });
  assert.strictEqual(pe.inf.hr, 90); assert.strictEqual(pe.hr.xHi, 130);   // high baseline: the screen is not loosened
  const pl = E.profile(null, { hr: { mean: 55, n: 13 } });
  assert.strictEqual(pl.inf.hr, 76);                                        // low baseline: tightened
});

test('removeCrew: delete data keeps the person; remove deletes them and bootstrap does not bring them back', async () => {
  const db = new MemDB(), now = Date.UTC(2026, 10, 14, 12);
  await C.api(db, 'bootstrap', {}, { now });
  await C.api(db, 'addReadings', { src: 'manual', readings: [{ pid: 'sarah', k: 'hr', t: now - 60000, v: 72 }, { pid: 'sarah', k: 'spo2', t: now - 60000, v: 98 }] }, { now });
  await C.api(db, 'addReadings', { src: 'manual', readings: [{ pid: 'maya', k: 'hr', t: now - 60000, v: 160 }, { pid: 'david', k: 'hr', t: now - 60000, v: 70 }] }, { now });
  await assert.rejects(C.api(db, 'removeCrew', { pid: 'sarah', mode: 'all', confirm: 'wrong' }, { now }));
  let r = await C.api(db, 'removeCrew', { pid: 'maya', mode: 'data', confirm: 'Maya' }, { now });
  assert.strictEqual(r.deleted.readings, 1);
  assert.ok((await db.listCrew()).some((c) => c.id === 'maya'));
  assert.ok(!db.readingsL.some((x) => x.pid === 'maya') && !db.events.some((x) => x.pid === 'maya') && !db.outboxL.some((x) => x.pid === 'maya'));
  r = await C.api(db, 'removeCrew', { pid: 'sarah', mode: 'all', confirm: 'sarah' }, { now });
  assert.strictEqual(r.deleted.readings, 2);
  await C.api(db, 'bootstrap', {}, { now: now + 1000 });
  assert.ok(!(await db.listCrew()).some((c) => c.id === 'sarah'));
  assert.ok(db.outboxL.some((o) => /removed from CHARM: Sarah/.test(o.text)));
  assert.ok(db.readingsL.some((x) => x.pid !== 'sarah'));
});

test('phone alerts: orange only to that astronaut, red to everyone, dead tokens removed', async () => {
  const db = new MemDB(), now = Date.UTC(2026, 10, 14, 12);
  await C.api(db, 'bootstrap', {}, { now });
  const T = (s) => s + 'x'.repeat(30);
  await C.api(db, 'pushRegister', { token: T('maya'), pid: 'maya' }, { now });
  await C.api(db, 'pushRegister', { token: T('david'), pid: 'david' }, { now });
  await C.api(db, 'pushRegister', { token: T('shared'), pid: 'shared' }, { now });
  await C.api(db, 'pushRegister', { token: T('dead'), pid: 'john' }, { now });
  // orange for Maya: SIRS with suspected infection
  await C.api(db, 'addReadings', { src: 'manual', readings: [{ pid: 'maya', k: 'temp', t: now - 60000, v: 38.4 }, { pid: 'maya', k: 'hr', t: now - 60000, v: 104 }, { pid: 'maya', k: 'rr', t: now - 60000, v: 18 }, { pid: 'maya', k: 'sym', t: now - 60000, x: { inf: true } }] }, { now });
  const orange = db.sent.filter((s) => s.data.l === '2');
  assert.ok(orange.length >= 1);
  orange.forEach((s) => assert.deepStrictEqual(s.tokens, [T('maya')]));
  db.sent = [];
  // red for David: SpO2 85
  await C.api(db, 'addReadings', { src: 'manual', readings: [{ pid: 'david', k: 'spo2', t: now - 60000, v: 85 }] }, { now });
  const red = db.sent.filter((s) => s.data.l === '3');
  assert.strictEqual(red.length, 1);
  assert.strictEqual(red[0].tokens.length, 4);
  assert.strictEqual(red[0].data.name, 'David');
  assert.ok(!(await db.listPush()).some((d) => d.pid === 'john'));
  await assert.rejects(C.api(db, 'pushRegister', { token: T('x'), pid: 'nobody' }, { now }));
});

test('demo tools: generated values reach the chosen level and return to normal', () => {
  const th = E.profile(null, null, 'sarah', NOW - 59 * 86400e3);
  E.DEMO_KEYS.forEach((k) => {
    const lv = E.demoLevels(k, th, NOW);
    assert.ok(lv.length, 'some level for ' + k);
    lv.forEach((l) => {
      const g = E.demoReading(k, l, th, NOW), a = g.abn[g.abn.length - 1];
      const val = E.MDEF[k].stat ? { x: a.x, t: NOW } : { v: a.v, v2: a.v2, t: NOW, prev: k === 'sleep' && l === 3 ? a.v : undefined };
      assert.strictEqual(E.levelOf(k, val, th[k]), l, k + ' level ' + l);
      const n = g.norm[0], nv = E.MDEF[k].stat ? { x: n.x, t: NOW } : { v: n.v, v2: n.v2, t: NOW };
      assert.strictEqual(E.levelOf(k, nv, th[k]), 0, k + ' normal');
    });
  });
  assert.strictEqual(E.demoReading('hr', 2, th, NOW), null);   // heart rate has no CAUTION level
});

test('demo tools: a demo alert raises, is marked, and clears after 5 minutes', async () => {
  const db = new MemDB(); await C.api(db, 'bootstrap', {}, { now: NOW });
  const r = await C.api(db, 'demoAlert', { pid: 'mei', k: 'spo2', level: 3 }, { now: NOW, by: 'Test' });
  assert.ok(r.ok);
  assert.strictEqual((await db.getStatus('mei')).levels.spo2, 3);
  assert.ok(db.readingsL.every((x) => x.src === 'demoalert' && x.sim));
  assert.ok(db.events.some((e) => /DEMO ALERT generated/.test(e.text)));
  assert.strictEqual((await db.getMission()).demoAlerts.length, 1);
  await C.api(db, 'demoPump', {}, { now: NOW + 4 * 60000 });
  assert.strictEqual((await db.getStatus('mei')).levels.spo2, 3);              // still on at 4 min
  await C.api(db, 'demoPump', {}, { now: NOW + 5 * 60000 + 1000 });
  assert.strictEqual((await db.getStatus('mei')).levels.spo2, 0);              // back to normal at 5 min
  assert.strictEqual((await db.getMission()).demoAlerts.length, 0);
  assert.ok(db.events.some((e) => /DEMO ALERT ended/.test(e.text)));
});

test('demo tools: a live demo file streams rows as time passes, once each, and loops', async () => {
  const db = new MemDB(); await C.api(db, 'bootstrap', {}, { now: NOW });
  const M = 60000, rows = [];
  for (let i = 0; i < 12; i++) rows.push({ o: i * 5 * M, k: 'hr', v: i === 8 ? 150 : 70, ctx: 'rest' });
  rows.push({ o: 40 * M, note: 'Crew note at 40 min' });
  const r = await C.api(db, 'demoLiveStart', { pid: 'sarah', rows, speed: 1, startAt: 20 * M }, { now: NOW, by: 'Test' });
  assert.strictEqual(r.backfilled, 4);                                           // rows at 0, 5, 10, 15 min
  const n0 = db.readingsL.length;
  await C.api(db, 'demoPump', {}, { now: NOW + 1 * M });
  assert.strictEqual(db.readingsL.length, n0 + 1);                               // the 20-min row
  await C.api(db, 'demoPump', {}, { now: NOW + 1 * M });
  assert.strictEqual(db.readingsL.length, n0 + 1);                               // not twice
  await C.api(db, 'demoPump', {}, { now: NOW + 21 * M });
  assert.strictEqual((await db.getStatus('sarah')).levels.hr, 3);                // 150 at 40 min
  assert.ok(db.events.some((e) => e.text === 'Crew note at 40 min'));
  await C.api(db, 'demoPump', {}, { now: NOW + 45 * M });
  assert.ok(db.readingsL.some((x) => /-1-/.test(x.id)), 'second cycle started');
  assert.ok(db.readingsL.every((x) => x.t <= NOW + 45 * M));
  await C.api(db, 'demoLiveStop', {}, { now: NOW + 90 * M });
  assert.strictEqual((await db.getMission()).demoLive, null);
});

test('alert scenarios: cabin CO2 and solar storms', () => {
  const env = (k, vals) => E.sortSeries(vals.map((v, i) => ({ k, t: NOW - (vals.length - 1 - i) * 10 * MIN, v })));
  assert.strictEqual(E.envAt(env('co2', [2.5, 2.5]), NOW).co2l, 1);
  assert.strictEqual(E.envAt(env('co2', [3.3, 3.3]), NOW).co2l, 2);
  assert.strictEqual(E.envAt(env('pfu', [12]), NOW).pfl, 1);
  assert.strictEqual(E.envAt(env('pfu', [150]), NOW).pfl, 2);
  assert.strictEqual(E.envAt(env('pfu', [1500]), NOW).pfl, 3);
});

test('alert scenario B: hemoglobin up while body mass falls is ATTENTION; down 10 % is CAUTION', () => {
  const D = 864e5, p = E.profile(), base = [{ k: 'blood', t: NOW - 60 * D, x: { hb: 12.7 }, src: 'record' }];
  const wt = []; for (let d = 20; d >= 0; d -= 2) wt.push({ k: 'wt', t: NOW - d * D, v: 70 * (1 - 0.045 * (20 - d) / 20), src: 'record' });
  const st = E.personStatus(E.sortSeries(base.concat(wt, [{ k: 'blood', t: NOW - 60000, x: { hb: 14.0 }, src: 'record' }])), p, NOW);
  assert.strictEqual(st.m.c_anem.l, 1);
  const lo = E.personStatus(E.sortSeries(base.concat([{ k: 'blood', t: NOW - 60000, x: { hb: 12.2 }, src: 'record' }])), E.profile(null, null, 'david'), NOW);
  assert.strictEqual(lo.m.c_anem.l, 2);          // 12.2: above 12 but David is male (limit 13) -> CAUTION
});

test('demo scenarios played live: the engine raises the medic team\'s levels by itself', async () => {
  global.window = {}; require('../public/js/scenarios.js'); const SC = global.window.CHARM_SCENARIOS;
  assert.deepStrictEqual(SC.map(s => s.id), ['pulm', 'dehy', 'sans', 'bone']);
  // stage n -> worst level CHARM must reach (team: NORMAL 0, ALERT >= 1, CRITICAL 3). Dehydration step 8 has no new RR,
  // so the last RR 24 still counts and qSOFA keeps it CRITICAL until step 9 brings a full set (conservative on purpose).
  const want = { pulm: [0, 1, 2, 3, 3, 3, 2, 0], dehy: [1, 1, 1, 2, 3, 3, 3, 3, 1, 0], sans: [null, null, 1, 2, 3, 3, 3, 2, 2, 2, 2], bone: [0, 0, 1, 1, 1, 1, 1] };
  for (const sc of SC) {
    const db = new MemDB(); await C.api(db, 'bootstrap', {}, { now: NOW });
    let t = NOW;
    for (const st of sc.stages) {
      t += 10000;
      await C.api(db, 'demoStage', { pid: 'sarah', sid: sc.id, title: sc.title, n: st.n, of: sc.stages.length, label: st.label, code: st.code, stage: st.stage, rows: st.rows, earth: st.earth, clear: st.down }, { now: t, by: 'test' });
      const rs = await db.readings('sarah', t - 4 * 24 * H, t), th = E.profile(null, null, 'sarah', (await db.getMission()).launch);
      const lv = E.personStatus(E.sortSeries(rs), th, t).lvl, w = want[sc.id][st.n - 1];
      if (w != null) assert.strictEqual(lv, w, sc.id + ' stage ' + st.n + ' (' + st.label + ')');
    }
    const m = await db.getMission(); assert.strictEqual(m.demoScenario.sid, sc.id);
    assert.ok(db.readingsL.every(r => r.sim && r.src === 'scenario'));
    if (sc.id === 'pulm' || sc.id === 'dehy') assert.ok(db.events.some(e => e.type === 'raise' && e.lv === 3), sc.id + ' raises a CRITICAL alert');
    await C.api(db, 'demoStage', { stop: true }, { now: t + 1000, by: 'test' });
    assert.strictEqual((await db.getMission()).demoScenario, null);
  }
});
