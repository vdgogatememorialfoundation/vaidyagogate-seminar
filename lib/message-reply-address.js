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
    const care = String(process.env.SUPPORT_CARE_EMAIL || process.env.ADMIN_CONTACT_EMAIL || 'care@vaidyagogate.org').trim();
    const parser = parserInboxAddress();
    if (parser) return parser;
    const id = String(ticketCanonicalId || '').trim();
    if (!id) return care || null;
    const domain = replyDomain();
    if (String(process.env.INBOUND_PLUS_ADDRESSING || '0') === '1' && domain) {
        const safe = Buffer.from(id, 'utf8').toString('base64url');
        return `ticket-reply+${safe}@${domain}`;
    }
    return care;
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

function adminRefToken(threadId) {
    const id = parseInt(threadId, 10);
    if (!Number.isInteger(id) || id < 1) return '';
    return `VGMF-ADM-${id}`;
}

function buildAdminThreadReplyAddress(threadId) {
    const parser = parserInboxAddress();
    if (parser) return parser;
    const id = parseInt(threadId, 10);
    if (!Number.isInteger(id) || id < 1) return null;
    return `admin-reply+${id}@${replyDomain()}`;
}

function parseRefFromText(text) {
    const raw = String(text || '');
    let m = raw.match(/VGMF-ADM-(\d+)/i);
    if (m) {
        return { type: 'admin', threadId: parseInt(m[1], 10) };
    }
    m = raw.match(/VGMF-CASE-(\d+)-(\d+)/i);
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
    m = raw.match(/\b(TKT_[A-Za-z0-9_]+)\b/i);
    if (m) {
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
        return { type: 'ticket', ticketId: ticketM[1] };
    }
    let adminM = local.match(/^admin-reply\+(\d+)$/);
    if (adminM) {
        return { type: 'admin', threadId: parseInt(adminM[1], 10) };
    }
    return null;
}

function replyFooterNote(replyTo, refToken) {
    const care = String(process.env.SUPPORT_CARE_EMAIL || 'care@vaidyagogate.org').trim();
    let note =
        '\n\n—\nYou can reply to this email' +
        (replyTo ? ' (' + replyTo + ')' : care ? ' (' + care + ')' : '') +
        ' and your message will appear in the support ticket thread.';
    if (refToken) note += embedRefLine(refToken);
    note += '\nOr sign in to the doctor portal to reply there.';
    return note;
}

function supportTicketPortalFooter(portalUrl) {
    const url = String(portalUrl || '').trim() || '/doctor#tab-support';
    return '\n\n—\nSign in to the doctor portal to view and reply to this ticket:\n' + url;
}

module.exports = {
    replyDomain,
    parserInboxAddress,
    buildCaseReplyAddress,
    buildTicketReplyAddress,
    buildAdminThreadReplyAddress,
    caseRefToken,
    ticketRefToken,
    adminRefToken,
    embedRefLine,
    parseRefFromText,
    parseInboundRecipient,
    replyFooterNote,
    supportTicketPortalFooter
};
