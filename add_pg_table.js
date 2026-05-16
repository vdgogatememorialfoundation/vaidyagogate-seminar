const sqlite3 = require('sqlite3').verbose();
const dbFile = './database.sqlite';

const db = new sqlite3.Database(dbFile, (err) => {
    if (err) console.error(err.message);
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS payment_gateways (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        is_active BOOLEAN DEFAULT 0,
        config TEXT
    )`, (err) => {
        if (err) console.error(err);
        else console.log("Payment gateways table created.");
        db.close();
    });
});