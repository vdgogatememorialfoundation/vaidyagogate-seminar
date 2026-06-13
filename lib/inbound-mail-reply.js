/**
 * Ingest inbound email via webhook (SendGrid / Mailgun / generic) or Gmail IMAP poller.
 * POST /api/webhooks/inbound-email  (header x-inbound-mail-secret)
 */
const emailParserNormalize = require('./email-parser-normalize');
const inboundMailIngest = require('./inbound-mail-ingest');

function webhookSecretOk(req) {
    const expected = String(process.env.INBOUND_MAIL_WEBHOOK_SECRET || '').trim();
    if (!expected) return false;
    const got =
        String(req.headers['x-inbound-mail-secret'] || req.headers['x-webhook-secret'] || '').trim() ||
        String((req.body && req.body.secret) || '').trim();
    return got === expected;
}

function handleInboundMail(db, req, res) {
    if (!webhookSecretOk(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const norm = emailParserNormalize.normalizeInboundPayload(req.body || {});
    const messageKey =
        String(req.headers['message-id'] || req.headers['x-message-id'] || norm.messageId || '').trim() ||
        'webhook:' + Date.now();

    inboundMailIngest.processInboundNormalized(db, norm, { provider: norm.provider || 'webhook', messageKey }, (err, result) => {
        if (err) {
            console.warn('[inbound-mail]', err.message);
            const code = inboundMailIngest.isClientError(err) ? 400 : 500;
            return res.status(code).json({ error: err.message });
        }
        res.json(result);
    });
}

module.exports = {
    handleInboundMail,
    extractMessageText: (norm) => {
        const n = emailParserNormalize.normalizeInboundPayload(norm || {});
        return n.text || '';
    },
    stripQuotedReply: inboundMailIngest.stripQuotedReply
};
