/**
 * Co-admin admin_modules parsing (server + shared with client logic).
 */
const { parseModulesJson } = require('./staff-portal-sync');

function coAdminModulesState(user) {
    if (!user) return { unset: true, mods: {} };
    const raw = user.admin_modules;
    if (raw == null || (typeof raw === 'string' && !String(raw).trim())) {
        return { unset: true, mods: {} };
    }
    const mods = parseModulesJson(raw);
    return { unset: false, mods };
}

const STAFF_CRM_ROLES = new Set(['staff_user', 'book_sales_staff']);

/** Staff users reach the admin CRM (/staff/crm) only for tabs mapped from their staff_modules. */
function isStaffCrmUser(user) {
    const ur = String((user && user.user_role) || '').toLowerCase();
    const r = String((user && user.role) || '').toLowerCase();
    return r !== 'admin' && STAFF_CRM_ROLES.has(ur);
}

function staffCrmAllowedTabIds(user) {
    if (!isStaffCrmUser(user)) return [];
    const { staffModulesToAdminModules } = require('./staff-portal-sync');
    const mods = staffModulesToAdminModules(user.staff_modules);
    return Object.keys(mods).filter((k) => mods[k] === true);
}

function coAdminAllowedTabIds(user) {
    const ur = String((user && user.user_role) || '').toLowerCase();
    if (isStaffCrmUser(user)) return staffCrmAllowedTabIds(user);
    if (ur !== 'co_admin') return null;
    const { unset, mods } = coAdminModulesState(user);
    if (unset) return null;
    return Object.keys(mods).filter((k) => mods[k] === true);
}

module.exports = {
    isStaffCrmUser,
    staffCrmAllowedTabIds,
    coAdminModulesState,
    coAdminAllowedTabIds
};
