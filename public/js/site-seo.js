/**
 * Apply SEO + favicon from public_site_cms.seo on public pages.
 */
(function () {
    function upsertMeta(attr, key, content) {
        if (!content) return;
        let el = document.querySelector(`meta[${attr}="${key}"]`);
        if (!el) {
            el = document.createElement('meta');
            el.setAttribute(attr, key);
            document.head.appendChild(el);
        }
        el.setAttribute('content', content);
    }

    function upsertLink(rel, href, extra) {
        if (!href) return;
        let el = document.querySelector(`link[rel="${rel}"]`);
        if (!el) {
            el = document.createElement('link');
            el.setAttribute('rel', rel);
            document.head.appendChild(el);
        }
        el.setAttribute('href', href);
        if (extra) {
            Object.keys(extra).forEach((k) => el.setAttribute(k, extra[k]));
        }
    }

    function applySeo(seo) {
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
        const canon = seo.canonicalUrl || window.location.origin + '/';
        upsertLink('canonical', canon);
        const fav = seo.faviconUrl || '/favicon.svg';
        upsertLink('icon', fav, { type: fav.endsWith('.svg') ? 'image/svg+xml' : undefined });
        upsertLink('shortcut icon', fav);
        upsertMeta('property', 'og:title', title || '');
        upsertMeta('property', 'og:description', seo.description || '');
        upsertMeta('property', 'og:type', 'website');
        upsertMeta('property', 'og:url', canon);
        if (seo.ogImage) upsertMeta('property', 'og:image', seo.ogImage);
        upsertMeta('name', 'twitter:card', seo.twitterCard || 'summary_large_image');
        upsertMeta('name', 'twitter:title', title || '');
        upsertMeta('name', 'twitter:description', seo.description || '');
        if (seo.robotsIndex === false) {
            upsertMeta('name', 'robots', 'noindex, nofollow');
        } else {
            upsertMeta('name', 'robots', 'index, follow');
        }
    }

    async function loadPublicSeo() {
        try {
            const res = await fetch('/api/public/site-cms', { cache: 'no-store' });
            const cms = await res.json();
            applySeo(cms.seo || {});
        } catch (_) {}
    }

    window.VgmfSiteSeo = { applySeo, loadPublicSeo };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', loadPublicSeo);
    } else {
        loadPublicSeo();
    }
})();
