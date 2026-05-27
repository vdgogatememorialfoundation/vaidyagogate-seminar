/**
 * Book sales + staff portal API access.
 */
const { safeInternalUserRowId } = require('./internal-user-id');
const { effectiveUserRole } = require('./user-roles');
const { resolveStaffPortalSections } = require('./staff-portal-modules');
const { canUseStaffPortal } = require('./staff-portal-access');

const STAFF_MODULE_INVENTORY = 'book-inventory';
const STAFF_MODULE_ORDERS = 'book-orders';

function parseModulesJson(raw) {
    if (!raw) return {};
    try {
        const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
    } catch (_) {
        return {};
    }
}

function staffSections(user) {
    return resolveStaffPortalSections(user);
}

function canAccessStaffSection(user, sectionId) {
    if (!user) return false;
    const ur = effectiveUserRole(user);
    const r = String(user.role || '').toLowerCase();
    if (r === 'admin' && ur !== 'co_admin') return true;
    if (!canAccessBookSales(user)) return false;
    return !!staffSections(user)[sectionId];
}

function canAccessBookSales(user) {
    return canUseStaffPortal(user);
}

function canAccessBookInventory(user) {
    return canAccessStaffSection(user, 'inventory');
}

function canAccessBookOrders(user) {
    return canAccessStaffSection(user, 'book-orders');
}

function canManageBookSalesConfig(user) {
    if (!canAccessBookSales(user)) return false;
    const ur = effectiveUserRole(user);
    return ur !== 'book_sales_staff';
}

function readActorId(req) {
    const fromHeader = req.headers && req.headers['x-acting-user-id'];
    const body = req.body || {};
    return safeInternalUserRowId(
        fromHeader || body.actingAdminId || body.actingStaffId || body.staffUserId || body.adminUserId
    );
}

function loadStaffActor(db, actorId, cb) {
    db.get(
        `SELECT id, role, user_role, admin_modules, staff_modules, first_name, last_name, email, phone
         FROM users WHERE id = ? AND COALESCE(is_disabled,0) = 0 AND COALESCE(is_banned,0) = 0`,
        [actorId],
        cb
    );
}

function requireBookSalesActor(db, opts, handler) {
    const needInventory = opts && opts.inventory;
    const needOrders = opts && opts.orders;
    const needConfig = opts && opts.config;
    const needSection = opts && opts.section;
    return (req, res) => {
        const actorId = readActorId(req);
        if (!actorId) return res.status(401).json({ error: 'Sign in required. Send actingAdminId or actingStaffId.' });
        loadStaffActor(db, actorId, (err, user) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!user) return res.status(401).json({ error: 'Invalid or disabled account' });
            if (!canAccessBookSales(user)) {
                return res.status(403).json({ error: 'Your account cannot use the staff portal.' });
            }
            if (needSection && !canAccessStaffSection(user, needSection)) {
                return res.status(403).json({ error: 'This module is not enabled for your account.' });
            }
            if (needInventory && !canAccessBookInventory(user)) {
                return res.status(403).json({ error: 'Book inventory access not enabled for this account.' });
            }
            if (needOrders && !canAccessBookOrders(user)) {
                return res.status(403).json({ error: 'Book orders access not enabled for this account.' });
            }
            if (needConfig && !canManageBookSalesConfig(user)) {
                return res.status(403).json({ error: 'Book sales settings are restricted to administrators.' });
            }
            req.bookSalesActor = user;
            req.bookSalesActorId = actorId;
            req.staffPortalSections = staffSections(user);
            handler(req, res);
        });
    };
}

module.exports = {
    STAFF_MODULE_INVENTORY,
    STAFF_MODULE_ORDERS,
    parseModulesJson,
    staffSections,
    canAccessStaffSection,
    canAccessBookSales,
    canAccessBookInventory,
    canAccessBookOrders,
    canManageBookSalesConfig,
    readActorId,
    loadStaffActor,
    requireBookSalesActor
};
