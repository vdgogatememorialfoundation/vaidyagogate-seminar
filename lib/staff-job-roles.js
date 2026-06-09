/**
 * Job role templates (user_roles.permissions JSON) for staff / co-admin / judge / scanner.
 */
const { parseModulesJson, adminModulesToStaffModules } = require('./staff-portal-sync');

const PERM_VERSION = 1;

const STAFF_MODULE_DEFS = [
    ['book-inventory', 'Stock inventory'],
    ['book-orders', 'Book orders'],
    ['applications', 'Review applications'],
    ['support-tickets', 'Support tickets'],
    ['etickets', 'E-tickets lookup'],
    ['payments', 'Payments & seminar orders']
];

/** All admin sidebar tab ids (keep in sync with ADMIN_MODULE_TAB_DEFS in public/js/admin.js). */
const CO_ADMIN_FULL_ADMIN_TAB_IDS = [
    'tab-staff-users',
    'tab-doctors',
    'tab-seminars',
    'tab-event-schedules',
    'tab-applications',
    'tab-feedback',
    'tab-support-tickets',
    'tab-support-desk',
    'tab-contact-inquiries',
    'tab-email-compose',
    'tab-transfer',
    'tab-behalf-reg',
    'tab-reg-form',
    'tab-site-cms',
    'tab-book-sales',
    'tab-admin-payments',
    'tab-certificates',
    'tab-volunteers',
    'tab-volunteer-assignments',
    'tab-case-mgmt',
    'tab-analytics',
    'tab-reports',
    'tab-etickets',
    'tab-scanner-logs',
    'tab-live-scanner',
    'tab-pos',
    'tab-feedback-form',
    'tab-activity-logs',
    'tab-notifications',
    'tab-system-platform',
    'tab-system-users',
    'tab-settings'
];

function fullCoAdminStaffModules() {
    return {
        'book-inventory': true,
        'book-orders': true,
        applications: true,
        'support-tickets': true,
        etickets: true,
        payments: true
    };
}

function fullCoAdminAdminModules() {
    const admin = {};
    CO_ADMIN_FULL_ADMIN_TAB_IDS.forEach((id) => {
        admin[id] = true;
    });
    return admin;
}

function fullCoAdminPermissions() {
    return {
        version: PERM_VERSION,
        portal: 'admin',
        user_role: 'co_admin',
        staff_modules: fullCoAdminStaffModules(),
        admin_modules: fullCoAdminAdminModules()
    };
}

const DEFAULT_JOB_ROLES = [
    {
        role_name: 'job_co_admin_full',
        description: 'Co-admin — full admin & staff portal',
        permissions: fullCoAdminPermissions()
    },
    {
        role_name: 'job_applications_staff',
        description: 'Staff — applications approval only',
        permissions: {
            version: PERM_VERSION,
            portal: 'staff',
            user_role: 'staff_user',
            staff_modules: { applications: true },
            admin_modules: {}
        }
    },
    {
        role_name: 'job_book_sales',
        description: 'Staff — book inventory & orders',
        permissions: {
            version: PERM_VERSION,
            portal: 'staff',
            user_role: 'book_sales_staff',
            staff_modules: { 'book-inventory': true, 'book-orders': true },
            admin_modules: {}
        }
    },
    {
        role_name: 'job_support_desk',
        description: 'Staff — support tickets & applications',
        permissions: {
            version: PERM_VERSION,
            portal: 'staff',
            user_role: 'staff_user',
            staff_modules: { applications: true, 'support-tickets': true },
            admin_modules: {}
        }
    },
    {
        role_name: 'job_support_agent',
        description: 'Support agent — dedicated support desk portal',
        permissions: {
            version: PERM_VERSION,
            portal: 'support',
            user_role: 'support_agent',
            staff_modules: {
                'support-tickets': true,
                applications: true,
                payments: true,
                etickets: true
            },
            admin_modules: {}
        }
    },
    {
        role_name: 'job_judge',
        description: 'Judge — case review portal only',
        permissions: {
            version: PERM_VERSION,
            portal: 'judge',
            user_role: 'judge_user',
            staff_modules: {},
            admin_modules: {}
        }
    },
    {
        role_name: 'job_scanner',
        description: 'Scanner — entry scanning portal only',
        permissions: {
            version: PERM_VERSION,
            portal: 'scanner',
            user_role: 'scanner_portal_user',
            staff_modules: {},
            admin_modules: {}
        }
    }
];

function parsePermissions(raw) {
    if (!raw) return null;
    try {
        const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!o || typeof o !== 'object') return null;
        if (o.version === PERM_VERSION && o.portal) return o;
        if (o.staff_modules || o.admin_modules || o.portal) {
            return {
                version: PERM_VERSION,
                portal: o.portal || 'staff',
                user_role: o.user_role || 'staff_user',
                staff_modules: o.staff_modules || {},
                admin_modules: o.admin_modules || {}
            };
        }
        return null;
    } catch (_) {
        return null;
    }
}

function serializePermissions(perm) {
    return JSON.stringify(perm || {});
}

function rowToJobRole(row) {
    if (!row) return null;
    const perm = parsePermissions(row.permissions);
    return {
        id: row.id,
        role_name: row.role_name,
        description: row.description || '',
        portal: (perm && perm.portal) || 'staff',
        user_role: (perm && perm.user_role) || row.role_name,
        staff_modules: (perm && perm.staff_modules) || {},
        admin_modules: (perm && perm.admin_modules) || {},
        permissions: perm
    };
}

function applyJobRoleToUserPayload(jobRole) {
    const perm = jobRole && jobRole.permissions ? jobRole.permissions : parsePermissions(jobRole && jobRole.permissions);
    if (!perm) {
        return { user_role: jobRole && jobRole.user_role, staff_modules: null, admin_modules: null };
    }
    let staffMods = perm.staff_modules && typeof perm.staff_modules === 'object' ? { ...perm.staff_modules } : {};
    if (String(perm.user_role || '').toLowerCase() === 'co_admin') {
        const fromAdmin = adminModulesToStaffModules(perm.admin_modules || {});
        staffMods = { ...fromAdmin, ...staffMods };
    } else if (perm.admin_modules && Object.keys(perm.admin_modules).length && !Object.keys(staffMods).length) {
        staffMods = adminModulesToStaffModules(perm.admin_modules);
    }
    return {
        user_role: perm.user_role,
        staff_modules: Object.keys(staffMods).length ? JSON.stringify(staffMods) : null,
        admin_modules:
            perm.user_role === 'co_admin' && perm.admin_modules && Object.keys(perm.admin_modules).length
                ? JSON.stringify(perm.admin_modules)
                : null
    };
}

function ensureDefaultJobRoles(db, cb) {
    let left = DEFAULT_JOB_ROLES.length;
    if (!left) return cb && cb(null);
    DEFAULT_JOB_ROLES.forEach((def) => {
        const payload = serializePermissions(def.permissions);
        db.run(
            `INSERT INTO user_roles (role_name, description, permissions)
             VALUES (?, ?, ?)
             ON CONFLICT (role_name) DO NOTHING`,
            [def.role_name, def.description, payload],
            () => {
                left -= 1;
                if (left <= 0 && cb) cb(null);
            }
        );
    });
}

function syncFullCoAdminJobRoleTemplate(db, cb) {
    db.run(
        `UPDATE user_roles SET description = ?, permissions = ? WHERE role_name = ?`,
        [
            'Co-admin — full admin & staff portal',
            serializePermissions(fullCoAdminPermissions()),
            'job_co_admin_full'
        ],
        (err) => cb && cb(err)
    );
}

/** SQLite lacks ON CONFLICT on role_name unless UNIQUE — use INSERT OR IGNORE fallback. */
function ensureDefaultJobRolesSafe(db, cb) {
    db.all(`SELECT role_name FROM user_roles`, [], (err, rows) => {
        if (err) return cb && cb(err);
        const existing = new Set((rows || []).map((r) => String(r.role_name || '').toLowerCase()));
        const todo = DEFAULT_JOB_ROLES.filter((d) => !existing.has(d.role_name.toLowerCase()));
        const afterSeed = () => {
            syncFullCoAdminJobRoleTemplate(db, cb);
        };
        if (!todo.length) return afterSeed();
        let left = todo.length;
        todo.forEach((def) => {
            db.run(
                `INSERT INTO user_roles (role_name, description, permissions) VALUES (?, ?, ?)`,
                [def.role_name, def.description, serializePermissions(def.permissions)],
                () => {
                    left -= 1;
                    if (left <= 0) afterSeed();
                }
            );
        });
    });
}

module.exports = {
    PERM_VERSION,
    STAFF_MODULE_DEFS,
    CO_ADMIN_FULL_ADMIN_TAB_IDS,
    DEFAULT_JOB_ROLES,
    fullCoAdminStaffModules,
    fullCoAdminAdminModules,
    fullCoAdminPermissions,
    parsePermissions,
    serializePermissions,
    rowToJobRole,
    applyJobRoleToUserPayload,
    syncFullCoAdminJobRoleTemplate,
    ensureDefaultJobRolesSafe
};
