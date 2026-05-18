const fs = require('fs');
const p = require('path').join(__dirname, '..', 'public', 'index.html');
let s = fs.readFileSync(p, 'utf8');

if (s.includes('id="cg-header"')) {
    console.log('Already patched');
    process.exit(0);
}

const insert = `
    <div class="cg-utility">
        <motion class="cg-utility-inner">
            <div>
                <span><i class="fas fa-envelope"></i> <span id="top-email">info@vaidyagogate.org</span></span>
                <span><i class="fas fa-phone"></i> <span id="top-phone">+91 9876543210</span></span>
                <span><i class="fas fa-calendar-alt"></i> <span id="top-date">National Seminar 2026</span></span>
            </div>
            <div>
                <a href="/doctor.html"><i class="fas fa-user"></i> Doctor sign in</a>
                <span style="opacity:0.5;margin:0 8px;">|</span>
                <a href="#" onclick="openRegisterModal(); return false;"><i class="fas fa-user-plus"></i> Create account</a>
            </div>
        </div>
    </div>

    <header class="cg-header" id="cg-header">
        <div class="cg-header-inner">
            <a href="#" class="cg-logo-zone" onclick="showSection('home'); return false;">
                <div data-site-logo data-logo-height="52px" data-logo-width="52px" data-logo-fallback="icon"><i class="fas fa-leaf" style="font-size:1.5rem;color:#0f766e;"></i></div>
                <div class="cg-logo-text">
                    <h1>Vaidya Gogate Memorial Foundation</h1>
                    <p>National Seminar Portal</p>
                </motion>
            </a>
            <button type="button" class="cg-menu-toggle" id="cg-menu-toggle" aria-label="Menu"><i class="fas fa-bars"></i></button>
            <nav class="cg-nav" id="cg-nav">
                <a href="#" data-nav-section="home" class="active">Home</a>
                <a href="#" data-nav-section="about">About</a>
                <a href="#" data-nav-section="schedule">Programme</a>
                <a href="#" data-nav-section="gallery">Gallery</a>
                <a href="#" id="nav-verify" data-nav-section="verify">Verify</a>
                <a href="#" data-nav-section="contact">Contact</a>
                <a id="nav-wix-home" href="https://www.vaidyagogate.org" target="_blank" rel="noopener" class="hidden">Main site</a>
                <a href="/doctor.html">Doctor portal</a>
                <a href="/?register=1" class="cg-btn-register" onclick="openRegisterModal(); return false;">Register</a>
            </nav>
        </div>
    </header>
    <div class="cg-nav-backdrop" id="cg-nav-backdrop" aria-hidden="true"></div>

    <div id="scrolling-announce-wrap" class="cg-ticker hidden" aria-label="Announcements">
        <div class="cg-ticker-inner">
            <span class="cg-ticker-badge">Live</span>
            <div class="cg-ticker-viewport">
                <div id="scrolling-announce-track" class="cg-ticker-track"></div>
            </div>
        </div>
    </div>

    <section id="congress-hero-root" class="congress-hero" aria-label="Featured">
        <motion id="congress-hero-slides"></div>
        <div class="congress-hero-arrows">
            <button type="button" class="prev" id="congress-hero-prev" aria-label="Previous"><i class="fas fa-chevron-left"></i></button>
            <button type="button" class="next" id="congress-hero-next" aria-label="Next"><i class="fas fa-chevron-right"></i></button>
        </div>
        <div class="congress-hero-nav">
            <div class="congress-hero-dots" id="congress-hero-dots"></div>
        </div>
    </section>

    <section class="cg-quick" aria-label="Quick access">
        <div class="cg-quick-grid" id="cg-quick-grid"></div>
    </section>

    <a href="#" class="cg-fab-register" id="cg-fab-register" onclick="openRegisterModal(); return false;"><i class="fas fa-user-plus"></i> Register</a>
`;

// Fix accidental typos in template
const clean = insert
    .replace(/<motion\b/g, '<div')
    .replace(/<\/motion>/g, '</motion>')
    .replace(/<\/motion>/g, '</div>');

s = s.replace('    <div class="top-bar">', clean + '\n    <div class="top-bar legacy-header">');

if (!s.includes('vgmf-congress.js')) {
    s = s.replace(
        '<script src="/js/vgmf-home.js"></script>',
        '<script src="/js/vgmf-congress.js"></script>\n    <script src="/js/vgmf-home.js"></script>'
    );
}

if (!s.includes('cg-programme-root')) {
    s = s.replace(
        '<div class="schedule-container">',
        '<motion id="cg-programme-root" class="cg-timeline-wrap"></div>\n            <div class="cg-programme-filters" id="cg-programme-filters"></div>\n            <div class="schedule-container">'
    );
}

if (!s.includes('cg-video-section')) {
    s = s.replace(
        '<div id="homeSection">',
        `<div id="homeSection">
            <section id="cg-video-section" class="cg-section hidden">
                <div class="cg-section-head"><h2>Video learning hub</h2><p>Seminar recordings and featured sessions</p></div>
                <div id="cg-video-grid" class="cg-video-grid"></div>
            </section>`
    );
}

if (!s.includes('cg-past-section') && s.includes('id="speakers-section"')) {
    s = s.replace(
        '<section id="speakers-section"',
        `<section id="cg-past-section" class="cg-section"><div class="cg-section-head"><h2>Past seminars</h2><p>Highlights from previous programmes</p></div><motion id="cg-past-timeline" class="cg-past-timeline"></motion></section>
            <section id="speakers-section"`
    );
}

if (!s.includes('cg-speaker-modal')) {
    s = s.replace(
        '<footer class="footer">',
        `<div id="cg-speaker-modal" class="cg-modal" aria-hidden="true"><div class="cg-modal-panel"><button type="button" class="cg-modal-close" id="cg-speaker-modal-close">&times;</button><div id="cg-speaker-modal-body"></div></div></div>
    <footer class="footer">`
    );
}

s = s.replace(/<motion\b/g, '<div').replace(/<\/motion>/g, '</motion>');

fs.writeFileSync(p, s);
console.log('patched index.html');
