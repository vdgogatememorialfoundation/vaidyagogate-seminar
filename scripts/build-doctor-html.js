const fs = require('fs');
const path = require('path');

const style = fs.readFileSync(path.join(__dirname, 'doctor-style-snippet.css'), 'utf8');
const styleExtra = `
        #auth-overlay { position: fixed; inset: 0; z-index: 9999; display: flex; align-items: center; justify-content: center; padding: 20px; background: rgba(15,118,110,0.35); backdrop-filter: blur(6px); }
        .btn-warning { background: #fef3c7; color: #92400e; border: 1px solid #fcd34d; padding: 8px 14px; border-radius: 8px; cursor: pointer; font-weight: 600; }
        .seminars-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; }
        .preview-box { background: #f8fafc; padding: 20px; border-radius: 12px; border: 1px solid #e2e8f0; margin-bottom: 20px; }
        .preview-box p { margin: 6px 0; font-size: 0.92rem; }
        #pdf-viewer { width: 100%; height: 420px; border: 1px solid #cbd5e1; border-radius: 8px; margin-top: 12px; }
        #prev-qrcode { max-width: 120px; display: none; margin: 10px 0; }
        #seminar-track-live, #case-track-live { font-size: 0.82rem; color: #0f766e; font-weight: 700; margin-bottom: 10px; }
`;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Doctor portal | VGMF National Seminar</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link rel="stylesheet" href="/css/responsive-portals.css">
${style}
${styleExtra}
    </style>
</head>
<body>

    <!-- Doctor portal login -->
    <motion id="auth-overlay">
        <div style="background:#fff;border-radius:16px;padding:32px;width:100%;max-width:420px;box-shadow:0 24px 50px rgba(15,118,110,0.2);border:1px solid #99f6e4;">
            <div data-site-logo data-logo-height="44px" style="margin-bottom:12px;"></motion>
            <h2 style="color:#0f766e;margin-bottom:8px;font-size:1.35rem;">Doctor portal sign-in</h2>
            <p style="color:#64748b;font-size:0.88rem;margin-bottom:18px;line-height:1.45;">Use your doctor account here. New doctors can <a href="/" style="color:#0d9488;font-weight:700;">register on the public site</a>.</p>
            <form id="doctor-login-form">
                <label style="display:block;font-size:0.82rem;font-weight:700;color:#0f766e;margin:10px 0 6px;">Email</label>
                <input type="email" id="doctor-login-email" required autocomplete="email" style="width:100%;padding:10px 12px;border:1px solid #cbd5e1;border-radius:10px;">
                <label style="display:block;font-size:0.82rem;font-weight:700;color:#0f766e;margin:12px 0 6px;">Password</label>
                <input type="password" id="doctor-login-password" required autocomplete="current-password" style="width:100%;padding:10px 12px;border:1px solid #cbd5e1;border-radius:10px;">
                <div id="doctor-login-otp-panel" style="display:none;margin-top:14px;padding-top:14px;border-top:1px solid #e2e8f0;">
                    <p style="font-size:0.82rem;color:#64748b;margin-bottom:8px;">Verify email and phone OTP codes.</p>
                    <motion style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px;">
                        <span style="font-weight:700;min-width:44px;">Email</span>
                        <button type="button" id="doctor-send-otp-email" style="padding:6px 12px;border-radius:8px;border:1px solid #99f6e4;background:#f0fdfa;cursor:pointer;font-weight:700;color:#0f766e;">Send</button>
                        <input type="text" id="doctor-email-otp" placeholder="Code" style="max-width:88px;padding:8px;border-radius:8px;border:1px solid #cbd5e1;">
                        <button type="button" id="doctor-verify-otp-email" style="padding:6px 12px;border-radius:8px;border:1px solid #99f6e4;background:#f0fdfa;cursor:pointer;font-weight:700;color:#0f766e;">Verify</button>
                        <span id="doctor-email-otp-ok" style="font-size:0.78rem;color:#059669;"></span>
                    </motion>
                    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
                        <span style="font-weight:700;min-width:44px;">Phone</span>
                        <button type="button" id="doctor-send-otp-phone" style="padding:6px 12px;border-radius:8px;border:1px solid #99f6e4;background:#f0fdfa;cursor:pointer;font-weight:700;color:#0f766e;">Send</button>
                        <input type="text" id="doctor-phone-otp" placeholder="Code" style="max-width:88px;padding:8px;border-radius:8px;border:1px solid #cbd5e1;">
                        <button type="button" id="doctor-verify-otp-phone" style="padding:6px 12px;border-radius:8px;border:1px solid #99f6e4;background:#f0fdfa;cursor:pointer;font-weight:700;color:#0f766e;">Verify</button>
                        <span id="doctor-phone-otp-ok" style="font-size:0.78rem;color:#059669;"></span>
                    </div>
                </div>
                <p id="doctor-login-err" class="hidden" style="color:#b91c1c;font-size:0.85rem;margin-top:10px;font-weight:600;"></p>
                <button type="submit" class="btn-primary" style="width:100%;margin-top:16px;">Sign in</button>
            </form>
            <p style="margin-top:14px;font-size:0.78rem;color:#94a3b8;text-align:center;">
                <a href="/admin.html" style="color:#0d9488;font-weight:600;">Admin</a> ·
                <a href="/judge.html" style="color:#0d9488;font-weight:600;">Judge</a> ·
                <a href="/scanner.html" style="color:#0d9488;font-weight:600;">Scanner</a>
            </p>
        </div>
    </div>

    <div class="dashboard-container hidden" id="dashboard-main">
        <aside class="sidebar">
            <div class="sidebar-header">
                <div data-site-logo data-logo-height="40px" data-logo-fallback="icon" style="margin-bottom:10px;"></div>
                <h2>Doctor portal</h2>
                <p>VGMF National Seminar (<span id="doctor-portal-year-label">2026</span>)</p>
            </div>
            <div class="menu-items">
                <a class="menu-item active" onclick="switchTab('tab-dashboard')"><i class="fas fa-home"></i> Dashboard</a>
                <a class="menu-item" onclick="switchTab('tab-profile')"><i class="fas fa-user-circle"></i> My Profile</a>
                <a class="menu-item" onclick="switchTab('tab-seminars')"><i class="fas fa-calendar-check"></i> Available Seminars</a>
                <a class="menu-item" onclick="switchTab('tab-applications')"><i class="fas fa-tasks"></i> Track seminar applications</a>
                <a class="menu-item" onclick="switchTab('tab-abstract')"><i class="fas fa-file-upload"></i> Case presentation</a>
                <a class="menu-item" onclick="switchTab('tab-case-track')"><i class="fas fa-route"></i> Track case applications</a>
                <a class="menu-item" id="nav-volunteer" onclick="switchTab('tab-volunteer')"><i class="fas fa-hands-helping"></i> Volunteer</a>
                <a class="menu-item" onclick="switchTab('tab-feedback')"><i class="fas fa-star"></i> Seminar feedback</a>
                <a class="menu-item" onclick="switchTab('tab-support')"><i class="fas fa-ticket-alt"></i> Support tickets</a>
                <a class="menu-item" onclick="switchTab('tab-orders')"><i class="fas fa-receipt"></i> Orders</a>
                <a class="menu-item" onclick="switchTab('tab-receipts')"><i class="fas fa-file-invoice"></i> Receipts</a>
                <a class="menu-item" onclick="switchTab('tab-payments')"><i class="fas fa-credit-card"></i> Payments</a>
                <a class="menu-item" onclick="switchTab('tab-ticket')"><i class="fas fa-qrcode"></i> Participant tickets</a>
                <a class="menu-item" onclick="switchTab('tab-certificate')"><i class="fas fa-award"></i> Certificates</a>
                <a class="menu-item" onclick="switchTab('tab-reset-pwd')"><i class="fas fa-key"></i> Change password</a>
            </div>
        </aside>

        <div class="main-content">
            <header class="top-header">
                <div class="header-title">Vaidya Gogate Memorial Foundation — Doctor workspace</motion>
                <div class="user-info">
                    <span class="hi-user" id="header-name">Hi, Doctor</span>
                    <span class="user-id" id="header-id">ID: —</span>
                    <a href="/" class="header-link" target="_blank"><i class="fas fa-external-link-alt"></i> Public site</a>
                    <button type="button" class="btn-primary" id="btn-logout" style="padding:8px 16px;"><i class="fas fa-sign-out-alt"></i> Logout</button>
                </div>
            </header>

            <div class="notification-bar"><i class="fas fa-info-circle"></i> Complete your profile before registering for seminars.</div>

            <div class="announcements-box">
                <h4 style="color: #0f766e; margin-bottom: 10px;"><i class="fas fa-bullhorn"></i> Updates from the office</h4>
                <p style="color:#64748b;font-size:0.85rem;margin-bottom:10px;">Important notices from seminar administrators.</p>
                <ul id="doctor-updates-list" style="list-style-position: inside; color: #64748b; font-size: 0.9rem;">
                    <li style="color:#94a3b8;">Loading…</li>
                </ul>
            </div>

            <div class="content-area">

                <div id="tab-dashboard" class="tab-pane">
                    <h2 class="section-title">Dashboard</h2>
                    <p style="color: #64748b; margin: -10px 0 20px;">Overview of your seminar activity. Use <strong>Seminar feedback</strong> and <strong>Support tickets</strong> in the menu for those features.</p>
                    <motion class="stat-grid">
                        <div class="stat-card"><h4 id="stat-registered">—</h4><p>Registered seminars</p></div>
                        <div class="stat-card" style="border-top-color:#10b981;"><h4 id="stat-paid">—</h4><p>Paid / confirmed</p></div>
                        <div class="stat-card" style="border-top-color:#f59e0b;"><h4 id="stat-checked">—</h4><p>Checked in</p></div>
                        <div class="stat-card" style="border-top-color:#8b5cf6;"><h4 id="stat-feedback">—</h4><p>Feedback submitted</p></div>
                        <div class="stat-card" style="border-top-color:#0ea5e9;"><h4 id="stat-abstracts">—</h4><p>Case presentations</p></div>
                        <div class="stat-card" style="border-top-color:#ec4899;"><h4 id="stat-ptix">—</h4><p>Participant e‑tickets</p></motion>
                        <div class="stat-card" style="border-top-color:#64748b;"><h4 id="stat-suptix">—</h4><p>Support tickets</p></div>
                    </div>
                    <div class="card">
                        <h3 style="color:#0f766e;margin-bottom:10px;"><i class="fas fa-bolt"></i> Quick links</h3>
                        <div style="display:flex;flex-wrap:wrap;gap:10px;">
                            <button type="button" class="btn-primary" onclick="switchTab('tab-seminars')">Register for seminar</button>
                            <button type="button" class="btn-primary" style="background:#7c3aed;" onclick="switchTab('tab-orders')">Orders</button>
                            <button type="button" class="btn-primary" style="background:#64748b;" onclick="switchTab('tab-reset-pwd')">Change password</button>
                        </div>
                    </div>
                </div>

                <div id="tab-profile" class="tab-pane hidden">
                    <h2 class="section-title">My profile</h2>
                    <div class="card">
                        <form id="profile-form" onsubmit="return saveProfile(event)">
                            <div class="form-group"><label>Specialization</label><input type="text" id="profile-specialization"></div>
                            <div class="form-group"><label>Registration number</label><input type="text" id="profile-registration-no"></div>
                            <motion class="form-group"><label>Qualifications</label><textarea id="profile-qualifications" rows="2"></textarea></div>
                            <div class="form-group"><label>Years of experience</label><input type="number" id="profile-experience" min="0"></div>
                            <div class="form-group"><label>Hospital / clinic</label><input type="text" id="profile-hospital"></div>
                            <div class="form-group"><label>Contact number</label><input type="text" id="profile-contact"></div>
                            <div class="form-group"><label>Bio</label><textarea id="profile-bio" rows="3"></textarea></div>
                            <div class="form-group"><label>Profile photo</label><input type="file" id="profile-photo" accept="image/*"></motion>
                            <button type="submit" class="btn-primary">Save profile</button>
                        </form>
                    </div>
                </div>

                <div id="tab-seminars" class="tab-pane hidden">
                    <h2 class="section-title" id="seminars-title">Available seminars</h2>
                    <p style="color:#64748b;margin:-10px 0 20px;">Register for open seminars. You must accept seminar terms before completing the application.</p>
                    <div id="seminars-grid-container" class="seminars-grid"></div>

                    <div id="multi-step-form" class="card hidden">
                        <h3 id="registration-seminar-name" style="color:#0f766e;margin-bottom:16px;">Registering for seminar</h3>
                        <div class="step-indicator">
                            <span class="step" id="ind-step-0">Terms</span>
                            <span class="step" id="ind-step-1">1. Personal</span>
                            <span class="step" id="ind-step-2">2. Address</span>
                            <span class="step" id="ind-step-3">3. Qualification</span>
                            <span class="step" id="ind-step-4">4. College</span>
                            <span class="step" id="ind-step-5">5. Preview</span>
                        </div>

                        <div id="step-0" class="form-step hidden">
                            <h4 style="color:#0f766e;margin-bottom:10px;">Terms &amp; conditions</h4>
                            <p style="color:#64748b;font-size:0.88rem;margin-bottom:12px;">Read and accept the seminar terms before filling the registration form.</p>
                            <div id="reg-tnc-text" style="max-height:320px;overflow-y:auto;padding:16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:0.9rem;line-height:1.55;white-space:pre-wrap;margin-bottom:16px;">Loading terms…</div>
                            <label style="display:flex;align-items:flex-start;gap:10px;margin-bottom:16px;font-size:0.9rem;">
                                <input type="checkbox" id="reg-tnc-accept" style="margin-top:4px;">
                                <span>I have read and accept the Terms &amp; Conditions for this seminar.</span>
                            </label>
                            <button type="button" class="btn-primary" onclick="proceedFromSeminarTnc()">Continue to application</button>
                            <button type="button" class="btn-primary" style="background:#64748b;margin-left:8px;" onclick="cancelRegistration()">Cancel</button>
                        </div>

                        <motion id="reg-seminar-otp-panel" class="hidden" style="background:#eff6ff;padding:12px;border-radius:8px;margin-bottom:14px;border:1px solid #bfdbfe;">
                            <strong style="color:#1e40af;">Seminar verification required</strong>
                            <p style="font-size:0.85rem;color:#475569;margin:6px 0 0;">Verify email and phone codes before continuing.</p>
                        </div>

                        <div id="step-1" class="form-step hidden">
                            <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 15px;">
                                <div class="form-group"><label>First name</label><input type="text" id="reg-fname"></div>
                                <div class="form-group"><label>Middle name</label><input type="text" id="reg-mname"></div>
                                <div class="form-group"><label>Last name</label><input type="text" id="reg-lname"></div>
                            </div>
                            <div class="form-group">
                                <label>Email</label>
                                <input type="email" id="reg-email" autocomplete="email">
                                <div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                                    <button type="button" class="btn-primary" onclick="sendRegistrationOtpForField('email')">Send email code</button>
                                    <input type="text" id="reg-otp-code-email" placeholder="Code" style="max-width:100px;padding:8px;">
                                    <button type="button" class="btn-primary" onclick="verifyRegistrationOtpForField('email')">Verify</button>
                                    <span id="reg-otp-status-email" style="font-size:0.85rem;color:#64748b;"></span>
                                </div>
                            </div>
                            <div class="form-group">
                                <label>Phone</label>
                                <input type="tel" id="reg-phone" autocomplete="tel">
                                <div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                                    <button type="button" class="btn-primary" onclick="sendRegistrationOtpForField('phone')">Send SMS code</button>
                                    <input type="text" id="reg-otp-code-phone" placeholder="Code" style="max-width:100px;padding:8px;">
                                    <button type="button" class="btn-primary" onclick="verifyRegistrationOtpForField('phone')">Verify</button>
                                    <span id="reg-otp-status-phone" style="font-size:0.85rem;color:#64748b;"></span>
                                </div>
                            </div>
                            <button type="button" class="btn-primary" onclick="nextStep(2)">Next</button>
                            <button type="button" class="btn-primary" style="background:#64748b;margin-left:8px;" onclick="nextStep(0)">Back</button>
                        </div>

                        <div id="step-2" class="form-step hidden">
                            <motion class="form-group"><label>Address</label><textarea id="reg-addr" rows="2"></textarea></div>
                            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
                                <div class="form-group"><label>PIN code</label><input type="text" id="reg-pin" inputmode="numeric" maxlength="6" placeholder="6-digit PIN" onblur="autofillAddress()"></motion>
                                <div class="form-group"><label>City</label><select id="reg-city"><option value="">Select city</option></select></div>
                                <div class="form-group"><label>State</label><select id="reg-state"><option value="">Select state</option></select></div>
                            </div>
                            <p id="reg-pin-hint" class="hidden" style="font-size:0.85rem;color:#64748b;margin:-4px 0 8px;"></p>
                            <div class="form-group"><label>Country</label><select id="reg-country"><option value="">Select country</option></select></div>
                            <button type="button" class="btn-primary" onclick="nextStep(3)">Next</button>
                            <button type="button" class="btn-primary" style="background:#64748b;margin-left:8px;" onclick="nextStep(1)">Back</button>
                        </div>

                        <div id="step-3" class="form-step hidden">
                            <div class="form-group">
                                <label>Qualification</label>
                                <select id="reg-qual" onchange="toggleRegBlock()">
                                    <option value="">Select</option>
                                    <option value="PG">PG</option>
                                    <option value="Practicing Vaidya">Practicing Vaidya</option>
                                    <option value="Practitioner">Practitioner</option>
                                </select>
                            </div>
                            <div id="reg-block" class="hidden">
                                <div class="form-group"><label>Registration / NCISM ID</label><input type="text" id="reg-ncism"><button type="button" class="btn-primary" style="margin-top:8px;" onclick="verifyNcism()">Verify ID</button></motion>
                                <p id="ncism-status" class="hidden" style="color:#059669;font-weight:600;">Verified</p>
                                <div class="form-group"><label>Certificate upload</label><input type="file" id="reg-cert-file" accept=".pdf,.jpg,.jpeg,.png"></div>
                            </div>
                            <button type="button" class="btn-primary" onclick="nextStep(4)">Next</button>
                            <button type="button" class="btn-primary" style="background:#64748b;margin-left:8px;" onclick="nextStep(2)">Back</button>
                        </div>

                        <div id="step-4" class="form-step hidden">
                            <div class="form-group"><label>College</label><input type="text" id="reg-college"></div>
                            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
                                <div class="form-group"><label>College city</label><input type="text" id="reg-ccity"></div>
                                <div class="form-group"><label>College state</label><input type="text" id="reg-cstate"></div>
                            </div>
                            <button type="button" class="btn-primary" onclick="nextStep(5)">Preview</button>
                            <button type="button" class="btn-primary" style="background:#64748b;margin-left:8px;" onclick="nextStep(3)">Back</button>
                        </div>

                        <div id="step-5" class="form-step hidden">
                            <h4 style="color:#0f766e;margin-bottom:12px;">Preview &amp; submit</h4>
                            <div class="preview-box">
                                <p><strong>Name:</strong> <span id="prev-name"></span></p>
                                <p><strong>Contact:</strong> <span id="prev-contact"></span></p>
                                <p><strong>Address:</strong> <span id="prev-addr"></span></p>
                                <p><strong>Location:</strong> <span id="prev-loc"></span></p>
                                <p><strong>Qualification:</strong> <span id="prev-qual"></span></p>
                                <div id="prev-ncism-box" class="hidden"><p><strong>Registration ID:</strong> <span id="prev-ncism"></span></p></div>
                                <div id="prev-cert-box" class="hidden"><p><strong>Certificate:</strong> uploaded</p></div>
                                <p><strong>College:</strong> <span id="prev-college"></span></p>
                                <p><strong>College location:</strong> <span id="prev-cloc"></span></p>
                                <div id="prev-tnc-block" style="margin-top:12px;display:none;">
                                    <h4 style="color:#0f766e;margin-bottom:6px;">Seminar terms</h4>
                                    <motion id="prev-tnc-text" style="white-space:pre-wrap;font-size:0.88rem;"></div>
                                </div>
                            </motion>
                            <img id="prev-qrcode" alt="QR preview">
                            <iframe id="pdf-viewer" title="Application preview PDF"></iframe>
                            <label style="display:flex;align-items:center;gap:8px;margin:16px 0;"><input type="checkbox" id="tnc"> I agree to the terms and confirm the information is correct.</label>
                            <div style="display:flex;flex-wrap:wrap;gap:10px;">
                                <button type="button" class="btn-primary" onclick="submitApplication()">Submit application</button>
                                <button type="button" class="btn-primary" onclick="downloadPdf()">Download preview PDF</button>
                                <button type="button" class="btn-primary" style="background:#64748b;" onclick="nextStep(4)">Back</button>
                                <button type="button" class="btn-primary" style="background:#64748b;" onclick="cancelRegistration()">Cancel</button>
                            </div>
                        </div>
                    </div>
                </div>

                <motion id="tab-applications" class="tab-pane hidden">
                    <h2 class="section-title">Track seminar applications</h2>
                    <p id="seminar-track-live" class="hidden"><i class="fas fa-circle" style="color:#10b981;font-size:0.5rem;vertical-align:middle;"></i> Live status updates</p>
                    <div class="card" id="applications-tracker-container"><p style="color:#64748b;">Loading trackers…</p></div>
                    <div class="card">
                        <h3 style="margin-bottom:12px;color:#0f766e;">Application list</h3>
                        <table class="data-table">
                            <thead><tr><th>Application #</th><th>Status</th><th>Actions</th></tr></thead>
                            <tbody id="applications-list"><tr><td colspan="3" style="text-align:center;color:#64748b;">Loading…</td></tr></tbody>
                        </table>
                    </div>
                </div>

                <div id="tab-abstract" class="tab-pane hidden">
                    <h2 class="section-title">Case presentation application</h2>
                    <p id="case-program-limits-note" style="color:#64748b;margin:-10px 0 16px;"></p>
                    <div id="case-programs-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-bottom:20px;"></div>
                    <div class="card hidden" id="case-application-form">
                        <button type="button" class="btn-primary" style="background:#64748b;margin-bottom:14px;" onclick="cancelCaseApplication()">← Back to programs</button>
                        <h3 id="case-form-program-title" style="margin:0 0 12px;color:#0f766e;"></h3>
                        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
                            <div class="form-group"><label>First name *</label><input type="text" id="case-fname"></div>
                            <div class="form-group"><label>Middle name</label><input type="text" id="case-mname"></div>
                            <div class="form-group"><label>Last name *</label><input type="text" id="case-lname"></div>
                        </div>
                        <div class="form-group"><label>Email *</label><input type="email" id="case-email"></div>
                        <div class="form-group"><label>Phone *</label><input type="text" id="case-phone" inputmode="tel" maxlength="15"></div>
                        <div class="form-group"><label>WhatsApp *</label><input type="text" id="case-whatsapp" inputmode="tel" maxlength="15"></div>
                        <div class="form-group">
                            <label>Category *</label>
                            <select id="case-category">
                                <option value="">Select</option>
                                <option value="agnikarma">Agnikarma</option>
                                <option value="viddhakarma">Viddhakarma</option>
                            </select>
                        </div>
                        <div class="form-group"><label>Case topic *</label><input type="text" id="case-topic"></div>
                        <motion class="form-group"><label>Upload files (max 5) *</label><input type="file" id="case-files" multiple accept=".pdf,.ppt,.pptx,.doc,.docx,video/*,image/*"></motion>
                        <button type="button" class="btn-primary" onclick="submitCasePresentation()">Submit application</button>
                    </div>
                </div>

                <div id="tab-case-track" class="tab-pane hidden">
                    <h2 class="section-title">Track case applications</h2>
                    <p id="case-track-live" class="hidden"><i class="fas fa-circle" style="color:#10b981;font-size:0.5rem;"></i> Live updates</p>
                    <div class="card" id="case-tracker-container"><p style="color:#64748b;">Loading…</p></div>
                </div>

                <div id="tab-volunteer" class="tab-pane hidden">
                    <h2 class="section-title">Volunteer registration</h2>
                    <div class="card" id="volunteer-panel"><p style="color:#64748b;">Loading…</p></div>
                </div>

                <div id="tab-feedback" class="tab-pane hidden">
                    <h2 class="section-title">Seminar feedback</h2>
                    <p style="color:#64748b;margin:-10px 0 20px;">Share your experience after attending a seminar.</p>
                    <div class="card">
                        <form id="dash-feedback-form" onsubmit="submitDashboardFeedback(event)">
                            <div class="form-group"><label>Seminar attended</label><select id="dfb-seminar" required></select></div>
                            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
                                <div class="form-group"><label>Overall (1–5)</label><select id="dfb-rating" required><option value="">—</option><option value="5">5</option><option value="4">4</option><option value="3">3</option><option value="2">2</option><option value="1">1</option></select></div>
                                <div class="form-group"><label>Content (1–5)</label><select id="dfb-content" required><option value="">—</option><option value="5">5</option><option value="4">4</option><option value="3">3</option><option value="2">2</option><option value="1">1</option></select></div>
                                <div class="form-group"><label>Speaker (1–5)</label><select id="dfb-speaker" required><option value="">—</option><option value="5">5</option><option value="4">4</option><option value="3">3</option><option value="2">2</option><option value="1">1</option></select></div>
                                <div class="form-group"><label>Organization (1–5)</label><select id="dfb-org" required><option value="">—</option><option value="5">5</option><option value="4">4</option><option value="3">3</option><option value="2">2</option><option value="1">1</option></select></div>
                            </div>
                            <div class="form-group"><label>Experience</label><textarea id="dfb-exp" rows="2" required></textarea></div>
                            <div class="form-group"><label>Suggestions</label><textarea id="dfb-sug" rows="2"></textarea></div>
                            <label style="display:flex;align-items:center;gap:8px;font-size:0.9rem;margin-bottom:12px;"><input type="checkbox" id="dfb-again" checked> Interested in future seminars</label>
                            <button type="submit" class="btn-primary" style="width:100%;">Submit feedback</button>
                        </form>
                    </div>
                </div>

                <div id="tab-support" class="tab-pane hidden">
                    <h2 class="section-title">Support tickets</h2>
                    <p style="color:#64748b;margin:-10px 0 20px;">Raise a ticket and continue the conversation when an administrator replies.</p>
                    <div id="support-main-view">
                        <button type="button" class="btn-primary" onclick="document.getElementById('new-ticket-form').classList.remove('hidden')" style="margin-bottom:20px;">+ New support ticket</button>
                        <div id="new-ticket-form" class="card hidden">
                            <h3 style="margin-bottom:15px;color:#0f766e;">Create ticket</h3>
                            <div class="form-group"><label>Category</label>
                                <select id="ticket-cat">
                                    <option value="general">General</option>
                                    <option value="technical">Technical</option>
                                    <option value="billing">Billing</option>
                                    <option value="registration">Registration</option>
                                    <option value="other">Other</option>
                                </select>
                            </div>
                            <div class="form-group"><label>Subject</label><input type="text" id="ticket-subj"></div>
                            <div class="form-group"><label>Description</label><textarea id="ticket-desc" rows="4"></textarea></div>
                            <button type="button" class="btn-primary" onclick="submitSupportTicket()">Submit ticket</button>
                            <button type="button" class="btn-primary" style="background:#64748b;margin-left:8px;" onclick="document.getElementById('new-ticket-form').classList.add('hidden')">Cancel</button>
                            <p id="ticket-result" style="margin-top:15px;color:#059669;font-weight:600;"></p>
                        </div>
                        <div class="card">
                            <h3 style="margin-bottom:15px;">Your tickets</h3>
                            <table class="data-table">
                                <thead><tr><th>Ticket ID</th><th>Subject</th><th>Status</th><th>Action</th></tr></thead>
                                <tbody id="tickets-list"><tr><td colspan="4" style="text-align:center;">No tickets found.</td></tr></tbody>
                            </table>
                        </div>
                    </div>
                    <div id="support-chat-view" class="card hidden">
                        <button type="button" class="btn-primary" onclick="closeChat()" style="background:#64748b;margin-bottom:15px;"><i class="fas fa-arrow-left"></i> Back</button>
                        <h3 id="chat-title" style="color:#0f766e;border-bottom:1px solid #e2e8f0;padding-bottom:10px;margin-bottom:15px;">Ticket</h3>
                        <div id="chat-messages" style="height:300px;overflow-y:auto;background:#f8fafc;padding:15px;border-radius:8px;margin-bottom:15px;display:flex;flex-direction:column;gap:10px;"></div>
                        <div style="display:flex;gap:10px;">
                            <input type="text" id="chat-reply-msg" placeholder="Type your reply…" style="flex:1;padding:10px;border:1px solid #cbd5e1;border-radius:6px;">
                            <button type="button" class="btn-primary" onclick="sendReply()">Send</button>
                        </div>
                    </div>
                </div>

                <div id="tab-orders" class="tab-pane hidden">
                    <h2 class="section-title">Orders</h2>
                    <div class="card">
                        <table class="data-table">
                            <thead><tr><th>Order ref</th><th>Seminar</th><th>Application</th><th>Amount</th><th>Order status</th><th>Registration</th><th>Date</th><th>Receipt</th></tr></thead>
                            <tbody id="orders-list"><tr><td colspan="8" style="text-align:center;color:#64748b;">Loading…</td></tr></tbody>
                        </table>
                    </div>
                </div>

                <div id="tab-receipts" class="tab-pane hidden">
                    <h2 class="section-title">Payment receipts</h2>
                    <p style="color:#64748b;margin:-10px 0 16px;">Successful payments only.</p>
                    <div class="card">
                        <table class="data-table">
                            <thead><tr><th>Order ref</th><th>Seminar</th><th>Amount</th><th>Paid on</th><th>Receipt</th></tr></thead>
                            <tbody id="doctor-receipts-list"><tr><td colspan="5" style="text-align:center;color:#64748b;">Loading…</td></tr></tbody>
                        </table>
                    </div>
                </div>

                <div id="tab-payments" class="tab-pane hidden">
                    <h2 class="section-title">Payments</h2>
                    <p style="color:#64748b;margin:-10px 0 16px;">When your application is approved, use the <strong>Pay now</strong> button on the seminar application tracker.</p>
                    <div class="card" id="make-payments-container"><p style="color:#64748b;">Open <strong>Track seminar applications</strong> to complete payment for approved registrations.</p></motion>
                </div>

                <div id="tab-ticket" class="tab-pane hidden">
                    <h2 class="section-title">Participant e‑tickets (QR)</h2>
                    <p style="color:#64748b;margin:-10px 0 16px;">QR entry tickets appear after successful payment.</p>
                    <div id="tickets-container" class="card"></div>
                </div>

                <div id="tab-certificate" class="tab-pane hidden">
                    <h2 class="section-title">Certificates</h2>
                    <p style="color:#64748b;margin:-10px 0 16px;">Available after event check-in and admin template upload.</p>
                    <div id="doctor-certificates-wrap" class="card"><p style="color:#64748b;">Loading…</p></div>
                </div>

                <motion id="tab-reset-pwd" class="tab-pane hidden">
                    <h2 class="section-title">Change password</h2>
                    <div class="card" style="max-width:480px;">
                        <div class="form-group"><label>Current password</label><input type="password" id="pwd-current" autocomplete="current-password"></div>
                        <div class="form-group"><label>New password</label><input type="password" id="pwd-new" autocomplete="new-password"></div>
                        <div class="form-group"><label>Confirm new password</label><input type="password" id="pwd-new2" autocomplete="new-password"></div>
                        <p id="pwd-change-msg" style="margin-bottom:12px;font-weight:600;"></p>
                        <button type="button" class="btn-primary" onclick="submitDoctorPasswordChange()">Update password</button>
                    </div>
                </div>

            </div>
        </div>
    </div>

    <div id="view-app-modal" class="hidden" style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:2000;display:flex;justify-content:center;align-items:center;padding:20px;">
        <div class="card" style="max-width:720px;width:100%;max-height:90vh;overflow-y:auto;">
            <h3 style="color:#0f766e;margin-bottom:12px;">Application details</h3>
            <div id="view-app-content"></div>
            <div id="view-app-tracking" style="margin-top:16px;"></div>
            <button type="button" class="btn-primary" style="margin-top:16px;background:#64748b;">Close</button>
        </div>
    </div>

    <div id="view-case-modal" class="hidden" style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:2000;display:flex;justify-content:center;align-items:center;padding:20px;">
        <div class="card" style="max-width:720px;width:100%;max-height:90vh;overflow-y:auto;">
            <h3 style="color:#0f766e;margin-bottom:12px;">Case application</h3>
            <div id="view-case-content"></div>
            <button type="button" class="btn-primary" style="margin-top:16px;background:#64748b;" onclick="document.getElementById('view-case-modal').classList.add('hidden')">Close</button>
        </div>
    </div>

    <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
    <script src="/js/site-branding.js"></script>
    <script src="/js/portal-auth.js"></script>
    <script src="/js/name-validation.js"></script>
    <script src="/js/doctor.js"></script>
</body>
</html>
`;

const fixed = html.replace(/<\/?motion\b/g, (m) => m.replace(/motion/g, 'motion')).replace(/motion/g, 'div');
const outPath = path.join(__dirname, '..', 'public', 'doctor.html');
fs.writeFileSync(outPath, fixed, 'utf8');

const ids = [...fixed.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
console.log('Wrote', outPath);
console.log('Lines:', fixed.split(/\n/).length);
console.log('Bytes:', Buffer.byteLength(fixed));
console.log('Unique IDs:', ids.length);
