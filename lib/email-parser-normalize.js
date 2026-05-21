/**
 * Normalize inbound payloads from Mailparser.io, SendGrid, Mailgun, Postmark, and generic webhooks.
 * @see https://mailparser.io — recommended when Zoho has no inbound routing.
 */
function asString(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(asString).filter(Boolean).join(', ');
    if (typeof v === 'object') {
        return v.address || v.email || v.value || v.text || '';
    }
    return String(v);
}

function collectToAddresses(body) {
    const out = [];
    const add = (v) => {
        asString(v)
            .split(/[,;]/)
            .map((s) => s.trim())
            .filter(Boolean)
            .forEach((a) => out.push(a));
    };
    add(body.to);
    add(body.recipient);
    add(body.envelope_to);
    add(body.To);
    add(body.headers && body.headers.to);
    if (body.envelope && body.envelope.to) add(body.envelope.to);
    if (Array.isArray(body.to)) {
        body.to.forEach((t) => add(t));
    }
    if (body['recipient-address']) add(body['recipient-address']);
    if (body.mailparser && body.mailparser.recipient) add(body.mailparser.recipient);
    return [...new Set(out)];
}

function normalizeInboundPayload(raw) {
    const body = raw || {};
    let from = asString(body.from || body.sender || body.From || body.headers && body.headers.from);
    let subject = asString(body.subject || body.Subject || '');
    let text = asString(
        body.text ||
            body.plain ||
            body['text/plain'] ||
            body['stripped-text'] ||
            body.body_plain ||
            ''
    );
    let html = asString(
        body.html || body['text/html'] || body['stripped-html'] || body.body_html || ''
    );

    if (body.payload && typeof body.payload === 'object') {
        const nested = normalizeInboundPayload(body.payload);
        from = from || nested.from;
        subject = subject || nested.subject;
        text = text || nested.text;
        html = html || nested.html;
    }

    if (Array.isArray(body) && body[0]) {
        const nested = normalizeInboundPayload(body[0]);
        return { ...nested, toList: collectToAddresses(body[0]) };
    }

    if (body.data && typeof body.data === 'object') {
        const nested = normalizeInboundPayload(body.data);
        from = from || nested.from;
        subject = subject || nested.subject;
        text = text || nested.text;
        html = html || nested.html;
    }

    return {
        from,
        subject,
        text,
        html,
        toList: collectToAddresses(body),
        provider: detectProvider(body)
    };
}

function detectProvider(body) {
    if (body['mailparser-inbox'] || body.mailparser) return 'mailparser';
    if (body.envelope && body['stripped-text'] != null) return 'mailgun';
    if (body.from && body.to && body.text && body.charsets) return 'sendgrid';
    return 'generic';
}

module.exports = {
    normalizeInboundPayload,
    collectToAddresses,
    asString
};
