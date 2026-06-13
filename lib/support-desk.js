/**
 * Support desk: agent availability, auto-assignment, SLA reply visibility.
 */
const supportAuthority = require('./support-authority');

const CONFIG_KEY = 'support_desk_config';

const DEFAULTS = {
    holdEarlyStaffReplies: true,
    autoAssignEnabled: true,
    liveChatEnabled: true,
    timezone: 'Asia/Kolkata',
    defaultDepartmentSlug: 'general',
    businessHours: { startMinutes: 9 * 60 + 30, endMinutes: 18 * 60 + 30, days: [1, 2, 3, 4, 5, 6] }
};

let cache = { ...DEFAULTS, businessHours: { ...DEFAULTS.businessHours, days: [...DEFAULTS.businessHours.days] } };

function mergeConfig(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    const bh = o.businessHours && typeof o.businessHours === 'object' ? o.businessHours : {};
    return {
        holdEarlyStaffReplies: o.holdEarlyStaffReplies !== false,
        autoAssignEnabled: o.autoAssignEnabled !== false,
        liveChatEnabled: o.liveChatEnabled !== false,
        timezone: String(o.timezone || DEFAULTS.timezone),
        defaultDepartmentSlug: String(o.defaultDepartmentSlug || DEFAULTS.defaultDepartmentSlug),
        businessHours: {
            startMinutes: Number.isFinite(+bh.startMinutes) ? +bh.startMinutes : DEFAULTS.businessHours.startMinutes,
            endMinutes: Number.isFinite(+bh.endMinutes) ? +bh.endMinutes : DEFAULTS.businessHours.endMinutes,
            days: Array.isArray(bh.days) && bh.days.length ? bh.days.map(Number) : [...DEFAULTS.businessHours.days]
        }
    };
}

function loadConfig(db, cb) {
    if (!db) {
        cache = mergeConfig(DEFAULTS);
        return cb && cb(null, cache);
    }
    db.get(`SELECT value FROM global_settings WHERE key = ?`, [CONFIG_KEY], (err, row) => {
        if (err) {
            cache = mergeConfig(DEFAULTS);
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
        cache = mergeConfig(parsed);
        cb && cb(null, cache);
    });
}

function saveConfig(db, raw, cb) {
    const norm = mergeConfig(raw);
    const json = JSON.stringify(norm);
    db.run(`UPDATE global_settings SET value = ? WHERE key = ?`, [json, CONFIG_KEY], function (uErr) {
        if (uErr) return cb && cb(uErr);
        if (this.changes > 0) {
            cache = norm;
            return cb && cb(null, norm);
        }
        db.run(`INSERT INTO global_settings (key, value) VALUES (?, ?)`, [CONFIG_KEY, json], (iErr) => {
            if (iErr) return cb && cb(iErr);
            cache = norm;
            cb && cb(null, norm);
        });
    });
}

function getConfig() {
    return mergeConfig(cache);
}

function istParts(date) {
    const d = date || new Date();
    const fmt = new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        weekday: 'short',
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });
    const parts = {};
    fmt.formatToParts(d).forEach((p) => {
        parts[p.type] = p.value;
    });
    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const dow = dayMap[parts.weekday] != null ? dayMap[parts.weekday] : d.getDay();
    const mins = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
    const ymd = `${parts.year}-${parts.month}-${parts.day}`;
    return { dow, mins, ymd };
}

function isWithinBusinessHours(cfg, date) {
    const c = cfg || getConfig();
    const { dow, mins } = istParts(date);
    const bh = c.businessHours || DEFAULTS.businessHours;
    if (!bh.days.includes(dow)) return false;
    return mins >= bh.startMinutes && mins < bh.endMinutes;
}

function formatMinutesIST(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return h12 + ':' + String(m).padStart(2, '0') + ' ' + ampm;
}

function formatBusinessHoursLabel(cfg) {
    const c = cfg || getConfig();
    const bh = c.businessHours || DEFAULTS.businessHours;
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const days = (bh.days || [])
        .slice()
        .sort((a, b) => a - b)
        .map((d) => dayNames[d] || String(d))
        .join(', ');
    const tz = c.timezone || DEFAULTS.timezone;
    return (
        (days || 'Mon–Sat') +
        ' · ' +
        formatMinutesIST(bh.startMinutes) +
        ' – ' +
        formatMinutesIST(bh.endMinutes) +
        ' (' +
        tz +
        ')'
    );
}

function isStaffSenderType(senderType) {
    const t = String(senderType || '').toLowerCase();
    return t === 'admin' || t === 'staff' || t === 'support';
}

function computeVisibleAtForStaffReply(ticket, cfg, actor) {
    if (actor) {
        const r = String(actor.role || '').toLowerCase();
        const ur = String(actor.user_role || '').trim().toLowerCase();
        if (r === 'admin' && ur !== 'co_admin') return null;
    }
    const c = cfg || getConfig();
    if (!c.holdEarlyStaffReplies) return null;
    const expected = ticket && ticket.expected_response_at ? new Date(ticket.expected_response_at) : null;
    if (!expected || Number.isNaN(expected.getTime())) return null;
    const now = new Date();
    if (now >= expected) return null;
    return expected.toISOString();
}

function filterMessagesForUserView(messages) {
    const now = Date.now();
    return (messages || []).filter((m) => {
        if (!isStaffSenderType(m.sender_type)) return true;
        if (!m.visible_at) return true;
        const vis = new Date(m.visible_at).getTime();
        return !Number.isNaN(vis) && vis <= now;
    });
}

function departmentIdForCategory(db, category, cb) {
    const cat = String(category || 'general').toLowerCase();
    const slugMap = {
        registration: 'registration',
        payment: 'payment',
        billing: 'payment',
        technical: 'technical',
        case: 'case',
        cancellation_refund: 'authority',
        certificate: 'authority'
    };
    const slug = slugMap[cat] || 'general';
    db.get(`SELECT id FROM support_departments WHERE slug = ? AND IFNULL(is_active,1) = 1`, [slug], (e, row) => {
        if (e) return cb(e);
        if (row) return cb(null, row.id);
        db.get(`SELECT id FROM support_departments WHERE slug = 'general'`, [], (e2, row2) => cb(e2, row2 && row2.id));
    });
}

function isAgentOnHoliday(db, userId, ymd, cb) {
    db.get(
        `SELECT 1 AS ok FROM support_agent_holidays
         WHERE holiday_date = ? AND (user_id IS NULL OR user_id = ?) LIMIT 1`,
        [ymd, userId],
        (e, row) => cb(e, !!row)
    );
}

function isAgentWithinHours(db, userId, date, cb) {
    const { dow, mins, ymd } = istParts(date);
    isAgentOnHoliday(db, userId, ymd, (eHol, onHoliday) => {
        if (eHol) return cb(eHol, false);
        if (onHoliday) return cb(null, false);
        db.all(`SELECT day_of_week, start_minutes, end_minutes FROM support_agent_hours WHERE user_id = ?`, [userId], (e, rows) => {
            if (e) return cb(e, false);
            if (!rows || !rows.length) {
                const cfg = getConfig();
                return cb(null, isWithinBusinessHours(cfg, date));
            }
            const ok = rows.some(
                (r) => r.day_of_week === dow && mins >= r.start_minutes && mins < r.end_minutes
            );
            cb(null, ok);
        });
    });
}

function countOpenTicketsForAgent(db, userId, cb) {
    db.get(
        `SELECT COUNT(*) AS c FROM support_tickets
         WHERE assigned_to_staff = ? AND LOWER(TRIM(status)) NOT IN ('resolved','closed','cancelled')`,
        [userId],
        (e, row) => cb(e, row ? parseInt(row.c, 10) || 0 : 0)
    );
}

function pickAgentForDepartment(db, departmentId, minAuthorityLevel, cb) {
    const minLevel = supportAuthority.clampLevel(minAuthorityLevel || 1);
    db.all(
        `SELECT u.id, u.first_name, u.last_name, p.max_open_tickets, p.is_available, p.authority_level
         FROM users u
         JOIN support_agent_profiles p ON p.user_id = u.id
         WHERE IFNULL(u.is_disabled,0) = 0 AND IFNULL(p.is_available,1) = 1
           AND IFNULL(p.authority_level, 1) >= ?
           AND (p.department_id IS NULL OR p.department_id = ? OR ? IS NULL)
           AND LOWER(TRIM(COALESCE(u.user_role,''))) IN ('support_agent','staff_user','co_admin')
         ORDER BY IFNULL(p.authority_level, 1) ASC, u.id ASC`,
        [minLevel, departmentId, departmentId],
        (e, agents) => {
            if (e) return cb(e);
            if (!agents || !agents.length) return cb(null, null);
            let idx = 0;
            const tryNext = () => {
                if (idx >= agents.length) return cb(null, null);
                const agent = agents[idx++];
                isAgentWithinHours(db, agent.id, new Date(), (eH, onDuty) => {
                    if (eH || !onDuty) return tryNext();
                    countOpenTicketsForAgent(db, agent.id, (eC, openCount) => {
                        if (eC) return cb(eC);
                        const max = parseInt(agent.max_open_tickets, 10) || 15;
                        if (openCount >= max) return tryNext();
                        cb(null, agent.id);
                    });
                });
            };
            tryNext();
        }
    );
}

function autoAssignTicket(db, ticketRow, cb) {
    const cfg = getConfig();
    if (!cfg.autoAssignEnabled) return cb(null, null);
    const requiredLevel = supportAuthority.clampLevel(
        ticketRow.required_authority_level ||
            supportAuthority.computeRequiredLevel(ticketRow.category, ticketRow.subject, ticketRow.description)
    );
    departmentIdForCategory(db, ticketRow.category, (eDept, deptId) => {
        if (eDept) return cb(eDept);
        pickAgentForDepartment(db, deptId, requiredLevel, (ePick, agentId) => {
            if (ePick) return cb(ePick);
            if (!agentId) return cb(null, null);
            db.run(
                `UPDATE support_tickets SET assigned_to_staff = ?, department_id = ?, assignment_mode = 'auto', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [agentId, deptId, ticketRow.id],
                (uErr) => {
                    if (uErr) return cb(uErr);
                    db.get(
                        `SELECT st.*, COALESCE(NULLIF(TRIM(st.ticket_id), ''), NULLIF(TRIM(st.tracking_id), '')) AS ticket_id
                         FROM support_tickets st WHERE st.id = ?`,
                        [ticketRow.id],
                        (e2, row) => {
                            if (!e2 && row) {
                                try {
                                    require('./support-desk-notify').notifyAgentTicketAssigned(db, agentId, row, () => {});
                                } catch (_) {}
                            }
                            cb(null, agentId);
                        }
                    );
                }
            );
        });
    });
}

function isSupportAgentUser(user) {
    if (!user) return false;
    const ur = String(user.user_role || user.role || '').toLowerCase();
    const r = String(user.role || '').toLowerCase();
    if (r === 'admin' && ur !== 'co_admin') return true;
    if (ur === 'support_agent' || ur === 'co_admin') return true;
    const mods = user.staff_modules;
    let parsed = {};
    try {
        parsed = typeof mods === 'string' ? JSON.parse(mods) : mods || {};
    } catch (_) {}
    return ur === 'staff_user' && !!parsed['support-tickets'];
}

module.exports = {
    CONFIG_KEY,
    DEFAULTS,
    loadConfig,
    saveConfig,
    getConfig,
    istParts,
    isWithinBusinessHours,
    formatBusinessHoursLabel,
    formatMinutesIST,
    isStaffSenderType,
    computeVisibleAtForStaffReply,
    filterMessagesForUserView,
    departmentIdForCategory,
    isAgentWithinHours,
    autoAssignTicket,
    isSupportAgentUser
};
