const { convertSqliteToPostgres } = require('../lib/sql-convert');
const q = `SELECT * FROM seminars WHERE is_active = 1 AND (portal_year = ? OR portal_year IS NULL OR CAST(strftime('%Y', COALESCE(event_date, created_at)) AS INTEGER) = ?)`;
console.log(convertSqliteToPostgres(q));
