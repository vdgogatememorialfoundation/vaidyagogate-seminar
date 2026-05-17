/**
 * Ensure admin logins exist from Vercel env:
 *   ADMIN_EMAIL / ADMIN_PASSWORD — super admin
 *   ADMIN_EMAIL_2 / ADMIN_PASSWORD_2 — second super admin (optional)
 *   CO_ADMIN_EMAIL / CO_ADMIN_PASSWORD — co-admin portal access (optional)
 */
function parseBootstrapAdmins() {
    const list = [];
    const add = (emailEnv, passEnv, userRole, firstName, lastName) => {
        const email = String(process.env[emailEnv] || '')
            .trim()
            .toLowerCase();
        const password = process.env[passEnv];
        if (!email || !password) return;
        list.push({ email, password, userRole, firstName, lastName });
    };

    add('ADMIN_EMAIL', 'ADMIN_PASSWORD', 'admin', 'Super', 'Admin');
    if (!list.length && !process.env.VERCEL && process.env.NODE_ENV !== 'production') {
        list.push({
            email: 'admin@vaidyagogate.org',
            password: 'Admin@2026',
            userRole: 'admin',
            firstName: 'Super',
            lastName: 'Admin'
        });
    }
    add('ADMIN_EMAIL_2', 'ADMIN_PASSWORD_2', 'admin', 'Admin', 'User');
    add('CO_ADMIN_EMAIL', 'CO_ADMIN_PASSWORD', 'co_admin', 'Co', 'Admin');
    return list;
}

function upsertBootstrapAdmin(db, spec, cb) {
    const roleCol = spec.userRole === 'co_admin' ? 'admin' : 'admin';
    db.get(`SELECT id FROM users WHERE lower(trim(email)) = ?`, [spec.email], (err, row) => {
        if (err) return cb(err);
        if (row) {
            db.run(
                `UPDATE users SET password = ?, role = ?, user_role = ?, is_disabled = 0,
                 first_name = COALESCE(NULLIF(trim(first_name), ''), ?),
                 last_name = COALESCE(NULLIF(trim(last_name), ''), ?)
                 WHERE id = ?`,
                [spec.password, roleCol, spec.userRole, spec.firstName, spec.lastName, row.id],
                (uErr) => {
                    if (!uErr) console.log('[admin] Updated', spec.userRole, 'user:', spec.email);
                    cb(uErr);
                }
            );
            return;
        }
        let uid = '';
        for (let i = 0; i < 12; i++) uid += Math.floor(Math.random() * 10).toString();
        const prefix = spec.userRole === 'co_admin' ? 'COADMIN_' : 'ADMIN_';
        db.run(
            `INSERT INTO users (user_id_string, first_name, last_name, email, phone, password, role, user_role)
             VALUES (?, ?, ?, ?, '0000000000', ?, ?, ?)`,
            [prefix + uid.slice(0, 8), spec.firstName, spec.lastName, spec.email, spec.password, roleCol, spec.userRole],
            (iErr) => {
                if (!iErr) console.log('[admin] Created', spec.userRole, 'user:', spec.email);
                cb(iErr);
            }
        );
    });
}

function ensureBootstrapAdmin(db, generateId, cb) {
    const admins = parseBootstrapAdmins();
    if (!admins.length) {
        if (process.env.VERCEL) {
            console.warn(
                '[admin] Set ADMIN_EMAIL + ADMIN_PASSWORD (and optionally ADMIN_EMAIL_2, CO_ADMIN_EMAIL) in Vercel env.'
            );
        }
        return cb && cb();
    }

    let i = 0;
    const next = (err) => {
        if (err) return cb && cb(err);
        if (i >= admins.length) return cb && cb();
        const spec = admins[i++];
        upsertBootstrapAdmin(db, spec, next);
    };
    next();
}

module.exports = { ensureBootstrapAdmin, parseBootstrapAdmins };
