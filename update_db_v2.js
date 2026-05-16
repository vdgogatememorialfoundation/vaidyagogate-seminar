const sqlite3 = require('sqlite3').verbose();
const dbFile = './database.sqlite';

const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        console.error(err.message);
        return;
    }
    console.log('Connected to the SQLite database.');
});

db.serialize(() => {
    // 1. Add fields to seminars
    db.run(`ALTER TABLE seminars ADD COLUMN location_url TEXT`, (err) => {
        if (err) console.log("location_url exists:", err.message);
    });
    db.run(`ALTER TABLE seminars ADD COLUMN terms_conditions TEXT`, (err) => {
        if (err) console.log("terms_conditions exists:", err.message);
    });
    db.run(`ALTER TABLE seminars ADD COLUMN is_countdown_active BOOLEAN DEFAULT 0`, (err) => {
        if (err) console.log("is_countdown_active exists:", err.message);
    });

    // 2. Create notices table
    db.run(`CREATE TABLE IF NOT EXISTS notices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        seminar_id INTEGER,
        message TEXT,
        pdf_path TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (seminar_id) REFERENCES seminars(id)
    )`, (err) => {
        if (err) console.error(err.message);
        else console.log("Checked notices table.");
    });
});

db.close((err) => {
    if (err) console.error(err.message);
    console.log('Database update v2 complete.');
});
