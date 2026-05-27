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

function coAdminAllowedTabIds(user) {
    const ur = String((user && user.user_role) || '').toLowerCase();
    if (ur !== 'co_admin') return null;
    const { unset, mods } = coAdminModulesState(user);
    if (unset) return null;
    return Object.keys(mods).filter((k) => mods[k] === true);
}

module.exports = {
    coAdminModulesState,
    coAdminAllowedTabIds
};
