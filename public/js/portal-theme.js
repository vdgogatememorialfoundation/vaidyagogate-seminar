/**
 * Apply admin-configured portal theme tokens as CSS variables.
 */
(function () {
    const MAP = {
        public: {
            '--cg-green': 'primary',
            '--cg-green-mid': 'primaryMid',
            '--cg-green-dark': 'primaryDark',
            '--cg-gold': 'accent',
            '--cg-text': 'text',
            '--cg-bg': 'background'
        },
        doctor: {
            '--doctor-primary': 'primary',
            '--doctor-primary-dark': 'primaryDark',
            '--doctor-accent': 'accent',
            '--doctor-sidebar': 'sidebar',
            '--doctor-bg': 'background',
            '--doctor-text': 'text'
        },
        judge: {
            '--judge-primary': 'primary',
            '--judge-primary-mid': 'primaryMid',
            '--judge-primary-dark': 'primaryDark',
            '--judge-accent': 'accent',
            '--judge-bg': 'background',
            '--judge-text': 'text'
        }
    };

    function detectPortal() {
        const p = document.body && document.body.getAttribute('data-portal-theme');
        if (p) return p;
        if (/\/doctor\.html/i.test(location.pathname)) return 'doctor';
        if (/\/judge\.html/i.test(location.pathname)) return 'judge';
        if (document.documentElement.classList.contains('congress-site')) return 'public';
        return 'public';
    }

    function applyTheme(portal, theme) {
        const map = MAP[portal] || MAP.public;
        const root = document.documentElement;
        Object.keys(map).forEach((cssVar) => {
            const key = map[cssVar];
            const val = theme && theme[key];
            if (val) root.style.setProperty(cssVar, val);
        });
        if (portal === 'doctor' && theme && theme.sidebar) {
            const side = document.querySelector('.sidebar');
            if (side) side.style.background = theme.sidebar;
        }
        if (portal === 'judge' && theme) {
            if (theme.background) document.body.style.background = theme.background;
            if (theme.primary) {
                document.querySelectorAll('.btn-primary, .btn-submit').forEach((el) => {
                    el.style.background = `linear-gradient(135deg, ${theme.primary}, ${theme.primaryMid || theme.primary})`;
                });
            }
        }
    }

    async function loadAndApply(portal) {
        try {
            const res = await fetch('/api/public/portal-theme/' + encodeURIComponent(portal), {
                cache: 'no-store'
            });
            const data = await res.json();
            if (data && data.theme) applyTheme(portal, data.theme);
        } catch (e) {
            console.warn('[portal-theme]', e.message);
        }
    }

    window.PortalTheme = { applyTheme, loadAndApply, detectPortal };

    document.addEventListener('DOMContentLoaded', () => {
        loadAndApply(detectPortal());
    });
})();
