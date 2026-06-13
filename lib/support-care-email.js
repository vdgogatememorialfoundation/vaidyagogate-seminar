/**
 * Central Reply-To for website contact and support ticket correspondence.
 */
function careReplyToEmail() {
    return String(
        process.env.SUPPORT_CARE_EMAIL || process.env.ADMIN_CONTACT_EMAIL || 'care@vaidyagogate.org'
    ).trim();
}

module.exports = {
    careReplyToEmail
};
