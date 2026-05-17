/**
 * Ensure admin login exists (email/password from env). Set on Vercel:
 *   ADMIN_EMAIL=admin@vaidyagogate.org
 *   ADMIN_PASSWORD=Admin@2026
 */
function ensureBootstrapAdmin(db, generateId, cb) {
    const email = String(process.env.ADMIN_EMAIL || 'admin@vaidyagogate.org')
        .trim()
        .toLowerCase();
    const password =
        process.env.ADMIN_PASSWORD ||
        (process.env.VERCEL || process.env.NODE_ENV === 'production' ? '' : 'Admin@2026');
    if (!password) {
        if (process.env.VERCEL) {
            console.warn(
                '[admin] Set ADMIN_EMAIL and ADMIN_PASSWORD in Vercel env to create/update the admin user.'
            );
        }
        return cb && cb();
    }

    db.get(`SELECT id FROM users WHERE lower(trim(email)) = ?`, [email], (err, row) => {
        if (err) return cb && cb(err);
        if (row) {
            db.run(
                `UPDATE users SET password = ?, role = 'admin', user_role = 'admin', is_disabled = 0,
                 first_name = COALESCE(NULLIF(trim(first_name), ''), 'Super'),
                 last_name = COALESCE(NULLIF(trim(last_name), ''), 'Admin')
                 WHERE id = ?`,
                [password, row.id],
                (uErr) => {
                    if (!uErr) console.log('[admin] Updated admin user:', email);
                    if (cb) cb(uErr);
                }
            );
            return;
        }
        let uid = '';
        for (let i = 0; i < 12; i++) uid += Math.floor(Math.random() * 10).toString();
        db.run(
            `INSERT INTO users (user_id_string, first_name, last_name, email, phone, password, role, user_role)
             VALUES (?, 'Super', 'Admin', ?, '0000000000', ?, 'admin', 'admin')`,
            ['ADMIN_' + uid.slice(0, 8), email, password],
            (iErr) => {
                if (!iErr) console.log('[admin] Created admin user:', email);
                if (cb) cb(iErr);
            }
        );
    });
}

module.exports = { ensureBootstrapAdmin };
