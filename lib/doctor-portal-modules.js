/**
 * Doctor portal sidebar modules — global defaults + per-user overrides.
 */
const TAB_DEFS = [
    ['tab-dashboard', 'Dashboard'],
    ['tab-profile', 'My profile'],
    ['tab-seminars', 'Available seminars (registration form)'],
    ['tab-applications', 'Track seminar applications'],
    ['tab-abstract', 'Case presentation'],
    ['tab-case-track', 'Track case applications'],
    ['tab-volunteer', 'Volunteer'],
    ['tab-feedback', 'Seminar feedback'],
    ['tab-support', 'Support tickets'],
    ['tab-orders', 'Orders'],
    ['tab-receipts', 'Receipts'],
    ['tab-payments', 'Payments'],
    ['tab-books', 'Book orders (Agnikarma / Viddhakarma)'],
    ['tab-ticket', 'Participant tickets'],
    ['tab-certificate', 'Certificates'],
    ['tab-reset-pwd', 'Change password']
];

const KNOWN_TABS = new Set(TAB_DEFS.map((d) => d[0]));

const DEFAULT_VOLUNTEER_DOCTOR_MODULES = {
    'tab-dashboard': true,
    'tab-profile': true,
    'tab-seminars': true,
    'tab-applications': true,
    'tab-abstract': true,
    'tab-case-track': true,
    'tab-volunteer': true,
    'tab-ticket': true,
    'tab-certificate': true,
    'tab-reset-pwd': true
};

function parseModulesJson(raw) {
    if (raw == null || raw === '') return null;
    if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
    try {
        const o = JSON.parse(String(raw));
        return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
    } catch (_) {
        return null;
    }
}

function sanitizeModulesInput(raw) {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const out = {};
    Object.keys(src).forEach((k) => {
        if (KNOWN_TABS.has(k)) out[k] = !!src[k];
    });
    return out;
}

/** Whitelist semantics (same as admin sidebar): empty = all tabs; any true = only those tabs. */
function modulesMapToAllowedSet(modulesMap) {
    const m = sanitizeModulesInput(modulesMap || {});
    const keys = Object.keys(m);
    if (!keys.length) return null;
    const anyOn = keys.some((k) => m[k] === true);
    if (!anyOn) return null;
    return new Set(keys.filter((k) => m[k] === true));
}

function normalizeDoctorCategory(v) {
    return String(v == null ? '' : v)
        .trim()
        .toLowerCase() === 'volunteer'
        ? 'volunteer'
        : 'regular';
}

/**
 * Resolve which doctor portal tabs are visible.
 * @returns {Set<string>|null} null = all known tabs allowed
 */
function resolveDoctorAllowedTabs(category, globalRegular, globalVolunteer, userModulesRaw) {
    const cat = normalizeDoctorCategory(category);
    const globalMap = cat === 'volunteer' ? globalVolunteer : globalRegular;
    let allowed = modulesMapToAllowedSet(globalMap);

    let userMap = parseModulesJson(userModulesRaw);
    if (isLegacyVolunteerDefaultModules(userModulesRaw)) {
        userMap = null;
    }
    if (!userMap || !Object.keys(userMap).length) {
        return allowed;
    }

    const userSan = sanitizeModulesInput(userMap);
    const userKeys = Object.keys(userSan);
    if (!userKeys.length) return allowed;

    const hasExplicitOff = userKeys.some((k) => userSan[k] === false);
    if (!hasExplicitOff) {
        return modulesMapToAllowedSet(userSan);
    }

    const out = new Set();
    TAB_DEFS.forEach(([tabId]) => {
        if (userSan[tabId] === true) {
            out.add(tabId);
            return;
        }
        if (userSan[tabId] === false) return;
        if (allowed === null || allowed.has(tabId)) out.add(tabId);
    });
    return out.size ? out : new Set();
}

function tabAllowed(allowedSet, tabId) {
    if (!allowedSet) return true;
    return allowedSet.has(tabId);
}

function effectiveModulesForAdminDisplay(category, globalRegular, globalVolunteer, userModulesRaw) {
    const allowed = resolveDoctorAllowedTabs(category, globalRegular, globalVolunteer, userModulesRaw);
    const out = {};
    TAB_DEFS.forEach(([id]) => {
        out[id] = tabAllowed(allowed, id);
    });
    return out;
}

/** Legacy volunteer onboarding stored a fixed whitelist that overrides global volunteer policy. */
function isLegacyVolunteerDefaultModules(userModulesRaw) {
    const userMap = parseModulesJson(userModulesRaw);
    if (!userMap) return false;
    const san = sanitizeModulesInput(userMap);
    const defaultKeys = Object.keys(DEFAULT_VOLUNTEER_DOCTOR_MODULES);
    const enabledKeys = defaultKeys.filter((k) => san[k] === true);
    if (enabledKeys.length !== defaultKeys.length) return false;
    const extraOn = Object.keys(san).some((k) => san[k] === true && !DEFAULT_VOLUNTEER_DOCTOR_MODULES[k]);
    return !extraOn;
}

function userHasCustomModules(userModulesRaw) {
    if (isLegacyVolunteerDefaultModules(userModulesRaw)) return false;
    const userMap = parseModulesJson(userModulesRaw);
    return !!(userMap && Object.keys(userMap).length);
}

module.exports = {
    TAB_DEFS,
    KNOWN_TABS,
    DEFAULT_VOLUNTEER_DOCTOR_MODULES,
    parseModulesJson,
    sanitizeModulesInput,
    modulesMapToAllowedSet,
    normalizeDoctorCategory,
    resolveDoctorAllowedTabs,
    tabAllowed,
    effectiveModulesForAdminDisplay,
    userHasCustomModules,
    isLegacyVolunteerDefaultModules
};
