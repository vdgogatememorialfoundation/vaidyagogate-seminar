/**
 * Admin APIs for support desk configuration, agents, hours, holidays.
 */
const supportDesk = require('./support-desk');
const { ensureSupportDeskSchema, DEPARTMENT_PORTALS, PORTAL_LOGIN_PATHS } = require('./support-desk-schema');

function slugifyDepartmentName(name) {
    return (
        String(name || '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'department'
    );
}

function normalizeDepartmentPortal(portal) {
    const p = String(portal || 'support')
        .trim()
        .toLowerCase();
    return DEPARTMENT_PORTALS.includes(p) ? p : 'support';
}

function registerSupportDeskAdminRoutes(app, db, assertAdminPortalActor) {
    function adminGuard(handler) {
        return (req, res) => {
            const aid = parseInt(
                (req.query && req.query.actingAdminId) ||
                    (req.body && req.body.actingAdminId) ||
                    req.headers['x-acting-user-id'],
                10
            );
            if (!Number.isInteger(aid) || aid < 1) {
                return res.status(400).json({ error: 'actingAdminId required' });
            }
            assertAdminPortalActor(aid, (e) => {
                if (e && e.message === 'FORBIDDEN') return res.status(403).json({ error: 'Administrator access required' });
                if (e) return res.status(500).json({ error: e.message });
                ensureSupportDeskSchema(db, () => handler(req, res, aid));
            });
        };
    }

    app.get('/api/admin/support-desk/config', adminGuard((_req, res) => {
        supportDesk.loadConfig(db, (err, config) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, config });
        });
    }));

    app.post('/api/admin/support-desk/config', adminGuard((req, res) => {
        supportDesk.saveConfig(db, req.body && req.body.config, (err, config) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, config });
        });
    }));

    app.get('/api/admin/support-desk/agents', adminGuard((_req, res) => {
        db.all(
            `SELECT u.id, u.first_name, u.last_name, u.email, u.user_role,
                    p.department_id, p.is_available, p.max_open_tickets, p.live_chat_enabled, p.notes,
                    sd.name AS department_name, sd.portal AS department_portal, sd.slug AS department_slug
             FROM users u
             LEFT JOIN support_agent_profiles p ON p.user_id = u.id
             LEFT JOIN support_departments sd ON sd.id = p.department_id
             WHERE LOWER(TRIM(COALESCE(u.user_role,''))) IN ('support_agent','staff_user','co_admin')
               AND IFNULL(u.is_disabled,0) = 0
             ORDER BY u.first_name, u.last_name`,
            [],
            (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ agents: rows || [] });
            }
        );
    }));

    app.post('/api/admin/support-desk/agents/:userId', adminGuard((req, res) => {
        const uid = parseInt(req.params.userId, 10);
        const body = req.body || {};
        if (!Number.isInteger(uid)) return res.status(400).json({ error: 'Invalid user id' });
        const deptId = parseInt(body.departmentId, 10);
        const maxOpen = parseInt(body.maxOpenTickets, 10) || 15;
        const isAvail = body.isAvailable !== false ? 1 : 0;
        const live = body.liveChatEnabled !== false ? 1 : 0;
        db.get(`SELECT user_id FROM support_agent_profiles WHERE user_id = ?`, [uid], (e, row) => {
            if (e) return res.status(500).json({ error: e.message });
            const params = [
                Number.isInteger(deptId) ? deptId : null,
                maxOpen,
                isAvail,
                live,
                String(body.notes || '').trim() || null,
                uid
            ];
            const run = row
                ? db.run.bind(
                      db,
                      `UPDATE support_agent_profiles SET department_id=?, max_open_tickets=?, is_available=?, live_chat_enabled=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE user_id=?`,
                      params
                  )
                : db.run.bind(
                      db,
                      `INSERT INTO support_agent_profiles (department_id, max_open_tickets, is_available, live_chat_enabled, notes, user_id) VALUES (?,?,?,?,?,?)`,
                      [
                          Number.isInteger(deptId) ? deptId : null,
                          maxOpen,
                          isAvail,
                          live,
                          String(body.notes || '').trim() || null,
                          uid
                      ]
                  );
            run(function (uErr) {
                if (uErr) return res.status(500).json({ error: uErr.message });
                res.json({ success: true });
            });
        });
    }));

    app.get('/api/admin/support-desk/agents/:userId/hours', adminGuard((req, res) => {
        db.all(
            `SELECT id, day_of_week, start_minutes, end_minutes FROM support_agent_hours WHERE user_id = ? ORDER BY day_of_week, start_minutes`,
            [parseInt(req.params.userId, 10)],
            (err, rows) => res.json(err ? { error: err.message } : { hours: rows || [] })
        );
    }));

    app.post('/api/admin/support-desk/agents/:userId/hours', adminGuard((req, res) => {
        const uid = parseInt(req.params.userId, 10);
        const hours = Array.isArray(req.body && req.body.hours) ? req.body.hours : [];
        db.run(`DELETE FROM support_agent_hours WHERE user_id = ?`, [uid], (delErr) => {
            if (delErr) return res.status(500).json({ error: delErr.message });
            if (!hours.length) return res.json({ success: true });
            let i = 0;
            const next = () => {
                if (i >= hours.length) return res.json({ success: true });
                const h = hours[i++];
                db.run(
                    `INSERT INTO support_agent_hours (user_id, day_of_week, start_minutes, end_minutes) VALUES (?,?,?,?)`,
                    [uid, parseInt(h.dayOfWeek, 10), parseInt(h.startMinutes, 10), parseInt(h.endMinutes, 10)],
                    (insErr) => {
                        if (insErr) return res.status(500).json({ error: insErr.message });
                        next();
                    }
                );
            };
            next();
        });
    }));

    app.get('/api/admin/support-desk/holidays', adminGuard((_req, res) => {
        db.all(
            `SELECT h.id, h.user_id, h.holiday_date, h.label, u.first_name, u.last_name
             FROM support_agent_holidays h
             LEFT JOIN users u ON u.id = h.user_id
             ORDER BY h.holiday_date DESC LIMIT 200`,
            [],
            (err, rows) => res.json(err ? { error: err.message } : { holidays: rows || [] })
        );
    }));

    app.post('/api/admin/support-desk/holidays', adminGuard((req, res) => {
        const body = req.body || {};
        const date = String(body.holidayDate || '').trim();
        if (!date) return res.status(400).json({ error: 'holidayDate required (YYYY-MM-DD)' });
        const userId = body.userId ? parseInt(body.userId, 10) : null;
        db.run(
            `INSERT INTO support_agent_holidays (user_id, holiday_date, label) VALUES (?, ?, ?)`,
            [Number.isInteger(userId) ? userId : null, date, String(body.label || '').trim() || null],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true, id: this.lastID });
            }
        );
    }));

    app.delete('/api/admin/support-desk/holidays/:id', adminGuard((req, res) => {
        db.run(`DELETE FROM support_agent_holidays WHERE id = ?`, [parseInt(req.params.id, 10)], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, deleted: this.changes });
        });
    }));

    app.get('/api/admin/support-desk/departments', adminGuard((_req, res) => {
        db.all(
            `SELECT d.id, d.slug, d.name, d.portal, d.description, d.sort_order, d.is_active,
                    (SELECT COUNT(*) FROM support_agent_profiles p WHERE p.department_id = d.id) AS agent_count
             FROM support_departments d
             ORDER BY d.sort_order, d.name`,
            [],
            (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({
                    departments: rows || [],
                    portalOptions: DEPARTMENT_PORTALS.map((p) => ({
                        id: p,
                        label: p,
                        loginPath: PORTAL_LOGIN_PATHS[p] || '/'
                    }))
                });
            }
        );
    }));

    app.post('/api/admin/support-desk/departments', adminGuard((req, res) => {
        const body = req.body || {};
        const name = String(body.name || '').trim();
        if (!name) return res.status(400).json({ error: 'Department name is required' });
        const slug = String(body.slug || slugifyDepartmentName(name)).trim() || slugifyDepartmentName(name);
        const portal = normalizeDepartmentPortal(body.portal);
        const sortOrder = parseInt(body.sortOrder, 10);
        const isActive = body.isActive === false ? 0 : 1;
        const description = String(body.description || '').trim() || null;
        db.run(
            `INSERT INTO support_departments (slug, name, portal, description, sort_order, is_active)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [slug, name, portal, description, Number.isInteger(sortOrder) ? sortOrder : 0, isActive],
            function (err) {
                if (err) {
                    if (/unique|duplicate/i.test(String(err.message))) {
                        return res.status(400).json({ error: 'A department with this slug already exists.' });
                    }
                    return res.status(500).json({ error: err.message });
                }
                res.json({ success: true, id: this.lastID, loginPath: PORTAL_LOGIN_PATHS[portal] });
            }
        );
    }));

    app.put('/api/admin/support-desk/departments/:id', adminGuard((req, res) => {
        const id = parseInt(req.params.id, 10);
        const body = req.body || {};
        if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid department id' });
        const name = String(body.name || '').trim();
        if (!name) return res.status(400).json({ error: 'Department name is required' });
        const slug = String(body.slug || slugifyDepartmentName(name)).trim() || slugifyDepartmentName(name);
        const portal = normalizeDepartmentPortal(body.portal);
        const sortOrder = parseInt(body.sortOrder, 10);
        const isActive = body.isActive === false ? 0 : 1;
        const description = String(body.description || '').trim() || null;
        db.run(
            `UPDATE support_departments
             SET slug = ?, name = ?, portal = ?, description = ?, sort_order = ?, is_active = ?
             WHERE id = ?`,
            [slug, name, portal, description, Number.isInteger(sortOrder) ? sortOrder : 0, isActive, id],
            function (err) {
                if (err) {
                    if (/unique|duplicate/i.test(String(err.message))) {
                        return res.status(400).json({ error: 'Another department already uses this slug.' });
                    }
                    return res.status(500).json({ error: err.message });
                }
                if (!this.changes) return res.status(404).json({ error: 'Department not found' });
                res.json({ success: true, loginPath: PORTAL_LOGIN_PATHS[portal] });
            }
        );
    }));

    app.delete('/api/admin/support-desk/departments/:id', adminGuard((req, res) => {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid department id' });
        db.run(`UPDATE support_agent_profiles SET department_id = NULL WHERE department_id = ?`, [id], () => {
            db.run(`UPDATE support_departments SET is_active = 0 WHERE id = ?`, [id], function (err) {
                if (err) return res.status(500).json({ error: err.message });
                if (!this.changes) return res.status(404).json({ error: 'Department not found' });
                res.json({ success: true, deactivated: true });
            });
        });
    }));
}

module.exports = { registerSupportDeskAdminRoutes };
