/**
 * PostgreSQL (Neon) — sqlite3-compatible callback API for minimal app changes.
 */
const { Pool } = require('pg');
const { convertSqliteToPostgres, toPositionalParams, insertReturnsId, appendReturningId } = require('./sql-convert');
const { resolveDatabaseUrl, resolveSchemaDatabaseUrl } = require('./env-db');
const { CORE_TABLE_DDL } = require('./core-schema-pg');
const {
    ensureAuxiliaryTables,
    ensureCertificateVerifyColumns,
    listMissingAuxTables
} = require('./extended-schema-pg');

let pool = null;
let schemaPool = null;
let schemaReady = null;
let schemaApplyErrors = [];
/** Persists on warm Vercel invocations — skips repeat schema work. */
let schemaBootstrapped = false;

function isIgnorablePgError(err) {
    const msg = String(err && err.message ? err.message : err);
    return (
        msg.includes('duplicate column') ||
        msg.includes('already exists') ||
        msg.includes('duplicate key')
    );
}

function getPool() {
    if (!pool) {
        const url = resolveDatabaseUrl();
        if (!url) throw new Error('DATABASE_URL is required for PostgreSQL');
        const isLocal = /localhost|127\.0\.0\.1/i.test(url);
        pool = new Pool({
            connectionString: url,
            ssl: isLocal ? false : { rejectUnauthorized: false },
            max: process.env.VERCEL ? 1 : 10,
            idleTimeoutMillis: process.env.VERCEL ? 5000 : 30000,
            connectionTimeoutMillis: process.env.VERCEL ? 10000 : 15000,
            allowExitOnIdle: !!process.env.VERCEL
        });
        pool.on('error', (err) => {
            console.error('[pg-pool]', err.message);
        });
    }
    return pool;
}

function getSchemaPool() {
    if (!schemaPool) {
        const url = resolveSchemaDatabaseUrl();
        if (!url) throw new Error('DATABASE_URL is required for PostgreSQL schema');
        const isLocal = /localhost|127\.0\.0\.1/i.test(url);
        schemaPool = new Pool({
            connectionString: url,
            ssl: isLocal ? false : { rejectUnauthorized: false },
            max: 1,
            idleTimeoutMillis: 10000,
            connectionTimeoutMillis: process.env.VERCEL ? 15000 : 20000,
            allowExitOnIdle: !!process.env.VERCEL
        });
        schemaPool.on('error', (err) => {
            console.error('[pg-schema-pool]', err.message);
        });
    }
    return schemaPool;
}

async function querySchemaWithRetry(sql, params, attempts) {
    const n = attempts || (process.env.VERCEL ? 3 : 2);
    let lastErr;
    for (let i = 0; i < n; i++) {
        try {
            return await getSchemaPool().query(sql, params);
        } catch (e) {
            lastErr = e;
            const retryable =
                /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timeout|Connection terminated|ECONNRESET|57P01|53300/i.test(
                    String(e.message || e)
                );
            if (!retryable || i === n - 1) throw e;
            await new Promise((r) => setTimeout(r, 300 * (i + 1)));
        }
    }
    throw lastErr;
}

async function queryWithRetry(sql, params, attempts) {
    const n = attempts || (process.env.VERCEL ? 3 : 2);
    let lastErr;
    for (let i = 0; i < n; i++) {
        try {
            return await getPool().query(sql, params);
        } catch (e) {
            lastErr = e;
            const retryable =
                /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timeout|Connection terminated|ECONNRESET|57P01|53300/i.test(
                    String(e.message || e)
                );
            if (!retryable || i === n - 1) throw e;
            await new Promise((r) => setTimeout(r, 300 * (i + 1)));
        }
    }
    throw lastErr;
}

const CORE_TABLES = ['users', 'seminars', 'registrations', 'orders', 'tickets'];

async function listMissingCoreTables() {
    try {
        const r = await queryWithRetry(
            `SELECT table_name FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
            [CORE_TABLES],
            2
        );
        const found = new Set((r.rows || []).map((row) => row.table_name));
        return CORE_TABLES.filter((n) => !found.has(n));
    } catch (e) {
        console.error('[pg-schema] listMissingCoreTables:', e.message);
        throw e;
    }
}

async function isCoreSchemaPresent() {
    const missing = await listMissingCoreTables();
    return missing.length === 0;
}

async function isFullSchemaPresent() {
    const [coreMissing, auxMissing] = await Promise.all([
        listMissingCoreTables(),
        listMissingAuxTables(queryWithRetry)
    ]);
    return coreMissing.length === 0 && auxMissing.length === 0;
}

async function markSchemaBootstrappedIfComplete() {
    const complete = await isFullSchemaPresent();
    schemaBootstrapped = complete;
    if (!complete) schemaReady = null;
    return complete;
}

async function ensureMissingCoreTables() {
    const missing = await listMissingCoreTables();
    if (!missing.length) return [];
    console.log('[pg-schema] ensuring core tables:', missing.join(', '));
    for (const def of CORE_TABLE_DDL) {
        if (!missing.includes(def.name)) continue;
        try {
            await querySchemaWithRetry(def.sql, [], 2);
            console.log('[pg-schema] created core table:', def.name);
        } catch (e) {
            if (!isIgnorablePgError(e)) {
                schemaApplyErrors.push(String(e.message).slice(0, 200));
                console.error('[pg-schema] core table failed:', def.name, e.message);
            }
        }
    }
    return listMissingCoreTables();
}

const SCHEMA_LOCK_KEY = 8675309;

async function waitForCoreSchema(maxWaitMs) {
    const deadline = Date.now() + (maxWaitMs || 45000);
    while (Date.now() < deadline) {
        if (await isCoreSchemaPresent()) return true;
        await new Promise((r) => setTimeout(r, 1500));
    }
    return isCoreSchemaPresent();
}

async function applyPostgresSchema() {
    const schemaUrl = resolveSchemaDatabaseUrl();
    if (schemaUrl && /-pooler\./i.test(resolveDatabaseUrl() || '')) {
        console.log('[pg-schema] applying DDL via direct Neon connection (non-pooler)');
    }
    let missingBefore = await listMissingCoreTables();
    if (!missingBefore.length) {
        await ensureAuxiliaryTables(querySchemaWithRetry, isIgnorablePgError);
        await markSchemaBootstrappedIfComplete();
        return;
    }

    await ensureMissingCoreTables();
    await ensureAuxiliaryTables(querySchemaWithRetry, isIgnorablePgError);
    missingBefore = await listMissingCoreTables();
    if (!missingBefore.length) {
        await markSchemaBootstrappedIfComplete();
        return;
    }
    if (schemaBootstrapped) {
        console.warn('[pg-schema] incomplete schema on warm instance — re-applying:', missingBefore.join(', '));
        schemaBootstrapped = false;
    }

    const fs = require('fs');
    const path = require('path');
    const schemaPath = path.join(__dirname, 'schema-postgres.sql');
    if (!fs.existsSync(schemaPath)) {
        await ensureMissingCoreTables();
        await ensureAuxiliaryTables(querySchemaWithRetry, isIgnorablePgError);
        await markSchemaBootstrappedIfComplete();
        return;
    }

    console.log('[pg-schema] missing tables:', missingBefore.join(', '));

    let locked = false;
    try {
        const lockRow = await querySchemaWithRetry('SELECT pg_try_advisory_lock($1) AS ok', [SCHEMA_LOCK_KEY], 2);
        locked = !!(lockRow.rows[0] && lockRow.rows[0].ok);
        if (!locked) {
            console.log('[pg-schema] waiting for peer bootstrap');
            if (await waitForCoreSchema(50000)) {
                await ensureAuxiliaryTables(querySchemaWithRetry, isIgnorablePgError);
                await markSchemaBootstrappedIfComplete();
                return;
            }
        }

        if (await isCoreSchemaPresent()) {
            await ensureAuxiliaryTables(querySchemaWithRetry, isIgnorablePgError);
            await markSchemaBootstrappedIfComplete();
            return;
        }

        schemaApplyErrors = [];
        const sql = fs.readFileSync(schemaPath, 'utf8');

        try {
            await querySchemaWithRetry(sql, [], 2);
            console.log('[pg-schema] applied (bulk)');
            await ensureMissingCoreTables();
            await ensureAuxiliaryTables(querySchemaWithRetry, isIgnorablePgError);
            if (await isCoreSchemaPresent()) {
                await markSchemaBootstrappedIfComplete();
                return;
            }
        } catch (bulkErr) {
            if (!isIgnorablePgError(bulkErr)) {
                console.warn('[pg-schema] bulk apply failed, chunking:', String(bulkErr.message).slice(0, 120));
            }
        }

        const chunks = sql
            .split(/;\s*\n/)
            .map((c) => c.trim())
            .filter((c) => c && !c.startsWith('--'));
        for (const chunk of chunks) {
            try {
                await querySchemaWithRetry(chunk, [], 2);
            } catch (e) {
                if (!isIgnorablePgError(e)) {
                    const brief = String(e.message).slice(0, 200);
                    schemaApplyErrors.push(brief);
                    console.error('[pg-schema]', brief, '| stmt:', chunk.slice(0, 72).replace(/\s+/g, ' '));
                }
            }
        }
        if (schemaApplyErrors.length) {
            console.error(`[pg-schema] ${schemaApplyErrors.length} non-idempotent statement(s) failed`);
        }
        await ensureMissingCoreTables();
        await ensureAuxiliaryTables(querySchemaWithRetry, isIgnorablePgError);
        await markSchemaBootstrappedIfComplete();
        const stillMissing = await listMissingCoreTables();
        const auxMissing = await listMissingAuxTables(queryWithRetry);
        if (stillMissing.length || auxMissing.length) {
            console.error(
                '[pg-schema] still missing after bootstrap:',
                [...stillMissing, ...auxMissing].join(', ')
            );
        }
    } finally {
        if (locked) {
            try {
                await queryWithRetry('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK_KEY], 1);
            } catch (e) {
                console.warn('[pg-schema] unlock failed:', e.message);
            }
        }
    }
}

function getSchemaApplyErrors() {
    const { getLastAuxDdlErrors } = require('./extended-schema-pg');
    return [...schemaApplyErrors, ...(getLastAuxDdlErrors ? getLastAuxDdlErrors() : [])];
}

function ensureSchemaReady() {
    const needsRun = !schemaReady || (process.env.VERCEL && !schemaBootstrapped);
    if (needsRun) {
        schemaReady = applyPostgresSchema()
            .then(async () => {
                const missing = await listMissingCoreTables();
                if (missing.length) {
                    schemaBootstrapped = false;
                    schemaReady = null;
                    throw new Error('PostgreSQL core schema incomplete: ' + missing.join(', '));
                }
                let auxMissing = await ensureAuxiliaryTables(querySchemaWithRetry, isIgnorablePgError);
                if (auxMissing.length) {
                    console.warn('[pg-schema] retrying auxiliary tables:', auxMissing.join(', '));
                    auxMissing = await ensureAuxiliaryTables(querySchemaWithRetry, isIgnorablePgError);
                }
                if (auxMissing.length) {
                    schemaBootstrapped = false;
                    schemaReady = null;
                    throw new Error('PostgreSQL auxiliary schema incomplete: ' + auxMissing.join(', '));
                }
                schemaBootstrapped = true;
                try {
                    await querySchemaWithRetry(
                        'ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ',
                        [],
                        1
                    );
                } catch (colErr) {
                    if (!isIgnorablePgError(colErr)) {
                        console.warn('[pg-schema] users.last_login_at:', colErr.message);
                    }
                }
                const { ensureCaseProgramsColumns } = require('./extended-schema-pg');
                await ensureCaseProgramsColumns(querySchemaWithRetry, isIgnorablePgError);
                const { ensureUsersEmailPolicy } = require('./users-email-policy');
                await new Promise((resolve, reject) => {
                    const shim = {
                        run(sql, params, cb) {
                            querySchemaWithRetry(sql, params, 2)
                                .then(() => cb && cb(null))
                                .catch((e) => cb && cb(e));
                        }
                    };
                    ensureUsersEmailPolicy(shim, (e) => (e ? reject(e) : resolve()));
                });
            })
            .catch((e) => {
                schemaBootstrapped = false;
                schemaReady = null;
                throw e;
            });
    }
    return schemaReady;
}

function runQuery(sql, params, callback, ctx) {
    const converted = convertSqliteToPostgres(sql);
    let finalSql = converted;
    let addReturning = insertReturnsId(converted);
    if (addReturning) finalSql = appendReturningId(converted);
    const { sql: pgSql, params: pgParams } = toPositionalParams(finalSql, params);

    queryWithRetry(pgSql, pgParams, 2)
        .then((result) => {
            const fake = {
                lastID: addReturning && result.rows[0] ? result.rows[0].id : undefined,
                changes: result.rowCount
            };
            if (typeof callback === 'function') callback.call(fake, null);
        })
        .catch((err) => {
            if (isIgnorablePgError(err)) {
                if (typeof callback === 'function') return callback.call({ changes: 0 }, null);
            }
            if (typeof callback === 'function') callback.call(ctx || {}, err);
        });
}

function createPgDb() {
    const api = {
        _queue: Promise.resolve(),

        connect(callback) {
            queryWithRetry('SELECT 1', [], process.env.VERCEL ? 3 : 2)
                .then(() => ensureSchemaReady())
                .then(() => callback && callback(null))
                .catch((e) => {
                    console.error('[pg] connect failed:', e.message);
                    callback && callback(e);
                });
        },

        run(sql, params, callback) {
            if (typeof params === 'function') {
                callback = params;
                params = [];
            }
            api._queue = api._queue.then(
                () =>
                    new Promise((resolve) => {
                        runQuery(sql, params, function (err) {
                            if (callback) callback.call(this, err);
                            resolve();
                        });
                    })
            );
        },

        get(sql, params, callback) {
            if (typeof params === 'function') {
                callback = params;
                params = [];
            }
            const converted = convertSqliteToPostgres(sql);
            const { sql: pgSql, params: pgParams } = toPositionalParams(converted, params);
            queryWithRetry(pgSql, pgParams, 2)
                .then((result) => callback(null, result.rows[0]))
                .catch((err) => callback(err));
        },

        all(sql, params, callback) {
            if (typeof params === 'function') {
                callback = params;
                params = [];
            }
            const converted = convertSqliteToPostgres(sql);
            const { sql: pgSql, params: pgParams } = toPositionalParams(converted, params);
            queryWithRetry(pgSql, pgParams, 2)
                .then((result) => callback(null, result.rows || []))
                .catch((err) => callback(err));
        },

        serialize(fn) {
            api._queue = api._queue.then(() => {
                try {
                    fn();
                } catch (e) {
                    console.error(e);
                }
            });
        },

        prepare(sql) {
            const converted = convertSqliteToPostgres(sql);
            return {
                run(...args) {
                    const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
                    api.run(converted, args, cb);
                },
                finalize(cb) {
                    if (cb) cb(null);
                }
            };
        },

        close(callback) {
            if (pool) {
                pool
                    .end()
                    .then(() => callback && callback(null))
                    .catch((e) => callback && callback(e));
                pool = null;
                schemaReady = null;
                schemaBootstrapped = false;
            } else if (callback) callback(null);
        }
    };
    return api;
}

async function runEnsureAuxiliaryTables() {
    return ensureAuxiliaryTables(querySchemaWithRetry, isIgnorablePgError);
}

async function runEnsureCertificateVerifyColumns() {
    return ensureCertificateVerifyColumns(queryWithRetry, isIgnorablePgError);
}

module.exports = {
    createPgDb,
    getPool,
    ensureSchemaReady,
    ensureMissingCoreTables,
    ensureAuxiliaryTables: runEnsureAuxiliaryTables,
    ensureCertificateVerifyColumns: runEnsureCertificateVerifyColumns,
    getSchemaApplyErrors,
    queryWithRetry,
    isCoreSchemaPresent,
    isFullSchemaPresent,
    listMissingCoreTables,
    listMissingAuxTables: () => listMissingAuxTables(queryWithRetry),
    CORE_TABLES
};
