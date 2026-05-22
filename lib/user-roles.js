/**
 * Shared doctor vs staff account classification (admin CRM, auth, portals).
 */
const STAFF_USER_ROLES = new Set([
    'co_admin',
    'judge_user',
    'scanner_portal_user',
    'scanner_dashboard_user',
    'reviewer',
    'admin'
]);

const ADMIN_CREATABLE_STAFF_ROLES = [
    'judge_user',
    'co_admin',
    'scanner_portal_user',
    'scanner_dashboard_user',
    'reviewer'
];

function normalizeUserRole(userRole) {
    return String(userRole || '')
        .trim()
        .toLowerCase();
}

/** Prefer user_role; fall back to legacy values stored in role column. */
function effectiveUserRole(row) {
    if (!row) return '';
    const ur = normalizeUserRole(row.user_role);
    const r = normalizeUserRole(row.role);
    if (ur && ur !== 'doctor' && ur !== 'event_attendee') return ur;
    if (STAFF_USER_ROLES.has(r) || ADMIN_CREATABLE_STAFF_ROLES.some((s) => s === r)) return r;
    return ur || r || '';
}

/** Staff portal roles may appear in either user_role or legacy role column. */
function isStaffPortalAccount(row) {
    if (!row) return false;
    const ur = normalizeUserRole(row.user_role);
    const r = normalizeUserRole(row.role);
    const eff = effectiveUserRole(row);
    if (STAFF_USER_ROLES.has(ur) || STAFF_USER_ROLES.has(r) || STAFF_USER_ROLES.has(eff)) return true;
    if (ADMIN_CREATABLE_STAFF_ROLES.some((s) => s === ur || s === r || s === eff)) return true;
    if (r === 'admin' && ur && ur !== 'doctor') return true;
    if (!ur && r === 'admin') return true;
    return false;
}

/** True for doctor / delegate portal accounts (shown under Doctors in admin). */
function isDoctorPortalAccount(row) {
    if (!row) return false;
    if (isStaffPortalAccount(row)) return false;
    const ur = normalizeUserRole(row.user_role);
    const r = normalizeUserRole(row.role);
    if (ur === 'doctor' || ur === 'event_attendee') return true;
    return r === 'doctor' && !ur;
}

function roleColumnForUserRole(userRole) {
    const ur = normalizeUserRole(userRole);
    if (ur === 'co_admin' || ur === 'admin') return 'admin';
    return 'doctor';
}

function isStaffUserRole(userRole) {
    return !isDoctorPortalAccount({ user_role: userRole, role: roleColumnForUserRole(userRole) });
}

module.exports = {
    STAFF_USER_ROLES,
    ADMIN_CREATABLE_STAFF_ROLES,
    normalizeUserRole,
    effectiveUserRole,
    isStaffPortalAccount,
    isDoctorPortalAccount,
    roleColumnForUserRole,
    isStaffUserRole
};
