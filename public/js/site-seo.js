/**
 * Apply SEO + favicon from public_site_cms.seo on public pages.
 */
(function () {
    const PRIVATE_PREFIXES = [
        '/admin',
        '/doctor',
        '/judge',
        '/scanner',
        '/staff',
        '/support'
    ];

    function isPrivatePortalPath() {
        const p = (window.location.pathname || '/').replace(/\/+$/, '') || '/';
        if (PRIVATE_PREFIXES.some((x) => p === x || p.startsWith(x + '/'))) return true;
        return p.startsWith('/admin/');
    }

    function upsertMeta(attr, key, content) {
        if (!content) return;
        let el = document.querySelector('meta[' + attr + '="' + key + '"]');
        if (!el) {
            el = document.createElement('meta');
            el.setAttribute(attr, key);
            document.head.appendChild(el);
        }
        el.setAttribute('content', content);
    }

    function upsertLink(rel, href, extra) {
        if (!href) return;
        let el = document.querySelector('link[rel="' + rel + '"]');
        if (!el) {
            el = document.createElement('link');
            el.setAttribute('rel', rel);
            document.head.appendChild(el);
        }
        el.setAttribute('href', href);
        if (extra) {
            Object.keys(extra).forEach(function (k) {
                if (extra[k]) el.setAttribute(k, extra[k]);
            });
        }
    }

    function faviconMime(url) {
        const u = String(url || '').toLowerCase();
        if (u.endsWith('.svg')) return 'image/svg+xml';
        if (u.endsWith('.jpg') || u.endsWith('.jpeg')) return 'image/jpeg';
        if (u.endsWith('.webp')) return 'image/webp';
        return 'image/png';
    }

    function applySeo(seo, logoPath) {
        if (!seo || typeof seo !== 'object') return;
        const title = seo.title || seo.siteName;
        if (title) document.title = title;
        upsertMeta('name', 'description', seo.description || '');
        if (seo.keywords) upsertMeta('name', 'keywords', seo.keywords);
        if (seo.googleSiteVerification) {
            upsertMeta('name', 'google-site-verification', seo.googleSiteVerification);
        }
        if (seo.bingSiteVerification) {
            upsertMeta('name', 'msvalidate.01', seo.bingSiteVerification);
        }

        const canon = (window.location.origin || '') + (window.location.pathname || '/');
        upsertLink('canonical', canon);

        const legacyFavicons = ['/favicon.svg', ''];
        let fav = seo.faviconUrl || logoPath || '/api/branding/logo/file';
        if (legacyFavicons.indexOf(fav) >= 0 && logoPath) fav = logoPath;
        upsertLink('icon', fav, { type: faviconMime(fav) });
        upsertLink('shortcut icon', '/favicon.ico');
        upsertLink('apple-touch-icon', fav);

        upsertMeta('property', 'og:title', title || '');
        upsertMeta('property', 'og:description', seo.description || '');
        upsertMeta('property', 'og:type', 'website');
        upsertMeta('property', 'og:url', canon);
        if (seo.ogImage) upsertMeta('property', 'og:image', seo.ogImage);
        upsertMeta('name', 'twitter:card', seo.twitterCard || 'summary_large_image');
        upsertMeta('name', 'twitter:title', title || '');
        upsertMeta('name', 'twitter:description', seo.description || '');

        if (isPrivatePortalPath()) {
            upsertMeta('name', 'robots', 'noindex, nofollow');
        } else if (seo.robotsIndex === false) {
            upsertMeta('name', 'robots', 'noindex, nofollow');
        } else {
            upsertMeta('name', 'robots', 'index, follow');
        }
    }

    async function loadPublicSeo() {
        try {
            const [cmsRes, logoRes] = await Promise.all([
                fetch('/api/public/site-cms', { cache: 'no-store' }),
                fetch('/api/branding/logo', { cache: 'no-store' })
            ]);
            const cms = cmsRes.ok ? await cmsRes.json() : {};
            const logoData = logoRes.ok ? await logoRes.json() : {};
            applySeo(cms.seo || {}, logoData.logoPath || '');
        } catch (_) {}
    }

    window.VgmfSiteSeo = { applySeo, loadPublicSeo, isPrivatePortalPath };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', loadPublicSeo);
    } else {
        loadPublicSeo();
    }
})();
