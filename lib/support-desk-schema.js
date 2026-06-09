/**
 * Support desk: departments, agent schedules, ticket assignment columns.
 */
function isPg() {
    return !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
}

function ignoreSchemaErr(e) {
    if (e && !/duplicate column|already exists/i.test(String(e.message))) {
        console.warn('[support-desk-schema]', e.message);
    }
}

function ensureSupportDeskSchema(db, cb) {
    const pg = isPg();
    const ts = pg ? 'TIMESTAMPTZ' : 'DATETIME';

    const steps = [
        pg
            ? `CREATE TABLE IF NOT EXISTS support_departments (
                id SERIAL PRIMARY KEY,
                slug TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                sort_order INTEGER DEFAULT 0,
                is_active INTEGER DEFAULT 1,
                created_at ${ts} DEFAULT CURRENT_TIMESTAMP
            )`
            : `CREATE TABLE IF NOT EXISTS support_departments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                slug TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                sort_order INTEGER DEFAULT 0,
                is_active INTEGER DEFAULT 1,
                created_at ${ts} DEFAULT CURRENT_TIMESTAMP
            )`,
        pg
            ? `CREATE TABLE IF NOT EXISTS support_agent_profiles (
                user_id INTEGER PRIMARY KEY,
                department_id INTEGER,
                is_available INTEGER DEFAULT 1,
                max_open_tickets INTEGER DEFAULT 15,
                live_chat_enabled INTEGER DEFAULT 1,
                notes TEXT,
                updated_at ${ts}
            )`
            : `CREATE TABLE IF NOT EXISTS support_agent_profiles (
                user_id INTEGER PRIMARY KEY,
                department_id INTEGER,
                is_available INTEGER DEFAULT 1,
                max_open_tickets INTEGER DEFAULT 15,
                live_chat_enabled INTEGER DEFAULT 1,
                notes TEXT,
                updated_at ${ts}
            )`,
        pg
            ? `CREATE TABLE IF NOT EXISTS support_agent_hours (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                day_of_week INTEGER NOT NULL,
                start_minutes INTEGER NOT NULL,
                end_minutes INTEGER NOT NULL
            )`
            : `CREATE TABLE IF NOT EXISTS support_agent_hours (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                day_of_week INTEGER NOT NULL,
                start_minutes INTEGER NOT NULL,
                end_minutes INTEGER NOT NULL
            )`,
        pg
            ? `CREATE TABLE IF NOT EXISTS support_agent_holidays (
                id SERIAL PRIMARY KEY,
                user_id INTEGER,
                holiday_date TEXT NOT NULL,
                label TEXT,
                created_at ${ts} DEFAULT CURRENT_TIMESTAMP
            )`
            : `CREATE TABLE IF NOT EXISTS support_agent_holidays (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                holiday_date TEXT NOT NULL,
                label TEXT,
                created_at ${ts} DEFAULT CURRENT_TIMESTAMP
            )`,
        pg
            ? `CREATE TABLE IF NOT EXISTS support_live_sessions (
                id SERIAL PRIMARY KEY,
                visitor_key TEXT,
                user_id INTEGER,
                assigned_agent_id INTEGER,
                status TEXT DEFAULT 'waiting',
                channel TEXT DEFAULT 'web',
                started_at ${ts} DEFAULT CURRENT_TIMESTAMP,
                ended_at ${ts},
                last_message_at ${ts}
            )`
            : `CREATE TABLE IF NOT EXISTS support_live_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                visitor_key TEXT,
                user_id INTEGER,
                assigned_agent_id INTEGER,
                status TEXT DEFAULT 'waiting',
                channel TEXT DEFAULT 'web',
                started_at ${ts} DEFAULT CURRENT_TIMESTAMP,
                ended_at ${ts},
                last_message_at ${ts}
            )`
    ];

    const ticketAlters = [
        ['assigned_to_staff', 'INTEGER'],
        ['department_id', 'INTEGER'],
        ['assignment_mode', "TEXT DEFAULT 'manual'"]
    ];
    const msgAlters = [['visible_at', ts]];

    let i = 0;
    const runStep = () => {
        if (i >= steps.length) return runTicketAlters(0);
        db.run(steps[i], (e) => {
            ignoreSchemaErr(e);
            i++;
            runStep();
        });
    };

    const runTicketAlters = (j) => {
        if (j >= ticketAlters.length) return runMsgAlters(0);
        const [name, type] = ticketAlters[j];
        const sql = pg
            ? `ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ${name} ${type}`
            : `ALTER TABLE support_tickets ADD COLUMN ${name} ${type}`;
        db.run(sql, (e) => {
            ignoreSchemaErr(e);
            runTicketAlters(j + 1);
        });
    };

    const runMsgAlters = (k) => {
        if (k >= msgAlters.length) return seedDepartments();
        const [name, type] = msgAlters[k];
        const sql = pg
            ? `ALTER TABLE ticket_messages ADD COLUMN IF NOT EXISTS ${name} ${type}`
            : `ALTER TABLE ticket_messages ADD COLUMN ${name} ${type}`;
        db.run(sql, (e) => {
            ignoreSchemaErr(e);
            runMsgAlters(k + 1);
        });
    };

    const seedDepartments = () => {
        const defaults = [
            ['general', 'General support', 0],
            ['registration', 'Registration & applications', 1],
            ['payment', 'Payments & receipts', 2],
            ['technical', 'Technical issues', 3],
            ['case', 'Case presentation', 4]
        ];
        let d = 0;
        const nextDept = () => {
            if (d >= defaults.length) return cb && cb();
            const [slug, name, sort] = defaults[d];
            db.run(
                `INSERT INTO support_departments (slug, name, sort_order, is_active)
                 SELECT ?, ?, ?, 1 WHERE NOT EXISTS (SELECT 1 FROM support_departments WHERE slug = ?)`,
                [slug, name, sort, slug],
                () => {
                    d++;
                    nextDept();
                }
            );
        };
        nextDept();
    };

    runStep();
}

module.exports = { ensureSupportDeskSchema };
