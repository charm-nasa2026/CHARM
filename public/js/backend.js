/*
 * CHARM backend connector for the web app.
 *   Firebase mode (default): live Firestore listeners + the `api` Cloud Function for every write.
 *   Local mode (?backend=local): runs the same server logic (core.js) in the browser with an in-memory store.
 *     For development and screenshots only; nothing is saved when the page closes.
 *
 * Writes that fail because the device is offline are kept in a local queue and retried, so the crew can keep
 * entering data during a link outage. Reads keep working offline from Firestore's local cache.
 */
(function () {
  'use strict';
  var D = 86400000;
  var local = /[?&]backend=local\b/.test(location.search);
  var handlers = null, apiFn = null, state = { mode: local ? 'local' : 'firebase', project: null, online: navigator.onLine, error: null, pending: 0 };
  var QKEY = 'charm-pending-writes', QUEUEABLE = { addReadings: 1, addEnv: 1, logEvent: 1, message: 1 };

  function emit(name, v) { if (handlers && handlers[name]) try { handlers[name](v); } catch (e) { console.error(e); } }
  function qGet() { try { return JSON.parse(localStorage.getItem(QKEY) || '[]'); } catch (e) { return []; } }
  function qSet(q) { try { localStorage.setItem(QKEY, JSON.stringify(q)); } catch (e) {} state.pending = q.length; emit('status', state); }
  function isNetworkError(e) { var c = String((e && e.code) || ''); return !navigator.onLine || /unavailable|deadline-exceeded/.test(c); }

  /* ---------- Firebase ---------- */
  async function startFirebase() {
    var FB = window.CHARM_FB;
    var cfg = window.CHARM_FIREBASE_CONFIG;
    if (!cfg) { var r = await fetch('/__/firebase/init.json'); if (!r.ok) throw new Error('No Firebase config. Deploy to Firebase Hosting, or set window.CHARM_FIREBASE_CONFIG in js/config.js.'); cfg = await r.json(); }
    state.project = cfg.projectId;
    var app = FB.initializeApp(cfg), db;
    try { db = FB.initializeFirestore(app, { localCache: FB.persistentLocalCache({ tabManager: FB.persistentMultipleTabManager() }) }); }
    catch (e) { db = FB.initializeFirestore(app, { localCache: FB.memoryLocalCache() }); }
    var fns = FB.getFunctions(app, 'us-central1');
    if (/[?&]emulator\b/.test(location.search)) { FB.connectFirestoreEmulator(db, location.hostname, 8080); FB.connectFunctionsEmulator(fns, location.hostname, 5001); }
    apiFn = FB.httpsCallable(fns, 'api', { timeout: 120000 });
    var since = Date.now() - 8 * D;
    var list = function (snap) { return snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); }); };
    var fail = function (name) { return function (e) { state.error = name + ': ' + e.message; emit('status', state); console.error(name, e); }; };
    var C = function (n) { return FB.collection(db, n); };
    FB.onSnapshot(C('crew'), function (s) { emit('crew', list(s)); }, fail('crew'));
    FB.onSnapshot(FB.doc(db, 'mission', 'main'), function (s) { emit('mission', s.exists() ? s.data() : null); }, fail('mission'));
    FB.onSnapshot(C('overrides'), function (s) { var o = {}; s.docs.forEach(function (d) { o[d.id] = d.data(); }); emit('overrides', o); }, fail('overrides'));
    FB.onSnapshot(FB.query(C('readings'), FB.where('t', '>=', since)), function (s) { emit('readings', list(s)); }, fail('readings'));
    FB.onSnapshot(FB.query(C('env'), FB.where('t', '>=', since)), function (s) { emit('env', list(s)); }, fail('env'));
    FB.onSnapshot(FB.query(C('events'), FB.where('t', '>=', Date.now() - 30 * D), FB.orderBy('t', 'desc'), FB.limit(1500)), function (s) { emit('events', list(s)); }, fail('events'));
    FB.onSnapshot(FB.query(C('outbox'), FB.orderBy('t', 'desc'), FB.limit(300)), function (s) { emit('outbox', list(s)); }, fail('outbox'));
    FB.onSnapshot(FB.query(C('inbox'), FB.orderBy('t', 'desc'), FB.limit(100)), function (s) { emit('inbox', list(s)); }, fail('inbox'));
    callApi('bootstrap', {}).catch(function (e) { state.error = 'Server not reachable: ' + e.message; emit('status', state); });
  }

  /* ---------- local (development) ---------- */
  var mem = null;
  async function startLocal() {
    var MemDB = window.CHARM_MEMDB; mem = new MemDB(); window.__charmMem = mem;
    var push = function () {
      emit('crew', Object.keys(mem.crew).map(function (k) { return mem.crew[k]; }));
      emit('mission', mem.mission);
      emit('overrides', JSON.parse(JSON.stringify(mem.overrides)));
      emit('readings', mem.readingsL.slice());
      emit('env', mem.envL.slice());
      emit('events', mem.events.slice().sort(function (a, b) { return b.t - a.t; }));
      emit('outbox', mem.outboxL.slice().sort(function (a, b) { return b.t - a.t; }));
      emit('inbox', mem.inbox.slice());
    };
    var pending = 0; mem.onChange(function () { if (pending) return; pending = setTimeout(function () { pending = 0; push(); }, 30); });
    state.project = 'local (in-memory, not saved)';
    await window.CHARM_CORE.api(mem, 'bootstrap', {}, { now: Date.now() });
    push();
    setInterval(function () { window.CHARM_CORE.tick(mem, Date.now()).catch(console.error); }, 60000);
  }

  /* ---------- calls ---------- */
  async function callApi(op, data, by) {
    if (local) return window.CHARM_CORE.api(mem, op, JSON.parse(JSON.stringify(data || {})), { now: Date.now(), by: by });
    var res = await apiFn({ op: op, data: data || {}, by: by || '' });
    return res.data;
  }
  async function call(op, data, by) {
    try { var r = await callApi(op, data, by); flush(); return r; }
    catch (e) {
      if (!local && QUEUEABLE[op] && isNetworkError(e)) { var q = qGet(); q.push({ op: op, data: data, by: by, t: Date.now() }); qSet(q); return { queued: true }; }
      var m = (e && e.message) || String(e); var err = new Error(m.replace(/^FirebaseError:\s*/, '')); err.code = e && e.code; throw err;
    }
  }
  var flushing = false;
  async function flush() {
    if (flushing || local) return; var q = qGet(); if (!q.length) return; flushing = true;
    try { while (q.length) { await callApi(q[0].op, q[0].data, q[0].by); q.shift(); qSet(q); } }
    catch (e) { /* still offline; try later */ }
    finally { flushing = false; }
  }
  window.addEventListener('online', function () { state.online = true; emit('status', state); flush(); });
  window.addEventListener('offline', function () { state.online = false; emit('status', state); });
  setInterval(flush, 30000);

  window.CHARM_BACKEND = {
    start: function (h) {
      handlers = h; state.pending = qGet().length;
      return (local ? startLocal() : startFirebase()).then(function () { emit('status', state); return state; }, function (e) { state.error = e.message; emit('status', state); throw e; });
    },
    call: call,
    state: state,
    tickNow: function () { return local ? window.CHARM_CORE.tick(mem, Date.now()) : Promise.resolve(); }
  };
})();
