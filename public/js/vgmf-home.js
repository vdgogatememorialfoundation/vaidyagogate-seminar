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

    function setText(id, text) {
        const el = document.getElementById(id);
        if (el && text != null && String(text).trim()) el.textContent = text;
    }

    function setHtml(id, html) {
        const el = document.getElementById(id);
        if (el && html) el.innerHTML = html;
    }

    window.__publicSchedules = [];

    const DEFAULT_SPEAKERS = [
        { name: 'Vaidya Expert Faculty', role: 'Keynote — Integrative Ayurveda', org: 'National faculty' },
        { name: 'Clinical Research Panel', role: 'Case presentation chairs', org: 'VGMF programme' },
        { name: 'Panchakarma & Shalya', role: 'Workshop leads', org: 'Speciality sessions' },
        { name: 'Young Scholars Forum', role: 'Research presentations', org: 'Delegate submissions' }
    ];

    function renderSpeakers(list) {
        const grid = document.getElementById('speakers-grid');
        if (!grid) return;
        const speakers = list && list.length ? list : DEFAULT_SPEAKERS;
        grid.innerHTML = speakers
            .map(
                (s) =>
                    '<article class="speaker-card">' +
                    '<div class="speaker-avatar" aria-hidden="true"><i class="fas fa-user-md"></i></div>' +
                    '<h3>' +
                    escHtml(s.name) +
                    '</h3><p class="speaker-role">' +
                    escHtml(s.role || '') +
                    '</p><p class="speaker-org">' +
                    escHtml(s.org || '') +
                    '</p></article>'
            )
            .join('');
    }

    const DEFAULT_FEATURES = [
        { icon: 'fa-microphone-alt', title: 'Expert faculty', text: 'Renowned practitioners and researchers from across India.' },
        { icon: 'fa-certificate', title: 'CME & certificates', text: 'Structured learning with documented participation.' },
        { icon: 'fa-trophy', title: 'Case presentations', text: 'Clinical excellence in Agnikarma and related disciplines.' },
        { icon: 'fa-network-wired', title: 'Professional network', text: 'Connect with peers, mentors, and institutions nationwide.' }
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

        const top = cms.topBar || {};
        setText('top-email', top.email);
        setText('top-phone', top.phone);
        setText('top-date', top.dateLine);

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
        const statsWrap = document.getElementById('hero-stats');
        if (statsWrap && stats.length) {
            statsWrap.innerHTML = stats
                .map(
                    (s) =>
                        `<div class="stat-item"><h3>${escHtml(s.value)}</h3><p>${escHtml(s.label)}</p></div>`
                )
                .join('');
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
            heroPanel.innerHTML = `<img src="${escHtml(cms.hero.image)}" alt="" class="hero-photo">`;
        }

        const bw = document.getElementById('site-banner-wrap');
        if (bw) {
            if (cms.bannerImage) {
                bw.classList.remove('hidden');
                bw.style.display = 'block';
                bw.innerHTML = `<img src="${escHtml(cms.bannerImage)}" alt="">`;
            } else {
                bw.classList.add('hidden');
                bw.innerHTML = '';
            }
        }

        if (typeof renderHomeSlider === 'function') renderHomeSlider(cms.slides || []);
        if (typeof renderScrollingAnnouncements === 'function') renderScrollingAnnouncements(cms.scrollingAnnouncements || []);
        if (typeof renderReviewsMarquee === 'function') renderReviewsMarquee(cms.reviews || []);
        if (typeof renderAboutGallerySocial === 'function') renderAboutGallerySocial(cms);
    };

    function parseScheduleDate(value) {
        if (!value) return null;
        const d = new Date(String(value).replace(' ', 'T'));
        return Number.isNaN(d.getTime()) ? null : d;
    }

    function formatScheduleWhen(startVal, endVal) {
        const start = parseScheduleDate(startVal);
        const end = parseScheduleDate(endVal);
        if (!start) return 'Schedule to be announced';
        const datePart = start.toLocaleDateString(undefined, {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            year: 'numeric'
        });
        const t1 = start.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        const t2 = end ? end.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
        return t2 ? `${datePart} · ${t1} – ${t2}` : `${datePart} · ${t1}`;
    }

    function renderScheduleDayTabs(schedules, activeKey) {
        const tabs = document.getElementById('schedule-day-tabs');
        if (!tabs) return;
        const days = [];
        (schedules || []).forEach((s) => {
            const d = parseScheduleDate(s.start_time);
            if (!d) return;
            const key = d.toISOString().slice(0, 10);
            if (!days.find((x) => x.key === key)) {
                days.push({
                    key,
                    label: d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
                });
            }
        });
        if (!days.length) {
            tabs.innerHTML = '';
            return;
        }
        const current = activeKey || days[0].key;
        window.__scheduleDayFilter = current;
        tabs.innerHTML = days
            .map(
                (d) =>
                    '<button type="button" class="schedule-day-tab' +
                    (d.key === current ? ' is-active' : '') +
                    '" data-day="' +
                    escHtml(d.key) +
                    '" role="tab">' +
                    escHtml(d.label) +
                    '</button>'
            )
            .join('');
        tabs.querySelectorAll('.schedule-day-tab').forEach((btn) => {
            btn.addEventListener('click', () => {
                window.__scheduleDayFilter = btn.getAttribute('data-day');
                renderScheduleTable(window.__publicSchedules || []);
                renderScheduleDayTabs(window.__publicSchedules || [], window.__scheduleDayFilter);
            });
        });
    }

    function renderScheduleTable(schedules) {
        const tbody = document.getElementById('schedule-table-body');
        if (!tbody) return;
        const dayKey = window.__scheduleDayFilter;
        let list = schedules || [];
        if (dayKey) {
            list = list.filter((s) => {
                const d = parseScheduleDate(s.start_time);
                return d && d.toISOString().slice(0, 10) === dayKey;
            });
        }
        tbody.innerHTML = '';
        if (!list.length) {
            tbody.innerHTML =
                '<tr><td colspan="4" style="text-align:center;padding:24px;color:var(--muted);">No sessions for this day.</td></tr>';
            return;
        }
        list.forEach((s) => {
            const start = parseScheduleDate(s.start_time);
            const tr = document.createElement('tr');
            tr.className = 'schedule-row-interactive';
            tr.dataset.scheduleId = String(s.id);
            tr.innerHTML = '<td></td><td></td><td></td><td></td>';
            tr.cells[0].textContent = start ? start.toLocaleDateString() : '—';
            tr.cells[1].textContent = start
                ? start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                : '—';
            tr.cells[2].textContent = s.title || '—';
            tr.cells[3].textContent = s.speaker_name || '—';
            tr.addEventListener('click', () => {
                const dropdown = document.getElementById('event-schedule-dropdown');
                if (dropdown) {
                    dropdown.value = String(s.id);
                    displayEventScheduleDetail();
                }
                document.getElementById('event-schedule-detail')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            });
            tbody.appendChild(tr);
        });
    }

    window.loadEventSchedulesPublic = async function loadEventSchedulesPublic() {
        try {
            const res = await fetch('/api/event-schedules');
            const schedules = await res.json();
            if (!res.ok || !Array.isArray(schedules)) return;
            window.__publicSchedules = schedules;

            renderScheduleDayTabs(schedules);
            renderScheduleTable(schedules);

            const dropdown = document.getElementById('event-schedule-dropdown');
            if (dropdown) {
                dropdown.innerHTML = '<option value="">Select a session</option>';
                schedules.forEach((s) => {
                    const opt = document.createElement('option');
                    opt.value = String(s.id);
                    const when = s.start_time ? new Date(s.start_time).toLocaleString() : '';
                    opt.textContent = (s.title || 'Session') + (when ? ` (${when})` : '');
                    dropdown.appendChild(opt);
                });
            }

            if (!schedules.length) {
                const tbody = document.getElementById('schedule-table-body');
                if (tbody) {
                    tbody.innerHTML =
                        '<tr><td colspan="4" style="text-align:center;padding:24px;color:var(--muted);">Programme schedule will be published soon.</td></tr>';
                }
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
            if (u.wix) {
                const w = document.getElementById('nav-wix-home');
                if (w) {
                    w.href = u.wix;
                    w.classList.remove('hidden');
                }
            }
        } catch (_) {}
    };

    renderSpeakers();

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
                        s.event_date && window.PortalDateTime
                            ? window.PortalDateTime.format(s.event_date, {
                                  day: 'numeric',
                                  month: 'short',
                                  year: 'numeric'
                              })
                            : s.event_date
                              ? new Date(s.event_date).toLocaleDateString()
                              : 'Date TBA';
                    const desc = escHtml((s.description || '').slice(0, 140));
                    const more = (s.description || '').length > 140 ? '…' : '';
                    return `<article class="seminar-pill">
                        <h4>${escHtml(s.title)}</h4>
                        <p>${desc}${more}</p>
                        <p class="seminar-meta"><i class="fas fa-calendar"></i> ${ed} · ₹${escHtml(s.price || 0)}</p>
                        <a href="/doctor.html" class="btn-primary">Register</a>
                    </article>`;
                })
                .join('');
            if (section) section.classList.remove('hidden');
        } catch (e) {
            console.error(e);
            wrap.innerHTML = '<p class="muted">Unable to load seminars. Please refresh the page.</p>';
        }
    };
})();
