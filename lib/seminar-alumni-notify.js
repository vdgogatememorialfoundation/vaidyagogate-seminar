/**
 * Notify paid participants from linked past seminars when a new year's seminar opens.
 */
const seminarDt = require('./seminar-datetime');

const EVENT_KEY = 'SEMINAR_ALUMNI_INVITE';
const LOG_TABLE = 'seminar_alumni_notification_log';

function isPg() {
    return !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
}

function ignoreErr(e) {
    if (e && !/duplicate column|already exists/i.test(String(e.message))) {
        console.warn('[seminar-alumni-notify]', e.message);
    }
}

function parseSourceIds(raw, excludeSeminarId) {
    let ids = [];
    if (Array.isArray(raw)) ids = raw;
    else if (raw != null && String(raw).trim()) {
        try {
            const parsed = JSON.parse(String(raw));
            if (Array.isArray(parsed)) ids = parsed;
        } catch (_) {
            ids = [];
        }
    }
    const ex = parseInt(excludeSeminarId, 10);
    return [
        ...new Set(
            ids
                .map((id) => parseInt(id, 10))
                .filter((id) => Number.isInteger(id) && id > 0 && (!Number.isInteger(ex) || id !== ex))
        )
    ];
}

function registrationOpen(row) {
    if (!row) return false;
    const now = Date.now();
    const rs = seminarDt.parseSeminarMs(row.registration_start);
    const re = seminarDt.parseSeminarMs(row.registration_end);
    if (rs != null && now < rs) return false;
    if (re != null && now > re) return false;
    return true;
}

function ensureSchema(db, cb) {
    const ts = isPg() ? 'TIMESTAMPTZ' : 'TEXT';
    const steps = [
        `ALTER TABLE seminars ADD COLUMN alumni_source_seminar_ids TEXT`,
        `ALTER TABLE seminars ADD COLUMN alumni_notify_auto INTEGER DEFAULT 0`,
        `ALTER TABLE seminars ADD COLUMN alumni_notify_sent_at ${ts}`,
        `CREATE TABLE IF NOT EXISTS ${LOG_TABLE} (
            target_seminar_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            sent_at ${ts} DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (target_seminar_id, user_id)
        )`
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

function loadSourceSeminarTitles(db, sourceIds, cb) {
    if (!sourceIds.length) return cb(null, []);
    const ph = sourceIds.map(() => '?').join(',');
    db.all(
        `SELECT id, title, portal_year, event_date FROM seminars WHERE id IN (${ph}) ORDER BY portal_year ASC, event_date ASC, id ASC`,
        sourceIds,
        (err, rows) => {
            if (err) return cb(err);
            cb(null, rows || []);
        }
    );
}

function buildRecipientSql(sourceIds, targetSeminarId, skipLog) {
    const ph = sourceIds.map(() => '?').join(',');
    let sql = `SELECT DISTINCT u.id AS user_id, u.email, u.phone, u.first_name, u.last_name, u.user_id_string
               FROM registrations r
               JOIN users u ON u.id = r.user_id
               JOIN orders o ON o.registration_id = r.id AND lower(trim(o.status)) = 'success'
               WHERE r.seminar_id IN (${ph})
                 AND r.status NOT IN ('rejected', 'cancelled')
                 AND IFNULL(u.is_disabled, 0) = 0
                 AND u.id NOT IN (
                     SELECT r2.user_id FROM registrations r2
                     WHERE r2.seminar_id = ? AND r2.status NOT IN ('rejected', 'cancelled')
                 )`;
    const params = sourceIds.slice();
    params.push(targetSeminarId);
    if (!skipLog) {
        sql += ` AND u.id NOT IN (
                     SELECT user_id FROM ${LOG_TABLE} WHERE target_seminar_id = ?
                 )`;
        params.push(targetSeminarId);
    }
    sql += ` ORDER BY u.id ASC`;
    return { sql, params };
}

function countRecipients(db, targetSeminarId, sourceIds, skipLog, cb) {
    const ids = parseSourceIds(sourceIds, targetSeminarId);
    if (!ids.length) return cb(null, { count: 0, sourceIds: ids });
    const { sql, params } = buildRecipientSql(ids, targetSeminarId, skipLog);
    db.all(sql, params, (err, rows) => {
        if (err) return cb(err);
        cb(null, { count: (rows || []).length, sourceIds: ids, sample: (rows || []).slice(0, 8) });
    });
}

function markAlumniNotifySent(db, targetSeminarId, cb) {
    const now = new Date().toISOString();
    db.run(`UPDATE seminars SET alumni_notify_sent_at = ? WHERE id = ?`, [now, targetSeminarId], cb);
}

function sendAlumniNotifications(db, notifEngine, targetSeminarId, sourceIds, opts, cb) {
    opts = opts || {};
    const sid = parseInt(targetSeminarId, 10);
    if (!Number.isInteger(sid) || sid < 1) return cb(new Error('Invalid seminar id'));
    const ids = parseSourceIds(sourceIds, sid);
    if (!ids.length) return cb(null, { sent: 0, skipped: true, reason: 'no_source_seminars' });

    db.get(`SELECT * FROM seminars WHERE id = ?`, [sid], (eSem, target) => {
        if (eSem) return cb(eSem);
        if (!target) return cb(new Error('Seminar not found'));

        loadSourceSeminarTitles(db, ids, (eTitles, pastRows) => {
            if (eTitles) return cb(eTitles);
            const pastTitles = (pastRows || []).map((r) => r.title || 'Past seminar').join('; ');
            const pastYears = [...new Set((pastRows || []).map((r) => r.portal_year).filter(Boolean))].sort();
            const previousYearsLabel = pastYears.length ? ` (${pastYears.join(', ')})` : '';

            const { sql, params } = buildRecipientSql(ids, sid, !!opts.forceResend);
            db.all(sql, params, (eList, recipients) => {
                if (eList) return cb(eList);
                const list = recipients || [];
                if (!list.length) {
                    return cb(null, {
                        sent: 0,
                        recipients: 0,
                        message: 'No eligible past participants found (already registered or already notified).'
                    });
                }

                let sent = 0;
                let left = list.length;
                const doneAll = (err) => {
                    if (err) return cb(err);
                    if (opts.markSent && sent > 0) {
                        return markAlumniNotifySent(db, sid, (eMark) => {
                            if (eMark) console.warn('[seminar-alumni-notify] mark sent:', eMark.message);
                            if (notifEngine && notifEngine.processQueueOnce) notifEngine.processQueueOnce(db);
                            cb(null, { sent, recipients: list.length, sourceSeminarIds: ids });
                        });
                    }
                    if (notifEngine && notifEngine.processQueueOnce) notifEngine.processQueueOnce(db);
                    cb(null, { sent, recipients: list.length, sourceSeminarIds: ids });
                };

                const logSent = (userId, next) => {
                    const ins = isPg()
                        ? `INSERT INTO ${LOG_TABLE} (target_seminar_id, user_id, sent_at) VALUES (?, ?, CURRENT_TIMESTAMP)
                           ON CONFLICT (target_seminar_id, user_id) DO NOTHING`
                        : `INSERT OR IGNORE INTO ${LOG_TABLE} (target_seminar_id, user_id, sent_at) VALUES (?, ?, datetime('now'))`;
                    db.run(ins, [sid, userId], () => next());
                };

                list.forEach((u) => {
                    notifEngine.notify(
                        db,
                        EVENT_KEY,
                        {
                            userId: u.user_id,
                            seminarId: sid,
                            vars: {
                                previous_seminar_titles: pastTitles,
                                previous_seminar_years: previousYearsLabel,
                                payment_amount: target.price != null ? String(target.price) : ''
                            }
                        },
                        (nErr) => {
                            if (!nErr) {
                                sent++;
                                logSent(u.user_id, () => {
                                    left--;
                                    if (left <= 0) doneAll();
                                });
                            } else {
                                left--;
                                if (left <= 0) doneAll();
                            }
                        }
                    );
                });
            });
        });
    });
}

function maybeTriggerAutoAlumniNotify(db, notifEngine, seminarId, cb) {
    const sid = parseInt(seminarId, 10);
    if (!Number.isInteger(sid) || sid < 1) return cb && cb(null, { skipped: true });
    db.get(`SELECT * FROM seminars WHERE id = ?`, [sid], (err, row) => {
        if (err) return cb && cb(err);
        if (!row || !Number(row.alumni_notify_auto)) return cb && cb(null, { skipped: true, reason: 'auto_off' });
        if (row.alumni_notify_sent_at) return cb && cb(null, { skipped: true, reason: 'already_sent' });
        const sources = parseSourceIds(row.alumni_source_seminar_ids, sid);
        if (!sources.length) return cb && cb(null, { skipped: true, reason: 'no_sources' });
        if (!registrationOpen(row)) return cb && cb(null, { skipped: true, reason: 'registration_not_open' });
        sendAlumniNotifications(db, notifEngine, sid, sources, { markSent: true }, cb);
    });
}

function runAutoAlumniNotifications(db, notifEngine, cb) {
    db.all(
        `SELECT id, title, registration_start, registration_end, alumni_source_seminar_ids, alumni_notify_sent_at
         FROM seminars
         WHERE IFNULL(alumni_notify_auto, 0) = 1
           AND alumni_notify_sent_at IS NULL
           AND alumni_source_seminar_ids IS NOT NULL
           AND trim(alumni_source_seminar_ids) != ''
           AND trim(alumni_source_seminar_ids) != '[]'
           AND IFNULL(is_active, 1) = 1`,
        [],
        (err, rows) => {
            if (err) return cb && cb(err);
            const list = rows || [];
            if (!list.length) return cb && cb(null, { processed: 0 });
            let processed = 0;
            let totalSent = 0;
            let i = 0;
            const next = () => {
                if (i >= list.length) return cb && cb(null, { processed, totalSent });
                const row = list[i++];
                if (!registrationOpen(row)) return next();
                const sources = parseSourceIds(row.alumni_source_seminar_ids, row.id);
                if (!sources.length) return next();
                sendAlumniNotifications(db, notifEngine, row.id, sources, { markSent: true }, (eSend, result) => {
                    processed++;
                    if (!eSend && result && result.sent) totalSent += result.sent;
                    if (eSend) console.warn('[seminar-alumni-notify] auto:', row.id, eSend.message);
                    next();
                });
            };
            next();
        }
    );
}

function serializeSourceIds(ids) {
    const norm = parseSourceIds(ids, null);
    return JSON.stringify(norm);
}

module.exports = {
    EVENT_KEY,
    ensureSchema,
    parseSourceIds,
    serializeSourceIds,
    registrationOpen,
    countRecipients,
    sendAlumniNotifications,
    maybeTriggerAutoAlumniNotify,
    runAutoAlumniNotifications,
    loadSourceSeminarTitles
};
