/**
 * Admin application payment-follow-up / contact module.
 */
function registerApplicationContactRoutes(app, deps) {
    const { db, assertAdminPortalActor } = deps;

    function adminGuard(req, res, cb) {
        const aid = parseInt(
            (req.query && req.query.actingAdminId) ||
            (req.body && req.body.actingAdminId) ||
            '',
            10
        );
        if (!Number.isInteger(aid) || aid < 1) {
            return res.status(400).json({ error: 'actingAdminId is required' });
        }
        assertAdminPortalActor(aid, (e, adm) => {
            if (e && e.message === 'BAD_ACTOR') return res.status(400).json({ error: 'actingAdminId is required' });
            if (e && e.message === 'FORBIDDEN') return res.status(403).json({ error: 'Administrator access required' });
            if (e) return res.status(500).json({ error: e.message });
            if (!adm) return res.status(403).json({ error: 'Invalid administrator' });
            cb(aid, adm);
        });
    }

    app.get('/api/admin/application-contact/staff', (req, res) => {
        adminGuard(req, res, () => {
            db.all(`SELECT id, first_name, last_name, email, phone, user_role, staff_modules FROM users WHERE LOWER(COALESCE(user_role, role, '')) IN ('admin','co_admin','staff_user','support_agent','book_sales_staff') ORDER BY first_name, last_name`, [], (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json(rows || []);
            });
        });
    });


    app.post('/api/admin/application-contact/assign', (req, res) => {
        adminGuard(req, res, (aid) => {
            const registrationId = parseInt(req.body && req.body.registrationId, 10);
            const staffUserId = parseInt(req.body && req.body.staffUserId, 10);
            if (!registrationId || !staffUserId) return res.status(400).json({ error: 'registrationId and staffUserId are required' });
            db.get(`SELECT id, seminar_id FROM registrations WHERE id = ?`, [registrationId], (e1, reg) => {
                if (e1) return res.status(500).json({ error: e1.message });
                if (!reg) return res.status(404).json({ error: 'Application not found' });
                db.get(`SELECT id FROM users WHERE id = ?`, [staffUserId], (e2, staff) => {
                    if (e2) return res.status(500).json({ error: e2.message });
                    if (!staff) return res.status(404).json({ error: 'Staff user not found' });
                    db.run(`INSERT INTO application_contact_assignments (registration_id, seminar_id, staff_user_id, assigned_by, status) VALUES (?, ?, ?, ?, 'active') ON CONFLICT (registration_id) DO UPDATE SET seminar_id = EXCLUDED.seminar_id, staff_user_id = EXCLUDED.staff_user_id, assigned_by = EXCLUDED.assigned_by, status = 'active', assigned_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`, [registrationId, reg.seminar_id, staffUserId, aid], function(err) {
                        if (err) return res.status(500).json({ error: err.message });
                        db.run(`INSERT INTO application_contact_assignment_history (registration_id, seminar_id, staff_user_id, assigned_by, action) VALUES (?, ?, ?, ?, 'assigned')`, [registrationId, reg.seminar_id, staffUserId, aid], function(e3) {
                            if (e3) return res.status(500).json({ error: e3.message });
                            res.json({ ok: true, assignmentId: this.lastID });
                        });
                    });
                });
            });
        });
    });


    app.get('/api/admin/application-contact/assignments', (req, res) => {
        adminGuard(req, res, () => {
            db.all(`SELECT a.id AS assignment_id, a.registration_id, a.seminar_id, a.staff_user_id, a.assigned_by, a.status, a.assigned_at, u.first_name, u.last_name, u.email AS staff_email, r.application_no, p.first_name AS applicant_first_name, p.last_name AS applicant_last_name, p.phone AS applicant_phone, s.title AS seminar_title FROM application_contact_assignments a JOIN users u ON u.id = a.staff_user_id JOIN registrations r ON r.id = a.registration_id JOIN users p ON p.id = r.user_id LEFT JOIN seminars s ON s.id = a.seminar_id ORDER BY a.assigned_at DESC LIMIT 1000`, [], (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json(rows || []);
            });
        });
    });


    app.get('/api/admin/application-contact/pending-payment', (req, res) => {
        adminGuard(req, res, () => {
            const seminarId = req.query.seminarId ? parseInt(req.query.seminarId, 10) : null;
            const params = [];
            let seminarFilter = '';

            if (Number.isInteger(seminarId) && seminarId > 0) {
                seminarFilter = ' AND r.seminar_id = ? ';
                params.push(seminarId);
            }

            db.all(
                `SELECT
                    r.id AS registration_id,
                    r.application_no,
                    r.status,
                    r.created_at,
                    r.seminar_id,
                    r.form_data,
                    r.doc_review_json,
                    u.id AS user_id,
                    u.user_id_string,
                    u.first_name,
                    u.middle_name,
                    u.last_name,
                    u.email,
                    u.phone,
                    s.title AS seminar_title,
                    s.event_date AS seminar_event_date,
                    s.price AS seminar_price,
                    o.id AS order_id,
                    o.status AS order_status,
                    o.amount AS order_amount,
                    o.payment_date,
                    (
                        SELECT h.status
                        FROM application_contact_history h
                        WHERE h.registration_id = r.id
                        ORDER BY h.id DESC
                        LIMIT 1
                    ) AS contact_status,
                    (
                        SELECT h.reason
                        FROM application_contact_history h
                        WHERE h.registration_id = r.id
                        ORDER BY h.id DESC
                        LIMIT 1
                    ) AS contact_reason,
                    (
                        SELECT h.notes
                        FROM application_contact_history h
                        WHERE h.registration_id = r.id
                        ORDER BY h.id DESC
                        LIMIT 1
                    ) AS contact_notes,
                    (
                        SELECT h.follow_up_at
                        FROM application_contact_history h
                        WHERE h.registration_id = r.id
                        ORDER BY h.id DESC
                        LIMIT 1
                    ) AS next_follow_up_at,
                    (
                        SELECT h.created_at
                        FROM application_contact_history h
                        WHERE h.registration_id = r.id
                        ORDER BY h.id DESC
                        LIMIT 1
                    ) AS last_contact_at
                 FROM registrations r
                 JOIN users u ON u.id = r.user_id
                 LEFT JOIN seminars s ON s.id = r.seminar_id
                 LEFT JOIN orders o ON o.registration_id = r.id
                    AND o.id = (
                        SELECT id
                        FROM orders
                        WHERE registration_id = r.id
                        ORDER BY id DESC
                        LIMIT 1
                    )
                 WHERE r.status = 'approved_pending_payment'
                   AND NOT EXISTS (
                       SELECT 1
                       FROM orders so
                       WHERE so.registration_id = r.id
                         AND LOWER(COALESCE(so.status, '')) = 'success'
                   )
                   ${seminarFilter}
                 ORDER BY r.created_at DESC`,
                params,
                (err, rows) => {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json(rows || []);
                }
            );
        });
    });

    app.get('/api/admin/application-contact/:registrationId/history', (req, res) => {
        adminGuard(req, res, () => {
            const registrationId = parseInt(req.params.registrationId, 10);
            if (!registrationId) return res.status(400).json({ error: 'Invalid registrationId' });

            db.all(
                `SELECT
                    h.id,
                    h.registration_id,
                    h.seminar_id,
                    h.admin_user_id,
                    h.contact_type,
                    h.status,
                    h.reason,
                    h.notes,
                    h.follow_up_at,
                    h.whatsapp_sent,
                    h.created_at,
                    h.updated_at,
                    u.first_name AS admin_first_name,
                    u.last_name AS admin_last_name
                 FROM application_contact_history h
                 LEFT JOIN users u ON u.id = h.admin_user_id
                 WHERE h.registration_id = ?
                 ORDER BY h.id DESC`,
                [registrationId],
                (err, rows) => {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json(rows || []);
                }
            );
        });
    });

    app.post('/api/admin/application-contact/:registrationId', (req, res) => {
        adminGuard(req, res, (aid) => {
            const registrationId = parseInt(req.params.registrationId, 10);
            if (!registrationId) return res.status(400).json({ error: 'Invalid registrationId' });

            const body = req.body || {};
            const allowedStatuses = new Set([
                'not_contacted',
                'called',
                'answered',
                'not_answered',
                'call_back_requested',
                'payment_link_sent',
                'payment_completed',
                'not_interested',
                'wrong_number',
                'other'
            ]);

            const status = String(body.status || '').trim().toLowerCase();
            const contactType = String(body.contactType || 'call').trim().toLowerCase();
            const reason = String(body.reason || '').trim();
            const notes = String(body.notes || '').trim();
            const followUpAt = body.followUpAt ? String(body.followUpAt).trim() : null;
            const whatsappSent = body.whatsappSent ? 1 : 0;

            if (!allowedStatuses.has(status)) {
                return res.status(400).json({ error: 'Invalid contact status' });
            }

            db.get(
                `SELECT id, seminar_id, status
                 FROM registrations
                 WHERE id = ?`,
                [registrationId],
                (err, reg) => {
                    if (err) return res.status(500).json({ error: err.message });
                    if (!reg) return res.status(404).json({ error: 'Application not found' });

                    db.run(
                        `INSERT INTO application_contact_history
                         (registration_id, seminar_id, admin_user_id, contact_type, status, reason, notes, follow_up_at, whatsapp_sent)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [
                            registrationId,
                            reg.seminar_id,
                            aid,
                            contactType,
                            status,
                            reason || null,
                            notes || null,
                            followUpAt || null,
                            whatsappSent
                        ],
                        function (insertErr) {
                            if (insertErr) return res.status(500).json({ error: insertErr.message });
                            res.json({
                                success: true,
                                contactId: this.lastID
                            });
                        }
                    );
                }
            );
        });
    });
}

module.exports = { registerApplicationContactRoutes };
