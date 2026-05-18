/**
 * Meta WhatsApp webhook — delivery status updates for notification_logs.
 */
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
    return s || 'unknown';
}

function updateNotificationByMessageId(db, messageId, status, errorDetail, cb) {
    if (!messageId) return cb && cb(null, 0);
    const mapped = mapWhatsAppStatus(status);
    const errText = errorDetail ? String(errorDetail).slice(0, 900) : null;
    db.run(
        `UPDATE notification_logs
         SET status = ?, error = CASE WHEN ? IS NOT NULL THEN ? ELSE error END
         WHERE provider_message_id = ? OR body_preview LIKE ?`,
        [mapped, errText, errText, messageId, '%' + messageId + '%'],
        function (err) {
            cb && cb(err, this.changes);
        }
    );
}

function handleWhatsAppWebhookPost(db, body, cb) {
    const events = extractStatusEvents(body);
    if (!events.length) return cb(null, { updated: 0, events: 0 });
    let pending = events.length;
    let updated = 0;
    let lastErr = null;
    events.forEach((ev) => {
        let errDetail = null;
        if (ev.errors && ev.errors.length) {
            errDetail = JSON.stringify(ev.errors).slice(0, 500);
        }
        updateNotificationByMessageId(db, ev.messageId, ev.status, errDetail, (err, n) => {
            if (err) lastErr = err;
            updated += n || 0;
            if (--pending === 0) cb(lastErr, { updated, events: events.length, statuses: events });
        });
    });
}

module.exports = {
    extractStatusEvents,
    handleWhatsAppWebhookPost,
    updateNotificationByMessageId,
    mapWhatsAppStatus
};
