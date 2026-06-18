/**
 * Staff portal routes — applications, tickets, payments, e-tickets (module-gated).
 */
const bookAuth = require('./book-sales-auth');
const { staffPortalSectionList } = require('./staff-portal-modules');
const appAuthority = require('./application-authority');
const appEscalation = require('./application-escalation');
const docVerify = require('./application-document-verify');

function registerStaffPortalRoutes(app, db, deps) {
    const guard = (section, fn) => bookAuth.requireBookSalesActor(db, { section }, fn);
    const portalTracking = deps && deps.portalTracking;
    const notifEngine = deps && deps.notifEngine;
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
    const DECISION_STATUSES = new Set(['approved_pending_payment', 'rejected']);

    function mapApplicationRow(row, actorLevel) {
        const required = appAuthority.clampLevel(row.review_required_level);
        const canAct = appAuthority.agentMeetsRequired(actorLevel, required);
        const esc = appEscalation.parseEscalationJson(row.review_escalation_json);
        return {
            id: row.id,
            application_no: row.application_no,
            status: row.status,
            form_data: row.form_data,
            doc_review_json: row.doc_review_json,
            created_at: row.created_at,
            first_name: row.first_name,
            last_name: row.last_name,
            user_id_string: row.user_id_string,
            seminar_title: row.seminar_title,
            review_required_level: required,
            review_required_label: appAuthority.requiredLevelLabel(required),
            review_escalated_at: row.review_escalated_at,
            can_act: canAct,
            can_escalate: required < 3 && appEscalation.REVIEWABLE_STATUSES.has(String(row.status || '').toLowerCase()),
            escalation_history: esc.history || []
        };
    }

    app.get('/api/staff/session', guard(null, (req, res) => {
        const actor = req.bookSalesActor;
        const ur = String(actor.user_role || '').toLowerCase();
        const finish = (authorityLevel) => {
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
                applicationReviewAuthority: authorityLevel,
                applicationReviewAuthorityLabel: appAuthority.requiredLevelLabel(authorityLevel),
                modules: {
                    inventory: !!sections.inventory,
                    orders: !!sections['book-orders']
                }
            });
        };
        const done = () => {
            appAuthority.loadReviewerAuthorityContext(db, actor, (e, ctx) => {
                if (e) return res.status(500).json({ error: e.message });
                finish(ctx.authorityLevel);
            });
        };
        if (ur !== 'co_admin') return done();
        const sync = require('./staff-portal-sync');
        const staffPayload = JSON.stringify(sync.adminModulesToStaffModules(actor.admin_modules));
        if (String(actor.staff_modules || '') === staffPayload) return done();
        db.run(`UPDATE users SET staff_modules = ? WHERE id = ?`, [staffPayload, actor.id], () => done());
    }));

    app.get('/api/staff/applications', guard('applications', (req, res) => {
        appAuthority.loadReviewerAuthorityContext(db, req.bookSalesActor, (eCtx, ctx) => {
            if (eCtx) return res.status(500).json({ error: eCtx.message });
            db.all(
                `SELECT a.id, a.application_no, a.status, a.form_data, a.doc_review_json, a.created_at,
                        a.review_required_level, a.review_escalated_at, a.review_escalation_json,
                        u.first_name, u.last_name, u.user_id_string, s.title AS seminar_title
                 FROM registrations a
                 JOIN users u ON a.user_id = u.id
                 LEFT JOIN seminars s ON s.id = a.seminar_id
                 ORDER BY COALESCE(a.review_required_level, 1) DESC, a.created_at DESC
                 LIMIT 500`,
                [],
                (err, rows) => {
                    if (err) return res.status(500).json({ error: err.message });
                    const actorLevel = ctx.authorityLevel;
                    res.json((rows || []).map((r) => mapApplicationRow(r, actorLevel)));
                }
            );
        });
    }));

    app.get('/api/staff/applications/:applicationId', guard('applications', (req, res) => {
        const appId = parseInt(req.params.applicationId, 10);
        if (!Number.isInteger(appId) || appId < 1) {
            return res.status(400).json({ error: 'Invalid application id' });
        }
        appAuthority.loadReviewerAuthorityContext(db, req.bookSalesActor, (eCtx, ctx) => {
            if (eCtx) return res.status(500).json({ error: eCtx.message });
            db.get(
                `SELECT a.id, a.application_no, a.status, a.form_data, a.doc_review_json, a.created_at,
                        a.review_required_level, a.review_escalated_at, a.review_escalation_json,
                        u.first_name, u.last_name, u.user_id_string, u.email, s.title AS seminar_title
                 FROM registrations a
                 JOIN users u ON a.user_id = u.id
                 LEFT JOIN seminars s ON s.id = a.seminar_id
                 WHERE a.id = ?`,
                [appId],
                (err, row) => {
                    if (err) return res.status(500).json({ error: err.message });
                    if (!row) return res.status(404).json({ error: 'Application not found' });
                    res.json(mapApplicationRow(row, ctx.authorityLevel));
                }
            );
        });
    }));

    app.post('/api/staff/applications/:applicationId/escalate', guard('applications', (req, res) => {
        const note = String((req.body && req.body.note) || '').trim();
        appEscalation.escalateSeminarApplication(
            db,
            req.params.applicationId,
            req.bookSalesActor,
            note,
            { portalTracking },
            (err, result) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!result || !result.ok) return res.status(400).json({ error: (result && result.error) || 'Escalation failed' });
                res.json({
                    success: true,
                    reviewRequiredLevel: result.reviewRequiredLevel,
                    reviewRequiredLabel: result.reviewRequiredLabel,
                    message: result.message
                });
            }
        );
    }));

    app.post('/api/staff/applications/:applicationId/document-verify', guard('applications', (req, res) => {
        const body = Object.assign({}, req.body || {}, { actingStaffId: req.bookSalesActorId });
        docVerify.verifySeminarApplication(
            db,
            req.params.applicationId,
            body,
            {
                portalTracking,
                notifEngine,
                getOrCreatePendingOrder: deps && deps.getOrCreatePendingOrder,
                volunteerTicketFlow: deps && deps.volunteerTicketFlow,
                volunteerTicketDeps: deps && deps.volunteerTicketDeps
            },
            (err, result) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!result || !result.ok) return res.status(400).json({ error: (result && result.error) || 'Verify failed' });
                res.json({ success: true, status: result.status, message: result.message });
            }
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
        db.get(`SELECT id, status, review_required_level FROM registrations WHERE id = ?`, [applicationId], (e, row) => {
            if (e) return res.status(500).json({ error: e.message });
            if (!row) return res.status(404).json({ error: 'Application not found' });
            if (DECISION_STATUSES.has(status)) {
                return res.status(400).json({
                    error: 'Use document verify actions to approve or reject. Escalate if you need higher authority.'
                });
            }
            appAuthority.checkApplicationAuthority(
                db,
                req.bookSalesActor,
                row,
                'Status update',
                (eAuth, auth) => {
                    if (eAuth) return res.status(500).json({ error: eAuth.message });
                    if (!auth.ok) return res.status(403).json({ error: auth.error });
                    db.run(`UPDATE registrations SET status = ? WHERE id = ?`, [status, applicationId], function (err) {
                        if (err) return res.status(500).json({ error: err.message });
                        if (!this.changes) return res.status(404).json({ error: 'Application not found' });
                        res.json({ success: true, message: 'Status updated.' });
                    });
                }
            );
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
