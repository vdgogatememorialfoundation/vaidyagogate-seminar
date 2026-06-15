/**
 * Serve the correct HTML shell per subdomain (admin / seminar / judge).
 */
const path = require('path');
const { getHosts, getPortalUrls } = require('./portal-urls');
const appPaths = require('./app-paths');
const { sendPortalHtml } = require('./html-delivery');

const SKIP_PREFIXES = ['/api', '/uploads', '/css', '/js', '/scanner', '/scanner-manifest.json'];

function shouldSkip(pathname) {
    return SKIP_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

function subdomainPortalMiddleware(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const pathname = req.path || '/';
    if (shouldSkip(pathname)) return next();

    const hosts = getHosts();
    const reqHost = String(req.hostname || (req.headers.host || '').split(':')[0]).toLowerCase();
    const urls = getPortalUrls();
    const publicDir = path.join(__dirname, '..', 'public');

    const send = (file) => sendPortalHtml(res, publicDir, file);

    if (reqHost === hosts.admin) {
        if (pathname === '/' || pathname === '/index.html' || pathname === appPaths.PATHS.admin || pathname === '/admin.html') {
            return res.redirect(302, urls.admin);
        }
        if (pathname === appPaths.PATHS.doctor || pathname === '/doctor.html') return res.redirect(302, urls.doctor);
        if (pathname === appPaths.PATHS.judge || pathname === '/judge.html') return res.redirect(302, urls.judge);
        if (pathname === appPaths.PATHS.scanner || pathname === '/scanner.html') return res.redirect(302, urls.scanner);
    }

    if (reqHost === hosts.judge) {
        if (pathname === '/' || pathname === '/index.html' || pathname === appPaths.PATHS.judge || pathname === '/judge.html') {
            return res.redirect(302, urls.judge);
        }
        if (pathname === appPaths.PATHS.admin || pathname === '/admin.html') return res.redirect(302, urls.admin);
        if (pathname === appPaths.PATHS.doctor || pathname === '/doctor.html') return res.redirect(302, urls.doctor);
    }

    if (reqHost === hosts.seminar) {
        if (pathname === '/' || pathname === '/index.html') return send('index.html');
        if (pathname === appPaths.PATHS.staffLogin || pathname === '/staff') return send('staff.html');
        if (pathname === appPaths.PATHS.staffCrm || pathname === '/staff/crm/') return send('admin.html');
    }

    return next();
}

module.exports = { subdomainPortalMiddleware };
