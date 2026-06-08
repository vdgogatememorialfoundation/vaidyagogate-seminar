/**
 * Public homepage — CMS-driven content
 */
(function () {
    function escHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function sanitizeDisplayText(text) {
        if (text == null) return text;
        let s = String(text).trim();
        s = s.replace(/^,\s*/, '');
        s = s.replace(/,\s+and\b/gi, ' and');
        return s;
    }

    function setText(id, text) {
        const el = document.getElementById(id);
        if (el && text != null && String(text).trim()) {
            el.textContent = sanitizeDisplayText(text);
        }
    }

    function setHtml(id, html) {
        const el = document.getElementById(id);
        if (el && html) el.innerHTML = html;
    }

    function mediaUrl(path) {
        if (!path) return '';
        const p = String(path).trim();
        if (p.startsWith('http')) return p;
        if (p.startsWith('/uploads/api/assets/')) return '/api/assets/' + p.slice('/uploads/api/assets/'.length);
        if (p.startsWith('/')) return p;
        return '/uploads/' + p;
    }

    function socialIcon(platform) {
        const p = String(platform || '').toLowerCase();
        if (p === 'youtube') return 'fab fa-youtube';
        if (p === 'facebook') return 'fab fa-facebook';
        if (p === 'instagram') return 'fab fa-instagram';
        if (p === 'twitter' || p === 'x') return 'fab fa-x-twitter';
        if (p === 'linkedin') return 'fab fa-linkedin';
        if (p === 'whatsapp') return 'fab fa-whatsapp';
        return 'fas fa-link';
    }
    window.socialIcon = socialIcon;

    function renderPillLink(url, iconClass, label, extraClass) {
        return (
            '<a href="' +
            escHtml(url) +
            '" target="_blank" rel="noopener noreferrer" class="' +
            escHtml(extraClass || 'social-link-btn') +
            '"><i class="' +
            escHtml(iconClass || 'fas fa-link') +
            '" aria-hidden="true"></i><span class="social-pill-label">' +
            escHtml(label || 'Open') +
            '</span></a>'
        );
    }

    window.renderSocialLinks = function renderSocialLinks(cms) {
        const links = Array.isArray(cms && cms.socialLinks) ? cms.socialLinks.filter((l) => l && l.url) : [];
        const html = links.length
            ? links
                  .map((l) => {
                      const p = String(l.platform || 'link').toLowerCase().replace(/[^a-z0-9]+/g, '_');
                      const pillClass = 'social-pill social-pill--' + (p || 'link');
                      return renderPillLink(
                          l.url,
                          socialIcon(l.platform),
                          l.label || l.platform || 'Follow',
                          'social-link-btn ' + pillClass
                      );
                  })
                  .join('')
            : '';
        ['social-follow', 'footer-social'].forEach((id) => {
            const el = document.getElementById(id);
            if (!el) return;
            if (!html) {
                el.innerHTML = '';
                el.classList.add('hidden');
                return;
            }
            el.classList.remove('hidden');
            el.innerHTML = html;
        });
    }

    window.__publicSchedules = [];

    function renderSpeakers(list) {
        const section = document.getElementById('speakers-section');
        const grid = document.getElementById('speakers-grid');
        if (!grid) return;
        const speakers = (list || []).filter((s) => s && (s.name || s.image || s.imagePath));
        if (section) section.classList.remove('hidden');
        if (!speakers.length) {
            grid.innerHTML =
                '<p class="speakers-placeholder muted" style="text-align:center;max-width:42rem;margin:0 auto;padding:24px 16px;">Faculty lineup will be announced shortly. Session speakers also appear on the <a href="#" data-nav-section="schedule">programme</a> page.</p>';
            return;
        }
        grid.innerHTML = speakers
            .map((s) => {
                const imgSrc = mediaUrl(s.image || s.imagePath);
                const avatar = imgSrc
                    ? '<div class="speaker-photo-wrap"><img src="' +
                      escHtml(imgSrc) +
                      '" alt="' +
                      escHtml(s.name || 'Speaker') +
                      '" class="speaker-photo" loading="lazy"></div>'
                    : '<div class="speaker-avatar" aria-hidden="true"><i class="fas fa-user-md"></i></div>';
                const seminarLine = s.seminar || s.seminarTitle;
                return (
                    '<article class="speaker-card">' +
                    avatar +
                    '<h3>' +
                    escHtml(s.name || '') +
                    '</h3>' +
                    (s.role ? '<p class="speaker-role">' + escHtml(s.role) + '</p>' : '') +
                    (seminarLine ? '<p class="speaker-seminar">' + escHtml(seminarLine) + '</p>' : '') +
                    (s.org ? '<p class="speaker-org">' + escHtml(s.org) + '</p>' : '') +
                    '</article>'
                );
            })
            .join('');
    }

    const DEFAULT_FEATURES = [
        { icon: 'fa-microphone-alt', title: 'Curated faculty', text: 'Sessions led by trusted Ayurvedic clinicians and researchers.' },
        { icon: 'fa-certificate', title: 'Verified credentials', text: 'Participation and certificate records with transparent verification.' },
        { icon: 'fa-trophy', title: 'Clinical excellence', text: 'Case-focused learning built around practical, modern workflows.' },
        { icon: 'fa-network-wired', title: 'Nationwide network', text: 'Collaborate with peers, institutions, and mentors across India.' }
    ];

    function renderFeatureCards(cards) {
        const featGrid = document.getElementById('feature-cards-grid');
        if (!featGrid) return;
        const list = cards && cards.length ? cards : DEFAULT_FEATURES;
        featGrid.innerHTML = list
            .map((c) => {
                const icon = escHtml(c.icon || 'fa-star');
                return (
                    '<article class="feature-card">' +
                    '<div class="card-icon"><i class="fas ' +
                    icon +
                    '"></i></div>' +
                    '<h3>' +
                    escHtml(c.title) +
                    '</h3><p>' +
                    escHtml(c.text) +
                    '</p></article>'
                );
            })
            .join('');
    }

    window.applySiteFooterExplore = function applySiteFooterExplore(cms) {
        const exploreUl = document.getElementById('footer-explore-links');
        if (!exploreUl || !cms) return;
        const menuPages =
            (window.__portalAuth && window.__portalAuth.websiteMenuPages) || {};
        const exploreLinks =
            window.PortalWebsiteMenu &&
            typeof window.PortalWebsiteMenu.buildFooterExploreLinks === 'function'
                ? window.PortalWebsiteMenu.buildFooterExploreLinks(menuPages, cms.siteMenu)
                : [];
        if (!exploreLinks.length) {
            exploreUl.innerHTML = '';
        } else {
            exploreUl.innerHTML = exploreLinks
                .map(function (l) {
                    const section = l.section || 'home';
                    return (
                        '<li><a href="#" data-menu-key="' +
                        escHtml(section) +
                        '" onclick="showSection(\'' +
                        escHtml(section) +
                        '\'); return false;">' +
                        escHtml(l.label || section) +
                        '</a></li>'
                    );
                })
                .join('');
        }
        if (typeof window.applyWebsiteMenuVisibility === 'function') {
            window.applyWebsiteMenuVisibility();
        }
    };

    window.applySiteCms = function applySiteCms(cms) {
        if (!cms) return;
        window.__homeCms = cms;

        const tickerEl = document.getElementById('tickerText');
        if (tickerEl && cms.tickerText) tickerEl.textContent = cms.tickerText;
        setText('hero-title', cms.hero && cms.hero.title);
        setText('hero-subtitle', cms.hero && cms.hero.subtitle);
        const vEl = document.getElementById('hero-venue');
        if (vEl && cms.hero && cms.hero.venue) {
            vEl.innerHTML =
                '<i class="fas fa-location-dot"></i> ' + escHtml(cms.hero.venue);
        }
        setText('hero-cta-primary', cms.hero && cms.hero.ctaPrimary);
        setText('hero-cta-secondary', cms.hero && cms.hero.ctaSecondary);
        setText('schedule-page-title', cms.schedulePage && cms.schedulePage.title);
        setText('schedule-page-subtitle', cms.schedulePage && cms.schedulePage.subtitle);
        setText('footer-tagline', cms.footer && cms.footer.tagline);
        setText('footer-copyright', cms.footer && cms.footer.copyright);
        const foot = cms.footer || {};
        setText('footer-explore-title', foot.exploreTitle || 'Explore');
        setText('footer-doctor-title', foot.doctorTitle || 'Doctor access');
        const contactCol = document.querySelector('.footer-col h4');
        if (foot.contactTitle) {
            const contactH = document.getElementById('footer-contact-heading');
            if (contactH) contactH.textContent = foot.contactTitle;
        }
        const creditEl = document.getElementById('footer-credit');
        if (creditEl) {
            creditEl.innerHTML =
                foot.creditHtml ||
                'Developed by <a href="https://capturevisualstudios.com" target="_blank" rel="noopener noreferrer">Capture Visual Studios</a>';
        }
        const exploreUl = document.getElementById('footer-explore-links');
        window.applySiteFooterExplore(cms);
        const doctorUl = document.getElementById('footer-doctor-links');
        if (doctorUl && Array.isArray(foot.doctorLinks) && foot.doctorLinks.length) {
            doctorUl.innerHTML = foot.doctorLinks
                .map((l) => {
                    const action = l.action === 'signup' ? 'openRegisterModal()' : 'openAuthModal(\'login\')';
                    return (
                        '<li><a href="#" onclick="' +
                        action +
                        '; return false;">' +
                        escHtml(l.label) +
                        '</a></li>'
                    );
                })
                .join('');
        }

        const top = cms.topBar || {};
        setText('top-email', top.email);
        setText('top-phone', top.phone);
        setText('top-date', top.dateLine);
        const emailLink = document.getElementById('top-email-link');
        const phoneLink = document.getElementById('top-phone-link');
        if (emailLink && top.email) {
            emailLink.href = 'mailto:' + String(top.email).trim();
        }
        if (phoneLink && top.phone) {
            const digits = String(top.phone).replace(/\D/g, '');
            phoneLink.href = digits ? 'tel:+' + (digits.length === 10 ? '91' + digits : digits) : '#';
        }

        const contact = cms.contact || {};
        ['contact-address', 'contact-page-address'].forEach((id) => setText(id, contact.address));
        ['contact-phone', 'contact-page-phone'].forEach((id) => setText(id, contact.phone));
        ['contact-email', 'contact-page-email'].forEach((id) => setText(id, contact.email));
        if (contact.hours) {
            setText('contact-hours', contact.hours);
            const hl = document.getElementById('contact-hours-line');
            if (hl) hl.classList.remove('hidden');
        }

        const stats = Array.isArray(cms.heroStats) ? cms.heroStats : [];
        if (typeof window.renderHomepageStats === 'function') {
            window.renderHomepageStats(cms);
        } else {
            const statsWrap = document.getElementById('hero-stats');
            if (statsWrap && stats.length) {
                statsWrap.innerHTML = stats
                    .map(
                        (s) =>
                            `<div class="stat-item"><h3>${escHtml(s.value)}</h3><p>${escHtml(s.label)}</p></div>`
                    )
                    .join('');
            }
        }

        renderFeatureCards(cms.featureCards);
        renderSpeakers(cms.speakers);

        const faqSection = document.getElementById('faq-section');
        const faqRoot = document.getElementById('faq-list');
        const faqs = Array.isArray(cms.faq) ? cms.faq : [];
        if (faqRoot && faqs.length) {
            faqRoot.innerHTML = faqs
                .map(
                    (f, i) => `
                <details class="faq-item" ${i === 0 ? 'open' : ''}>
                    <summary>${escHtml(f.q)}</summary>
                    <p>${escHtml(f.a)}</p>
                </details>`
                )
                .join('');
            if (faqSection) faqSection.classList.remove('hidden');
        }

        const heroPanel = document.getElementById('hero-image-panel');
        if (heroPanel && cms.hero && cms.hero.image) {
            heroPanel.innerHTML = `<img src="${escHtml(mediaUrl(cms.hero.image))}" alt="" class="hero-photo">`;
        }

        const bw = document.getElementById('site-banner-wrap');
        if (bw) {
            if (cms.bannerImage) {
                bw.classList.remove('hidden');
                bw.style.display = 'block';
                bw.innerHTML = `<img src="${escHtml(mediaUrl(cms.bannerImage))}" alt="">`;
            } else {
                bw.classList.add('hidden');
                bw.innerHTML = '';
            }
        }

        const announceHeading = document.getElementById('scrolling-announce-heading');
        if (announceHeading && cms.scrollingAnnounceHeading) {
            announceHeading.textContent = cms.scrollingAnnounceHeading;
        }
        if (typeof renderHomeSlider === 'function') renderHomeSlider(cms.slides || []);
        const onCongressSite = document.body && document.body.classList.contains('congress-site');
        if (!onCongressSite && typeof renderScrollingAnnouncements === 'function') {
            renderScrollingAnnouncements(cms.scrollingAnnouncements || []);
        }
        if (typeof renderReviewsMarquee === 'function') renderReviewsMarquee(cms.reviews || []);
        renderSocialLinks(cms);
        if (typeof renderAboutGallerySocial === 'function') renderAboutGallerySocial(cms);
    };

    function parseScheduleDate(value) {
        if (!value) return null;
        if (window.PortalDateTime && window.PortalDateTime.parse) {
            return window.PortalDateTime.parse(value);
        }
        const s = String(value).trim();
        if (!s) return null;
        const d = new Date(/Z$|[+-]\d{2}/i.test(s) ? s : s.replace(' ', 'T') + (s.includes('+') ? '' : '+05:30'));
        return Number.isNaN(d.getTime()) ? null : d;
    }

    function formatScheduleWhen(startVal, endVal) {
        if (window.PortalDateTime && window.PortalDateTime.format) {
            const a = window.PortalDateTime.format(startVal);
            const b = endVal ? window.PortalDateTime.format(endVal) : '';
            if (!a) return 'Schedule to be announced';
            return b ? `${a} – ${b}` : a;
        }
        const start = parseScheduleDate(startVal);
        const end = parseScheduleDate(endVal);
        if (!start) return 'Schedule to be announced';
        const tz = { timeZone: 'Asia/Kolkata' };
        const datePart = start.toLocaleDateString('en-IN', {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            ...tz
        });
        const t1 = start.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, ...tz });
        const t2 = end ? end.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, ...tz }) : '';
        return t2 ? `${datePart} · ${t1} – ${t2}` : `${datePart} · ${t1}`;
    }

    function formatScheduleCell(iso, dateOnly) {
        if (!iso) return '—';
        if (window.PortalDateTime && window.PortalDateTime.format) {
            if (dateOnly && window.PortalDateTime.formatEvent) {
                return window.PortalDateTime.formatEvent(iso);
            }
            return window.PortalDateTime.format(iso);
        }
        const d = parseScheduleDate(iso);
        if (!d) return '—';
        const tz = { timeZone: 'Asia/Kolkata' };
        if (dateOnly) {
            return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', ...tz });
        }
        return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, ...tz });
    }

    window.loadEventSchedulesPublic = async function loadEventSchedulesPublic() {
        try {
            const res = await fetch('/api/event-schedules');
            const schedules = await res.json();
            if (!res.ok || !Array.isArray(schedules)) return;
            window.__publicSchedules = schedules;

            const dropdown = document.getElementById('event-schedule-dropdown');
            if (dropdown) {
                dropdown.innerHTML = '<option value="">Select a session</option>';
                schedules.forEach((s) => {
                    const opt = document.createElement('option');
                    opt.value = String(s.id);
                    const when = s.start_time ? formatScheduleCell(s.start_time, false) : '';
                    opt.textContent = (s.title || 'Session') + (when ? ` (${when})` : '');
                    dropdown.appendChild(opt);
                });
            }

            const tbody = document.getElementById('schedule-table-body');
            if (tbody) {
                tbody.innerHTML = '';
                if (!schedules.length) {
                    tbody.innerHTML =
                        '<tr><td colspan="4" style="text-align:center;padding:24px;color:var(--muted);">Programme schedule will be published soon.</td></tr>';
                    return;
                }
                schedules.forEach((s) => {
                    const start = parseScheduleDate(s.start_time);
                    const tr = document.createElement('tr');
                    tr.innerHTML = '<td></td><td></td><td></td><td></td>';
                    tr.cells[0].textContent = formatScheduleCell(s.start_time, true);
                    tr.cells[1].textContent = formatScheduleCell(s.start_time, false);
                    tr.cells[2].textContent = s.title || '—';
                    tr.cells[3].textContent = s.speaker_name || '—';
                    tbody.appendChild(tr);
                });
            }
        } catch (e) {
            console.error(e);
        }
    };

    window.displayEventScheduleDetail = function displayEventScheduleDetail() {
        const dropdown = document.getElementById('event-schedule-dropdown');
        const detail = document.getElementById('event-schedule-detail');
        if (!dropdown || !detail) return;
        const id = dropdown.value;
        if (!id) {
            detail.style.display = 'none';
            return;
        }
        const schedule = (window.__publicSchedules || []).find((x) => String(x.id) === String(id));
        if (!schedule) {
            detail.style.display = 'none';
            return;
        }
        detail.innerHTML = `
            <h4 style="margin-bottom:10px;font-size:1.05rem;">${escHtml(schedule.title)}</h4>
            ${schedule.seminar_title ? `<p><strong>Seminar:</strong> ${escHtml(schedule.seminar_title)}</p>` : ''}
            <p><strong>When:</strong> ${escHtml(formatScheduleWhen(schedule.start_time, schedule.end_time))}</p>
            <p><strong>Where:</strong> ${escHtml(schedule.location && String(schedule.location).trim() ? schedule.location : 'To be announced')}</p>
            ${schedule.speaker_name ? `<p><strong>Speaker:</strong> ${escHtml(schedule.speaker_name)}</p>` : ''}
            ${schedule.speaker_bio ? `<p>${escHtml(schedule.speaker_bio)}</p>` : ''}
            ${schedule.description ? `<p>${escHtml(schedule.description)}</p>` : ''}`;
        detail.style.display = 'block';
    };

    window.applyPortalUrls = async function applyPortalUrls() {
        try {
            const res = await fetch('/api/public/portal-urls');
            const u = await res.json();
            window.__portalUrls = u;
        } catch (_) {}
    };

    window.loadOpenSeminarsStrip = async function loadOpenSeminarsStrip() {
        const wrap = document.getElementById('open-seminars-strip');
        const section = document.getElementById('seminars-section');
        if (!wrap) return;
        try {
            const res = await fetch('/api/seminars?bucket=current');
            const payload = await res.json();
            const list = payload.seminars || [];
            if (!list.length) {
                wrap.innerHTML =
                    '<p class="muted">No seminars are open for registration at the moment. Please check back soon.</p>';
                return;
            }
            wrap.innerHTML = list
                .map((s) => {
                    const ed =
                        s.event_date && window.PortalDateTime && window.PortalDateTime.formatEvent
                            ? window.PortalDateTime.formatEvent(s.event_date)
                            : s.event_date
                              ? String(s.event_date)
                              : '';
                    return (
                        '<article class="seminar-pill">' +
                        '<h4>' +
                        escHtml(s.title || 'Seminar') +
                        '</h4>' +
                        '<p>' +
                        escHtml(s.description || '') +
                        '</p>' +
                        (ed ? '<p class="seminar-meta"><i class="fas fa-calendar"></i> ' + escHtml(ed) + '</p>' : '') +
                        '<a href="/doctor.html" class="btn-primary" style="margin-top:auto;text-align:center;">Register</a>' +
                        '</article>'
                    );
                })
                .join('');
            if (section) section.classList.remove('hidden');
        } catch (e) {
            console.error(e);
            wrap.innerHTML = '<p class="muted">Could not load seminars.</p>';
        }
    };
})();
