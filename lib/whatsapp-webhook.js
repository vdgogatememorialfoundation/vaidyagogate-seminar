/**
 * Meta WhatsApp webhook — delivery status updates for notification_logs + central wa_messages,
 * inbound messages (opt-in/opt-out keywords, Flow replies).
 */
const crypto = require('crypto');
const central = require('./whatsapp-central');

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

function extractInboundMessages(body) {
    const out = [];
    const entries = (body && body.entry) || [];
    entries.forEach((entry) => {
        (entry.changes || []).forEach((change) => {
            const value = change.value || {};
            const names = {};
            (value.contacts || []).forEach((c) => {
                if (c && c.wa_id) names[c.wa_id] = c.profile && c.profile.name;
            });
            (value.messages || []).forEach((m) => {
                if (!m || !m.from) return;
                let text = '';
                let flowReply = null;
                if (m.type === 'text' && m.text) text = m.text.body || '';
                else if (m.type === 'button' && m.button) text = m.button.text || m.button.payload || '';
                else if (m.type === 'interactive' && m.interactive) {
                    const it = m.interactive;
                    if (it.button_reply) text = it.button_reply.title || it.button_reply.id || '';
                    else if (it.list_reply) text = it.list_reply.title || it.list_reply.id || '';
                    else if (it.nfm_reply) {
                        text = it.nfm_reply.body || 'Flow reply';
                        try {
                            flowReply = JSON.parse(it.nfm_reply.response_json || '{}');
                        } catch (_) {
                            flowReply = {};
                        }
                    }
                }
                out.push({ messageId: m.id, from: m.from, type: m.type, text, name: names[m.from] || null, flowReply, timestamp: m.timestamp });
            });
        });
    });
    return out;
}

function handleInboundMessages(db, body, cb) {
    const msgs = extractInboundMessages(body);
    if (!msgs.length) return cb(null, 0);
    central.ensureSchema(db, () => {
        central.loadSettings(db, (eS, settings) => {
            let pending = msgs.length;
            const done = () => {
                if (--pending === 0) cb(null, msgs.length);
            };
            msgs.forEach((m) => {
                central.logMessage(
                    db,
                    { providerMessageId: m.messageId, direction: 'in', phone: m.from, messageType: m.flowReply ? 'flow_reply' : m.type || 'text', preview: m.text, status: 'received' },
                    () => {
                        central.recordInbound(db, m.from, m.text, m.name, () => {
                            if (m.flowReply && m.flowReply.flow_token) {
                                db.run(
                                    `UPDATE wa_flow_sessions SET status = 'completed', data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE flow_token = ?`,
                                    [JSON.stringify(m.flowReply).slice(0, 20000), String(m.flowReply.flow_token)],
                                    () => {}
                                );
                            }
                            const kw = central.classifyKeyword(m.text);

                            const incomingText = String(m.text || '').trim().toLowerCase();
                            const shouldStartFlow = !m.flowReply && /^(hi|hello|hey|register|registration|register now)$/i.test(incomingText);

                            if (shouldStartFlow) {
                                const flowToken = crypto.randomBytes(16).toString('hex');

                                db.run(
                                    `INSERT INTO wa_flow_sessions
                                     (flow_token, flow_id, meta_flow_id, phone, first_screen, last_screen, last_action, data_json, status)
                                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                                    [
                                        flowToken,
                                        1,
                                        '926980180059857',
                                        m.from,
                                        'WELCOME',
                                        'WELCOME',
                                        'start',
                                        JSON.stringify({}),
                                        'open'
                                    ],
                                    (flowErr) => {
                                        if (flowErr) {
                                            console.error('[whatsapp-webhook] Flow session create failed:', flowErr.message);
                                            return done();
                                        }

                                        central.send(
                                            db,
                                            {
                                                kind: 'flow',
                                                phone: m.from,
                                                flow: {
                                                    flowId: '926980180059857',
                                                    flowToken,
                                                    cta: 'Register Now',
                                                    body: 'Register for the Vaidya Gogate Memorial Foundation National Seminar.',
                                                    header: 'Vaidya Gogate Memorial Foundation',
                                                    firstScreen: 'WELCOME'
                                                },
                                                meta: {
                                                    messageType: 'flow',
                                                    bypassOptOut: true
                                                }
                                            },
                                            (sendErr, result) => {
                                                if (sendErr || !result || !result.ok) {
                                                    console.error('[whatsapp-webhook] Hi Flow send failed:', (sendErr && sendErr.message) || (result && result.error) || 'Unknown error');
                                                } else {
                                                    console.log('[whatsapp-webhook] Registration Flow sent to', m.from, 'messageId=', result.messageId || '');
                                                }
                                                done();
                                            }
                                        );
                                    }
                                );

                                return;
                            }

                            if (!kw || Number((settings || {}).opt_out_enabled) !== 1) return done();
                            central.setOptStatus(db, m.from, kw === 'out', 'inbound_keyword', () => {
                                const reply = kw === 'out' ? settings.opt_out_reply : settings.opt_in_reply;
                                if (!reply) return done();
                                central.send(db, { kind: 'text', phone: m.from, body: reply, meta: { messageType: kw === 'out' ? 'opt_out_ack' : 'opt_in_ack', bypassOptOut: true } }, () => done());
                            });
                        });
                    }
                );
            });
        });
    });
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
        errText
            ? `UPDATE notification_logs SET status = ?, error = ?
               WHERE provider_message_id = ? OR body_preview LIKE ?`
            : `UPDATE notification_logs SET status = ?
               WHERE provider_message_id = ? OR body_preview LIKE ?`,
        errText
            ? [mapped, errText, messageId, '%' + messageId + '%']
            : [mapped, messageId, '%' + messageId + '%'],
        function (err) {
            cb && cb(err, this.changes);
        }
    );
}

function handleWhatsAppWebhookPost(db, body, cb) {
    ensureWhatsAppWebhookSchema(db, () => {
        const events = extractStatusEvents(body);
        handleInboundMessages(db, body, (eIn, inboundCount) => {
            if (eIn) console.warn('[whatsapp-webhook] inbound', eIn.message);
            if (!events.length) {
                return cb(null, { updated: 0, events: 0, stored: 0, inbound: inboundCount || 0 });
            }
            let pending = events.length;
            let updated = 0;
            let lastErr = null;
            events.forEach((ev) => {
                const errDetail = formatMetaErrors(ev.errors);
                insertDeliveryEvent(db, ev, () => {
                    central.applyDeliveryStatus(db, ev.messageId, mapWhatsAppStatus(ev.status), errDetail, () => {
                        updateNotificationByMessageId(db, ev.messageId, ev.status, errDetail, (err, n) => {
                            if (err) lastErr = err;
                            updated += n || 0;
                            if (--pending === 0) {
                                cb(lastErr, { updated, events: events.length, statuses: events, inbound: inboundCount || 0 });
                            }
                        });
                    });
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
    extractInboundMessages,
    handleWhatsAppWebhookPost,
    updateNotificationByMessageId,
    mapWhatsAppStatus,
    getDeliveryEventsForMessage,
    waitForDeliveryUpdate,
    formatMetaErrors
};
