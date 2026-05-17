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

    // Boolean IFNULL patterns before generic IFNULL → COALESCE (0 would become integer on PG booleans)
    s = s.replace(/\bIFNULL\s*\(\s*public_list_enabled\s*,\s*0\s*\)\s*=\s*1\b/gi, 'COALESCE(public_list_enabled, false) IS TRUE');
    s = s.replace(
        /\bIFNULL\s*\(\s*checkin_enabled\s*,\s*0\s*\)\s*=\s*1\b/gi,
        'COALESCE(checkin_enabled, false) IS TRUE'
    );

    s = s.replace(/\bIFNULL\s*\(\s*(\w+\.)?is_disabled\s*,\s*0\s*\)/gi, 'COALESCE($1is_disabled, 0)');
    s = s.replace(/\bIFNULL\s*\(\s*(\w+\.)?is_valid\s*,\s*1\s*\)/gi, 'COALESCE($1is_valid, 1)');
    s = s.replace(/\bIFNULL\s*\(\s*(\w+\.)?otp_on_application\s*,\s*0\s*\)/gi, 'COALESCE($1otp_on_application, 0)');

    s = s.replace(/IFNULL\s*\(/gi, 'COALESCE(');
    // Nested COALESCE inside strftime (portal year backfill / seminar lists)
    s = s.replace(
        /CAST\s*\(\s*strftime\s*\(\s*'%Y'\s*,\s*COALESCE\s*\(([^)]+)\)\s*\)\s*AS\s+INTEGER\s*\)/gi,
        'EXTRACT(YEAR FROM COALESCE($1))::INTEGER'
    );
    s = s.replace(/CAST\s*\(\s*strftime\s*\(\s*'%Y'\s*,\s*([^)]+)\)\s*AS\s+INTEGER\s*\)/gi, 'EXTRACT(YEAR FROM $1)::INTEGER');
    s = s.replace(/strftime\s*\(\s*'%Y'\s*,\s*([^)]+)\)/gi, 'EXTRACT(YEAR FROM $1)::INTEGER');
    const boolCols = [
        'is_active',
        'is_countdown_active',
        'public_list_enabled',
        'checkin_enabled',
        'is_disabled',
        'is_demo',
        'is_locked',
        'is_scanned',
        'is_valid'
    ];
    // SET is_scanned = 1 must become TRUE/FALSE, not (col IS TRUE OR ...) which is invalid in SET
    s = s.replace(/\bSET\b([\s\S]*?)(?=\bWHERE\b|;|$)/gi, (full, setPart) => {
        let part = setPart;
        for (const col of boolCols) {
            const re = new RegExp(`\\b(${col})\\s*=\\s*([01])\\b`, 'gi');
            part = part.replace(re, (_, name, bit) => (bit === '1' ? `${name} = TRUE` : `${name} = FALSE`));
        }
        return 'SET' + part;
    });
    // SQLite 0/1 vs PostgreSQL boolean in WHERE (preserve table alias: cp.is_active = 1)
    for (const col of boolCols) {
        const re = new RegExp(`(\\b\\w+\\.)?(${col})\\s*=\\s*([01])\\b`, 'gi');
        s = s.replace(re, (_, prefix, name, bit) => {
            const full = (prefix || '') + name;
            return bit === '1'
                ? `(${full} IS TRUE OR ${full}::int = 1)`
                : `(${full} IS FALSE OR ${full}::int = 0)`;
        });
    }
    s = s.replace(
        /\bCOALESCE\s*\(\s*checkin_enabled\s*,\s*0\s*\)\s*=\s*1\b/gi,
        'COALESCE(checkin_enabled, false) IS TRUE'
    );
    s = s.replace(/\bCOALESCE\s*\(\s*(\w+\.)?checkin_enabled\s*,\s*0\s*\)/gi, 'COALESCE($1checkin_enabled, false)');
    s = s.replace(/\bCOALESCE\s*\(\s*(\w+\.)?is_disabled\s*,\s*0\s*\)/gi, 'COALESCE($1is_disabled, 0)');
    s = s.replace(/\bCOALESCE\s*\(\s*(\w+\.)?is_disabled\s*,\s*false\s*\)/gi, 'COALESCE($1is_disabled, 0)');
    s = s.replace(/\bCOALESCE\s*\(\s*(\w+\.)?is_valid\s*,\s*1\s*\)/gi, 'COALESCE($1is_valid, 1)');
    s = s.replace(/\bCOALESCE\s*\(\s*(\w+\.)?is_valid\s*,\s*true\s*\)/gi, 'COALESCE($1is_valid, 1)');
    s = s.replace(/\bCOALESCE\s*\(\s*(\w+\.)?public_list_enabled\s*,\s*0\s*\)/gi, 'COALESCE($1public_list_enabled, 0)');
    s = s.replace(/\bCOALESCE\s*\(\s*(\w+\.)?public_list_enabled\s*,\s*false\s*\)/gi, 'COALESCE($1public_list_enabled, 0)');
    s = s.replace(/\bCOALESCE\s*\(\s*(\w+\.)?otp_on_application\s*,\s*0\s*\)/gi, 'COALESCE($1otp_on_application, 0)');
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
        } else if (/user_certificates/i.test(s) && /user_id/i.test(s) && /seminar_id/i.test(s)) {
            s = s
                .trim()
                .replace(/;\s*$/, '')
                .replace(
                    /ON CONFLICT\s*\(\s*user_id\s*,\s*seminar_id\s*\)/gi,
                    'ON CONFLICT (user_id, seminar_id)'
                );
            if (!/ON CONFLICT/i.test(s)) {
                s += ' ON CONFLICT (user_id, seminar_id) DO NOTHING';
            }
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

/** Tables whose primary key is not `id` — must not use RETURNING id on Neon. */
const INSERT_TABLES_WITHOUT_ID = /\bINTO\s+(global_settings|pages|registration_reminder_log)\b/i;

function insertReturnsId(sql) {
    if (!isInsert(sql)) return false;
    if (/RETURNING\s+/i.test(sql)) return false;
    if (INSERT_TABLES_WITHOUT_ID.test(sql)) return false;
    return true;
}

function appendReturningId(sql) {
    const s = String(sql).trim().replace(/;\s*$/, '');
    if (!insertReturnsId(s)) return s;
    return s + ' RETURNING id';
}

module.exports = {
    convertSqliteToPostgres,
    toPositionalParams,
    isInsert,
    insertReturnsId,
    appendReturningId
};
