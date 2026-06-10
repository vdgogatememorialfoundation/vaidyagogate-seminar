/**
 * Client-side i18n — public website and doctor portal only.
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

    const NAV_SECTION_I18N = {
        home: 'nav.home',
        about: 'nav.foundation',
        schedule: 'nav.agenda',
        gallery: 'nav.gallery',
        verify: 'nav.delegates',
        certificate: 'nav.certificateVerify',
        contact: 'nav.contact'
    };

    let catalog = {};
    let locale = DEFAULT_LOCALE;
    let enabled = false;

    function isI18nEnabledPage() {
        const b = document.body;
        if (!b) return false;
        if (b.classList.contains('congress-site')) return true;
        if (b.getAttribute('data-portal-theme') === 'doctor') return true;
        return false;
    }

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

    function navSectionI18nKey(section) {
        return NAV_SECTION_I18N[String(section || '').trim()] || null;
    }

    function navLabelMarkup(section, fallbackLabel) {
        const key = navSectionI18nKey(section);
        const label = String(fallbackLabel || '').trim() || (key ? t(key) : '');
        if (!key) return label;
        return '<span data-i18n="' + key + '">' + label + '</span>';
    }

    function refreshDynamicUi() {
        if (!enabled) return;
        if (window.__siteCms && typeof window.applySiteMenu === 'function') {
            window.applySiteMenu(window.__siteCms);
        }
        if (typeof window.renderHomepageStats === 'function') {
            window.renderHomepageStats(window.__homeCms || window.__siteCms);
        }
        if (window.__siteCms && typeof window.applySiteFooterExplore === 'function') {
            window.applySiteFooterExplore(window.__siteCms);
        }
        apply(document);
    }

    function setLocale(code) {
        const next = String(code || DEFAULT_LOCALE);
        locale = LOCALES.some((l) => l.code === next) ? next : DEFAULT_LOCALE;
        try {
            localStorage.setItem(STORAGE_KEY, locale);
        } catch (_) {}
        document.documentElement.lang = locale === 'en' ? 'en' : locale;
        refreshDynamicUi();
        syncLangSelects();
        try {
            global.dispatchEvent(new CustomEvent('portal-locale-change', { detail: { locale } }));
        } catch (_) {}
    }

    function getLocale() {
        return locale;
    }

    function apply(root) {
        if (!enabled) return;
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
        const id = container.id || 'portal-lang-' + Math.random().toString(36).slice(2, 8);
        if (!container.id) container.id = id;
        container.className = 'portal-lang-wrap';
        container.innerHTML =
            '<label class="portal-lang-label" for="' +
            id +
            '-sel"><i class="fas fa-globe" aria-hidden="true"></i> <span data-i18n="lang.label">Language</span></label>' +
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

    function mountLangSelects() {
        if (!enabled) return;
        document.querySelectorAll('[data-portal-lang]').forEach((el) => renderLangSelect(el));
        syncLangSelects();
    }

    function syncLangSelects() {
        document.querySelectorAll('.portal-lang-select').forEach((sel) => {
            if (sel.value !== locale) sel.value = locale;
        });
    }

    function init() {
        enabled = isI18nEnabledPage();
        if (!enabled) return;
        locale = readStoredLocale();
        document.documentElement.lang = locale === 'en' ? 'en' : locale;
        if (global.PortalI18nMessages) registerMessages(global.PortalI18nMessages);
        mountLangSelects();
        apply(document);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    global.PortalI18n = {
        LOCALES,
        NAV_SECTION_I18N,
        registerMessages,
        t,
        setLocale,
        getLocale,
        apply,
        refreshDynamicUi,
        navSectionI18nKey,
        navLabelMarkup,
        renderLangSelect,
        mountLangSelects,
        isI18nEnabledPage
    };
})(typeof window !== 'undefined' ? window : global);
