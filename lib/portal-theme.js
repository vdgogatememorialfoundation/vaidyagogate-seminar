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
        primaryDark: '#134e4a',
        accent: '#c9a227',
        text: '#1e293b',
        background: '#f8fafc'
    },
    doctor: {
        primary: '#0f766e',
        primaryDark: '#115e59',
        accent: '#fbbf24',
        sidebar: '#0f766e',
        background: '#f1f5f9',
        text: '#1e293b'
    },
    judge: {
        primary: '#7c3aed',
        primaryMid: '#6366f1',
        primaryDark: '#312e81',
        accent: '#a78bfa',
        background: '#faf5ff',
        text: '#1e1b4b'
    }
};

function normalizeTheme(input, portal) {
    const base = { ...(DEFAULT_THEMES[portal] || DEFAULT_THEMES.public) };
    if (!input || typeof input !== 'object') return base;
    Object.keys(base).forEach((k) => {
        const v = input[k];
        if (v != null && String(v).trim()) base[k] = String(v).trim();
    });
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
