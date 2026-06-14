/**
 * Public site SEO metadata, robots.txt, sitemap.xml, favicon helpers.
 */
const path = require('path');
const fs = require('fs');
const branding = require('./branding');

const DEFAULT_SEO = {
    siteName: 'Vaidya Gogate Memorial Foundation',
    title: 'Vaidya Gogate Memorial Foundation | National Seminar',
    description:
        'Vaidya Gogate Memorial Foundation National Seminar — register online, e-tickets, programme, and certificate verification.',
    keywords:
        'Vaidya Gogate, Ayurveda seminar, national seminar, CME, doctor registration, certificate verification, Pune',
    canonicalUrl: '',
    ogImage: '/og-image.svg',
    twitterCard: 'summary_large_image',
    googleSiteVerification: '',
    bingSiteVerification: '',
    robotsIndex: true,
    faviconUrl: '/api/branding/logo/file',
    sitemapExtraPaths: []
};

const PRIVATE_PORTAL_PATHS = new Set([
    '/admin',
    '/admin/live-scanner',
    '/doctor',
    '/judge',
    '/scanner',
    '/staff',
    '/staff/login',
    '/staff/crm',
    '/support',
    '/login'
]);

function publicBaseUrl() {
    try {
        return require('./integration-settings').getPublicBaseUrl();
    } catch (_) {
        return (process.env.PUBLIC_BASE_URL || process.env.SITE_URL || 'https://seminar.vaidyagogate.org').replace(
            /\/$/,
            ''
        );
    }
}

function normalizeLegacyFaviconUrl(url) {
    const u = String(url || '').trim();
    if (!u || u === '/favicon.svg' || u === '/favicon.ico') {
        return DEFAULT_SEO.faviconUrl;
    }
    return u;
}

function normalizeSeo(seo) {
    const o = seo && typeof seo === 'object' ? seo : {};
    const base = publicBaseUrl();
    return {
        siteName: String(o.siteName || DEFAULT_SEO.siteName).trim() || DEFAULT_SEO.siteName,
        title: String(o.title || DEFAULT_SEO.title).trim() || DEFAULT_SEO.title,
        description: String(o.description || DEFAULT_SEO.description).trim() || DEFAULT_SEO.description,
        keywords: String(o.keywords || DEFAULT_SEO.keywords).trim(),
        canonicalUrl: String(o.canonicalUrl || base).trim() || base,
        ogImage: String(o.ogImage || '').trim(),
        twitterCard: String(o.twitterCard || DEFAULT_SEO.twitterCard).trim() || 'summary',
        googleSiteVerification: String(o.googleSiteVerification || '').trim(),
        bingSiteVerification: String(o.bingSiteVerification || '').trim(),
        robotsIndex: o.robotsIndex !== false && o.robotsIndex !== 0 && String(o.robotsIndex) !== 'false',
        faviconUrl: normalizeLegacyFaviconUrl(o.faviconUrl || DEFAULT_SEO.faviconUrl),
        sitemapExtraPaths: Array.isArray(o.sitemapExtraPaths)
            ? o.sitemapExtraPaths.filter((p) => typeof p === 'string' && p.startsWith('/'))
            : DEFAULT_SEO.sitemapExtraPaths.slice()
    };
}

function escapeHtml(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function isPrivatePortalPath(routePath) {
    const p = String(routePath || '/').replace(/\/+$/, '') || '/';
    if (PRIVATE_PORTAL_PATHS.has(p)) return true;
    if (p.startsWith('/admin/')) return true;
    if (p.startsWith('/staff/') && p !== '/staff') return true;
    return false;
}

function collectPublicSitemapPaths(seo) {
    const s = normalizeSeo(seo);
    const paths = new Set(['/']);
    try {
        const { PAGE_ROUTES } = require('./app-paths');
        (PAGE_ROUTES || []).forEach(({ path: routePath }) => {
            if (routePath && !isPrivatePortalPath(routePath)) paths.add(routePath);
        });
    } catch (_) {
        ['/verify-certificate', '/legal', '/track-shipment', '/support-rate', '/live-chat'].forEach((p) =>
            paths.add(p)
        );
    }
    (s.sitemapExtraPaths || []).forEach((p) => {
        if (p && String(p).startsWith('/') && !isPrivatePortalPath(p)) paths.add(String(p));
    });
    return [...paths];
}

function buildRobotsTxt(seo) {
    const s = normalizeSeo(seo);
    const base = publicBaseUrl();
    if (!s.robotsIndex) {
        return 'User-agent: *\nDisallow: /\n';
    }
    return (
        'User-agent: *\n' +
        'Allow: /\n' +
        'Disallow: /api/\n' +
        'Disallow: /admin\n' +
        'Disallow: /admin/\n' +
        'Disallow: /staff\n' +
        'Disallow: /staff/\n' +
        'Disallow: /judge\n' +
        'Disallow: /scanner\n' +
        'Disallow: /doctor\n' +
        'Disallow: /support\n' +
        'Sitemap: ' +
        base +
        '/sitemap.xml\n'
    );
}

function buildSitemapXml(seo, extraUrls) {
    const base = publicBaseUrl();
    const paths = new Set(collectPublicSitemapPaths(seo));
    (extraUrls || []).forEach((p) => {
        if (p && String(p).startsWith('/') && !isPrivatePortalPath(p)) paths.add(String(p));
    });
    const appPaths = require('./app-paths');
    const normalizePath = (routePath) => {
        const p = String(routePath || '').trim();
        if (!p || p === '/index.html') return '/';
        if (/\.html$/i.test(p)) return appPaths.htmlFileToPath(p.replace(/^\//, ''));
        return p;
    };
    const dedupedPaths = [...new Set([...paths].map(normalizePath).filter(Boolean))].filter(
        (p) => !isPrivatePortalPath(p)
    );
    const today = new Date().toISOString().slice(0, 10);
    const urls = dedupedPaths
        .map((routePath) => {
            const loc = routePath === '/' ? base + '/' : base + routePath;
            const priority =
                routePath === '/'
                    ? '1.0'
                    : routePath === '/verify-certificate' || routePath === '/legal'
                      ? '0.9'
                      : '0.8';
            return (
                '  <url>\n    <loc>' +
                escapeHtml(loc) +
                '</loc>\n    <lastmod>' +
                today +
                '</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>' +
                priority +
                '</priority>\n  </url>'
            );
        })
        .join('\n');
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        urls +
        '\n</urlset>\n'
    );
}

function sendStaticFaviconSvg(res) {
    const fallback = path.join(__dirname, '..', 'public', 'favicon.svg');
    if (fs.existsSync(fallback)) {
        res.type('image/svg+xml');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.sendFile(fallback);
    }
    return res.status(404).end();
}

function serveBrandingFavicon(req, res, db) {
    branding.loadSiteLogoFile(db, (err, file) => {
        if (!err && file && file.buffer) {
            res.setHeader('Content-Type', file.mime || 'image/png');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            return res.send(file.buffer);
        }
        sendStaticFaviconSvg(res);
    });
}

function registerFaviconRoutes(app, deps) {
    const { db } = deps || {};
    app.get('/api/branding/logo/file', (req, res) => {
        branding.loadSiteLogoFile(db, (err, file) => {
            if (err) return res.status(500).end();
            if (!file || !file.buffer) return res.status(404).end();
            res.setHeader('Content-Type', file.mime || 'image/png');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.send(file.buffer);
        });
    });
    app.get(['/favicon.ico', '/favicon.svg', '/favicon.png'], (req, res) => {
        serveBrandingFavicon(req, res, db);
    });
}

function registerSiteSeoRoutes(app, deps) {
    const { loadPublicSiteCms } = deps;

    app.get('/robots.txt', (req, res) => {
        loadPublicSiteCms((e, cms) => {
            const txt = buildRobotsTxt((cms && cms.seo) || {});
            res.type('text/plain').send(txt);
        });
    });

    app.get('/sitemap.xml', (req, res) => {
        loadPublicSiteCms((e, cms) => {
            const xml = buildSitemapXml((cms && cms.seo) || {}, []);
            res.type('application/xml').send(xml);
        });
    });
}

module.exports = {
    DEFAULT_SEO,
    PRIVATE_PORTAL_PATHS,
    normalizeSeo,
    buildRobotsTxt,
    buildSitemapXml,
    collectPublicSitemapPaths,
    isPrivatePortalPath,
    registerFaviconRoutes,
    registerSiteSeoRoutes,
    publicBaseUrl
};
