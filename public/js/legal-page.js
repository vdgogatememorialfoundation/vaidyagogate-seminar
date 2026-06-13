(function () {
    const LEGACY_ALIASES = {
        terms: 'terms',
        tnc: 'terms',
        'terms-and-conditions': 'terms',
        privacy: 'privacy',
        'privacy-policy': 'privacy',
        refund: 'refund',
        'refund-policy': 'refund'
    };

    function esc(s) {
        const d = document.createElement('div');
        d.textContent = s == null ? '' : String(s);
        return d.innerHTML;
    }

    function formatBody(text) {
        const raw = String(text || '').trim();
        if (!raw) return '<p style="color:#64748b;">Content not published yet.</p>';
        return raw
            .split(/\n\s*\n/)
            .map((para) => '<p>' + esc(para).replace(/\n/g, '<br>') + '</p>')
            .join('');
    }

    function normalizeKeyInput(raw) {
        return String(raw || '').trim().toLowerCase();
    }

    function legalPagesList(raw) {
        if (Array.isArray(raw)) return raw;
        if (raw && typeof raw === 'object') {
            return ['terms', 'privacy', 'refund']
                .map((id, idx) => ({
                    id,
                    title: raw[id] && raw[id].title,
                    body: raw[id] && raw[id].body,
                    order: idx + 1
                }))
                .filter((p) => p.title || p.body);
        }
        return [];
    }

    function resolvePageId(legalPages, raw) {
        const list = legalPagesList(legalPages);
        const p = normalizeKeyInput(raw) || 'terms';
        const alias = LEGACY_ALIASES[p];
        if (alias) {
            const found = list.find((x) => normalizeKeyInput(x.id) === alias);
            if (found) return found.id;
        }
        const byId = list.find((x) => normalizeKeyInput(x.id) === p);
        if (byId) return byId.id;
        if (list.length) return list[0].id;
        return alias || 'terms';
    }

    function pageEnabled(menuPages, pageId) {
        if (!window.PortalWebsiteMenu || typeof window.PortalWebsiteMenu.pageEnabled !== 'function') {
            return true;
        }
        const key =
            typeof window.PortalWebsiteMenu.legalPageMenuKey === 'function'
                ? window.PortalWebsiteMenu.legalPageMenuKey(pageId)
                : 'legal-' + pageId;
        return window.PortalWebsiteMenu.pageEnabled(menuPages, key);
    }

    function visibleLegalPages(legalPages, menuPages) {
        return legalPagesList(legalPages).filter((p) => p && p.id && pageEnabled(menuPages, p.id));
    }

    function legalHref(id) {
        return '/legal?p=' + encodeURIComponent(id);
    }

    function renderLegalNav(legalPages, menuPages, activeId) {
        const nav = document.getElementById('legal-nav');
        if (!nav) return;
        const items = visibleLegalPages(legalPages, menuPages);
        if (!items.length) {
            nav.innerHTML = '';
            return;
        }
        nav.innerHTML = items
            .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.title).localeCompare(String(b.title)))
            .map((item) => {
                const title = item.title || item.id;
                const cls = item.id === activeId ? 'legal-nav-link is-active' : 'legal-nav-link';
                return (
                    '<a class="' + cls + '" href="' + legalHref(item.id) + '">' + esc(title) + '</a>'
                );
            })
            .join('');
    }

    function renderLegalFooter(legalPages, menuPages) {
        const footer = document.getElementById('legal-footer-nav');
        if (!footer || !window.PortalWebsiteMenu) return;
        const links =
            typeof window.PortalWebsiteMenu.buildFooterLegalLinks === 'function'
                ? window.PortalWebsiteMenu.buildFooterLegalLinks(menuPages, legalPages)
                : [];
        footer.innerHTML =
            typeof window.PortalWebsiteMenu.renderFooterLegalLinksHtml === 'function'
                ? window.PortalWebsiteMenu.renderFooterLegalLinksHtml(links, esc)
                : '';
        footer.parentElement.style.display = links.length ? '' : 'none';
    }

    async function init() {
        const requested = normalizeKeyInput(new URLSearchParams(window.location.search).get('p') || new URLSearchParams(window.location.search).get('page') || 'terms');
        const titleEl = document.getElementById('legal-title');
        const bodyEl = document.getElementById('legal-body');
        const statusEl = document.getElementById('legal-status');
        try {
            const [cmsRes, authRes] = await Promise.all([
                fetch('/api/public/site-cms', { cache: 'no-store' }),
                fetch('/api/public/portal-auth', { cache: 'no-store' })
            ]);
            const cms = await cmsRes.json();
            const auth = await authRes.json().catch(() => ({}));
            const menuPages = (auth && auth.websiteMenuPages) || {};
            const legalPages = cms.legalPages || [];
            const pageId = resolvePageId(legalPages, requested);
            const list = legalPagesList(legalPages);
            const page = list.find((x) => x.id === pageId) || { title: 'Legal', body: '' };

            if (!pageEnabled(menuPages, pageId)) {
                document.title = 'Page unavailable | Vaidya Gogate Memorial Foundation';
                if (titleEl) titleEl.textContent = 'Page unavailable';
                if (bodyEl) {
                    bodyEl.innerHTML =
                        '<p style="color:#64748b;">This page is not available on the public website.</p>';
                }
                renderLegalNav(legalPages, menuPages, '');
                renderLegalFooter(legalPages, menuPages);
                if (statusEl) statusEl.textContent = '';
                return;
            }

            document.title = (page.title || 'Legal') + ' | Vaidya Gogate Memorial Foundation';
            if (titleEl) titleEl.textContent = page.title || 'Legal';
            if (bodyEl) bodyEl.innerHTML = formatBody(page.body);
            renderLegalNav(legalPages, menuPages, pageId);
            renderLegalFooter(legalPages, menuPages);
            if (statusEl) statusEl.textContent = '';
        } catch (e) {
            if (statusEl) statusEl.textContent = 'Could not load page content. Please try again later.';
            if (bodyEl) bodyEl.innerHTML = '';
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
