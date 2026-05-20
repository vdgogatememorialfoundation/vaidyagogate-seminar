/**
 * Minimal core table DDL for Neon — applied when full schema-postgres.sql bootstrap is incomplete.
 */
const CORE_TABLE_DDL = [
    {
        name: 'users',
        sql: `CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        user_id_string TEXT UNIQUE,
        first_name TEXT NOT NULL,
        middle_name TEXT,
        last_name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        phone TEXT NOT NULL,
        whatsapp TEXT,
        password TEXT NOT NULL,
        role TEXT DEFAULT 'doctor',
        qualification TEXT,
        practitioner_type TEXT,
        registration_cert_path TEXT,
        registration_cert_no TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        is_disabled INTEGER DEFAULT 0,
        user_role TEXT DEFAULT 'doctor',
        admin_modules TEXT,
        doctor_category TEXT DEFAULT 'regular',
        doctor_modules TEXT,
        is_demo INTEGER DEFAULT 0,
        last_login_at TIMESTAMPTZ
    )`
    },
    {
        name: 'seminars',
        sql: `CREATE TABLE IF NOT EXISTS seminars (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        registration_start TIMESTAMPTZ,
        registration_end TIMESTAMPTZ,
        event_date TIMESTAMPTZ,
        capacity INTEGER,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        custom_fields_schema TEXT DEFAULT '{}',
        price REAL DEFAULT 0,
        checkin_enabled BOOLEAN DEFAULT FALSE,
        checkin_date DATE,
        location_url TEXT,
        terms_conditions TEXT,
        is_countdown_active BOOLEAN DEFAULT FALSE,
        hero_image_path TEXT,
        flyer_path TEXT,
        gallery_paths TEXT,
        registration_form_json TEXT,
        cancellation_policy_json TEXT,
        whatsapp_group_url TEXT,
        otp_on_application INTEGER DEFAULT 0,
        portal_year INTEGER,
        public_list_enabled INTEGER DEFAULT 0,
        cert_scans_required INTEGER DEFAULT 1,
        certificate_verify_enabled INTEGER DEFAULT 0
    )`
    },
    {
        name: 'registrations',
        sql: `CREATE TABLE IF NOT EXISTS registrations (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        seminar_id INTEGER,
        application_no TEXT UNIQUE,
        status TEXT DEFAULT 'pending_approval',
        rejection_reason TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        form_data TEXT,
        doc_review_json TEXT,
        registration_source TEXT DEFAULT 'doctor',
        admin_editor_user_id INTEGER,
        FOREIGN KEY (seminar_id) REFERENCES seminars(id)
    )`
    },
    {
        name: 'orders',
        sql: `CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        order_id_string TEXT UNIQUE,
        registration_id INTEGER,
        amount REAL,
        status TEXT DEFAULT 'pending',
        payment_date TIMESTAMPTZ,
        payment_gateway TEXT,
        provider_order_id TEXT,
        provider_transaction_id TEXT,
        FOREIGN KEY (registration_id) REFERENCES registrations(id)
    )`
    },
    {
        name: 'tickets',
        sql: `CREATE TABLE IF NOT EXISTS tickets (
        id SERIAL PRIMARY KEY,
        order_id INTEGER,
        user_id INTEGER,
        qr_code_data TEXT UNIQUE,
        is_scanned BOOLEAN DEFAULT FALSE,
        scan_time TIMESTAMPTZ,
        scanned_by INTEGER,
        ticket_id_string TEXT,
        is_valid INTEGER DEFAULT 1,
        FOREIGN KEY (order_id) REFERENCES orders(id)
    )`
    }
];

module.exports = { CORE_TABLE_DDL };
