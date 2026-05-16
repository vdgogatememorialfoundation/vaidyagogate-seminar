const cron = require('node-cron');
const { processQueueOnce } = require('./notification-engine');
const notif = require('./notification-engine');

function enqueue(db, row, cb) {
    db.run(
        `INSERT INTO notification_queue (channel, destination, template_key, payload, scheduled_at, status) VALUES (?, ?, ?, ?, ?, 'pending')`,
        [
            row.channel,
            row.destination,
            row.template_key,
            JSON.stringify(row.payload || {}),
            row.scheduled_at || new Date().toISOString()
        ],
        cb
    );
}

function scheduleDailyReminders(db) {
    const cronExpr = process.env.DAILY_REMINDER_CRON || '0 8 * * *';
    cron.schedule(cronExpr, () => {
        const today = new Date().toISOString().slice(0, 10);
        db.all(
            `
            SELECT r.id AS registration_id, r.user_id, r.application_no, r.status,
                   u.email, u.phone, u.first_name, u.last_name,
                   s.id AS seminar_id, s.title AS seminar_title, s.event_date
            FROM registrations r
            JOIN users u ON r.user_id = u.id
            JOIN seminars s ON r.seminar_id = s.id
            WHERE r.status IN ('approved_pending_payment','completed','checked_in')
              AND s.event_date IS NOT NULL
              AND datetime(s.event_date) > datetime('now')
            `,
            [],
            (err, rows) => {
                if (err || !rows) return;
                rows.forEach((r) => {
                    db.get(
                        `SELECT 1 FROM registration_reminder_log WHERE registration_id = ? AND sent_date = ?`,
                        [r.registration_id, today],
                        (e2, hit) => {
                            if (e2 || hit) return;
                            notif.notify(
                                db,
                                'SEMINAR_REMINDER',
                                {
                                    userId: r.user_id,
                                    seminarId: r.seminar_id,
                                    registrationId: r.registration_id,
                                    vars: {
                                        approval_status: r.status,
                                        application_no: r.application_no
                                    }
                                },
                                () => {}
                            );
                            db.run(`INSERT OR IGNORE INTO registration_reminder_log (registration_id, sent_date) VALUES (?, ?)`, [
                                r.registration_id,
                                today
                            ]);
                        }
                    );
                });
            }
        );
    });
}

function startWorkers(db) {
    setInterval(() => processQueueOnce(db), 30000);
    scheduleDailyReminders(db);
    console.log('[jobs] Notification queue (email + WhatsApp) + daily reminders started.');
}

module.exports = { startWorkers, enqueue, processQueueOnce };
