/**
 * Public site CMS helpers — gallery by year, menu items, normalization.
 */

const DEFAULT_SITE_MENU = [
    { label: 'Home', section: 'home', href: '', visible: true, order: 1 },
    { label: 'Foundation', section: 'about', href: '', visible: true, order: 2 },
    { label: 'Agenda', section: 'schedule', href: '', visible: true, order: 3 },
    { label: 'Gallery', section: 'gallery', href: '', visible: true, order: 4 },
    { label: 'Delegates', section: 'verify', href: '', visible: true, order: 5 },
    { label: 'Certificate', section: '', href: '/verify-certificate.html', visible: true, order: 6 },
    { label: 'Contact', section: 'contact', href: '', visible: true, order: 7 }
];

const DEFAULT_LEGAL_PAGES_LIST = [
    {
        id: 'terms',
        title: 'Terms & Conditions',
        body:
            'By using the Vaidya Gogate Memorial Foundation seminar portal and registering for events, you agree to these terms.\n\n' +
            'Registration information must be accurate. The Foundation may verify credentials and reject incomplete or misleading applications.\n\n' +
            'Seminar fees, schedules, and venues may change with reasonable notice. Participation is subject to seat availability and event rules communicated by the organisers.\n\n' +
            'Portal accounts must not be shared. You are responsible for activity under your login credentials.\n\n' +
            'For questions contact care@vaidyagogate.org.',
        order: 1
    },
    {
        id: 'privacy',
        title: 'Privacy Policy',
        body:
            'The Vaidya Gogate Memorial Foundation respects your privacy. This policy describes how we handle personal information collected through our website and doctor portal.\n\n' +
            'We collect information you provide during registration, support requests, and payments (such as name, email, phone, professional details, and payment references).\n\n' +
            'We use this information to process registrations, issue tickets and certificates, communicate event updates, and provide support.\n\n' +
            'We do not sell personal data. Data may be shared with payment gateways, email/WhatsApp providers, and authorised staff or volunteers strictly for event operations.\n\n' +
            'You may request correction of your profile details through the doctor portal or by emailing care@vaidyagogate.org.',
        order: 2
    },
    {
        id: 'refund',
        title: 'Refund Policy',
        body:
            'Refund eligibility depends on the cancellation policy published for each seminar at the time of registration.\n\n' +
            'Approved refunds are processed to the original payment method where possible. Processing may take 7–14 working days depending on the payment gateway and bank.\n\n' +
            'No-shows and registrations cancelled after the published deadline may not qualify for a refund unless explicitly approved by the organisers.\n\n' +
            'For refund status, sign in to the doctor portal or contact care@vaidyagogate.org with your application number.',
        order: 3
    }
];

const DEFAULT_LEGAL_PAGES_BY_ID = Object.fromEntries(
    DEFAULT_LEGAL_PAGES_LIST.map((page) => [page.id, page])
);

function defaultLegalPagesList() {
    return DEFAULT_LEGAL_PAGES_LIST.map((page) => ({ ...page }));
}

function slugLegalPageId(raw, fallback) {
    let s = String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return s || fallback || 'page';
}

function legalPageMenuKey(id) {
    return 'legal-' + slugLegalPageId(id, 'page');
}

function normalizeLegalPages(raw) {
    let list;
    if (Array.isArray(raw)) {
        list = raw;
    } else if (raw && typeof raw === 'object') {
        if (raw.terms || raw.privacy || raw.refund) {
            list = ['terms', 'privacy', 'refund'].map((id, idx) => ({
                id,
                title: raw[id] && raw[id].title,
                body: raw[id] && raw[id].body,
                order: idx + 1
            }));
        } else {
            list = [];
        }
    } else {
        return defaultLegalPagesList();
    }

    const seen = new Set();
    const out = [];
    list.forEach((page, idx) => {
        if (!page || typeof page !== 'object') return;
        const baseId = slugLegalPageId(page.id, 'page-' + (idx + 1));
        let id = baseId;
        let n = 2;
        while (seen.has(id)) {
            id = baseId + '-' + n;
            n += 1;
        }
        seen.add(id);
        const defaults = DEFAULT_LEGAL_PAGES_BY_ID[id] || {};
        const title = String(page.title || defaults.title || '').trim() || id;
        const body = String(page.body || defaults.body || '').trim() || defaults.body || '';
        out.push({
            id,
            title,
            body,
            order: Number(page.order) || idx + 1
        });
    });

    if (!out.length) return defaultLegalPagesList();
    return out.sort(
        (a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || a.title.localeCompare(b.title)
    );
}

function legalPagesMenuDefs(pages) {
    return normalizeLegalPages(pages).map((page) => [
        legalPageMenuKey(page.id),
        'Legal: ' + page.title
    ]);
}

/** Enable legal page menu keys when CMS is saved (respect explicit false opt-out). */
function mergeLegalPagesWebsiteMenu(menuPages, legalPages) {
    const out = menuPages && typeof menuPages === 'object' ? { ...menuPages } : {};
    normalizeLegalPages(legalPages).forEach((page) => {
        const key = legalPageMenuKey(page.id);
        if (out[key] !== false) out[key] = true;
    });
    return out;
}

function normalizeYoutubePlaylistUrl(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    const listMatch = s.match(/[?&]list=([a-zA-Z0-9_-]+)/);
    if (listMatch) return 'https://www.youtube.com/playlist?list=' + listMatch[1];
    if (/^PL[\w-]+$/i.test(s)) return 'https://www.youtube.com/playlist?list=' + s;
    if (/youtube\.com|youtu\.be/i.test(s)) return s;
    return '';
}

function flattenGalleryYears(yearGroups) {
    if (!Array.isArray(yearGroups)) return [];
    const out = [];
    yearGroups.forEach((yg) => {
        const year = String((yg && yg.year) || '').trim() || 'Archive';
        const images = Array.isArray(yg && yg.images) ? yg.images : [];
        images.forEach((img) => {
            const src = String((img && img.src) || '').trim();
            if (!src) return;
            out.push({
                src,
                caption: String((img && img.caption) || '').trim(),
                year
            });
        });
    });
    return out;
}

function groupGalleryToYears(flatItems) {
    const byYear = new Map();
    (Array.isArray(flatItems) ? flatItems : []).forEach((g) => {
        const year = String((g && g.year) || '').trim() || 'Archive';
        if (!byYear.has(year)) {
            byYear.set(year, { year, title: '', youtubePlaylistUrl: '', youtubePlaylistLabel: '', images: [] });
        }
        const src = String((g && g.src) || '').trim();
        if (!src) return;
        byYear.get(year).images.push({
            src,
            caption: String((g && g.caption) || '').trim()
        });
    });
    return [...byYear.entries()]
        .map(([, v]) => v)
        .sort((a, b) => String(b.year).localeCompare(String(a.year)));
}

function normalizeSiteMenu(menu) {
    const src = Array.isArray(menu) && menu.length ? menu : DEFAULT_SITE_MENU;
    return src
        .map((item, idx) => ({
            label: String((item && item.label) || '').trim(),
            section: String((item && item.section) || '').trim(),
            href: String((item && item.href) || '').trim(),
            visible: item && item.visible === false ? false : true,
            order: Number(item && item.order) || idx + 1
        }))
        .filter((item) => item.label)
        .sort((a, b) => a.order - b.order);
}

function normalizeGalleryYears(cms) {
    const base = cms && typeof cms === 'object' ? cms : {};
    let years = Array.isArray(base.seminarGalleryYears) ? base.seminarGalleryYears : [];
    if (!years.length && Array.isArray(base.pastSeminarGallery) && base.pastSeminarGallery.length) {
        years = groupGalleryToYears(base.pastSeminarGallery);
    }
    years = years
        .map((yg) => ({
            year: String((yg && yg.year) || '').trim(),
            title: String((yg && yg.title) || '').trim(),
            youtubePlaylistUrl: normalizeYoutubePlaylistUrl(yg && yg.youtubePlaylistUrl),
            youtubePlaylistLabel: String((yg && yg.youtubePlaylistLabel) || '').trim(),
            images: (Array.isArray(yg && yg.images) ? yg.images : [])
                .map((img) => ({
                    src: String((img && img.src) || '').trim(),
                    caption: String((img && img.caption) || '').trim()
                }))
                .filter((img) => img.src)
        }))
        .filter((yg) => yg.year && (yg.images.length || yg.youtubePlaylistUrl));
    base.seminarGalleryYears = years;
    base.pastSeminarGallery = flattenGalleryYears(years);
    return base;
}

function normalizeSiteCms(cms) {
    const base = cms && typeof cms === 'object' ? { ...cms } : {};
    base.siteMenu = normalizeSiteMenu(base.siteMenu);
    try {
        const { normalizeSeo, DEFAULT_SEO } = require('./site-seo');
        base.seo = normalizeSeo(base.seo || DEFAULT_SEO);
    } catch (_) {}
    base.legalPages = normalizeLegalPages(base.legalPages);
    return normalizeGalleryYears(base);
}

function getGalleryItems(cms) {
    const normalized = normalizeGalleryYears({ ...cms });
    return normalized.pastSeminarGallery || [];
}

module.exports = {
    DEFAULT_SITE_MENU,
    DEFAULT_LEGAL_PAGES: defaultLegalPagesList(),
    DEFAULT_LEGAL_PAGES_LIST,
    defaultLegalPagesList,
    slugLegalPageId,
    legalPageMenuKey,
    legalPagesMenuDefs,
    mergeLegalPagesWebsiteMenu,
    normalizeYoutubePlaylistUrl,
    normalizeLegalPages,
    flattenGalleryYears,
    groupGalleryToYears,
    normalizeSiteMenu,
    normalizeGalleryYears,
    normalizeSiteCms,
    getGalleryItems
};
