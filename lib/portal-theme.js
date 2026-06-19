/**
 * Portal theme tokens stored in global_settings (public / doctor / judge).
 */
const KEYS = {
    public: 'public_portal_theme',
    doctor: 'doctor_portal_theme',
    judge: 'judge_portal_theme'
};

const DEFAULT_THEMES = {
    public: {
        primary: '#0f766e',
        primaryMid: '#14b8a6',
        primaryDark: '#0d5c4d',
        accent: '#c9a227',
        text: '#0f172a',
        background: '#fafbfc',
        fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
        fontDisplay: "'Libre Baskerville', Georgia, serif"
    },
    doctor: {
        primary: '#0f766e',
        primaryDark: '#115e59',
        accent: '#fbbf24',
        sidebar: '#0f766e',
        sidebarDeep: '#134e4a',
        sidebarText: '#ccfbf1',
        sidebarTextMuted: '#99f6e4',
        sidebarHeading: '#f0fdfa',
        background: '#f8fafc',
        text: '#134e4a',
        fontFamily: "'Inter', system-ui, sans-serif"
    },
    judge: {
        primary: '#7c3aed',
        primaryMid: '#6366f1',
        primaryDark: '#312e81',
        accent: '#a78bfa',
        background: '#faf5ff',
        text: '#1e1b4b',
        fontFamily: "'DM Sans', system-ui, sans-serif",
        fontDisplay: "'Fraunces', Georgia, serif"
    }
};

function normalizeTheme(input, portal) {
    const base = { ...(DEFAULT_THEMES[portal] || DEFAULT_THEMES.public) };
    if (!input || typeof input !== 'object') return base;
    Object.keys(base).forEach((k) => {
        const v = input[k];
        if (v != null && String(v).trim()) base[k] = String(v).trim();
    });
    if (portal === 'public') {
        if (input && input.primary && !input.primaryMid) base.primaryMid = base.primary;
        if (input && input.primary && !input.primaryDark) base.primaryDark = base.primary;
    }
    if (portal === 'doctor') {
        if (input && input.primary && !input.primaryDark) base.primaryDark = base.primary;
        if (input && input.sidebar && !input.sidebarDeep) base.sidebarDeep = base.primaryDark;
    }
    if (portal === 'judge') {
        if (input && input.primary && !input.primaryMid) base.primaryMid = base.primary;
        if (input && input.primary && !input.primaryDark) base.primaryDark = base.primary;
    }
    return base;
}

function loadTheme(db, portal, cb) {
    const key = KEYS[portal];
    if (!key) return cb(new Error('Unknown portal'));
    db.get(`SELECT value FROM global_settings WHERE key = ?`, [key], (err, row) => {
        if (err) return cb(err);
        let parsed = null;
        if (row && row.value) {
            try {
                parsed = JSON.parse(row.value);
            } catch (_) {
                parsed = null;
            }
        }
        cb(null, normalizeTheme(parsed, portal));
    });
}

function saveTheme(db, portal, theme, cb) {
    const key = KEYS[portal];
    if (!key) return cb(new Error('Unknown portal'));
    const normalized = normalizeTheme(theme, portal);
    const sql =
        process.env.DATABASE_URL && !process.env.USE_SQLITE
            ? `INSERT INTO global_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
            : null;
    const json = JSON.stringify(normalized);
    if (sql) {
        return db.run(sql, [key, json], (e) => cb(e, normalized));
    }
    db.run(`UPDATE global_settings SET value = ? WHERE key = ?`, [json, key], function (uerr) {
        if (uerr) return cb(uerr);
        if (this.changes > 0) return cb(null, normalized);
        db.run(`INSERT INTO global_settings (key, value) VALUES (?, ?)`, [key, json], (ierr) => cb(ierr, normalized));
    });
}

function loadAllThemes(db, cb) {
    loadTheme(db, 'public', (e1, pub) => {
        if (e1) return cb(e1);
        loadTheme(db, 'doctor', (e2, doc) => {
            if (e2) return cb(e2);
            loadTheme(db, 'judge', (e3, jud) => {
                if (e3) return cb(e3);
                cb(null, { public: pub, doctor: doc, judge: jud });
            });
        });
    });
}

module.exports = {
    KEYS,
    DEFAULT_THEMES,
    normalizeTheme,
    loadTheme,
    saveTheme,
    loadAllThemes
};
