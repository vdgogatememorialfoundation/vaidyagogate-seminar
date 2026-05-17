/**
 * Admin APIs for notification templates & logs.
 */
const { EVENT_KEYS } = require('./notification-defaults');
const {
    renderTemplate,
    processQueueOnce,
    deliverQueueRow,
    seedDefaultTemplates,
    syncDefaultNotificationTemplates
} = require('./notification-engine');

function registerNotificationRoutes(app, db) {
    app.get('/api/admin/notification-events', (req, res) => {
        res.json({ events: EVENT_KEYS });
    });

    app.get('/api/admin/notification-templates', (req, res) => {
        const seminarId = req.query.seminarId;
        let sql = `SELECT id, event_key, seminar_id, enabled, channel, email_subject, email_html,
                          whatsapp_template_name, whatsapp_body, version, updated_at
                   FROM notification_templates`;
        const params = [];
        if (seminarId != null && seminarId !== '') {
            sql += ` WHERE seminar_id IS ? OR seminar_id IS NULL`;
            params.push(parseInt(seminarId, 10));
        }
        sql += ` ORDER BY event_key ASC, seminar_id IS NULL DESC`;
        db.all(sql, params, (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        });
    });

    app.get('/api/admin/notification-templates/:id', (req, res) => {
        db.get(`SELECT * FROM notification_templates WHERE id = ?`, [req.params.id], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!row) return res.status(404).json({ error: 'Not found' });
            res.json(row);
        });
    });

    app.post('/api/admin/notification-templates', (req, res) => {
        const b = req.body || {};
        if (!b.event_key) return res.status(400).json({ error: 'event_key required' });
        db.run(
            `INSERT INTO notification_templates (event_key, seminar_id, enabled, channel, email_subject, email_html, whatsapp_template_name, whatsapp_body, version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
            [
                b.event_key,
                b.seminar_id != null && b.seminar_id !== '' ? parseInt(b.seminar_id, 10) : null,
                b.enabled === false || b.enabled === 0 ? 0 : 1,
                b.channel || 'both',
                b.email_subject || '',
                b.email_html || '',
                b.whatsapp_template_name || '',
                b.whatsapp_body || ''
            ],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true, id: this.lastID });
            }
        );
    });

    app.put('/api/admin/notification-templates/:id', (req, res) => {
        const b = req.body || {};
        db.run(
            `UPDATE notification_templates SET enabled=?, channel=?, email_subject=?, email_html=?,
             whatsapp_template_name=?, whatsapp_body=?, version = version + 1, updated_at = CURRENT_TIMESTAMP
             WHERE id=?`,
            [
                b.enabled === false || b.enabled === 0 ? 0 : 1,
                b.channel || 'both',
                b.email_subject || '',
                b.email_html || '',
                b.whatsapp_template_name || '',
                b.whatsapp_body || '',
                req.params.id
            ],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true, changes: this.changes });
            }
        );
    });

    app.delete('/api/admin/notification-templates/:id', (req, res) => {
        db.run(`DELETE FROM notification_templates WHERE id = ? AND seminar_id IS NOT NULL`, [req.params.id], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            if (!this.changes) return res.status(400).json({ error: 'Cannot delete global default templates' });
            res.json({ success: true });
        });
    });

    app.post('/api/admin/notification-templates/preview', (req, res) => {
        const b = req.body || {};
        const vars = b.sampleVars || {
            full_name: 'Dr. Sample User',
            first_name: 'Sample',
            email: 'doctor@example.com',
            seminar_name: 'National Seminar 2026',
            otp_code: '123456',
            portal_login_url: 'http://localhost:3000/doctor.html'
        };
        res.json({
            emailSubject: renderTemplate(b.email_subject || '', vars),
            emailHtml: renderTemplate(b.email_html || '', vars),
            whatsappBody: renderTemplate(b.whatsapp_body || '', vars)
        });
    });

    app.post('/api/admin/notification-templates/test', (req, res) => {
        const b = req.body || {};
        const channel = b.channel || 'email';
        const destination = b.destination;
        if (!destination) return res.status(400).json({ error: 'destination required' });

        const payload = {
            subject: b.email_subject || 'Test notification',
            html: b.email_html || '<p>Test</p>',
            text: b.whatsapp_body || 'Test',
            body: renderTemplate(b.whatsapp_body || 'Test', b.sampleVars || {}),
            templateName: b.whatsapp_template_name || ''
        };

        const row = {
            id: 0,
            channel: channel === 'whatsapp' ? 'whatsapp' : 'email',
            destination,
            template_key: 'TEST',
            payload: JSON.stringify(payload)
        };

        deliverQueueRow(db, row).then((r) => {
            if (r.ok) return res.json({ success: true });
            res.status(503).json({ error: r.error || 'Send failed' });
        });
    });

    app.post('/api/admin/notification-templates/seed', (req, res) => {
        seedDefaultTemplates(db, (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
    });

    app.post('/api/admin/notification-templates/sync-defaults', (req, res) => {
        syncDefaultNotificationTemplates(db, (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, message: 'Global templates updated to VGMF 2026 defaults.' });
        });
    });

    app.post('/api/admin/notification-queue/retry-failed', (req, res) => {
        db.run(
            `UPDATE notification_queue SET status = 'pending', attempts = 0 WHERE status = 'failed'`,
            [],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                processQueueOnce(db);
                res.json({ success: true, retried: this.changes });
            }
        );
    });

    app.get('/api/admin/notification-logs', (req, res) => {
        const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
        const status = req.query.status ? String(req.query.status) : '';
        let sql = `SELECT * FROM notification_logs`;
        const params = [];
        if (status) {
            sql += ` WHERE status = ?`;
            params.push(status);
        }
        sql += ` ORDER BY id DESC LIMIT ?`;
        params.push(limit);
        db.all(
            sql,
            params,
            (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json(rows || []);
            }
        );
    });

    app.get('/api/admin/notification-queue', (req, res) => {
        db.all(
            `SELECT * FROM notification_queue ORDER BY id DESC LIMIT 100`,
            [],
            (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json(rows || []);
            }
        );
    });

    app.post('/api/admin/notification-queue/:id/retry', (req, res) => {
        db.run(`UPDATE notification_queue SET status = 'pending', attempts = 0 WHERE id = ?`, [req.params.id], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            processQueueOnce(db);
            res.json({ success: true });
        });
    });
}

module.exports = { registerNotificationRoutes };
