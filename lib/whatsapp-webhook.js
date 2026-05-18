/**
 * Meta WhatsApp webhook — delivery status updates for notification_logs.
 */
function ensureWhatsAppWebhookSchema(db, cb) {
    db.run(
        `CREATE TABLE IF NOT EXISTS whatsapp_delivery_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id TEXT,
            recipient TEXT,
            status TEXT,
            error_detail TEXT,
            raw_json TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`,
        (e1) => {
            if (e1) console.warn('[whatsapp-webhook] schema', e1.message);
            db.run(
                `CREATE INDEX IF NOT EXISTS idx_wa_delivery_msg ON whatsapp_delivery_events (message_id, created_at DESC)`,
                () => cb && cb()
            );
        }
    );
}

function extractStatusEvents(body) {
    const out = [];
    const entries = (body && body.entry) || [];
    entries.forEach((entry) => {
        (entry.changes || []).forEach((change) => {
            const value = change.value || {};
            (value.statuses || []).forEach((st) => {
                if (st && st.id) {
                    out.push({
                        messageId: st.id,
                        status: st.status,
                        recipient: st.recipient_id,
                        timestamp: st.timestamp,
                        errors: st.errors
                    });
                }
            });
        });
    });
    return out;
}

function mapWhatsAppStatus(metaStatus) {
    const s = String(metaStatus || '').toLowerCase();
    if (s === 'sent') return 'sent';
    if (s === 'delivered') return 'delivered';
    if (s === 'read') return 'read';
    if (s === 'failed') return 'failed';
    if (s === 'accepted') return 'accepted';
    return s || 'unknown';
}

function formatMetaErrors(errors) {
    if (!errors || !errors.length) return null;
    return errors
        .map((e) => {
            const code = e.code != null ? e.code : '';
            const title = e.title || e.message || '';
            const details = e.error_data && e.error_data.details ? e.error_data.details : '';
            return [code, title, details].filter(Boolean).join(': ');
        })
        .join(' | ')
        .slice(0, 900);
}

function insertDeliveryEvent(db, ev, cb) {
    const errDetail = formatMetaErrors(ev.errors);
    db.run(
        `INSERT INTO whatsapp_delivery_events (message_id, recipient, status, error_detail, raw_json)
         VALUES (?, ?, ?, ?, ?)`,
        [
            ev.messageId,
            ev.recipient || '',
            mapWhatsAppStatus(ev.status),
            errDetail,
            JSON.stringify(ev).slice(0, 4000)
        ],
        () => cb && cb()
    );
}

function updateNotificationByMessageId(db, messageId, status, errorDetail, cb) {
    if (!messageId) return cb && cb(null, 0);
    const mapped = mapWhatsAppStatus(status);
    const errText = errorDetail ? String(errorDetail).slice(0, 900) : null;
    db.run(
        `UPDATE notification_logs
         SET status = ?, error = CASE WHEN ? IS NOT NULL AND ? != '' THEN ? ELSE error END
         WHERE provider_message_id = ? OR body_preview LIKE ?`,
        [mapped, errText, errText, errText, messageId, '%' + messageId + '%'],
        function (err) {
            cb && cb(err, this.changes);
        }
    );
}

function handleWhatsAppWebhookPost(db, body, cb) {
    ensureWhatsAppWebhookSchema(db, () => {
        const events = extractStatusEvents(body);
        if (!events.length) {
            return cb(null, { updated: 0, events: 0, stored: 0 });
        }
        let pending = events.length;
        let updated = 0;
        let lastErr = null;
        events.forEach((ev) => {
            const errDetail = formatMetaErrors(ev.errors);
            insertDeliveryEvent(db, ev, () => {
                updateNotificationByMessageId(db, ev.messageId, ev.status, errDetail, (err, n) => {
                    if (err) lastErr = err;
                    updated += n || 0;
                    if (--pending === 0) {
                        cb(lastErr, { updated, events: events.length, statuses: events });
                    }
                });
            });
        });
    });
}

function getDeliveryEventsForMessage(db, messageId, cb) {
    ensureWhatsAppWebhookSchema(db, () => {
        db.all(
            `SELECT * FROM whatsapp_delivery_events WHERE message_id = ? ORDER BY id DESC LIMIT 20`,
            [messageId],
            (err, rows) => cb(err, rows || [])
        );
    });
}

function waitForDeliveryUpdate(db, messageId, timeoutMs, cb) {
    const deadline = Date.now() + (timeoutMs || 8000);
    const poll = () => {
        getDeliveryEventsForMessage(db, messageId, (err, rows) => {
            if (err) return cb(err);
            const failed = rows.find((r) => r.status === 'failed');
            if (failed) {
                return cb(null, {
                    status: 'failed',
                    error: failed.error_detail,
                    events: rows
                });
            }
            const delivered = rows.find((r) => r.status === 'delivered' || r.status === 'read');
            if (delivered) {
                return cb(null, {
                    status: delivered.status,
                    error: null,
                    events: rows
                });
            }
            const sent = rows.find((r) => r.status === 'sent');
            if (sent && Date.now() > deadline - 2000) {
                return cb(null, {
                    status: 'sent',
                    error: null,
                    events: rows
                });
            }
            if (Date.now() >= deadline) {
                return cb(null, {
                    status: rows[0] ? rows[0].status : 'accepted',
                    error: rows[0] && rows[0].error_detail ? rows[0].error_detail : null,
                    events: rows,
                    timeout: true
                });
            }
            setTimeout(poll, 1500);
        });
    };
    poll();
}

module.exports = {
    ensureWhatsAppWebhookSchema,
    extractStatusEvents,
    handleWhatsAppWebhookPost,
    updateNotificationByMessageId,
    mapWhatsAppStatus,
    getDeliveryEventsForMessage,
    waitForDeliveryUpdate,
    formatMetaErrors
};
