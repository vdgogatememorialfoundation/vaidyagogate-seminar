const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('database.sqlite');

db.all(
    `SELECT t.id, t.ticket_id_string, t.order_id, o.status, r.application_no, r.status AS reg_status
     FROM tickets t
     JOIN orders o ON o.id = t.order_id
     JOIN registrations r ON r.id = o.registration_id
     ORDER BY t.id DESC LIMIT 20`,
    [],
    (e, tickets) => {
        console.log('=== Tickets (latest 20) ===');
        console.log(JSON.stringify(tickets, null, 2));
        db.all(
            `SELECT uc.id, uc.user_id, uc.seminar_id, uc.enabled, uc.scan_verified, uc.template_id,
                    ct.file_path, ct.is_active AS tpl_active
             FROM user_certificates uc
             LEFT JOIN certificate_templates ct ON ct.id = uc.template_id
             ORDER BY uc.id DESC LIMIT 15`,
            [],
            (e2, certs) => {
                console.log('=== User certificates ===');
                console.log(JSON.stringify(certs, null, 2));
                db.all(
                    `SELECT seminar_id, id, file_path, is_active, cert_type FROM certificate_templates ORDER BY id DESC LIMIT 10`,
                    [],
                    (e3, tpls) => {
                        console.log('=== Certificate templates ===');
                        console.log(JSON.stringify(tpls, null, 2));
                        db.close();
                    }
                );
            }
        );
    }
);
