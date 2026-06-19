/**
 * Multi-subdomain portal URLs (Wix main site + seminar/admin/judge on VPS).
 */
const integrationSettings = require('./integration-settings');

const DEFAULTS = {
    seminarHost: 'seminar.vaidyagogate.org',
    adminHost: 'admin.vaidyagogate.org',
    judgeHost: 'judge.vaidyagogate.org',
    wixSiteUrl: 'https://www.vaidyagogate.org'
};

function hostFromEnv(key, fallback) {
    const v = process.env[key];
    return v && String(v).trim() ? String(v).trim().toLowerCase() : fallback;
}

function scheme() {
    return process.env.PORTAL_SCHEME === 'http' ? 'http' : 'https';
}

function originForHost(host) {
    return `${scheme()}://${host}`;
}

function getHosts() {
    const rt = integrationSettings.getRuntimeIntegrations();
    return {
        seminar: (rt.seminar_host || hostFromEnv('SEMINAR_HOST', DEFAULTS.seminarHost)).toLowerCase(),
        admin: (rt.admin_host || hostFromEnv('ADMIN_HOST', DEFAULTS.adminHost)).toLowerCase(),
        judge: (rt.judge_host || hostFromEnv('JUDGE_HOST', DEFAULTS.judgeHost)).toLowerCase(),
        wix: rt.wix_site_url || process.env.WIX_SITE_URL || DEFAULTS.wixSiteUrl
    };
}

function getPortalUrls() {
    const hosts = getHosts();
    const production = require('./hosting').isProduction();
    const seminarOrigin =
        integrationSettings.getPublicBaseUrl() || originForHost(hosts.seminar);
    const sem = seminarOrigin.replace(/\/$/, '');
    const allowDemoAccounts = process.env.DISABLE_DEMO_ACCOUNTS !== '1';
    return {
        seminar: sem,
        admin: `${sem}/admin`,
        judge: `${sem}/judge`,
        doctor: `${sem}/doctor`,
        scanner: `${sem}/scanner`,
        staff: `${sem}/staff/login`,
        staffCrm: `${sem}/staff/crm`,
        adminHostLegacy: originForHost(hosts.admin),
        judgeHostLegacy: originForHost(hosts.judge),
        wix: hosts.wix,
        hosts,
        production,
        allowDemoAccounts
    };
}

function portalLoginUrl() {
    return getPortalUrls().doctor;
}

/** Login URL + labels for welcome / account-created emails based on user_role. */
function resolveAccountPortal(user) {
    const userRoles = require('./user-roles');
    const urls = getPortalUrls();
    if (!user) {
        return {
            url: urls.doctor,
            name: 'Doctor portal',
            buttonLabel: 'Open doctor portal',
            blurb: 'You can complete seminar registrations, case presentations, and payments from the doctor portal.'
        };
    }
    const eff = userRoles.effectiveUserRole(user);
    if (eff === 'judge_user') {
        return {
            url: urls.judge,
            name: 'Judge portal',
            buttonLabel: 'Open judge portal',
            blurb: 'Sign in to review and score case presentations assigned to you.'
        };
    }
    if (eff === 'scanner_portal_user' || eff === 'scanner_dashboard_user' || eff === 'venue_gate_user') {
        return {
            url: urls.scanner,
            name: 'Scanner portal',
            buttonLabel: 'Open scanner portal',
            blurb: 'Sign in to scan e-tickets and manage venue check-in.'
        };
    }
    if (eff === 'co_admin' || eff === 'admin') {
        return {
            url: urls.admin,
            name: 'Admin portal',
            buttonLabel: 'Open admin portal',
            blurb: 'Sign in to manage seminars, applications, payments, and reports.'
        };
    }
    if (eff === 'book_sales_staff') {
        return {
            url: urls.staff,
            name: 'Staff portal (book sales)',
            buttonLabel: 'Open staff portal',
            blurb: 'Sign in to manage book inventory and orders.'
        };
    }
    if (userRoles.isStaffPortalAccount(user)) {
        return {
            url: urls.staff,
            name: 'Staff portal',
            buttonLabel: 'Open staff portal',
            blurb: 'Sign in with your email and temporary password, then change your password after first login.'
        };
    }
    return {
        url: urls.doctor,
        name: 'Doctor portal',
        buttonLabel: 'Open doctor portal',
        blurb: 'You can complete seminar registrations, case presentations, and payments from the doctor portal.'
    };
}

function hostMatches(req, hostKey) {
    const hosts = getHosts();
    const reqHost = String(req.hostname || (req.headers.host || '').split(':')[0]).toLowerCase();
    return reqHost === hosts[hostKey];
}

module.exports = {
    DEFAULTS,
    getHosts,
    getPortalUrls,
    portalLoginUrl,
    resolveAccountPortal,
    hostMatches
};
