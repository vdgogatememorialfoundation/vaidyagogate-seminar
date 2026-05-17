/**
 * Loads site logo from /api/branding/logo into [data-site-logo] slots.
 */
(function () {
    const DEFAULT_ICON = '🏥';

    function applyLogoToSlot(el, logoPath) {
        if (!el) return;
        if (logoPath) {
            const img = document.createElement('img');
            img.src = logoPath;
            img.alt = 'Site logo';
            img.className = 'site-logo-img';
            img.style.maxHeight = el.getAttribute('data-logo-height') || '48px';
            img.style.maxWidth = el.getAttribute('data-logo-width') || '160px';
            img.style.objectFit = 'contain';
            img.style.display = 'block';
            el.innerHTML = '';
            el.appendChild(img);
            el.classList.add('has-site-logo');
        } else if (el.getAttribute('data-logo-fallback') === 'icon') {
            el.innerHTML = '<span class="logo-icon-fallback" style="font-size:2rem;line-height:1;">' + DEFAULT_ICON + '</span>';
        }
    }

    async function loadSiteBranding() {
        const onScanner =
            document.documentElement.classList.contains('scanner-native-shell') ||
            /\/scanner\.html$/i.test(window.location.pathname || '');
        if (onScanner && !document.querySelector('[data-site-logo]')) {
            return;
        }
        let logoPath = '';
        try {
            const res = await fetch('/api/branding/logo', { cache: 'no-store' });
            if (res.ok) {
                const data = await res.json();
                logoPath = (data && data.logoPath) || '';
            }
        } catch (e) {
            console.warn('Site branding:', e.message || e);
        }
        window.__siteLogoPath = logoPath;
        document.querySelectorAll('[data-site-logo]').forEach((el) => applyLogoToSlot(el, logoPath));
        if (logoPath && !onScanner) {
            document.body.classList.add('has-logo-theme');
            document.body.style.setProperty('--site-logo-watermark', 'url("' + logoPath + '")');
        } else {
            document.body.classList.remove('has-logo-theme');
            document.body.style.removeProperty('--site-logo-watermark');
        }
        document.dispatchEvent(new CustomEvent('site-branding-loaded', { detail: { logoPath } }));
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', loadSiteBranding);
    } else {
        loadSiteBranding();
    }

    window.reloadSiteBranding = loadSiteBranding;
})();
