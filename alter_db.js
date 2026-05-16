const sqlite3 = require('sqlite3').verbose();
const dbFile = './database.sqlite';

const db = new sqlite3.Database(dbFile, (err) => {
    if (err) console.error(err.message);
});

db.serialize(() => {
    // Add form_data to registrations if it doesn't exist
    db.run(`ALTER TABLE registrations ADD COLUMN form_data TEXT`, (err) => {
        if(err) console.log("form_data column already exists or error: ", err.message);
        else console.log("Added form_data column to registrations.");
    });
});

db.close();
