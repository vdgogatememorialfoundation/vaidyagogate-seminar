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
    db.run(`ALTER TABLE seminars ADD COLUMN price REAL DEFAULT 0`, (err) => {
        if (err) console.log("Column price may already exist or error:", err.message);
        else console.log("Added price column.");
    });
    db.run(`ALTER TABLE seminars ADD COLUMN checkin_enabled BOOLEAN DEFAULT 0`, (err) => {
        if (err) console.log("Column checkin_enabled may already exist or error:", err.message);
        else console.log("Added checkin_enabled column.");
    });
    db.run(`ALTER TABLE seminars ADD COLUMN checkin_date DATE`, (err) => {
        if (err) console.log("Column checkin_date may already exist or error:", err.message);
        else console.log("Added checkin_date column.");
    });
    
    // Also add support tickets table if it doesn't exist (since we noticed it in server.js but it wasn't in init_db.js)
    db.run(`CREATE TABLE IF NOT EXISTS support_tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tracking_id TEXT UNIQUE,
        user_id INTEGER, -- Can be NULL for guest tickets
        subject TEXT,
        status TEXT DEFAULT 'Open',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if(err) console.error(err.message);
        else console.log("Checked support_tickets table.");
    });

    db.run(`CREATE TABLE IF NOT EXISTS support_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER,
        sender TEXT,
        message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (ticket_id) REFERENCES support_tickets(id)
    )`, (err) => {
        if(err) console.error(err.message);
        else console.log("Checked support_messages table.");
    });
});

db.close((err) => {
    if (err) console.error(err.message);
    console.log('Closed database connection.');
});
