/**
 * Support agent authority levels — route sensitive tickets to higher authority.
 * Level 1: frontline · Level 2: senior · Level 3: authority (cancellation, refunds, certificates)
 */
const LEVELS = {
    1: { label: 'Frontline', short: 'L1', description: 'General and technical support' },
    2: { label: 'Senior', short: 'L2', description: 'Billing, payments, and applications' },
    3: { label: 'Authority', short: 'L3', description: 'Cancellation, refunds, and certificate eligibility' }
};

const CATEGORY_MIN_LEVEL = {
    general: 1,
    other: 1,
    technical: 1,
    registration: 1,
    billing: 2,
    payment: 2,
    case: 2,
    cancellation_refund: 3,
    certificate: 3
};

const KEYWORD_RULES = [
    { re: /\b(cancel(lation|led)?|refund(ed|s)?)\b/i, level: 3 },
    { re: /\b(certificate|certification|eligib(le|ility))\b/i, level: 3 }
];

function clampLevel(n) {
    const v = parseInt(n, 10);
    if (!Number.isFinite(v) || v < 1) return 1;
    if (v > 3) return 3;
    return v;
}

function levelLabel(level) {
    const lv = clampLevel(level);
    return (LEVELS[lv] && LEVELS[lv].label) || 'Level ' + lv;
}

function levelShort(level) {
    const lv = clampLevel(level);
    return (LEVELS[lv] && LEVELS[lv].short) || 'L' + lv;
}

function computeRequiredLevel(category, subject, description) {
    const cat = String(category || 'general').trim().toLowerCase();
    let level = CATEGORY_MIN_LEVEL[cat] || 1;
    const text = [subject, description].filter(Boolean).join(' ');
    KEYWORD_RULES.forEach((rule) => {
        if (rule.re.test(text)) level = Math.max(level, rule.level);
    });
    return clampLevel(level);
}

function getAgentAuthorityLevel(user, profile) {
    if (!user) return 0;
    const role = String(user.role || '').toLowerCase();
    const ur = String(user.user_role || user.role || '').trim().toLowerCase();
    if (role === 'admin' && ur !== 'co_admin') return 99;
    if (ur === 'co_admin') return 3;
    return clampLevel(profile && profile.authority_level != null ? profile.authority_level : 1);
}

function agentMeetsRequired(agentLevel, requiredLevel) {
    return parseInt(agentLevel, 10) >= clampLevel(requiredLevel);
}

function requiredLevelLabel(requiredLevel) {
    return levelLabel(requiredLevel) + ' (' + levelShort(requiredLevel) + ')';
}

function nextEscalationLevel(currentRequired, agentLevel) {
    const cur = clampLevel(currentRequired);
    const bump = Math.max(cur, clampLevel(agentLevel) + 1);
    return clampLevel(Math.max(bump, cur + 1));
}

function loadAgentAuthorityContext(db, user, cb) {
    if (!user || !user.id) return cb(null, { authorityLevel: 0, profile: null });
    db.get(`SELECT * FROM support_agent_profiles WHERE user_id = ?`, [user.id], (e, profile) => {
        if (e) return cb(e);
        cb(null, {
            profile: profile || null,
            authorityLevel: getAgentAuthorityLevel(user, profile)
        });
    });
}

function checkTicketAuthority(db, user, ticket, actionLabel, cb) {
    const required = clampLevel(ticket && ticket.required_authority_level);
    loadAgentAuthorityContext(db, user, (e, ctx) => {
        if (e) return cb(e);
        const agentLevel = ctx.authorityLevel;
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

module.exports = {
    LEVELS,
    CATEGORY_MIN_LEVEL,
    clampLevel,
    levelLabel,
    levelShort,
    requiredLevelLabel,
    computeRequiredLevel,
    getAgentAuthorityLevel,
    agentMeetsRequired,
    nextEscalationLevel,
    loadAgentAuthorityContext,
    checkTicketAuthority
};
