'use strict';
/** Browser push notifications (VAPID) for portal users — no app needed. */
let webpush = null;
try { webpush = require('web-push'); } catch (_) { webpush = null; }

const KEY = 'web_push_vapid';
let vapid = null;

function ensureSchema(db, cb) {
    db.run(
        `CREATE TABLE IF NOT EXISTS push_subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            endpoint TEXT UNIQUE NOT NULL,
            keys_json TEXT NOT NULL,
            user_agent TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`,
        () => cb && cb()
    );
}

function loadVapid(db, cb) {
    if (vapid) return cb(null, vapid);
    if (!webpush) return cb(new Error('web-push not installed'));
    db.get(`SELECT value FROM global_settings WHERE key = ?`, [KEY], (err, row) => {
        if (!err && row && row.value) {
            try { vapid = JSON.parse(row.value); } catch (_) { vapid = null; }
        }
        if (vapid && vapid.publicKey) return finish();
        vapid = webpush.generateVAPIDKeys();
        db.run(`INSERT INTO global_settings (key, value) VALUES (?, ?)`, [KEY, JSON.stringify(vapid)], () => finish());
        function finish() {
            webpush.setVapidDetails('mailto:vd.gogatememorialfoundation@gmail.com', vapid.publicKey, vapid.privateKey);
            cb(null, vapid);
        }
    });
}

/** Send a push to every browser the user subscribed from; dead subscriptions are pruned. */
function pushToUser(db, userId, msg, cb) {
    const uid = parseInt(userId, 10);
    if (!webpush || !Number.isInteger(uid) || uid <= 0) return cb && cb();
    loadVapid(db, (err) => {
        if (err) return cb && cb();
        db.all(`SELECT id, endpoint, keys_json FROM push_subscriptions WHERE user_id = ?`, [uid], (e2, rows) => {
            if (e2 || !rows || !rows.length) return cb && cb();
            const payload = JSON.stringify({
                title: String(msg.title || 'Vaidya Gogate Seminar').slice(0, 120),
                body: String(msg.body || '').slice(0, 300),
                url: msg.url || '/doctor.html',
                tag: msg.tag || 'seminar'
            });
            Promise.all(rows.map((r) => {
                let keys = {};
                try { keys = JSON.parse(r.keys_json); } catch (_) {}
                return webpush.sendNotification({ endpoint: r.endpoint, keys }, payload, { TTL: 3600 }).catch((pe) => {
                    if (pe && (pe.statusCode === 404 || pe.statusCode === 410)) db.run(`DELETE FROM push_subscriptions WHERE id = ?`, [r.id]);
                });
            })).then(() => cb && cb(), () => cb && cb());
        });
    });
}

function registerWebPushRoutes(app, db) {
    ensureSchema(db);
    app.get('/api/push/vapid-public', (req, res) => {
        loadVapid(db, (err, v) => (err ? res.status(503).json({ error: 'Push unavailable' }) : res.json({ publicKey: v.publicKey })));
    });
    app.post('/api/push/subscribe', (req, res) => {
        const sub = req.body && req.body.subscription;
        const uid = parseInt(req.body && req.body.userId, 10);
        if (!sub || !sub.endpoint || !sub.keys || !Number.isInteger(uid) || uid <= 0) return res.status(400).json({ error: 'Invalid subscription' });
        db.run(`DELETE FROM push_subscriptions WHERE endpoint = ?`, [sub.endpoint], () => {
            db.run(
                `INSERT INTO push_subscriptions (user_id, endpoint, keys_json, user_agent) VALUES (?, ?, ?, ?)`,
                [uid, sub.endpoint, JSON.stringify(sub.keys), String(req.headers['user-agent'] || '').slice(0, 200)],
                (err) => (err ? res.status(500).json({ error: err.message }) : res.json({ success: true }))
            );
        });
    });
    app.post('/api/push/unsubscribe', (req, res) => {
        const endpoint = req.body && req.body.endpoint;
        if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
        db.run(`DELETE FROM push_subscriptions WHERE endpoint = ?`, [endpoint], () => res.json({ success: true }));
    });
    app.post('/api/push/test', (req, res) => {
        const uid = parseInt(req.body && req.body.userId, 10);
        pushToUser(db, uid, { title: 'Notifications enabled', body: 'You will get instant alerts for tickets, payments and shipments.', url: '/doctor.html' }, () => res.json({ success: true }));
    });
}

module.exports = { registerWebPushRoutes, pushToUser, loadVapid };
