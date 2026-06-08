/**
 * Homepage hero banners + promotional popup (DB-backed, admin-managed).
 */
const DEFAULT_POPUP = {
    enabled: false,
    imagePath: '',
    images: [],
    heading: '',
    body: '',
    ctaText: '',
    ctaUrl: '',
    delaySeconds: 0,
    showMode: 'once_session',
    autoSlideMs: 5500
};

function normalizePopupConfig(cfg) {
    const base = { ...DEFAULT_POPUP, ...(cfg && typeof cfg === 'object' ? cfg : {}) };
    let images = Array.isArray(base.images)
        ? base.images.filter((i) => i && String(i.imagePath || '').trim())
        : [];
    if (!images.length && base.imagePath) {
        images = [{ imagePath: String(base.imagePath).trim() }];
    }
    base.images = images.map((i) => ({
        imagePath: String(i.imagePath || '').trim(),
        heading: i.heading || '',
        body: i.body || '',
        ctaText: i.ctaText || '',
        ctaUrl: i.ctaUrl || ''
    }));
    if (base.images.length) base.imagePath = base.images[0].imagePath;
    return base;
}

const DEFAULT_CAROUSEL = {
    autoSlideMs: 5500
};

function ignoreSchemaMigrationErr(err) {
    if (!err) return;
    const m = String(err.message || '');
    if (m.includes('duplicate column') || m.includes('already exists')) return;
    console.error('[site-marketing] schema:', m);
}

function ensureSiteMarketingSchema(db, next) {
    db.run(
        `CREATE TABLE IF NOT EXISTS homepage_banners (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT,
            subtitle TEXT,
            description TEXT,
            image_path TEXT NOT NULL,
            cta_text TEXT,
            cta_url TEXT,
            sort_order INTEGER DEFAULT 0,
            enabled INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        (e) => {
            ignoreSchemaMigrationErr(e);
            next && next();
        }
    );
}

function loadPopupConfig(db, callback) {
    db.get(`SELECT value FROM global_settings WHERE key = 'site_popup_config'`, [], (err, row) => {
        let cfg = { ...DEFAULT_POPUP };
        if (!err && row && row.value) {
            try {
                const p = JSON.parse(row.value);
                if (p && typeof p === 'object') cfg = { ...cfg, ...p };
            } catch (_) {}
        }
        db.get(`SELECT value FROM global_settings WHERE key = 'homepage_carousel_settings'`, [], (e2, row2) => {
            let carousel = { ...DEFAULT_CAROUSEL };
            if (!e2 && row2 && row2.value) {
                try {
                    const c = JSON.parse(row2.value);
                    if (c && typeof c === 'object') carousel = { ...carousel, ...c };
                } catch (_) {}
            }
            callback(null, { popup: normalizePopupConfig(cfg), carousel });
        });
    });
}

function savePopupConfig(db, cfg, upsertGlobalSetting, callback) {
    const payload = JSON.stringify(normalizePopupConfig(cfg));
    upsertGlobalSetting('site_popup_config', payload, callback);
}

function saveCarouselSettings(db, settings, upsertGlobalSetting, callback) {
    upsertGlobalSetting('homepage_carousel_settings', JSON.stringify({ ...DEFAULT_CAROUSEL, ...settings }), callback);
}

function registerSiteMarketingRoutes(app, db, upload, upsertGlobalSetting) {
    app.get('/api/public/marketing', (req, res) => {
        loadPopupConfig(db, (e, meta) => {
            if (e) return res.status(500).json({ error: e.message });
            db.all(
                `SELECT id, title, subtitle, description, image_path AS imagePath,
                        cta_text AS ctaText, cta_url AS ctaUrl, sort_order AS sortOrder
                 FROM homepage_banners
                 WHERE IFNULL(enabled, 1) = 1
                 ORDER BY sort_order ASC, id ASC`,
                [],
                (err, banners) => {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({
                        banners: banners || [],
                        popup: normalizePopupConfig(meta.popup),
                        carousel: meta.carousel
                    });
                }
            );
        });
    });

    app.get('/api/admin/homepage-banners', (req, res) => {
        db.all(
            `SELECT id, title, subtitle, description, image_path AS imagePath,
                    cta_text AS ctaText, cta_url AS ctaUrl, sort_order AS sortOrder,
                    IFNULL(enabled, 1) AS enabled
             FROM homepage_banners ORDER BY sort_order ASC, id ASC`,
            [],
            (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json(rows || []);
            }
        );
    });

    app.post('/api/admin/homepage-banners', (req, res) => {
        const b = req.body || {};
        if (!b.imagePath) return res.status(400).json({ error: 'imagePath is required' });
        db.run(
            `INSERT INTO homepage_banners (title, subtitle, description, image_path, cta_text, cta_url, sort_order, enabled)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                b.title || '',
                b.subtitle || '',
                b.description || '',
                b.imagePath,
                b.ctaText || '',
                b.ctaUrl || '',
                parseInt(b.sortOrder, 10) || 0,
                b.enabled === false || b.enabled === 0 ? 0 : 1
            ],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true, id: this.lastID, imagePath: b.imagePath });
            }
        );
    });

    app.put('/api/admin/homepage-banners/:id', (req, res) => {
        const { id } = req.params;
        const b = req.body || {};
        db.get(`SELECT image_path FROM homepage_banners WHERE id = ?`, [id], (gErr, existing) => {
            if (gErr) return res.status(500).json({ error: gErr.message });
            if (!existing) return res.status(404).json({ error: 'Banner not found' });
            const imagePath =
                b.imagePath != null && String(b.imagePath).trim() !== ''
                    ? String(b.imagePath).trim()
                    : existing.image_path || '';
            if (!imagePath) return res.status(400).json({ error: 'imagePath is required' });
            db.run(
                `UPDATE homepage_banners SET title=?, subtitle=?, description=?, image_path=?, cta_text=?, cta_url=?, sort_order=?, enabled=? WHERE id=?`,
                [
                    b.title != null ? b.title : '',
                    b.subtitle != null ? b.subtitle : '',
                    b.description != null ? b.description : '',
                    imagePath,
                    b.ctaText != null ? b.ctaText : '',
                    b.ctaUrl != null ? b.ctaUrl : '',
                    parseInt(b.sortOrder, 10) || 0,
                    b.enabled === false || b.enabled === 0 ? 0 : 1,
                    id
                ],
                function (err) {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ success: true, changes: this.changes, imagePath });
                }
            );
        });
    });

    app.post('/api/admin/homepage-banners/reorder', (req, res) => {
        const order = req.body && req.body.order;
        if (!Array.isArray(order)) return res.status(400).json({ error: 'order array required' });
        let pending = order.length;
        if (!pending) return res.json({ success: true });
        order.forEach((item, idx) => {
            db.run(
                `UPDATE homepage_banners SET sort_order = ? WHERE id = ?`,
                [idx, item.id],
                () => {
                    pending--;
                    if (pending === 0) res.json({ success: true });
                }
            );
        });
    });

    app.delete('/api/admin/homepage-banners/:id', (req, res) => {
        db.run(`DELETE FROM homepage_banners WHERE id = ?`, [req.params.id], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
    });

    app.get('/api/admin/site-popup', (req, res) => {
        loadPopupConfig(db, (e, meta) => {
            if (e) return res.status(500).json({ error: e.message });
            res.json(meta);
        });
    });

    app.post('/api/admin/site-popup', (req, res) => {
        const popup = req.body && req.body.popup;
        const carousel = req.body && req.body.carousel;
        savePopupConfig(db, popup || {}, upsertGlobalSetting, (e) => {
            if (e) return res.status(500).json({ error: e.message });
            if (carousel) {
                saveCarouselSettings(db, carousel, upsertGlobalSetting, (e2) => {
                    if (e2) return res.status(500).json({ error: e2.message });
                    res.json({ success: true });
                });
            } else {
                res.json({ success: true });
            }
        });
    });
}

module.exports = {
    ensureSiteMarketingSchema,
    registerSiteMarketingRoutes,
    normalizePopupConfig,
    DEFAULT_POPUP,
    DEFAULT_CAROUSEL
};
