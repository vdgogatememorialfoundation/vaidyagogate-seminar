(function () {
    const WEBSITE_MENU_PAGE_DEFS = [
        ['home', 'Home'],
        ['about', 'Foundation'],
        ['schedule', 'Agenda'],
        ['gallery', 'Gallery'],
        ['verify', 'Delegates'],
        ['certificate', 'Certificate'],
        ['contact', 'Contact']
    ];

    function websiteMenuPagesRestrict(pages) {
        const keys = Object.keys(pages || {});
        return keys.length && keys.some(function (k) {
            return pages[k] === true;
        });
    }

    function websiteMenuPageEnabled(pages, key) {
        if (!websiteMenuPagesRestrict(pages)) return true;
        return pages[key] === true;
    }

    function labelForSection(section, siteMenu, defs) {
        const items = Array.isArray(siteMenu) ? siteMenu : [];
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            if (it && String(it.section || '').trim() === section && String(it.label || '').trim()) {
                return String(it.label).trim();
            }
        }
        for (let j = 0; j < defs.length; j++) {
            if (defs[j][0] === section) return defs[j][1];
        }
        return section;
    }

    function orderedEnabledSections(pages, siteMenu, defs) {
        const out = [];
        const seen = {};
        function push(key) {
            if (!key || seen[key] || !websiteMenuPageEnabled(pages, key)) return;
            seen[key] = true;
            out.push(key);
        }
        const items = Array.isArray(siteMenu) ? siteMenu.slice() : [];
        items.sort(function (a, b) {
            return (Number(a.order) || 0) - (Number(b.order) || 0);
        });
        items.forEach(function (it) {
            if (it && it.visible !== false && String(it.section || '').trim()) {
                push(String(it.section).trim());
            }
        });
        defs.forEach(function (pair) {
            push(pair[0]);
        });
        return out;
    }

    function buildFooterExploreLinks(pages, siteMenu) {
        const defs = WEBSITE_MENU_PAGE_DEFS;
        return orderedEnabledSections(pages, siteMenu, defs)
            .filter(function (section) {
                return section !== 'certificate';
            })
            .map(function (section) {
                return {
                    label: labelForSection(section, siteMenu, defs),
                    section: section
                };
            });
    }

    function filterSiteMenuItems(pages, siteMenu) {
        const items = Array.isArray(siteMenu) ? siteMenu : [];
        return items.filter(function (it) {
            if (!it || it.visible === false) return false;
            const section = String(it.section || '').trim();
            const href = String(it.href || '').trim();
            if (href && (href.startsWith('/') || href.startsWith('http'))) {
                if (href.indexOf('verify-certificate') !== -1) {
                    return websiteMenuPageEnabled(pages, 'certificate');
                }
                return true;
            }
            if (!section) return false;
            return websiteMenuPageEnabled(pages, section);
        });
    }

    window.PortalWebsiteMenu = {
        defs: WEBSITE_MENU_PAGE_DEFS,
        pageEnabled: websiteMenuPageEnabled,
        buildFooterExploreLinks: buildFooterExploreLinks,
        filterSiteMenuItems: filterSiteMenuItems,
        orderedEnabledSections: orderedEnabledSections,
        labelForSection: labelForSection
    };
})();
