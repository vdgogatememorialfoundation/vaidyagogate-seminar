/**
 * Public portal auth & OTP policy (global_settings.portal_auth_config).
 * Env overrides: REQUIRE_SIGNUP_OTP / REQUIRE_LOGIN_OTP = '0' | '1'
 */
const KEY = 'portal_auth_config';

const DEFAULTS = {
    showSignup: true,
    showLogin: true,
    requireSignupOtp: true,
    requireLoginOtp: true,
    requireEmailVerification: false,
    requireAdminOtpForSensitive: false
};

let cache = { ...DEFAULTS };

function merge(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    return {
        showSignup: o.showSignup !== false,
        showLogin: o.showLogin !== false,
        requireSignupOtp: o.requireSignupOtp !== false,
        requireLoginOtp: o.requireLoginOtp !== false,
        requireEmailVerification: !!o.requireEmailVerification,
        requireAdminOtpForSensitive: !!o.requireAdminOtpForSensitive
    };
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

function publicPortalAuthPayload() {
    const c = getPortalAuthConfig();
    return {
        showSignup: !!c.showSignup,
        showLogin: !!c.showLogin,
        requireSignupOtp: signupOtpRequired(),
        requireLoginOtp: loginOtpRequired(),
        requireEmailVerification: !!c.requireEmailVerification
    };
}

module.exports = {
    KEY,
    DEFAULTS,
    loadPortalAuthConfig,
    getPortalAuthConfig,
    signupOtpRequired,
    loginOtpRequired,
    publicPortalAuthPayload,
    merge
};
