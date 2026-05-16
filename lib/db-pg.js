/**
 * PostgreSQL (Neon) — sqlite3-compatible callback API for minimal app changes.
 */
const { Pool } = require('pg');
const { convertSqliteToPostgres, toPositionalParams, isInsert, appendReturningId } = require('./sql-convert');

let pool = null;
let schemaReady = null;

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
        const url = process.env.DATABASE_URL;
        if (!url) throw new Error('DATABASE_URL is required for PostgreSQL');
        pool = new Pool({
            connectionString: url,
            ssl: url.includes('localhost') || url.includes('127.0.0.1') ? false : { rejectUnauthorized: false },
            max: process.env.VERCEL ? 3 : 10,
            idleTimeoutMillis: process.env.VERCEL ? 10000 : 30000,
            connectionTimeoutMillis: 15000
        });
        pool.on('error', (err) => {
            console.error('[pg-pool]', err.message);
        });
    }
    return pool;
}

async function applyPostgresSchema() {
    const fs = require('fs');
    const path = require('path');
    const schemaPath = path.join(__dirname, 'schema-postgres.sql');
    if (!fs.existsSync(schemaPath)) return;
    const sql = fs.readFileSync(schemaPath, 'utf8');
    const chunks = sql
        .split(/;\s*\n/)
        .map((c) => c.trim())
        .filter((c) => c && !c.startsWith('--'));
    for (const chunk of chunks) {
        try {
            await getPool().query(chunk);
        } catch (e) {
            if (!isIgnorablePgError(e)) {
                console.warn('[pg-schema]', String(e.message).slice(0, 160));
            }
        }
    }
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
    let addReturning = isInsert(converted) && !/RETURNING\s+/i.test(converted);
    if (addReturning) finalSql = appendReturningId(converted);
    const { sql: pgSql, params: pgParams } = toPositionalParams(finalSql, params);

    getPool()
        .query(pgSql, pgParams)
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
            getPool()
                .query('SELECT 1')
                .then(() => ensureSchemaReady())
                .then(() => callback && callback(null))
                .catch((e) => callback && callback(e));
        },

        run(sql, params, callback) {
            if (typeof params === 'function') {
                callback = params;
                params = [];
            }
            api._queue = api._queue.then(
                () =>
                    new Promise((resolve) => {
                        runQuery(sql, params, (err) => {
                            if (callback) callback(err);
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
            getPool()
                .query(pgSql, pgParams)
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
            getPool()
                .query(pgSql, pgParams)
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
            } else if (callback) callback(null);
        }
    };
    return api;
}

module.exports = { createPgDb, getPool, ensureSchemaReady };
