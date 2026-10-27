'use strict';

const crypto = require('crypto');
const integrationSettings = require('./integration-settings');


function createProtectedGroupJoinLink(db, registrationId, cb) {
    const id = Number(registrationId || 0);
    if (!id) return cb(new Error('registrationId is required.'));
    db.get(
        `SELECT r.id AS registration_id, r.seminar_id, r.status AS registration_status,
                s.whatsapp_group_url
         FROM registrations r
         JOIN seminars s ON s.id = r.seminar_id
         WHERE r.id = ?`,
        [id],
        (err, reg) => {
            if (err) return cb(err);
            if (!reg) return cb(new Error('Registration not found.'));
            if (!reg.whatsapp_group_url) return cb(new Error('WhatsApp group URL is not configured.'));
            if (['cancelled', 'refunded', 'rejected'].includes(String(reg.registration_status || '').toLowerCase())) {
                return cb(new Error('Registration is not eligible.'));
            }
            db.get(
                `SELECT t.ticket_id_string
                 FROM tickets t
                 JOIN orders o ON o.id = t.order_id
                 WHERE o.registration_id = ?
                   AND o.status = 'success'
                   AND COALESCE(t.is_valid, 1) = 1
                 ORDER BY t.id DESC
                 LIMIT 1`,
                [id],
                (ticketErr, ticket) => {
                    if (ticketErr) return cb(ticketErr);
                    if (!ticket) return cb(new Error('A valid issued e-ticket is required.'));
                    db.get(
                        `SELECT token_hash, expires_at
                         FROM seminar_whatsapp_group_access
                         WHERE registration_id = ? AND seminar_id = ? AND status = 'active'
                           AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
                         ORDER BY id DESC LIMIT 1`,
                        [id, reg.seminar_id],
                        (existingErr, existing) => {
                            if (existingErr) return cb(existingErr);
                            if (existing && existing.token_hash) {
                                db.run('UPDATE seminar_whatsapp_group_access SET sent_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE token_hash=?',[existing.token_hash],()=>{});
  return cb(null, { link: publicUrlFromSettings('/whatsapp-group/join/' + existing.token_hash),
                                    ticketId: ticket.ticket_id_string || null
                                });
                            }
                            const token = createToken();
                            const tokenHash = hashToken(token);
                            db.run(
                                `INSERT INTO seminar_whatsapp_group_access
                                 (registration_id, seminar_id, token_hash, status, sent_at, expires_at, created_at, updated_at)
                                 VALUES (?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '30 days', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                                [id, reg.seminar_id, tokenHash],
                                (insertErr) => {
                                    if (insertErr) return cb(insertErr);
                                    cb(null, {
                                        link: publicUrlFromSettings('/whatsapp-group/join/' + token),
                                        ticketId: ticket.ticket_id_string || null
                                    });
                                }
                            );
                        }
                    );
                }
            );
        }
    );
}

function publicUrlFromSettings(path) {
    const base = (integrationSettings.getPublicBaseUrl() || 'https://seminar.vaidyagogate.org').replace(/\/$/, '');
    return base + path;
}

function registerWhatsAppGroupAccessRoutes(app, deps) {
    if (!app) throw new Error('Express app is required');
    if (!deps || !deps.db) throw new Error('Database dependency is required');

    const db = deps.db;
    const assertAdminPortalActor = deps.assertAdminPortalActor;

    function admin(req, res, next) {
        try {
            if (typeof assertAdminPortalActor === 'function') {
                return assertAdminPortalActor(req, res, next);
            }
            return next();
        } catch (e) {
            return res.status(403).json({ success: false, error: e.message });
        }
    }

    function hashToken(token) {
        return crypto.createHash('sha256').update(String(token)).digest('hex');
    }

    function createToken() {
        return crypto.randomBytes(32).toString('base64url');
    }

    function publicUrl(path) {
        return integrationSettings.getPublicBaseUrl().replace(/\/$/, '') + path;
    }

    app.post('/api/admin/whatsapp-group-access/create', admin, (req, res) => {
        const registrationId = Number(req.body && req.body.registrationId || 0);
        if (!registrationId) {
            return res.status(400).json({ success: false, error: 'registrationId is required.' });
        }

        db.get(
            `SELECT r.id AS registration_id, r.seminar_id, r.user_id, r.status AS registration_status,
                    s.title AS seminar_title, s.whatsapp_group_url
             FROM registrations r
             JOIN seminars s ON s.id = r.seminar_id
             WHERE r.id = ?`,
            [registrationId],
            (err, reg) => {
                if (err) return res.status(500).json({ success: false, error: err.message });
                if (!reg) return res.status(404).json({ success: false, error: 'Registration not found.' });
                if (!reg.whatsapp_group_url) {
                    return res.status(400).json({ success: false, error: 'WhatsApp group URL is not configured for this seminar.' });
                }
                if (['cancelled', 'refunded', 'rejected'].includes(String(reg.registration_status || '').toLowerCase())) {
                    return res.status(403).json({ success: false, error: 'This registration is not eligible.' });
                }

                db.get(
                    `SELECT t.id, t.ticket_id_string
                     FROM tickets t
                     JOIN orders o ON o.id = t.order_id
                     WHERE o.registration_id = ?
                       AND o.status = 'success'
                       AND COALESCE(t.is_valid, 1) = 1
                     ORDER BY t.id DESC
                     LIMIT 1`,
                    [registrationId],
                    (ticketErr, ticket) => {
                        if (ticketErr) return res.status(500).json({ success: false, error: ticketErr.message });
                        if (!ticket) {
                            return res.status(403).json({ success: false, error: 'A valid issued e-ticket is required.' });
                        }

                        const token = createToken();
                        const tokenHash = hashToken(token);

                        db.run(
                            `INSERT INTO seminar_whatsapp_group_access
                             (registration_id, seminar_id, token_hash, status, sent_at, expires_at, created_at, updated_at)
                             VALUES (?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '30 days', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                             ON CONFLICT (token_hash) DO NOTHING`,
                            [registrationId, reg.seminar_id, tokenHash],
                            function(insertErr) {
                                if (insertErr) return res.status(500).json({ success: false, error: insertErr.message });

                                const link = publicUrl('/whatsapp-group/join/' + encodeURIComponent(token));
                                res.json({
                                    success: true,
                                    registrationId,
                                    seminarId: reg.seminar_id,
                                    seminarTitle: reg.seminar_title,
                                    ticketId: ticket.ticket_id_string || null,
                                    link
                                });
                            }
                        );
                    }
                );
            }
        );
    });

    app.get('/whatsapp-group/join/:token', (req, res) => {
        const token = String(req.params.token || '').trim();
        if (!token || token.length < 40) {
            return res.status(404).send('Invalid or expired WhatsApp group link.');
        }

        const tokenHash = hashToken(token);

        db.get(
            `SELECT a.id, a.registration_id, a.seminar_id, a.status, a.expires_at,
                    s.whatsapp_group_url
             FROM seminar_whatsapp_group_access a
             JOIN seminars s ON s.id = a.seminar_id
             JOIN registrations r ON r.id = a.registration_id
             WHERE a.token_hash = ?
               AND a.status = 'active'
               AND (a.expires_at IS NULL OR a.expires_at > CURRENT_TIMESTAMP)
               AND r.status NOT IN ('cancelled', 'refunded', 'rejected')
               AND EXISTS (
                   SELECT 1
                   FROM tickets t
                   JOIN orders o ON o.id = t.order_id
                   WHERE o.registration_id = r.id
                     AND o.status = 'success'
                     AND COALESCE(t.is_valid, 1) = 1
               )
             LIMIT 1`,
            [tokenHash],
            (err, row) => {
                if (err) return res.status(500).send('Unable to validate this link.');
                if (!row || !row.whatsapp_group_url) {
                    return res.status(403).send('This WhatsApp group link is invalid, expired, or no longer available.');
                }

                db.run(
                    `UPDATE seminar_whatsapp_group_access
                     SET clicked_at = COALESCE(clicked_at, CURRENT_TIMESTAMP),
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    [row.id],
                    () => res.redirect(302, row.whatsapp_group_url)
                );
            }
        );
    });
}

module.exports = { registerWhatsAppGroupAccessRoutes, createProtectedGroupJoinLink };
