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
        const p = String(path).trim();
        if (p.startsWith('http')) return p;
        if (p.startsWith('/uploads/api/assets/')) return '/api/assets/' + p.slice('/uploads/api/assets/'.length);
        if (p.startsWith('/')) return p;
        return '/uploads/' + p;
    }

    const QUICK_ACCESS = [
        { icon: 'fa-user-plus', title: 'Start enrollment', text: 'Create your doctor account', action: 'register' },
        { icon: 'fa-user-md', title: "Doctor's Portal Sign In", text: 'Sign in and manage applications', href: '/doctor.html' },
        { icon: 'fa-calendar-alt', title: 'Event agenda', text: 'Sessions and timings', section: 'schedule' },
        { icon: 'fa-microphone', title: 'Faculty board', text: 'Featured experts', section: 'home', anchor: 'speakers-section' },
        { icon: 'fa-ticket-alt', title: 'Open windows', text: 'Current registrations', section: 'home', anchor: 'seminars-section' },
        { icon: 'fa-images', title: 'Seminar gallery', text: 'Past highlights', section: 'gallery' },
        { icon: 'fa-shield-check', title: 'Delegate directory', text: 'Paid participant lookup', section: 'verify' },
        { icon: 'fa-award', title: 'Certificate authenticity', text: 'OTP validation', href: '/verify-certificate.html' },
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

    function buildHeroSlides(cms) {
        const slides = [];
        const fromCms = Array.isArray(cms.slides) ? cms.slides : [];
        fromCms.forEach((sl) => {
            if (!sl || (!sl.image && !sl.title)) return;
            slides.push({
                image: mediaUrl(sl.image),
                title: sl.title || (cms.hero && cms.hero.title) || 'National Seminar',
                subtitle: sl.subtitle || (cms.hero && cms.hero.subtitle) || '',
                cta: sl.cta || (cms.hero && cms.hero.ctaPrimary) || 'Register now',
                link: sl.link || '#register',
                cta2: sl.cta2 || '',
                link2: sl.link2 || ''
            });
        });
        if (!slides.length && cms.hero) {
            slides.push({
                image: mediaUrl(cms.hero.image),
                title: cms.hero.title || 'National Seminar',
                subtitle: cms.hero.subtitle || '',
                cta: cms.hero.ctaPrimary || 'Register now',
                link: '#register',
                cta2: cms.hero.ctaSecondary || 'View programme',
                link2: '#schedule'
            });
        }
        if (!slides.length) {
            slides.push({
                image: '',
                title: 'VGMF National Seminar',
                subtitle: 'Ayurveda · Education · Excellence',
                cta: 'Register now',
                link: '#register',
                cta2: 'Programme',
                link2: '#'
            });
        }
        return slides;
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
            link === '/doctor.html' ||
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
        if (!root) return;
        heroSlides = buildHeroSlides(cms || {});
        root.innerHTML = heroSlides
            .map((sl, i) => {
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
                    esc((cms && cms.hero && cms.hero.eyebrow) || 'National CME Congress') +
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
    };

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
        const items = Array.isArray(cms.siteMenu) ? cms.siteMenu.filter((i) => i && i.visible !== false) : [];
        if (!items.length) return;
        items.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
        host.innerHTML = items
            .map((item) => {
                const label = esc(item.label || '');
                const href = String(item.href || '').trim();
                const section = String(item.section || '').trim();
                if (href && (href.startsWith('/') || href.startsWith('http'))) {
                    const ext = href.startsWith('http') ? ' target="_blank" rel="noopener noreferrer"' : '';
                    return '<a href="' + esc(href) + '"' + ext + '>' + label + '</a>';
                }
                if (section) {
                    return (
                        '<a href="#" data-nav-section="' +
                        esc(section) +
                        '">' +
                        label +
                        '</a>'
                    );
                }
                return '';
            })
            .join('');
    };

    window.renderCongressPastSeminars = function renderCongressPastSeminars(cms) {
        const root = document.getElementById('cg-past-timeline');
        if (!root) return;
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
                                '<figure><img src="' +
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
        renderCongressHero(cms);
        renderCongressTicker(cms.scrollingAnnouncements || []);
        renderCongressPastSeminars(cms);
        renderCongressVideos(cms);
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
        const pre = document.getElementById('site-preloader');
        if (pre) {
            setTimeout(() => pre.classList.add('done'), 400);
        }
        (async () => {
            const root = document.getElementById('congress-hero-slides');
            if (root && root.children.length) return;
            try {
                const res = await fetch('/api/public/site-cms', { cache: 'no-store' });
                const cms = await res.json();
                if (typeof window.applySiteCms === 'function') window.applySiteCms(cms);
            } catch (e) {
                console.error('[congress] CMS bootstrap failed', e);
                renderCongressHero({});
            }
        })();
    });
})();
