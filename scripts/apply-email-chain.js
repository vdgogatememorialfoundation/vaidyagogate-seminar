/**
 * Configure production email: ZeptoMail HTTPS only (no fallback/SMTP).
 * Usage:
 *   ZEPTOMAIL_TOKEN=... node scripts/apply-email-chain.js
 */
require('./apply-zeptomail-only');
