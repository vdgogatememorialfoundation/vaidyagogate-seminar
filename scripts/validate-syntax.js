/**
 * Fail CI / npm run build if critical server modules have a syntax error.
 */
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const files = [
    'server.js',
    path.join('lib', 'extended-schema-pg.js'),
    path.join('lib', 'extended-modules.js'),
    path.join('lib', 'routes-ext.js'),
    path.join('lib', 'routes-payments.js'),
    path.join('lib', 'refund-tracking.js'),
    path.join('lib', 'certificate-verify.js'),
    path.join('lib', 'notification-engine.js'),
    path.join('lib', 'db-pg.js'),
    path.join('lib', 'book-sales.js'),
    path.join('lib', 'book-courier-tracking.js'),
    path.join('lib', 'book-courier-tracker.js'),
    path.join('lib', 'logistics-aggregators.js'),
    path.join('lib', 'book-tracking-journey.js'),
    path.join('lib', 'book-sales-auth.js'),
    path.join('lib', 'book-sales-inventory.js'),
    path.join('lib', 'book-sales-notify.js'),
    path.join('lib', 'inbound-mail-reply.js'),
    path.join('lib', 'thread-reply-notify.js'),
    path.join('lib', 'support-ticket-notify.js'),
    path.join('lib', 'case-upload-routes.js'),
    path.join('lib', 'support-desk.js'),
    path.join('lib', 'support-desk-routes.js'),
    path.join('lib', 'support-desk-schema.js'),
    path.join('lib', 'support-live-chat.js'),
    path.join('lib', 'support-desk-admin-routes.js'),
    path.join('lib', 'support-desk-admin-routes.js'),
    path.join('public', 'js', 'fetch-json.js')
];

let failed = false;
for (const rel of files) {
    const abs = path.join(root, rel);
    try {
        execSync(`node --check "${abs}"`, { stdio: 'pipe' });
    } catch (e) {
        console.error('[validate-syntax] syntax error in', rel);
        failed = true;
    }
}

if (failed) process.exit(1);
console.log('[validate-syntax] OK', files.length, 'files');
