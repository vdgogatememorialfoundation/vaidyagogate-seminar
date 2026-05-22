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
            byYear.set(year, { year, title: '', images: [] });
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
            images: (Array.isArray(yg && yg.images) ? yg.images : [])
                .map((img) => ({
                    src: String((img && img.src) || '').trim(),
                    caption: String((img && img.caption) || '').trim()
                }))
                .filter((img) => img.src)
        }))
        .filter((yg) => yg.year && yg.images.length);
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
    return normalizeGalleryYears(base);
}

function getGalleryItems(cms) {
    const normalized = normalizeGalleryYears({ ...cms });
    return normalized.pastSeminarGallery || [];
}

module.exports = {
    DEFAULT_SITE_MENU,
    flattenGalleryYears,
    groupGalleryToYears,
    normalizeSiteMenu,
    normalizeGalleryYears,
    normalizeSiteCms,
    getGalleryItems
};
