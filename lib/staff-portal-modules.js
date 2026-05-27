/**
 * Staff portal sections — driven by staff_modules (all roles) with admin_modules fallback for co-admin.
 */
const { effectiveUserRole } = require('./user-roles');
const { STAFF_PORTAL_SECTION_DEFS } = require('./staff-portal-defs');
const { parseModulesJson, adminModulesToStaffModules } = require('./staff-portal-sync');

function resolveFromStaffModuleKeys(staffMods) {
    const sections = {};
    const keys = Object.keys(staffMods);
    const unrestricted = keys.length === 0;
    STAFF_PORTAL_SECTION_DEFS.forEach((d) => {
        if (unrestricted) {
            sections[d.id] = false;
            return;
        }
        if (d.staffKey === 'book-inventory' || d.staffKey === 'book-orders') {
            sections[d.id] = staffMods['book-inventory'] === true || staffMods['book-orders'] === true;
        } else {
            sections[d.id] = staffMods[d.staffKey] === true;
        }
    });
    if (staffMods['tab-book-sales'] === true) {
        sections.inventory = true;
        sections['book-orders'] = true;
    }
    return sections;
}

function resolveStaffPortalSections(user) {
    const sections = {};
    STAFF_PORTAL_SECTION_DEFS.forEach((d) => {
        sections[d.id] = false;
    });
    if (!user) return sections;

    const ur = effectiveUserRole(user);
    const roleCol = String(user.role || '').toLowerCase();
    const isSuperAdmin = roleCol === 'admin' && ur !== 'co_admin';

    if (isSuperAdmin) {
        STAFF_PORTAL_SECTION_DEFS.forEach((d) => {
            sections[d.id] = true;
        });
        return sections;
    }

    if (ur === 'co_admin') {
        const adminRaw = user.admin_modules;
        const adminMods = parseModulesJson(adminRaw);
        const adminKeys = Object.keys(adminMods);
        const unrestricted =
            adminRaw == null || (typeof adminRaw === 'string' && !String(adminRaw).trim());
        if (unrestricted) {
            STAFF_PORTAL_SECTION_DEFS.forEach((d) => {
                sections[d.id] = true;
            });
            return sections;
        }
        if (!adminKeys.length) {
            return sections;
        }
        return resolveFromStaffModuleKeys(adminModulesToStaffModules(adminMods));
    }

    const staffMods = parseModulesJson(user.staff_modules);
    const staffKeys = Object.keys(staffMods);

    if (staffKeys.length) {
        return resolveFromStaffModuleKeys(staffMods);
    }

    if (ur === 'book_sales_staff') {
        sections.inventory = true;
        sections['book-orders'] = true;
        return sections;
    }

    return sections;
}

function staffPortalSectionList(sections) {
    return STAFF_PORTAL_SECTION_DEFS.filter((d) => sections && sections[d.id]).map((d) => ({
        id: d.id,
        label: d.label
    }));
}

module.exports = {
    STAFF_PORTAL_SECTION_DEFS,
    parseModulesJson,
    resolveStaffPortalSections,
    staffPortalSectionList
};
