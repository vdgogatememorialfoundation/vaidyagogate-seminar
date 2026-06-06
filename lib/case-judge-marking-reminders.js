/**
 * Reminder emails/WhatsApp for judges who have not locked marks before marking_deadline.
 */
const notif = require('./notification-engine');
const integrationSettings = require('./integration-settings');
const markingDeadline = require('./case-marking-deadline');

const CONFIG_KEY = 'case_judge_marking_reminder_config';
const EVENT_ASSIGNED = 'CASE_JUDGE_ASSIGNED';
const EVENT_REMINDER = 'CASE_JUDGE_MARKING_REMINDER';
const LOG_TABLE = 'case_judge_marking_reminder_log';

const DEFAULT_CONFIG = {
    enabled: false,
    intervalDays: 2,
    maxReminders: 12,
    channels: { email: true, whatsapp: false },
    urgentHoursBeforeDeadline: 24
};

function todayYmdIst() {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(new Date());
}

function judgePortalUrl() {
    const rt = integrationSettings.getRuntimeIntegrations();
    const base = rt.judge_host || rt.public_base_url || process.env.PUBLIC_BASE_URL || 'https://seminar.vaidyagogate.org';
    return String(base).replace(/\/$/, '').replace(/\/doctor\.html$/i, '') + '/judge.html';
}

function normalizeConfig(raw) {
    const c = { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) };
    c.enabled = !!(c.enabled === true || c.enabled === 1 || c.enabled === '1');
    c.intervalDays = Math.max(1, Math.min(14, parseInt(c.intervalDays, 10) || 2));
    c.maxReminders = Math.max(1, Math.min(30, parseInt(c.maxReminders, 10) || 12));
    c.urgentHoursBeforeDeadline = Math.max(1, Math.min(72, parseInt(c.urgentHoursBeforeDeadline, 10) || 24));
    c.channels = c.channels && typeof c.channels === 'object' ? c.channels : DEFAULT_CONFIG.channels;
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
            judge_user_id INTEGER NOT NULL,
            submission_id INTEGER NOT NULL,
            sent_date TEXT NOT NULL,
            PRIMARY KEY (judge_user_id, submission_id, sent_date)
        )`,
        [],
        () => cb && cb()
    );
}

function daysSince(iso) {
    if (!iso) return 999;
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return 999;
    return Math.floor((Date.now() - t) / 86400000);
}

function countReminders(db, judgeUserId, submissionId, cb) {
    db.get(
        `SELECT COUNT(*) AS c FROM ${LOG_TABLE} WHERE judge_user_id = ? AND submission_id = ?`,
        [judgeUserId, submissionId],
        (e, row) => {
            if (e) return cb(e, 0);
            cb(null, Number(row && row.c) || 0);
        }
    );
}

function notifyJudge(db, judgeUserId, eventKey, vars, cb) {
    db.get(
        `SELECT id, first_name, last_name, email FROM users WHERE id = ?`,
        [judgeUserId],
        (e, judgeRow) => {
            if (e) return cb && cb(e);
            if (!judgeRow || !judgeRow.id) return cb && cb(null, { skipped: true });
            notif.notify(
                db,
                eventKey,
                {
                    userId: judgeRow.id,
                    vars: Object.assign(
                        {
                            judge_name: [judgeRow.first_name, judgeRow.last_name].filter(Boolean).join(' ').trim(),
                            portal_login_url: judgePortalUrl()
                        },
                        vars || {}
                    ),
                    immediate: true
                },
                cb
            );
        }
    );
}

function notifyJudgeAssigned(db, judgeUserId, submissionRow, cb) {
    if (!judgeUserId || !submissionRow) return cb && cb(null, { skipped: true });
    notifyJudge(
        db,
        judgeUserId,
        EVENT_ASSIGNED,
        {
            application_no: submissionRow.application_no || String(submissionRow.id),
            case_topic: submissionRow.title || submissionRow.case_topic || 'Case presentation',
            marking_deadline: markingDeadline.formatMarkingDeadlineDisplay(submissionRow.marking_deadline),
            marking_deadline_iso: submissionRow.marking_deadline || ''
        },
        cb
    );
}

function notifyAssignedJudges(db, submissionId, judgeIds, cb) {
    const sid = parseInt(submissionId, 10);
    if (!Number.isInteger(sid) || sid < 1 || !Array.isArray(judgeIds) || !judgeIds.length) {
        return cb && cb(null, { skipped: true });
    }
    db.get(
        `SELECT id, application_no, title, marking_deadline FROM case_submissions WHERE id = ?`,
        [sid],
        (e, sub) => {
            if (e || !sub) return cb && cb(e);
            let left = judgeIds.length;
            let sent = 0;
            judgeIds.forEach((jid) => {
                notifyJudgeAssigned(db, jid, sub, (eN) => {
                    if (!eN) sent += 1;
                    left -= 1;
                    if (left === 0) cb && cb(null, { sent });
                });
            });
        }
    );
}

function runCaseJudgeMarkingReminders(db, cb) {
    loadConfig(db, (eCfg, cfg) => {
        if (eCfg) return cb && cb(eCfg);
        if (!cfg.enabled) return cb && cb(null, { skipped: true, reason: 'disabled' });
        const today = todayYmdIst();
        const now = Date.now();
        db.all(
            `SELECT cja.judge_user_id, cja.submission_id, cja.assigned_at,
                    cs.application_no, cs.title, cs.marking_deadline, cs.status,
                    u.email, u.first_name, u.last_name
             FROM case_judge_assignments cja
             JOIN case_submissions cs ON cs.id = cja.submission_id
             JOIN users u ON u.id = cja.judge_user_id
             LEFT JOIN case_judge_scores cjs ON cjs.submission_id = cja.submission_id
                 AND cjs.judge_user_id = cja.judge_user_id AND IFNULL(cjs.is_locked, 0) = 1
             WHERE cs.status = 'judging'
               AND cs.marking_deadline IS NOT NULL AND TRIM(cs.marking_deadline) != ''
               AND cjs.id IS NULL`,
            [],
            (err, rows) => {
                if (err) return cb && cb(err);
                let sent = 0;
                let examined = 0;
                const list = (rows || []).filter((r) => !markingDeadline.isMarkingDeadlinePassed(r.marking_deadline, now));
                const finish = () => cb && cb(null, { sent, examined, today });

                function next(i) {
                    if (i >= list.length) return finish();
                    const r = list[i];
                    examined += 1;
                    const msLeft = markingDeadline.msUntilDeadline(r.marking_deadline);
                    const urgent =
                        msLeft != null && msLeft <= cfg.urgentHoursBeforeDeadline * 3600000 && msLeft > 0;
                    const ageBase = r.assigned_at || r.marking_deadline;
                    if (!urgent && daysSince(ageBase) < cfg.intervalDays) return next(i + 1);
                    countReminders(db, r.judge_user_id, r.submission_id, (eCnt, cnt) => {
                        if (eCnt || cnt >= cfg.maxReminders) return next(i + 1);
                        db.get(
                            `SELECT 1 FROM ${LOG_TABLE} WHERE judge_user_id = ? AND submission_id = ? AND sent_date = ?`,
                            [r.judge_user_id, r.submission_id, today],
                            (eHit, hit) => {
                                if (eHit || hit) return next(i + 1);
                                notifyJudge(
                                    db,
                                    r.judge_user_id,
                                    EVENT_REMINDER,
                                    {
                                        application_no: r.application_no || String(r.submission_id),
                                        case_topic: r.title || 'Case presentation',
                                        marking_deadline: markingDeadline.formatMarkingDeadlineDisplay(r.marking_deadline),
                                        days_remaining:
                                            msLeft != null ? String(Math.max(0, Math.ceil(msLeft / 86400000))) : ''
                                    },
                                    (eN) => {
                                        if (!eN) {
                                            db.run(
                                                `INSERT OR IGNORE INTO ${LOG_TABLE} (judge_user_id, submission_id, sent_date) VALUES (?, ?, ?)`,
                                                [r.judge_user_id, r.submission_id, today],
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
    EVENT_ASSIGNED,
    EVENT_REMINDER,
    LOG_TABLE,
    DEFAULT_CONFIG,
    normalizeConfig,
    loadConfig,
    saveConfig,
    ensureSchema,
    judgePortalUrl,
    notifyJudgeAssigned,
    notifyAssignedJudges,
    runCaseJudgeMarkingReminders
};
