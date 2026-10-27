/* Web push service worker */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('push', function (e) {
    var data = {};
    try { data = e.data ? e.data.json() : {}; } catch (_) { data = { body: e.data ? e.data.text() : '' }; }
    e.waitUntil(self.registration.showNotification(data.title || 'Vaidya Gogate Seminar', {
        body: data.body || '',
        icon: '/favicon.ico',
        badge: '/favicon.ico',
        tag: data.tag || 'seminar',
        renotify: true,
        data: { url: data.url || '/doctor.html' }
    }));
});
self.addEventListener('notificationclick', function (e) {
    e.notification.close();
    var url = (e.notification.data && e.notification.data.url) || '/doctor.html';
    e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
        for (var i = 0; i < list.length; i++) { if ('focus' in list[i]) { list[i].navigate(url); return list[i].focus(); } }
        return self.clients.openWindow(url);
    }));
});
