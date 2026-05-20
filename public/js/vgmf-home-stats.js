/**
 * Homepage stats strip (minimal — no search/scroll extras).
 */
(function () {
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

    document.addEventListener('DOMContentLoaded', loadHomeStats);
})();
