/**
 * Main site UI — search, stats, scroll progress, back-to-top
 */
(function () {
    const SEARCH_ITEMS = (function buildSearchItems() {
        const base = Array.isArray(window.VGMF_QUICK_ACCESS) ? window.VGMF_QUICK_ACCESS : [];
        const mapped = base.map((x) => ({
            icon: x.icon,
            label: x.title,
            section: x.section,
            href: x.href,
            action: x.action,
            anchor: x.anchor
        }));
        return [{ icon: 'fa-home', label: 'Home', section: 'home' }, ...mapped];
    })();

    function bindScrollProgress() {
        const bar = document.getElementById('vg-scroll-progress');
        if (!bar) return;
        window.addEventListener(
            'scroll',
            () => {
                const h = document.documentElement.scrollHeight - window.innerHeight;
                const pct = h > 0 ? (window.scrollY / h) * 100 : 0;
                bar.style.width = pct + '%';
            },
            { passive: true }
        );
    }

    function bindBackToTop() {
        const btn = document.getElementById('vg-back-top');
        if (!btn) return;
        window.addEventListener(
            'scroll',
            () => {
                btn.classList.toggle('is-visible', window.scrollY > 400);
            },
            { passive: true }
        );
        btn.addEventListener('click', () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    }

    function openSearch() {
        const modal = document.getElementById('vg-search-modal');
        const input = document.getElementById('vg-search-input');
        if (!modal) return;
        modal.classList.add('is-open');
        modal.setAttribute('aria-hidden', 'false');
        document.body.classList.add('cg-nav-open');
        setTimeout(() => input && input.focus(), 80);
        renderSearchResults('');
    }

    function closeSearch() {
        const modal = document.getElementById('vg-search-modal');
        if (!modal) return;
        modal.classList.remove('is-open');
        modal.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('cg-nav-open');
    }

    function renderSearchResults(q) {
        const box = document.getElementById('vg-search-results');
        if (!box) return;
        const query = String(q || '')
            .trim()
            .toLowerCase();
        const list = query
            ? SEARCH_ITEMS.filter((i) => i.label.toLowerCase().includes(query))
            : SEARCH_ITEMS;
        if (!list.length) {
            box.innerHTML = '<p style="padding:16px;color:#64748b;text-align:center;">No matches</p>';
            return;
        }
        box.innerHTML = list
            .map((item, idx) => {
                return (
                    '<button type="button" class="vg-search-item" data-search-idx="' +
                    idx +
                    '"><i class="fas ' +
                    item.icon +
                    '"></i><span>' +
                    item.label +
                    '</span></button>'
                );
            })
            .join('');
        box.querySelectorAll('.vg-search-item').forEach((btn, idx) => {
            btn.addEventListener('click', () => navigateSearchItem(list[idx]));
        });
    }

    function navigateSearchItem(item) {
        closeSearch();
        if (item.action === 'register' && typeof openRegisterModal === 'function') {
            openRegisterModal();
            return;
        }
        if (item.href) {
            window.location.href = item.href;
            return;
        }
        if (item.section && typeof window.showSection === 'function') {
            window.showSection(item.section);
            if (item.anchor) {
                setTimeout(() => {
                    document.getElementById(item.anchor)?.scrollIntoView({ behavior: 'smooth' });
                }, 200);
            }
        }
    }

    function bindSearch() {
        document.getElementById('vg-search-open')?.addEventListener('click', openSearch);
        document.getElementById('vg-search-close')?.addEventListener('click', closeSearch);
        document.getElementById('vg-search-modal')?.addEventListener('click', (e) => {
            if (e.target.id === 'vg-search-modal') closeSearch();
        });
        document.getElementById('vg-search-input')?.addEventListener('input', (e) => {
            renderSearchResults(e.target.value);
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeSearch();
            if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                e.preventDefault();
                openSearch();
            }
        });
    }

    async function loadHomeStats() {
        const grid = document.getElementById('vg-stats-grid');
        if (!grid) return;
        let seminars = 0;
        let speakers = 0;
        try {
            const [sRes, cmsRes] = await Promise.all([
                fetch('/api/seminars?bucket=current', { cache: 'no-store' }),
                fetch('/api/public/site-cms', { cache: 'no-store' })
            ]);
            const seminarsData = await sRes.json().catch(() => []);
            const cms = await cmsRes.json().catch(() => ({}));
            seminars = Array.isArray(seminarsData) ? seminarsData.length : 0;
            speakers = Array.isArray(cms.speakers) ? cms.speakers.length : 0;
        } catch (_) {}

        const stats = [
            { value: seminars || '1+', label: 'Active seminars' },
            { value: speakers || '20+', label: 'Expert speakers' },
            { value: '1972', label: 'Founded' },
            { value: '24/7', label: 'Online portal' }
        ];
        grid.innerHTML = stats
            .map(
                (s) =>
                    '<div class="vg-stat"><strong>' +
                    s.value +
                    '</strong><span>' +
                    s.label +
                    '</span></div>'
            )
            .join('');
    }

    document.addEventListener('DOMContentLoaded', () => {
        bindScrollProgress();
        bindBackToTop();
        bindSearch();
        loadHomeStats();
    });
})();
