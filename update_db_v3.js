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
    db.run(`ALTER TABLE tickets ADD COLUMN scanned_by INTEGER REFERENCES users(id)`, (err) => {
        if (err) console.log("scanned_by might already exist:", err.message);
        else console.log("Added scanned_by column to tickets table.");
    });
});

db.close((err) => {
    if (err) console.error(err.message);
    console.log('Database update v3 complete.');
});
