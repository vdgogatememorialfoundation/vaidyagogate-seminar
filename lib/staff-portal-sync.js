/**
 * Sync admin_modules (co-admin sidebar) ↔ staff_modules (staff portal at /staff/login).
 */
const { STAFF_PORTAL_SECTION_DEFS } = require('./staff-portal-defs');

function parseModulesJson(raw) {
    if (!raw) return {};
    try {
        const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
    } catch (_) {
        return {};
    }
}

/** staff_modules keys from admin_modules tab ids. */
function adminModulesToStaffModules(adminMods) {
    const admin = parseModulesJson(adminMods);
    const staff = {};
    (STAFF_PORTAL_SECTION_DEFS || []).forEach((d) => {
        if (admin[d.adminKey] === true) {
            staff[d.staffKey] = true;
        }
    });
    if (admin['tab-book-sales'] === true) {
        staff['book-inventory'] = true;
        staff['book-orders'] = true;
    }
    return staff;
}

/** admin_modules tab ids from staff_modules keys (for co-admin sidebar sync). */
function staffModulesToAdminModules(staffMods) {
    const staff = parseModulesJson(staffMods);
    const admin = {};
    (STAFF_PORTAL_SECTION_DEFS || []).forEach((d) => {
        if (staff[d.staffKey] === true) {
            admin[d.adminKey] = true;
        }
    });
    if (staff['book-inventory'] === true || staff['book-orders'] === true) {
        admin['tab-book-sales'] = true;
    }
    return admin;
}

module.exports = {
    parseModulesJson,
    adminModulesToStaffModules,
    staffModulesToAdminModules
};
