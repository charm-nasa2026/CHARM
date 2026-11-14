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
  assert.strictEqual(lv.sarah.lvl, 2); assert.ok(lv.sarah.m.hr.val.irr);
  assert.strictEqual(lv.marcus.lvl, 1); assert.strictEqual(lv.marcus.top, 'sleep');
  assert.strictEqual(lv.elena.lvl, -1);
  assert.strictEqual(lv.john.lvl, 0);
  assert.ok(db.events.some(e => e.pid === 'sarah' && e.type === 'raise' && e.lv === 2));
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
  assert.strictEqual((await db.getStatus('elena')).levels.hr, 2);   // critical 130 is the same for everyone
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
