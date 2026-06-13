/**
 * Live site visitor sessions — page, device, location (from IP) for admin dashboard.
 */
const crypto = require('crypto');
const supportLiveChat = require('./support-live-chat');
const userClientTelemetry = require('./user-client-telemetry');

function isPg() {
    return !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
}

function ignoreErr(e) {
    if (e && !/duplicate column|already exists/i.test(String(e.message))) {
        console.warn('[site-visitors]', e.message);
    }
}

function ensureSchema(db, cb) {
    const ts = isPg() ? 'TIMESTAMPTZ' : 'DATETIME';
    const steps = [
        `CREATE TABLE IF NOT EXISTS site_visitor_sessions (
            session_id TEXT PRIMARY KEY,
            user_id INTEGER,
            user_label TEXT,
            client_ip TEXT,
            location_label TEXT,
            geo_json TEXT,
            device_label TEXT,
            user_agent TEXT,
            current_path TEXT,
            referrer TEXT,
            first_seen ${ts} DEFAULT CURRENT_TIMESTAMP,
            last_seen ${ts} DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE INDEX IF NOT EXISTS idx_site_visitor_last_seen ON site_visitor_sessions(last_seen DESC)`
    ];
    let i = 0;
    const next = () => {
        if (i >= steps.length) return cb && cb(null);
        db.run(steps[i++], (e) => {
            ignoreErr(e);
            next();
        });
    };
    next();
}

function newSessionId() {
    return crypto.randomBytes(16).toString('hex');
}

function deviceFromDiagnostics(d) {
    if (d && d.platform) return String(d.platform);
    if (d && d.userAgent) return userClientTelemetry.deviceLabelFromDiagnostics(d);
    return '—';
}

function recordHeartbeat(db, req, body, cb) {
    let sessionId = String((body && body.sessionId) || '').trim();
    if (!sessionId || sessionId.length < 8) sessionId = newSessionId();

    const userId = body && body.userId != null ? parseInt(body.userId, 10) : null;
    const currentPath = String((body && body.path) || (body && body.page) || req.path || '/').slice(0, 500);
    const referrer = String((body && body.referrer) || req.get('referer') || '').slice(0, 500);
    const diagnostics = body && body.clientDiagnostics ? body.clientDiagnostics : {};
    const userAgent = String((diagnostics && diagnostics.userAgent) || req.get('user-agent') || '').slice(0, 500);
    const deviceLabel = deviceFromDiagnostics(diagnostics);
    const userLabel = String((body && body.userLabel) || '').trim().slice(0, 120) || null;
    const ip = supportLiveChat.getClientIpFromReq(req) || null;
    const diagnosticsJson = diagnostics != null ? JSON.stringify(diagnostics) : null;

    ensureSchema(db, (schemaErr) => {
        if (schemaErr) return cb && cb(schemaErr);

        const upsert = (locationLabel, geoJson) => {
            db.get(`SELECT session_id, first_seen FROM site_visitor_sessions WHERE session_id = ?`, [sessionId], (e0, existing) => {
                const isNew = !existing;
                const sql = isPg()
                    ? `INSERT INTO site_visitor_sessions (
                        session_id, user_id, user_label, client_ip, location_label, geo_json,
                        device_label, user_agent, current_path, referrer, first_seen, last_seen
                      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                      ON CONFLICT(session_id) DO UPDATE SET
                        user_id = COALESCE(EXCLUDED.user_id, site_visitor_sessions.user_id),
                        user_label = COALESCE(EXCLUDED.user_label, site_visitor_sessions.user_label),
                        client_ip = EXCLUDED.client_ip,
                        location_label = COALESCE(EXCLUDED.location_label, site_visitor_sessions.location_label),
                        geo_json = COALESCE(EXCLUDED.geo_json, site_visitor_sessions.geo_json),
                        device_label = EXCLUDED.device_label,
                        user_agent = EXCLUDED.user_agent,
                        current_path = EXCLUDED.current_path,
                        referrer = EXCLUDED.referrer,
                        last_seen = CURRENT_TIMESTAMP`
                    : existing
                      ? `UPDATE site_visitor_sessions SET
                          user_id = COALESCE(?, user_id),
                          user_label = COALESCE(?, user_label),
                          client_ip = ?,
                          location_label = COALESCE(?, location_label),
                          geo_json = COALESCE(?, geo_json),
                          device_label = ?,
                          user_agent = ?,
                          current_path = ?,
                          referrer = ?,
                          last_seen = CURRENT_TIMESTAMP
                        WHERE session_id = ?`
                      : `INSERT INTO site_visitor_sessions (
                          session_id, user_id, user_label, client_ip, location_label, geo_json,
                          device_label, user_agent, current_path, referrer, first_seen, last_seen
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;

                const params = existing && !isPg()
                    ? [
                          Number.isInteger(userId) ? userId : null,
                          userLabel,
                          ip,
                          locationLabel,
                          geoJson,
                          deviceLabel,
                          userAgent,
                          currentPath,
                          referrer,
                          sessionId
                      ]
                    : [
                          sessionId,
                          Number.isInteger(userId) ? userId : null,
                          userLabel,
                          ip,
                          locationLabel,
                          geoJson,
                          deviceLabel,
                          userAgent,
                          currentPath,
                          referrer
                      ];

                db.run(sql, params, (uErr) => {
                    if (uErr) return cb && cb(uErr);
                    cb(null, { sessionId, isNew: !!isNew });
                });
            });
        };

        if (!ip) return upsert(null, null);
        supportLiveChat.lookupIpGeo(ip, (geoErr, geo) => {
            upsert(geo && geo.label ? geo.label : null, geo ? JSON.stringify(geo) : null);
        });
    });
}

function listLiveVisitors(db, opts, cb) {
    const minutes = Math.min(60, Math.max(1, parseInt(opts && opts.minutes, 10) || 15));
    const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();
    ensureSchema(db, (e) => {
        if (e) return cb(e);
        db.all(
            `SELECT session_id, user_id, user_label, client_ip, location_label, device_label,
                    user_agent, current_path, referrer, first_seen, last_seen
             FROM site_visitor_sessions
             WHERE last_seen >= ?
             ORDER BY last_seen DESC
             LIMIT 100`,
            [since],
            (err, rows) => {
                if (err) return cb(err);
                const now = Date.now();
                const visitors = (rows || []).map((r) => {
                    const firstMs = r.first_seen ? new Date(r.first_seen).getTime() : 0;
                    return {
                        sessionId: r.session_id,
                        userId: r.user_id,
                        userLabel: r.user_label,
                        ip: r.client_ip,
                        location: r.location_label,
                        device: r.device_label,
                        page: r.current_path,
                        referrer: r.referrer,
                        firstSeen: r.first_seen,
                        lastSeen: r.last_seen,
                        isNew: firstMs > 0 && now - firstMs < 3 * 60 * 1000
                    };
                });
                cb(null, {
                    count: visitors.length,
                    newCount: visitors.filter((v) => v.isNew).length,
                    visitors
                });
            }
        );
    });
}

module.exports = {
    ensureSchema,
    recordHeartbeat,
    listLiveVisitors,
    newSessionId
};
