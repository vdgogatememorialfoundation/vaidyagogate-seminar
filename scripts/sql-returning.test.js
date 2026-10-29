/**
 * Postgres inserts append RETURNING id. Tables whose key is not id must be excluded,
 * or the first save fails with: column "id" does not exist.
 */
const assert = require('assert');
const { insertReturnsId, appendReturningId } = require('../lib/sql-convert');

const settings = `INSERT INTO video_settings (value, updated_at, key) VALUES (?, ?, ?)`;
assert.strictEqual(insertReturnsId(settings), false);
assert.strictEqual(appendReturningId(settings), settings.trim());

assert.strictEqual(insertReturnsId(`INSERT INTO wa_settings (key, value) VALUES (?, ?)`), false);
assert.strictEqual(insertReturnsId(`INSERT INTO global_settings (key, value) VALUES (?, ?)`), false);
assert.strictEqual(insertReturnsId(`INSERT INTO online_seminar_meetings (seminar_id, delivery_mode) VALUES (?, ?)`), false);
assert.strictEqual(insertReturnsId(`INSERT INTO video_items (title) VALUES (?)`), true);
assert.strictEqual(appendReturningId(`INSERT INTO video_items (title) VALUES (?)`), `INSERT INTO video_items (title) VALUES (?) RETURNING id`);

console.log('sql returning ok');
