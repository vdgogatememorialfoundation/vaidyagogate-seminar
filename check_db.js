const sqlite3 = require('sqlite3').verbose();
const dbFile = './database.sqlite';

const db = new sqlite3.Database(dbFile, (err) => {
    if (err) console.error(err.message);
});

db.serialize(() => {
    db.all(`SELECT application_no, form_data FROM registrations;`, (err, rows) => {
        if (err) console.error(err.message);
        console.log(JSON.stringify(rows, null, 2));
    });
});

db.close();
