/**
 * Email delivery — ZeptoMail HTTPS (primary) → Sender.net (fallback) → Zoho SMTP (standby).
 * Env: EMAIL_API_PROVIDER=zeptomail, ZEPTOMAIL_TOKEN, EMAIL_API_FALLBACK_PROVIDER=sender, SENDER_NET_API_TOKEN
 */
let nodemailer = null;
try {
    nodemailer = require('nodemailer');
} catch (_) {}

const dns = require('dns');
const integrationSettings = require('./integration-settings');
const httpTransport = require('./email-http-transport');

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

function buildTransportOptions(cfg, portOverride) {
    const port = portOverride != null ? Number(portOverride) : cfg.port;
    const opts = {
        host: cfg.host,
        port,
        auth: cfg.auth,
        pool: false,
        connectionTimeout: 60000,
        greetingTimeout: 60000,
        socketTimeout: 90000,
        dnsTimeout: 25000,
        tls: { servername: cfg.host, minVersion: 'TLSv1.2' },
        lookup: (hostname, _options, callback) => {
            dns.lookup(hostname, { family: 4 }, callback);
        }
    };
    if (port === 465) {
        opts.secure = true;
    } else if (port === 587) {
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

function getTransporter(overrides, portOverride) {
    const cfg = mailConfig(overrides);
    if (!cfg || !nodemailer) return null;
    const port = portOverride != null ? Number(portOverride) : cfg.port;
    const key = [cfg.host, port, cfg.auth.user, cfg.auth.pass, cfg.from].join('|');
    if (!transporterCache || transporterCacheKey !== key) {
        transporterCache = nodemailer.createTransport(buildTransportOptions(cfg, port));
        transporterCacheKey = key;
    }
    return { transporter: transporterCache, from: cfg.from, cfg: { ...cfg, port } };
}

function formatFromAddress(fromEmail, displayName) {
    const addr = String(fromEmail || '').trim();
    if (!addr) return addr;
    const name = String(displayName || 'Vaidya Gogate Memorial Foundation').trim().replace(/"/g, "'");
    return `"${name}" <${addr}>`;
}

function isSmtpStandbyAllowed(overrides) {
    const emailProv = require('./email-provider-settings');
    const o = overrides || {};
    if (o.email_smtp_standby_enabled !== undefined && o.email_smtp_standby_enabled !== null) {
        return emailProv.flagEnabled(o.email_smtp_standby_enabled, true);
    }
    return emailProv.isSmtpStandbyEnabled(integrationSettings.getRuntimeIntegrations());
}

function logEmailResult(action, to, result) {
    if (result && result.ok) {
        console.log(
            '[email]',
            action,
            'via',
            result.provider || result.transport || 'unknown',
            'to',
            to
        );
    } else if (result && !result.skipped) {
        console.warn('[email]', action, 'failed:', result.error, result.provider ? '(' + result.provider + ')' : '');
    }
}

function explainSmtpError(err) {
    const msg = String((err && err.message) || err || 'Send failed');
    const code = err && err.responseCode;
    const lower = msg.toLowerCase();
    if (code === 553 || lower.includes('553') || lower.includes('not allowed to relay')) {
        return {
            error: msg,
            hint:
                'Zoho SMTP rejected relay. Use ZeptoMail HTTPS only: Admin → Integrations → enable primary ZeptoMail, ' +
                'disable SMTP standby, set From to noreply@seminar.vaidyagogate.org (verified in ZeptoMail).'
        };
    }
    if (code === 535 || lower.includes('535') || lower.includes('authentication failed')) {
        return {
            error: msg,
            hint:
                'Zoho rejected the login. Use the full mailbox as User (e.g. care@vaidyagogate.org), ' +
                'an App-Specific Password (not your normal Zoho password), and the same address in From. ' +
                'Create the app password at Zoho Mail → Security → App Passwords (2FA must be on). ' +
                'Then Save API keys, then Test email. If it still fails, update ZOHO_PASS on Render and redeploy.'
        };
    }
    if (lower.includes('self signed') || lower.includes('certificate')) {
        return { error: msg, hint: 'Try port 465 with host smtp.zoho.in, or port 587 with TLS.' };
    }
    if (isConnectionLikeError(msg)) {
        return {
            error: msg,
            hint:
                'Could not reach the mail server in time. On Render free hosting, SMTP ports 465/587 are blocked — ' +
                'use Admin → Integrations → HTTPS email API (Brevo, Resend, or Zoho ZeptoMail). ' +
                'Or upgrade Render to a paid plan for direct Zoho SMTP.'
        };
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

function isConnectionLikeError(errMsg) {
    const m = String(errMsg || '').toLowerCase();
    return (
        m.includes('timeout') ||
        m.includes('timed out') ||
        m.includes('connection') ||
        m.includes('econnrefused') ||
        m.includes('econnreset') ||
        m.includes('enotfound') ||
        m.includes('etimedout') ||
        m.includes('socket') ||
        m.includes('greeting')
    );
}

async function sendMailOnce(pack, mail) {
    return pack.transporter.sendMail(mail);
}

/**
 * Verify SMTP login before sending (used by admin test).
 * @param {object} [overrides] optional zoho_* fields from admin form
 */
async function verifySmtpConnection(overrides) {
    if (httpTransport.isHttpEmailConfigured(overrides)) {
        const cfg = httpTransport.getHttpEmailConfig(overrides);
        return {
            ok: true,
            user: cfg && cfg.from,
            from: cfg && cfg.from,
            transport: 'http',
            provider: cfg && cfg.provider
        };
    }
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

async function trySendOnPort(to, subject, html, opts, overrides, portOverride) {
    const pack = getTransporter(overrides, portOverride);
    if (!pack) {
        return { ok: false, skipped: true, error: 'Email not configured' };
    }
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
    if (opts && opts.replyTo) mail.replyTo = opts.replyTo;
    if (opts && opts.cc) mail.cc = opts.cc;

    const maxAttempts = 4;
    let lastExplained = { error: 'Send failed', hint: null };
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (attempt > 1) resetTransporter();
        const activePack = getTransporter(overrides, portOverride);
        if (!activePack) {
            return { ok: false, skipped: true, error: 'Email not configured' };
        }
        try {
            await sendMailOnce(activePack, mail);
            return { ok: true, port: activePack.cfg.port };
        } catch (e) {
            lastExplained = explainSmtpError(e);
            const retryable = isConnectionLikeError(lastExplained.error);
            if (!retryable || attempt >= maxAttempts) break;
            console.warn('[email] retry', attempt, 'port', activePack.cfg.port, lastExplained.error);
            await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
    }
    return { ok: false, error: lastExplained.error, hint: lastExplained.hint, port: portOverride };
}

/**
 * @param {string} to
 * @param {string} subject
 * @param {string} html
 * @param {{ text?: string, smtpOverrides?: object }} [opts]
 */
async function sendViaSmtp(to, subject, html, opts, overrides) {
    const cfg = mailConfig(overrides);
    if (!cfg || !nodemailer) {
        return { ok: false, skipped: true, error: 'Email not configured' };
    }
    const primaryPort = cfg.port;
    const ports = [primaryPort];
    if (primaryPort === 465) ports.push(587);
    else if (primaryPort === 587) ports.push(465);

    let last = { ok: false, error: 'Send failed', hint: null };
    for (let i = 0; i < ports.length; i++) {
        const port = ports[i];
        if (i > 0) resetTransporter();
        last = await trySendOnPort(to, subject, html, opts, overrides, port);
        if (last.ok) return { ...last, transport: 'smtp' };
        if (!isConnectionLikeError(last.error)) return last;
        if (i < ports.length - 1) {
            console.warn('[email] port', port, 'unreachable, trying', ports[i + 1]);
        }
    }
    if (last.error) console.error('[email]', last.error);
    return last;
}

/**
 * @param {string} to
 * @param {string} subject
 * @param {string} html
 * @param {{ text?: string, smtpOverrides?: object }} [opts]
 */
async function sendEmail(to, subject, html, opts) {
    const overrides = opts && opts.smtpOverrides;
    if (httpTransport.isHttpEmailConfigured(overrides)) {
        const httpResult = await httpTransport.sendEmailHttp(to, subject, html, opts);
        if (httpResult.ok) {
            logEmailResult('send', to, httpResult);
            return httpResult;
        }

        if (isSmtpStandbyAllowed(overrides)) {
            const smtpCfg = mailConfig(overrides);
            if (smtpCfg && nodemailer) {
                console.warn(
                    '[email] HTTPS failed — trying SMTP standby (explicitly enabled):',
                    httpResult.error
                );
                const smtpResult = await sendViaSmtp(to, subject, html, opts, overrides);
                if (smtpResult.ok) {
                    logEmailResult('send-smtp-standby', to, { ...smtpResult, provider: 'smtp' });
                    return {
                        ...smtpResult,
                        fallback: 'smtp',
                        primaryTransport: 'http',
                        primaryProvider: httpResult.provider,
                        primaryError: httpResult.error
                    };
                }
                return {
                    ok: false,
                    error: smtpResult.error || httpResult.error,
                    hint: smtpResult.hint || httpResult.hint,
                    transport: 'http+smtp',
                    provider: httpResult.provider,
                    primaryError: httpResult.error,
                    standbyError: smtpResult.error
                };
            }
        }
        logEmailResult('send', to, httpResult);
        return httpResult;
    }

    if (!isSmtpStandbyAllowed(overrides)) {
        return {
            ok: false,
            skipped: true,
            error: 'HTTPS email API not configured and SMTP standby is disabled',
            hint: 'Admin → Integrations → enable ZeptoMail primary and paste Send Mail token.'
        };
    }

    const smtpOnly = await sendViaSmtp(to, subject, html, opts, overrides);
    if (smtpOnly.skipped) {
        console.warn('[email] SMTP not configured (ZOHO_* or SMTP_* env vars).');
    }
    if (smtpOnly.ok) {
        logEmailResult('send-smtp', to, { ...smtpOnly, provider: 'smtp' });
        return smtpOnly;
    }
    if (!isConnectionLikeError(smtpOnly.error)) {
        logEmailResult('send-smtp', to, smtpOnly);
        return smtpOnly;
    }
    if (httpTransport.isHttpEmailConfigured()) {
        console.warn('[email] SMTP unreachable, trying HTTPS email API');
        const fallback = await httpTransport.sendEmailHttp(to, subject, html, opts);
        if (fallback.ok) {
            logEmailResult('send-http-fallback', to, fallback);
            return fallback;
        }
    }
    logEmailResult('send-smtp', to, smtpOnly);
    return smtpOnly;
}

module.exports = {
    sendEmail,
    isEmailConfigured,
    mailConfig,
    verifySmtpConnection,
    resetTransporter,
    explainSmtpError,
    isConnectionLikeError
};
