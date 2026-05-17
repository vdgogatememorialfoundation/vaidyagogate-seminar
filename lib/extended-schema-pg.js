/**
 * Auxiliary tables required beyond core seminar flow — idempotent on Neon.
 */
const AUX_TABLE_DDL = [
    {
        name: 'global_settings',
        sql: `CREATE TABLE IF NOT EXISTS global_settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )`
    },
    {
        name: 'payment_gateways',
        sql: `CREATE TABLE IF NOT EXISTS payment_gateways (
            id SERIAL PRIMARY KEY,
            name TEXT UNIQUE,
            is_active BOOLEAN DEFAULT FALSE,
            config TEXT
        )`
    },
    {
        name: 'case_programs',
        sql: `CREATE TABLE IF NOT EXISTS case_programs (
            id SERIAL PRIMARY KEY,
            title TEXT NOT NULL,
            description TEXT,
            seminar_id INTEGER,
            registration_start TIMESTAMPTZ,
            registration_end TIMESTAMPTZ,
            is_active INTEGER DEFAULT 1,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            form_config_json TEXT,
            max_presentations_per_user INTEGER DEFAULT 2,
            max_total_submissions INTEGER,
            max_files_per_submission INTEGER DEFAULT 5,
            max_file_size_mb INTEGER DEFAULT 50,
            enabled_categories TEXT,
            instructions TEXT,
            portal_year INTEGER,
            judge_criteria_json TEXT
        )`
    },
    {
        name: 'case_submissions',
        sql: `CREATE TABLE IF NOT EXISTS case_submissions (
            id SERIAL PRIMARY KEY,
            case_program_id INTEGER,
            user_id INTEGER,
            seminar_id INTEGER,
            title TEXT,
            category TEXT,
            status TEXT DEFAULT 'submitted',
            application_no TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            plagiarism_zero INTEGER DEFAULT 0
        )`
    },
    {
        name: 'case_judge_assignments',
        sql: `CREATE TABLE IF NOT EXISTS case_judge_assignments (
            id SERIAL PRIMARY KEY,
            submission_id INTEGER NOT NULL,
            judge_user_id INTEGER NOT NULL,
            assigned_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(submission_id, judge_user_id)
        )`
    },
    {
        name: 'case_judge_scores',
        sql: `CREATE TABLE IF NOT EXISTS case_judge_scores (
            id SERIAL PRIMARY KEY,
            submission_id INTEGER NOT NULL,
            judge_user_id INTEGER NOT NULL,
            criteria_json TEXT,
            total_score REAL,
            remarks TEXT,
            submitted_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            is_locked INTEGER DEFAULT 0,
            UNIQUE(submission_id, judge_user_id)
        )`
    },
    {
        name: 'case_status_log',
        sql: `CREATE TABLE IF NOT EXISTS case_status_log (
            id SERIAL PRIMARY KEY,
            submission_id INTEGER NOT NULL,
            step_key TEXT NOT NULL,
            label TEXT,
            message TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'registration_status_log',
        sql: `CREATE TABLE IF NOT EXISTS registration_status_log (
            id SERIAL PRIMARY KEY,
            registration_id INTEGER NOT NULL,
            step_key TEXT NOT NULL,
            label TEXT,
            message TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'doctor_profile',
        sql: `CREATE TABLE IF NOT EXISTS doctor_profile (
            id SERIAL PRIMARY KEY,
            user_id INTEGER UNIQUE,
            specialization TEXT,
            registration_no TEXT,
            qualifications TEXT,
            experience_years INTEGER,
            hospital_name TEXT,
            contact_number TEXT,
            bio TEXT,
            profile_photo_path TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'abstracts',
        sql: `CREATE TABLE IF NOT EXISTS abstracts (
            id SERIAL PRIMARY KEY,
            user_id INTEGER,
            topic TEXT NOT NULL,
            video_path TEXT,
            ppt_path TEXT,
            status TEXT DEFAULT 'Under Review',
            rejection_reason TEXT,
            marks INTEGER DEFAULT 0,
            judge_remarks TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'support_tickets',
        sql: `CREATE TABLE IF NOT EXISTS support_tickets (
            id SERIAL PRIMARY KEY,
            tracking_id TEXT UNIQUE NOT NULL,
            user_id INTEGER NOT NULL,
            subject TEXT NOT NULL,
            status TEXT DEFAULT 'Open',
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'certificate_templates',
        sql: `CREATE TABLE IF NOT EXISTS certificate_templates (
            id SERIAL PRIMARY KEY,
            seminar_id INTEGER,
            file_path TEXT NOT NULL,
            original_name TEXT,
            mime_type TEXT,
            uploaded_by INTEGER,
            is_active INTEGER DEFAULT 1,
            cert_type TEXT DEFAULT 'participant',
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
    },
    {
        name: 'user_certificates',
        sql: `CREATE TABLE IF NOT EXISTS user_certificates (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            seminar_id INTEGER NOT NULL,
            ticket_id INTEGER,
            registration_id INTEGER,
            display_name TEXT NOT NULL,
            template_id INTEGER,
            enabled INTEGER DEFAULT 0,
            scan_verified INTEGER DEFAULT 0,
            scan_time TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, seminar_id)
        )`
    }
];

const PAYMENT_GATEWAY_SEED = [
    ['razorpay', 0, '{}'],
    ['payu', 0, '{}'],
    ['cashfree', 0, '{}']
];

/** Idempotent column adds for case_programs created before newer fields existed. */
const CASE_PROGRAMS_COLUMN_ALTERS = [
    'ALTER TABLE case_programs ADD COLUMN IF NOT EXISTS form_config_json TEXT',
    'ALTER TABLE case_programs ADD COLUMN IF NOT EXISTS max_presentations_per_user INTEGER DEFAULT 2',
    'ALTER TABLE case_programs ADD COLUMN IF NOT EXISTS max_total_submissions INTEGER',
    'ALTER TABLE case_programs ADD COLUMN IF NOT EXISTS max_files_per_submission INTEGER DEFAULT 5',
    'ALTER TABLE case_programs ADD COLUMN IF NOT EXISTS max_file_size_mb INTEGER DEFAULT 50',
    'ALTER TABLE case_programs ADD COLUMN IF NOT EXISTS enabled_categories TEXT',
    'ALTER TABLE case_programs ADD COLUMN IF NOT EXISTS instructions TEXT',
    'ALTER TABLE case_programs ADD COLUMN IF NOT EXISTS portal_year INTEGER',
    'ALTER TABLE case_programs ADD COLUMN IF NOT EXISTS judge_criteria_json TEXT'
];

async function ensureCaseProgramsColumns(queryWithRetry, isIgnorablePgError) {
    for (const sql of CASE_PROGRAMS_COLUMN_ALTERS) {
        try {
            await queryWithRetry(sql, [], 2);
        } catch (e) {
            if (!isIgnorablePgError(e)) {
                console.warn('[pg-schema] case_programs column:', e.message);
            }
        }
    }
}

async function listMissingAuxTables(queryWithRetry) {
    const names = AUX_TABLE_DDL.map((t) => t.name);
    try {
        const r = await queryWithRetry(
            `SELECT required.name AS table_name
             FROM unnest($1::text[]) AS required(name)
             LEFT JOIN information_schema.tables t
               ON t.table_schema = 'public' AND t.table_name = required.name
             WHERE t.table_name IS NULL`,
            [names],
            2
        );
        return (r.rows || []).map((row) => row.table_name);
    } catch {
        return names;
    }
}

async function ensureAuxiliaryTables(queryWithRetry, isIgnorablePgError) {
    const missingBefore = await listMissingAuxTables(queryWithRetry);
    if (missingBefore.length) {
        console.log('[pg-schema] ensuring auxiliary tables:', missingBefore.join(', '));
    }
    for (const def of AUX_TABLE_DDL) {
        try {
            await queryWithRetry(def.sql, [], 2);
        } catch (e) {
            if (!isIgnorablePgError(e)) {
                console.error('[pg-schema] auxiliary table failed:', def.name, e.message);
            }
        }
    }
    try {
        for (const row of PAYMENT_GATEWAY_SEED) {
            await queryWithRetry(
                `INSERT INTO payment_gateways (name, is_active, config) VALUES ($1, $2, $3)
                 ON CONFLICT (name) DO NOTHING`,
                row,
                1
            );
        }
    } catch (e) {
        if (!isIgnorablePgError(e)) {
            console.warn('[pg-schema] payment_gateways seed:', e.message);
        }
    }
    await ensureCaseProgramsColumns(queryWithRetry, isIgnorablePgError);
    return listMissingAuxTables(queryWithRetry);
}

module.exports = {
    AUX_TABLE_DDL,
    CASE_PROGRAMS_COLUMN_ALTERS,
    ensureAuxiliaryTables,
    ensureCaseProgramsColumns,
    listMissingAuxTables
};
