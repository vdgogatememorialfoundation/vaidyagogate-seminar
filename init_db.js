const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

const dbFile = './database.sqlite';

// Remove existing DB for a fresh start during development
if (fs.existsSync(dbFile)) {
    fs.unlinkSync(dbFile);
}

const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        console.error(err.message);
    }
    console.log('Connected to the SQLite database.');
});

db.serialize(() => {
    // 1. Users Table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id_string TEXT UNIQUE,
        first_name TEXT NOT NULL,
        middle_name TEXT,
        last_name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        phone TEXT NOT NULL,
        whatsapp TEXT,
        password TEXT NOT NULL,
        role TEXT DEFAULT 'doctor', -- doctor, admin, judge, scanner
        qualification TEXT,
        practitioner_type TEXT, -- Practitioner, Vaidya, PG, UG
        registration_cert_path TEXT,
        registration_cert_no TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 2. Seminars Table
    db.run(`CREATE TABLE IF NOT EXISTS seminars (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        registration_start DATETIME,
        registration_end DATETIME,
        event_date DATETIME,
        capacity INTEGER,
        is_active BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 3. Abstracts (Case Presentations) Table
    db.run(`CREATE TABLE IF NOT EXISTS abstracts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        topic TEXT NOT NULL,
        video_path TEXT,
        ppt_path TEXT,
        status TEXT DEFAULT 'Under Review', -- Under Review, Accepted, Rejected
        rejection_reason TEXT,
        marks INTEGER DEFAULT 0,
        judge_remarks TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    // 4. Registrations Table
    db.run(`CREATE TABLE IF NOT EXISTS registrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        seminar_id INTEGER,
        application_no TEXT UNIQUE,
        status TEXT DEFAULT 'pending_approval', -- pending_approval, approved_pending_payment, completed, rejected
        rejection_reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (seminar_id) REFERENCES seminars(id)
    )`);

    // 5. Orders & Payments Table
    db.run(`CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id_string TEXT UNIQUE,
        registration_id INTEGER,
        amount REAL,
        status TEXT DEFAULT 'pending', -- pending, success, failed
        payment_date DATETIME,
        payment_gateway TEXT,
        provider_order_id TEXT,
        provider_transaction_id TEXT,
        FOREIGN KEY (registration_id) REFERENCES registrations(id)
    )`);

    // 7. Payment Gateways Table
    db.run(`CREATE TABLE IF NOT EXISTS payment_gateways (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE, -- 'razorpay', 'payu', 'easebuzz', 'paytm', 'phonepe', 'cashfree'
        is_active BOOLEAN DEFAULT 0,
        config TEXT -- JSON string with keys like api_key, secret_key, etc.
    )`);

    console.log("Tables created successfully.");

    // Insert Default Admin
    db.run(`INSERT INTO users (user_id_string, first_name, last_name, email, phone, password, role) 
            VALUES ('ADMIN_001', 'Super', 'Admin', 'admin@vaidyagogate.org', '0000000000', 'Admin@2026', 'admin')`);
            
    // Insert Mock Seminar
    db.run(`INSERT INTO seminars (title, description, registration_start, registration_end, event_date, capacity) 
            VALUES ('Vaidya Gogate Memorial Foundation National Seminar 2025', 'Annual Medical Conference', datetime('now', '-1 day'), datetime('now', '+30 days'), datetime('now', '+60 days'), 500)`);
            
    db.run(`INSERT INTO seminars (title, description, registration_start, registration_end, event_date, capacity) 
            VALUES ('Upcoming Interactive Session', 'Specialized session opening soon', datetime('now', '+2 days'), datetime('now', '+10 days'), datetime('now', '+15 days'), 100)`);

    console.log("Mock data inserted.");
});

db.close((err) => {
    if (err) {
        console.error(err.message);
    }
    console.log('Close the database connection.');
});
