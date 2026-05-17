const { convertSqliteToPostgres } = require('../lib/sql-convert');
const q = `SELECT cp.*, s.title AS seminar_title,
                    (SELECT COUNT(*) FROM case_submissions cs WHERE cs.case_program_id = cp.id AND cs.status NOT IN ('cancelled')) AS submission_count
             FROM case_programs cp
             LEFT JOIN seminars s ON s.id = cp.seminar_id
             WHERE cp.is_active = 1
             ORDER BY cp.registration_start DESC`;
console.log(convertSqliteToPostgres(q));
