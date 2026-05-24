/**
 * Public portal auth & OTP policy (global_settings.portal_auth_config).
 * Env overrides: REQUIRE_SIGNUP_OTP / REQUIRE_LOGIN_OTP = '0' | '1'
 */
const KEY = 'portal_auth_config';

/** Public website main navigation (data-nav-section / data-menu-key on index.html). */
const WEBSITE_MENU_PAGE_DEFS = [
    ['home', 'Home'],
    ['about', 'Foundation'],
    ['schedule', 'Agenda'],
    ['gallery', 'Gallery'],
    ['verify', 'Delegates (participant search)'],
    ['certificate', 'Certificate verification'],
    ['contact', 'Contact']
];

const DEFAULTS = {
    showSignup: true,
    showLogin: true,
    requireSignupOtp: true,
    requireLoginOtp: true,
    requireEmailVerification: false,
    requireAdminOtpForSensitive: false,
    requireBehalfApplicantOtp: true,
    adminEnabledPages: {},
    websiteMenuPages: {}
};

/** Staff portals never use email/phone login OTP (password only). */
const STAFF_LOGIN_PORTALS = new Set(['admin', 'judge', 'scanner']);

/** CRM staff account roles (not doctor portal delegates). */
const STAFF_USER_ROLES = new Set([
    'co_admin',
    'judge_user',
    'scanner_portal_user',
    'scanner_dashboard_user',
    'reviewer'
]);

let cache = { ...DEFAULTS };

function merge(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    const pages =
        o.adminEnabledPages && typeof o.adminEnabledPages === 'object' && !Array.isArray(o.adminEnabledPages)
            ? o.adminEnabledPages
            : {};
    const menuPages =
        o.websiteMenuPages && typeof o.websiteMenuPages === 'object' && !Array.isArray(o.websiteMenuPages)
            ? o.websiteMenuPages
            : {};
    return {
        showSignup: o.showSignup !== false,
        showLogin: o.showLogin !== false,
        requireSignupOtp: o.requireSignupOtp !== false,
        requireLoginOtp: o.requireLoginOtp !== false,
        requireEmailVerification: !!o.requireEmailVerification,
        requireAdminOtpForSensitive: !!o.requireAdminOtpForSensitive,
        requireBehalfApplicantOtp: o.requireBehalfApplicantOtp !== false,
        adminEnabledPages: pages,
        websiteMenuPages: menuPages
    };
}

/** If any admin page is explicitly enabled, only those tabs show; empty config = all tabs. */
function adminTabGloballyEnabled(tabId) {
    const pages = cache.adminEnabledPages || {};
    const keys = Object.keys(pages);
    if (!keys.length) return true;
    const anyOn = keys.some((k) => pages[k] === true);
    if (!anyOn) return true;
    return pages[tabId] === true;
}

function loadPortalAuthConfig(db, cb) {
    if (!db) {
        cache = { ...DEFAULTS };
        return cb && cb(null, cache);
    }
    db.get(`SELECT value FROM global_settings WHERE key = ?`, [KEY], (err, row) => {
        if (err) {
            cache = { ...DEFAULTS };
            return cb && cb(err, cache);
        }
        let parsed = {};
        if (row && row.value) {
            try {
                parsed = JSON.parse(row.value) || {};
            } catch (_) {
                parsed = {};
            }
        }
        cache = merge(parsed);
        cb && cb(null, cache);
    });
}

function getPortalAuthConfig() {
    return { ...cache };
}

function normalizeLoginPortal(portal) {
    const p = String(portal || '')
        .trim()
        .toLowerCase();
    if (STAFF_LOGIN_PORTALS.has(p)) return p;
    if (p === 'doctor' || p === 'public' || p === 'homepage' || p === 'main') return 'public';
    return 'public';
}

function isStaffPortal(portal) {
    return STAFF_LOGIN_PORTALS.has(normalizeLoginPortal(portal));
}

function isStaffUserRole(userRole) {
    const ur = String(userRole || '')
        .trim()
        .toLowerCase();
    if (!ur || ur === 'doctor') return false;
    return STAFF_USER_ROLES.has(ur) || ur === 'admin';
}

/** True for co-admin, judge, scanner, reviewer, and super-admin accounts. */
function isStaffPortalAccount(row) {
    if (!row) return false;
    const ur = String(row.user_role || '')
        .trim()
        .toLowerCase();
    if (ur && ur !== 'doctor') return true;
    return String(row.role || '')
        .trim()
        .toLowerCase() === 'admin';
}

function signupOtpRequired() {
    if (process.env.REQUIRE_SIGNUP_OTP === '0') return false;
    if (process.env.REQUIRE_SIGNUP_OTP === '1') return true;
    return cache.requireSignupOtp !== false;
}

function loginOtpRequired() {
    if (process.env.REQUIRE_LOGIN_OTP === '0') return false;
    if (process.env.REQUIRE_LOGIN_OTP === '1') return true;
    return cache.requireLoginOtp !== false;
}

function behalfApplicantOtpRequired() {
    return cache.requireBehalfApplicantOtp !== false;
}

function loginOtpRequiredForPortal(portal) {
    if (isStaffPortal(portal)) return false;
    return loginOtpRequired();
}

function websiteMenuPageEnabled(key) {
    const pages = cache.websiteMenuPages || {};
    const keys = Object.keys(pages);
    if (!keys.length) return true;
    const anyOn = keys.some((k) => pages[k] === true);
    if (!anyOn) return true;
    return pages[key] === true;
}

function publicPortalAuthPayload() {
    const c = getPortalAuthConfig();
    return {
        showSignup: !!c.showSignup,
        showLogin: !!c.showLogin,
        requireSignupOtp: signupOtpRequired(),
        requireLoginOtp: loginOtpRequired(),
        requireEmailVerification: !!c.requireEmailVerification,
        staffLoginOtp: false,
        websiteMenuPages: c.websiteMenuPages || {},
        websiteMenuPageDefs: WEBSITE_MENU_PAGE_DEFS
    };
}

module.exports = {
    KEY,
    DEFAULTS,
    WEBSITE_MENU_PAGE_DEFS,
    STAFF_LOGIN_PORTALS,
    STAFF_USER_ROLES,
    loadPortalAuthConfig,
    getPortalAuthConfig,
    normalizeLoginPortal,
    isStaffPortal,
    isStaffUserRole,
    isStaffPortalAccount,
    signupOtpRequired,
    loginOtpRequired,
    loginOtpRequiredForPortal,
    behalfApplicantOtpRequired,
    publicPortalAuthPayload,
    adminTabGloballyEnabled,
    websiteMenuPageEnabled,
    merge
};
