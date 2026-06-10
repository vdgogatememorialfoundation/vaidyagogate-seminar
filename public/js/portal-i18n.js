/**
 * Client-side i18n for public site and doctor portal.
 */
(function (global) {
    const STORAGE_KEY = 'portal_locale';
    const DEFAULT_LOCALE = 'en';

    const LOCALES = [
        { code: 'en', label: 'English', native: 'English' },
        { code: 'hi', label: 'Hindi', native: 'हिन्दी' },
        { code: 'mr', label: 'Marathi', native: 'मराठी' },
        { code: 'kn', label: 'Kannada', native: 'ಕನ್ನಡ' },
        { code: 'ta', label: 'Tamil', native: 'தமிழ்' },
        { code: 'te', label: 'Telugu', native: 'తెలుగు' },
        { code: 'ml', label: 'Malayalam', native: 'മലയാളം' },
        { code: 'gu', label: 'Gujarati', native: 'ગુજરાતી' },
        { code: 'bho', label: 'Bhojpuri', native: 'भोजपुरी' },
        { code: 'pa', label: 'Punjabi', native: 'ਪੰਜਾਬੀ' },
        { code: 'bn', label: 'Bengali', native: 'বাংলা' },
        { code: 'or', label: 'Odia', native: 'ଓଡ଼ିଆ' }
    ];

    let catalog = {};
    let locale = DEFAULT_LOCALE;

    function readStoredLocale() {
        try {
            const v = String(localStorage.getItem(STORAGE_KEY) || '').trim();
            if (v && LOCALES.some((l) => l.code === v)) return v;
        } catch (_) {}
        return DEFAULT_LOCALE;
    }

    function registerMessages(map) {
        catalog = map && typeof map === 'object' ? map : {};
    }

    function t(key, vars) {
        const k = String(key || '');
        const pack = catalog[locale] || catalog[DEFAULT_LOCALE] || {};
        const fallback = (catalog[DEFAULT_LOCALE] || {})[k];
        let s = pack[k] != null ? pack[k] : fallback != null ? fallback : k;
        if (vars && typeof vars === 'object') {
            Object.keys(vars).forEach((name) => {
                s = String(s).split('{{' + name + '}}').join(String(vars[name]));
            });
        }
        return s;
    }

    function setLocale(code) {
        const next = String(code || DEFAULT_LOCALE);
        locale = LOCALES.some((l) => l.code === next) ? next : DEFAULT_LOCALE;
        try {
            localStorage.setItem(STORAGE_KEY, locale);
        } catch (_) {}
        document.documentElement.lang = locale === 'en' ? 'en' : locale;
        apply(document);
        syncLangSelects();
        try {
            global.dispatchEvent(new CustomEvent('portal-locale-change', { detail: { locale } }));
        } catch (_) {}
    }

    function getLocale() {
        return locale;
    }

    function apply(root) {
        root = root || document;
        root.querySelectorAll('[data-i18n]').forEach((el) => {
            const key = el.getAttribute('data-i18n');
            if (!key) return;
            const val = t(key);
            if (el.hasAttribute('data-i18n-html')) {
                el.innerHTML = val;
            } else {
                el.textContent = val;
            }
        });
        root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
            el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
        });
        root.querySelectorAll('[data-i18n-title]').forEach((el) => {
            el.title = t(el.getAttribute('data-i18n-title'));
        });
        root.querySelectorAll('[data-i18n-aria]').forEach((el) => {
            el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
        });
    }

    function currentLocaleMeta() {
        return LOCALES.find((l) => l.code === locale) || LOCALES[0];
    }

    function buildLangOptions(selected) {
        return LOCALES.map((l) => {
            const sel = l.code === selected ? ' selected' : '';
            return (
                '<option value="' +
                l.code +
                '"' +
                sel +
                '>' +
                l.native +
                (l.code !== 'en' ? ' · ' + l.label : '') +
                '</option>'
            );
        }).join('');
    }

    function wireLangSelect(sel) {
        if (!sel || sel.dataset.portalLangWired === '1') return;
        sel.dataset.portalLangWired = '1';
        sel.value = locale;
        sel.addEventListener('change', function () {
            setLocale(sel.value);
        });
    }

    function renderLangSelect(container) {
        if (!container) return;
        const mode = container.getAttribute('data-portal-lang-mode') || '';
        const id = container.id || 'portal-lang-' + Math.random().toString(36).slice(2, 8);
        if (!container.id) container.id = id;
        const compact = mode === 'compact' || mode === 'fab';
        container.className =
            (container.className || '')
                .split(/\s+/)
                .filter((c) => c && c !== 'portal-lang-wrap' && c !== 'portal-lang-wrap--compact')
                .join(' ') +
            ' portal-lang-wrap' +
            (compact ? ' portal-lang-wrap--compact' : '');
        const showLabel = mode !== 'fab';
        container.innerHTML =
            (showLabel
                ? '<label class="portal-lang-label" for="' +
                  id +
                  '-sel"><i class="fas fa-globe" aria-hidden="true"></i> <span data-i18n="lang.label">Language</span></label>'
                : '') +
            '<select id="' +
            id +
            '-sel" class="portal-lang-select" aria-label="' +
            t('lang.label') +
            '">' +
            buildLangOptions(locale) +
            '</select>';
        wireLangSelect(container.querySelector('select'));
        apply(container);
    }

    function ensureFloatingLangPicker() {
        if (document.getElementById('portal-lang-floating')) return;
        const fab = document.createElement('div');
        fab.id = 'portal-lang-floating';
        fab.className = 'portal-lang-fab';
        fab.setAttribute('data-portal-lang', 'site-lang-fab');
        fab.setAttribute('data-portal-lang-mode', 'fab');
        fab.innerHTML =
            '<span class="portal-lang-fab-icon" aria-hidden="true"><i class="fas fa-globe"></i></span>' +
            '<select class="portal-lang-select" id="portal-lang-fab-sel" aria-label="Language"></select>';
        document.body.appendChild(fab);
        const sel = fab.querySelector('select');
        if (sel) {
            sel.innerHTML = buildLangOptions(locale);
            wireLangSelect(sel);
        }
    }

    function mountLangSelects() {
        document.querySelectorAll('[data-portal-lang]').forEach((el) => renderLangSelect(el));
        ensureFloatingLangPicker();
        syncLangSelects();
    }

    function syncLangSelects() {
        const meta = currentLocaleMeta();
        document.querySelectorAll('.portal-lang-select').forEach((sel) => {
            if (sel.value !== locale) sel.value = locale;
            if (sel.closest('.portal-lang-fab') && meta) {
                sel.setAttribute('title', meta.native + ' (' + meta.label + ')');
            }
        });
    }

    function init() {
        locale = readStoredLocale();
        document.documentElement.lang = locale === 'en' ? 'en' : locale;
        if (global.PortalI18nMessages) registerMessages(global.PortalI18nMessages);
        apply(document);
        mountLangSelects();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    global.PortalI18n = {
        LOCALES,
        registerMessages,
        t,
        setLocale,
        getLocale,
        apply,
        renderLangSelect,
        mountLangSelects,
        ensureFloatingLangPicker
    };
})(typeof window !== 'undefined' ? window : global);
