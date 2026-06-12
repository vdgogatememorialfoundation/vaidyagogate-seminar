(function () {
    const PAGE_KEYS = {
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

    function resolvePageKey() {
        const params = new URLSearchParams(window.location.search);
        const p = String(params.get('p') || params.get('page') || 'terms')
            .trim()
            .toLowerCase();
        return PAGE_KEYS[p] || 'terms';
    }

    function legalHref(key) {
        return '/legal.html?p=' + encodeURIComponent(key);
    }

    function renderLegalNav(legalPages, activeKey) {
        const nav = document.getElementById('legal-nav');
        if (!nav || !legalPages) return;
        const items = [
            { key: 'terms', page: legalPages.terms },
            { key: 'privacy', page: legalPages.privacy },
            { key: 'refund', page: legalPages.refund }
        ];
        nav.innerHTML = items
            .map((item) => {
                const title = (item.page && item.page.title) || item.key;
                const cls = item.key === activeKey ? 'legal-nav-link is-active' : 'legal-nav-link';
                return (
                    '<a class="' +
                    cls +
                    '" href="' +
                    legalHref(item.key) +
                    '">' +
                    esc(title) +
                    '</a>'
                );
            })
            .join('');
    }

    async function init() {
        const key = resolvePageKey();
        const titleEl = document.getElementById('legal-title');
        const bodyEl = document.getElementById('legal-body');
        const statusEl = document.getElementById('legal-status');
        try {
            const res = await fetch('/api/public/site-cms', { cache: 'no-store' });
            const cms = await res.json();
            const legalPages = cms.legalPages || {};
            const page = legalPages[key] || legalPages.terms || { title: 'Legal', body: '' };
            document.title = (page.title || 'Legal') + ' | Vaidya Gogate Memorial Foundation';
            if (titleEl) titleEl.textContent = page.title || 'Legal';
            if (bodyEl) bodyEl.innerHTML = formatBody(page.body);
            renderLegalNav(legalPages, key);
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
