/**
 * One-off: lookup ticket for scanner debugging.
 * Usage: node scripts/query-ticket-scan.js 720240995786
 */
const id = process.argv[2] || '720240995786';
const path = require('path');

async function main() {
    const { resolveDatabaseUrl } = require('../lib/env-db');
    const url = resolveDatabaseUrl();
    let db;
    if (url) {
        process.env.DATABASE_URL = url;
        db = require('../lib/db-pg').createPgDb();
        await new Promise((r, j) => db.connect((e) => (e ? j(e) : r())));
        console.log('[db] PostgreSQL');
    } else {
        const sqlite3 = require('sqlite3').verbose();
        const dbFile = process.env.SQLITE_PATH || path.join(__dirname, '..', 'database.sqlite');
        db = new sqlite3.Database(dbFile);
        console.log('[db] SQLite', dbFile);
    }

    const prom = (sql, params) =>
        new Promise((resolve, reject) => {
            db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
        });
    const promAll = (sql, params) =>
        new Promise((resolve, reject) => {
            db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
        });

    const patterns = [
        ['ticket_id_string exact', `SELECT t.id, t.ticket_id_string, t.qr_code_data FROM tickets t WHERE t.ticket_id_string = ?`, [id]],
        [
            'qr_code_data LIKE',
            `SELECT t.id, t.ticket_id_string, substr(t.qr_code_data,1,200) AS qr_snip FROM tickets t WHERE t.qr_code_data LIKE ?`,
            [`%${id}%`]
        ],
        ['tickets.id numeric', `SELECT t.id, t.ticket_id_string FROM tickets t WHERE t.id = ?`, [parseInt(id, 10)]]
    ];

    for (const [label, sql, params] of patterns) {
        try {
            const rows = await promAll(sql, params);
            console.log('\n===', label, '===', rows.length ? '' : '(none)');
            console.log(JSON.stringify(rows, null, 2));
        } catch (e) {
            console.error(label, e.message);
        }
    }

    const full = await prom(
        `SELECT t.id, t.ticket_id_string, t.is_scanned, t.is_valid, t.qr_code_data,
                o.order_id_string, o.status AS payment_status,
                r.application_no, r.status AS registration_status, s.title AS seminar_title
         FROM tickets t
         JOIN orders o ON t.order_id = o.id
         JOIN registrations r ON o.registration_id = r.id
         JOIN seminars s ON r.seminar_id = s.id
         WHERE t.ticket_id_string = ? OR t.qr_code_data LIKE ?`,
        [id, `%"ticketId":"${id}"%`]
    );
    console.log('\n=== full join ===');
    console.log(JSON.stringify(full, null, 2));

    const sem = await promAll(
        `SELECT id, title, checkin_enabled, checkin_date, event_date FROM seminars WHERE title LIKE '%2028%' OR id IN (
            SELECT r.seminar_id FROM tickets t JOIN orders o ON o.id=t.order_id JOIN registrations r ON r.id=o.registration_id WHERE t.ticket_id_string=?
        )`,
        [id]
    );
    console.log('\n=== seminars for ticket ===');
    console.log(JSON.stringify(sem, null, 2));

    const scanners = await promAll(
        `SELECT id, user_role, role, first_name FROM users WHERE lower(user_role) LIKE '%scanner%' OR lower(role)='admin' LIMIT 5`,
        []
    );
    console.log('\n=== scanner users ===');
    console.log(JSON.stringify(scanners, null, 2));

    db.close && db.close(() => process.exit(0));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
