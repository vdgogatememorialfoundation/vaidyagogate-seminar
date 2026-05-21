/**
 * DATABASE_URL resolution and validation (Vercel / Neon).
 */
function normalizeDatabaseUrl(raw) {
    let s = String(raw == null ? '' : raw).trim();
    if (!s) return '';
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        s = s.slice(1, -1).trim();
    }
    // Neon copy sometimes omits the scheme
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

/** Direct Neon host for DDL (migrations). Falls back to DATABASE_URL without -pooler. */
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
            message: 'DATABASE_URL looks like a placeholder — paste your real Neon connection string'
        };
    }
    return { ok: true, url: resolved };
}

function publicDatabaseHint(code) {
    switch (code) {
        case 'DATABASE_URL_MISSING':
            return 'Vercel → Project → Settings → Environment Variables → add DATABASE_URL (Neon pooler URL with ?sslmode=require) for Production, then Redeploy.';
        case 'DATABASE_URL_INVALID':
        case 'DATABASE_URL_PLACEHOLDER':
            return 'In Neon: Connection details → copy the pooled connection string. Paste it as DATABASE_URL in Vercel Production env, then Redeploy.';
        case 'DB_CONNECT_FAILED':
            return 'Check Neon project is active, credentials are correct, and the URL uses the -pooler host with sslmode=require.';
        default:
            return 'Open Vercel → Deployments → Functions logs for [bootstrap] and [pg-schema] lines.';
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
