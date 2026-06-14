/**
 * Legacy messaging facade — email via ZeptoMail → Sender.net → Zoho SMTP, phone via MSG91 SMS then WhatsApp.
 */
const { sendEmail, isEmailConfigured } = require('./email-service');
const { sendWhatsAppText, isWhatsAppConfigured } = require('./whatsapp-service');
const { sendMsg91Sms, isMsg91Configured } = require('./msg91-service');

async function sendMail(opts) {
    return sendEmail(opts.to, opts.subject, opts.html || opts.text || '', { text: opts.text });
}

/** Cellular SMS via MSG91; falls back to WhatsApp text when MSG91 is not configured. */
async function sendSms(to, body, opts) {
    if (isMsg91Configured()) {
        const r = await sendMsg91Sms(to, body, opts || {});
        if (r.ok || !r.skipped) return r;
    }
    return sendWhatsAppText(to, body);
}

function isSmsConfigured() {
    return isMsg91Configured() || isWhatsAppConfigured();
}

function isMailConfigured() {
    return isEmailConfigured();
}

module.exports = { sendSms, sendMail, isSmsConfigured, isMailConfigured, sendEmail, sendWhatsAppText };
