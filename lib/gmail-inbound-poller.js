/**
 * Poll Gmail via IMAP (free) for support ticket / thread replies.
 * Forward care@vaidyagogate.org → vd.gogatememorialfoundation@gmail.com in Zoho Mail,
 * then set GMAIL_INBOUND_USER + App Password on Render.
 */
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const inboundMailIngest = require('./inbound-mail-ingest');
const emailParserNormalize = require('./email-parser-normalize');

let pollTimer = null;
let polling = false;

function enabled() {
    if (String(process.env.GMAIL_INBOUND_ENABLED || '1') === '0') return false;
    const user = String(process.env.GMAIL_INBOUND_USER || '').trim();
    const pass = String(process.env.GMAIL_INBOUND_APP_PASSWORD || '').trim();
    return !!(user && pass);
}

function pollIntervalMs() {
    const n = parseInt(process.env.GMAIL_INBOUND_POLL_MS, 10);
    return Number.isFinite(n) && n >= 30000 ? n : 120000;
}

function status() {
    const user = String(process.env.GMAIL_INBOUND_USER || '').trim();
    return {
        enabled: enabled(),
        user: user ? user.replace(/^(.).+(@.+)$/, '$1***$2') : null,
        pollMs: pollIntervalMs(),
        hint: enabled()
            ? 'Gmail IMAP poller active — replies to care@ (forwarded to this inbox) sync into support tickets.'
            : 'Set GMAIL_INBOUND_USER and GMAIL_INBOUND_APP_PASSWORD (Google App Password) on the server.'
    };
}

async function pollOnce(db) {
    if (!enabled() || polling) return { skipped: true };
    polling = true;
    const user = String(process.env.GMAIL_INBOUND_USER || '').trim();
    const pass = String(process.env.GMAIL_INBOUND_APP_PASSWORD || '').trim();
    const client = new ImapFlow({
        host: String(process.env.GMAIL_IMAP_HOST || 'imap.gmail.com'),
        port: parseInt(process.env.GMAIL_IMAP_PORT, 10) || 993,
        secure: true,
        auth: { user, pass },
        logger: false
    });

    const stats = { scanned: 0, ingested: 0, skipped: 0, errors: 0 };

    try {
        await client.connect();
        const lock = await client.getMailboxLock('INBOX');
        try {
            const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
            const uids = await client.search({ since, seen: false });
            for (const uid of uids) {
                stats.scanned++;
                let messageKey = 'gmail:' + uid;
                try {
                    const msg = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
                    if (!msg || !msg.source) {
                        stats.skipped++;
                        continue;
                    }
                    const parsed = await simpleParser(msg.source);
                    if (parsed.messageId) messageKey = 'mid:' + String(parsed.messageId).trim();

                    const norm = {
                        from: parsed.from && parsed.from.text ? parsed.from.text : '',
                        subject: parsed.subject || '',
                        text: parsed.text || '',
                        html: parsed.html || '',
                        toList: emailParserNormalize.collectToAddresses({
                            to: parsed.to,
                            cc: parsed.cc,
                            subject: parsed.subject,
                            text: parsed.text
                        })
                    };

                    await new Promise((resolve) => {
                        inboundMailIngest.processInboundNormalized(
                            db,
                            norm,
                            { provider: 'gmail', messageKey },
                            (err) => {
                                if (err) {
                                    if (/already processed/i.test(err.message)) stats.skipped++;
                                    else if (inboundMailIngest.isClientError(err)) {
                                        stats.skipped++;
                                        console.warn('[gmail-inbound] skip uid', uid, err.message);
                                    } else {
                                        stats.errors++;
                                        console.warn('[gmail-inbound] uid', uid, err.message);
                                    }
                                } else {
                                    stats.ingested++;
                                }
                                resolve();
                            }
                        );
                    });

                    await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
                } catch (eMsg) {
                    stats.errors++;
                    console.warn('[gmail-inbound] message', uid, eMsg.message);
                    try {
                        await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
                    } catch (_) {}
                }
            }
        } finally {
            lock.release();
        }
        await client.logout();
    } catch (e) {
        console.warn('[gmail-inbound] poll failed:', e.message);
        stats.errors++;
        try {
            await client.logout();
        } catch (_) {}
    } finally {
        polling = false;
    }
    if (stats.ingested > 0) {
        console.log('[gmail-inbound] ingested', stats.ingested, 'of', stats.scanned, 'unread');
    }
    return stats;
}

function startGmailInboundPoller(db) {
    if (!enabled()) {
        console.log('[gmail-inbound] disabled — set GMAIL_INBOUND_USER + GMAIL_INBOUND_APP_PASSWORD to enable');
        return;
    }
    if (pollTimer) return;
    const ms = pollIntervalMs();
    console.log('[gmail-inbound] polling', status().user, 'every', Math.round(ms / 1000), 's');
    pollTimer = setInterval(() => {
        pollOnce(db).catch((e) => console.warn('[gmail-inbound]', e.message));
    }, ms);
    setTimeout(() => {
        pollOnce(db).catch((e) => console.warn('[gmail-inbound]', e.message));
    }, 20000);
}

function stopGmailInboundPoller() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
}

module.exports = {
    enabled,
    status,
    pollOnce,
    startGmailInboundPoller,
    stopGmailInboundPoller
};
