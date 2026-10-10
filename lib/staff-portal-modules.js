/**
 * Staff portal sections — driven by staff_modules (all roles) with admin_modules fallback for co-admin.
 */
const { effectiveUserRole, DESK_STAFF_MODULES } = require('./user-roles');
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
    if (ur === 'desk_staff') {
        return hideCommerceFromStaff(user, resolveFromStaffModuleKeys(staffKeys.length ? staffMods : DESK_STAFF_MODULES));
    }

    if (staffKeys.length) {
        return hideCommerceFromStaff(user, resolveFromStaffModuleKeys(staffMods));
    }

    if (ur === 'book_sales_staff') {
        return sections;
    }

    return sections;
}

function hideCommerceFromStaff(user, sections) {
    if (!user) return sections;
    const ur = effectiveUserRole(user);
    const roleCol = String(user.role || '').toLowerCase();
    const isSuperAdmin = roleCol === 'admin' && ur !== 'co_admin';
    if (isSuperAdmin || ur === 'co_admin') return sections;
    sections.inventory = false;
    sections['book-orders'] = false;
    return sections;
}

function staffPortalSectionList(sections) {
    return STAFF_PORTAL_SECTION_DEFS.filter((d) => sections && sections[d.id]).map((d) => ({
        id: d.id,
        label: d.label
    }));
}

/** Admin modules (tab-* keys in staff_modules) that have no native staff panel; opened at /staff/crm#tab. */
function staffPortalCrmSectionList(user) {
    if (!user) return [];
    const ur = effectiveUserRole(user);
    if (ur === 'co_admin' || String(user.role || '').toLowerCase() === 'admin') return [];
    const stored = parseModulesJson(user.staff_modules);
    const mods = Object.keys(stored).length ? stored : ur === 'desk_staff' ? DESK_STAFF_MODULES : {};
    const nativeAdminKeys = new Set(STAFF_PORTAL_SECTION_DEFS.map((d) => d.adminKey));
    const defs = require('../public/js/admin-module-defs');
    return defs
        .filter((d) => mods[d.id] === true && !nativeAdminKeys.has(d.id))
        .map((d) => ({ id: d.id, label: d.label, crm: true }));
}

module.exports = {
    STAFF_PORTAL_SECTION_DEFS,
    parseModulesJson,
    resolveStaffPortalSections,
    staffPortalSectionList,
    staffPortalCrmSectionList
};
