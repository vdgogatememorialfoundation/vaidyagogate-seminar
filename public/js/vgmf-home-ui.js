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
        const groups = { Sections: [], Actions: [], External: [] };
        list.forEach((item) => {
            if (item.href) groups.External.push(item);
            else if (item.action) groups.Actions.push(item);
            else groups.Sections.push(item);
        });
        const flat = [];
        box.innerHTML = Object.entries(groups)
            .filter(([, arr]) => arr.length)
            .map(([label, arr]) => {
                const items = arr
                    .map((item) => {
                        const idx = flat.push(item) - 1;
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
                return '<div class="vg-search-group"><h5 style="padding:8px 12px;color:#64748b;">' + label + '</h5>' + items + '</div>';
            })
            .join('');
        box.querySelectorAll('.vg-search-item').forEach((btn) => {
            const idx = parseInt(btn.getAttribute('data-search-idx'), 10);
            btn.addEventListener('click', () => navigateSearchItem(flat[idx]));
        });
    }

    function bindAccessibilityControls() {
        const panel = document.getElementById('vg-accessibility-panel');
        const toggle = document.getElementById('vg-accessibility-toggle');
        if (!panel || !toggle) return;
        const highContrast = document.getElementById('a11y-high-contrast');
        const reducedMotion = document.getElementById('a11y-reduced-motion');
        const textSize = document.getElementById('a11y-text-size');
        const apply = () => {
            document.body.classList.toggle('a11y-high-contrast', !!highContrast?.checked);
            document.body.classList.toggle('a11y-reduced-motion', !!reducedMotion?.checked);
            document.documentElement.style.fontSize = (textSize?.value || '100') + '%';
            localStorage.setItem(
                'vgmf_a11y',
                JSON.stringify({
                    highContrast: !!highContrast?.checked,
                    reducedMotion: !!reducedMotion?.checked,
                    textSize: textSize?.value || '100'
                })
            );
        };
        try {
            const pref = JSON.parse(localStorage.getItem('vgmf_a11y') || '{}');
            if (highContrast) highContrast.checked = !!pref.highContrast;
            if (reducedMotion) reducedMotion.checked = !!pref.reducedMotion;
            if (textSize && pref.textSize) textSize.value = pref.textSize;
        } catch (_) {}
        apply();
        toggle.addEventListener('click', () => panel.classList.toggle('hidden'));
        highContrast?.addEventListener('change', apply);
        reducedMotion?.addEventListener('change', apply);
        textSize?.addEventListener('change', apply);
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
        bindAccessibilityControls();
        loadHomeStats();
    });
})();
