/**
 * Public site SEO metadata, robots.txt, sitemap.xml, favicon helpers.
 */
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
    faviconUrl: '/favicon.svg',
    sitemapExtraPaths: ['/verify-certificate.html']
};

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
        faviconUrl: String(o.faviconUrl || DEFAULT_SEO.faviconUrl).trim() || DEFAULT_SEO.faviconUrl,
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
        'Disallow: /admin.html\n' +
        'Disallow: /staff/crm\n' +
        'Disallow: /staff/login\n' +
        'Disallow: /judge.html\n' +
        'Disallow: /scanner.html\n' +
        'Disallow: /doctor.html\n' +
        'Sitemap: ' +
        base +
        '/sitemap.xml\n'
    );
}

function buildSitemapXml(seo, extraUrls) {
    const s = normalizeSeo(seo);
    const base = publicBaseUrl();
    const blocked = new Set([
        '/admin.html',
        '/staff/login',
        '/staff/crm',
        '/judge.html',
        '/scanner.html',
        '/doctor.html',
        '/login.html'
    ]);
    const paths = new Set(['/']);
    (s.sitemapExtraPaths || []).forEach((p) => paths.add(p));
    (extraUrls || []).forEach((p) => {
        if (p && String(p).startsWith('/')) paths.add(String(p));
    });
    const normalizePath = (path) => {
        const p = String(path || '').trim();
        if (!p || p === '/index.html') return '/';
        return p;
    };
    const canonicalPaths = [...paths].map(normalizePath).filter(Boolean);
    const dedupedPaths = [...new Set(canonicalPaths)].filter((p) => !blocked.has(p));
    const today = new Date().toISOString().slice(0, 10);
    const urls = dedupedPaths
        .map((path) => {
            const loc = path === '/' ? base + '/' : base + path;
            return (
                '  <url>\n    <loc>' +
                escapeHtml(loc) +
                '</loc>\n    <lastmod>' +
                today +
                '</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>' +
                (path === '/' ? '1.0' : '0.8') +
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

function registerSiteSeoRoutes(app, deps) {
    const { db, loadPublicSiteCms } = deps;
    const path = require('path');
    const fs = require('fs');

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

    app.get('/favicon.ico', (req, res) => {
        loadPublicSiteCms((e, cms) => {
            const fav = normalizeSeo((cms && cms.seo) || {}).faviconUrl || '/favicon.svg';
            if (fav.startsWith('http://') || fav.startsWith('https://')) {
                return res.redirect(302, fav);
            }
            const rel = fav.startsWith('/') ? fav.slice(1) : fav;
            const disk = path.join(__dirname, '..', 'public', rel);
            if (fs.existsSync(disk)) {
                return res.sendFile(disk);
            }
            const fallback = path.join(__dirname, '..', 'public', 'favicon.svg');
            if (fs.existsSync(fallback)) {
                res.type('image/svg+xml');
                return res.sendFile(fallback);
            }
            res.status(404).end();
        });
    });
}

module.exports = {
    DEFAULT_SEO,
    normalizeSeo,
    buildRobotsTxt,
    buildSitemapXml,
    registerSiteSeoRoutes,
    publicBaseUrl
};
