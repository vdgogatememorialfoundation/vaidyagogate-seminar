/**
 * Event-day checklist, reminders, and WhatsApp group invite helpers per seminar.
 */
const DEFAULT_CHECKLIST = [
    'Venue signage and registration desk ready',
    'Scanner staff logged in and tested',
    'WhatsApp group link verified in seminar settings',
    'Paid participants notified to join WhatsApp group',
    'Welcome announcement / notices posted on doctor portal',
    'Certificates and check-in flow tested',
    'Emergency contact numbers shared with volunteers'
];

function isPg() {
    return !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
}

function ignoreErr(e) {
    if (e && !/duplicate column|already exists/i.test(String(e.message))) {
        console.warn('[seminar-event-ops]', e.message);
    }
}

function ensureSchema(db, cb) {
    const ts = isPg() ? 'TIMESTAMPTZ' : 'DATETIME';
    const steps = [
        `CREATE TABLE IF NOT EXISTS seminar_event_checklist (
            id ${isPg() ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
            seminar_id INTEGER NOT NULL,
            label TEXT NOT NULL,
            sort_order INTEGER DEFAULT 0,
            is_done INTEGER DEFAULT 0,
            done_at ${ts},
            done_by_admin_id INTEGER,
            created_at ${ts} DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS seminar_event_reminder_log (
            id ${isPg() ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
            seminar_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            reminder_type TEXT NOT NULL,
            sent_at ${ts} DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(seminar_id, user_id, reminder_type)
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

function seedChecklistIfEmpty(db, seminarId, cb) {
    ensureSchema(db, (e) => {
        if (e) return cb(e);
        db.get(`SELECT COUNT(*) AS c FROM seminar_event_checklist WHERE seminar_id = ?`, [seminarId], (err, row) => {
            if (err) return cb(err);
            if (row && Number(row.c) > 0) return cb(null, false);
            let n = 0;
            const insertNext = () => {
                if (n >= DEFAULT_CHECKLIST.length) return cb(null, true);
                db.run(
                    `INSERT INTO seminar_event_checklist (seminar_id, label, sort_order) VALUES (?, ?, ?)`,
                    [seminarId, DEFAULT_CHECKLIST[n], n],
                    () => {
                        n++;
                        insertNext();
                    }
                );
            };
            insertNext();
        });
    });
}

function getChecklist(db, seminarId, cb) {
    seedChecklistIfEmpty(db, seminarId, (seedErr) => {
        if (seedErr) return cb(seedErr);
        db.all(
            `SELECT id, seminar_id, label, sort_order, is_done, done_at, done_by_admin_id
             FROM seminar_event_checklist WHERE seminar_id = ? ORDER BY sort_order ASC, id ASC`,
            [seminarId],
            (err, rows) => cb(err, rows || [])
        );
    });
}

function toggleChecklistItem(db, itemId, adminId, done, cb) {
    db.run(
        `UPDATE seminar_event_checklist SET is_done = ?, done_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END,
         done_by_admin_id = CASE WHEN ? = 1 THEN ? ELSE NULL END WHERE id = ?`,
        [done ? 1 : 0, done ? 1 : 0, done ? 1 : 0, adminId || null, itemId],
        function (err) {
            cb(err, this.changes);
        }
    );
}

function listPaidWithTickets(db, seminarId, cb) {
    db.all(
        `SELECT DISTINCT u.id AS user_id, u.first_name, u.last_name, u.email, u.phone, u.whatsapp,
                r.id AS registration_id, r.application_no, t.ticket_id_string
         FROM registrations r
         JOIN users u ON u.id = r.user_id
         JOIN tickets t ON t.registration_id = r.id AND IFNULL(t.is_valid,1) = 1
         WHERE r.seminar_id = ?
           AND LOWER(IFNULL(r.status,'')) IN ('completed','checked_in','e_ticket_issued','certificate_issued')
         ORDER BY u.last_name, u.first_name`,
        [seminarId],
        (err, rows) => cb(err, rows || [])
    );
}

function sendEventDayReminders(db, notifEngine, seminarId, reminderType, cb) {
    const type = String(reminderType || 'event_day').trim();
    db.get(`SELECT id, title, event_date, whatsapp_group_url, location_url FROM seminars WHERE id = ?`, [seminarId], (eSem, sem) => {
        if (eSem) return cb(eSem);
        if (!sem) return cb(null, { sent: 0, error: 'Seminar not found' });

        listPaidWithTickets(db, seminarId, (eList, rows) => {
            if (eList) return cb(eList);
            let sent = 0;
            let i = 0;
            const run = () => {
                if (i >= rows.length) return cb(null, { sent, total: rows.length });
                const row = rows[i++];
                db.get(
                    `SELECT 1 AS ok FROM seminar_event_reminder_log WHERE seminar_id = ? AND user_id = ? AND reminder_type = ?`,
                    [seminarId, row.user_id, type],
                    (eLog, logged) => {
                        if (logged) return run();
                        notifEngine.notify(
                            db,
                            type === 'whatsapp_group' ? 'WHATSAPP_GROUP_INVITE' : 'SEMINAR_REMINDER',
                            {
                                userId: row.user_id,
                                seminarId,
                                registrationId: row.registration_id,
                                vars: {
                                    seminar_title: sem.title,
                                    event_date: sem.event_date,
                                    whatsapp_group_url: sem.whatsapp_group_url || '',
                                    location_url: sem.location_url || '',
                                    ticket_id: row.ticket_id_string || ''
                                }
                            },
                            (nErr) => {
                                if (!nErr) {
                                    sent++;
                                    const logSql = isPg()
                                        ? `INSERT INTO seminar_event_reminder_log (seminar_id, user_id, reminder_type) VALUES (?, ?, ?)
                                           ON CONFLICT (seminar_id, user_id, reminder_type) DO NOTHING`
                                        : `INSERT OR IGNORE INTO seminar_event_reminder_log (seminar_id, user_id, reminder_type) VALUES (?, ?, ?)`;
                                    db.run(logSql, [seminarId, row.user_id, type], () => run());
                                } else run();
                            }
                        );
                    }
                );
            };
            run();
        });
    });
}

module.exports = {
    DEFAULT_CHECKLIST,
    ensureSchema,
    getChecklist,
    toggleChecklistItem,
    listPaidWithTickets,
    sendEventDayReminders
};
