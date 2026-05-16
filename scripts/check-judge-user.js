const sqlite3 = require('sqlite3');
const db = new sqlite3.Database('./database.sqlite');
const uid = '393671924601';
db.get(
    `SELECT id, user_id_string, first_name, last_name, email, role, user_role FROM users WHERE user_id_string = ?`,
    [uid],
    (e, user) => {
        console.log('target user:', user);
        db.all(
            `SELECT id, user_id_string, first_name, last_name, role, user_role FROM users
             WHERE LOWER(COALESCE(role,'')) IN ('judge','reviewer')
                OR LOWER(COALESCE(user_role,'')) IN ('judge','reviewer')`,
            [],
            (e2, judges) => {
                console.log('reviewers API would return:', judges?.length, 'rows');
                judges?.forEach((j) => console.log(' -', j.user_id_string, j.first_name, j.last_name, j.role, j.user_role));
                db.all('SELECT id, user_id, application_no, status, case_program_id FROM case_submissions ORDER BY id DESC LIMIT 5', [], (e3, subs) => {
                    console.log('recent submissions:', subs);
                    db.close();
                });
            }
        );
    }
);
