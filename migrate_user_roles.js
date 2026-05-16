const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./database.sqlite');

// Add user_role column to users table if it doesn't exist
db.run(`ALTER TABLE users ADD COLUMN user_role TEXT DEFAULT 'doctor'`, (err) => {
    if (err && err.message.includes('duplicate column')) {
        console.log('✓ user_role column already exists');
    } else if (err) {
        console.error('Error adding user_role:', err.message);
    } else {
        console.log('✓ Added user_role column to users table');
    }
});

// Add phone column to users if it doesn't exist (for SMS/WhatsApp)
db.run(`ALTER TABLE users ADD COLUMN phone TEXT`, (err) => {
    if (err && err.message.includes('duplicate column')) {
        console.log('✓ phone column already exists');
    } else if (err) {
        console.error('Error adding phone:', err.message);
    } else {
        console.log('✓ Added phone column to users table');
    }
});

// Create doctor_profile table
db.run(`CREATE TABLE IF NOT EXISTS doctor_profile (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE,
    specialization TEXT,
    registration_no TEXT,
    qualifications TEXT,
    experience_years INTEGER,
    hospital_name TEXT,
    contact_number TEXT,
    bio TEXT,
    profile_photo_path TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
)`, (err) => {
    if (err && err.message.includes('already exists')) {
        console.log('✓ doctor_profile table already exists');
    } else if (err) {
        console.error('Error creating doctor_profile table:', err.message);
    } else {
        console.log('✓ Created doctor_profile table');
    }
});

// Create application_edits table to track edits
db.run(`CREATE TABLE IF NOT EXISTS application_edits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER,
    edited_by_user_id INTEGER,
    changes TEXT,
    edited_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (application_id) REFERENCES registrations(id),
    FOREIGN KEY (edited_by_user_id) REFERENCES users(id)
)`, (err) => {
    if (err && err.message.includes('already exists')) {
        console.log('✓ application_edits table already exists');
    } else if (err) {
        console.error('Error creating application_edits table:', err.message);
    } else {
        console.log('✓ Created application_edits table');
    }
});

// Create user_roles reference table
db.run(`CREATE TABLE IF NOT EXISTS user_roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role_name TEXT UNIQUE,
    description TEXT,
    permissions TEXT
)`, (err) => {
    if (err && err.message.includes('already exists')) {
        console.log('✓ user_roles table already exists');
    } else if (err) {
        console.error('Error creating user_roles table:', err.message);
    } else {
        console.log('✓ Created user_roles table');
        
        // Insert default roles
        db.run(`INSERT OR IGNORE INTO user_roles (role_name, description, permissions) VALUES
            ('doctor', 'Regular Doctor/Medical Professional', 'register,apply_seminar,edit_own_application'),
            ('judge_user', 'Judge/Evaluator', 'view_applications,review_submissions'),
            ('co_admin', 'Co Administrator', 'manage_users,manage_seminars,view_reports'),
            ('scanner_portal_user', 'Event Scanner', 'scan_qrcodes,mark_attendance'),
            ('reviewer', 'Application Reviewer', 'view_applications,review_papers,add_comments')
        `, (err) => {
            if (err) console.error('Error inserting roles:', err.message);
            else console.log('✓ Inserted default user roles');
        });
    }
});

setTimeout(() => {
    console.log('\n✅ Database schema migration completed!');
    db.close();
}, 1000);
