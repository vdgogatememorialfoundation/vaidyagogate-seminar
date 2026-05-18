const sqlite3 = require('sqlite3');
const db = new sqlite3.Database(require('path').join(__dirname, '..', 'database.sqlite'));
db.all('SELECT id, name, is_active FROM payment_gateways', [], (e, rows) => {
    console.log('gateways', rows);
    db.get(
        "SELECT id, status, user_id FROM registrations WHERE status = 'approved_pending_payment' LIMIT 1",
        [],
        (e2, r) => {
            console.log('pending reg', r);
            db.close();
        }
    );
});
