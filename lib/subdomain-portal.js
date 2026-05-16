/**
 * Serve the correct HTML shell per subdomain (admin / seminar / judge).
 */
const path = require('path');
const { getHosts, getPortalUrls } = require('./portal-urls');

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

    const send = (file) => res.sendFile(path.join(publicDir, file));

    if (reqHost === hosts.admin) {
        if (pathname === '/' || pathname === '/index.html') return send('admin.html');
        if (pathname === '/doctor.html') return res.redirect(302, urls.doctor);
        if (pathname === '/judge.html') return res.redirect(302, urls.judge);
        if (pathname === '/scanner.html' || pathname === '/scanner') return res.redirect(302, urls.scanner);
    }

    if (reqHost === hosts.judge) {
        if (pathname === '/' || pathname === '/index.html') return send('judge.html');
        if (pathname === '/admin.html') return res.redirect(302, urls.admin);
        if (pathname === '/doctor.html') return res.redirect(302, urls.doctor);
    }

    if (reqHost === hosts.seminar) {
        if (pathname === '/' || pathname === '/index.html') return send('index.html');
    }

    return next();
}

module.exports = { subdomainPortalMiddleware };
