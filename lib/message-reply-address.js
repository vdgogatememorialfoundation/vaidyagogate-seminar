/**
 * Thread refs for support tickets & case messages (email parser + optional plus-address Reply-To).
 */
function replyDomain() {
    const explicit = String(process.env.INBOUND_REPLY_DOMAIN || '').trim();
    if (explicit) return explicit;
    const from = String(process.env.ZOHO_FROM || process.env.ADMIN_CONTACT_EMAIL || '').trim();
    const at = from.indexOf('@');
    if (at > 0) return from.slice(at + 1);
    return 'vaidyagogate.org';
}

/** Mailparser.io (or similar) inbox — set when Zoho has no inbound routing. */
function parserInboxAddress() {
    return String(process.env.MAILPARSER_INBOUND_EMAIL || process.env.EMAIL_PARSER_INBOX || '').trim();
}

function buildCaseReplyAddress(submissionId, judgeUserId) {
    const parser = parserInboxAddress();
    if (parser) return parser;
    const sid = parseInt(submissionId, 10);
    const jid = parseInt(judgeUserId, 10);
    if (!Number.isInteger(sid) || sid < 1 || !Number.isInteger(jid) || jid < 1) return null;
    return `case-reply+${sid}.${jid}@${replyDomain()}`;
}

function buildTicketReplyAddress(ticketCanonicalId) {
    const parser = parserInboxAddress();
    if (parser) return parser;
    const id = String(ticketCanonicalId || '').trim();
    if (!id) return null;
    const safe = Buffer.from(id, 'utf8').toString('base64url');
    return `ticket-reply+${safe}@${replyDomain()}`;
}

function caseRefToken(submissionId, judgeUserId) {
    const sid = parseInt(submissionId, 10);
    const jid = parseInt(judgeUserId, 10);
    if (!Number.isInteger(sid) || !Number.isInteger(jid)) return '';
    return `VGMF-CASE-${sid}-${jid}`;
}

function ticketRefToken(ticketCanonicalId) {
    const id = String(ticketCanonicalId || '').trim();
    if (!id) return '';
    return `VGMF-TKT-${Buffer.from(id, 'utf8').toString('base64url')}`;
}

function embedRefLine(refToken) {
    if (!refToken) return '';
    return `\n\n[${refToken}]`;
}

function parseRefFromText(text) {
    const raw = String(text || '');
    let m = raw.match(/VGMF-CASE-(\d+)-(\d+)/i);
    if (m) {
        return { type: 'case', submissionId: parseInt(m[1], 10), judgeUserId: parseInt(m[2], 10) };
    }
    m = raw.match(/VGMF-TKT-([A-Za-z0-9_-]+)/i);
    if (m) {
        try {
            const ticketId = Buffer.from(m[1], 'base64url').toString('utf8');
            if (ticketId) return { type: 'ticket', ticketId };
        } catch (_) {}
        return { type: 'ticket', ticketId: m[1] };
    }
    return null;
}

function parseInboundRecipient(addr) {
    const raw = String(addr || '').trim().toLowerCase();
    const m = raw.match(/<?([^@\s<>]+)@([^>\s]+)>?/);
    if (!m) return null;
    const local = m[1];
    const domain = m[2];
    const relax = String(process.env.MAIL_PARSER_RELAX_DOMAIN || '1') !== '0';
    if (!relax && domain !== replyDomain().toLowerCase()) return null;

    let caseM = local.match(/^case-reply\+(\d+)\.(\d+)$/);
    if (caseM) {
        return { type: 'case', submissionId: parseInt(caseM[1], 10), judgeUserId: parseInt(caseM[2], 10) };
    }
    let ticketM = local.match(/^ticket-reply\+([a-z0-9_-]+)$/i);
    if (ticketM) {
        try {
            const ticketId = Buffer.from(ticketM[1], 'base64url').toString('utf8');
            if (ticketId) return { type: 'ticket', ticketId };
        } catch (_) {}
    }
    return null;
}

function replyFooterNote(replyTo, refToken) {
    let note =
        '\n\n—\nReply to this email and your message will appear in the portal thread (include the reference line below).';
    if (refToken) note += embedRefLine(refToken);
    else if (replyTo) note += '\n\nOr sign in to the portal to reply there.';
    return note;
}

module.exports = {
    replyDomain,
    parserInboxAddress,
    buildCaseReplyAddress,
    buildTicketReplyAddress,
    caseRefToken,
    ticketRefToken,
    embedRefLine,
    parseRefFromText,
    parseInboundRecipient,
    replyFooterNote
};
