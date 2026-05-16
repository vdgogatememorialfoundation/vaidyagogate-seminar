const fs = require('fs');
const p = 'public/index.html';
let h = fs.readFileSync(p, 'utf8');

// White header: remove conflicting inline navbar bg
h = h.replace(
    /\.navbar \{\s*background: #fffdf8;[\s\S]*?box-shadow: 0 4px 24px rgba\(61,52,40,0\.06\);\s*\}/,
    '/* navbar styled in vgmf-site.css */'
);

// Top bar CMS ids
h = h.replace(
    '<span><i class="fas fa-envelope"></i> info@vaidyagogate.org</span>',
    '<span><i class="fas fa-envelope"></i> <span id="top-email">info@vaidyagogate.org</span></span>'
);
h = h.replace(
    '<span><i class="fas fa-phone"></i> +91 9876543210</span>',
    '<span><i class="fas fa-phone"></i> <span id="top-phone">+91 9876543210</span></span>'
);
h = h.replace(
    '<span><i class="fas fa-calendar-alt"></i> March 19-20, 2026</span>',
    '<span><i class="fas fa-calendar-alt"></i> <span id="top-date">March 19-20, 2026</span></span>'
);

// Hero CMS ids
h = h.replace('<h1>National Seminar 2026</h1>', '<h1 id="hero-title">National Seminar 2026</h1>');
h = h.replace(
    '<p>Advancements in Ayurveda & Integrative Medicine</p>',
    '<p id="hero-subtitle">Advancements in Ayurveda & Integrative Medicine</p>'
);
h = h.replace(
    '<a href="/doctor.html" class="btn-primary">Register Now</a>',
    '<a href="/doctor.html" class="btn-primary" id="hero-cta-primary">Register Now</a>'
);
h = h.replace(
    '<a onclick="showSection(\'schedule\')" class="btn-outline-light">View Schedule</a>',
    '<a onclick="showSection(\'schedule\')" class="btn-outline-light" id="hero-cta-secondary">View Schedule</a>'
);
h = h.replace(
    '<motion class="hero-stats">',
    '<div class="hero-stats" id="hero-stats">'
);
h = h.replace(
    /<div class="hero-image">[\s\S]*?<\/motion>\s*<\/motion>/,
    `<div class="hero-image" id="hero-image-panel">
                <i class="fas fa-hospital-user hero-fallback-icon"></i>
                <h3>Vaidya Gogate Memorial Foundation</h3>
                <p id="hero-venue">Convention Centre, Pune</p>
            </div>`
);

// Fix if hero-image replace failed - simpler
if (!h.includes('hero-image-panel')) {
    h = h.replace(
        '<div class="hero-image">',
        '<div class="hero-image" id="hero-image-panel">'
    );
    h = h.replace(
        '<div style="margin-top: 20px;"><i class="fas fa-map-marker-alt"></i> Convention Centre, Pune</div>',
        '<p id="hero-venue" style="margin-top:12px;"><i class="fas fa-map-marker-alt"></i> Convention Centre, Pune</p>'
    );
}

// Feature grid + open seminars + FAQ on home
const homeInsert = `
            <div class="section-title" style="margin-top:10px;"><h2>Why attend</h2><p>Highlights you can edit in Admin → Website content</p></div>
            <div class="cards-grid" id="feature-cards-grid"></div>

            <div class="section-title" style="margin-top:40px;"><h2>Open for registration</h2><p>Current seminars from the portal</p></div>
            <div id="open-seminars-strip" class="open-seminars-strip"></div>

            <div id="faq-section" class="faq-section" style="display:none;margin-top:48px;">
                <div class="section-title"><h2>Frequently asked questions</h2></motion>
                <div id="faq-list" class="faq-list"></div>
            </motion>`;
if (!h.includes('feature-cards-grid')) {
    h = h.replace(
        '<motion class="section-title" style="margin-top: 10px;"><h2>What delegates say</h2>',
        homeInsert + '\n            <div class="section-title" style="margin-top: 10px;"><h2>What delegates say</h2>'
    );
    h = h.replace(/<motion /g, '<div ').replace(/<\/motion>/g, '</div>');
}

// Schedule section titles
h = h.replace(
    '<div class="section-title"><h2>Event Schedule</h2><p>March 19-20, 2026 | Convention Centre, Pune</p></div>',
    '<div class="section-title"><h2 id="schedule-page-title">Event Schedule</h2><p id="schedule-page-subtitle">March 19-20, 2026 | Convention Centre, Pune</p></div>'
);

// Footer CMS
h = h.replace(
    '<div class="footer-col"><h4>Vaidya Gogate Memorial Foundation</h4><p>Promoting Ayurveda since 1972</p></div>',
    '<div class="footer-col"><h4>Vaidya Gogate Memorial Foundation</h4><p id="footer-tagline">Promoting Ayurveda since 1972</p></div>'
);
h = h.replace(
    '<div class="footer-col"><h4>Contact</h4><p>Pune, Maharashtra<br>+91 9876543210</p></div>',
    '<motion class="footer-col"><h4>Contact</h4><p id="contact-address">Pune, Maharashtra</p><p id="contact-phone">+91 9876543210</p><p id="contact-email">info@vaidyagogate.org</p><p id="contact-hours"></p></div>'
);
h = h.replace(
    '<div class="footer-bottom"><p>© 2026 Vaidya Gogate Memorial Foundation. All rights reserved.</p></motion>',
    '<div class="footer-bottom"><p id="footer-copyright">© 2026 Vaidya Gogate Memorial Foundation. All rights reserved.</p></div>'
);
h = h.replace(/<motion /g, '<div ').replace(/<\/motion>/g, '</div>');

// Contact section
h = h.replace(
    '<div style="margin:20px 0"><i class="fas fa-map-marker-alt"></i> Convention Centre, Pune</div>',
    '<div style="margin:20px 0"><i class="fas fa-map-marker-alt"></i> <span id="contact-address">Convention Centre, Pune</span></div>'
);
// duplicate id fix - contact page uses contact-info spans only in footer; use contact-page-* for form section
h = h.replace(
    '<div style="margin:20px 0"><i class="fas fa-phone"></i> +91 9876543210</div>',
    '<div style="margin:20px 0"><i class="fas fa-phone"></i> <span id="contact-page-phone">+91 9876543210</span></div>'
);
h = h.replace(
    '<div style="margin:20px 0"><i class="fas fa-envelope"></i> info@vaidyagogate.org</div>',
    '<div style="margin:20px 0"><i class="fas fa-envelope"></i> <span id="contact-page-email">info@vaidyagogate.org</span></motion>'
);
h = h.replace(/<motion /g, '<motion ').replace(/<\/motion>/g, '</motion>');
h = h.replace(/<motion /g, '<div ').replace(/<\/motion>/g, '</div>');

// Script + CMS hook
if (!h.includes('vgmf-home.js')) {
    h = h.replace('<script>', '<script src="/js/vgmf-home.js"></script>\n    <script>');
}
h = h.replace(
    `async function loadPublicCmsAndApply() {
            try {
                const res = await fetch('/api/public/site-cms');
                const cms = await res.json();
                window.__homeCms = cms;
                const tick = document.getElementById('tickerText');
                if (tick && cms.tickerText) tick.textContent = cms.tickerText;
                const bw = document.getElementById('site-banner-wrap');
                if (bw) {
                    if (cms.bannerImage) {
                        bw.style.display = 'block';
                        bw.innerHTML = \`<img src="\${escHtml(cms.bannerImage)}" alt="">\`;
                    } else {
                        bw.style.display = 'none';
                        bw.innerHTML = '';
                    }
                }
                renderHomeSlider(cms.slides || []);
                renderScrollingAnnouncements(cms.scrollingAnnouncements || []);
                renderReviewsMarquee(cms.reviews || []);
            } catch (e) {
                console.error(e);
            }
        }`,
    `async function loadPublicCmsAndApply() {
            try {
                const res = await fetch('/api/public/site-cms');
                const cms = await res.json();
                if (typeof applySiteCms === 'function') applySiteCms(cms);
                const c = cms.contact || {};
                const cp = document.getElementById('contact-page-phone');
                const ce = document.getElementById('contact-page-email');
                const ca = document.getElementById('contact-page-address');
                if (cp && c.phone) cp.textContent = c.phone;
                if (ce && c.email) ce.textContent = c.email;
                if (ca && c.address) ca.textContent = c.address;
            } catch (e) {
                console.error(e);
            }
        }`
);

h = h.replace(
    `else if (section === 'schedule') {
                document.getElementById('scheduleSection').style.display = 'block';
                loadEventSchedules();
            }`,
    `else if (section === 'schedule') {
                document.getElementById('scheduleSection').style.display = 'block';
                if (typeof loadEventSchedulesPublic === 'function') loadEventSchedulesPublic();
                else loadEventSchedules();
            }`
);

// DOMContentLoaded extras
if (!h.includes('loadOpenSeminarsStrip')) {
    h = h.replace(
        'loadPublicCmsAndApply();',
        'loadPublicCmsAndApply();\n            if (typeof loadOpenSeminarsStrip === "function") loadOpenSeminarsStrip();'
    );
}

fs.writeFileSync(p, h);
console.log('index.html patched');
