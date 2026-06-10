/**
 * Persist doctor portal device / network / IP-location telemetry for admin.
 */
const supportLiveChat = require('./support-live-chat');

function isPg() {
    return !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
}

function ignoreSchemaErr(e) {
    if (e && !/duplicate column|already exists/i.test(String(e.message))) {
        console.warn('[user-client-telemetry]', e.message);
    }
}

function parseJsonField(raw) {
    if (raw == null || raw === '') return null;
    if (typeof raw === 'object') return raw;
    try {
        return JSON.parse(String(raw));
    } catch (_) {
        return null;
    }
}

function deviceLabelFromDiagnostics(diagnostics) {
    const d = diagnostics || {};
    if (d.platform) return String(d.platform);
    const ua = String(d.userAgent || '');
    if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
    if (/Android/i.test(ua)) return 'Android';
    if (/Windows/i.test(ua)) return 'Windows';
    if (/Macintosh|Mac OS/i.test(ua)) return 'macOS';
    if (/Linux/i.test(ua)) return 'Linux';
    return ua ? ua.slice(0, 48) : '—';
}

function networkLabelFromDiagnostics(diagnostics) {
    const net = diagnostics && diagnostics.network;
    if (!net) return '—';
    const parts = [];
    if (net.downlinkMbps != null) parts.push('~' + net.downlinkMbps + ' Mbps');
    if (net.effectiveType) parts.push(net.effectiveType);
    if (net.rttMs != null) parts.push(net.rttMs + ' ms RTT');
    return parts.length ? parts.join(' · ') : '—';
}

function summaryFromRow(row) {
    if (!row) return null;
    const diagnostics = parseJsonField(row.diagnostics_json);
    return {
        ip: row.client_ip || null,
        location: row.location_label || null,
        device: deviceLabelFromDiagnostics(diagnostics),
        network: networkLabelFromDiagnostics(diagnostics),
        timezone: diagnostics && diagnostics.timezone ? diagnostics.timezone : null,
        online: diagnostics && diagnostics.online != null ? !!diagnostics.online : null,
        screen:
            diagnostics && diagnostics.screen
                ? diagnostics.screen.width + '×' + diagnostics.screen.height
                : null,
        userAgent: diagnostics && diagnostics.userAgent ? diagnostics.userAgent : null,
        updatedAt: row.updated_at || null
    };
}

function ensureUserClientTelemetrySchema(db, cb) {
    const pg = isPg();
    const ts = pg ? 'TIMESTAMPTZ' : 'DATETIME';
    const steps = [
        pg
            ? `CREATE TABLE IF NOT EXISTS user_client_telemetry (
                user_id INTEGER PRIMARY KEY,
                client_ip TEXT,
                location_label TEXT,
                geo_json TEXT,
                diagnostics_json TEXT,
                updated_at ${ts} DEFAULT CURRENT_TIMESTAMP
            )`
            : `CREATE TABLE IF NOT EXISTS user_client_telemetry (
                user_id INTEGER PRIMARY KEY,
                client_ip TEXT,
                location_label TEXT,
                geo_json TEXT,
                diagnostics_json TEXT,
                updated_at ${ts} DEFAULT CURRENT_TIMESTAMP
            )`,
        pg
            ? `CREATE TABLE IF NOT EXISTS user_client_telemetry_log (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                client_ip TEXT,
                location_label TEXT,
                geo_json TEXT,
                diagnostics_json TEXT,
                recorded_at ${ts} DEFAULT CURRENT_TIMESTAMP
            )`
            : `CREATE TABLE IF NOT EXISTS user_client_telemetry_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                client_ip TEXT,
                location_label TEXT,
                geo_json TEXT,
                diagnostics_json TEXT,
                recorded_at ${ts} DEFAULT CURRENT_TIMESTAMP
            )`
    ];
    let i = 0;
    const next = () => {
        if (i >= steps.length) return cb && cb(null);
        db.run(steps[i++], (err) => {
            ignoreSchemaErr(err);
            next();
        });
    };
    next();
}

function upsertTelemetryRow(db, uid, ip, locationLabel, geoJson, diagnosticsJson, cb) {
    const finish = (err) => {
        if (err) return cb && cb(err);
        db.run(
            `INSERT INTO user_client_telemetry_log (user_id, client_ip, location_label, geo_json, diagnostics_json)
             VALUES (?, ?, ?, ?, ?)`,
            [uid, ip, locationLabel, geoJson, diagnosticsJson],
            (logErr) => {
                if (logErr) return cb && cb(logErr);
                db.all(
                    `SELECT id FROM user_client_telemetry_log WHERE user_id = ? ORDER BY id DESC`,
                    [uid],
                    (listErr, rows) => {
                        if (listErr) return cb && cb(listErr);
                        const drop = (rows || []).slice(30).map((r) => r.id);
                        if (!drop.length) return cb && cb(null);
                        const placeholders = drop.map(() => '?').join(',');
                        db.run(
                            `DELETE FROM user_client_telemetry_log WHERE id IN (${placeholders})`,
                            drop,
                            () => cb && cb(null)
                        );
                    }
                );
            }
        );
    };

    db.run(
        `INSERT INTO user_client_telemetry (user_id, client_ip, location_label, geo_json, diagnostics_json, updated_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id) DO UPDATE SET
            client_ip = excluded.client_ip,
            location_label = COALESCE(excluded.location_label, user_client_telemetry.location_label),
            geo_json = COALESCE(excluded.geo_json, user_client_telemetry.geo_json),
            diagnostics_json = COALESCE(excluded.diagnostics_json, user_client_telemetry.diagnostics_json),
            updated_at = CURRENT_TIMESTAMP`,
        [uid, ip, locationLabel, geoJson, diagnosticsJson],
        (err) => {
            if (err && /ON CONFLICT/i.test(String(err.message))) {
                return db.run(
                    `REPLACE INTO user_client_telemetry (user_id, client_ip, location_label, geo_json, diagnostics_json, updated_at)
                     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                    [uid, ip, locationLabel, geoJson, diagnosticsJson],
                    finish
                );
            }
            finish(err);
        }
    );
}

function saveUserClientTelemetry(db, userId, req, clientDiagnostics, cb) {
    const uid = parseInt(userId, 10);
    if (!Number.isInteger(uid) || uid < 1) return cb && cb(new Error('Invalid user id'));

    ensureUserClientTelemetrySchema(db, (schemaErr) => {
        if (schemaErr) return cb && cb(schemaErr);

        const ip = supportLiveChat.getClientIpFromReq(req) || null;
        const diagnosticsJson =
            clientDiagnostics != null
                ? typeof clientDiagnostics === 'string'
                    ? clientDiagnostics
                    : JSON.stringify(clientDiagnostics)
                : null;

        if (!ip) return upsertTelemetryRow(db, uid, ip, null, null, diagnosticsJson, cb);

        supportLiveChat.lookupIpGeo(ip, (geoErr, geo) => {
            const locationLabel = geo && geo.label ? geo.label : null;
            const geoJson = geo ? JSON.stringify(geo) : null;
            upsertTelemetryRow(db, uid, ip, locationLabel, geoJson, diagnosticsJson, cb);
        });
    });
}

function getUserClientTelemetry(db, userId, cb) {
    const uid = parseInt(userId, 10);
    if (!Number.isInteger(uid) || uid < 1) return cb && cb(new Error('Invalid user id'));

    ensureUserClientTelemetrySchema(db, (schemaErr) => {
        if (schemaErr) return cb && cb(schemaErr);
        db.get(`SELECT * FROM user_client_telemetry WHERE user_id = ?`, [uid], (err, row) => {
            if (err) return cb && cb(err);
            db.all(
                `SELECT id, client_ip, location_label, geo_json, diagnostics_json, recorded_at
                 FROM user_client_telemetry_log WHERE user_id = ? ORDER BY id DESC LIMIT 20`,
                [uid],
                (err2, history) => {
                    if (err2) return cb && cb(err2);
                    const latest = summaryFromRow(row);
                    const geo = parseJsonField(row && row.geo_json);
                    cb(null, {
                        latest: latest
                            ? {
                                  ...latest,
                                  geo,
                                  diagnostics: parseJsonField(row && row.diagnostics_json)
                              }
                            : null,
                        history: (history || []).map((h) => {
                            const diag = parseJsonField(h.diagnostics_json);
                            return {
                                id: h.id,
                                ip: h.client_ip || null,
                                location: h.location_label || null,
                                device: deviceLabelFromDiagnostics(diag),
                                network: networkLabelFromDiagnostics(diag),
                                recordedAt: h.recorded_at || null
                            };
                        })
                    });
                }
            );
        });
    });
}

function getTelemetrySummariesForUsers(db, userIds, cb) {
    const ids = (userIds || [])
        .map((id) => parseInt(id, 10))
        .filter((id) => Number.isInteger(id) && id > 0);
    if (!ids.length) return cb && cb(null, {});

    ensureUserClientTelemetrySchema(db, (schemaErr) => {
        if (schemaErr) return cb && cb(schemaErr);
        const placeholders = ids.map(() => '?').join(',');
        db.all(
            `SELECT * FROM user_client_telemetry WHERE user_id IN (${placeholders})`,
            ids,
            (err, rows) => {
                if (err) return cb && cb(err);
                const out = {};
                (rows || []).forEach((row) => {
                    out[String(row.user_id)] = summaryFromRow(row);
                });
                cb(null, out);
            }
        );
    });
}

module.exports = {
    ensureUserClientTelemetrySchema,
    saveUserClientTelemetry,
    getUserClientTelemetry,
    getTelemetrySummariesForUsers,
    summaryFromRow,
    deviceLabelFromDiagnostics,
    networkLabelFromDiagnostics
};
