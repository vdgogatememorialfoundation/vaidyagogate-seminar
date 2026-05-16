const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) {
        console.error(err.message);
    }
    console.log('Connected to database for migrations.');
});

db.serialize(() => {
    // Event Schedules Table
    db.run(`CREATE TABLE IF NOT EXISTS event_schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        seminar_id INTEGER,
        start_time DATETIME NOT NULL,
        end_time DATETIME NOT NULL,
        location TEXT,
        speaker_name TEXT,
        speaker_bio TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (seminar_id) REFERENCES seminars(id)
    )`, (err) => {
        if (err) {
            console.error('Event Schedules table creation error:', err.message);
        } else {
            console.log('✓ Event Schedules table created/verified');
        }
    });

    // Seminar Feedback Table
    db.run(`CREATE TABLE IF NOT EXISTS seminar_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        seminar_id INTEGER,
        registration_id INTEGER,
        rating INTEGER DEFAULT 5,
        content_quality INTEGER DEFAULT 5,
        speaker_quality INTEGER DEFAULT 5,
        organization_quality INTEGER DEFAULT 5,
        overall_experience TEXT,
        suggestions TEXT,
        would_attend_again BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (seminar_id) REFERENCES seminars(id),
        FOREIGN KEY (registration_id) REFERENCES registrations(id)
    )`, (err) => {
        if (err) {
            console.error('Seminar Feedback table creation error:', err.message);
        } else {
            console.log('✓ Seminar Feedback table created/verified');
        }
    });

    // Doctor Support Tickets Table
    db.run(`CREATE TABLE IF NOT EXISTS support_tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id TEXT UNIQUE,
        user_id INTEGER,
        category TEXT, -- 'technical', 'billing', 'general', 'registration', 'other'
        subject TEXT NOT NULL,
        description TEXT NOT NULL,
        priority TEXT DEFAULT 'medium', -- 'low', 'medium', 'high', 'urgent'
        status TEXT DEFAULT 'open', -- 'open', 'in_progress', 'resolved', 'closed'
        attachment_path TEXT,
        assigned_to_admin INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        resolved_at DATETIME,
        admin_response TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (assigned_to_admin) REFERENCES users(id)
    )`, (err) => {
        if (err) {
            console.error('Support Tickets table creation error:', err.message);
        } else {
            console.log('✓ Support Tickets table created/verified');
        }
    });

    // Support Ticket Messages/Responses Table
    db.run(`CREATE TABLE IF NOT EXISTS ticket_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id TEXT NOT NULL,
        sender_id INTEGER NOT NULL,
        sender_type TEXT, -- 'user', 'admin'
        message TEXT NOT NULL,
        attachment_path TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (ticket_id) REFERENCES support_tickets(ticket_id),
        FOREIGN KEY (sender_id) REFERENCES users(id)
    )`, (err) => {
        if (err) {
            console.error('Ticket Messages table creation error:', err.message);
        } else {
            console.log('✓ Ticket Messages table created/verified');
        }
    });

    // Live Chat Support Table
    db.run(`CREATE TABLE IF NOT EXISTS live_chat_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT UNIQUE,
        user_id INTEGER,
        admin_id INTEGER,
        status TEXT DEFAULT 'active', -- 'active', 'closed', 'waiting'
        query TEXT,
        resolution TEXT,
        rating INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        ended_at DATETIME,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (admin_id) REFERENCES users(id)
    )`, (err) => {
        if (err) {
            console.error('Live Chat Sessions table creation error:', err.message);
        } else {
            console.log('✓ Live Chat Sessions table created/verified');
        }
    });

    // Live Chat Messages Table
    db.run(`CREATE TABLE IF NOT EXISTS live_chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        sender_id INTEGER NOT NULL,
        sender_type TEXT, -- 'user', 'admin', 'system'
        message TEXT NOT NULL,
        read_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES live_chat_sessions(session_id),
        FOREIGN KEY (sender_id) REFERENCES users(id)
    )`, (err) => {
        if (err) {
            console.error('Live Chat Messages table creation error:', err.message);
        } else {
            console.log('✓ Live Chat Messages table created/verified');
        }
    });
});

db.close((err) => {
    if (err) {
        console.error(err.message);
    }
    console.log('Database migrations completed.');
});
