/**
 * Build lib/schema-postgres.sql from SQLite schema dump.
 * Run: node scripts/build-pg-schema.js
 */
const fs = require('fs');
const path = require('path');

const dumpPath = path.join(__dirname, 'sqlite-schema-dump.txt');
const outPath = path.join(__dirname, '..', 'lib', 'schema-postgres.sql');

if (!fs.existsSync(dumpPath)) {
    console.error('Run: node dump_schema.js > scripts/sqlite-schema-dump.txt');
    process.exit(1);
}

const raw = fs.readFileSync(dumpPath, 'utf8');
const blocks = raw.split(/(?=CREATE TABLE)/).filter((b) => b.trim().startsWith('CREATE'));

function convertCreate(sql) {
    if (/sqlite_sequence/i.test(sql)) return '';
    let s = sql.trim();
    s = s.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY');
    s = s.replace(/AUTOINCREMENT/gi, '');
    s = s.replace(/\bDATETIME\b/gi, 'TIMESTAMPTZ');
    s = s.replace(/\bBOOLEAN\b/gi, 'BOOLEAN');
    s = s.replace(/,\s*--[^\n]*/g, '');
    s = s.replace(/\s+REFERENCES users\(id\)/gi, '');
    if (!/CREATE TABLE IF NOT EXISTS/i.test(s)) {
        s = s.replace(/CREATE TABLE/i, 'CREATE TABLE IF NOT EXISTS');
    }
    if (!s.endsWith(';')) s += ';';
    return s;
}

const out = [
    '-- Auto-generated from SQLite schema — Neon / Vercel',
    'CREATE EXTENSION IF NOT EXISTS "pgcrypto";',
    '',
    ...blocks.map(convertCreate).filter(Boolean),
    '',
    `INSERT INTO payment_gateways (name, is_active, config) VALUES
 ('razorpay', 0, '{}'),
 ('payu', 0, '{}'),
 ('cashfree', 0, '{}')
 ON CONFLICT (name) DO NOTHING;`,
    ''
].join('\n');

fs.writeFileSync(outPath, out);
console.log('Wrote', outPath, '(' + blocks.length, 'tables)');
