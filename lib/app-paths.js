/**
 * Clean public page URLs (no .html). Legacy *.html paths redirect here.
 */
const { sendPortalHtml } = require('./html-delivery');

/** @type {{ path: string, file: string }[]} */
const PAGE_ROUTES = [
    { path: '/admin', file: 'admin.html' },
    { path: '/doctor', file: 'doctor.html' },
    { path: '/judge', file: 'judge.html' },
    { path: '/scanner', file: 'scanner.html' },
    { path: '/support', file: 'support.html' },
    { path: '/support-rate', file: 'support-rate.html' },
    { path: '/track-shipment', file: 'track-shipment.html' },
    { path: '/verify-certificate', file: 'verify-certificate.html' },
    { path: '/legal', file: 'legal.html' },
    { path: '/live-chat', file: 'live-chat.html' },
    { path: '/admin/live-scanner', file: 'admin-live-scanner.html' }
];

/** Old paths → canonical clean path (query string preserved). */
const LEGACY_REDIRECTS = [
    { from: '/index.html', to: '/' },
    { from: '/order-tracker', to: '/track-shipment' },
    { from: '/order-tracker.html', to: '/track-shipment' },
    { from: '/track-book', to: '/track-shipment' },
    { from: '/track-book.html', to: '/track-shipment' },
    { from: '/support.html', to: '/support' },
    { from: '/support/login', to: '/support' },
    { from: '/admin-live-scanner.html', to: '/admin/live-scanner' }
];

const PATHS = {
    home: '/',
    admin: '/admin',
    doctor: '/doctor',
    judge: '/judge',
    scanner: '/scanner',
    support: '/support',
    supportRate: '/support-rate',
    staffLogin: '/staff/login',
    staffCrm: '/staff/crm',
    trackShipment: '/track-shipment',
    verifyCertificate: '/verify-certificate',
    legal: '/legal',
    liveChat: '/live-chat',
    adminLiveScanner: '/admin/live-scanner'
};

const FILE_TO_PATH = Object.fromEntries(PAGE_ROUTES.map((r) => [r.file, r.path]));
FILE_TO_PATH['index.html'] = '/';
FILE_TO_PATH['staff.html'] = PATHS.staffLogin;

function querySuffix(req) {
    const u = req.originalUrl || req.url || '';
    const i = u.indexOf('?');
    return i >= 0 ? u.slice(i) : '';
}

function registerAppPageRoutes(app, publicDir) {
    for (const { from, to } of LEGACY_REDIRECTS) {
        app.get([from, from + '/'], (req, res) => {
            res.redirect(301, to + querySuffix(req));
        });
    }

    for (const { path: routePath, file } of PAGE_ROUTES) {
        app.get([routePath, routePath + '/'], (req, res) => {
            sendPortalHtml(res, publicDir, file);
        });
        app.get('/' + file, (req, res) => {
            res.redirect(301, routePath + querySuffix(req));
        });
    }

    app.get(['/', '/index.html', '/index.html/'], (req, res) => {
        sendPortalHtml(res, publicDir, 'index.html');
    });
}

function htmlFileToPath(fileName) {
    const base = String(fileName || '').trim().replace(/^\//, '');
    if (!base) return PATHS.home;
    if (FILE_TO_PATH[base]) return FILE_TO_PATH[base];
    if (/\.html$/i.test(base)) return '/' + base.replace(/\.html$/i, '');
    return '/' + base;
}

function normalizeReturnPath(raw) {
    const s = String(raw || '').trim();
    if (!s) return PATHS.home;
    const noHash = s.split('#')[0];
    const file = noHash.replace(/^\//, '').toLowerCase();
    if (file === 'index.html' || file === '' || file === '/') return PATHS.home;
    if (FILE_TO_PATH[file]) return FILE_TO_PATH[file];
    if (/^[a-z0-9._-]+\.html$/i.test(file)) return htmlFileToPath(file);
    return PATHS.home;
}

module.exports = {
    PATHS,
    PAGE_ROUTES,
    LEGACY_REDIRECTS,
    FILE_TO_PATH,
    registerAppPageRoutes,
    sendPortalHtml,
    htmlFileToPath,
    normalizeReturnPath
};
