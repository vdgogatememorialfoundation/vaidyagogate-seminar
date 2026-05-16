const sqlite3 = require('sqlite3').verbose();
const dbFile = './database.sqlite';

const db = new sqlite3.Database(dbFile, (err) => {
    if (err) console.error(err.message);
});

db.all("SELECT sql FROM sqlite_master WHERE type='table'", (err, rows) => {
    if (err) console.error(err.message);
    rows.forEach(r => console.log(r.sql));
});
db.close();
