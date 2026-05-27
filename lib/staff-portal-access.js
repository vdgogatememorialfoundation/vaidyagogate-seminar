/**
 * Who may use /staff/login and how modules resolve (job roles + staff_modules).
 */
const { effectiveUserRole } = require('./user-roles');
const { resolveStaffPortalSections, parseModulesJson } = require('./staff-portal-modules');

const STAFF_PORTAL_USER_ROLES = new Set(['co_admin', 'book_sales_staff', 'staff_user']);

const DEDICATED_PORTAL_ROLES = new Set([
    'judge_user',
    'reviewer',
    'scanner_portal_user',
    'scanner_dashboard_user'
]);

function usesDedicatedPortal(user) {
    const ur = effectiveUserRole(user);
    return DEDICATED_PORTAL_ROLES.has(ur);
}

function canUseStaffPortal(user) {
    if (!user) return false;
    if (usesDedicatedPortal(user)) return false;
    const ur = effectiveUserRole(user);
    const r = String(user.role || '').toLowerCase();
    if (r === 'admin' && ur !== 'co_admin') return true;
    if (STAFF_PORTAL_USER_ROLES.has(ur)) return true;
    const staffMods = parseModulesJson(user.staff_modules);
    return Object.keys(staffMods).some((k) => staffMods[k] === true);
}

function staffPortalSectionsForUser(user) {
    return resolveStaffPortalSections(user);
}

module.exports = {
    STAFF_PORTAL_USER_ROLES,
    DEDICATED_PORTAL_ROLES,
    usesDedicatedPortal,
    canUseStaffPortal,
    staffPortalSectionsForUser
};
