const fs = require('fs');
const path = 'public/index.html';
const html = fs.readFileSync(path, 'utf8');
const scriptStart = html.indexOf('<script src="/js/vgmf-home.js">');
if (scriptStart < 0) {
    console.error('script marker not found');
    process.exit(1);
}
const scripts = html.slice(scriptStart);

const shell = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Vaidya Gogate Memorial Foundation | National Seminar</title>
    <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link rel="stylesheet" href="/css/vgmf-site.css">
</head>
<body>
    <motion class="top-bar">
        <div class="top-bar-container">
            <div class="top-bar-left">
                <span><i class="fas fa-envelope"></i> <span id="top-email">info@vaidyagogate.org</span></span>
                <span><i class="fas fa-phone"></i> <span id="top-phone">+91 9876543210</span></span>
                <span><i class="fas fa-calendar-alt"></i> <span id="top-date">National Seminar 2026</span></span>
            </div>
            <div class="top-bar-right">
                <a onclick="openAuthModal()"><i class="fas fa-user"></i> Sign in</a>
                <a onclick="openAuthModal()"><i class="fas fa-user-plus"></i> Register</a>
            </div>
        </div>
    </div>

    <div id="site-banner-wrap" class="site-banner hidden"></div>

    <header class="site-header" id="site-header">
        <div class="nav-container">
            <a href="#" class="logo" onclick="showSection('home'); return false;">
                <div class="logo-icon" data-site-logo data-logo-height="48px" data-logo-width="48px" data-logo-fallback="icon"><i class="fas fa-leaf"></i></div>
                <div class="logo-text">
                    <h1>Vaidya Gogate Memorial Foundation</h1>
                    <p>Ayurveda · Education · Excellence</p>
                </div>
            </a>
            <button type="button" class="nav-toggle" id="nav-toggle" aria-label="Menu"><i class="fas fa-bars"></i></button>
            <nav class="nav-links" id="nav-links">
                <a onclick="showSection('home')">Home</a>
                <a onclick="showSection('about')">About</a>
                <a onclick="showSection('gallery')">Gallery</a>
                <a onclick="showSection('schedule')">Schedule</a>
                <a onclick="showSection('verify')">Verify</a>
                <a onclick="showSection('contact')">Contact</a>
                <a href="/doctor.html" class="btn-portal">Doctor portal</a>
            </nav>
        </div>
    </header>

    <div class="announcement-ticker">
        <div class="ticker-container">
            <span class="ticker-label">Update</span>
            <div class="ticker-content">
                <div class="ticker-text" id="tickerText">Welcome to the VGMF National Seminar portal.</div>
            </div>
        </div>
    </div>

    <div id="scrolling-announce-wrap" class="scrolling-announce-wrap hidden">
        <div class="scrolling-announce-header">
            <span class="ticker-label">News</span>
            <span class="sa-sub">Latest updates</span>
        </div>
        <div class="scrolling-announce-viewport">
            <div class="scrolling-announce-track" id="scrolling-announce-track"></motion>
        </div>
    </div>

    <section class="hero">
        <div class="hero-container">
            <div class="hero-content">
                <span class="hero-badge"><i class="fas fa-certificate"></i> National CME Seminar</span>
                <h1 id="hero-title">National Seminar 2026</h1>
                <p class="hero-lead" id="hero-subtitle">Advancements in Ayurveda &amp; integrative medicine</p>
                <div class="hero-buttons">
                    <a href="/doctor.html" class="btn-primary" id="hero-cta-primary"><i class="fas fa-arrow-right"></i> Register now</a>
                    <a onclick="showSection('schedule')" class="btn-ghost" id="hero-cta-secondary">View programme</a>
                </div>
                <div class="hero-stats" id="hero-stats">
                    <div class="stat-item"><h3>50+</h3><p>Expert speakers</p></div>
                    <div class="stat-item"><h3>500+</h3><p>Delegates</p></div>
                    <div class="stat-item"><h3>30+</h3><p>Sessions</p></div>
                </div>
            </div>
            <div class="hero-visual" id="hero-image-panel">
                <i class="fas fa-spa hero-fallback-icon"></i>
                <h3>Vaidya Gogate Memorial Foundation</h3>
                <p class="hero-venue-line" id="hero-venue"><i class="fas fa-location-dot"></i> Convention Centre, Pune</p>
            </div>
        </div>
    </section>

    <div id="countdown-region"></div>

    <main class="main-content">
        <div id="homeSection">
            <motion id="home-slider" class="home-slider hidden"></div>

            <section class="vgmf-section home-split">
                <div>
                    <div class="section-head left">
                        <h2 id="section-features-title">Programme highlights</h2>
                        <p id="section-features-subtitle">Clinical learning, research, and professional networking</p>
                    </div>
                    <div class="cards-grid" id="feature-cards-grid"></motion>
                </div>
                <aside class="notices-panel">
                    <h3><i class="fas fa-bullhorn"></i> Official notices</h3>
                    <div id="notices-container">
                        <p class="muted">Loading notices…</p>
                    </div>
                </aside>
            </section>

            <section class="vgmf-section" id="seminars-section">
                <div class="section-head">
                    <h2>Seminars open for registration</h2>
                    <p>Apply through the secure doctor portal</p>
                </div>
                <div id="open-seminars-strip" class="open-seminars-strip"></div>
            </section>

            <section class="vgmf-section hidden" id="faq-section">
                <div class="section-head">
                    <h2>Frequently asked questions</h2>
                    <p>Registration, payments, and e-tickets</p>
                </div>
                <motion class="faq-list" id="faq-list"></div>
            </section>

            <section class="vgmf-section reviews-wrap hidden" id="reviews-section">
                <div class="section-head">
                    <h2>What delegates say</h2>
                    <p>Experiences from our community</p>
                </div>
                <div class="reviews-track" id="reviews-track"></div>
            </section>
        </div>

        <div id="aboutSection" class="hidden">
            <div class="section-head">
                <h2>About the foundation</h2>
                <p>Advancing Ayurveda since 1972</p>
            </div>
            <div class="page-panel" id="about-content"></motion>
            <div id="social-follow" class="social-follow" style="text-align:center;margin-top:28px;"></div>
        </div>

        <div id="gallerySection" class="hidden">
            <div class="section-head">
                <h2>Gallery</h2>
                <p>Memories from past national seminars</p>
            </div>
            <div id="gallery-grid" class="cards-grid"></div>
        </div>

        <div id="verifySection" class="hidden">
            <div class="section-head">
                <h2>Participant verification</h2>
                <p>Search published attendee lists for registered seminars</p>
            </div>
            <div class="page-panel" style="max-width:560px;">
                <label style="font-weight:700;display:block;margin-bottom:8px;">Seminar</label>
                <select id="verify-seminar" style="width:100%;padding:12px;border-radius:10px;border:1px solid var(--line);margin-bottom:16px;"></select>
                <label style="font-weight:700;display:block;margin-bottom:8px;">Search</label>
                <input type="text" id="verify-query" placeholder="Application no., name, or portal ID" style="width:100%;padding:12px;border-radius:10px;border:1px solid var(--line);">
                <button type="button" class="btn-primary" style="margin-top:16px;width:100%;border:none;cursor:pointer;" onclick="runParticipantVerify()">Search</button>
                <div id="verify-results" style="margin-top:20px;"></div>
            </div>
        </div>

        <div id="scheduleSection" class="hidden">
            <div class="section-head">
                <h2 id="schedule-page-title">Event schedule</h2>
                <p id="schedule-page-subtitle">Sessions, speakers, and timings</p>
            </motion>
            <div class="schedule-picker">
                <label for="event-schedule-dropdown">Session detail</label>
                <select id="event-schedule-dropdown" onchange="displayEventScheduleDetail()">
                    <option value="">Select a session</option>
                </select>
                <div id="event-schedule-detail"></div>
            </div>
            <div class="schedule-container" style="overflow-x:auto;">
                <table class="schedule-table">
                    <thead><tr><th>Date</th><th>Time</th><th>Session</th><th>Speaker</th></tr></thead>
                    <tbody id="schedule-table-body">
                        <tr><td colspan="4" style="text-align:center;padding:24px;">Loading schedule…</td></tr>
                    </tbody>
                </table>
            </div>
        </div>

        <div id="contactSection" class="hidden">
            <div class="section-head">
                <h2>Contact us</h2>
                <p>We are happy to help with registration and general enquiries</p>
            </div>
            <div class="contact-grid">
                <div class="contact-info">
                    <h3>Get in touch</h3>
                    <div><i class="fas fa-map-marker-alt"></i> <span id="contact-page-address">—</span></div>
                    <div><i class="fas fa-phone"></i> <span id="contact-page-phone">—</span></div>
                    <div><i class="fas fa-envelope"></i> <span id="contact-page-email">—</span></motion>
                    <motion id="contact-hours-line" class="hidden"><i class="fas fa-clock"></i> <span id="contact-hours"></span></div>
                </div>
                <div class="contact-form">
                    <h3 style="margin-bottom:16px;font-size:1.05rem;">Send a message</h3>
                    <form id="contactForm">
                        <div class="form-group"><input type="text" id="contact_name" placeholder="Your name" required></div>
                        <div class="form-group"><input type="email" id="contact_email" placeholder="Email" required></div>
                        <div class="form-group"><input type="tel" id="contact_phone" placeholder="Phone"></motion>
                        <div class="form-group"><input type="text" id="contact_subject" placeholder="Subject" required></div>
                        <div class="form-group"><textarea id="contact_message" rows="4" placeholder="Message" required></textarea></div>
                        <button type="submit" class="btn-primary" style="width:100%;border:none;cursor:pointer;">Send message</button>
                    </form>
                </div>
            </div>
        </div>
    </main>

    <div id="authModal" class="modal">
        <div class="modal-content">
            <motion style="padding:28px;">
                <motion style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;gap:12px;">
                    <h3 style="font-size:1.1rem;line-height:1.35;">Doctor account</h3>
                    <button type="button" onclick="closeAuthModal()" style="background:none;border:none;font-size:1.25rem;cursor:pointer;color:var(--muted);">&times;</button>
                </div>
                <div style="display:flex;gap:8px;margin-bottom:20px;">
                    <button type="button" class="btn-primary" style="flex:1;" onclick="switchAuthTab('login')">Sign in</button>
                    <button type="button" class="btn-ghost" style="flex:1;color:var(--ink);border-color:var(--line);" onclick="switchAuthTab('signup')">Create account</button>
                </div>
                <motion id="loginForm">
                    <form onsubmit="handleLogin(event)">
                        <div class="form-group"><label>Email</label><input type="email" id="login_email" required autocomplete="email"></div>
                        <div class="form-group"><label>Password</label><input type="password" id="login_password" required autocomplete="current-password"></div>
                        <div id="login_otp_panel" class="hidden" style="margin-top:14px;padding-top:14px;border-top:1px solid var(--line);">
                            <p style="font-size:0.85rem;color:var(--muted);margin-bottom:10px;">Verify with codes sent to your email and phone.</p>
                            <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px;">
                                <span style="font-weight:700;min-width:48px;">Email</span>
                                <button type="button" class="btn-ghost" style="padding:6px 12px;font-size:0.8rem;color:var(--ink);border-color:var(--line);" onclick="sendLoginOtp('email')">Send</button>
                                <input type="text" id="login_email_otp" placeholder="Code" style="max-width:80px;padding:8px;border-radius:8px;border:1px solid var(--line);">
                                <button type="button" class="btn-ghost" style="padding:6px 12px;font-size:0.8rem;color:var(--ink);border-color:var(--line);" onclick="verifyLoginOtp('email')">Verify</button>
                                <span id="login_email_otp_ok" style="font-size:0.8rem;color:#059669;"></span>
                            </div>
                            <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
                                <span style="font-weight:700;min-width:48px;">Phone</span>
                                <button type="button" class="btn-ghost" style="padding:6px 12px;font-size:0.8rem;color:var(--ink);border-color:var(--line);" onclick="sendLoginOtp('phone')">Send</button>
                                <input type="text" id="login_phone_otp" placeholder="Code" style="max-width:80px;padding:8px;border-radius:8px;border:1px solid var(--line);">
                                <button type="button" class="btn-ghost" style="padding:6px 12px;font-size:0.8rem;color:var(--ink);border-color:var(--line);" onclick="verifyLoginOtp('phone')">Verify</button>
                                <span id="login_phone_otp_ok" style="font-size:0.8rem;color:#059669;"></span>
                            </div>
                        </div>
                        <button type="submit" class="btn-primary" style="width:100%;margin-top:12px;border:none;cursor:pointer;">Sign in</button>
                    </form>
                </div>
                <div id="signupForm" class="hidden">
                    <form onsubmit="handleSignup(event)">
                        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
                            <div class="form-group"><input type="text" id="signup_firstname" placeholder="First name" required></div>
                            <div class="form-group"><input type="text" id="signup_lastname" placeholder="Last name" required></div>
                        </div>
                        <div class="form-group"><input type="email" id="signup_email" placeholder="Email" required></div>
                        <div class="form-group"><input type="tel" id="signup_phone" placeholder="Phone" required></div>
                        <div id="signup_otp_panel" class="hidden" style="margin-top:14px;padding-top:14px;border-top:1px solid var(--line);">
                            <p style="font-size:0.85rem;color:var(--muted);margin-bottom:10px;">Verify email and phone before creating your account.</p>
                            <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px;">
                                <span style="font-weight:600;min-width:48px;">Email</span>
                                <button type="button" class="btn-ghost" style="padding:6px 12px;font-size:0.8rem;color:var(--ink);border-color:var(--line);" onclick="sendSignupOtp('email')">Send</button>
                                <input type="text" id="signup_email_otp" placeholder="Code" style="max-width:80px;padding:8px;border-radius:8px;border:1px solid var(--line);">
                                <button type="button" class="btn-ghost" style="padding:6px 12px;font-size:0.8rem;color:var(--ink);border-color:var(--line);" onclick="verifySignupOtp('email')">Verify</button>
                                <span id="signup_email_otp_ok" style="font-size:0.8rem;color:#059669;"></span>
                            </div>
                            <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
                                <span style="font-weight:600;min-width:48px;">Phone</span>
                                <button type="button" class="btn-ghost" style="padding:6px 12px;font-size:0.8rem;color:var(--ink);border-color:var(--line);" onclick="sendSignupOtp('phone')">Send</button>
                                <input type="text" id="signup_phone_otp" placeholder="Code" style="max-width:80px;padding:8px;border-radius:8px;border:1px solid var(--line);">
                                <button type="button" class="btn-ghost" style="padding:6px 12px;font-size:0.8rem;color:var(--ink);border-color:var(--line);" onclick="verifySignupOtp('phone')">Verify</button>
                                <span id="signup_phone_otp_ok" style="font-size:0.8rem;color:#059669;"></span>
                            </div>
                        </div>
                        <motion class="form-group"><input type="password" id="signup_password" placeholder="Password" required></div>
                        <button type="submit" class="btn-primary" style="width:100%;border:none;cursor:pointer;">Create account</button>
                    </form>
                </div>
            </div>
        </div>
    </div>

    <footer class="footer">
        <div class="footer-container">
            <div class="footer-col">
                <h4>Foundation</h4>
                <p id="footer-tagline">Promoting Ayurveda education since 1972</p>
            </div>
            <div class="footer-col">
                <h4>Explore</h4>
                <ul>
                    <li><a onclick="showSection('home')">Home</a></li>
                    <li><a onclick="showSection('about')">About</a></li>
                    <li><a onclick="showSection('schedule')">Schedule</a></li>
                    <li><a onclick="showSection('gallery')">Gallery</a></li>
                </ul>
            </div>
            <div class="footer-col">
                <h4>Portals</h4>
                <ul>
                    <li><a href="/doctor.html">Doctor</a></li>
                    <li><a href="/admin.html">Admin</a></li>
                    <li><a href="/judge.html">Judge</a></li>
                    <li><a href="/scanner.html">Scanner</a></li>
                </ul>
            </div>
            <div class="footer-col">
                <h4>Contact</h4>
                <p id="contact-address">—</p>
                <p id="contact-phone">—</p>
                <p id="contact-email">—</p>
            </div>
        </div>
        <div class="footer-bottom">
            <p id="footer-copyright">© 2026 Vaidya Gogate Memorial Foundation. All rights reserved.</p>
        </div>
    </footer>

    `;

let out = shell.replace(/<motion /g, '<div ').replace(/<\/motion>/g, '</div>') + scripts;

// Nav toggle
if (!out.includes('nav-toggle')) {
    console.warn('nav toggle missing');
}

// Patch showSection for active nav + header scroll
const navPatch = `
        document.getElementById('nav-toggle')?.addEventListener('click', () => {
            document.getElementById('site-header')?.classList.toggle('nav-open');
        });
`;
if (!out.includes("nav-toggle')?.addEventListener")) {
    out = out.replace('showSection(\'home\');', "showSection('home');" + navPatch);
}

fs.writeFileSync(path, out);
console.log('index.html rebuilt, length', out.length);
