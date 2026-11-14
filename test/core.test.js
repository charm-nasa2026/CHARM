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
  assert.strictEqual(db.events.filter(e => e.type === 'raise').length, 1);
  await add(NOW + 5 * MIN, 37.0);
  await C.tick(db, NOW + 5 * MIN); await C.tick(db, NOW + 10 * MIN);
  assert.strictEqual(db.events.filter(e => e.type === 'clear').length, 0);
  await add(NOW + 14 * MIN, 37.0);
  await C.tick(db, NOW + 15 * MIN);
  assert.strictEqual(db.events.filter(e => e.type === 'clear').length, 1);
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

test('personal offsets move caution limits, never critical, with cap and gap', () => {
  const pr = E.profile(null, { hr: { mean: 98.4, n: 13 }, sbp: { mean: 103.9, n: 16 }, temp: { mean: 36.9, n: 16 } });
  assert.strictEqual(pr.hr.cHi, 115);            // +29 capped at +15
  assert.strictEqual(pr.hr.cLo, 65);
  assert.strictEqual(pr.hr.xHi, 130);            // critical unchanged
  assert.strictEqual(pr.hr.xLo, 40);
  assert.strictEqual(pr.bp.sCL, 85);             // 90 - 12 -> 78, held 5 above critical 80
  assert.strictEqual(pr._personal.offsets.hr.capped, true);
  const low = E.profile(null, { hr: { mean: 52, n: 10 } });
  assert.strictEqual(low.hr.cLo, 45);            // 50 - 15 = 35, held 5 above critical 40
  const few = E.profile(null, { hr: { mean: 90, n: 3 } });
  assert.strictEqual(few.hr.cHi, 100);           // fewer than 5 baseline readings: no offset
});

test('setBaseline stores the baseline and alerts use personal limits', async () => {
  const db = new MemDB(); await C.api(db, 'bootstrap', {}, { now: NOW });
  await C.api(db, 'setBaseline', { pid: 'elena', base: { hr: { mean: 98, n: 13 } }, via: 'test' }, { now: NOW });
  await C.api(db, 'addReadings', { src: 'record', readings: [{ pid: 'elena', k: 'hr', t: NOW - 60000, v: 104 }] }, { now: NOW });
  const st = await db.getStatus('elena');
  assert.strictEqual(st.levels.hr || 0, 0);      // 104 is above 100 but inside her personal 113 limit
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
  // infection: SIRS 2 + suspected infection -> CAUTION; qSOFA 2 -> CRITICAL; no suspicion -> no condition alert
  const v = [{ k: 'temp', v: 38.4 }, { k: 'hr', v: 104 }, { k: 'rr', v: 18 }];
  assert.strictEqual(at(v).m.c_inf.l, 0);
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
  // personal offsets move the orange infection-screen numbers too, never the red qSOFA
  const pe = E.profile(null, { hr: { mean: 98, n: 13 } });
  assert.strictEqual(pe.inf.hr, 105); assert.strictEqual(pe.hr.xHi, 130);
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
