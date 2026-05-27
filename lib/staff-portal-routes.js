/**
 * Staff portal routes — applications, tickets, payments, e-tickets (module-gated).
 */
const bookAuth = require('./book-sales-auth');
const { staffPortalSectionList } = require('./staff-portal-modules');

function registerStaffPortalRoutes(app, db, deps) {
    const guard = (section, fn) => bookAuth.requireBookSalesActor(db, { section }, fn);
    const ALLOWED_STATUSES = new Set([
        'submitted',
        'pending_approval',
        'revision_required',
        'documents_requested',
        'approved_pending_payment',
        'completed',
        'e_ticket_issued',
        'certificate_issued',
        'checked_in',
        'rejected',
        'cancelled'
    ]);

    app.get('/api/staff/session', guard(null, (req, res) => {
        const actor = req.bookSalesActor;
        const ur = String(actor.user_role || '').toLowerCase();
        const finish = () => {
            const sections = req.staffPortalSections || {};
            res.json({
                user: {
                    id: actor.id,
                    email: actor.email,
                    name: [actor.first_name, actor.last_name].filter(Boolean).join(' '),
                    user_role: actor.user_role || actor.role
                },
                sections,
                sectionList: staffPortalSectionList(sections),
                modules: {
                    inventory: !!sections.inventory,
                    orders: !!sections['book-orders']
                }
            });
        };
        if (ur !== 'co_admin') return finish();
        const sync = require('./staff-portal-sync');
        const staffPayload = JSON.stringify(sync.adminModulesToStaffModules(actor.admin_modules));
        if (String(actor.staff_modules || '') === staffPayload) return finish();
        db.run(`UPDATE users SET staff_modules = ? WHERE id = ?`, [staffPayload, actor.id], () => finish());
    }));

    app.get('/api/staff/applications', guard('applications', (req, res) => {
        db.all(
            `SELECT a.id, a.application_no, a.status, a.form_data, a.doc_review_json, a.created_at,
                    u.first_name, u.last_name, u.user_id_string
             FROM registrations a
             JOIN users u ON a.user_id = u.id
             ORDER BY a.created_at DESC
             LIMIT 500`,
            [],
            (err, rows) => res.json(err ? { error: err.message } : rows || [])
        );
    }));

    app.post('/api/staff/applications/status', guard('applications', (req, res) => {
        const applicationId = parseInt(req.body && req.body.applicationId, 10);
        const status = String((req.body && req.body.status) || '').toLowerCase();
        if (!Number.isInteger(applicationId) || applicationId < 1) {
            return res.status(400).json({ error: 'applicationId required' });
        }
        if (!ALLOWED_STATUSES.has(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }
        db.run(`UPDATE registrations SET status = ? WHERE id = ?`, [status, applicationId], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            if (!this.changes) return res.status(404).json({ error: 'Application not found' });
            res.json({ success: true, message: 'Status updated.' });
        });
    }));

    app.get('/api/staff/support-tickets', guard('support-tickets', (req, res) => {
        db.all(
            `SELECT st.id, st.user_id, st.category, st.subject, st.priority, st.status, st.created_at,
                    COALESCE(NULLIF(TRIM(st.ticket_id), ''), NULLIF(TRIM(st.tracking_id), '')) AS ticket_id,
                    u.first_name, u.last_name, u.email
             FROM support_tickets st
             LEFT JOIN users u ON st.user_id = u.id
             ORDER BY st.created_at DESC
             LIMIT 300`,
            [],
            (err, rows) => {
                if (err && /relation .* does not exist/i.test(err.message)) return res.json([]);
                if (err) return res.status(500).json({ error: err.message });
                res.json(rows || []);
            }
        );
    }));

    app.put('/api/staff/support-tickets/:ticketId/status', guard('support-tickets', (req, res) => {
        const ticketId = parseInt(req.params.ticketId, 10);
        const status = String((req.body && req.body.status) || '').trim();
        if (!Number.isInteger(ticketId) || ticketId < 1 || !status) {
            return res.status(400).json({ error: 'Invalid ticket or status' });
        }
        db.run(
            `UPDATE support_tickets SET status = ?, assigned_to_admin = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [status, req.bookSalesActorId, ticketId],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                if (!this.changes) return res.status(404).json({ error: 'Ticket not found' });
                res.json({ success: true });
            }
        );
    }));

    app.get('/api/staff/seminar-orders', guard('payments', (req, res) => {
        db.all(
            `SELECT o.id, o.order_id_string, o.amount, o.status, o.payment_date,
                    r.application_no, r.status AS registration_status,
                    s.title AS seminar_title, u.first_name, u.last_name, u.user_id_string, u.email
             FROM orders o
             JOIN registrations r ON o.registration_id = r.id
             JOIN users u ON r.user_id = u.id
             LEFT JOIN seminars s ON r.seminar_id = s.id
             ORDER BY o.id DESC
             LIMIT 300`,
            [],
            (err, rows) => res.json(err ? { error: err.message } : rows || [])
        );
    }));

    app.get('/api/staff/etickets/lookup', guard('etickets', (req, res) => {
        const q = String(req.query.q || '').trim();
        if (!q) return res.status(400).json({ error: 'Search query required' });
        const like = '%' + q.replace(/%/g, '') + '%';
        db.all(
            `SELECT r.id AS registration_id, r.application_no, r.status AS registration_status,
                    u.id AS user_id, u.first_name, u.last_name, u.email, u.phone,
                    s.title AS seminar_title, o.status AS payment_status, o.order_id_string,
                    t.ticket_id_string, t.is_scanned
             FROM registrations r
             JOIN users u ON u.id = r.user_id
             LEFT JOIN seminars s ON s.id = r.seminar_id
             LEFT JOIN orders o ON o.registration_id = r.id
             LEFT JOIN tickets t ON t.order_id = o.id
             WHERE r.application_no LIKE ? OR u.email LIKE ? OR u.phone LIKE ? OR t.ticket_id_string LIKE ?
             ORDER BY r.id DESC
             LIMIT 30`,
            [like, like, like, like],
            (err, rows) => res.json(err ? { error: err.message } : { results: rows || [] })
        );
    }));
}

module.exports = { registerStaffPortalRoutes };
