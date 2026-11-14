/*
 * CHARM Cloud Functions.
 *   api   – callable endpoint the web app uses for every write (readings, crew, thresholds, events, mission, demo).
 *   tick  – runs every 5 minutes: clears alerts that stayed in range, detects silent wearables, cabin alerts,
 *           moves the Earth outbox, and pulls real space weather from NOAA.
 * All writes go through here (Admin SDK). Firestore rules let the app read but never write directly.
 *
 * engine.js and core.js are copied from ../shared by the predeploy hook in firebase.json. Edit them there.
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions, logger } = require('firebase-functions');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const E = require('./engine.js');
const C = require('./core.js');

initializeApp();
const fs = getFirestore();
setGlobalOptions({ region: 'us-central1', maxInstances: 10 });

/* ---------- Firestore implementation of the storage adapter used by core.js ---------- */
const col = (n) => fs.collection(n);
const data = (snap) => snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
const clean = (o) => JSON.parse(JSON.stringify(o)); // drops undefined fields, which Firestore rejects

async function commitAll(writes) { // writes: [(batch) => void], max 450 per batch
  for (let i = 0; i < writes.length; i += 450) {
    const b = fs.batch();
    writes.slice(i, i + 450).forEach((w) => w(b));
    await b.commit();
  }
}

const db = {
  listCrew: async () => data(await col('crew').get()).sort((a, b) => (a.order || 0) - (b.order || 0)),
  setCrew: (id, o) => col('crew').doc(id).set(clean(o)),
  getMission: async () => { const s = await col('mission').doc('main').get(); return s.exists ? s.data() : null; },
  setMission: (m) => col('mission').doc('main').set(clean(m)),
  getOverride: async (pid) => { const s = await col('overrides').doc(pid).get(); return s.exists ? s.data() : null; },
  setOverride: (pid, o) => col('overrides').doc(pid).set(clean(o)),
  readings: async (pid, from, to) => data(await col('readings').where('pid', '==', pid).where('t', '>=', from).where('t', '<=', to).get()),
  addReadings: (arr) => commitAll(arr.map((r) => (b) => b.set(col('readings').doc(), clean(r)))),
  env: async (from, to) => data(await col('env').where('t', '>=', from).where('t', '<=', to).get()),
  addEnv: (arr) => commitAll(arr.map((r) => (b) => b.set(col('env').doc(), clean(r)))),
  getStatus: async (pid) => { const s = await col('status').doc(pid).get(); return s.exists ? s.data() : null; },
  setStatus: (pid, s) => col('status').doc(pid).set(clean(s)),
  getEnvStatus: async () => { const s = await col('system').doc('envStatus').get(); return s.exists ? s.data() : null; },
  setEnvStatus: (s) => col('system').doc('envStatus').set(clean(s)),
  addEvents: async (arr) => {
    const out = arr.map((e) => { const ref = e.id ? col('events').doc(e.id) : col('events').doc(); return { ref, e: Object.assign({}, e, { id: ref.id }) }; });
    // create() fails if an event with the same id exists, so a retried request can't log twice
    for (const x of out) { try { await x.ref.create(clean(x.e)); } catch (err) { if (err.code !== 6) throw err; x.dup = true; } }
    return out.filter((x) => !x.dup).map((x) => x.e);
  },
  addOutbox: (arr) => commitAll(arr.map((o) => (b) => b.set(col('outbox').doc(), clean(o)))),
  outbox: async (statuses, limit) => data(await col('outbox').where('status', 'in', statuses).limit(limit || 500).get()),
  updateOutbox: (id, patch) => col('outbox').doc(id).update(clean(patch)),
  // deletes every document of one astronaut in a collection, 400 at a time
  purge: async (pid) => {
    const n = {};
    for (const c of ['readings', 'events', 'outbox']) {
      n[c] = 0;
      for (;;) {
        const snap = await col(c).where('pid', '==', pid).limit(400).get();
        if (snap.empty) break;
        const b = fs.batch(); snap.docs.forEach((d) => b.delete(d.ref)); await b.commit(); n[c] += snap.size;
      }
    }
    await col('status').doc(pid).delete(); await col('overrides').doc(pid).delete();
    return n;
  },
  deleteCrew: (id) => col('crew').doc(id).delete(),
  addInbox: (arr) => commitAll(arr.map((o) => (b) => b.set(col('inbox').doc(), clean(o))))
};

/* ---------- callable API ---------- */
exports.api = onCall({ invoker: 'public', timeoutSeconds: 300, memory: '512MiB' }, async (req) => {
  const body = req.data || {};
  if (typeof body.op !== 'string') throw new HttpsError('invalid-argument', 'Missing op');
  try {
    return await C.api(db, body.op, body.data || {}, { now: Date.now(), by: body.by });
  } catch (err) {
    if (err.code && ['invalid-argument', 'failed-precondition', 'not-found'].includes(err.code)) throw new HttpsError(err.code, err.message);
    logger.error('api failed', { op: body.op, err: err.message, stack: err.stack });
    throw new HttpsError('internal', 'CHARM server error: ' + err.message);
  }
});

/* ---------- scheduled tick ---------- */
exports.tick = onSchedule({ schedule: 'every 5 minutes', timeoutSeconds: 120 }, async () => {
  const now = Date.now();
  try { await C.bootstrap(db, now); } catch (e) { logger.warn('bootstrap', e.message); }
  try { await spaceWeather(now); } catch (e) { logger.warn('NOAA space weather unavailable', e.message); }
  const r = await C.tick(db, now, { external: false });
  logger.info('tick', r);
});

/*
 * Real space weather: NOAA SWPC GOES integral proton flux (≥10 MeV), the measure behind NOAA S-scale radiation storms.
 * It is measured near Earth, so on a Mars transit it is an early-warning proxy, not the dose at the ship.
 */
async function spaceWeather(now) {
  const res = await fetch('https://services.swpc.noaa.gov/json/goes/primary/integral-protons-6-hour.json', { headers: { 'User-Agent': 'CHARM-hackathon/1.0' } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const rows = (await res.json()).filter((r) => /^>=\s*10 MeV$/.test(String(r.energy)) && typeof r.flux === 'number' && r.time_tag);
  if (!rows.length) return;
  const last = (await col('env').where('k', '==', 'pfu').orderBy('t', 'desc').limit(1).get()).docs[0];
  const since = last ? last.data().t : now - 6 * E.H;
  const all = rows.map((r) => ({ k: 'pfu', t: Date.parse(r.time_tag), v: Math.round(r.flux * 100) / 100, src: 'noaa', created: now }))
    .filter((r) => isFinite(r.t) && r.t > since && r.t <= now + E.MIN).sort((a, b) => a.t - b.t);
  const fresh = all.filter((r, i) => i % 3 === 0 || i === all.length - 1); // about one point per 15 minutes
  if (fresh.length) await db.addEnv(fresh);
}
