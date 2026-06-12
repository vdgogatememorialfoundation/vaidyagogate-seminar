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

const DEFAULT_LEGAL_PAGES = {
    terms: {
        title: 'Terms & Conditions',
        body:
            'By using the Vaidya Gogate Memorial Foundation seminar portal and registering for events, you agree to these terms.\n\n' +
            'Registration information must be accurate. The Foundation may verify credentials and reject incomplete or misleading applications.\n\n' +
            'Seminar fees, schedules, and venues may change with reasonable notice. Participation is subject to seat availability and event rules communicated by the organisers.\n\n' +
            'Portal accounts must not be shared. You are responsible for activity under your login credentials.\n\n' +
            'For questions contact care@vaidyagogate.org.'
    },
    privacy: {
        title: 'Privacy Policy',
        body:
            'The Vaidya Gogate Memorial Foundation respects your privacy. This policy describes how we handle personal information collected through our website and doctor portal.\n\n' +
            'We collect information you provide during registration, support requests, and payments (such as name, email, phone, professional details, and payment references).\n\n' +
            'We use this information to process registrations, issue tickets and certificates, communicate event updates, and provide support.\n\n' +
            'We do not sell personal data. Data may be shared with payment gateways, email/WhatsApp providers, and authorised staff or volunteers strictly for event operations.\n\n' +
            'You may request correction of your profile details through the doctor portal or by emailing care@vaidyagogate.org.'
    },
    refund: {
        title: 'Refund Policy',
        body:
            'Refund eligibility depends on the cancellation policy published for each seminar at the time of registration.\n\n' +
            'Approved refunds are processed to the original payment method where possible. Processing may take 7–14 working days depending on the payment gateway and bank.\n\n' +
            'No-shows and registrations cancelled after the published deadline may not qualify for a refund unless explicitly approved by the organisers.\n\n' +
            'For refund status, sign in to the doctor portal or contact care@vaidyagogate.org with your application number.'
    }
};

function normalizeLegalPage(page, defaults) {
    const d = defaults || { title: '', body: '' };
    return {
        title: String((page && page.title) || d.title || '')
            .trim() || d.title,
        body: String((page && page.body) || d.body || '').trim() || d.body
    };
}

function normalizeLegalPages(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    return {
        terms: normalizeLegalPage(src.terms, DEFAULT_LEGAL_PAGES.terms),
        privacy: normalizeLegalPage(src.privacy, DEFAULT_LEGAL_PAGES.privacy),
        refund: normalizeLegalPage(src.refund, DEFAULT_LEGAL_PAGES.refund)
    };
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
    DEFAULT_LEGAL_PAGES,
    normalizeYoutubePlaylistUrl,
    normalizeLegalPages,
    flattenGalleryYears,
    groupGalleryToYears,
    normalizeSiteMenu,
    normalizeGalleryYears,
    normalizeSiteCms,
    getGalleryItems
};
