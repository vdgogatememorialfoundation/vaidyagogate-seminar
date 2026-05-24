/**
 * Extended platform modules: volunteers, registration overrides, case management, certificate candidates.
 */

function ensureExtendedModulesSchema(db, ignoreErr, next) {
    db.serialize(() => {
        db.run(
            `CREATE TABLE IF NOT EXISTS registration_overrides (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                seminar_id INTEGER NOT NULL,
                enabled INTEGER DEFAULT 1,
                note TEXT,
                created_by INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, seminar_id)
            )`,
            (e) => {
                ignoreErr(e);
                db.run(
                    `CREATE TABLE IF NOT EXISTS seminar_volunteers (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        seminar_id INTEGER NOT NULL,
                        user_id INTEGER NOT NULL,
                        status TEXT DEFAULT 'pending',
                        approved_by INTEGER,
                        approved_at DATETIME,
                        volunteer_ticket_id_string TEXT,
                        notes TEXT,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        UNIQUE(seminar_id, user_id)
                    )`,
                    (e2) => {
                        ignoreErr(e2);
                        db.run(
                            `CREATE TABLE IF NOT EXISTS volunteer_certificates (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                user_id INTEGER NOT NULL,
                                seminar_id INTEGER NOT NULL,
                                registration_id INTEGER,
                                display_name TEXT NOT NULL,
                                template_id INTEGER,
                                enabled INTEGER DEFAULT 0,
                                scan_verified INTEGER DEFAULT 0,
                                scan_time DATETIME,
                                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                                UNIQUE(user_id, seminar_id)
                            )`,
                            (e3) => {
                                ignoreErr(e3);
                                db.run(`ALTER TABLE volunteer_certificates ADD COLUMN scan_time TEXT`, (e3a) => {
                                    ignoreErr(e3a);
                                    db.run(`ALTER TABLE seminar_volunteers ADD COLUMN duties TEXT`, (e3d) => {
                                        ignoreErr(e3d);
                                        db.run(
                                            `ALTER TABLE certificate_templates ADD COLUMN cert_type TEXT DEFAULT 'participant'`,
                                            (e4) => {
                                                ignoreErr(e4);
                                                db.run(
                                                    `ALTER TABLE certificate_templates ADD COLUMN config_json TEXT`,
                                                    (e4b) => {
                                                        ignoreErr(e4b);
                                                        db.run(
                                                            `CREATE TABLE IF NOT EXISTS case_submissions (
                                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                                            user_id INTEGER NOT NULL,
                                            seminar_id INTEGER,
                                            title TEXT NOT NULL,
                                            status TEXT DEFAULT 'draft',
                                            fee_amount REAL DEFAULT 0,
                                            order_id INTEGER,
                                            winner_flag INTEGER DEFAULT 0,
                                            admin_notes TEXT,
                                            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                                            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                                        )`,
                                                            (e5) => {
                                                                ignoreErr(e5);
                                                                db.run(
                                                                    `CREATE TABLE IF NOT EXISTS case_files (
                                                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                    submission_id INTEGER NOT NULL,
                                                    file_path TEXT NOT NULL,
                                                    original_name TEXT,
                                                    status TEXT DEFAULT 'pending',
                                                    rejection_reason TEXT,
                                                    sort_order INTEGER DEFAULT 0,
                                                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                                                    FOREIGN KEY (submission_id) REFERENCES case_submissions(id)
                                                )`,
                                                                    (e6) => {
                                                                        ignoreErr(e6);
                                                                        db.run(
                                                                            `CREATE TABLE IF NOT EXISTS case_judge_assignments (
                                                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                            submission_id INTEGER NOT NULL,
                                                            judge_user_id INTEGER NOT NULL,
                                                            assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                                                            UNIQUE(submission_id, judge_user_id)
                                                        )`,
                                                                            (e7) => {
                                                                                ignoreErr(e7);
                                                                                db.run(
                                                                                    `CREATE TABLE IF NOT EXISTS case_judge_scores (
                                                                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                                    submission_id INTEGER NOT NULL,
                                                                    judge_user_id INTEGER NOT NULL,
                                                                    criteria_json TEXT,
                                                                    total_score REAL,
                                                                    remarks TEXT,
                                                                    is_locked INTEGER DEFAULT 0,
                                                                    submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                                                                    UNIQUE(submission_id, judge_user_id)
                                                                )`,
                                                                                    (e8) => {
                                                                                        ignoreErr(e8);
                                                                                        if (next) next();
                                                                                    }
                                                                                );
                                                                            }
                                                                        );
                                                                    }
                                                                );
                                                            }
                                                        );
                                                    }
                                                );
                                            }
                                        );
                                    });
                                });
                            }
                        );
                    }
                );
            }
        );
    });
}

function getGlobalSetting(db, key, cb) {
    db.get(`SELECT value FROM global_settings WHERE key = ?`, [key], (e, row) => {
        if (e) return cb(e);
        cb(null, row && row.value != null ? String(row.value) : '');
    });
}

function userHasRegistrationOverride(db, userId, seminarId, cb) {
    db.get(
        `SELECT enabled FROM registration_overrides WHERE user_id = ? AND seminar_id = ? AND enabled = 1`,
        [userId, seminarId],
        (e, row) => {
            if (e) return cb(e);
            if (row) return cb(null, true);
            db.get(
                `SELECT id FROM seminar_volunteers
                 WHERE user_id = ? AND seminar_id = ? AND status = 'pending'
                   AND (volunteer_ticket_id_string IS NULL OR trim(volunteer_ticket_id_string) = '')`,
                [userId, seminarId],
                (e2, vol) => {
                    if (e2) return cb(e2);
                    cb(null, !!(vol && vol.id));
                }
            );
        }
    );
}

module.exports = {
    ensureExtendedModulesSchema,
    getGlobalSetting,
    userHasRegistrationOverride
};
