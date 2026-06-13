/**
 * VGMF Congress — premium homepage UI (hero, ticker, quick access, programme timeline)
 */
(function () {
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function mediaUrl(path) {
        if (!path) return '';
        let p = String(path).trim();
        if (!p) return '';
        if (/^https?:\/\//i.test(p)) return p;
        if (p.startsWith('/uploads/api/assets/')) {
            p = '/api/assets/' + p.slice('/uploads/api/assets/'.length);
        } else if (p.startsWith('uploads/api/assets/')) {
            p = '/api/assets/' + p.slice('uploads/api/assets/'.length);
        } else if (/^(upload_asset_|cert_|file_)/i.test(p)) {
            p = '/api/assets/' + encodeURIComponent(p);
        } else if (p.startsWith('api/assets/')) {
            p = '/' + p;
        }
        if (p.startsWith('/')) return p;
        return '/uploads/' + p;
    }

    const QUICK_ACCESS = [
        { icon: 'fa-user-plus', title: 'Start enrollment', text: 'Create your doctor account', action: 'register' },
        { icon: 'fa-user-md', title: "Doctor's Portal Sign In", text: 'Sign in and manage applications', href: '/doctor' },
        { icon: 'fa-calendar-alt', title: 'Event agenda', text: 'Sessions and timings', section: 'schedule' },
        { icon: 'fa-microphone', title: 'Faculty board', text: 'Featured experts', section: 'home', anchor: 'speakers-section' },
        { icon: 'fa-ticket-alt', title: 'Open windows', text: 'Current registrations', section: 'home', anchor: 'seminars-section' },
        { icon: 'fa-images', title: 'Seminar gallery', text: 'Past highlights', section: 'gallery' },
        { icon: 'fa-shield-check', title: 'Delegate directory', text: 'Paid participant lookup', section: 'verify' },
        { icon: 'fa-award', title: 'Certificate authenticity', text: 'OTP validation', href: '/verify-certificate' },
        { icon: 'fa-info-circle', title: 'Foundation profile', text: 'Mission and history', section: 'about' },
        { icon: 'fa-envelope', title: 'Support desk', text: 'Contact the office', section: 'contact' }
    ];
    window.VGMF_QUICK_ACCESS = QUICK_ACCESS;

    let heroIndex = 0;
    let heroTimer = null;
    let heroSlides = [];

    function renderQuickAccess() {
        const grid = document.getElementById('cg-quick-grid');
        if (!grid) return;
        grid.innerHTML = QUICK_ACCESS.map((c) => {
            let onclick = '';
            if (c.section && typeof showSection === 'function') {
                onclick = `onclick="showSection('${c.section}');${c.anchor ? "document.getElementById('" + c.anchor + "')?.scrollIntoView({behavior:'smooth'});" : ''} return false;"`;
            } else if (c.action === 'register') {
                onclick = `onclick="openRegisterModal(); return false;"`;
            }
            const href = c.href || '#';
            return (
                '<a class="cg-quick-card" href="' +
                esc(href) +
                '" ' +
                onclick +
                '><div class="cg-quick-icon"><i class="fas ' +
                esc(c.icon) +
                '"></i></div><h3>' +
                esc(c.title) +
                '</h3><p>' +
                esc(c.text) +
                '</p></a>'
            );
        }).join('');
    }

    function formatSeminarHeroDate(value) {
        if (!value) return '';
        if (window.PortalDateTime && window.PortalDateTime.formatEvent) {
            return window.PortalDateTime.formatEvent(value) || '';
        }
        return String(value);
    }

    function seminarHeroImagePath(seminar) {
        if (!seminar) return '';
        if (seminar.hero_image_path) return mediaUrl(seminar.hero_image_path);
        if (seminar.flyer_path) return mediaUrl(seminar.flyer_path);
        try {
            const gallery = seminar.gallery_paths ? JSON.parse(seminar.gallery_paths) : [];
            if (Array.isArray(gallery) && gallery.length) return mediaUrl(gallery[0]);
        } catch (_) {}
        return '';
    }

    function buildMarketingBannerSlides(banners, cms) {
        return (Array.isArray(banners) ? banners : [])
            .filter((b) => b && (b.imagePath || b.imagepath || b.image_path))
            .map((b) => {
                const imagePath = b.imagePath || b.imagepath || b.image_path;
                const title = (b.title && String(b.title).trim()) || '';
                const subtitle =
                    (b.subtitle && String(b.subtitle).trim()) ||
                    (b.description && String(b.description).trim()) ||
                    '';
                const cta = (b.ctaText && String(b.ctaText).trim()) || '';
                return {
                    image: mediaUrl(imagePath),
                    title,
                    subtitle,
                    eyebrow: '',
                    cta,
                    link: (b.ctaUrl && String(b.ctaUrl).trim()) || '#register',
                    cta2: '',
                    link2: '',
                    imageOnly: true
                };
            });
    }

    function bannerSlideHasCopy(sl) {
        return !!(sl && (sl.title || sl.subtitle || sl.eyebrow || sl.cta));
    }

    function bannerFrameClass(i) {
        return ['congress-hero-slide--frame-a', 'congress-hero-slide--frame-b', 'congress-hero-slide--frame-c'][
            i % 3
        ];
    }

    function renderBannerHeroSlide(sl, i) {
        const primary = heroPrimaryCtaAttrs(sl);
        const cta2 =
            sl.cta2 && sl.link2
                ? `<a href="${esc(sl.link2)}" class="cg-btn-ghost" onclick="${sl.link2 === '#' ? "showSection('schedule');return false;" : ''}">${esc(sl.cta2)}</a>`
                : '';
        const copyBlock = bannerSlideHasCopy(sl)
            ? '<div class="congress-hero-content congress-hero-content--banner-copy">' +
              (sl.eyebrow
                  ? '<span class="congress-hero-eyebrow">' + esc(sl.eyebrow) + '</span>'
                  : '') +
              (sl.title ? '<h2>' + esc(sl.title) + '</h2>' : '') +
              (sl.subtitle ? '<p class="lead">' + esc(sl.subtitle) + '</p>' : '') +
              (sl.cta
                  ? '<div class="congress-hero-actions">' +
                    '<a href="' +
                    primary.href +
                    '" class="cg-btn-primary"' +
                    primary.onclick +
                    '>' +
                    esc(sl.cta) +
                    ' <i class="fas fa-arrow-right"></i></a>' +
                    cta2 +
                    '</div>'
                  : '') +
              '</div>'
            : '';
        const imgUrl = esc(sl.image);
        return (
            '<div class="congress-hero-slide congress-hero-slide--banner ' +
            bannerFrameClass(i) +
            (i === 0 ? ' is-active' : '') +
            '">' +
            '<div class="congress-hero-banner-stage" aria-hidden="true">' +
            '<div class="congress-hero-banner-glow"></div>' +
            '<div class="congress-hero-banner-frame" data-banner-src="' +
            imgUrl +
            '">' +
            '<img class="congress-hero-banner-img" src="' +
            imgUrl +
            '" alt="" loading="eager" decoding="async"' +
            (i === 0 ? ' fetchpriority="high"' : '') +
            '>' +
            '<span class="congress-hero-banner-missing" aria-hidden="true">Banner image unavailable — re-upload in Admin</span>' +
            '</div></div>' +
            copyBlock +
            '</div>'
        );
    }

    function buildSeminarHeroSlides(seminars) {
        const list = Array.isArray(seminars) ? seminars.filter((s) => s && Number(s.is_active) !== 0) : [];
        if (!list.length) return [];
        return list
            .map((s) => {
                const image = seminarHeroImagePath(s);
                if (!image) return null;
                const when = formatSeminarHeroDate(s.event_date);
                const venue = s.venue ? String(s.venue).trim() : '';
                const meta = [when, venue].filter(Boolean);
                const desc = s.description ? String(s.description).trim().slice(0, 140) : '';
                const year = s.portal_year || (s.event_date ? String(s.event_date).slice(0, 4) : '');
                return {
                    image,
                    title: s.title || 'National Seminar',
                    subtitle: meta.join(' · ') || desc || 'Register for this live seminar',
                    eyebrow: year ? 'Live seminar · ' + year : 'Live seminar',
                    cta: 'Register now',
                    link: '#register',
                    cta2: 'View programme',
                    link2: '#schedule'
                };
            })
            .filter(Boolean);
    }

    function buildHeroSlides(cms, marketingBanners) {
        const slides = [];
        const seen = new Set();
        const hero = (cms && cms.hero) || {};
        function pushSlide(sl) {
            if (!sl || (!sl.title && !sl.image)) return;
            const key = String(sl.image || '') + '|' + String(sl.title || '');
            if (seen.has(key)) return;
            seen.add(key);
            slides.push(sl);
        }
        const uploaded = buildMarketingBannerSlides(marketingBanners, cms);
        uploaded.forEach(pushSlide);
        const hasUploaded = uploaded.length > 0;
        const fromCms = Array.isArray(cms && cms.slides) ? cms.slides : [];
        if (!hasUploaded) fromCms.forEach((sl) => {
            if (!sl || (!sl.image && !sl.title)) return;
            pushSlide({
                image: mediaUrl(sl.image),
                title: sl.title || 'National Seminar',
                subtitle: sl.subtitle || '',
                eyebrow: 'Featured',
                cta: sl.cta || (cms.hero && cms.hero.ctaPrimary) || 'Register now',
                link: sl.link || '#register',
                cta2: sl.cta2 || '',
                link2: sl.link2 || ''
            });
        });
        if (!hasUploaded && !slides.length && (hero.image || hero.title)) {
            pushSlide({
                image: mediaUrl(hero.image),
                title: hero.title || 'VGMF National Seminar',
                subtitle: hero.venue || hero.subtitle || '',
                eyebrow: hero.eyebrow || 'National Seminar Portal',
                cta: hero.ctaPrimary || 'Register now',
                link: '#register',
                cta2: hero.ctaSecondary || 'View programme',
                link2: '#schedule'
            });
        }
        if (!slides.length) {
            pushSlide({
                image: '',
                title: hero.title || 'VGMF National Seminar',
                subtitle: hero.subtitle || hero.venue || 'Register for upcoming live seminars',
                eyebrow: hero.eyebrow || 'National Seminar Portal',
                cta: hero.ctaPrimary || 'Register now',
                link: '#register',
                cta2: hero.ctaSecondary || 'Programme',
                link2: '#schedule'
            });
        }
        return slides;
    }

    async function loadHeroSeminars() {
        try {
            const res = await fetch('/api/seminars?bucket=current', { cache: 'no-store' });
            const data = await res.json();
            window.__heroSeminars = (data && data.seminars) || [];
        } catch (_) {
            window.__heroSeminars = [];
        }
        return window.__heroSeminars;
    }

    async function loadHeroMarketing() {
        try {
            const res = await fetch('/api/public/marketing', { cache: 'no-store' });
            const data = await res.json();
            window.__heroMarketingBanners = (data && data.banners) || [];
            if (data && data.carousel && data.carousel.autoSlideMs) {
                window.__heroCarouselMs = data.carousel.autoSlideMs;
            }
        } catch (_) {
            window.__heroMarketingBanners = [];
        }
        return window.__heroMarketingBanners;
    }

    function showHeroSlide(i) {
        const root = document.getElementById('congress-hero-slides');
        const dots = document.getElementById('congress-hero-dots');
        if (!root || !heroSlides.length) return;
        heroIndex = ((i % heroSlides.length) + heroSlides.length) % heroSlides.length;
        root.querySelectorAll('.congress-hero-slide').forEach((el, idx) => {
            el.classList.toggle('is-active', idx === heroIndex);
        });
        if (dots) {
            dots.querySelectorAll('button').forEach((btn, idx) => {
                btn.classList.toggle('is-active', idx === heroIndex);
            });
        }
        capBannerHeroImages();
    }

    function startHeroAutoplay() {
        if (heroTimer) clearInterval(heroTimer);
        if (heroSlides.length < 2) return;
        heroTimer = setInterval(() => showHeroSlide(heroIndex + 1), 6000);
    }

    function heroPrimaryCtaAttrs(sl) {
        const link = String(sl.link || '').trim();
        const cta = String(sl.cta || '');
        const isRegister =
            link === '#register' ||
            link === '/doctor' ||
            /register/i.test(cta) ||
            /register/i.test(link);
        if (isRegister) {
            return {
                href: '#',
                onclick: ' onclick="if(typeof openRegisterModal===\'function\'){openRegisterModal();}return false;"'
            };
        }
        return { href: esc(link || '#'), onclick: '' };
    }

    window.renderCongressHero = function renderCongressHero(cms) {
        const root = document.getElementById('congress-hero-slides');
        const dots = document.getElementById('congress-hero-dots');
        const heroRoot = document.getElementById('congress-hero-root');
        if (!root) return;
        heroSlides = buildHeroSlides(cms || {}, window.__heroMarketingBanners || []);
        const bannerMode = heroSlides.some((sl) => sl.imageOnly && sl.image);
        if (heroRoot) {
            heroRoot.classList.toggle('congress-hero--banner-mode', bannerMode);
        }
        root.innerHTML = heroSlides
            .map((sl, i) => {
                if (sl.imageOnly && sl.image) return renderBannerHeroSlide(sl, i);
                const bg = sl.image
                    ? `style="background-image:url('${esc(sl.image)}')"`
                    : 'style="background:linear-gradient(135deg,#0f766e,#134e4a)"';
                const cta2 =
                    sl.cta2 && sl.link2
                        ? `<a href="${esc(sl.link2)}" class="cg-btn-ghost" onclick="${sl.link2 === '#' ? "showSection('schedule');return false;" : ''}">${esc(sl.cta2)}</a>`
                        : '';
                const primary = heroPrimaryCtaAttrs(sl);
                return (
                    '<div class="congress-hero-slide' +
                    (i === 0 ? ' is-active' : '') +
                    '">' +
                    '<div class="congress-hero-bg" ' +
                    bg +
                    '></div>' +
                    '<div class="congress-hero-overlay"></div>' +
                    '<div class="congress-hero-content">' +
                    '<span class="congress-hero-eyebrow"><i class="fas fa-certificate"></i> ' +
                    esc(sl.eyebrow || 'Live seminar') +
                    '</span>' +
                    '<h2>' +
                    esc(sl.title) +
                    '</h2>' +
                    '<p class="lead">' +
                    esc(sl.subtitle) +
                    '</p>' +
                    '<div class="congress-hero-actions">' +
                    '<a href="' +
                    primary.href +
                    '" class="cg-btn-primary"' +
                    primary.onclick +
                    '>' +
                    esc(sl.cta) +
                    ' <i class="fas fa-arrow-right"></i></a>' +
                    cta2 +
                    '</div></div></div>'
                );
            })
            .join('');
        if (dots) {
            dots.innerHTML = heroSlides
                .map(
                    (_, i) =>
                        '<button type="button" data-i="' +
                        i +
                        '" class="' +
                        (i === 0 ? 'is-active' : '') +
                        '" aria-label="Slide ' +
                        (i + 1) +
                        '"></button>'
                )
                .join('');
            dots.querySelectorAll('button').forEach((btn) => {
                btn.addEventListener('click', () => {
                    showHeroSlide(parseInt(btn.dataset.i, 10));
                    startHeroAutoplay();
                });
            });
        }
        startHeroAutoplay();
        capBannerHeroImages();
        preloadHeroBanners();
        if (typeof window.dismissSitePreloader === 'function') window.dismissSitePreloader();
    };

    function capBannerHeroImages() {
        const imgs = document.querySelectorAll('.congress-hero-banner-img');
        imgs.forEach(function (img) {
            if (img.dataset.capBound === '1') return;
            img.dataset.capBound = '1';
            const frame = img.closest('.congress-hero-banner-frame');
            const stage = img.closest('.congress-hero-banner-stage');
            if (frame) frame.classList.add('is-pending');
            const src = String(img.getAttribute('src') || '').trim();
            function finish(ok) {
                img.classList.add('is-ready');
                if (frame) {
                    frame.classList.remove('is-pending');
                    frame.classList.toggle('is-missing-image', !ok);
                }
                if (stage && ok) stage.classList.add('is-ready');
            }
            if (!src) {
                finish(false);
                return;
            }
            function checkLoaded() {
                finish(img.naturalWidth > 0 && img.naturalHeight > 0);
            }
            img.addEventListener('load', checkLoaded, { once: true });
            img.addEventListener('error', function () {
                finish(false);
            }, { once: true });
            if (img.complete) {
                if (typeof img.decode === 'function') {
                    img.decode().then(checkLoaded).catch(function () {
                        finish(false);
                    });
                } else {
                    window.setTimeout(checkLoaded, 0);
                }
            }
        });
    }

    function preloadHeroBanners() {
        const seen = {};
        heroSlides.forEach(function (sl, i) {
            if (!sl || !sl.image || seen[sl.image]) return;
            seen[sl.image] = true;
            const link = document.createElement('link');
            link.rel = 'preload';
            link.as = 'image';
            link.href = sl.image;
            if (i === 0) link.setAttribute('fetchpriority', 'high');
            document.head.appendChild(link);
        });
    }

    function filterAnnouncements(items) {
        const now = Date.now();
        return (items || [])
            .filter((a) => {
                if (!a || (!a.title && !a.body)) return false;
                if (a.enabled === false || a.enabled === '0') return false;
                if (a.expiresAt || a.expiry) {
                    const ex = new Date(String(a.expiresAt || a.expiry));
                    if (!Number.isNaN(ex.getTime()) && ex.getTime() < now) return false;
                }
                return true;
            })
            .sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0));
    }

    window.renderCongressTicker = function renderCongressTicker(items) {
        const wrap = document.getElementById('scrolling-announce-wrap');
        const track = document.getElementById('scrolling-announce-track');
        if (!wrap || !track) return;
        const list = filterAnnouncements(items);
        if (!list.length) {
            wrap.classList.add('hidden');
            return;
        }
        wrap.classList.remove('hidden');
        const html = list
            .map((it) => {
                const text = esc(it.title || it.body || 'Update');
                const link = it.link ? '<a href="' + esc(it.link) + '">' + text + '</a>' : text;
                const pdf = it.pdf
                    ? ' <a href="' + esc(mediaUrl(it.pdf)) + '" target="_blank" rel="noopener"><i class="fas fa-file-pdf"></i></a>'
                    : '';
                return '<span class="cg-ticker-item">' + link + pdf + '</span>';
            })
            .join('');
        track.innerHTML = html + html;
    };

    function groupSchedulesByDay(schedules) {
        const map = new Map();
        (schedules || []).forEach((s) => {
            const d = s.start_time ? new Date(String(s.start_time).replace(' ', 'T')) : null;
            const key = d ? d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : 'TBA';
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(s);
        });
        return map;
    }

    window.renderCongressProgramme = function renderCongressProgramme(schedules) {
        const root = document.getElementById('cg-programme-root');
        const filters = document.getElementById('cg-programme-filters');
        if (!root) return;
        const list = schedules || window.__publicSchedules || [];
        if (!list.length) {
            root.innerHTML =
                '<p style="text-align:center;color:#64748b;padding:32px;">Programme schedule will be published soon.</p>';
            return;
        }
        const seminars = [...new Set(list.map((s) => s.seminar_title).filter(Boolean))];
        let activeFilter = 'all';
        const render = () => {
            const filtered =
                activeFilter === 'all' ? list : list.filter((s) => s.seminar_title === activeFilter);
            const byDay = groupSchedulesByDay(filtered);
            let html = '<div class="cg-timeline">';
            byDay.forEach((sessions, day) => {
                html += '<div class="cg-timeline-day"><h3>' + esc(day) + '</h3>';
                sessions.forEach((s) => {
                    const start = s.start_time ? new Date(String(s.start_time).replace(' ', 'T')) : null;
                    const end = s.end_time ? new Date(String(s.end_time).replace(' ', 'T')) : null;
                    const time =
                        start && end
                            ? start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) +
                              ' – ' +
                              end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                            : '—';
                    html +=
                        '<article class="cg-session" tabindex="0"><time>' +
                        esc(time) +
                        '</time><h4>' +
                        esc(s.title || 'Session') +
                        '</h4><p class="meta">' +
                        esc(s.speaker_name || '') +
                        (s.location ? ' · ' + esc(s.location) : '') +
                        (s.seminar_title ? ' · ' + esc(s.seminar_title) : '') +
                        '</p><div class="cg-session-detail">' +
                        esc(s.description || s.speaker_bio || '') +
                        '</div></article>';
                });
                html += '</div>';
            });
            html += '</div>';
            root.innerHTML = html;
            root.querySelectorAll('.cg-session').forEach((el) => {
                el.addEventListener('click', () => el.classList.toggle('is-open'));
            });
        };
        if (filters && seminars.length > 1) {
            filters.innerHTML =
                '<button type="button" class="is-active" data-f="all">All</button>' +
                seminars
                    .map((t) => '<button type="button" data-f="' + esc(t) + '">' + esc(t) + '</button>')
                    .join('');
            filters.querySelectorAll('button').forEach((btn) => {
                btn.addEventListener('click', () => {
                    filters.querySelectorAll('button').forEach((b) => b.classList.remove('is-active'));
                    btn.classList.add('is-active');
                    activeFilter = btn.dataset.f;
                    render();
                });
            });
        }
        render();
    };

    function galleryItemsFromCms(cms) {
        if (Array.isArray(cms.seminarGalleryYears) && cms.seminarGalleryYears.length) {
            const out = [];
            cms.seminarGalleryYears.forEach((yg) => {
                const year = yg.year || 'Archive';
                (yg.images || []).forEach((img) => {
                    if (img && img.src) {
                        out.push({
                            src: img.src,
                            caption: img.caption || yg.title || '',
                            year
                        });
                    }
                });
            });
            return out;
        }
        return Array.isArray(cms.pastSeminarGallery) ? cms.pastSeminarGallery : [];
    }

    window.applySiteMenu = function applySiteMenu(cms) {
        const host = document.getElementById('cg-nav-menu-links');
        if (!host || !cms) return;
        const menuPages =
            (window.__portalAuth && window.__portalAuth.websiteMenuPages) || {};
        if (window.PortalWebsiteMenu && typeof window.PortalWebsiteMenu.buildSiteMenuNavItems === 'function') {
            const navItems = window.PortalWebsiteMenu.buildSiteMenuNavItems(
                menuPages,
                cms.siteMenu,
                cms.legalPages
            );
            host.innerHTML = navItems
                .map(function (item) {
                    if (item.kind === 'href') {
                        const ext = item.external ? ' target="_blank" rel="noopener noreferrer"' : '';
                        return (
                            '<a href="' +
                            esc(item.href) +
                            '" data-menu-key="' +
                            esc(item.menuKey) +
                            '"' +
                            ext +
                            '>' +
                            esc(item.label) +
                            '</a>'
                        );
                    }
                    return (
                        '<a href="#" data-nav-section="' +
                        esc(item.section) +
                        '" data-menu-key="' +
                        esc(item.menuKey) +
                        '">' +
                        esc(item.label) +
                        '</a>'
                    );
                })
                .join('');
            if (typeof window.applyWebsiteMenuVisibility === 'function') {
                window.applyWebsiteMenuVisibility();
            }
            return;
        }
        let items = Array.isArray(cms.siteMenu) ? cms.siteMenu.filter((i) => i && i.visible !== false) : [];
        if (window.PortalWebsiteMenu && typeof window.PortalWebsiteMenu.filterSiteMenuItems === 'function') {
            items = window.PortalWebsiteMenu.filterSiteMenuItems(menuPages, items);
        }
        if (!items.length) return;
        items.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
        host.innerHTML = items
            .map((item) => {
                const label = esc(item.label || '');
                const href = String(item.href || '').trim();
                const section = String(item.section || '').trim();
                if (href && (href.startsWith('/') || href.startsWith('http'))) {
                    const ext = href.startsWith('http') ? ' target="_blank" rel="noopener noreferrer"' : '';
                    const menuKey =
                        href.indexOf('verify-certificate') !== -1 ? ' data-menu-key="certificate"' : '';
                    return '<a href="' + esc(href) + '"' + ext + menuKey + '>' + label + '</a>';
                }
                if (section) {
                    return (
                        '<a href="#" data-nav-section="' +
                        esc(section) +
                        '" data-menu-key="' +
                        esc(section) +
                        '">' +
                        label +
                        '</a>'
                    );
                }
                return '';
            })
            .join('');
        if (typeof window.applyWebsiteMenuVisibility === 'function') {
            window.applyWebsiteMenuVisibility();
        }
    };

    function normalizeYoutubePlaylistUrl(raw) {
        const s = String(raw || '').trim();
        if (!s) return '';
        const m = s.match(/[?&]list=([a-zA-Z0-9_-]+)/);
        if (m) return 'https://www.youtube.com/playlist?list=' + m[1];
        if (/^PL[\w-]+$/i.test(s)) return 'https://www.youtube.com/playlist?list=' + s;
        if (/youtube\.com|youtu\.be/i.test(s)) return s;
        return '';
    }

    function galleryYoutubeButton(yg) {
        const url = normalizeYoutubePlaylistUrl(yg && yg.youtubePlaylistUrl);
        if (!url) return '';
        const label = String((yg && yg.youtubePlaylistLabel) || '').trim() || 'Watch on YouTube';
        return (
            '<p class="cg-gallery-youtube"><a href="' +
            esc(url) +
            '" target="_blank" rel="noopener noreferrer" class="social-pill social-pill--youtube"><i class="fab fa-youtube" aria-hidden="true"></i> ' +
            esc(label) +
            '</a></p>'
        );
    }

    window.renderCongressPastSeminars = function renderCongressPastSeminars(cms) {
        const root = document.getElementById('cg-past-timeline');
        if (!root) return;
        const yearGroups =
            Array.isArray(cms.seminarGalleryYears) && cms.seminarGalleryYears.length
                ? cms.seminarGalleryYears.slice().sort((a, b) => String(b.year || '').localeCompare(String(a.year || '')))
                : null;
        if (yearGroups && yearGroups.length) {
            root.innerHTML = yearGroups
                .map((yg) => {
                    const items = yg.images || [];
                    const figures = items
                        .map(
                            (it) =>
                                '<figure><img class="vgmf-gallery-thumb" src="' +
                                esc(mediaUrl(it.src)) +
                                '" data-gallery-src="' +
                                esc(mediaUrl(it.src)) +
                                '" alt="' +
                                esc(it.caption || '') +
                                '" loading="lazy"><figcaption>' +
                                esc(it.caption || '') +
                                '</figcaption></figure>'
                        )
                        .join('');
                    return (
                        '<div class="cg-past-year"><div class="cg-past-year-label">' +
                        esc(yg.title || yg.year || 'Archive') +
                        '</div>' +
                        galleryYoutubeButton(yg) +
                        '<div class="cg-past-gallery">' +
                        (figures || '<p style="color:#64748b;">Watch the YouTube playlist for this year.</p>') +
                        '</div></div>'
                    );
                })
                .join('');
            return;
        }
        const gallery = galleryItemsFromCms(cms);
        if (!gallery.length) {
            root.innerHTML = '<p style="color:#64748b;">Past seminar highlights coming soon.</p>';
            return;
        }
        const byYear = new Map();
        gallery.forEach((g) => {
            const y = g.year || 'Archive';
            if (!byYear.has(y)) byYear.set(y, []);
            byYear.get(y).push(g);
        });
        let html = '';
        [...byYear.entries()]
            .sort((a, b) => String(b[0]).localeCompare(String(a[0])))
            .forEach(([year, items]) => {
                html +=
                    '<div class="cg-past-year"><div class="cg-past-year-label">' +
                    esc(year) +
                    '</div><div class="cg-past-gallery">' +
                    items
                        .map(
                            (it) =>
                                '<figure><img class="vgmf-gallery-thumb" src="' +
                                esc(mediaUrl(it.src)) +
                                '" data-gallery-src="' +
                                esc(mediaUrl(it.src)) +
                                '" alt="' +
                                esc(it.caption || '') +
                                '" loading="lazy"><figcaption>' +
                                esc(it.caption || '') +
                                '</figcaption></figure>'
                        )
                        .join('') +
                    '</div></div>';
            });
        root.innerHTML = html;
    };

    window.renderCongressVideos = function renderCongressVideos(cms) {
        const section = document.getElementById('cg-video-section');
        const grid = document.getElementById('cg-video-grid');
        if (!section || !grid) return;
        const videos = Array.isArray(cms.videoHub) ? cms.videoHub : [];
        if (!videos.length) {
            section.classList.add('hidden');
            return;
        }
        section.classList.remove('hidden');
        grid.innerHTML = videos
            .map((v) => {
                const id = (String(v.youtubeId || v.url || '').match(/[\w-]{11}/) || [])[0];
                const embed = id ? 'https://www.youtube-nocookie.com/embed/' + id : '';
                return (
                    '<article class="cg-video-card"><div class="cg-video-thumb">' +
                    (embed
                        ? '<iframe src="' + embed + '" title="' + esc(v.title || 'Video') + '" allowfullscreen loading="lazy"></iframe>'
                        : '') +
                    '</div><div class="cg-video-body"><h4>' +
                    esc(v.title || 'Video') +
                    '</h4><p>' +
                    esc(v.category || v.description || '') +
                    '</p></div></article>'
                );
            })
            .join('');
    };

    function isLocalReelMediaUrl(raw) {
        const s = String(raw || '').trim();
        if (!s) return false;
        if (/^\/uploads\//i.test(s) || /^\/api\/assets\//i.test(s)) return true;
        if (/\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(s)) return true;
        if (/^https?:\/\//i.test(s) && !/youtube\.com|youtu\.be/i.test(s)) return true;
        return false;
    }

    function youtubeIdFromValue(raw) {
        const s = String(raw || '').trim();
        if (!s || isLocalReelMediaUrl(s)) return '';
        const m = s.match(
            /(?:youtube\.com\/(?:shorts\/|live\/|watch\?(?:.*&)?v=|embed\/|v\/)|youtu\.be\/)([\w-]{11})/i
        );
        if (m) return m[1];
        if (/^[\w-]{11}$/.test(s) && /[a-zA-Z]/.test(s)) return s;
        return '';
    }

    function reelThumbUrl(reel, ytId) {
        if (reel.thumbnail) return esc(String(reel.thumbnail).trim());
        if (ytId) return 'https://i.ytimg.com/vi/' + ytId + '/hqdefault.jpg';
        return '';
    }

    function renderReelCard(reel, idx) {
        const title = esc(reel.title || 'Reel');
        const subtitle = esc(reel.subtitle || reel.category || '');
        const localVideo = isLocalReelMediaUrl(reel.videoUrl) ? esc(String(reel.videoUrl).trim()) : '';
        const ytId = youtubeIdFromValue(reel.youtubeId || reel.url);
        const thumb = reelThumbUrl(reel, ytId);
        let media = '';
        if (localVideo) {
            if (thumb) {
                media =
                    '<img src="' +
                    thumb +
                    '" alt="' +
                    title +
                    '" loading="lazy"><span class="cg-reel-play" aria-hidden="true"><i class="fas fa-play-circle"></i></span>';
            } else {
                media =
                    '<video src="' +
                    localVideo +
                    '" muted playsinline loop preload="metadata"></video><span class="cg-reel-play" aria-hidden="true"><i class="fas fa-play-circle"></i></span>';
            }
        } else if (ytId || thumb) {
            media =
                '<img src="' +
                (thumb || 'https://i.ytimg.com/vi/' + ytId + '/hqdefault.jpg') +
                '" alt="' +
                title +
                '" loading="lazy"><span class="cg-reel-play" aria-hidden="true"><i class="fas fa-play-circle"></i></span>';
        } else {
            media =
                '<div class="cg-reel-fallback" style="display:grid;place-items:center;height:100%;color:#94a3b8;font-size:0.85rem;padding:12px;text-align:center;">Video preview unavailable</div>';
        }
        return (
            '<article class="cg-reel-card" data-reel-idx="' +
            idx +
            '" tabindex="0" role="button" aria-label="Open reel: ' +
            title +
            '">' +
            '<div class="cg-reel-media">' +
            media +
            '</div>' +
            '<div class="cg-reel-body"><h4>' +
            title +
            '</h4>' +
            (subtitle ? '<p>' + subtitle + '</p>' : '') +
            '</div></article>'
        );
    }

    function closeReelModal() {
        const modal = document.getElementById('cg-reel-modal');
        const body = document.getElementById('cg-reel-modal-body');
        if (!modal) return;
        if (body) {
            const vid = body.querySelector('video');
            if (vid) {
                try {
                    vid.pause();
                } catch (_) {}
            }
            body.innerHTML = '';
        }
        modal.classList.remove('open');
        modal.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('cg-reel-modal-open');
    }

    function openReelModal(reel) {
        const modal = document.getElementById('cg-reel-modal');
        const body = document.getElementById('cg-reel-modal-body');
        if (!modal || !body || !reel) return;
        const title = esc(reel.title || 'Reel');
        const subtitle = esc(reel.subtitle || reel.category || '');
        const localVideo = isLocalReelMediaUrl(reel.videoUrl) ? esc(String(reel.videoUrl).trim()) : '';
        const ytId = youtubeIdFromValue(reel.youtubeId || reel.url);
        let player = '';
        if (localVideo) {
            player =
                '<div class="cg-reel-modal-video"><video src="' +
                localVideo +
                '" controls autoplay playsinline></video></div>';
        } else if (ytId) {
            player =
                '<div class="cg-reel-modal-video"><iframe src="https://www.youtube-nocookie.com/embed/' +
                ytId +
                '?autoplay=1&rel=0&playsinline=1" title="' +
                title +
                '" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe></div>';
        } else {
            player = '<p style="color:#94a3b8;">This reel cannot be played here.</p>';
        }
        body.innerHTML =
            '<h3 class="cg-reel-modal-title" id="cg-reel-modal-title">' +
            title +
            '</h3>' +
            (subtitle ? '<p class="cg-reel-modal-sub">' + subtitle + '</p>' : '') +
            player;
        modal.classList.add('open');
        modal.setAttribute('aria-hidden', 'false');
        document.body.classList.add('cg-reel-modal-open');
        const vid = body.querySelector('video');
        if (vid) {
            vid.muted = false;
            vid.play().catch(function () {
                vid.muted = true;
                vid.play().catch(function () {});
            });
        }
    }

    let reelModalBound = false;
    function bindReelModal() {
        if (reelModalBound) return;
        reelModalBound = true;
        const modal = document.getElementById('cg-reel-modal');
        const closeBtn = document.getElementById('cg-reel-modal-close');
        closeBtn?.addEventListener('click', closeReelModal);
        modal?.addEventListener('click', function (e) {
            if (e.target === modal) closeReelModal();
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && modal && modal.classList.contains('open')) closeReelModal();
        });
    }

    function bindReelCards(track, reels) {
        if (!track || !reels) return;
        bindReelModal();
        track.querySelectorAll('.cg-reel-card').forEach(function (card) {
            const idx = parseInt(card.getAttribute('data-reel-idx'), 10);
            const reel = reels[idx];
            if (!reel) return;

            function openFromCard(e) {
                if (e) {
                    e.preventDefault();
                    e.stopPropagation();
                }
                openReelModal(reel);
            }

            card.addEventListener('click', openFromCard);
            card.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') openFromCard(e);
            });

            const previewVid = card.querySelector('video');
            if (previewVid) {
                previewVid.addEventListener('loadeddata', function () {
                    try {
                        previewVid.currentTime = 0.1;
                    } catch (_) {}
                });
                card.addEventListener('mouseenter', function () {
                    if (window.matchMedia('(hover: hover)').matches) {
                        previewVid.muted = true;
                        previewVid.play().catch(function () {});
                    }
                });
                card.addEventListener('mouseleave', function () {
                    if (window.matchMedia('(hover: hover)').matches) {
                        previewVid.pause();
                        try {
                            previewVid.currentTime = 0.1;
                        } catch (_) {}
                    }
                });
            }
        });
    }

    function dedupeReels(list) {
        const seen = new Set();
        return (list || []).filter(function (r) {
            if (!r) return false;
            const key = [r.title, r.videoUrl, r.youtubeId, r.url, r.thumbnail].join('||').toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return !!(r.title || r.youtubeId || r.url || r.videoUrl);
        });
    }

    window.renderCongressReels = function renderCongressReels(cms) {
        const section = document.getElementById('cg-reels-section');
        const track = document.getElementById('cg-reels-track');
        const titleEl = document.getElementById('cg-reels-title');
        const subEl = document.getElementById('cg-reels-subtitle');
        if (!section || !track) return;
        const reels = dedupeReels(Array.isArray(cms.videoReels) ? cms.videoReels : []);
        const meta = cms.videoReelsSection || {};
        if (titleEl) titleEl.textContent = meta.title || 'Seminar reels & highlights';
        if (subEl) subEl.textContent = meta.subtitle || 'Short clips from our events and programmes';
        section.classList.toggle('cg-reels-section--single', reels.length === 1);
        section.classList.toggle('cg-reels-section--marquee', reels.length >= 2);
        if (!reels.length) {
            section.classList.add('hidden');
            track.innerHTML = '';
            track.className = 'cg-reels-track';
            track.style.animationDuration = '';
            return;
        }
        section.classList.remove('hidden');
        const cards = reels
            .map(function (r, i) {
                return renderReelCard(r, i);
            })
            .join('');
        const useMarquee = reels.length >= 2;
        track.className = 'cg-reels-track' + (useMarquee ? '' : ' cg-reels-track--static');
        track.innerHTML = useMarquee ? cards + cards : cards;
        if (useMarquee) {
            track.style.animationDuration = Math.max(28, reels.length * 14) + 's';
        } else {
            track.style.animationDuration = '';
        }
        window.__homepageReels = reels;
        bindReelCards(track, reels);
    };

    function bindSpeakerModal() {
        const modal = document.getElementById('cg-speaker-modal');
        const body = document.getElementById('cg-speaker-modal-body');
        const close = document.getElementById('cg-speaker-modal-close');
        if (!modal || !body) return;
        document.getElementById('speakers-grid')?.addEventListener('click', (e) => {
            const card = e.target.closest('.speaker-card');
            if (!card) return;
            body.innerHTML = card.innerHTML;
            modal.classList.add('open');
            modal.setAttribute('aria-hidden', 'false');
        });
        const shut = () => {
            modal.classList.remove('open');
            modal.setAttribute('aria-hidden', 'true');
        };
        close?.addEventListener('click', shut);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) shut();
        });
    }

    function bindMobileNav() {
        const toggle = document.getElementById('cg-menu-toggle');
        const nav = document.getElementById('cg-nav');
        const backdrop = document.getElementById('cg-nav-backdrop');
        const navClose = document.getElementById('cg-nav-close');
        const headerRow = document.querySelector('.cg-header-row');
        const mq = window.matchMedia('(max-width: 900px)');
        if (!toggle || !nav) return;

        function mountNavPortal() {
            if (!backdrop) return;
            if (mq.matches) {
                if (backdrop.parentElement !== document.body) document.body.appendChild(backdrop);
                if (nav.parentElement !== document.body) document.body.appendChild(nav);
            } else if (headerRow && nav.parentElement === document.body) {
                headerRow.appendChild(nav);
            }
        }

        const close = () => {
            nav.classList.remove('mobile-open');
            backdrop?.classList.remove('open');
            document.body.classList.remove('cg-nav-open');
            toggle.setAttribute('aria-expanded', 'false');
            nav.setAttribute('aria-hidden', 'true');
        };
        const openNav = () => {
            mountNavPortal();
            nav.classList.add('mobile-open');
            backdrop?.classList.add('open');
            document.body.classList.add('cg-nav-open');
            toggle.setAttribute('aria-expanded', 'true');
            nav.setAttribute('aria-hidden', 'false');
        };

        mountNavPortal();
        close();
        if (typeof mq.addEventListener === 'function') {
            mq.addEventListener('change', () => {
                close();
                mountNavPortal();
            });
        } else if (typeof mq.addListener === 'function') {
            mq.addListener(() => {
                close();
                mountNavPortal();
            });
        }

        toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            if (nav.classList.contains('mobile-open')) close();
            else openNav();
        });
        navClose?.addEventListener('click', (e) => {
            e.stopPropagation();
            close();
        });
        backdrop?.addEventListener('click', close);
        if (!nav.dataset.navClickBound) {
            nav.dataset.navClickBound = '1';
            nav.addEventListener('click', (e) => {
                const a = e.target.closest('a[data-nav-section]');
                if (!a) return;
                e.preventDefault();
                e.stopPropagation();
                if (mq.matches) close();
                const section = a.getAttribute('data-nav-section');
                if (section && typeof window.showSection === 'function') {
                    window.showSection(section);
                }
                nav.querySelectorAll('a[data-nav-section]').forEach((link) => {
                    link.classList.toggle('active', link === a);
                });
            });
        }
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && nav.classList.contains('mobile-open')) close();
        });
    }

    window.highlightCongressNav = function (section) {
        const nav = document.getElementById('cg-nav');
        if (!nav) return;
        nav.querySelectorAll('a[data-nav-section]').forEach((a) => {
            a.classList.toggle('active', a.getAttribute('data-nav-section') === section);
        });
    };

    function bindHeaderScroll() {
        const header = document.getElementById('cg-header');
        if (!header) return;
        window.addEventListener(
            'scroll',
            () => {
                header.classList.toggle('is-scrolled', window.scrollY > 8);
            },
            { passive: true }
        );
    }

    document.getElementById('congress-hero-prev')?.addEventListener('click', () => {
        showHeroSlide(heroIndex - 1);
        startHeroAutoplay();
    });
    document.getElementById('congress-hero-next')?.addEventListener('click', () => {
        showHeroSlide(heroIndex + 1);
        startHeroAutoplay();
    });

    const origApply = window.applySiteCms;
    window.applySiteCms = function (cms) {
        if (origApply) origApply(cms);
        if (typeof window.applySiteMenu === 'function') window.applySiteMenu(cms);
        const featSub = document.getElementById('section-features-subtitle');
        if (featSub && cms && cms.featuresSubtitle) {
            featSub.textContent = String(cms.featuresSubtitle)
                .trim()
                .replace(/^,\s*/, '')
                .replace(/,\s+and\b/gi, ' and');
        }
        window.__siteCms = cms || {};
        Promise.all([loadHeroMarketing()]).then(function () {
            renderCongressHero(window.__siteCms);
        });
        renderCongressTicker(cms.scrollingAnnouncements || []);
        renderCongressPastSeminars(cms);
        renderCongressVideos(cms);
        renderCongressReels(cms);
    };

    const origSchedules = window.loadEventSchedulesPublic;
    window.loadEventSchedulesPublic = async function () {
        if (origSchedules) await origSchedules();
        renderCongressProgramme(window.__publicSchedules);
    };

    document.addEventListener('DOMContentLoaded', () => {
        renderQuickAccess();
        bindMobileNav();
        bindHeaderScroll();
        bindSpeakerModal();
        if (typeof window.dismissSitePreloader === 'function') window.dismissSitePreloader();
    });
})();
