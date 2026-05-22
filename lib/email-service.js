/**
 * Zoho / generic SMTP email — Nodemailer.
 * Env: ZOHO_HOST, ZOHO_PORT, ZOHO_USER, ZOHO_PASS, ZOHO_FROM
 */
let nodemailer = null;
try {
    nodemailer = require('nodemailer');
} catch (_) {}

const integrationSettings = require('./integration-settings');

integrationSettings.registerTransporterReset(() => {
    transporterCache = null;
});

function mailConfig(overrides) {
    return integrationSettings.getMailConfig(overrides);
}

function isEmailConfigured() {
    return integrationSettings.isEmailConfiguredFromSettings();
}

let transporterCache = null;
let transporterCacheKey = '';

function transportCacheKey(cfg) {
    if (!cfg) return '';
    return [cfg.host, cfg.port, cfg.auth.user, cfg.auth.pass, cfg.from].join('|');
}

function buildTransportOptions(cfg) {
    const opts = {
        host: cfg.host,
        port: cfg.port,
        auth: cfg.auth,
        connectionTimeout: 35000,
        greetingTimeout: 35000,
        socketTimeout: 45000
    };
    if (cfg.port === 465) {
        opts.secure = true;
    } else if (cfg.port === 587) {
        opts.secure = false;
        opts.requireTLS = true;
    } else {
        opts.secure = !!cfg.secure;
        if (cfg.requireTLS) opts.requireTLS = true;
    }
    return opts;
}

function resetTransporter() {
    transporterCache = null;
    transporterCacheKey = '';
}

function getTransporter(overrides) {
    const cfg = mailConfig(overrides);
    if (!cfg || !nodemailer) return null;
    const key = transportCacheKey(cfg);
    if (!transporterCache || transporterCacheKey !== key) {
        transporterCache = nodemailer.createTransport(buildTransportOptions(cfg));
        transporterCacheKey = key;
    }
    return { transporter: transporterCache, from: cfg.from, cfg };
}

function formatFromAddress(fromEmail, displayName) {
    const addr = String(fromEmail || '').trim();
    if (!addr) return addr;
    const name = String(displayName || 'Vaidya Gogate Memorial Foundation').trim().replace(/"/g, "'");
    return `"${name}" <${addr}>`;
}

function explainSmtpError(err) {
    const msg = String((err && err.message) || err || 'Send failed');
    const code = err && err.responseCode;
    const lower = msg.toLowerCase();
    if (code === 535 || lower.includes('535') || lower.includes('authentication failed')) {
        return {
            error: msg,
            hint:
                'Zoho rejected the login. Use the full mailbox as User (e.g. care@vaidyagogate.org), ' +
                'an App-Specific Password (not your normal Zoho password), and the same address in From. ' +
                'Create the app password at Zoho Mail → Security → App Passwords (2FA must be on). ' +
                'Then Save API keys, then Test email. If it still fails, update ZOHO_PASS on Vercel and redeploy.'
        };
    }
    if (lower.includes('self signed') || lower.includes('certificate')) {
        return { error: msg, hint: 'Try port 465 with host smtp.zoho.in, or port 587 with TLS.' };
    }
    if (
        code === 550 ||
        lower.includes('550') ||
        lower.includes('5.4.6') ||
        lower.includes('unusual sending activity') ||
        lower.includes('rate limit') ||
        lower.includes('too many')
    ) {
        return {
            error: msg,
            hint:
                'Zoho blocked bulk sending (free SMTP daily/hourly limits). On-spot POS registrations no longer send email immediately — ' +
                'use the printed QR ticket at the venue. Queued emails drain slowly via /api/cron/process-notifications. ' +
                'To unblock the mailbox, open the link in the error and wait, or spread sends across hours. ' +
                'Admin → Website & doctor updates → Email delivery (venue / bulk).'
        };
    }
    return { error: msg, hint: null };
}

/**
 * Verify SMTP login before sending (used by admin test).
 * @param {object} [overrides] optional zoho_* fields from admin form
 */
async function verifySmtpConnection(overrides) {
    const pack = getTransporter(overrides);
    if (!pack) {
        return {
            ok: false,
            skipped: true,
            error: 'Email not configured',
            hint: 'Enter Zoho host, user, and app password, then Save API keys.'
        };
    }
    try {
        await pack.transporter.verify();
        return { ok: true, user: pack.cfg.auth.user, from: pack.from };
    } catch (e) {
        const explained = explainSmtpError(e);
        console.error('[email] verify failed:', explained.error);
        return { ok: false, ...explained };
    }
}

/**
 * @param {string} to
 * @param {string} subject
 * @param {string} html
 * @param {{ text?: string, smtpOverrides?: object }} [opts]
 */
async function sendEmail(to, subject, html, opts) {
    const overrides = opts && opts.smtpOverrides;
    const pack = getTransporter(overrides);
    if (!pack) {
        console.warn('[email] SMTP not configured (ZOHO_* or SMTP_* env vars).');
        return { ok: false, skipped: true, error: 'Email not configured' };
    }
    try {
        const fromAddr =
            opts && opts.fromEmail ? String(opts.fromEmail).trim() : pack.from;
        const display =
            opts && opts.fromDisplay ? String(opts.fromDisplay).trim() : 'Vaidya Gogate Memorial Foundation';
        const mail = {
            from: formatFromAddress(fromAddr || pack.from, display),
            to,
            subject,
            html: html || undefined,
            text: (opts && opts.text) || undefined
        };
        if (opts && Array.isArray(opts.attachments) && opts.attachments.length) {
            mail.attachments = opts.attachments;
        }
        if (opts && opts.replyTo) {
            mail.replyTo = opts.replyTo;
        }
        if (opts && opts.cc) {
            mail.cc = opts.cc;
        }
        await pack.transporter.sendMail(mail);
        return { ok: true };
    } catch (e) {
        const explained = explainSmtpError(e);
        const retryable =
            String(explained.error || '')
                .toLowerCase()
                .includes('timeout') ||
            String(explained.error || '')
                .toLowerCase()
                .includes('connection');
        if (retryable && !(opts && opts._emailRetried)) {
            await new Promise((r) => setTimeout(r, 1200));
            return sendEmail(to, subject, html, { ...(opts || {}), _emailRetried: true });
        }
        console.error('[email]', explained.error);
        return { ok: false, error: explained.error, hint: explained.hint };
    }
}

module.exports = {
    sendEmail,
    isEmailConfigured,
    mailConfig,
    verifySmtpConnection,
    resetTransporter,
    explainSmtpError
};
