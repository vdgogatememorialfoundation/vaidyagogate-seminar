/**
 * User & doctor activity audit log (global_settings-backed schema on SQLite).
 */
function ignoreErr(e) {
    if (e && !/duplicate column|already exists/i.test(String(e.message || e))) {
        console.warn('[activity-log]', e.message || e);
    }
}

function ensureActivityLogSchema(db, next) {
    db.serialize(() => {
        db.run(
            `CREATE TABLE IF NOT EXISTS user_activity_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                user_role TEXT,
                action TEXT NOT NULL,
                resource_type TEXT,
                resource_id TEXT,
                seminar_id INTEGER,
                ip TEXT,
                user_agent TEXT,
                meta TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )`,
            ignoreErr
        );
        db.run(
            `CREATE INDEX IF NOT EXISTS idx_activity_created ON user_activity_logs (created_at DESC)`,
            ignoreErr
        );
        db.run(`CREATE INDEX IF NOT EXISTS idx_activity_user ON user_activity_logs (user_id, created_at DESC)`, ignoreErr);
        db.run(`CREATE INDEX IF NOT EXISTS idx_activity_action ON user_activity_logs (action, created_at DESC)`, ignoreErr, () => {
            if (next) next();
        });
    });
}

function clientIp(req) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
    return req.ip || req.connection?.remoteAddress || '';
}

function logActivity(db, row) {
    if (!db || !row || !row.action) return;
    const meta =
        row.meta != null
            ? typeof row.meta === 'string'
                ? row.meta
                : JSON.stringify(row.meta).slice(0, 4000)
            : null;
    db.run(
        `INSERT INTO user_activity_logs (user_id, user_role, action, resource_type, resource_id, seminar_id, ip, user_agent, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            row.user_id || row.userId || null,
            row.user_role || row.role || null,
            String(row.action).slice(0, 120),
            row.resource_type || row.resourceType || null,
            row.resource_id != null ? String(row.resource_id).slice(0, 200) : null,
            row.seminar_id || row.seminarId || null,
            (row.ip || '').slice(0, 64),
            (row.user_agent || row.userAgent || '').slice(0, 400),
            meta
        ],
        (err) => {
            if (err) console.warn('[activity-log] insert:', err.message);
        }
    );
}

function logFromRequest(db, req, row) {
    logActivity(db, {
        ...row,
        ip: row.ip || clientIp(req),
        user_agent: row.user_agent || req.headers['user-agent']
    });
}

module.exports = {
    ensureActivityLogSchema,
    clientIp,
    logActivity,
    logFromRequest
};
