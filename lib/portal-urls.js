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
    hostMatches
};
