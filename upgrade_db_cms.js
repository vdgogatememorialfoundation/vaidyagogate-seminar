const sqlite3 = require('sqlite3').verbose();
const dbFile = './database.sqlite';

const db = new sqlite3.Database(dbFile, (err) => {
    if (err) console.error(err.message);
});

db.serialize(() => {
    // 1. global_settings
    db.run(`CREATE TABLE IF NOT EXISTS global_settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )`);

    // Seed defaults
    const defaults = [
        ['site_logo', '🏥'],
        ['site_name', 'Vaidya Gogate Memorial Foundation'],
        ['domain', 'localhost:3000'],
        ['payment_gateway', 'mock'],
        ['is_site_disabled', '0']
    ];
    const stmt = db.prepare(`INSERT OR IGNORE INTO global_settings (key, value) VALUES (?, ?)`);
    defaults.forEach(d => stmt.run(d[0], d[1]));
    stmt.finalize();

    // 2. pages
    db.run(`CREATE TABLE IF NOT EXISTS pages (
        slug TEXT PRIMARY KEY,
        title TEXT,
        html_content TEXT
    )`);

    // 3. schedule
    db.run(`CREATE TABLE IF NOT EXISTS schedule (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date_str TEXT,
        time_str TEXT,
        session_title TEXT,
        speaker TEXT
    )`);

    // 4. users - is_disabled
    db.run(`ALTER TABLE users ADD COLUMN is_disabled INTEGER DEFAULT 0`, (err) => {
        if(err) console.log("is_disabled already exists");
        else console.log("Added is_disabled to users");
    });

    // 5. seminars - custom_fields_schema
    db.run(`ALTER TABLE seminars ADD COLUMN custom_fields_schema TEXT DEFAULT '{}'`, (err) => {
        if(err) console.log("custom_fields_schema already exists");
        else console.log("Added custom_fields_schema to seminars");
    });
});

db.close(() => {
    console.log("Database schema upgrade complete.");
});
