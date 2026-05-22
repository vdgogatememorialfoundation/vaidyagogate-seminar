/**
 * Browser mirror of lib/user-roles.js (keep in sync).
 */
(function (global) {
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

    function isStaffPortalAccount(row) {
        if (!row) return false;
        const ur = normalizeUserRole(row.user_role);
        const r = normalizeUserRole(row.role);
        if (STAFF_USER_ROLES.has(ur) || STAFF_USER_ROLES.has(r)) return true;
        if (ADMIN_CREATABLE_STAFF_ROLES.some((s) => s === ur || s === r)) return true;
        if (r === 'admin' && ur !== 'doctor') return true;
        return false;
    }

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

    global.UserRoles = {
        STAFF_USER_ROLES,
        ADMIN_CREATABLE_STAFF_ROLES,
        normalizeUserRole,
        isStaffPortalAccount,
        isDoctorPortalAccount,
        roleColumnForUserRole
    };
})(typeof window !== 'undefined' ? window : global);
