const sqlite3 = require('sqlite3');
const db = new sqlite3.Database('./database.sqlite');
db.all(
    `SELECT id, user_id_string, first_name, last_name, role, user_role FROM users
     WHERE LOWER(COALESCE(role,'')) IN ('judge','reviewer')
        OR LOWER(COALESCE(user_role,'')) IN ('judge','reviewer')`,
    [],
    (e, r) => {
        console.log('API without judge_user:', r?.length, r);
        db.all(
            `SELECT id, user_id_string, first_name, last_name, role, user_role FROM users
             WHERE LOWER(COALESCE(user_role,'')) IN ('judge','reviewer','judge_user')`,
            [],
            (e2, r2) => {
                console.log('with judge_user only on user_role:', r2);
                db.all('SELECT * FROM case_judge_assignments', [], (e3, a) => {
                    console.log('assignments', a);
                    db.close();
                });
            }
        );
    }
);
