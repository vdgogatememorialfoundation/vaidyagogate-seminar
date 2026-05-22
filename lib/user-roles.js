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

/** True for doctor / delegate portal accounts (shown under Doctors in admin). */
function isDoctorPortalAccount(row) {
    if (!row) return false;
    const ur = normalizeUserRole(row.user_role);
    const r = normalizeUserRole(row.role);
    if (STAFF_USER_ROLES.has(ur)) return false;
    if (r === 'admin' && ur !== 'doctor') return false;
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
    isDoctorPortalAccount,
    roleColumnForUserRole,
    isStaffUserRole
};
