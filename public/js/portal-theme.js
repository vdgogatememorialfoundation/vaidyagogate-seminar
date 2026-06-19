/**
 * Apply admin-configured portal theme tokens as CSS variables.
 */
(function () {
    const MAP = {
        public: {
            '--cg-green': 'primaryDark',
            '--cg-green-mid': 'primaryMid',
            '--cg-green-dark': 'primaryDark',
            '--cg-gold': 'accent',
            '--cg-text': 'text',
            '--cg-ink': 'text',
            '--cg-bg': 'background',
            '--cg-font': 'fontFamily',
            '--cg-display': 'fontDisplay'
        },
        doctor: {
            '--doctor-primary': 'primary',
            '--doctor-primary-dark': 'primaryDark',
            '--doctor-accent': 'accent',
            '--doctor-sidebar': 'sidebar',
            '--doctor-sidebar-deep': 'sidebarDeep',
            '--doctor-sidebar-text': 'sidebarText',
            '--doctor-sidebar-text-muted': 'sidebarTextMuted',
            '--doctor-sidebar-heading': 'sidebarHeading',
            '--doctor-bg': 'background',
            '--doctor-text': 'text',
            '--doctor-font': 'fontFamily'
        },
        judge: {
            '--judge-primary': 'primary',
            '--judge-primary-mid': 'primaryMid',
            '--judge-primary-dark': 'primaryDark',
            '--judge-accent': 'accent',
            '--judge-bg': 'background',
            '--judge-text': 'text',
            '--judge-font': 'fontFamily',
            '--judge-font-display': 'fontDisplay'
        }
    };

    const JUDGE_BRIDGE = {
        '--jp-emerald': 'primary',
        '--jp-emerald-dark': 'primaryDark',
        '--jp-emerald-deep': 'primaryDark',
        '--jp-emerald-muted': 'primaryMid',
        '--jp-gold': 'accent',
        '--jp-bg': 'background',
        '--jp-bg-accent': 'background',
        '--jp-text': 'text',
        '--jp-text-soft': 'text',
        '--jp-font': 'fontFamily',
        '--jp-display': 'fontDisplay'
    };

    function detectPortal() {
        const p = document.body && document.body.getAttribute('data-portal-theme');
        if (p) return p;
        if (/\/doctor(?:\.html)?$/i.test(location.pathname)) return 'doctor';
        if (/\/judge(?:\.html)?$/i.test(location.pathname)) return 'judge';
        if (document.documentElement.classList.contains('congress-site')) return 'public';
        return 'public';
    }

    function setVars(root, theme, map) {
        if (!theme) return;
        Object.keys(map).forEach((cssVar) => {
            const key = map[cssVar];
            const val = theme[key];
            if (val) root.style.setProperty(cssVar, val);
        });
    }

    function applyTheme(portal, theme) {
        if (!theme) return;
        const root = document.documentElement;
        const body = document.body;
        setVars(root, theme, MAP[portal] || MAP.public);

        if (portal === 'public') {
            if (theme.fontFamily && body) body.style.fontFamily = theme.fontFamily;
            if (theme.text && body) body.style.color = theme.text;
            if (theme.background && body) body.style.background = theme.background;
        }

        if (portal === 'doctor') {
            setVars(root, theme, MAP.doctor);
            if (theme.fontFamily && body) body.style.fontFamily = theme.fontFamily;
            if (theme.text && body) body.style.color = theme.text;
            if (theme.primary) {
                root.style.setProperty('--doctor-primary', theme.primary);
            }
            if (theme.sidebar) {
                root.style.setProperty('--doctor-sidebar', theme.sidebar);
            }
        }

        if (portal === 'judge') {
            setVars(root, theme, MAP.judge);
            setVars(root, theme, JUDGE_BRIDGE);
            if (theme.fontFamily && body) body.style.fontFamily = theme.fontFamily;
            if (theme.background && body) body.style.background = theme.background;
            if (theme.text && body) body.style.color = theme.text;
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
