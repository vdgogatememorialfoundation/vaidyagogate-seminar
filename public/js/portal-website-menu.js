(function () {
    const WEBSITE_MENU_PAGE_DEFS = [
        ['home', 'Home'],
        ['about', 'Foundation'],
        ['schedule', 'Agenda'],
        ['gallery', 'Gallery'],
        ['verify', 'Delegates'],
        ['certificate', 'Certificate'],
        ['contact', 'Contact'],
        ['legal', 'Legal (all policy pages)']
    ];

    function websiteMenuPagesRestrict(pages) {
        const keys = Object.keys(pages || {});
        return keys.length && keys.some(function (k) {
            return pages[k] === true;
        });
    }

    function normalizeLegalPagesList(raw) {
        if (Array.isArray(raw)) return raw;
        if (raw && typeof raw === 'object') {
            return ['terms', 'privacy', 'refund']
                .map(function (id, idx) {
                    return {
                        id: id,
                        title: raw[id] && raw[id].title,
                        body: raw[id] && raw[id].body,
                        order: idx + 1
                    };
                })
                .filter(function (p) {
                    return (p.title && String(p.title).trim()) || (p.body && String(p.body).trim());
                });
        }
        return [];
    }

    function isLegalMenuKey(key) {
        const k = String(key || '');
        return k === 'legal' || k.indexOf('legal-') === 0;
    }

    function websiteMenuPageEnabled(pages, key) {
        if (!websiteMenuPagesRestrict(pages)) return true;
        if (isLegalMenuKey(key)) {
            return pages[key] !== false;
        }
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
                return section !== 'certificate' && section !== 'legal';
            })
            .map(function (section) {
                return {
                    label: labelForSection(section, siteMenu, defs),
                    section: section
                };
            });
    }

    function legalPageMenuKey(id) {
        const slug = String(id || '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
        return 'legal-' + (slug || 'page');
    }

    function legalPageIdFromHref(href) {
        const h = String(href || '');
        if (h.indexOf('legal.html') === -1) return '';
        const m = h.match(/[?&]p=([^&#]+)/i);
        if (!m) return '';
        try {
            return decodeURIComponent(m[1]).trim().toLowerCase();
        } catch (_) {
            return String(m[1] || '').trim().toLowerCase();
        }
    }

    function renderFooterLegalLinksHtml(links, escHtml) {
        const esc = typeof escHtml === 'function' ? escHtml : function (s) { return String(s == null ? '' : s); };
        return (Array.isArray(links) ? links : [])
            .map(function (item, idx) {
                const sep =
                    idx > 0 ? '<span class="footer-legal-sep" aria-hidden="true"> | </span>' : '';
                return (
                    sep +
                    '<a href="' +
                    esc(item.href) +
                    '" data-menu-key="' +
                    esc(item.menuKey || '') +
                    '">' +
                    esc(item.title) +
                    '</a>'
                );
            })
            .join('');
    }

    function buildFooterLegalLinks(menuPages, legalPages) {
        const list = normalizeLegalPagesList(legalPages);
        return list
            .filter(function (p) {
                return p && p.id && websiteMenuPageEnabled(menuPages, legalPageMenuKey(p.id));
            })
            .sort(function (a, b) {
                return (
                    (Number(a.order) || 0) - (Number(b.order) || 0) ||
                    String(a.title || '').localeCompare(String(b.title || ''))
                );
            })
            .map(function (p) {
                return {
                    id: p.id,
                    title: p.title || p.id,
                    href: '/legal.html?p=' + encodeURIComponent(p.id),
                    menuKey: legalPageMenuKey(p.id)
                };
            });
    }

    function buildLegalMenuDefs(legalPages) {
        const list = normalizeLegalPagesList(legalPages);
        return list.map(function (p) {
            return [legalPageMenuKey(p.id), 'Legal: ' + (p.title || p.id)];
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
                if (href.indexOf('legal.html') !== -1) {
                    const legalId = legalPageIdFromHref(href);
                    if (legalId) {
                        return websiteMenuPageEnabled(pages, legalPageMenuKey(legalId));
                    }
                    return websiteMenuPageEnabled(pages, 'legal');
                }
                return true;
            }
            if (!section) return false;
            return websiteMenuPageEnabled(pages, section);
        });
    }

    function buildSiteMenuNavItems(pages, siteMenu, legalPages) {
        const defs = WEBSITE_MENU_PAGE_DEFS.filter(function (pair) {
            return pair[0] !== 'legal';
        });
        const sections = orderedEnabledSections(pages, siteMenu, defs);
        const cmsBySection = {};
        (Array.isArray(siteMenu) ? siteMenu : []).forEach(function (it) {
            if (it && String(it.section || '').trim()) {
                cmsBySection[String(it.section).trim()] = it;
            }
        });
        const items = sections.map(function (section) {
            const cmsItem = cmsBySection[section];
            const label =
                cmsItem && String(cmsItem.label || '').trim()
                    ? String(cmsItem.label).trim()
                    : labelForSection(section, siteMenu, defs);
            if (section === 'certificate') {
                return {
                    kind: 'href',
                    href: (cmsItem && cmsItem.href) || '/verify-certificate.html',
                    label: label,
                    menuKey: 'certificate'
                };
            }
            const href = cmsItem && String(cmsItem.href || '').trim();
            if (href && (href.startsWith('/') || href.startsWith('http'))) {
                return {
                    kind: 'href',
                    href: href,
                    label: label,
                    menuKey: href.indexOf('verify-certificate') !== -1 ? 'certificate' : section,
                    external: href.startsWith('http')
                };
            }
            return { kind: 'section', section: section, label: label, menuKey: section };
        });
        const legalLinks = buildFooterLegalLinks(pages, legalPages);
        if (legalLinks.length && websiteMenuPageEnabled(pages, 'legal')) {
            items.push({
                kind: 'href',
                href: '/legal.html',
                label: 'Legal',
                menuKey: 'legal',
                external: false
            });
        }
        return items;
    }

    window.PortalWebsiteMenu = {
        defs: WEBSITE_MENU_PAGE_DEFS,
        pageEnabled: websiteMenuPageEnabled,
        legalPageMenuKey: legalPageMenuKey,
        normalizeLegalPagesList: normalizeLegalPagesList,
        buildLegalMenuDefs: buildLegalMenuDefs,
        buildFooterLegalLinks: buildFooterLegalLinks,
        renderFooterLegalLinksHtml: renderFooterLegalLinksHtml,
        buildFooterExploreLinks: buildFooterExploreLinks,
        buildSiteMenuNavItems: buildSiteMenuNavItems,
        filterSiteMenuItems: filterSiteMenuItems,
        orderedEnabledSections: orderedEnabledSections,
        labelForSection: labelForSection
    };
})();
