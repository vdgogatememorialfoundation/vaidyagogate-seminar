#!/usr/bin/env node
/**
 * One-time: apply lib/schema-postgres.sql to Neon (faster first Vercel cold start).
 * Usage: set DATABASE_URL in env, then: node scripts/apply-neon-schema.js
 */
const { createPgDb, getPool } = require('../lib/db-pg');

const db = createPgDb();
db.connect((err) => {
    if (err) {
        console.error('Connect failed:', err.message);
        process.exit(1);
    }
    console.log('Schema apply finished.');
    getPool()
        .end()
        .then(() => process.exit(0))
        .catch(() => process.exit(0));
});
