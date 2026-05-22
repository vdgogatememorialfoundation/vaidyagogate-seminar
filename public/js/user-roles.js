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

    function effectiveUserRole(row) {
        if (!row) return '';
        const ur = normalizeUserRole(row.user_role);
        const r = normalizeUserRole(row.role);
        if (ur && ur !== 'doctor' && ur !== 'event_attendee') return ur;
        if (STAFF_USER_ROLES.has(r) || ADMIN_CREATABLE_STAFF_ROLES.some((s) => s === r)) return r;
        return ur || r || '';
    }

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
        effectiveUserRole,
        isStaffPortalAccount,
        isDoctorPortalAccount,
        roleColumnForUserRole
    };
})(typeof window !== 'undefined' ? window : global);
