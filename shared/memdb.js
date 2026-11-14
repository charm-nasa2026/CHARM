/*
 * In-memory implementation of the CHARM storage adapter.
 * Used by the unit tests and by the app's local development mode (?backend=local). Not used in production.
 */
(function (root, factory) {
  var M = factory();
  if (typeof module === 'object' && module.exports) module.exports = M; else root.CHARM_MEMDB = M;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function MemDB() {
    this.crew = {}; this.mission = null; this.overrides = {}; this.readingsL = []; this.envL = []; this.status = {}; this.envStatus = null;
    this.events = []; this.outboxL = []; this.inbox = []; this.seq = 0; this.listeners = [];
  }
  var P = MemDB.prototype;
  P.id = function (p) { return (p || 'x') + (++this.seq).toString(36) + Math.random().toString(36).slice(2, 6); };
  P.changed = function (what) { this.listeners.forEach(function (f) { try { f(what); } catch (e) { console.error(e); } }); };
  P.onChange = function (f) { this.listeners.push(f); };
  P.listCrew = async function () { var c = this.crew; return Object.keys(c).map(function (k) { return Object.assign({ id: k }, c[k]); }).sort(function (a, b) { return (a.order || 0) - (b.order || 0); }); };
  P.setCrew = async function (id, o) { this.crew[id] = Object.assign({}, o, { id: id }); this.changed('crew'); };
  P.getMission = async function () { return this.mission ? Object.assign({}, this.mission) : null; };
  P.setMission = async function (m) { this.mission = Object.assign({}, m); this.changed('mission'); };
  P.getOverride = async function (pid) { return this.overrides[pid] ? JSON.parse(JSON.stringify(this.overrides[pid])) : null; };
  P.setOverride = async function (pid, o) { this.overrides[pid] = JSON.parse(JSON.stringify(o)); this.changed('overrides'); };
  P.readings = async function (pid, from, to) { return this.readingsL.filter(function (r) { return r.pid === pid && r.t >= from && r.t <= to; }); };
  P.addReadings = async function (arr) { var me = this; arr.forEach(function (r) { me.readingsL.push(Object.assign({ id: me.id('r') }, r)); }); this.changed('readings'); };
  P.env = async function (from, to) { return this.envL.filter(function (r) { return r.t >= from && r.t <= to; }); };
  P.addEnv = async function (arr) { var me = this; arr.forEach(function (r) { me.envL.push(Object.assign({ id: me.id('e') }, r)); }); this.changed('env'); };
  P.getStatus = async function (pid) { return this.status[pid] ? Object.assign({}, this.status[pid]) : null; };
  P.setStatus = async function (pid, s) { this.status[pid] = Object.assign({}, s); this.changed('status'); };
  P.getEnvStatus = async function () { return this.envStatus ? Object.assign({}, this.envStatus) : null; };
  P.setEnvStatus = async function (s) { this.envStatus = Object.assign({}, s); };
  P.addEvents = async function (arr) {
    var me = this, out = [];
    arr.forEach(function (e) { var id = e.id || me.id('v'); if (me.events.some(function (x) { return x.id === id; })) return; var x = Object.assign({}, e, { id: id }); me.events.push(x); out.push(x); });
    this.changed('events'); return out;
  };
  P.addOutbox = async function (arr) { var me = this; arr.forEach(function (o) { me.outboxL.push(Object.assign({ id: me.id('o') }, o)); }); this.changed('outbox'); };
  P.outbox = async function (statuses, limit) { return this.outboxL.filter(function (o) { return statuses.indexOf(o.status) >= 0; }).slice(0, limit || 500).map(function (o) { return Object.assign({}, o); }); };
  P.updateOutbox = async function (id, patch) { this.outboxL.forEach(function (o) { if (o.id === id) Object.assign(o, patch); }); this.changed('outbox'); };
  P.purge = async function (pid) {
    var me = this, n = {};
    [['readings', 'readingsL'], ['events', 'events'], ['outbox', 'outboxL']].forEach(function (c) { var before = me[c[1]].length; me[c[1]] = me[c[1]].filter(function (x) { return x.pid !== pid; }); n[c[0]] = before - me[c[1]].length; });
    delete this.status[pid]; delete this.overrides[pid]; this.changed('purge'); return n;
  };
  P.deleteCrew = async function (id) { delete this.crew[id]; this.changed('crew'); };
  P.addInbox = async function (arr) { var me = this; arr.forEach(function (o) { me.inbox.push(Object.assign({ id: me.id('i') }, o)); }); this.changed('inbox'); };
  return MemDB;
});
