/**
 * Poll Zoho Mail (or any IMAP inbox) for inbound replies — no Mailparser.io required.
 * Uses the same Zoho app password as SMTP standby (Admin → Integrations).
 *
 * Env:
 *   INBOUND_IMAP_ENABLED=1          (default on when credentials exist)
 *   INBOUND_IMAP_HOST=imap.zoho.in  (auto from smtp.zoho.in)
 *   INBOUND_IMAP_USER=care@…        (default SUPPORT_CARE_EMAIL or ZOHO_USER)
 *   INBOUND_IMAP_PASS               (default ZOHO_PASS from env / admin settings)
 *   INBOUND_IMAP_MAILBOX=INBOX
 *   INBOUND_IMAP_POLL_MS=120000     (in-process poll; also use /api/cron/poll-inbound-mail)
 */
const integrationSettings = require('./integration-settings');
const { careReplyToEmail } = require('./support-care-email');
const inboundMailReply = require('./inbound-mail-reply');

let ImapFlow = null;
try {
    ImapFlow = require('imapflow').ImapFlow;
} catch (_) {}

let pollTimer = null;
let pollRunning = false;

function imapExplicitlyDisabled() {
    return String(process.env.INBOUND_IMAP_ENABLED || '').trim() === '0';
}

function imapExplicitlyEnabled() {
    const v = String(process.env.INBOUND_IMAP_ENABLED || '').trim();
    return v === '1' || v === 'true' || v === 'yes';
}

function deriveImapHost(smtpHost) {
    const h = String(smtpHost || 'smtp.zoho.in').trim();
    if (/^smtp\./i.test(h)) return h.replace(/^smtp\./i, 'imap.');
    if (process.env.INBOUND_IMAP_HOST) return String(process.env.INBOUND_IMAP_HOST).trim();
    return 'imap.zoho.in';
}

function resolvePass(rt) {
    let pass =
        process.env.INBOUND_IMAP_PASS ||
        rt.zoho_pass ||
        process.env.ZOHO_PASS ||
        '';
    pass = String(pass || '').trim();
    if (integrationSettings.isMaskedSecretValue(pass)) {
        pass = String(process.env.ZOHO_PASS || '').trim();
    }
    return pass;
}

function getImapConfig() {
    if (imapExplicitlyDisabled()) return null;
    const rt = integrationSettings.getRuntimeIntegrations();
    const pass = resolvePass(rt);
    const user =
        integrationSettings.normalizeEmail(
            process.env.INBOUND_IMAP_USER ||
                process.env.SUPPORT_CARE_EMAIL ||
                careReplyToEmail() ||
                rt.zoho_user ||
                process.env.ZOHO_USER
        ) || '';
    if (!user || !pass) return null;
    const smtpHost = rt.zoho_host || process.env.ZOHO_HOST || 'smtp.zoho.in';
    const host = String(process.env.INBOUND_IMAP_HOST || deriveImapHost(smtpHost)).trim();
    const port = parseInt(process.env.INBOUND_IMAP_PORT || '993', 10) || 993;
    const mailbox = String(process.env.INBOUND_IMAP_MAILBOX || 'INBOX').trim() || 'INBOX';
    return { host, port, secure: port === 993, auth: { user, pass }, mailbox, user };
}

function isConfigured() {
    return !!(ImapFlow && getImapConfig());
}

function ensureProcessedSchema(db, cb) {
    const pg = !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
    const ts = pg ? 'TIMESTAMPTZ' : 'DATETIME';
    db.run(
        pg
            ? `CREATE TABLE IF NOT EXISTS inbound_mail_processed (
                mailbox TEXT NOT NULL,
                message_uid TEXT NOT NULL,
                processed_at ${ts} DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (mailbox, message_uid)
            )`
            : `CREATE TABLE IF NOT EXISTS inbound_mail_processed (
                mailbox TEXT NOT NULL,
                message_uid TEXT NOT NULL,
                processed_at ${ts} DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (mailbox, message_uid)
            )`,
        (e) => cb && cb(e)
    );
}

function alreadyProcessed(db, mailbox, uid, cb) {
    db.get(
        `SELECT 1 AS ok FROM inbound_mail_processed WHERE mailbox = ? AND message_uid = ?`,
        [mailbox, String(uid)],
        (e, row) => cb(e, !!(row && row.ok))
    );
}

function recordProcessed(db, mailbox, uid, cb) {
    const pg = !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
    if (pg) {
        return db.run(
            `INSERT INTO inbound_mail_processed (mailbox, message_uid) VALUES (?, ?)
             ON CONFLICT (mailbox, message_uid) DO NOTHING`,
            [mailbox, String(uid)],
            cb
        );
    }
    return db.run(
        `INSERT OR IGNORE INTO inbound_mail_processed (mailbox, message_uid) VALUES (?, ?)`,
        [mailbox, String(uid)],
        cb
    );
}

function normalizeAddresses(list) {
    return (list || [])
        .map((a) => {
            if (!a) return '';
            if (typeof a === 'string') return a;
            if (a.address) return a.address;
            return '';
        })
        .filter(Boolean);
}

async function fetchAndProcessUnseen(db, cfg) {
    if (!ImapFlow) throw new Error('imapflow package not installed');
    const client = new ImapFlow({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        auth: cfg.auth,
        logger: false,
        tls: { minVersion: 'TLSv1.2', servername: cfg.host }
    });

    const stats = { scanned: 0, processed: 0, skipped: 0, errors: [] };

    await client.connect();
    try {
        const lock = await client.getMailboxLock(cfg.mailbox);
        try {
            const unseen = await client.search({ seen: false });
            for (const uid of unseen) {
                stats.scanned++;
                const done = await new Promise((resolve) => {
                    alreadyProcessed(db, cfg.mailbox, uid, (eCheck, seen) => {
                        if (eCheck) {
                            stats.errors.push(eCheck.message);
                            return resolve();
                        }
                        if (seen) {
                            stats.skipped++;
                            client.messageFlagsAdd(uid, ['\\Seen']).catch(() => {});
                            return resolve();
                        }
                        resolve(null);
                    });
                });
                if (done !== null) continue;

                let msg;
                try {
                    msg = await client.fetchOne(uid, {
                        envelope: true,
                        source: true,
                        uid: true
                    });
                } catch (fetchErr) {
                    stats.errors.push(fetchErr.message);
                    continue;
                }
                if (!msg) continue;

                const env = msg.envelope || {};
                const fromAddr = (env.from && env.from[0] && env.from[0].address) || '';
                const toList = []
                    .concat(normalizeAddresses(env.to))
                    .concat(normalizeAddresses(env.cc))
                    .concat(normalizeAddresses(env.replyTo));

                let text = '';
                let html = '';
                if (msg.source) {
                    const raw = msg.source.toString('utf8');
                    const textMatch = raw.match(/\r?\n\r?\n([\s\S]*)/);
                    if (textMatch) text = textMatch[1].slice(0, 120000);
                    html = text;
                }

                await new Promise((resolve) => {
                    inboundMailReply.processInboundEmail(
                        db,
                        {
                            from: fromAddr,
                            toList,
                            subject: env.subject || '',
                            text,
                            html,
                            provider: 'imap'
                        },
                        (err) => {
                            if (err) {
                                if (!inboundMailReply.isIgnorableInboundError(err)) {
                                    stats.errors.push(err.message);
                                } else {
                                    stats.skipped++;
                                }
                            } else {
                                stats.processed++;
                            }
                            recordProcessed(db, cfg.mailbox, uid, () => {
                                client.messageFlagsAdd(uid, ['\\Seen']).finally(resolve);
                            });
                        }
                    );
                });
            }
        } finally {
            lock.release();
        }
    } finally {
        await client.logout().catch(() => {});
    }
    return stats;
}

function pollOnce(db, cb) {
    if (typeof cb !== 'function') cb = () => {};
    if (!ImapFlow) {
        return cb(new Error('imapflow not installed — run npm install imapflow'));
    }
    const cfg = getImapConfig();
    if (!cfg) {
        return cb(null, { skipped: true, reason: 'IMAP not configured (set Zoho app password + INBOUND_IMAP_USER)' });
    }
    if (pollRunning) {
        return cb(null, { skipped: true, reason: 'poll already running' });
    }
    pollRunning = true;
    ensureProcessedSchema(db, (schemaErr) => {
        if (schemaErr) {
            pollRunning = false;
            return cb(schemaErr);
        }
        fetchAndProcessUnseen(db, cfg)
            .then((stats) => {
                pollRunning = false;
                if (stats.processed > 0) {
                    console.log('[inbound-imap] processed', stats.processed, 'of', stats.scanned, 'unseen');
                }
                cb(null, { ok: true, mailbox: cfg.user, ...stats });
            })
            .catch((err) => {
                pollRunning = false;
                console.warn('[inbound-imap]', err.message);
                cb(err);
            });
    });
}

function status() {
    const cfg = getImapConfig();
    return {
        mode: 'imap',
        imapflowInstalled: !!ImapFlow,
        configured: isConfigured(),
        explicitlyDisabled: imapExplicitlyDisabled(),
        explicitlyEnabled: imapExplicitlyEnabled(),
        mailbox: cfg ? cfg.user : null,
        host: cfg ? cfg.host : null,
        pollMs: parseInt(process.env.INBOUND_IMAP_POLL_MS || '120000', 10) || 120000,
        webhookPath: '/api/webhooks/inbound-email',
        webhookOptional: true,
        hint: !ImapFlow
            ? 'Run npm install imapflow on the server.'
            : !cfg
              ? 'Save Zoho app password in Admin → Integrations (SMTP standby). Set INBOUND_IMAP_USER to care@vaidyagogate.org on Render.'
              : 'Inbound replies poll your Zoho inbox automatically — include [VGMF-TKT-…] in ticket emails or reply without removing that line.'
    };
}

function startBackgroundPoll(db) {
    if (pollTimer || !isConfigured()) return;
    const ms = Math.max(60000, parseInt(process.env.INBOUND_IMAP_POLL_MS || '120000', 10) || 120000);
    const tick = () => {
        pollOnce(db, (err, result) => {
            if (err) console.warn('[inbound-imap] background', err.message);
            else if (result && result.processed) console.log('[inbound-imap] background ok', result.processed);
        });
    };
    setTimeout(tick, 15000);
    pollTimer = setInterval(tick, ms);
    console.log('[inbound-imap] background poll every', Math.round(ms / 1000), 's →', getImapConfig().user);
}

function stopBackgroundPoll() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

module.exports = {
    getImapConfig,
    isConfigured,
    pollOnce,
    status,
    startBackgroundPoll,
    stopBackgroundPoll
};
