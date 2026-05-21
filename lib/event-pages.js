/**
 * Per-event public pages and portal modes (doctor portal vs standalone attendee site).
 */

const DEFAULT_EVENT_PAGE = {
    heroTitle: '',
    heroSubtitle: '',
    heroImage: '',
    showOnHomepage: true,
    customDomainHint: '',
    sections: []
};

function parseEventPageJson(raw) {
    if (!raw) return { ...DEFAULT_EVENT_PAGE };
    try {
        const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Object.assign({}, DEFAULT_EVENT_PAGE, o && typeof o === 'object' ? o : {});
    } catch (_) {
        return { ...DEFAULT_EVENT_PAGE };
    }
}

function slugify(s) {
    return String(s || '')
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
}

/** Status after admin document approval (or manual approve). */
function statusAfterApproval(row) {
    if (!row || Number(row.payment_required) === 0) return 'completed';
    return 'approved_pending_payment';
}

function paymentAmountForSeminar(row) {
    const p = row && row.price != null ? Number(row.price) : NaN;
    return Number.isFinite(p) && p > 0 ? p : 1500;
}

function getSeminarEventFlags(db, seminarId, cb) {
    const sid = parseInt(seminarId, 10);
    if (!Number.isInteger(sid) || sid < 1) {
        return cb(null, { ok: false, error: 'Invalid seminar id' });
    }
    db.get(
        `SELECT id, title, event_slug, portal_mode, public_page_enabled, registration_enabled,
                payment_required, price, is_active, registration_start, registration_end
         FROM seminars WHERE id = ?`,
        [sid],
        (err, row) => {
            if (err) return cb(err);
            if (!row) return cb(null, { ok: false, error: 'Seminar not found' });
            cb(null, {
                ok: true,
                seminarId: row.id,
                title: row.title,
                eventSlug: row.event_slug,
                portalMode: row.portal_mode || 'doctor',
                publicPageEnabled: Number(row.public_page_enabled) === 1,
                registrationEnabled: Number(row.registration_enabled) !== 0,
                paymentRequired: Number(row.payment_required) !== 0,
                price: row.price,
                isActive: Number(row.is_active) !== 0,
                registrationStart: row.registration_start,
                registrationEnd: row.registration_end
            });
        }
    );
}

function ensureEventPageSchema(db, ignoreErr, next) {
    const alters = [
        `ALTER TABLE seminars ADD COLUMN event_slug TEXT`,
        `ALTER TABLE seminars ADD COLUMN portal_mode TEXT DEFAULT 'doctor'`,
        `ALTER TABLE seminars ADD COLUMN public_page_enabled INTEGER DEFAULT 0`,
        `ALTER TABLE seminars ADD COLUMN event_page_json TEXT`,
        `ALTER TABLE seminars ADD COLUMN registration_enabled INTEGER DEFAULT 1`,
        `ALTER TABLE seminars ADD COLUMN payment_required INTEGER DEFAULT 1`
    ];
    let i = 0;
    const step = () => {
        if (i >= alters.length) return next && next();
        db.run(alters[i++], (e) => {
            if (ignoreErr) ignoreErr(e);
            step();
        });
    };
    step();
}

function registerEventPageRoutes(app, db, deps) {
    const { fileStore, parsePositiveUserId } = deps;

    app.get('/api/public/event/:slug', (req, res) => {
        const slug = slugify(req.params.slug);
        if (!slug) return res.status(400).json({ error: 'Invalid event slug' });
        db.get(
            `SELECT id, title, event_date, location_url, price, portal_mode, public_page_enabled,
                    registration_enabled, payment_required, registration_form_json, event_page_json,
                    hero_image_path, flyer_path, terms_conditions, is_active
             FROM seminars
             WHERE lower(trim(event_slug)) = lower(trim(?)) AND IFNULL(public_page_enabled, 0) = 1`,
            [slug],
            (err, row) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!row || Number(row.is_active) === 0) {
                    return res.status(404).json({ error: 'Event not found or not published' });
                }
                const page = parseEventPageJson(row.event_page_json);
                if (row.hero_image_path) page.heroImage = fileStore.publicFileUrl(row.hero_image_path);
                res.json({
                    slug,
                    seminarId: row.id,
                    title: row.title,
                    eventDate: row.event_date,
                    locationUrl: row.location_url,
                    price: row.price,
                    portalMode: row.portal_mode || 'doctor',
                    registrationEnabled: Number(row.registration_enabled) !== 0,
                    paymentRequired: Number(row.payment_required) !== 0,
                    termsConditions: row.terms_conditions || '',
                    page,
                    registerUrl:
                        String(row.portal_mode || 'doctor') === 'standalone'
                            ? '/event-register.html?event=' + encodeURIComponent(slug)
                            : '/doctor.html?seminarId=' + row.id
                });
            }
        );
    });

    app.get('/api/public/events', (req, res) => {
        db.all(
            `SELECT id, title, event_date, event_slug, portal_mode, public_page_enabled,
                    registration_enabled, payment_required, price, event_page_json, is_active
             FROM seminars
             WHERE IFNULL(public_page_enabled, 0) = 1 AND IFNULL(is_active, 0) = 1
             ORDER BY event_date ASC, id DESC LIMIT 50`,
            [],
            (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                const out = (rows || [])
                    .map((row) => {
                        const page = parseEventPageJson(row.event_page_json);
                        if (page.showOnHomepage === false) return null;
                        const slug = slugify(row.event_slug);
                        if (!slug) return null;
                        return {
                            slug,
                            seminarId: row.id,
                            title: page.heroTitle || row.title,
                            subtitle: page.heroSubtitle || '',
                            eventDate: row.event_date,
                            portalMode: row.portal_mode || 'doctor',
                            registrationEnabled: Number(row.registration_enabled) !== 0,
                            paymentRequired: Number(row.payment_required) !== 0,
                            price: row.price,
                            pageUrl: '/event.html?event=' + encodeURIComponent(slug),
                            registerUrl:
                                String(row.portal_mode || 'doctor') === 'standalone'
                                    ? '/event-register.html?event=' + encodeURIComponent(slug)
                                    : '/doctor.html?seminarId=' + row.id
                        };
                    })
                    .filter(Boolean);
                res.json(out);
            }
        );
    });

    app.get('/api/admin/event-pages', (req, res) => {
        db.all(
            `SELECT id, title, event_date, event_slug, portal_mode, public_page_enabled,
                    registration_enabled, payment_required, is_active, event_page_json
             FROM seminars ORDER BY id DESC LIMIT 200`,
            [],
            (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json(rows || []);
            }
        );
    });

    app.get('/api/admin/event-pages/:seminarId', (req, res) => {
        const sid = parseInt(req.params.seminarId, 10);
        if (!Number.isInteger(sid) || sid < 1) return res.status(400).json({ error: 'Invalid seminar id' });
        db.get(
            `SELECT id, title, event_date, event_slug, portal_mode, public_page_enabled,
                    registration_enabled, payment_required, is_active, event_page_json
             FROM seminars WHERE id = ?`,
            [sid],
            (err, row) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!row) return res.status(404).json({ error: 'Seminar not found' });
                const page = parseEventPageJson(row.event_page_json);
                res.json({
                    ...row,
                    eventPage: page
                });
            }
        );
    });

    app.post('/api/admin/event-pages/:seminarId', (req, res) => {
        const sid = parseInt(req.params.seminarId, 10);
        if (!Number.isInteger(sid) || sid < 1) return res.status(400).json({ error: 'Invalid seminar id' });
        const body = req.body || {};
        const slug = body.eventSlug != null ? slugify(body.eventSlug) : null;
        const pageJson =
            body.eventPage != null ? JSON.stringify(Object.assign({}, DEFAULT_EVENT_PAGE, body.eventPage)) : null;
        db.get(`SELECT id FROM seminars WHERE id = ?`, [sid], (e0, exists) => {
            if (e0) return res.status(500).json({ error: e0.message });
            if (!exists) return res.status(404).json({ error: 'Seminar not found' });
            if (slug) {
                db.get(
                    `SELECT id FROM seminars WHERE lower(trim(event_slug)) = lower(trim(?)) AND id != ?`,
                    [slug, sid],
                    (e1, dup) => {
                        if (e1) return res.status(500).json({ error: e1.message });
                        if (dup) return res.status(400).json({ error: 'Event URL slug already in use' });
                        saveEvent();
                    }
                );
            } else {
                saveEvent();
            }
            function saveEvent() {
                const sets = [];
                const params = [];
                if (slug != null) {
                    sets.push('event_slug = ?');
                    params.push(slug || null);
                }
                if (body.portalMode != null) {
                    sets.push('portal_mode = ?');
                    params.push(String(body.portalMode) === 'standalone' ? 'standalone' : 'doctor');
                }
                if (body.publicPageEnabled != null) {
                    sets.push('public_page_enabled = ?');
                    params.push(body.publicPageEnabled ? 1 : 0);
                }
                if (body.registrationEnabled != null) {
                    sets.push('registration_enabled = ?');
                    params.push(body.registrationEnabled ? 1 : 0);
                }
                if (body.paymentRequired != null) {
                    sets.push('payment_required = ?');
                    params.push(body.paymentRequired ? 1 : 0);
                }
                if (pageJson != null) {
                    sets.push('event_page_json = ?');
                    params.push(pageJson);
                }
                if (!sets.length) return res.json({ success: true });
                params.push(sid);
                db.run(`UPDATE seminars SET ${sets.join(', ')} WHERE id = ?`, params, function (e2) {
                    if (e2) return res.status(500).json({ error: e2.message });
                    res.json({ success: true, eventSlug: slug });
                });
            }
        });
    });
}

module.exports = {
    DEFAULT_EVENT_PAGE,
    parseEventPageJson,
    slugify,
    statusAfterApproval,
    paymentAmountForSeminar,
    getSeminarEventFlags,
    ensureEventPageSchema,
    registerEventPageRoutes
};
