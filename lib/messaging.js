/**
 * Legacy messaging facade — email via Zoho/SMTP, phone via WhatsApp (no SMS).
 */
const { sendEmail, isEmailConfigured } = require('./email-service');
const { sendWhatsAppText, isWhatsAppConfigured } = require('./whatsapp-service');

async function sendMail(opts) {
    return sendEmail(opts.to, opts.subject, opts.html || opts.text || '', { text: opts.text });
}

/** @deprecated Use sendWhatsAppText — kept name for minimal call-site churn */
async function sendSms(to, body) {
    return sendWhatsAppText(to, body);
}

function isSmsConfigured() {
    return isWhatsAppConfigured();
}

function isMailConfigured() {
    return isEmailConfigured();
}

module.exports = { sendSms, sendMail, isSmsConfigured, isMailConfigured, sendEmail, sendWhatsAppText };
