/**
 * PostgreSQL (Neon) — sqlite3-compatible callback API for minimal app changes.
 */
const { Pool } = require('pg');
const { convertSqliteToPostgres, toPositionalParams, isInsert, appendReturningId } = require('./sql-convert');

let pool = null;
let schemaReady = null;

function getPool() {
    if (!pool) {
        const url = process.env.DATABASE_URL;
        if (!url) throw new Error('DATABASE_URL is required for PostgreSQL');
        pool = new Pool({
            connectionString: url,
            ssl: url.includes('localhost') ? false : { rejectUnauthorized: false },
            max: process.env.VERCEL ? 3 : 10
        });
    }
    return pool;
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
            const msg = String(err.message || err);
            if (msg.includes('duplicate column') || msg.includes('already exists')) {
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
                .then(() => {
                    const fs = require('fs');
                    const path = require('path');
                    const schemaPath = path.join(__dirname, 'schema-postgres.sql');
                    if (!schemaReady) {
                        schemaReady = (async () => {
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
                                    if (!String(e.message).includes('already exists')) {
                                        console.warn('[pg-schema]', e.message.slice(0, 120));
                                    }
                                }
                            }
                        })();
                    }
                    schemaReady.then(() => callback && callback(null)).catch((e) => callback && callback(e));
                })
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
            api._queue = api._queue.then(
                () =>
                    new Promise((resolve) => {
                        try {
                            fn();
                        } catch (e) {
                            console.error(e);
                        }
                        setImmediate(() => resolve());
                    })
            );
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
                pool.end().then(() => callback && callback(null)).catch((e) => callback && callback(e));
                pool = null;
            } else if (callback) callback(null);
        }
    };
    return api;
}

module.exports = { createPgDb, getPool };
