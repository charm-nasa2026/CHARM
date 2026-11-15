/* CHARM service worker: phone alerts only (it does not cache pages).
   The server sends CAUTION (orange) alerts to the phone of the astronaut they are about, and CRITICAL (red) alerts to every crew phone,
   through Firebase Cloud Messaging. Tapping the notification opens CHARM on a full-screen alert in the alert's colour. */
'use strict';
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

function alertUrl(d) {
  var q = new URLSearchParams({ push: '1', l: d.l || '3', pid: d.pid || '', k: d.k || '', msg: d.text || '', sub: d.sub || '', t: d.t || '', name: d.name || '' });
  return '/?' + q.toString();
}

self.addEventListener('push', function (e) {
  var m = {};
  try { m = e.data ? e.data.json() : {}; } catch (x) { m = { data: { text: e.data ? e.data.text() : '' } }; }
  var d = m.data || m;
  var l = +d.l >= 3 ? 3 : 2, crit = l === 3;
  var title = (crit ? 'CRITICAL' : 'CAUTION') + (d.name ? ' · ' + d.name : d.pid ? '' : ' · Cabin');
  var body = (d.text || 'New alert in CHARM') + (d.sub ? '\n' + d.sub : '') + (d.sim === '1' ? '\n(simulated data)' : '');
  e.waitUntil(self.registration.showNotification(title, {
    body: body,
    icon: crit ? '/assets/alert-red.png' : '/assets/alert-orange.png',
    badge: '/assets/alert-badge.png',
    tag: 'charm-' + (d.pid || 'cabin') + '-' + l,
    renotify: true,
    requireInteraction: crit,
    vibrate: crit ? [500, 150, 500, 150, 900] : [250, 120, 250],
    timestamp: +d.t || Date.now(),
    data: { url: alertUrl(d), d: d }
  }));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var info = e.notification.data || {};
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cs) {
    for (var i = 0; i < cs.length; i++) {
      var c = cs[i];
      if (new URL(c.url).origin === self.location.origin) { c.postMessage({ type: 'charm-push', d: info.d || {} }); return c.focus(); }
    }
    return self.clients.openWindow(info.url || '/');
  }));
});
