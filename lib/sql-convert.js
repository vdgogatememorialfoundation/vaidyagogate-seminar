/**
 * SQLite → PostgreSQL query conversion for runtime SQL.
 */
function convertSqliteToPostgres(sql) {
    let s = String(sql || '');
    // Runtime DDL from SQLite migrations (bootstrap on Neon)
    s = s.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY');
    s = s.replace(/\bAUTOINCREMENT\b/gi, '');
    s = s.replace(/\bDATETIME\b/gi, 'TIMESTAMPTZ');
    const hadOrIgnore = /INSERT\s+OR\s+IGNORE\s+INTO/i.test(s);
    const hadOrReplace = /INSERT\s+OR\s+REPLACE\s+INTO/i.test(s);

    s = s.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT INTO');
    s = s.replace(/INSERT\s+OR\s+REPLACE\s+INTO/gi, 'INSERT INTO');

    s = s.replace(/IFNULL\s*\(/gi, 'COALESCE(');
    s = s.replace(/CAST\s*\(\s*strftime\s*\(\s*'%Y'\s*,\s*([^)]+)\)\s*AS\s+INTEGER\s*\)/gi, 'EXTRACT(YEAR FROM $1)::INTEGER');
    s = s.replace(/strftime\s*\(\s*'%Y'\s*,\s*([^)]+)\)/gi, 'EXTRACT(YEAR FROM $1)::INTEGER');
    s = s.replace(/datetime\s*\(\s*'now'\s*\)/gi, 'NOW()');
    s = s.replace(/datetime\s*\(\s*'now'\s*,\s*'([^']+)'\s*\)/gi, (_, mod) => {
        const m = mod.trim();
        if (m.startsWith('+')) return `NOW() + INTERVAL '${m.slice(1)}'`;
        if (m.startsWith('-')) return `NOW() - INTERVAL '${m.slice(1)}'`;
        return 'NOW()';
    });
    s = s.replace(/datetime\s*\(\s*([^)]+)\s*\)/gi, '($1)::timestamptz');

    if (hadOrIgnore && !/ON\s+CONFLICT/i.test(s)) {
        if (/notification_templates/i.test(s)) {
            s = s.trim().replace(/;\s*$/, '') + ' ON CONFLICT (event_key, seminar_id) DO NOTHING';
        } else if (/registration_reminder_log/i.test(s)) {
            s = s.trim().replace(/;\s*$/, '') + ' ON CONFLICT (registration_id, sent_date) DO NOTHING';
        } else if (/orders/i.test(s) && /order_id_string/i.test(s)) {
            s = s.trim().replace(/;\s*$/, '') + ' ON CONFLICT (order_id_string) DO NOTHING';
        } else if (/case_judge_assignments/i.test(s)) {
            s = s.trim().replace(/;\s*$/, '') + ' ON CONFLICT (submission_id, judge_user_id) DO NOTHING';
        } else if (/user_roles/i.test(s)) {
            s = s.trim().replace(/;\s*$/, '') + ' ON CONFLICT (role_name) DO NOTHING';
        } else if (/global_settings/i.test(s)) {
            s = s.trim().replace(/;\s*$/, '') + ' ON CONFLICT (key) DO NOTHING';
        }
    }

    if (hadOrReplace && /payment_gateways/i.test(s) && !/ON\s+CONFLICT/i.test(s)) {
        s = s.trim().replace(/;\s*$/, '') + ' ON CONFLICT (name) DO UPDATE SET is_active = EXCLUDED.is_active, config = EXCLUDED.config';
    }

    return s;
}

function toPositionalParams(sql, params) {
    const p = Array.isArray(params) ? params : params != null ? [params] : [];
    let i = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++i}`);
    return { sql: pgSql, params: p };
}

function isInsert(sql) {
    return /^\s*INSERT\s+INTO/i.test(String(sql || ''));
}

function appendReturningId(sql) {
    const s = String(sql).trim().replace(/;\s*$/, '');
    if (/RETURNING\s+/i.test(s)) return s;
    return s + ' RETURNING id';
}

module.exports = { convertSqliteToPostgres, toPositionalParams, isInsert, appendReturningId };
