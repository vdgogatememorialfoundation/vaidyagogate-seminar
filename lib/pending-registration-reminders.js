/**
 * Admin-configurable reminders for doctors with pending registration / missing documents.
 */
const notif = require('./notification-engine');

const CONFIG_KEY = 'pending_registration_reminder_config';
const EVENT_KEY = 'REGISTRATION_PENDING_REMINDER';
const LOG_TABLE = 'pending_registration_reminder_log';

const DEFAULT_CONFIG = {
    enabled: false,
    intervalDays: 3,
    maxReminders: 5,
    statuses: ['submitted', 'pending_approval', 'revision_required'],
    channels: { email: true, whatsapp: true },
    requireMissingDocuments: true
};

function todayYmdIst() {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(new Date());
}

function normalizeConfig(raw) {
    const c = { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) };
    c.enabled = !!(c.enabled === true || c.enabled === 1 || c.enabled === '1');
    c.intervalDays = Math.max(1, Math.min(30, parseInt(c.intervalDays, 10) || 3));
    c.maxReminders = Math.max(1, Math.min(20, parseInt(c.maxReminders, 10) || 5));
    if (!Array.isArray(c.statuses) || !c.statuses.length) {
        c.statuses = DEFAULT_CONFIG.statuses.slice();
    }
    c.statuses = c.statuses.map((s) => String(s || '').trim()).filter(Boolean);
    c.channels = c.channels && typeof c.channels === 'object' ? c.channels : DEFAULT_CONFIG.channels;
    c.requireMissingDocuments = c.requireMissingDocuments !== false && c.requireMissingDocuments !== 0;
    return c;
}

function loadConfig(db, cb) {
    db.get(`SELECT value FROM global_settings WHERE key = ?`, [CONFIG_KEY], (err, row) => {
        if (err) return cb(err);
        if (!row || !row.value) return cb(null, normalizeConfig(null));
        try {
            return cb(null, normalizeConfig(JSON.parse(row.value)));
        } catch (_) {
            return cb(null, normalizeConfig(null));
        }
    });
}

function saveConfig(db, config, cb) {
    const norm = normalizeConfig(config);
    const json = JSON.stringify(norm);
    db.run(`UPDATE global_settings SET value = ? WHERE key = ?`, [json, CONFIG_KEY], function (uerr) {
        if (uerr) return cb(uerr);
        if (this.changes > 0) return cb(null, norm);
        db.run(`INSERT INTO global_settings (key, value) VALUES (?, ?)`, [CONFIG_KEY, json], (ierr) => cb(ierr, norm));
    });
}

function ensureSchema(db, cb) {
    db.run(
        `CREATE TABLE IF NOT EXISTS ${LOG_TABLE} (
            registration_id INTEGER NOT NULL,
            sent_date TEXT NOT NULL,
            PRIMARY KEY (registration_id, sent_date)
        )`,
        [],
        () => cb && cb()
    );
}

function registrationNeedsDocumentNudge(row) {
    const st = String(row.status || '');
    if (st === 'revision_required') return true;
    let fd = {};
    try {
        fd = JSON.parse(row.form_data || '{}');
    } catch (_) {
        fd = {};
    }
    let doc = null;
    try {
        doc = row.doc_review_json ? JSON.parse(row.doc_review_json) : null;
    } catch (_) {
        doc = null;
    }
    if (doc && doc.decision === 'approve') return false;
    const hasCert = !!(fd.certificate_path || fd.ncism_certificate_path);
    const hasNcism = !!(fd.ncism || fd.ncism_number);
    if (!hasCert || !hasNcism) return true;
    if (doc && (doc.ncism_ok === false || doc.certificate_ok === false)) return true;
    return st === 'submitted' || st === 'pending_approval';
}

function daysSince(iso) {
    if (!iso) return 999;
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return 999;
    return Math.floor((Date.now() - t) / 86400000);
}

function countReminders(db, registrationId, cb) {
    db.get(`SELECT COUNT(*) AS c FROM ${LOG_TABLE} WHERE registration_id = ?`, [registrationId], (e, row) => {
        if (e) return cb(e, 0);
        cb(null, Number(row && row.c) || 0);
    });
}

function runPendingRegistrationReminders(db, cb) {
    loadConfig(db, (eCfg, cfg) => {
        if (eCfg) return cb && cb(eCfg);
        if (!cfg.enabled) return cb && cb(null, { skipped: true, reason: 'disabled' });
        const today = todayYmdIst();
        const placeholders = cfg.statuses.map(() => '?').join(',');
        db.all(
            `SELECT r.id AS registration_id, r.user_id, r.application_no, r.status, r.created_at, r.updated_at,
                    r.form_data, r.doc_review_json, r.seminar_id,
                    u.email, u.phone, u.first_name, u.last_name
             FROM registrations r
             JOIN users u ON u.id = r.user_id
             WHERE r.status IN (${placeholders})`,
            cfg.statuses,
            (err, rows) => {
                if (err) return cb && cb(err);
                let sent = 0;
                let examined = 0;
                const list = rows || [];
                const finish = () => cb && cb(null, { sent, examined, today });

                function next(i) {
                    if (i >= list.length) return finish();
                    const r = list[i];
                    examined += 1;
                    if (cfg.requireMissingDocuments && !registrationNeedsDocumentNudge(r)) {
                        return next(i + 1);
                    }
                    const ageBase = r.updated_at || r.created_at;
                    if (daysSince(ageBase) < cfg.intervalDays) return next(i + 1);
                    countReminders(db, r.registration_id, (eCnt, cnt) => {
                        if (eCnt || cnt >= cfg.maxReminders) return next(i + 1);
                        db.get(
                            `SELECT 1 FROM ${LOG_TABLE} WHERE registration_id = ? AND sent_date = ?`,
                            [r.registration_id, today],
                            (eHit, hit) => {
                                if (eHit || hit) return next(i + 1);
                                notif.notify(
                                    db,
                                    EVENT_KEY,
                                    {
                                        userId: r.user_id,
                                        seminarId: r.seminar_id,
                                        registrationId: r.registration_id,
                                        vars: {
                                            application_no: r.application_no,
                                            approval_status: r.status
                                        }
                                    },
                                    (eN) => {
                                        if (!eN) {
                                            db.run(
                                                `INSERT OR IGNORE INTO ${LOG_TABLE} (registration_id, sent_date) VALUES (?, ?)`,
                                                [r.registration_id, today],
                                                () => {
                                                    sent += 1;
                                                    next(i + 1);
                                                }
                                            );
                                        } else {
                                            next(i + 1);
                                        }
                                    }
                                );
                            }
                        );
                    });
                }
                next(0);
            }
        );
    });
}

module.exports = {
    CONFIG_KEY,
    EVENT_KEY,
    LOG_TABLE,
    DEFAULT_CONFIG,
    normalizeConfig,
    loadConfig,
    saveConfig,
    ensureSchema,
    runPendingRegistrationReminders
};
