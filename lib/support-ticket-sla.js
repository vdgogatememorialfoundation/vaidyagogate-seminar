/**
 * Support ticket expected response time (admin-configurable via global_settings).
 */
const KEY = 'support_ticket_config';

const DEFAULTS = {
    defaultResponseHours: 24,
    byCategory: {
        general: 24,
        registration: 48,
        payment: 24,
        technical: 48
    }
};

let cache = { ...DEFAULTS, byCategory: { ...DEFAULTS.byCategory } };

function merge(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    const byCategory =
        o.byCategory && typeof o.byCategory === 'object' && !Array.isArray(o.byCategory)
            ? { ...DEFAULTS.byCategory, ...o.byCategory }
            : { ...DEFAULTS.byCategory };
    const hours = parseInt(o.defaultResponseHours, 10);
    return {
        defaultResponseHours: Number.isFinite(hours) && hours > 0 ? Math.min(720, hours) : DEFAULTS.defaultResponseHours,
        byCategory: Object.fromEntries(
            Object.entries(byCategory).map(([k, v]) => {
                const h = parseInt(v, 10);
                return [String(k).toLowerCase(), Number.isFinite(h) && h > 0 ? Math.min(720, h) : DEFAULTS.defaultResponseHours];
            })
        )
    };
}

function loadConfig(db, cb) {
    if (!db) {
        cache = merge(DEFAULTS);
        return cb && cb(null, cache);
    }
    db.get(`SELECT value FROM global_settings WHERE key = ?`, [KEY], (err, row) => {
        if (err) {
            cache = merge(DEFAULTS);
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

function saveConfig(db, raw, cb) {
    const norm = merge(raw);
    const json = JSON.stringify(norm);
    db.run(`UPDATE global_settings SET value = ? WHERE key = ?`, [json, KEY], function (uErr) {
        if (uErr) return cb && cb(uErr);
        if (this.changes > 0) {
            cache = norm;
            return cb && cb(null, norm);
        }
        db.run(`INSERT INTO global_settings (key, value) VALUES (?, ?)`, [KEY, json], (iErr) => {
            if (iErr) return cb && cb(iErr);
            cache = norm;
            cb && cb(null, norm);
        });
    });
}

function hoursForCategory(cfg, category) {
    const cat = String(category || 'general').toLowerCase();
    const map = (cfg && cfg.byCategory) || cache.byCategory || {};
    const h = map[cat];
    if (Number.isFinite(h) && h > 0) return h;
    return (cfg && cfg.defaultResponseHours) || cache.defaultResponseHours || DEFAULTS.defaultResponseHours;
}

function computeExpectedResponseAt(category, cfg) {
    const c = cfg || cache;
    const hours = hoursForCategory(c, category);
    const at = new Date(Date.now() + hours * 60 * 60 * 1000);
    return { at, hours, iso: at.toISOString() };
}

function formatExpectedDisplay(iso) {
    if (!iso) return '';
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '';
        return d.toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            dateStyle: 'medium',
            timeStyle: 'short',
            hour12: true
        });
    } catch (_) {
        return String(iso);
    }
}

function getConfig() {
    return merge(cache);
}

module.exports = {
    KEY,
    DEFAULTS,
    loadConfig,
    saveConfig,
    getConfig,
    merge,
    hoursForCategory,
    computeExpectedResponseAt,
    formatExpectedDisplay
};
