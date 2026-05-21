/**
 * Plus-address Reply-To for threading inbound email replies into portal messages.
 * Configure INBOUND_REPLY_DOMAIN (defaults to ZOHO_FROM domain).
 */
function replyDomain() {
    const explicit = String(process.env.INBOUND_REPLY_DOMAIN || '').trim();
    if (explicit) return explicit;
    const from = String(process.env.ZOHO_FROM || process.env.ADMIN_CONTACT_EMAIL || '').trim();
    const at = from.indexOf('@');
    if (at > 0) return from.slice(at + 1);
    return 'vaidyagogate.org';
}

function buildCaseReplyAddress(submissionId, judgeUserId) {
    const sid = parseInt(submissionId, 10);
    const jid = parseInt(judgeUserId, 10);
    if (!Number.isInteger(sid) || sid < 1 || !Number.isInteger(jid) || jid < 1) return null;
    return `case-reply+${sid}.${jid}@${replyDomain()}`;
}

function buildTicketReplyAddress(ticketCanonicalId) {
    const id = String(ticketCanonicalId || '').trim();
    if (!id) return null;
    const safe = Buffer.from(id, 'utf8').toString('base64url');
    return `ticket-reply+${safe}@${replyDomain()}`;
}

function parseInboundRecipient(addr) {
    const raw = String(addr || '').trim().toLowerCase();
    const m = raw.match(/<?([^@\s<>]+)@([^>\s]+)>?/);
    if (!m) return null;
    const local = m[1];
    const domain = m[2];
    if (domain !== replyDomain().toLowerCase()) return null;

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

function replyFooterNote(replyTo) {
    if (!replyTo) return '';
    return (
        '\n\n—\nYou can reply to this email and your message will appear in the portal thread. ' +
        'Or sign in to the portal to reply there.'
    );
}

module.exports = {
    replyDomain,
    buildCaseReplyAddress,
    buildTicketReplyAddress,
    parseInboundRecipient,
    replyFooterNote
};
