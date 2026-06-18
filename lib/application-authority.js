/**
 * Seminar application review authority — L1 frontline · L2 senior · L3 authority.
 * Separate from support-desk ticket authority.
 */
const supportAuthority = require('./support-authority');

const LEVELS = {
    1: { label: 'Frontline', short: 'L1', description: 'First review of seminar applications' },
    2: { label: 'Senior', short: 'L2', description: 'Complex cases and document disputes' },
    3: { label: 'Authority', short: 'L3', description: 'Final decisions on sensitive applications' }
};

function clampLevel(n) {
    return supportAuthority.clampLevel(n);
}

function levelLabel(level) {
    const lv = clampLevel(level);
    return (LEVELS[lv] && LEVELS[lv].label) || 'Level ' + lv;
}

function levelShort(level) {
    const lv = clampLevel(level);
    return (LEVELS[lv] && LEVELS[lv].short) || 'L' + lv;
}

function requiredLevelLabel(requiredLevel) {
    return levelLabel(requiredLevel) + ' (' + levelShort(requiredLevel) + ')';
}

function parseModulesJson(raw) {
    if (!raw) return {};
    try {
        const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
    } catch (_) {
        return {};
    }
}

function userCanReviewApplications(user) {
    if (!user) return false;
    const role = String(user.role || '').toLowerCase();
    const ur = String(user.user_role || user.role || '').trim().toLowerCase();
    if (role === 'admin' && ur !== 'co_admin') return true;
    if (ur === 'co_admin') return true;
    if (ur === 'staff_user' || ur === 'support_agent') {
        const mods = parseModulesJson(user.staff_modules);
        return !!mods.applications;
    }
    return false;
}

function getReviewerAuthorityLevel(user, profile) {
    if (!user) return 0;
    const role = String(user.role || '').toLowerCase();
    const ur = String(user.user_role || user.role || '').trim().toLowerCase();
    if (role === 'admin' && ur !== 'co_admin') return 99;
    if (ur === 'co_admin') return 3;
    if (!userCanReviewApplications(user)) return 0;
    return clampLevel(profile && profile.authority_level != null ? profile.authority_level : 1);
}

function agentMeetsRequired(agentLevel, requiredLevel) {
    return parseInt(agentLevel, 10) >= clampLevel(requiredLevel);
}

function loadReviewerAuthorityContext(db, user, cb) {
    if (!user || !user.id) return cb(null, { authorityLevel: 0, profile: null });
    db.get(`SELECT * FROM application_reviewer_profiles WHERE user_id = ?`, [user.id], (e, profile) => {
        if (e) return cb(e);
        cb(null, {
            profile: profile || null,
            authorityLevel: getReviewerAuthorityLevel(user, profile)
        });
    });
}

function loadReviewerAuthorityByUserId(db, userId, cb) {
    db.get(
        `SELECT id, role, user_role, staff_modules, first_name, last_name, email
         FROM users WHERE id = ? AND COALESCE(is_disabled,0) = 0`,
        [parseInt(userId, 10)],
        (e, user) => {
            if (e) return cb(e);
            if (!user) return cb(null, { authorityLevel: 0, profile: null, user: null });
            loadReviewerAuthorityContext(db, user, (e2, ctx) => {
                if (e2) return cb(e2);
                cb(null, Object.assign({ user }, ctx));
            });
        }
    );
}

function checkApplicationAuthority(db, user, registration, actionLabel, cb) {
    const required = clampLevel(registration && registration.review_required_level);
    loadReviewerAuthorityContext(db, user, (e, ctx) => {
        if (e) return cb(e);
        const agentLevel = ctx.authorityLevel;
        if (!userCanReviewApplications(user)) {
            return cb(null, {
                ok: false,
                agentLevel,
                requiredLevel: required,
                error: 'Your account is not enabled for seminar application review.'
            });
        }
        if (agentMeetsRequired(agentLevel, required)) {
            return cb(null, { ok: true, agentLevel, requiredLevel: required });
        }
        cb(null, {
            ok: false,
            agentLevel,
            requiredLevel: required,
            error:
                actionLabel +
                ' requires ' +
                requiredLevelLabel(required) +
                '. Your level is ' +
                requiredLevelLabel(agentLevel) +
                '. Escalate to higher authority.'
        });
    });
}

function checkApplicationAuthorityByUserId(db, userId, registration, actionLabel, cb) {
    db.get(
        `SELECT id, role, user_role, staff_modules, first_name, last_name, email
         FROM users WHERE id = ?`,
        [parseInt(userId, 10)],
        (e, user) => {
            if (e) return cb(e);
            if (!user) {
                return cb(null, { ok: false, error: 'Reviewer account not found.' });
            }
            checkApplicationAuthority(db, user, registration, actionLabel, cb);
        }
    );
}

module.exports = {
    LEVELS,
    clampLevel,
    levelLabel,
    levelShort,
    requiredLevelLabel,
    parseModulesJson,
    userCanReviewApplications,
    getReviewerAuthorityLevel,
    agentMeetsRequired,
    loadReviewerAuthorityContext,
    loadReviewerAuthorityByUserId,
    checkApplicationAuthority,
    checkApplicationAuthorityByUserId
};
