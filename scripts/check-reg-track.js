const sqlite3 = require('sqlite3');
const db = new sqlite3.Database(require('path').join(__dirname, '..', 'database.sqlite'));
const appNo = process.argv[2] || '412305579651';
db.get(
    'SELECT id, status, user_id, created_at FROM registrations WHERE application_no = ?',
    [appNo],
    (e, r) => {
        console.log('reg', r);
        if (!r) return db.close();
        db.all(
            'SELECT step_key, created_at FROM registration_status_log WHERE registration_id = ? ORDER BY id',
            [r.id],
            (e2, logs) => {
                console.log('logs', logs);
                db.get(
                    `SELECT o.id, o.status FROM orders o WHERE o.registration_id = ?`,
                    [r.id],
                    (e3, orders) => {
                        console.log('orders', orders);
                        db.all(
                            `SELECT t.id, t.is_scanned FROM tickets t JOIN orders o ON o.id = t.order_id WHERE o.registration_id = ?`,
                            [r.id],
                            (e4, tix) => {
                                console.log('tickets', tix);
                                db.close();
                            }
                        );
                    }
                );
            }
        );
    }
);
