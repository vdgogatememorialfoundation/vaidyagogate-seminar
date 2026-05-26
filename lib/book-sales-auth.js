/**
 * Book sales API access — super-admin, co-admin (book tab), book_sales_staff.
 */
const { safeInternalUserRowId } = require('./internal-user-id');
const { effectiveUserRole } = require('./user-roles');

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

function staffModuleEnabled(user, moduleId) {
    const mods = parseModulesJson(user.staff_modules);
    const keys = Object.keys(mods);
    if (!keys.length) return true;
    return mods[moduleId] === true;
}

function canAccessBookSales(user) {
    if (!user) return false;
    const ur = effectiveUserRole(user);
    const r = String(user.role || '').toLowerCase();
    if (r === 'admin' && ur !== 'co_admin') return true;
    if (ur === 'co_admin') return true;
    if (ur === 'book_sales_staff') return true;
    return false;
}

function canAccessBookInventory(user) {
    if (!canAccessBookSales(user)) return false;
    const ur = effectiveUserRole(user);
    if (ur === 'book_sales_staff') return staffModuleEnabled(user, STAFF_MODULE_INVENTORY);
    return true;
}

function canAccessBookOrders(user) {
    if (!canAccessBookSales(user)) return false;
    const ur = effectiveUserRole(user);
    if (ur === 'book_sales_staff') return staffModuleEnabled(user, STAFF_MODULE_ORDERS);
    return true;
}

/** Book catalog, logistics API keys — admins only, not book_sales_staff. */
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

function requireBookSalesActor(db, opts, handler) {
    const needInventory = opts && opts.inventory;
    const needOrders = opts && opts.orders;
    const needConfig = opts && opts.config;
    return (req, res) => {
        const actorId = readActorId(req);
        if (!actorId) return res.status(401).json({ error: 'Sign in required. Send actingAdminId or actingStaffId.' });
        db.get(
            `SELECT id, role, user_role, admin_modules, staff_modules, first_name, last_name, email
             FROM users WHERE id = ? AND COALESCE(is_disabled,0) = 0 AND COALESCE(is_banned,0) = 0`,
            [actorId],
            (err, user) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!user) return res.status(401).json({ error: 'Invalid or disabled account' });
                if (!canAccessBookSales(user)) {
                    return res.status(403).json({ error: 'Your account cannot manage book sales.' });
                }
                if (needInventory && !canAccessBookInventory(user)) {
                    return res.status(403).json({ error: 'Book inventory access not enabled for this account.' });
                }
                if (needOrders && !canAccessBookOrders(user)) {
                    return res.status(403).json({ error: 'Book orders access not enabled for this account.' });
                }
                if (needConfig && !canManageBookSalesConfig(user)) {
                    return res.status(403).json({
                        error: 'Book sales settings are restricted to administrators.'
                    });
                }
                req.bookSalesActor = user;
                req.bookSalesActorId = actorId;
                handler(req, res);
            }
        );
    };
}

module.exports = {
    STAFF_MODULE_INVENTORY,
    STAFF_MODULE_ORDERS,
    parseModulesJson,
    staffModuleEnabled,
    canAccessBookSales,
    canAccessBookInventory,
    canAccessBookOrders,
    canManageBookSalesConfig,
    readActorId,
    requireBookSalesActor
};
