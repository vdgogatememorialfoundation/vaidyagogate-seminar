/**
 * Zoho / generic SMTP email — Nodemailer.
 * Env: ZOHO_HOST, ZOHO_PORT, ZOHO_USER, ZOHO_PASS, ZOHO_FROM
 * Fallback: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM, SMTP_SECURE
 */
let nodemailer = null;
try {
    nodemailer = require('nodemailer');
} catch (_) {}

const integrationSettings = require('./integration-settings');

integrationSettings.registerTransporterReset(() => {
    transporterCache = null;
});

function mailConfig() {
    return integrationSettings.getMailConfig();
}

function isEmailConfigured() {
    return integrationSettings.isEmailConfiguredFromSettings();
}

let transporterCache = null;

function getTransporter() {
    const cfg = mailConfig();
    if (!cfg || !nodemailer) return null;
    if (!transporterCache) {
        transporterCache = nodemailer.createTransport({
            host: cfg.host,
            port: cfg.port,
            secure: cfg.secure,
            auth: cfg.auth
        });
    }
    return { transporter: transporterCache, from: cfg.from };
}

/**
 * @param {string} to
 * @param {string} subject
 * @param {string} html
 * @param {{ text?: string }} [opts]
 */
async function sendEmail(to, subject, html, opts) {
    const pack = getTransporter();
    if (!pack) {
        console.warn('[email] SMTP not configured (ZOHO_* or SMTP_* env vars).');
        return { ok: false, skipped: true, error: 'Email not configured' };
    }
    try {
        await pack.transporter.sendMail({
            from: pack.from,
            to,
            subject,
            html: html || undefined,
            text: (opts && opts.text) || undefined
        });
        return { ok: true };
    } catch (e) {
        console.error('[email]', e.message);
        return { ok: false, error: e.message };
    }
}

module.exports = { sendEmail, isEmailConfigured, mailConfig };
