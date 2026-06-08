/**
 * Homepage stats strip — values from Admin → Website & doctor updates → hero stats.
 */
(function () {
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/"/g, '&quot;');
    }

    const DEFAULT_STATS = [
        { value: '@active_seminars', label: 'Active seminars' },
        { value: '@speaker_count', label: 'Expert speakers' },
        { value: '1972', label: 'Founded' },
        { value: '24/7', label: 'Online portal' }
    ];

    function resolveStatValue(raw, ctx) {
        const v = String(raw || '').trim();
        if (!v) return '';
        const key = v.toLowerCase();
        if (key === '@active_seminars' || key === 'auto:seminars') {
            return ctx.activeSeminars > 0 ? String(ctx.activeSeminars) : '1+';
        }
        if (key === '@speaker_count' || key === 'auto:speakers') {
            return ctx.speakerCount > 0 ? String(ctx.speakerCount) : '20+';
        }
        return v;
    }

    async function fetchStatsContext(cmsOverride) {
        let activeSeminars = 0;
        let speakerCount = 0;
        let cms = cmsOverride || {};
        try {
            const requests = cmsOverride
                ? [fetch('/api/seminars?bucket=current', { cache: 'no-store' })]
                : [
                      fetch('/api/seminars?bucket=current', { cache: 'no-store' }),
                      fetch('/api/public/site-cms', { cache: 'no-store' })
                  ];
            const responses = await Promise.all(requests);
            const seminarsPayload = await responses[0].json().catch(() => ({}));
            if (!cmsOverride && responses[1]) {
                cms = await responses[1].json().catch(() => ({}));
            }
            const seminars = Array.isArray(seminarsPayload)
                ? seminarsPayload
                : Array.isArray(seminarsPayload.seminars)
                  ? seminarsPayload.seminars
                  : [];
            activeSeminars = seminars.filter((s) => s && Number(s.is_active) !== 0).length;
            speakerCount = Array.isArray(cms.speakers) ? cms.speakers.length : 0;
        } catch (_) {}
        return { activeSeminars, speakerCount, cms };
    }

    window.renderHomepageStats = async function renderHomepageStats(cmsOverride) {
        const grid = document.getElementById('vg-stats-grid');
        if (!grid) return;
        const ctx = await fetchStatsContext(cmsOverride);
        const cms = ctx.cms || {};
        let rows = Array.isArray(cms.heroStats)
            ? cms.heroStats.filter((s) => s && (String(s.value || '').trim() || String(s.label || '').trim()))
            : [];
        if (!rows.length) rows = DEFAULT_STATS.slice();
        const stats = rows.map((s) => ({
            value: resolveStatValue(s.value, ctx) || '—',
            label: String(s.label || '').trim() || '—'
        }));
        grid.innerHTML = stats
            .map(
                (s) =>
                    '<div class="vg-stat"><strong>' +
                    esc(s.value) +
                    '</strong><span>' +
                    esc(s.label) +
                    '</span></div>'
            )
            .join('');
    };

    document.addEventListener('DOMContentLoaded', function () {
        window.renderHomepageStats();
    });
})();
