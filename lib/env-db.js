/**
 * DATABASE_URL resolution and validation (Render / Supabase).
 */
const { envDashboardHint } = require('./hosting');

function normalizeDatabaseUrl(raw) {
    let s = String(raw == null ? '' : raw).trim();
    if (!s) return '';
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        s = s.slice(1, -1).trim();
    }
    if (!/^postgres(ql)?:\/\//i.test(s) && /^[a-zA-Z0-9_.-]+:[^@\s]+@[^/\s]+/.test(s)) {
        s = 'postgresql://' + s;
    }
    return s;
}

function resolveDatabaseUrl() {
    const raw = process.env.DATABASE_URL;
    if (raw == null) return null;
    const normalized = normalizeDatabaseUrl(raw);
    return normalized || null;
}

/** Direct host for DDL (migrations). Falls back to DATABASE_URL without -pooler if applicable. */
function resolveSchemaDatabaseUrl() {
    const direct = process.env.DATABASE_URL_DIRECT || process.env.POSTGRES_URL_NON_POOLING;
    if (direct) {
        const normalized = normalizeDatabaseUrl(direct);
        if (normalized) return normalized;
    }
    const pooled = resolveDatabaseUrl();
    if (!pooled) return null;
    if (/-pooler\./i.test(pooled)) {
        return pooled.replace(/-pooler\./i, '.');
    }
    return pooled;
}

function isPostgresConfigured() {
    return !!resolveDatabaseUrl();
}

function validateDatabaseUrl(url) {
    const resolved = url != null ? url : resolveDatabaseUrl();
    if (!resolved) {
        return {
            ok: false,
            code: 'DATABASE_URL_MISSING',
            message: 'DATABASE_URL is not set'
        };
    }
    if (!/^postgres(ql)?:\/\//i.test(resolved)) {
        return {
            ok: false,
            code: 'DATABASE_URL_INVALID',
            message: 'DATABASE_URL must be a postgres:// or postgresql:// connection string'
        };
    }
    if (/USER:PASSWORD|ep-xxx|your-/i.test(resolved)) {
        return {
            ok: false,
            code: 'DATABASE_URL_PLACEHOLDER',
            message: 'DATABASE_URL looks like a placeholder — paste your real Supabase connection string'
        };
    }
    return { ok: true, url: resolved };
}

function publicDatabaseHint(code) {
    switch (code) {
        case 'DATABASE_URL_MISSING':
            return envDashboardHint() + ' Add DATABASE_URL (Supabase connection URL), then redeploy.';
        case 'DATABASE_URL_INVALID':
        case 'DATABASE_URL_PLACEHOLDER':
            return 'In Supabase: copy the connection string. Paste as DATABASE_URL in Render env, then redeploy.';
        case 'DB_CONNECT_FAILED':
            return 'Check Supabase project is active, credentials are correct, and the URL is valid.';
        case 'BOOTSTRAP_TIMEOUT':
            return 'Database bootstrap timed out — retry shortly. Check Render logs for [bootstrap] and [pg-schema].';
        default:
            return 'Check Render service logs for database errors.';
    }
}

function sanitizeDbError(err) {
    const msg = String((err && err.message) || err || 'unknown');
    return msg.replace(/postgres(ql)?:\/\/[^@\s]+@/gi, 'postgresql://***@');
}

module.exports = {
    resolveDatabaseUrl,
    resolveSchemaDatabaseUrl,
    isPostgresConfigured,
    validateDatabaseUrl,
    publicDatabaseHint,
    sanitizeDbError
};
