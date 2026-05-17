/**
 * PostgreSQL (Neon) — sqlite3-compatible callback API for minimal app changes.
 */
const { Pool } = require('pg');
const { convertSqliteToPostgres, toPositionalParams, insertReturnsId, appendReturningId } = require('./sql-convert');
const { resolveDatabaseUrl } = require('./env-db');

let pool = null;
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
            `SELECT required.name AS table_name
             FROM unnest($1::text[]) AS required(name)
             LEFT JOIN information_schema.tables t
               ON t.table_schema = 'public' AND t.table_name = required.name
             WHERE t.table_name IS NULL`,
            [CORE_TABLES],
            2
        );
        return (r.rows || []).map((row) => row.table_name);
    } catch {
        return CORE_TABLES.slice();
    }
}

async function isCoreSchemaPresent() {
    const missing = await listMissingCoreTables();
    return missing.length === 0;
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
    const missingBefore = await listMissingCoreTables();
    if (!missingBefore.length) {
        schemaBootstrapped = true;
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
        schemaBootstrapped = true;
        return;
    }

    console.log('[pg-schema] missing tables:', missingBefore.join(', '));

    let locked = false;
    try {
        const lockRow = await queryWithRetry('SELECT pg_try_advisory_lock($1) AS ok', [SCHEMA_LOCK_KEY], 2);
        locked = !!(lockRow.rows[0] && lockRow.rows[0].ok);
        if (!locked) {
            console.log('[pg-schema] waiting for peer bootstrap');
            if (await waitForCoreSchema(50000)) {
                schemaBootstrapped = true;
                return;
            }
        }

        if (await isCoreSchemaPresent()) {
            schemaBootstrapped = true;
            return;
        }

        schemaApplyErrors = [];
        const sql = fs.readFileSync(schemaPath, 'utf8');

        try {
            await queryWithRetry(sql, [], 2);
            console.log('[pg-schema] applied (bulk)');
            schemaBootstrapped = true;
            return;
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
                await queryWithRetry(chunk, [], 2);
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
        schemaBootstrapped = true;
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
    return schemaApplyErrors.slice();
}

function ensureSchemaReady() {
    if (!schemaReady) {
        schemaReady = applyPostgresSchema();
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

module.exports = {
    createPgDb,
    getPool,
    ensureSchemaReady,
    getSchemaApplyErrors,
    queryWithRetry,
    isCoreSchemaPresent,
    listMissingCoreTables,
    CORE_TABLES
};
