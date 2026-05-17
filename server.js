const express = require('express');
const db = require('./lib/db');
const { isPostgresConfigured, validateDatabaseUrl, publicDatabaseHint, sanitizeDbError } = require('./lib/env-db');
const pgDb = isPostgresConfigured() ? require('./lib/db-pg') : null;
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const Razorpay = require('razorpay');
const axios = require('axios');
const crypto = require('crypto');
const { sendMail, isMailConfigured } = require('./lib/messaging');
const notifEngine = require('./lib/notification-engine');
const { registerNotificationRoutes } = require('./lib/notification-routes');
const integrationSettings = require('./lib/integration-settings');
const portalUrls = require('./lib/portal-urls');
const { subdomainPortalMiddleware } = require('./lib/subdomain-portal');
const otpLib = require('./lib/otp');
const {
    validateDynamicForm,
    normalizeFields,
    sanitizeRegistrationFormFields,
    maxStepFromFields
} = require('./lib/dynamic-fields');
const paymentGatewayOptions = require('./lib/payment-gateway-options');
const { ensureBootstrapAdmin } = require('./lib/ensure-bootstrap-admin');
const { validatePersonName, validateRegistrationPersonNames } = require('./lib/name-validation');
const refundLib = require('./lib/refunds');
const branding = require('./lib/branding');
const extModules = require('./lib/extended-modules');
const portalTracking = require('./lib/portal-tracking');
const seminarDt = require('./lib/seminar-datetime');
const siteMarketing = require('./lib/site-marketing');
const { isCheckinDateToday, localDateYmd } = require('./lib/local-date');
let jobsModule = null;
try {
    jobsModule = require('./lib/jobs');
} catch (e) {
    console.warn('[jobs] Could not load lib/jobs:', e.message);
}

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let appReadyPromise = null;
let appReadyFailed = null;
let appReadyResolved = false;
let deferredBootstrapStarted = false;

function bootstrapTimeoutMs() {
    if (!process.env.VERCEL) return 120000;
    const cap = Number(process.env.VERCEL_MAX_DURATION_MS);
    if (Number.isFinite(cap) && cap > 0) return Math.max(8000, cap - 3000);
    return 55000;
}

function bootstrapApp(done) {
    mountExtendedRoutes();
    startBackgroundWorkers();

    const finish = () => {
        if (done) done();
    };

    const runFullMigrations = () => {
        ensureCriticalUserColumns(() => {
            console.log('[bootstrap] migrations complete');
            if (done) done();
        });
    };

    const scheduleDeferredMigrations = () => {
        if (deferredBootstrapStarted) return finish();
        deferredBootstrapStarted = true;
        setImmediate(() => runFullMigrations());
        finish();
    };

    // Vercel: never block requests on the long SQLite-style migration chain (60s function cap).
    if (process.env.VERCEL) {
        return scheduleDeferredMigrations();
    }

    if (!pgDb) {
        return runFullMigrations();
    }

    const startMigrations = () => {
        pgDb
            .isCoreSchemaPresent()
            .then((ready) => {
                if (!ready) return runFullMigrations();
                console.log('[bootstrap] fast path — deferring migrations');
                scheduleDeferredMigrations();
            })
            .catch(() => runFullMigrations());
    };
    if (pgDb.ensureMissingCoreTables) {
        return pgDb.ensureMissingCoreTables().then(startMigrations).catch(() => runFullMigrations());
    }
    startMigrations();
}

function databaseConfigResponse(res) {
    const check = validateDatabaseUrl();
    return res.status(503).json({
        error: check.message,
        code: check.code,
        hint: publicDatabaseHint(check.code)
    });
}

function bootstrapFailureResponse(res, err) {
    const msg = sanitizeDbError(err);
    let code = 'BOOTSTRAP_FAILED';
    if (/timed out/i.test(msg)) code = 'BOOTSTRAP_TIMEOUT';
    else if (/DATABASE_URL|ECONNREFUSED|ENOTFOUND|password authentication|SSL|timeout|Connection terminated/i.test(msg)) {
        code = 'DB_CONNECT_FAILED';
    }
    return res.status(503).json({
        error:
            code === 'BOOTSTRAP_TIMEOUT'
                ? 'Database bootstrap timed out on cold start — retry in a few seconds.'
                : 'Database unavailable.',
        code,
        hint: publicDatabaseHint(code),
        detail: process.env.VERCEL_ENV === 'production' ? undefined : msg
    });
}

function startAppBootstrap() {
    const timeoutMs = bootstrapTimeoutMs();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error('Database bootstrap timed out after ' + Math.round(timeoutMs / 1000) + 's'));
        }, timeoutMs);
        db.connect((err) => {
            if (err) {
                clearTimeout(timer);
                return reject(err);
            }
            if (process.env.VERCEL) {
                clearTimeout(timer);
                appReadyResolved = true;
                resolve();
                bootstrapApp();
                return;
            }
            bootstrapApp(() => {
                clearTimeout(timer);
                appReadyResolved = true;
                resolve();
            });
        });
    });
}

function ensureAppReady(req, res, next) {
    if (!isPostgresConfigured()) {
        if (process.env.VERCEL) return databaseConfigResponse(res);
        return next();
    }
    const urlCheck = validateDatabaseUrl();
    if (!urlCheck.ok) return databaseConfigResponse(res);

    const failCooldownMs = process.env.VERCEL ? 8000 : 15000;
    if (appReadyFailed && Date.now() - appReadyFailed.at < failCooldownMs) {
        return bootstrapFailureResponse(res, new Error(appReadyFailed.message));
    }
    if (appReadyResolved && !appReadyPromise) return next();

    if (!appReadyPromise) {
        appReadyPromise = startAppBootstrap()
            .catch((e) => {
                appReadyFailed = { message: e.message, at: Date.now(), code: e.code };
                appReadyPromise = null;
                appReadyResolved = false;
                throw e;
            });
    }
    appReadyPromise
        .then(() => next())
        .catch((e) => {
            console.error('[bootstrap]', sanitizeDbError(e));
            bootstrapFailureResponse(res, e);
        });
}

app.get('/api/health', (req, res) => {
    const urlCheck = validateDatabaseUrl();
    const payload = {
        ok: false,
        time: new Date().toISOString(),
        runtime: {
            vercel: !!process.env.VERCEL,
            node: process.version
        },
        database: {
            mode: isPostgresConfigured() ? 'postgresql' : process.env.VERCEL ? 'unset' : 'sqlite',
            configured: isPostgresConfigured(),
            valid: urlCheck.ok
        },
        bootstrap: {
            state: appReadyResolved ? 'ready' : appReadyPromise ? 'in_progress' : appReadyFailed ? 'failed' : 'idle'
        }
    };
    if (!urlCheck.ok) {
        payload.code = urlCheck.code;
        payload.error = urlCheck.message;
        payload.hint = publicDatabaseHint(urlCheck.code);
        return res.status(503).json(payload);
    }
    if (!isPostgresConfigured()) {
        payload.ok = true;
        return res.json(payload);
    }
    if (appReadyFailed) {
        payload.bootstrap.lastError = sanitizeDbError(appReadyFailed.message);
        payload.bootstrap.failedAt = new Date(appReadyFailed.at).toISOString();
    }
    db.connect((err) => {
        if (err) {
            payload.code = 'DB_CONNECT_FAILED';
            payload.error = sanitizeDbError(err);
            payload.hint = publicDatabaseHint('DB_CONNECT_FAILED');
            return res.status(503).json(payload);
        }
        if (appReadyResolved) {
            payload.ok = true;
            payload.bootstrap.state = 'ready';
            if (pgDb && pgDb.listMissingCoreTables) {
                return Promise.all([
                    pgDb.listMissingCoreTables(),
                    pgDb.listMissingAuxTables ? pgDb.listMissingAuxTables() : Promise.resolve([])
                ])
                    .then(([coreMissing, auxMissing]) => {
                        const missing = [...coreMissing, ...auxMissing];
                        if (missing.length) {
                            payload.ok = false;
                            payload.schema = { missingTables: missing };
                            payload.hint =
                                'PostgreSQL schema is incomplete. Redeploy after fixing DATABASE_URL, or run schema-postgres.sql on Neon.';
                        }
                        res.json(payload);
                    })
                    .catch(() => res.json(payload));
            }
            return res.json(payload);
        }
        if (appReadyPromise) {
            return appReadyPromise
                .then(() => {
                    payload.ok = true;
                    payload.bootstrap.state = 'ready';
                    res.json(payload);
                })
                .catch((e) => {
                    payload.bootstrap.state = 'failed';
                    payload.error = sanitizeDbError(e);
                    payload.hint = publicDatabaseHint('BOOTSTRAP_FAILED');
                    res.status(503).json(payload);
                });
        }
        payload.ok = true;
        payload.bootstrap.state = 'connected';
        res.json(payload);
    });
});

function requestNeedsBootstrap(req) {
    const p = req.path || '/';
    if (p === '/api/health') return false;
    if (p.startsWith('/api/branding/logo')) return false;
    if (p === '/scanner' || p === '/scanner/') return false;
    if (/\.(html?|css|js|ico|png|jpe?g|gif|webp|svg|woff2?|json|webmanifest|txt|map)$/i.test(p)) return false;
    if (p.startsWith('/css/') || p.startsWith('/js/') || p.startsWith('/uploads/')) return false;
    if (p.startsWith('/api/')) return true;
    if (p.startsWith('/admin') || p.startsWith('/doctor') || p.startsWith('/judge')) return true;
    return false;
}

app.use(subdomainPortalMiddleware);

app.get('/scanner', (req, res) => {
    res.redirect(302, '/scanner.html');
});
app.get('/scanner/', (req, res) => {
    res.redirect(302, '/scanner.html');
});

app.use(
    express.static('public', {
        maxAge: process.env.VERCEL ? '86400000' : 0,
        etag: true
    })
);

app.use((req, res, next) => {
    if (!requestNeedsBootstrap(req)) return next();
    return ensureAppReady(req, res, next);
});

// Kill Switch Middleware
app.use((req, res, next) => {
    // Let admin routes pass
    if (
        req.path.startsWith('/admin') ||
        req.path.startsWith('/api/admin') ||
        req.path.startsWith('/api/auth') ||
        req.path.startsWith('/api/otp') ||
        req.path.startsWith('/api/judge') ||
        req.path.startsWith('/api/scanner') ||
        req.path.startsWith('/api/branding') ||
        req.path.startsWith('/api/assets/') ||
        req.path.startsWith('/api/case') ||
        req.path.startsWith('/api/doctor') ||
        req.path.startsWith('/api/applications') ||
        req.path.startsWith('/api/payments') ||
        req.path.startsWith('/api/orders') ||
        req.path.startsWith('/api/seminars') ||
        req.path.startsWith('/api/global_settings') ||
        req.path === '/api/registration-form-config' ||
        req.path.startsWith('/api/public/') ||
        req.path.startsWith('/uploads') ||
        req.path.startsWith('/css') ||
        req.path.startsWith('/js')
    ) {
        return next();
    }
    db.get(`SELECT value FROM global_settings WHERE key = 'is_site_disabled'`, [], (err, row) => {
        if (err) {
            console.error('Kill switch read global_settings:', err.message);
            return next();
        }
        if (row && row.value === '1') {
            return res.status(503).send(`
                <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Under Maintenance</title>
                    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
                    <style>
                        * { margin: 0; padding: 0; box-sizing: border-box; }
                        body {
                            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                            min-height: 100vh;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            overflow: hidden;
                        }
                        .maintenance-container {
                            background: rgba(255, 255, 255, 0.95);
                            border-radius: 20px;
                            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
                            padding: 60px 40px;
                            max-width: 600px;
                            width: 90%;
                            text-align: center;
                            backdrop-filter: blur(10px);
                            animation: slideIn 0.6s ease-out;
                        }
                        @keyframes slideIn {
                            from { opacity: 0; transform: translateY(30px); }
                            to { opacity: 1; transform: translateY(0); }
                        }
                        .icon-wrapper {
                            margin-bottom: 30px;
                            animation: float 3s ease-in-out infinite;
                        }
                        .icon-wrapper i {
                            font-size: 80px;
                            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                            -webkit-background-clip: text;
                            -webkit-text-fill-color: transparent;
                            background-clip: text;
                        }
                        @keyframes float {
                            0%, 100% { transform: translateY(0px); }
                            50% { transform: translateY(-20px); }
                        }
                        h1 {
                            font-size: 2.5rem;
                            color: #2d3748;
                            margin-bottom: 15px;
                            font-weight: 700;
                            letter-spacing: -0.5px;
                        }
                        .subtitle {
                            font-size: 1.1rem;
                            color: #667eea;
                            margin-bottom: 10px;
                            font-weight: 600;
                        }
                        .description {
                            font-size: 1rem;
                            color: #4a5568;
                            line-height: 1.6;
                            margin-bottom: 30px;
                        }
                        .info-box {
                            background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
                            border-left: 4px solid #667eea;
                            padding: 20px;
                            border-radius: 10px;
                            margin-bottom: 30px;
                            text-align: left;
                        }
                        .info-box p {
                            color: #2d3748;
                            font-size: 0.95rem;
                            margin: 8px 0;
                        }
                        .info-box strong {
                            color: #667eea;
                        }
                        .contact-info {
                            margin-top: 30px;
                            padding-top: 20px;
                            border-top: 1px solid #e2e8f0;
                        }
                        .contact-info p {
                            color: #718096;
                            font-size: 0.9rem;
                            margin: 8px 0;
                        }
                        .contact-info a {
                            color: #667eea;
                            text-decoration: none;
                            font-weight: 600;
                            transition: all 0.3s ease;
                        }
                        .contact-info a:hover {
                            color: #764ba2;
                            text-decoration: underline;
                        }
                        .loader {
                            margin-top: 30px;
                            display: flex;
                            justify-content: center;
                            gap: 8px;
                        }
                        .dot {
                            width: 8px;
                            height: 8px;
                            border-radius: 50%;
                            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                            animation: pulse 1.5s ease-in-out infinite;
                        }
                        .dot:nth-child(2) { animation-delay: 0.2s; }
                        .dot:nth-child(3) { animation-delay: 0.4s; }
                        @keyframes pulse {
                            0%, 100% { transform: scale(1); opacity: 1; }
                            50% { transform: scale(1.5); opacity: 0.5; }
                        }
                    </style>
                </head>
                <body>
                    <div class="maintenance-container">
                        <div class="icon-wrapper">
                            <i class="fas fa-tools"></i>
                        </div>
                        <h1>Under Maintenance</h1>
                        <p class="subtitle">We'll be back soon!</p>
                        <p class="description">
                            The Vaidya Gogate Memorial Foundation National Seminar Portal is currently undergoing scheduled maintenance and updates to serve you better.
                        </p>
                        <div class="info-box">
                            <p><strong>📅 What's Happening:</strong> We're upgrading our systems and improving the platform experience.</p>
                            <p><strong>⏱️ Expected Time:</strong> Maintenance should be completed within 1-2 hours.</p>
                            <p><strong>✅ We appreciate your patience!</strong></p>
                        </div>
                        <div class="loader">
                            <div class="dot"></div>
                            <div class="dot"></div>
                            <div class="dot"></div>
                        </div>
                        <div class="contact-info">
                            <p>For urgent inquiries, please contact us at:</p>
                            <p><a href="mailto:support@vaidyagogate.org">📧 support@vaidyagogate.org</a></p>
                            <p><a href="tel:+919876543210">📞 +91-98765-43210</a></p>
                        </div>
                    </div>
                </body>
                </html>
            `);
        }
        next();
    });
});

app.get('/api/public/portal-urls', (req, res) => {
    res.json(portalUrls.getPortalUrls());
});

const uploadsDir = path.join(__dirname, 'public', 'uploads');
try {
    fs.mkdirSync(uploadsDir, { recursive: true });
} catch (mkdirErr) {
    console.warn('Could not ensure uploads directory:', mkdirErr.message);
}

// Configure Multer for file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadsDir);
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname))
    }
});
const upload = multer({ storage: storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB max
const memoryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function ensureCriticalUserColumns(callback) {
    const ignoreDup = (err) => {
        if (!err) return;
        const m = String(err.message || '');
        if (
            m.includes('duplicate column') ||
            m.includes('already exists') ||
            m.includes('does not exist')
        ) {
            return;
        }
        console.error('Schema migration:', m);
    };

    const runRegistrationMigrations = (next) => {
        db.run(`ALTER TABLE registrations ADD COLUMN registration_source TEXT DEFAULT 'doctor'`, (r1) => {
            ignoreDup(r1);
            db.run(`ALTER TABLE registrations ADD COLUMN admin_editor_user_id INTEGER`, (r2) => {
                ignoreDup(r2);
                db.run(`ALTER TABLE registrations ADD COLUMN updated_at DATETIME`, (r2b) => {
                    ignoreDup(r2b);
                    db.run(
                        `UPDATE registrations SET updated_at = created_at WHERE updated_at IS NULL`,
                        (r2c) => {
                            ignoreDup(r2c);
                            next();
                        }
                    );
                });
            });
        });
    };

    const afterUsers = () => {
        const onRegDone = () => {
            db.run(`ALTER TABLE case_judge_scores ADD COLUMN is_locked INTEGER DEFAULT 0`, (r3) => {
                ignoreDup(r3);
                db.run(`ALTER TABLE users ADD COLUMN is_demo INTEGER DEFAULT 0`, (r4) => {
                    ignoreDup(r4);
                    ensureBootstrapAdmin(db, generateId, (admErr) => {
                        if (admErr) console.warn('[admin] bootstrap:', admErr.message);
                        ensurePortalSchema(() => callback());
                    });
                });
            });
        };
        if (pgDb && pgDb.listMissingCoreTables) {
            return pgDb.listMissingCoreTables().then((missing) => {
                if (missing.includes('registrations')) return onRegDone();
                runRegistrationMigrations(onRegDone);
            });
        }
        runRegistrationMigrations(onRegDone);
    };

    db.run(`ALTER TABLE users ADD COLUMN is_disabled INTEGER DEFAULT 0`, (err) => {
        ignoreDup(err);
        db.run(`ALTER TABLE users ADD COLUMN user_role TEXT`, (err2) => {
            ignoreDup(err2);
            db.run(`ALTER TABLE users ADD COLUMN admin_modules TEXT`, (err3) => {
                ignoreDup(err3);
                afterUsers();
            });
        });
    });
}

// Helper function to generate exactly 12-digit numeric IDs
function generateId() {
    let id = '';
    for(let i=0; i<12; i++) {
        id += Math.floor(Math.random() * 10).toString();
    }
    return id;
}

const DEFAULT_REGISTRATION_FORM_CONFIG = {
    version: 1,
    fields: [
        { key: 'fname', label: 'First name', type: 'text', step: 1, enabled: true, required: true },
        { key: 'mname', label: 'Middle name', type: 'text', step: 1, enabled: true, required: true },
        { key: 'lname', label: 'Last name', type: 'text', step: 1, enabled: true, required: true },
        { key: 'email', label: 'Email', type: 'email', step: 1, enabled: true, required: true, verifyOtp: true },
        { key: 'phone', label: 'Phone', type: 'tel', step: 1, enabled: true, required: true, verifyOtp: true },
        { key: 'address', label: 'Address', type: 'textarea', step: 2, enabled: true, required: true },
        { key: 'pin', label: 'Pincode', type: 'text', step: 2, enabled: true, required: true },
        { key: 'city', label: 'City', type: 'text', step: 2, enabled: true, required: true },
        { key: 'state', label: 'State', type: 'text', step: 2, enabled: true, required: true },
        { key: 'country', label: 'Country', type: 'text', step: 2, enabled: true, required: true },
        {
            key: 'qual',
            label: 'Qualification',
            type: 'select',
            step: 3,
            enabled: true,
            required: true,
            options: [
                { value: 'Practicing Vaidya', label: 'Practicing Vaidya' },
                { value: 'Practitioner', label: 'Practitioner' },
                { value: 'PG', label: 'PG' }
            ]
        },
        { key: 'ncism', label: 'Medical registration / NCISM', type: 'text', step: 3, enabled: true, required: true, onlyWhenAdvancedQual: true },
        { key: 'certificate', label: 'Certificate upload', type: 'file', step: 3, enabled: true, required: true, onlyWhenAdvancedQual: true },
        { key: 'college', label: 'College name', type: 'text', step: 4, enabled: true, required: true },
        { key: 'ccity', label: 'College city', type: 'text', step: 4, enabled: true, required: true },
        { key: 'cstate', label: 'College state', type: 'text', step: 4, enabled: true, required: true },
        {
            key: 'agree_terms',
            label: 'I confirm the information is accurate',
            type: 'boolean',
            step: 4,
            enabled: true,
            required: true
        }
    ]
};
const DEFAULT_REGISTRATION_FORM_CONFIG_JSON = JSON.stringify(DEFAULT_REGISTRATION_FORM_CONFIG);

const DEFAULT_PUBLIC_SITE_CMS = {
    version: 1,
    tickerText: 'Limited seats available! Register before February 28th to get early bird discount.',
    bannerImage: '',
    scrollingAnnouncements: [],
    aboutSections: [
        {
            heading: 'About Vaidya Gogate Memorial Foundation',
            body: 'The Foundation advances Ayurveda education through national seminars, clinical case presentations, and continuing medical education since 1972.'
        }
    ],
    socialLinks: [
        {
            platform: 'youtube',
            label: 'Vaidya Gogate Memorial Foundation',
            url: 'https://www.youtube.com/results?search_query=Vaidya+Gogate+Memorial+Foundation'
        },
        {
            platform: 'facebook',
            label: 'Vaidya Gogate Memorial Foundation',
            url: 'https://www.facebook.com/search/top?q=Vaidya%20Gogate%20Memorial%20Foundation'
        },
        {
            platform: 'instagram',
            label: 'Vaidya Gogate Memorial Foundation',
            url: 'https://www.instagram.com/explore/tags/vaidyagogate/'
        }
    ],
    pastSeminarGallery: [],
    doctorUpdates: [
        {
            title: 'Doctor portal',
            body: 'Use Available Seminars to register, then Make Payments when your application is approved. Receipts and QR tickets appear under View Orders and View Tickets.',
            at: ''
        }
    ],
    slides: [],
    publicNotices: [],
    reviews: [
        { name: 'Dr. A. Sharma', role: 'Practitioner, Mumbai', text: 'Outstanding academic content and hospitality.', rating: 5 },
        { name: 'Dr. B. Patil', role: 'PG Scholar', text: 'Well organised — valuable for clinical practice.', rating: 5 },
        { name: 'Dr. C. Joshi', role: 'Ayurvedic physician', text: 'Highly recommended for continuing medical education.', rating: 5 }
    ],
    topBar: {
        email: 'info@vaidyagogate.org',
        phone: '+91 9876543210',
        dateLine: 'National Seminar 2026'
    },
    hero: {
        title: 'National Seminar 2026',
        subtitle: 'Advancements in Ayurveda & Integrative Medicine',
        venue: 'Convention Centre, Pune',
        image: '',
        ctaPrimary: 'Register Now',
        ctaSecondary: 'View Schedule'
    },
    heroStats: [
        { value: '50+', label: 'Expert Speakers' },
        { value: '500+', label: 'Delegates' },
        { value: '30+', label: 'Research Papers' }
    ],
    featureCards: [
        { icon: 'fa-microphone-alt', title: 'Expert Speakers', text: 'Renowned practitioners and researchers' },
        { icon: 'fa-certificate', title: 'CME Credits', text: 'Professional development hours' },
        { icon: 'fa-trophy', title: 'Case Presentations', text: 'Clinical excellence awards' },
        { icon: 'fa-network-wired', title: 'Networking', text: 'Connect with leaders nationwide' }
    ],
    contact: {
        address: 'Convention Centre, Pune, Maharashtra',
        phone: '+91 9876543210',
        email: 'info@vaidyagogate.org',
        hours: 'Mon–Sat, 10:00 AM – 6:00 PM'
    },
    schedulePage: {
        title: 'Event Schedule',
        subtitle: 'Sessions, speakers, and timings'
    },
    faq: [
        {
            q: 'How do I register?',
            a: 'Create a doctor account on this site or use the Doctor portal, then complete registration under Available Seminars.'
        },
        {
            q: 'When will I receive my e-ticket?',
            a: 'After your application is approved and payment is confirmed, your QR e-ticket appears in the Doctor portal.'
        }
    ],
    footer: {
        tagline: 'Promoting Ayurveda education since 1972',
        copyright: '© 2026 Vaidya Gogate Memorial Foundation. All rights reserved.'
    }
};
const DEFAULT_PUBLIC_SITE_CMS_JSON = JSON.stringify(DEFAULT_PUBLIC_SITE_CMS);

function needsAdvancedQualBlock(qual) {
    const q = String(qual || '');
    return q === 'PG' || q === 'Practicing Vaidya' || q === 'Practitioner';
}

function ignoreSchemaMigrationErr(err) {
    if (!err) return;
    const m = String(err.message || '');
    if (m.includes('duplicate column') || m.includes('duplicate column name') || m.includes('already exists')) {
        return;
    }
    console.error('Schema migration:', m);
}

function seedGlobalSettingIfMissing(key, jsonValue, next) {
    db.get(`SELECT 1 AS ok FROM global_settings WHERE key = ?`, [key], (e, row) => {
        if (e) {
            console.error('seedGlobalSettingIfMissing read:', e.message);
            return next && next();
        }
        if (row && row.ok) return next && next();
        db.run(`INSERT INTO global_settings (key, value) VALUES (?, ?)`, [key, jsonValue], (insErr) => {
            if (insErr) console.error('seedGlobalSettingIfMissing insert:', key, insErr.message);
            next && next();
        });
    });
}

function ensureMessagingOtpSchema(next) {
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS otp_codes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel TEXT NOT NULL,
            destination TEXT NOT NULL,
            purpose TEXT NOT NULL,
            meta TEXT,
            code_hash TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            consumed INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS otp_verification_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token_hash TEXT NOT NULL,
            purpose TEXT NOT NULL,
            channel TEXT NOT NULL,
            user_id INTEGER,
            seminar_id INTEGER,
            expires_at TEXT NOT NULL,
            consumed INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS notification_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel TEXT NOT NULL,
            destination TEXT NOT NULL,
            template_key TEXT,
            payload TEXT,
            scheduled_at TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            attempts INTEGER DEFAULT 0,
            last_error TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS refunds (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER,
            registration_id INTEGER,
            amount REAL,
            percent INTEGER,
            gateway TEXT,
            provider_refund_id TEXT,
            status TEXT,
            raw_response TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS registration_reminder_log (
            registration_id INTEGER NOT NULL,
            sent_date TEXT NOT NULL,
            PRIMARY KEY (registration_id, sent_date)
        )`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_otp_lookup ON otp_codes (destination, purpose, consumed)`, () => {
            notifEngine.ensureNotificationSchema(db, ignoreSchemaMigrationErr, () => {
                if (next) next();
            });
        });
    });
}

function ensurePortalSchema(next) {
    db.run(
        `CREATE TABLE IF NOT EXISTS global_settings (
            key TEXT PRIMARY KEY NOT NULL,
            value TEXT
        )`,
        (e0) => {
            ignoreSchemaMigrationErr(e0);
            db.run(
                `CREATE TABLE IF NOT EXISTS event_schedules (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL,
                    description TEXT,
                    seminar_id INTEGER,
                    start_time DATETIME NOT NULL,
                    end_time DATETIME NOT NULL,
                    location TEXT,
                    speaker_name TEXT,
                    speaker_bio TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (seminar_id) REFERENCES seminars(id)
                )`,
                (esErr) => {
                    ignoreSchemaMigrationErr(esErr);
                }
            );
            db.run(`ALTER TABLE seminars ADD COLUMN hero_image_path TEXT`, (h1) => {
                ignoreSchemaMigrationErr(h1);
                db.run(`ALTER TABLE seminars ADD COLUMN flyer_path TEXT`, (h2) => {
                    ignoreSchemaMigrationErr(h2);
                    db.run(`ALTER TABLE seminars ADD COLUMN gallery_paths TEXT`, (h3) => {
                        ignoreSchemaMigrationErr(h3);
                        db.run(`ALTER TABLE seminars ADD COLUMN registration_form_json TEXT`, (h4) => {
                            ignoreSchemaMigrationErr(h4);
                            db.run(`ALTER TABLE seminars ADD COLUMN cancellation_policy_json TEXT`, (h5) => {
                                ignoreSchemaMigrationErr(h5);
                                db.run(`ALTER TABLE seminars ADD COLUMN whatsapp_group_url TEXT`, (h6) => {
                                    ignoreSchemaMigrationErr(h6);
                                    db.run(`ALTER TABLE seminars ADD COLUMN otp_on_application INTEGER DEFAULT 0`, (h7) => {
                                        ignoreSchemaMigrationErr(h7);
                                        db.run(`ALTER TABLE seminars ADD COLUMN public_list_enabled INTEGER DEFAULT 0`, (h7b) => {
                                            ignoreSchemaMigrationErr(h7b);
                                        db.run(`ALTER TABLE tickets ADD COLUMN ticket_id_string TEXT`, (e2) => {
                                            ignoreSchemaMigrationErr(e2);
                                            db.run(`ALTER TABLE tickets ADD COLUMN is_valid INTEGER DEFAULT 1`, (e2b) => {
                                                ignoreSchemaMigrationErr(e2b);
                                            db.run(`ALTER TABLE orders ADD COLUMN payment_gateway TEXT`, (eo1) => {
                                                ignoreSchemaMigrationErr(eo1);
                                                db.run(`ALTER TABLE orders ADD COLUMN provider_order_id TEXT`, (eo2) => {
                                                    ignoreSchemaMigrationErr(eo2);
                                                    db.run(`ALTER TABLE orders ADD COLUMN provider_transaction_id TEXT`, (eo3) => {
                                                        ignoreSchemaMigrationErr(eo3);
                                                        seedGlobalSettingIfMissing('registration_form_config', DEFAULT_REGISTRATION_FORM_CONFIG_JSON, () => {
                                                            migrateLegacyRegistrationFormConfig(() => {
                                                            seedGlobalSettingIfMissing('public_site_cms', DEFAULT_PUBLIC_SITE_CMS_JSON, () => {
                                                                ensureMessagingOtpSchema(() => {
                                                                    ensureCertificateSchema(() => {
                                                                        extModules.ensureExtendedModulesSchema(
                                                                            db,
                                                                            ignoreSchemaMigrationErr,
                                                                            () => {
                                                                                casePresentation.ensureCasePresentationSchema(
                                                                                    db,
                                                                                    ignoreSchemaMigrationErr,
                                                                                    () => {
                                                                                        portalTracking.ensurePortalTrackingSchema(
                                                                                            db,
                                                                                            ignoreSchemaMigrationErr,
                                                                                            () => {
                                                                                                seedGlobalSettingIfMissing(
                                                                                                    portalTracking.PORTAL_YEAR_KEY,
                                                                                                    JSON.stringify(new Date().getFullYear()),
                                                                                                    () => {
                                                                                                        siteMarketing.ensureSiteMarketingSchema(db, () => {
                                                                                                            seedGlobalSettingIfMissing(
                                                                                                                integrationSettings.SETTINGS_KEY,
                                                                                                                '{}',
                                                                                                                () => {
                                                                                                                    integrationSettings.loadFromDb(db, () => {
                                                                                                                        if (next) next();
                                                                                                                    });
                                                                                                                }
                                                                                                            );
                                                                                                        });
                                                                                                    }
                                                                                                );
                                                                                            }
                                                                                        );
                                                                                    }
                                                                                );
                                                                            }
                                                                        );
                                                                    });
                                                                });
                                                            });
                                                            });
                                                        });
                                                    });
                                                });
                                            });
                                        });
                                        });
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
        }
    );
}

function ensureCertificateSchema(next) {
    db.run(
        `CREATE TABLE IF NOT EXISTS certificate_templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            seminar_id INTEGER,
            file_path TEXT NOT NULL,
            original_name TEXT,
            mime_type TEXT,
            uploaded_by INTEGER,
            is_active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (seminar_id) REFERENCES seminars(id)
        )`,
        (e1) => {
            ignoreSchemaMigrationErr(e1);
            db.run(
                `CREATE TABLE IF NOT EXISTS user_certificates (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    seminar_id INTEGER NOT NULL,
                    ticket_id INTEGER,
                    registration_id INTEGER,
                    display_name TEXT NOT NULL,
                    template_id INTEGER,
                    enabled INTEGER DEFAULT 0,
                    scan_verified INTEGER DEFAULT 0,
                    scan_time DATETIME,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(user_id, seminar_id),
                    FOREIGN KEY (user_id) REFERENCES users(id),
                    FOREIGN KEY (seminar_id) REFERENCES seminars(id)
                )`,
                (e2) => {
                    ignoreSchemaMigrationErr(e2);
                    if (next) next();
                }
            );
        }
    );
}

function buildDisplayNameFromFormData(formData, userRow) {
    let fd = {};
    try {
        fd = typeof formData === 'string' ? JSON.parse(formData) : formData || {};
    } catch (_) {
        fd = {};
    }
    const parts = [fd.fname, fd.mname, fd.lname].filter((x) => x != null && String(x).trim() !== '');
    if (parts.length) return parts.join(' ').replace(/\s+/g, ' ').trim();
    if (userRow) {
        return [userRow.first_name, userRow.middle_name, userRow.last_name].filter(Boolean).join(' ').trim();
    }
    return 'Participant';
}

/** True if today is strictly before the seminar calendar day (local). */
function isBeforeSeminarDay(eventDate) {
    if (!eventDate) return true;
    const ev = new Date(eventDate);
    if (Number.isNaN(ev.getTime())) return true;
    const eventDay = new Date(ev.getFullYear(), ev.getMonth(), ev.getDate());
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return today < eventDay;
}

function invalidateTicketsForRegistration(registrationId, cb) {
    db.run(
        `UPDATE tickets SET is_valid = 0
         WHERE order_id IN (SELECT id FROM orders WHERE registration_id = ?)`,
        [registrationId],
        (err) => {
            if (cb) cb(err);
        }
    );
}

function syncCertificateEligibilityForTicket(ticketId, cb) {
    const q = `
        SELECT t.id AS ticket_id, t.is_scanned, t.scan_time, t.user_id, t.order_id,
               r.id AS registration_id, r.seminar_id, r.form_data,
               u.first_name, u.middle_name, u.last_name,
               o.status AS order_status
        FROM tickets t
        JOIN orders o ON o.id = t.order_id
        JOIN registrations r ON r.id = o.registration_id
        JOIN users u ON u.id = t.user_id
        WHERE t.id = ?
    `;
    db.get(q, [ticketId], (err, row) => {
        if (err) return cb && cb(err);
        if (!row) return cb && cb(null);
        const displayName = buildDisplayNameFromFormData(row.form_data, row);
        const paidAndScanned =
            row.is_scanned === 1 && String(row.order_status || '').toLowerCase() === 'success' ? 1 : 0;
        db.get(
            `SELECT id FROM certificate_templates WHERE seminar_id = ? AND is_active = 1 ORDER BY id DESC LIMIT 1`,
            [row.seminar_id],
            (e2, tpl) => {
                if (e2) return cb && cb(e2);
                const scanVerified = paidAndScanned && tpl ? 1 : 0;
                db.run(
                    `INSERT INTO user_certificates (user_id, seminar_id, ticket_id, registration_id, display_name, template_id, enabled, scan_verified, scan_time, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, CURRENT_TIMESTAMP)
                     ON CONFLICT(user_id, seminar_id) DO UPDATE SET
                       ticket_id = excluded.ticket_id,
                       registration_id = excluded.registration_id,
                       display_name = excluded.display_name,
                       template_id = COALESCE(excluded.template_id, user_certificates.template_id),
                       scan_verified = excluded.scan_verified,
                       scan_time = excluded.scan_time,
                       updated_at = CURRENT_TIMESTAMP`,
                    [
                        row.user_id,
                        row.seminar_id,
                        row.ticket_id,
                        row.registration_id,
                        displayName,
                        tpl ? tpl.id : null,
                        scanVerified,
                        row.scan_time || null
                    ],
                    () => cb && cb(null)
                );
            }
        );
    });
}

function migrateLegacyRegistrationFormConfig(done) {
    db.get(`SELECT value FROM global_settings WHERE key = 'registration_form_config'`, [], (err, row) => {
        if (err || !row || !row.value) return done && done();
        try {
            const parsed = JSON.parse(row.value);
            const rawFields = Array.isArray(parsed.fields) ? parsed.fields : [];
            const hasLegacyOtp = rawFields.some(
                (f) => f && (f.key === 'phone_otp' || f.key === 'email_otp')
            );
            if (!hasLegacyOtp) return done && done();
            parsed.fields = sanitizeRegistrationFormFields(rawFields);
            upsertGlobalSetting('registration_form_config', parsed, () => done && done());
        } catch (_) {
            done && done();
        }
    });
}

function loadGlobalRegistrationFormFields(callback) {
    db.get(`SELECT value FROM global_settings WHERE key = 'registration_form_config'`, [], (err, row) => {
        if (err || !row || !row.value) {
            return callback(null, sanitizeRegistrationFormFields(DEFAULT_REGISTRATION_FORM_CONFIG.fields));
        }
        try {
            const parsed = JSON.parse(row.value);
            const fields = Array.isArray(parsed.fields) ? parsed.fields : DEFAULT_REGISTRATION_FORM_CONFIG.fields;
            callback(null, sanitizeRegistrationFormFields(fields));
        } catch (_) {
            callback(null, sanitizeRegistrationFormFields(DEFAULT_REGISTRATION_FORM_CONFIG.fields));
        }
    });
}

function loadRegistrationFormConfig(seminarIdOrNull, callback) {
    let seminarId = seminarIdOrNull;
    let cb = callback;
    if (typeof seminarIdOrNull === 'function') {
        cb = seminarIdOrNull;
        seminarId = null;
    }
    if (seminarId != null && seminarId !== '' && !Number.isNaN(Number(seminarId))) {
        const sid = Number(seminarId);
        db.get(`SELECT registration_form_json FROM seminars WHERE id = ?`, [sid], (err, row) => {
            if (!err && row && row.registration_form_json && String(row.registration_form_json).trim()) {
                try {
                    const parsed = JSON.parse(row.registration_form_json);
                    if (parsed && Array.isArray(parsed.fields) && parsed.fields.length) {
                        return cb(null, sanitizeRegistrationFormFields(parsed.fields));
                    }
                } catch (_) {
                    /* fall through */
                }
            }
            loadGlobalRegistrationFormFields(cb);
        });
        return;
    }
    loadGlobalRegistrationFormFields(cb);
}

function loadPublicSiteCms(callback) {
    db.get(`SELECT value FROM global_settings WHERE key = 'public_site_cms'`, [], (err, row) => {
        let base = { ...DEFAULT_PUBLIC_SITE_CMS };
        if (!err && row && row.value) {
            try {
                const parsed = JSON.parse(row.value);
                if (parsed && typeof parsed === 'object') {
                    base = { ...base, ...parsed };
                    if (!Array.isArray(base.doctorUpdates)) base.doctorUpdates = DEFAULT_PUBLIC_SITE_CMS.doctorUpdates;
                    if (!Array.isArray(base.slides)) base.slides = [];
                    if (!Array.isArray(base.publicNotices)) base.publicNotices = [];
                    if (!Array.isArray(base.scrollingAnnouncements)) base.scrollingAnnouncements = [];
                    if (!Array.isArray(base.reviews)) base.reviews = DEFAULT_PUBLIC_SITE_CMS.reviews;
                    if (!Array.isArray(base.aboutSections)) base.aboutSections = DEFAULT_PUBLIC_SITE_CMS.aboutSections;
                    if (!Array.isArray(base.socialLinks)) base.socialLinks = DEFAULT_PUBLIC_SITE_CMS.socialLinks;
                    if (!Array.isArray(base.pastSeminarGallery)) base.pastSeminarGallery = [];
                    if (!base.topBar || typeof base.topBar !== 'object') base.topBar = { ...DEFAULT_PUBLIC_SITE_CMS.topBar };
                    if (!base.hero || typeof base.hero !== 'object') base.hero = { ...DEFAULT_PUBLIC_SITE_CMS.hero };
                    if (!Array.isArray(base.heroStats)) base.heroStats = DEFAULT_PUBLIC_SITE_CMS.heroStats;
                    if (!Array.isArray(base.featureCards)) base.featureCards = DEFAULT_PUBLIC_SITE_CMS.featureCards;
                    if (!base.contact || typeof base.contact !== 'object') base.contact = { ...DEFAULT_PUBLIC_SITE_CMS.contact };
                    if (!base.schedulePage || typeof base.schedulePage !== 'object') {
                        base.schedulePage = { ...DEFAULT_PUBLIC_SITE_CMS.schedulePage };
                    }
                    if (!Array.isArray(base.faq)) base.faq = DEFAULT_PUBLIC_SITE_CMS.faq;
                    if (!base.footer || typeof base.footer !== 'object') base.footer = { ...DEFAULT_PUBLIC_SITE_CMS.footer };
                }
            } catch (_) {
                /* keep defaults */
            }
        }
        callback(null, base);
    });
}

/** When a seminar is saved and active, refresh its auto card in homepage scrolling announcements (+ optional DB notice on create). */
function syncSeminarCmsAfterSave(seminarId, alsoInsertDbNotice, cb) {
    const sid = parseInt(seminarId, 10);
    if (Number.isNaN(sid)) return cb && cb(null);
    db.get(
        `SELECT id, title, description, event_date, registration_start, registration_end, is_active FROM seminars WHERE id = ?`,
        [sid],
        (err, row) => {
            if (err || !row) return cb && cb(err);
            if (!Number(row.is_active)) return cb && cb(null);
            const title = row.title || 'Seminar';
            const msg = `${title}: registration is open. Apply from the doctor portal.`;
            const bodyBits = [];
            if (row.registration_start) {
                bodyBits.push(`Opens ${seminarDt.formatSeminarDateTime(row.registration_start)}`);
            }
            if (row.registration_end) {
                bodyBits.push(`closes ${seminarDt.formatSeminarDateTime(row.registration_end)}`);
            }
            if (row.event_date) {
                bodyBits.push(`event ${seminarDt.formatSeminarDateTime(row.event_date)}`);
            }
            const descShort = row.description ? String(row.description).replace(/\s+/g, ' ').trim().slice(0, 160) : '';
            const body = [msg, bodyBits.join(' · '), descShort].filter(Boolean).join(' — ');

            const pushCms = () => {
                loadPublicSiteCms((e2, cms) => {
                    if (e2) return cb && cb(e2);
                    const arr = Array.isArray(cms.scrollingAnnouncements) ? cms.scrollingAnnouncements : [];
                    const filtered = arr.filter((a) => !(a && Number(a.autoFromSeminarId) === sid));
                    filtered.unshift({
                        title: `Seminar — ${title}`,
                        body,
                        date: new Date().toISOString().slice(0, 10),
                        autoFromSeminarId: sid,
                        link: ''
                    });
                    cms.scrollingAnnouncements = filtered.slice(0, 40);
                    upsertGlobalSetting('public_site_cms', JSON.stringify({ ...cms, version: 1 }), (upErr) => cb && cb(upErr));
                });
            };

            if (alsoInsertDbNotice) {
                db.run(`INSERT INTO notices (seminar_id, message, pdf_path) VALUES (?, ?, NULL)`, [sid, msg], () => pushCms());
            } else {
                pushCms();
            }
        }
    );
}

function validateFormDataAgainstRegistrationConfig(formData, hasCertificateFile, fields, qualOverride) {
    const nameErr = validateRegistrationPersonNames(formData);
    if (nameErr) return nameErr;
    return validateDynamicForm(formData, hasCertificateFile, fields, qualOverride);
}

function parseMaybeJson(val) {
    if (val == null) return null;
    if (typeof val === 'object') return val;
    const s = String(val).trim();
    if (!s) return null;
    try {
        return JSON.parse(s);
    } catch (_) {
        return null;
    }
}

function persistUploadedCertificate(req, cb) {
    if (!req.file) return cb(null, null);
    if (process.env.VERCEL && req.file.buffer) {
        const key =
            'cert_' + Date.now() + '_' + crypto.randomBytes(6).toString('hex');
        const payload = JSON.stringify({
            mime: req.file.mimetype || 'application/octet-stream',
            data: req.file.buffer.toString('base64'),
            name: req.file.originalname || 'certificate'
        });
        return upsertGlobalSetting(key, payload, (err) => {
            if (err) return cb(err);
            cb(null, '/api/assets/' + encodeURIComponent(key));
        });
    }
    cb(null, req.file.filename || null);
}

function sanitizeFormDataForStorage(formData) {
    const src = formData && typeof formData === 'object' ? formData : {};
    const out = { ...src };
    delete out.phone_otp;
    delete out.email_otp;
    delete out.fieldOtpTokens;
    delete out.phoneOtpToken;
    delete out.emailOtpToken;
    Object.keys(out).forEach((k) => {
        if (/_otp$/i.test(k) || k === 'otp' || k === 'otp_code') delete out[k];
    });
    return out;
}

function enqueueApplicationSubmitted(db, meta, cb) {
    const { userId, seminarId, registrationId } = meta || {};
    if (!userId) return cb && cb(null);
    notifEngine.notify(
        db,
        'APPLICATION_UNDER_REVIEW',
        {
            userId,
            seminarId,
            registrationId,
            vars: { approval_status: 'submitted' }
        },
        () => cb && cb(null)
    );
}

/** Assign 12-digit e-ticket ID + refresh QR payload when missing (legacy rows). */
function ensureTicketIdString(ticketRowId, orderIdStr, registrationId, applicationNo, userId, orderDbId, existingQr, cb) {
    const tid = parseInt(ticketRowId, 10);
    if (!Number.isInteger(tid) || tid < 1) return cb && cb(new Error('Invalid ticket id'));

    function finish(etk, qrData) {
        db.run(
            `UPDATE tickets SET ticket_id_string = ?, qr_code_data = ? WHERE id = ?`,
            [etk, qrData, tid],
            (err) => cb && cb(err, etk, qrData)
        );
    }

    function attempt(tryNo) {
        if (tryNo > 30) return cb && cb(new Error('Could not allocate a unique e-ticket id. Try again.'));
        const etk = generateId();
        db.get(`SELECT 1 AS ok FROM tickets WHERE ticket_id_string = ? AND id != ?`, [etk, tid], (eDup, dupRow) => {
            if (eDup) return cb && cb(eDup);
            if (dupRow && dupRow.ok) return attempt(tryNo + 1);
            let qr = {};
            try {
                qr = existingQr ? JSON.parse(existingQr) : {};
            } catch (_) {
                qr = {};
            }
            qr.ticketId = etk;
            qr.orderId = orderIdStr || qr.orderId || null;
            qr.orderDbId = orderDbId != null ? orderDbId : qr.orderDbId;
            qr.registrationId = registrationId != null ? registrationId : qr.registrationId;
            qr.applicationNo = applicationNo || qr.applicationNo || null;
            qr.userId = userId != null ? userId : qr.userId;
            if (!qr.ts) qr.ts = Date.now();
            finish(etk, JSON.stringify(qr));
        });
    }

    attempt(0);
}

function backfillMissingTicketIdStrings(cb) {
    db.all(
        `SELECT t.id, t.order_id, t.user_id, t.qr_code_data, o.order_id_string, o.registration_id, r.application_no
         FROM tickets t
         JOIN orders o ON o.id = t.order_id
         JOIN registrations r ON r.id = o.registration_id
         WHERE t.ticket_id_string IS NULL OR TRIM(t.ticket_id_string) = ''`,
        [],
        (err, rows) => {
            if (err) return cb && cb(err);
            const list = rows || [];
            if (!list.length) return cb && cb(null, 0);
            let i = 0;
            const next = () => {
                if (i >= list.length) return cb && cb(null, list.length);
                const row = list[i++];
                ensureTicketIdString(
                    row.id,
                    row.order_id_string,
                    row.registration_id,
                    row.application_no,
                    row.user_id,
                    row.order_id,
                    row.qr_code_data,
                    (e) => {
                        if (e) return cb && cb(e);
                        next();
                    }
                );
            };
            next();
        }
    );
}

function notifyTicketIssued(userId, registrationId, ticketId) {
    if (!userId || !registrationId || !ticketId) return;
    db.get(`SELECT seminar_id FROM registrations WHERE id = ?`, [registrationId], (e, reg) => {
        if (e || !reg) return;
        notifEngine.notify(db, 'TICKET_ISSUED', {
            userId,
            seminarId: reg.seminar_id,
            registrationId,
            vars: {
                ticket_id: ticketId,
                qr_code_url: notifEngine.publicBaseUrl() + '/doctor.html#tab-tickets',
                payment_status: 'PAID'
            }
        });
    });
}

function insertParticipantTicket(orderDbId, userId, orderIdStr, registrationId, applicationNo, cb) {
    db.get(`SELECT status FROM registrations WHERE id = ?`, [registrationId], (eReg, regRow) => {
        if (eReg) return cb && cb(eReg);
        const st = String((regRow && regRow.status) || '').toLowerCase();
        if (st === 'rejected' || st === 'cancelled') {
            return cb && cb(null, null, null, { skipped: true });
        }

        function attemptInsert(tryNo) {
            if (tryNo > 30) return cb && cb(new Error('Could not allocate a unique e-ticket id. Try again.'));
            const etk = generateId();
            db.get(`SELECT 1 AS ok FROM tickets WHERE ticket_id_string = ?`, [etk], (eDup, dupRow) => {
                if (eDup) return cb && cb(eDup);
                if (dupRow && dupRow.ok) return attemptInsert(tryNo + 1);
                const qrData = JSON.stringify({
                    ticketId: etk,
                    orderId: orderIdStr,
                    orderDbId,
                    registrationId,
                    applicationNo: applicationNo || null,
                    userId,
                    ts: Date.now()
                });
                db.run(
                    `INSERT INTO tickets (order_id, user_id, qr_code_data, ticket_id_string) VALUES (?, ?, ?, ?)`,
                    [orderDbId, userId, qrData, etk],
                    (err) => {
                        if (err && String(err.message || '').includes('UNIQUE')) {
                            return attemptInsert(tryNo + 1);
                        }
                        if (err && String(err.message || '').includes('no such column')) {
                            return db.run(
                                `INSERT INTO tickets (order_id, user_id, qr_code_data) VALUES (?, ?, ?)`,
                                [orderDbId, userId, qrData],
                                function (e2) {
                                    if (e2) return cb && cb(e2);
                                    const newId = this.lastID;
                                    if (newId) {
                                        return ensureTicketIdString(
                                            newId,
                                            orderIdStr,
                                            registrationId,
                                            applicationNo,
                                            userId,
                                            orderDbId,
                                            qrData,
                                            (e3, etk2, qr2) => {
                                                if (!e3 && etk2) notifyTicketIssued(userId, registrationId, etk2);
                                                cb && cb(e3, etk2, qr2);
                                            }
                                        );
                                    }
                                    if (!err && etk) notifyTicketIssued(userId, registrationId, etk);
                                    cb && cb(null, etk, qrData);
                                }
                            );
                        }
                        cb && cb(err, etk, qrData);
                    }
                );
            });
        }

        db.get(`SELECT id, ticket_id_string, qr_code_data FROM tickets WHERE order_id = ?`, [orderDbId], (eExist, existing) => {
            if (eExist) return cb && cb(eExist);
            if (existing) {
                const cur = existing.ticket_id_string && String(existing.ticket_id_string).trim();
                if (cur) return cb && cb(null, cur, existing.qr_code_data);
                return ensureTicketIdString(
                    existing.id,
                    orderIdStr,
                    registrationId,
                    applicationNo,
                    userId,
                    orderDbId,
                    existing.qr_code_data,
                    (eFix, etk, qr) => {
                        if (!eFix && etk) notifyTicketIssued(userId, registrationId, etk);
                        cb && cb(eFix, etk, qr);
                    }
                );
            }
            attemptInsert(0);
        });
    });
}

const casePresentation = require('./lib/case-presentation');

let extendedRoutesMounted = false;
function mountExtendedRoutes() {
    if (extendedRoutesMounted) return;
    extendedRoutesMounted = true;
    casePresentation.registerCasePresentationRoutes(app, { db, upload, generateId });
    try {
        require('./lib/routes-ext')(app, {
            db,
            upload,
            generateId,
            buildDisplayNameFromFormData,
            syncCertificateEligibilityForTicket,
            insertParticipantTicket,
            ignoreSchemaMigrationErr
        });
    } catch (routeErr) {
        console.error('[routes] routes-ext failed (case APIs still active):', routeErr.message);
    }
    console.log('[routes] Extended APIs mounted (case programs, branding, volunteers, reports)');
}
try {
    mountExtendedRoutes();
} catch (mountErr) {
    console.error('[routes] mountExtendedRoutes failed:', mountErr.message);
    try {
        casePresentation.registerCasePresentationRoutes(app, { db, upload, generateId });
    } catch (caseErr) {
        console.error('[routes] case presentation routes failed:', caseErr.message);
    }
}

function listDoctorPaymentOptions(callback) {
    db.all(`SELECT * FROM payment_gateways WHERE is_active = 1`, [], (err, rows) => {
        if (err) return callback(err);
        const options = [];
        (rows || []).forEach((row) => {
            options.push(...paymentGatewayOptions.expandGatewayRow(row));
        });
        callback(null, options);
    });
}

function resolveDoctorPaymentOption(paymentOptionId, callback) {
    db.all(`SELECT * FROM payment_gateways WHERE is_active = 1`, [], (err, rows) => {
        if (err) return callback(err);
        const resolved = paymentGatewayOptions.resolvePaymentOption(paymentOptionId, rows);
        if (!resolved) return callback(null, null);
        callback(null, {
            name: resolved.gateway,
            mode: resolved.mode,
            label: resolved.label,
            config: resolved.config
        });
    });
}

function upsertGlobalSetting(key, value, cb) {
    db.run(`UPDATE global_settings SET value = ? WHERE key = ?`, [value, key], function (uerr) {
        if (uerr) return cb && cb(uerr);
        if (this.changes > 0) return cb && cb(null);
        db.run(`INSERT INTO global_settings (key, value) VALUES (?, ?)`, [key, value], (ierr) => cb && cb(ierr));
    });
}

siteMarketing.registerSiteMarketingRoutes(app, db, upload, upsertGlobalSetting);
registerNotificationRoutes(app, db);

function withIntegrationSettingsLoaded(req, res, next) {
    integrationSettings.ensureIntegrationSettingsLoaded(db, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        next();
    });
}

function integrationSettingsJson(data) {
    const masked = integrationSettings.maskSecretsForClient(data);
    masked.email_configured = integrationSettings.isEmailConfiguredFromSettings();
    masked.email_status = integrationSettings.getEmailConfigStatus();
    masked.whatsapp_configured = integrationSettings.isWhatsAppConfiguredFromSettings();
    return masked;
}

app.get('/api/admin/integrations', withIntegrationSettingsLoaded, (req, res) => {
    res.json(integrationSettingsJson(integrationSettings.getRuntimeIntegrations()));
});

app.post('/api/admin/integrations', withIntegrationSettingsLoaded, (req, res) => {
    const body = req.body || {};
    integrationSettings.saveToDb(db, body, (err, merged) => {
        if (err) return res.status(500).json({ error: err.message });
        if (body.public_base_url) {
            upsertGlobalSetting('domain', String(body.public_base_url).replace(/^https?:\/\//, ''), () => {});
        }
        res.json({
            success: true,
            settings: integrationSettingsJson(merged),
            email_configured: integrationSettings.isEmailConfiguredFromSettings(),
            email_status: integrationSettings.getEmailConfigStatus(),
            whatsapp_configured: integrationSettings.isWhatsAppConfiguredFromSettings()
        });
    });
});

app.post('/api/admin/integrations/test-email', withIntegrationSettingsLoaded, async (req, res) => {
    const to = String((req.body && req.body.to) || '').trim();
    if (!to) return res.status(400).json({ error: 'to email required' });
    const { sendEmail } = require('./lib/email-service');
    const r = await sendEmail(to, 'VGMF test email', '<p>SMTP test from seminar admin.</p>', { text: 'SMTP test' });
    if (r.ok) return res.json({ success: true });
    res.status(503).json({ error: r.error || 'Send failed', skipped: r.skipped });
});

app.post('/api/admin/integrations/test-whatsapp', async (req, res) => {
    const phone = String((req.body && req.body.phone) || '').trim();
    if (!phone) return res.status(400).json({ error: 'phone required' });
    const { sendWhatsAppText } = require('./lib/whatsapp-service');
    const r = await sendWhatsAppText(phone, 'VGMF scanner/portal test message from admin.');
    if (r.ok) return res.json({ success: true });
    res.status(503).json({ error: r.error || 'Send failed', skipped: r.skipped });
});

function validateDoctorName(name) {
    return validatePersonName(name, 'Name');
}

// --- API ENDPOINTS ---

function signupOtpRequired() {
    if (process.env.REQUIRE_SIGNUP_OTP === '0') return false;
    if (process.env.REQUIRE_SIGNUP_OTP === '1') return true;
    return notifEngine.isMessagingConfigured();
}

function loginOtpRequired() {
    if (process.env.REQUIRE_LOGIN_OTP === '0') return false;
    if (process.env.REQUIRE_LOGIN_OTP === '1') return true;
    return notifEngine.isMessagingConfigured();
}

function isSuperAdminRow(row) {
    if (!row) return false;
    const r = String(row.role || '').toLowerCase();
    const ur = String(row.user_role || '').trim().toLowerCase();
    return r === 'admin' && ur !== 'co_admin';
}

function parseAdminModulesJson(str) {
    if (str == null || !String(str).trim()) return null;
    try {
        const o = JSON.parse(str);
        return o && typeof o === 'object' ? o : null;
    } catch (_) {
        return null;
    }
}

app.get('/api/auth/signup-otp-required', (req, res) => {
    res.json({ required: signupOtpRequired() });
});

app.get('/api/auth/login-otp-required', (req, res) => {
    res.json({ required: loginOtpRequired() });
});

/** After password check: send login OTP to the user’s verified phone or email. */
app.post('/api/auth/login-otp/send', withIntegrationSettingsLoaded, (req, res) => {
    const { email, password, channel } = req.body || {};
    if (!email || password === undefined || password === null || !channel) {
        return res.status(400).json({ error: 'email, password, and channel are required' });
    }
    if (channel !== 'phone' && channel !== 'email') {
        return res.status(400).json({ error: 'channel must be phone or email' });
    }
    const emailNorm = String(email).trim().toLowerCase();
    db.get(
        `SELECT id, phone, email FROM users WHERE lower(trim(email)) = ? AND password = ? AND IFNULL(is_disabled,0) = 0`,
        [emailNorm, password],
        (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!row) return res.status(401).json({ error: 'Invalid credentials' });
            const dest =
                channel === 'email'
                    ? String(row.email || '')
                          .trim()
                          .toLowerCase()
                    : String(row.phone || '')
                          .trim()
                          .toLowerCase();
            if (!dest) {
                return res.status(400).json({ error: channel === 'email' ? 'No email on file.' : 'No phone on file.' });
            }
            const meta = { userId: row.id };
            otpLib.countRecentSends(db, channel, dest, (cerr, cnt) => {
                if (cerr) return res.status(500).json({ error: cerr.message });
                if (cnt >= otpLib.MAX_SENDS_PER_HOUR) {
                    return res.status(429).json({ error: 'Too many OTP requests. Try again later.' });
                }
                const code = otpLib.generateOtpDigits();
                otpLib.saveOtp(db, { channel, destination: dest, purpose: 'login', meta }, code, (serr) => {
                    if (serr) return res.status(500).json({ error: serr.message });
                    const msg = `Your login code is ${code}. Valid ${otpLib.OTP_TTL_MIN} minutes.`;
                    const finish = (sent) => {
                        const debug = process.env.OTP_RETURN_CODE === '1' || process.env.NODE_ENV === 'development';
                        const payload = { success: true, ttlMinutes: otpLib.OTP_TTL_MIN };
                        if (debug) payload.debugCode = code;
                        if (!sent.ok && !sent.skipped) {
                            return res.status(503).json({
                                error: sent.error || 'Could not deliver OTP.',
                                debugCode: debug ? code : undefined
                            });
                        }
                        if (sent.skipped) payload.warning = 'Messaging not fully configured; use debugCode in development.';
                        res.json(payload);
                    };
                    if (channel === 'phone') {
                        notifEngine
                            .sendOtpMessages({ phone: dest, code, db, eventKey: 'OTP_VERIFICATION' })
                            .then((r) => finish(r.whatsapp || { ok: false }));
                    } else {
                        notifEngine
                            .sendOtpMessages({ email: dest, code, db, eventKey: 'OTP_VERIFICATION' })
                            .then((r) => finish(r.email || { ok: false }));
                    }
                });
            });
        }
    );
});

app.post('/api/auth/login-otp/verify', (req, res) => {
    const { email, password, channel, code } = req.body || {};
    if (!email || password === undefined || !channel || !code) {
        return res.status(400).json({ error: 'email, password, channel, and code are required' });
    }
    if (channel !== 'phone' && channel !== 'email') {
        return res.status(400).json({ error: 'channel must be phone or email' });
    }
    const emailNorm = String(email).trim().toLowerCase();
    db.get(
        `SELECT id, phone, email FROM users WHERE lower(trim(email)) = ? AND password = ? AND IFNULL(is_disabled,0) = 0`,
        [emailNorm, password],
        (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!row) return res.status(401).json({ error: 'Invalid credentials' });
            const dest =
                channel === 'email'
                    ? String(row.email || '')
                          .trim()
                          .toLowerCase()
                    : String(row.phone || '')
                          .trim()
                          .toLowerCase();
            if (!dest) return res.status(400).json({ error: 'Missing destination on account' });
            const meta = { userId: row.id };
            otpLib.verifyOtp(
                db,
                {
                    channel,
                    destination: dest,
                    purpose: 'login',
                    code,
                    meta,
                    userId: row.id,
                    seminarId: null
                },
                (verr, result) => {
                    if (verr) return res.status(500).json({ error: verr.message });
                    if (!result || !result.ok) {
                        return res.status(400).json({ error: (result && result.error) || 'Verification failed' });
                    }
                    res.json({ success: true, token: result.token });
                }
            );
        }
    );
});

// OTP: send & verify (used by homepage signup + doctor registration)
app.post('/api/otp/send', withIntegrationSettingsLoaded, (req, res) => {
    const { channel, destination, purpose, seminarId, fieldKey, userId } = req.body || {};
    if (!channel || !destination || !purpose) {
        return res.status(400).json({ error: 'channel, destination, and purpose are required' });
    }
    if (channel !== 'phone' && channel !== 'email') {
        return res.status(400).json({ error: 'channel must be phone or email' });
    }
    const dest = String(destination).trim();
    if (!dest) return res.status(400).json({ error: 'destination required' });

    const meta = {};
    if (seminarId != null && seminarId !== '') meta.seminarId = parseInt(seminarId, 10);
    if (fieldKey) meta.fieldKey = String(fieldKey);
    if (userId != null && userId !== '') meta.userId = parseInt(userId, 10);

    if (purpose === 'registration' && Number.isNaN(meta.seminarId)) {
        return res.status(400).json({ error: 'seminarId required for registration OTP' });
    }
    if (purpose === 'registration_field' && (Number.isNaN(meta.seminarId) || !meta.fieldKey)) {
        return res.status(400).json({ error: 'seminarId and fieldKey required for field OTP' });
    }

    otpLib.countRecentSends(db, channel, dest, (cerr, cnt) => {
        if (cerr) return res.status(500).json({ error: cerr.message });
        if (cnt >= otpLib.MAX_SENDS_PER_HOUR) {
            return res.status(429).json({ error: 'Too many OTP requests. Try again later.' });
        }
        const code = otpLib.generateOtpDigits();
        otpLib.saveOtp(db, { channel, destination: dest, purpose, meta }, code, (serr) => {
            if (serr) return res.status(500).json({ error: serr.message });
            const purposeKey =
                purpose === 'signup' ? 'OTP_VERIFICATION' : purpose === 'registration' ? 'OTP_VERIFICATION' : 'OTP_VERIFICATION';
            notifEngine.sendOtpMessages({
                email: channel === 'email' ? dest : null,
                phone: channel === 'phone' ? dest : null,
                code,
                db,
                eventKey: purposeKey
            }).then((results) => {
                const sent = channel === 'phone' ? results.whatsapp : results.email;
                const debug = process.env.OTP_RETURN_CODE === '1' || process.env.NODE_ENV === 'development';
                const payload = { success: true, ttlMinutes: otpLib.OTP_TTL_MIN };
                if (debug) payload.debugCode = code;
                if (!sent.ok && !sent.skipped) {
                    return res.status(503).json({
                        error: sent.error || 'Could not deliver OTP. Configure Zoho email and/or WhatsApp API.',
                        debugCode: debug ? code : undefined
                    });
                }
                if (sent.skipped) {
                    payload.warning = 'Messaging not fully configured; use debugCode in development or set ZOHO_* / WHATSAPP_* env vars.';
                }
                res.json(payload);
            });
        });
    });
});

app.post('/api/otp/verify', (req, res) => {
    const { channel, destination, purpose, code, seminarId, fieldKey, userId } = req.body || {};
    if (!channel || !destination || !purpose || !code) {
        return res.status(400).json({ error: 'channel, destination, purpose, and code are required' });
    }
    const meta = {};
    if (seminarId != null && seminarId !== '') meta.seminarId = parseInt(seminarId, 10);
    if (fieldKey) meta.fieldKey = String(fieldKey);
    const uidNum = userId != null && userId !== '' ? parseInt(userId, 10) : null;
    if (purpose === 'login') {
        if (uidNum == null || Number.isNaN(uidNum)) {
            return res.status(400).json({ error: 'userId required for login OTP' });
        }
        meta.userId = uidNum;
    }
    otpLib.verifyOtp(
        db,
        {
            channel,
            destination,
            purpose,
            code,
            meta,
            userId: uidNum,
            seminarId: meta.seminarId
        },
        (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!result || !result.ok) {
                return res.status(400).json({ error: (result && result.error) || 'Verification failed' });
            }
            res.json({ success: true, token: result.token });
        }
    );
});

// 1. Auth: Signup
function normalizeAuthUserRow(row) {
    if (!row) return row;
    if (row.id != null) row.id = Number(row.id);
    if (row.is_disabled != null) row.is_disabled = Number(row.is_disabled);
    if (row.is_demo != null) row.is_demo = Number(row.is_demo);
    return row;
}

app.post('/api/auth/signup', (req, res) => {
    const { firstName, lastName, email, phone, password, role, phoneOtpToken, emailOtpToken } = req.body;
    const emailNorm = String(email || '').trim().toLowerCase();
    const phoneNorm = String(phone || '').trim();
    
    const firstNameValidation = validateDoctorName(firstName);
    if (!firstNameValidation.valid) {
        return res.status(400).json({ error: `First name: ${firstNameValidation.message}` });
    }
    const lastNameValidation = validateDoctorName(lastName);
    if (!lastNameValidation.valid) {
        return res.status(400).json({ error: `Last name: ${lastNameValidation.message}` });
    }
    
    function insertUser() {
        const userIdStr = generateId();
    const userRole = role || 'doctor';
    const cleanFirstName = firstNameValidation.cleanedName;
    const cleanLastName = lastNameValidation.cleanedName;
        db.run(
            `INSERT INTO users (user_id_string, first_name, last_name, email, phone, password, role, user_role) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [userIdStr, cleanFirstName, cleanLastName, emailNorm, phoneNorm, password, userRole, userRole],
        function (err) {
            if (err) {
                    if (err.message.includes('UNIQUE constraint failed') || /unique|duplicate key/i.test(err.message)) {
                    return res.status(400).json({ error: 'Email already exists.' });
                }
                return res.status(500).json({ error: err.message });
            }
                const newUserId = this.lastID != null ? Number(this.lastID) : null;
                if (!newUserId) {
                    return res.status(500).json({ error: 'Account was created but could not be confirmed. Try signing in with your email.' });
                }
                notifEngine.notify(
                    db,
                    'ACCOUNT_CREATED',
                    {
                        userId: newUserId,
                        vars: {
                            temporary_password: '(password you chose at registration)'
                        }
                    },
                    () => {}
                );
                res.json({
                    success: true,
                    userId: newUserId,
                    user_id_string: userIdStr,
                    message: 'Signup successful! Please create your profile before applying.'
                });
            }
        );
    }

    if (signupOtpRequired()) {
        if (!phoneOtpToken || !emailOtpToken) {
            return res.status(400).json({ error: 'Phone and email OTP verification is required before signup.' });
        }
        otpLib.validateSignupOtpTokens(db, { phoneToken: phoneOtpToken, emailToken: emailOtpToken }, (verr, vr) => {
            if (verr) return res.status(500).json({ error: verr.message });
            if (!vr || !vr.ok) return res.status(400).json({ error: (vr && vr.error) || 'Invalid OTP verification' });
            insertUser();
        });
        return;
    }
    insertUser();
});

// 2. Auth: Login (optional phone + email OTP when messaging is configured)
app.post('/api/auth/login', (req, res) => {
    const { email, password, phoneOtpToken, emailOtpToken } = req.body;
    if (!email || password === undefined || password === null) {
        return res.status(400).json({ error: 'Email and password are required' });
    }
    const emailNorm = String(email).trim().toLowerCase();
    db.get(
        `SELECT id, user_id_string, first_name, middle_name, last_name, email, phone, password, role, user_role, is_disabled, IFNULL(is_demo,0) AS is_demo, admin_modules FROM users WHERE lower(trim(email)) = ? AND password = ?`,
        [emailNorm, password],
        (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(401).json({ error: 'Invalid credentials' });
            if (Number(row.is_disabled) === 1) {
                return res.status(403).json({ error: 'Your account has been disabled. Please contact support.' });
            }

            function sendUser() {
                delete row.password;
                normalizeAuthUserRow(row);
        res.json({ success: true, user: row });
            }

            if (loginOtpRequired()) {
                if (!phoneOtpToken || !emailOtpToken) {
                    return res.status(400).json({ error: 'Phone and email OTP verification is required to log in.' });
                }
                otpLib.validateLoginOtpTokens(
                    db,
                    row.id,
                    { phoneToken: phoneOtpToken, emailToken: emailOtpToken },
                    (verr, vr) => {
                        if (verr) return res.status(500).json({ error: verr.message });
                        if (!vr || !vr.ok) return res.status(400).json({ error: (vr && vr.error) || 'Invalid OTP verification' });
                        sendUser();
                    }
                );
                return;
            }
            sendUser();
        }
    );
});

// Portal year (doctor + public)
app.get('/api/portal/year', (req, res) => {
    portalTracking.getPortalYear(db, (e, year) => {
        if (e) return res.status(500).json({ error: e.message });
        res.json({ portalYear: year });
    });
});

app.get('/api/admin/portal/year', (req, res) => {
    portalTracking.getPortalYear(db, (e, year) => {
        if (e) return res.status(500).json({ error: e.message });
        res.json({ portalYear: year });
    });
});

app.put('/api/admin/portal/year', (req, res) => {
    const year = req.body && (req.body.portalYear != null ? req.body.portalYear : req.body.year);
    const alignAllActive = !(req.body && req.body.alignAllActive === false);
    portalTracking.setPortalYear(db, upsertGlobalSetting, year, { alignAllActive }, (e) => {
        if (e) return res.status(400).json({ error: e.message });
        res.json({ success: true, portalYear: parseInt(year, 10), alignedActiveSeminars: alignAllActive });
    });
});

// 3. Seminars: current year vs past years
app.get('/api/seminars', (req, res) => {
    const bucket = String((req.query && req.query.bucket) || 'current').toLowerCase();
    portalTracking.getPortalYear(db, (eY, portalYear) => {
        if (eY) return res.status(500).json({ error: eY.message });
        const yearQ = req.query && req.query.year != null ? parseInt(req.query.year, 10) : portalYear;
        const activeYear = Number.isInteger(yearQ) ? yearQ : portalYear;
        let sql;
        let params;
        if (bucket === 'past') {
            sql = `SELECT * FROM seminars WHERE is_active = 1 AND portal_year IS NOT NULL AND portal_year < ? ORDER BY event_date DESC, id DESC`;
            params = [activeYear];
        } else {
            sql =
                `SELECT * FROM seminars WHERE is_active = 1 AND ` +
                portalTracking.seminarPortalYearMatchSql() +
                ` ORDER BY event_date ASC, id DESC`;
            params = [activeYear, activeYear];
        }
        db.all(sql, params, (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ portalYear: activeYear, bucket, seminars: rows || [] });
        });
    });
});

function registrationOtpChannelFlags(cb) {
    integrationSettings.ensureIntegrationSettingsLoaded(db, () => {
        const emailOk = integrationSettings.isEmailConfiguredFromSettings();
        const waOk = integrationSettings.isWhatsAppConfiguredFromSettings();
        cb(null, {
            emailConfigured: emailOk,
            whatsappConfigured: waOk,
            otpRequiresEmail: emailOk,
            otpRequiresPhone: waOk
        });
    });
}

app.get('/api/registration-form-config', (req, res) => {
    const raw = req.query && req.query.seminarId;
    const sid = raw != null && String(raw).trim() !== '' ? parseInt(raw, 10) : null;
    loadRegistrationFormConfig(Number.isNaN(sid) ? null : sid, (e, fields) => {
        if (e) return res.status(500).json({ error: e.message });
        registrationOtpChannelFlags((eFlags, flags) => {
            if (eFlags) return res.status(500).json({ error: eFlags.message });
            const base = {
                fields: fields || [],
                otpOnApplication: false,
                ...flags
            };
            if (sid != null && !Number.isNaN(sid)) {
                db.get(`SELECT otp_on_application FROM seminars WHERE id = ?`, [sid], (e2, row) => {
                    if (e2) return res.status(500).json({ error: e2.message });
                    const otpOn = !!(row && Number(row.otp_on_application) === 1);
                    res.json({
                        ...base,
                        otpOnApplication: otpOn,
                        otpRequiresEmail: otpOn && flags.otpRequiresEmail,
                        otpRequiresPhone: otpOn && flags.otpRequiresPhone
                    });
                });
                return;
            }
            res.json(base);
        });
    });
});

app.get('/api/public/participant-directories', (req, res) => {
    db.all(
        `SELECT id, title, event_date FROM seminars
         WHERE is_active = 1 AND IFNULL(public_list_enabled, 0) = 1
         ORDER BY event_date DESC`,
        [],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        }
    );
});

app.get('/api/public/participants/:seminarId', (req, res) => {
    const sid = parseInt(req.params.seminarId, 10);
    const q = String((req.query && req.query.q) || '').trim().toLowerCase();
    if (Number.isNaN(sid)) return res.status(400).json({ error: 'Invalid seminar' });
    db.get(
        `SELECT id, title, public_list_enabled FROM seminars WHERE id = ? AND is_active = 1`,
        [sid],
        (err, sem) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!sem || !sem.public_list_enabled) {
                return res.status(403).json({ error: 'Participant list is not published for this seminar yet.' });
            }
            db.all(
                `SELECT r.application_no, r.status, u.first_name, u.middle_name, u.last_name, u.user_id_string,
                        u.city, u.state, o.status AS payment_status, o.payment_date
                 FROM registrations r
                 JOIN users u ON r.user_id = u.id
                 INNER JOIN orders o ON o.registration_id = r.id AND o.status = 'success'
                 WHERE r.seminar_id = ?
                   AND r.status IN ('approved_pending_payment', 'completed', 'checked_in')
                 ORDER BY r.application_no ASC`,
                [sid],
                (e2, rows) => {
                    if (e2) return res.status(500).json({ error: e2.message });
                    let list = (rows || []).map((r) => ({
                        applicationNo: r.application_no,
                        name: [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' '),
                        city: r.city || '',
                        state: r.state || '',
                        status: r.status,
                        paid: r.payment_status === 'success',
                        userIdString: r.user_id_string
                    }));
                    if (q) {
                        list = list.filter(
                            (p) =>
                                String(p.applicationNo || '').toLowerCase().includes(q) ||
                                String(p.name || '').toLowerCase().includes(q) ||
                                String(p.userIdString || '').toLowerCase().includes(q)
                        );
                    }
                    res.json({ seminarTitle: sem.title, participants: list });
                }
            );
        }
    );
});

app.get('/api/public/site-cms', (req, res) => {
    loadPublicSiteCms((e, cms) => {
        if (e) return res.status(500).json({ error: e.message });
        res.json(cms);
    });
});

app.post('/api/admin/site-cms', (req, res) => {
    const incoming = req.body && req.body.cms;
    if (!incoming || typeof incoming !== 'object') {
        return res.status(400).json({ error: 'cms object required' });
    }
    for (let i = 0; i < ['doctorUpdates', 'slides', 'publicNotices', 'reviews', 'scrollingAnnouncements', 'aboutSections', 'socialLinks', 'pastSeminarGallery'].length; i++) {
        const k = ['doctorUpdates', 'slides', 'publicNotices', 'reviews', 'scrollingAnnouncements', 'aboutSections', 'socialLinks', 'pastSeminarGallery'][i];
        if (incoming[k] !== undefined && !Array.isArray(incoming[k])) {
            return res.status(400).json({ error: `${k} must be an array` });
        }
    }
    loadPublicSiteCms((e, current) => {
        if (e) return res.status(500).json({ error: e.message });
        const merged = {
            ...current,
            ...incoming,
            version: 1
        };
        ['doctorUpdates', 'slides', 'publicNotices', 'reviews', 'scrollingAnnouncements', 'aboutSections', 'socialLinks', 'pastSeminarGallery'].forEach((k) => {
            if (incoming[k] !== undefined) merged[k] = incoming[k];
        });
        if (typeof incoming.tickerText === 'string') merged.tickerText = incoming.tickerText;
        if (typeof incoming.bannerImage === 'string') merged.bannerImage = incoming.bannerImage;
        ['topBar', 'hero', 'contact', 'schedulePage', 'footer'].forEach((k) => {
            if (incoming[k] && typeof incoming[k] === 'object') {
                merged[k] = { ...(merged[k] || {}), ...incoming[k] };
            }
        });
        if (Array.isArray(incoming.heroStats)) merged.heroStats = incoming.heroStats;
        if (Array.isArray(incoming.featureCards)) merged.featureCards = incoming.featureCards;
        if (Array.isArray(incoming.faq)) merged.faq = incoming.faq;
        const payload = JSON.stringify(merged);
        upsertGlobalSetting('public_site_cms', payload, (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
    });
});

app.post('/api/admin/upload-asset', (req, res, next) => {
    (process.env.VERCEL ? memoryUpload : upload).single('file')(req, res, next);
}, (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'file is required' });
    }
    if (process.env.VERCEL && req.file.buffer) {
        const crypto = require('crypto');
        const key =
            'upload_asset_' +
            Date.now() +
            '_' +
            crypto.randomBytes(6).toString('hex');
        const payload = JSON.stringify({
            mime: req.file.mimetype || 'application/octet-stream',
            data: req.file.buffer.toString('base64'),
            name: req.file.originalname || 'file'
        });
        return upsertGlobalSetting(key, payload, (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, path: '/api/assets/' + encodeURIComponent(key) });
        });
    }
    if (!req.file.filename) {
        return res.status(400).json({ error: 'file is required' });
    }
    res.json({ success: true, path: '/uploads/' + req.file.filename });
});

app.get('/api/assets/:key', (req, res) => {
    const key = decodeURIComponent(String(req.params.key || ''));
    if (!/^upload_asset_[a-z0-9_]+$/i.test(key)) {
        return res.status(400).json({ error: 'Invalid asset key' });
    }
    db.get(`SELECT value FROM global_settings WHERE key = ?`, [key], (e, row) => {
        if (e) return res.status(500).end();
        if (!row || !row.value) return res.status(404).end();
        let payload;
        try {
            payload = JSON.parse(row.value);
        } catch (_) {
            return res.status(404).end();
        }
        if (!payload || !payload.data) return res.status(404).end();
        const buf = Buffer.from(payload.data, 'base64');
        res.setHeader('Content-Type', payload.mime || 'application/octet-stream');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(buf);
    });
});

app.post('/api/admin/registration-form-config', (req, res) => {
    const { fields } = req.body;
    if (!Array.isArray(fields)) return res.status(400).json({ error: 'fields must be an array' });
    const normalized = fields.map((f) => ({
        ...f,
        required: f.enabled !== false
    }));
    const payload = JSON.stringify({ version: 1, fields: normalized });
    upsertGlobalSetting('registration_form_config', payload, (e) => {
        if (e) return res.status(500).json({ error: e.message });
        res.json({ success: true });
    });
});

app.get('/api/admin/orders', (req, res) => {
    db.all(
        `SELECT o.id, o.order_id_string, o.amount, o.status, o.payment_date,
                o.payment_gateway, o.provider_order_id, o.provider_transaction_id,
                r.id as registration_id, r.application_no, r.status as registration_status,
                s.title as seminar_title, u.id as user_id, u.first_name, u.last_name, u.middle_name,
                u.user_id_string, u.email, u.phone,
                t.ticket_id_string AS e_ticket_id
         FROM orders o
         JOIN registrations r ON o.registration_id = r.id
         JOIN users u ON r.user_id = u.id
         LEFT JOIN seminars s ON r.seminar_id = s.id
         LEFT JOIN tickets t ON t.order_id = o.id
         ORDER BY o.id DESC`,
        [],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        }
    );
});

// Admin: Get ALL seminars (active and inactive)
app.get('/api/admin/seminars/all', (req, res) => {
    db.all(`SELECT * FROM seminars ORDER BY created_at DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// Alias used by volunteer/reports/certificate dropdowns
app.get('/api/admin/seminars', (req, res) => {
    db.all(
        `SELECT * FROM seminars WHERE is_active = 1 ORDER BY event_date DESC, id DESC`,
        [],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        }
    );
});

// 4. Abstracts: Submit (with video and ppt upload)
app.post('/api/abstracts/submit', upload.fields([{ name: 'video', maxCount: 1 }, { name: 'ppt', maxCount: 1 }]), (req, res) => {
    const { userId, topic } = req.body;
    const videoPath = req.files['video'] ? req.files['video'][0].filename : null;
    const pptPath = req.files['ppt'] ? req.files['ppt'][0].filename : null;

    db.run(`INSERT INTO abstracts (user_id, topic, video_path, ppt_path) VALUES (?, ?, ?, ?)`,
        [userId, topic, videoPath, pptPath],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, message: 'Abstract submitted successfully (Under Review).', abstractId: this.lastID });
        });
});

function parsePositiveUserId(raw) {
    const n = parseInt(raw, 10);
    return Number.isInteger(n) && n > 0 ? n : null;
}

/** Link registrations saved without user_id (bad session) to the signed-in account by email in form_data. */
function healOrphanRegistrationsForUser(uid, cb) {
    db.get(`SELECT email FROM users WHERE id = ?`, [uid], (e, user) => {
        if (e || !user || !user.email) return cb(e);
        const emailNorm = String(user.email).trim().toLowerCase();
        db.all(
            `SELECT id, form_data FROM registrations WHERE user_id IS NULL OR user_id = 0`,
            [],
            (e2, orphans) => {
                if (e2 || !orphans || !orphans.length) return cb(null, 0);
                let fixed = 0;
                let pending = orphans.length;
                orphans.forEach((row) => {
                    let fdEmail = '';
                    try {
                        const fd = typeof row.form_data === 'string' ? JSON.parse(row.form_data) : row.form_data;
                        fdEmail = String((fd && fd.email) || '').trim().toLowerCase();
                    } catch (_) {
                        fdEmail = '';
                    }
                    if (fdEmail && fdEmail === emailNorm) {
                        db.run(`UPDATE registrations SET user_id = ? WHERE id = ?`, [uid, row.id], () => {
                            fixed++;
                            if (--pending === 0) cb(null, fixed);
                        });
                    } else if (--pending === 0) {
                        cb(null, fixed);
                    }
                });
            }
        );
    });
}

function fetchApplicationsForUser(uid, yearFilter, cb) {
    if (!parsePositiveUserId(uid)) return cb(new Error('Invalid user id'));
    let sql = `SELECT r.id, r.seminar_id, r.application_no, r.status, r.form_data, r.created_at,
                r.created_at AS updated_at,
                s.title AS seminar_title, s.whatsapp_group_url, s.cancellation_policy_json, s.terms_conditions,
                s.event_date AS seminar_event_date, s.price AS seminar_price, s.portal_year
         FROM registrations r
         LEFT JOIN seminars s ON r.seminar_id = s.id
         WHERE r.user_id = ?`;
    const params = [uid];
    if (Number.isInteger(yearFilter)) {
        if (isPostgresConfigured()) {
            sql += ` AND (s.portal_year = ? OR EXTRACT(YEAR FROM COALESCE(s.event_date, r.created_at))::INTEGER = ?)`;
        } else {
            sql += ` AND (s.portal_year = ? OR CAST(strftime('%Y', COALESCE(s.event_date, r.created_at)) AS INTEGER) = ?)`;
        }
        params.push(yearFilter, yearFilter);
    }
    sql += ` ORDER BY r.id DESC`;
    db.all(sql, params, cb);
}

function respondApplicationsList(uid, yearFilter, res) {
    fetchApplicationsForUser(uid, yearFilter, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const finish = (list) => {
            portalTracking.attachRegistrationTimelines(db, list || [], (e2, enriched) => {
                if (e2) {
                    console.error('[applications] timeline attach failed:', e2.message);
                    enriched = (list || []).map((r) => ({ ...r, timeline: { steps: [], status: r.status } }));
                }
                portalTracking.getPortalYear(db, (e3, portalYear) => {
                    if (e3) return res.status(500).json({ error: e3.message });
                    res.json({ portalYear, applications: enriched || [] });
                });
            });
        };
        if (rows && rows.length) return finish(rows);
        healOrphanRegistrationsForUser(uid, (healErr, fixed) => {
            if (healErr) console.warn('[applications] heal orphans:', healErr.message);
            if (fixed) console.log(`[applications] linked ${fixed} orphan registration(s) to user ${uid}`);
            fetchApplicationsForUser(uid, yearFilter, (err2, rows2) => {
                if (err2) return res.status(500).json({ error: err2.message });
                finish(rows2 || []);
            });
        });
    });
}

// 5. Seminars: Register (Application Submission)
app.post('/api/applications/submit', (req, res, next) => {
    (process.env.VERCEL ? memoryUpload : upload).single('certificate')(req, res, (err) => {
        if (err) {
            return res.status(400).json({
                error: err.code === 'LIMIT_FILE_SIZE' ? 'Certificate file is too large.' : err.message || 'Upload failed'
            });
        }
        next();
    });
}, (req, res) => {
    let { userId, seminarId, formData, phoneOtpToken, emailOtpToken, fieldOtpTokens } = req.body;
    userId = parsePositiveUserId(userId);
    if (!userId) {
        return res.status(400).json({
            error: 'Invalid user session. Sign out of the doctor portal, sign in again with your email, then resubmit.'
        });
    }
    seminarId = parseInt(seminarId, 10);
    if (!Number.isInteger(seminarId) || seminarId < 1) {
        return res.status(400).json({ error: 'Invalid seminar.' });
    }
    
    // formData might be passed as string if using FormData API
    if (typeof formData === 'string') {
        try {
            formData = JSON.parse(formData);
        } catch (e) {}
    }
    const fieldOtpTokensObj = parseMaybeJson(fieldOtpTokens) || (fieldOtpTokens && typeof fieldOtpTokens === 'object' ? fieldOtpTokens : {});
    
    // Check if user already registered for this event
    db.get(`SELECT id FROM registrations WHERE user_id = ? AND seminar_id = ?`, [userId, seminarId], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (row) {
            return res.status(400).json({
                error: 'You have already registered an application for this event. You can track it in your Dashboard.'
            });
        }

        db.get(
            `SELECT registration_start, registration_end, otp_on_application, title FROM seminars WHERE id = ? AND is_active = 1`,
            [seminarId],
            (err2, sem) => {
            if (err2) return res.status(500).json({ error: err2.message });
            if (!sem) return res.status(400).json({ error: 'Seminar not found or is not active.' });

            const now = Date.now();
            const rs = seminarDt.parseSeminarMs(sem.registration_start);
            const re = seminarDt.parseSeminarMs(sem.registration_end);
            if (rs != null && !Number.isNaN(rs) && now < rs) {
                    return res.status(400).json({
                        error: 'Registration for this seminar has not opened yet. Please wait until the scheduled registration date.'
                    });
            }
            if (re != null && !Number.isNaN(re) && now > re) {
                    return extModules.userHasRegistrationOverride(db, userId, seminarId, (ovErr, hasOverride) => {
                        if (ovErr) return res.status(500).json({ error: ovErr.message });
                        if (!hasOverride) {
                return res.status(400).json({ error: 'Registration for this seminar has closed.' });
                        }
                        continueApplicationSubmit();
                    });
                } else {
                    continueApplicationSubmit();
            }

                function continueApplicationSubmit() {
            persistUploadedCertificate(req, (certErr, certPath) => {
                if (certErr) return res.status(500).json({ error: certErr.message });
                if (certPath) {
                    formData = formData || {};
                    formData.certificate_path = certPath;
                }

                loadRegistrationFormConfig(seminarId, (cfgErr, regFields) => {
                    if (cfgErr) return res.status(500).json({ error: cfgErr.message });
                    const list = regFields || [];
                    const hasCertFile =
                        !!req.file || !!(formData && formData.certificate_path);
                    const validationError = validateFormDataAgainstRegistrationConfig(
                        formData || {},
                        hasCertFile,
                        list
                    );
                    if (validationError) {
                        return res.status(400).json({ error: validationError });
                    }

                    const sidNum = parseInt(seminarId, 10);
                    const otpApp = !!(sem && Number(sem.otp_on_application) === 1);
                    const skipFieldKeys = otpApp ? ['email', 'phone'] : [];

                    function runFieldOtpsThenInsert() {
                        otpLib.validateAllFieldOtpTokens(
                            db,
                            sidNum,
                            fieldOtpTokensObj,
                            list,
                            (ferr, fv) => {
                                if (ferr) return res.status(500).json({ error: ferr.message });
                                if (!fv || !fv.ok) {
                                    return res.status(400).json({ error: (fv && fv.error) || 'Field OTP verification failed' });
                                }
                                insertRegistration();
                            },
                            { skipFieldKeys }
                        );
                    }

                    function insertRegistration() {
                        const applicationNo = generateId();
                        const stored = sanitizeFormDataForStorage(formData || {});
                        db.run(
                            `INSERT INTO registrations (user_id, seminar_id, application_no, status, form_data) VALUES (?, ?, ?, 'submitted', ?)`,
                            [userId, seminarId, applicationNo, JSON.stringify(stored)],
                function (err3) {
                    if (err3) return res.status(500).json({ error: err3.message });
                                const newId = this.lastID;
                                portalTracking.logRegistrationEvent(
                                    db,
                                    newId,
                                    'submitted',
                                    'Application submitted',
                                    'Registration received.',
                                    () => {}
                                );
                                const seminarTitle = sem.title || 'Seminar';
                                db.get(
                                    `SELECT first_name, last_name, email, phone FROM users WHERE id = ?`,
                                    [userId],
                                    (uerr, urow) => {
                                        const uname = urow ? `${urow.first_name || ''} ${urow.last_name || ''}`.trim() : '';
                                        enqueueApplicationSubmitted(db, {
                                            userId,
                                            seminarId,
                                            registrationId: newId
                                        });
                                        notifEngine.notify(db, 'SEMINAR_REGISTRATION_SUCCESS', {
                                    userId,
                                    seminarId,
                                    registrationId: newId,
                                    vars: { approval_status: 'submitted' }
                                });
                                res.json({ success: true, applicationId: newId, applicationNo });
                                    }
                                );
                            }
                        );
                    }

                    if (otpApp) {
                        integrationSettings.ensureIntegrationSettingsLoaded(db, () => {
                            const needEmail = integrationSettings.isEmailConfiguredFromSettings();
                            const needPhone = integrationSettings.isWhatsAppConfiguredFromSettings();
                            if (!needEmail && !needPhone) {
                                return runFieldOtpsThenInsert();
                            }
                            if (needEmail && !emailOtpToken) {
                                return res.status(400).json({
                                    error: 'Verify your email with the code sent to your inbox before submitting.'
                                });
                            }
                            if (needPhone && !phoneOtpToken) {
                                return res.status(400).json({
                                    error: 'Verify your phone with the WhatsApp code before submitting.'
                                });
                            }
                            otpLib.validateRegistrationOtpTokens(
                                db,
                                sidNum,
                                {
                                    phoneToken: needPhone ? phoneOtpToken : null,
                                    emailToken: needEmail ? emailOtpToken : null
                                },
                                (oerr, ov) => {
                                    if (oerr) return res.status(500).json({ error: oerr.message });
                                    if (!ov || !ov.ok) {
                                        return res.status(400).json({
                                            error: (ov && ov.error) || 'OTP verification failed'
                                        });
                                    }
                                    runFieldOtpsThenInsert();
                                }
                            );
                        });
                        return;
                    }
                    runFieldOtpsThenInsert();
                });
            });
                }
            }
        );
    });
});

// 5b. Get Applications for User
app.get('/api/applications/:userId', (req, res) => {
    const uid = parsePositiveUserId(req.params.userId);
    if (!uid) return res.status(400).json({ error: 'Invalid user id' });
    const yearFilter = req.query && req.query.year != null ? parseInt(req.query.year, 10) : null;
    respondApplicationsList(uid, yearFilter, res);
});
// 5c. Edit Application
app.put('/api/applications/:applicationId', upload.single('certificate'), (req, res) => {
    let { formData, phoneOtpToken, emailOtpToken, fieldOtpTokens } = req.body;
    
    if (typeof formData === 'string') {
        try {
            formData = JSON.parse(formData);
        } catch (e) {}
    }
    const fieldOtpTokensObj = parseMaybeJson(fieldOtpTokens) || (fieldOtpTokens && typeof fieldOtpTokens === 'object' ? fieldOtpTokens : {});
    
    if (req.file) {
        formData = formData || {};
        formData.certificate_path = req.file.filename;
    }
    
    db.get(
        `SELECT r.user_id, r.seminar_id, r.status, r.form_data, IFNULL(s.otp_on_application, 0) AS otp_on_application
         FROM registrations r
         LEFT JOIN seminars s ON s.id = r.seminar_id
         WHERE r.id = ?`,
        [req.params.applicationId],
        (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Application not found' });
        
            const st = String(row.status || '').toLowerCase();
            if (st !== 'submitted' && st !== 'pending_approval') {
                return res.status(400).json({
                    error: 'This application can no longer be edited after it has moved forward in the workflow.'
                });
            }

            let prev = {};
            try {
                prev = JSON.parse(row.form_data || '{}');
            } catch (_) {
                prev = {};
            }
            const merged = { ...prev, ...(formData || {}) };
            const hasCert = !!req.file || !!merged.certificate_path;

            loadRegistrationFormConfig(row.seminar_id, (cfgErr, regFields) => {
                if (cfgErr) return res.status(500).json({ error: cfgErr.message });
                const list = regFields || [];
                const validationError = validateFormDataAgainstRegistrationConfig(merged, hasCert, list);
                if (validationError) {
                    return res.status(400).json({ error: validationError });
                }

                const sidNum = parseInt(row.seminar_id, 10);
                const otpApp = !!Number(row.otp_on_application);
                const skipFieldKeys = otpApp ? ['email', 'phone'] : [];

                function persistUpdate() {
                    const mergedStored = sanitizeFormDataForStorage(merged);
        const changes = JSON.stringify({
            old: row.form_data,
                        new: mergedStored,
            timestamp: new Date().toISOString()
        });
        
                    db.run(
                        `INSERT INTO application_edits (application_id, edited_by_user_id, changes) VALUES (?, ?, ?)`,
                        [req.params.applicationId, row.user_id, changes],
                        (editErr) => {
                if (editErr) console.error('Edit history error:', editErr.message);
                        }
                    );

                    db.run(
                        `UPDATE registrations SET form_data = ? WHERE id = ?`,
                        [JSON.stringify(mergedStored), req.params.applicationId],
                        function (err2) {
                            if (err2) return res.status(500).json({ error: err2.message });
                            res.json({ success: true, message: 'Application updated successfully' });
                        }
                    );
                }

                function runFieldOtps() {
                    otpLib.validateAllFieldOtpTokens(
                        db,
                        sidNum,
                        fieldOtpTokensObj,
                        list,
                        (ferr, fv) => {
                            if (ferr) return res.status(500).json({ error: ferr.message });
                            if (!fv || !fv.ok) {
                                return res.status(400).json({ error: (fv && fv.error) || 'Field OTP verification failed' });
                            }
                            persistUpdate();
                        },
                        { skipFieldKeys }
                    );
                }

                if (otpApp) {
                    if (!phoneOtpToken || !emailOtpToken) {
                        return res.status(400).json({
                            error: 'This seminar requires phone and email OTP verification when saving changes.'
                        });
                    }
                    otpLib.validateRegistrationOtpTokens(
                        db,
                        sidNum,
                        { phoneToken: phoneOtpToken, emailToken: emailOtpToken },
                        (oerr, ov) => {
                            if (oerr) return res.status(500).json({ error: oerr.message });
                            if (!ov || !ov.ok) {
                                return res.status(400).json({ error: (ov && ov.error) || 'OTP verification failed' });
                            }
                            runFieldOtps();
                        }
                    );
                    return;
                }
                runFieldOtps();
            });
        }
    );
});

// 5d. Cancel application (optional automated refund by cancellation policy)
app.post('/api/applications/:applicationId/cancel', (req, res) => {
    const applicationId = parseInt(req.params.applicationId, 10);
    const userId = parseInt((req.body && req.body.userId) || '', 10);
    if (Number.isNaN(applicationId) || applicationId < 1 || Number.isNaN(userId) || userId < 1) {
        return res.status(400).json({ error: 'Valid applicationId and userId are required.' });
    }

    db.get(
        `SELECT r.id, r.user_id, r.status, r.application_no,
                s.title AS seminar_title, s.event_date, s.cancellation_policy_json,
                u.email AS user_email
         FROM registrations r
         JOIN seminars s ON s.id = r.seminar_id
         JOIN users u ON u.id = r.user_id
         WHERE r.id = ?`,
        [applicationId],
        (err, reg) => {
                if (err) return res.status(500).json({ error: err.message });
            if (!reg) return res.status(404).json({ error: 'Application not found.' });
            if (Number(reg.user_id) !== userId) {
                return res.status(403).json({ error: 'You can only cancel your own applications.' });
            }

            const st = String(reg.status || '').toLowerCase();
            if (st === 'cancelled') return res.status(400).json({ error: 'This application is already cancelled.' });
            if (st === 'rejected') return res.status(400).json({ error: 'Rejected applications cannot be cancelled here.' });
            if (!isBeforeSeminarDay(reg.event_date)) {
                return res.status(400).json({
                    error: 'Cancellation is only allowed before the seminar day. Contact support if you need help.'
                });
            }

            db.get(
                `SELECT * FROM orders WHERE registration_id = ? AND status = 'success' ORDER BY id DESC LIMIT 1`,
                [applicationId],
                (oerr, order) => {
                    if (oerr) return res.status(500).json({ error: oerr.message });

                    const hadPaidOrder = !!order;
                    let policy = {};
                    try {
                        policy = reg.cancellation_policy_json
                            ? JSON.parse(reg.cancellation_policy_json)
                            : {};
                    } catch (_) {
                        policy = {};
                    }
                    const refundCalc = refundLib.computeRefundPercent(policy, reg.event_date);
                    const refundPercent = hadPaidOrder ? refundCalc.percent : 0;
                    const refundAmount =
                        hadPaidOrder && order && order.amount
                            ? Math.round((Number(order.amount) * refundPercent) / 100 * 100) / 100
                            : 0;
                    const refundReason = hadPaidOrder
                        ? `Policy: ${refundCalc.reason}. ${refundPercent}% refund (${refundAmount > 0 ? '₹' + refundAmount : '₹0'}) — automated gateway refund is not wired yet.`
                        : 'No payment recorded for this application.';

                    function markCancelled(extra) {
                        invalidateTicketsForRegistration(applicationId, (invErr) => {
                            if (invErr) return res.status(500).json({ error: invErr.message });
                            db.run(`UPDATE registrations SET status = 'cancelled' WHERE id = ?`, [applicationId], (uerr) => {
                                if (uerr) return res.status(500).json({ error: uerr.message });
                                db.run(
                                    `UPDATE user_certificates SET enabled = 0, updated_at = CURRENT_TIMESTAMP
                                     WHERE registration_id = ?`,
                                    [applicationId],
                                    () => {}
                                );
                                if (jobsModule && jobsModule.enqueue && reg.user_email) {
                                    const title = reg.seminar_title || 'Seminar';
                                    const text = `Your application ${reg.application_no} for "${title}" has been cancelled.${extra ? '\n\n' + extra : ''}\n\n— Vaidya Gogate Memorial Foundation`;
                                    jobsModule.enqueue(
                                        db,
                                        {
                                            channel: 'email',
                                            destination: reg.user_email,
                                            template_key: 'application_cancelled',
                                            payload: { subject: `Cancelled: ${title}`, text },
                                            scheduled_at: new Date().toISOString()
                                        },
                                        () => {}
                                    );
                                }
                                res.json({
                                    success: true,
                                    refundPercent,
                                    refundReason,
                                    refundAmount,
                                    ticketsInvalidated: true,
                                    detail: extra || null
                                });
                            });
                        });
                    }

                    const cancelDetail = hadPaidOrder
                        ? `Your registration is cancelled. ${refundReason} Your e-ticket QR code is no longer valid for entry.`
                        : 'Your registration is cancelled. Your e-ticket (if any) is no longer valid for entry.';
                    return markCancelled(cancelDetail);
                }
            );
        }
    );
});

// 6. Doctor Profile Management
// Create or update doctor profile
app.post('/api/doctor/profile', upload.single('profilePhoto'), (req, res) => {
    const { userId, specialization, registration_no, qualifications, experience_years, hospital_name, contact_number, bio } = req.body;
    
    const profilePhoto = req.file ? req.file.filename : null;
    
    // Check if profile exists
    db.get(`SELECT id FROM doctor_profile WHERE user_id = ?`, [userId], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        
        if (row) {
            // Update existing profile
            db.run(`UPDATE doctor_profile SET specialization=?, registration_no=?, qualifications=?, experience_years=?, hospital_name=?, contact_number=?, bio=?, profile_photo_path=?, updated_at=CURRENT_TIMESTAMP WHERE user_id=?`,
                [specialization, registration_no, qualifications, experience_years || 0, hospital_name, contact_number, bio, profilePhoto || null, userId],
                function(err) {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ success: true, message: 'Profile updated successfully' });
                });
        } else {
            // Create new profile
            db.run(`INSERT INTO doctor_profile (user_id, specialization, registration_no, qualifications, experience_years, hospital_name, contact_number, bio, profile_photo_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [userId, specialization, registration_no, qualifications, experience_years || 0, hospital_name, contact_number, bio, profilePhoto || null],
                function(err) {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ success: true, message: 'Profile created successfully', profileId: this.lastID });
                });
        }
    });
});

// Get doctor profile
app.get('/api/doctor/profile/:userId', (req, res) => {
    db.get(`SELECT * FROM doctor_profile WHERE user_id = ?`, [req.params.userId], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row || {});
    });
});

// Doctor dashboard statistics
app.get('/api/doctor/dashboard-stats/:userId', (req, res) => {
    const uid = parseInt(req.params.userId, 10);
    if (Number.isNaN(uid)) return res.status(400).json({ error: 'Invalid user' });
    const sql = `
        SELECT
            (SELECT COUNT(*) FROM registrations WHERE user_id = ? AND IFNULL(status,'') NOT IN ('rejected','cancelled')) AS registered_seminars,
            (SELECT COUNT(*) FROM registrations WHERE user_id = ? AND status IN ('completed','checked_in')) AS paid_or_confirmed,
            (SELECT COUNT(*) FROM registrations WHERE user_id = ? AND status = 'checked_in') AS checked_in_seminars,
            (SELECT COUNT(*) FROM seminar_feedback WHERE user_id = ?) AS feedback_submitted,
            (SELECT COUNT(*) FROM abstracts WHERE user_id = ?) AS abstracts_submitted,
            (SELECT COUNT(*) FROM support_tickets WHERE user_id = ?) AS support_tickets,
            (SELECT COUNT(*) FROM tickets t JOIN orders o ON t.order_id = o.id JOIN registrations r ON o.registration_id = r.id WHERE r.user_id = ?) AS participant_tickets
    `;
    db.get(sql, [uid, uid, uid, uid, uid, uid, uid], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row || {});
    });
});

// Doctor orders (payments linked to their registrations)
app.get('/api/doctor/orders/:userId', (req, res) => {
    const uid = parseInt(req.params.userId, 10);
    if (Number.isNaN(uid)) return res.status(400).json({ error: 'Invalid user' });
    db.all(
        `SELECT o.id, o.order_id_string, o.amount, o.status, o.payment_date,
                o.payment_gateway, o.provider_order_id, o.provider_transaction_id,
                r.application_no, r.status as registration_status, s.title as seminar_title,
                t.ticket_id_string AS e_ticket_id,
                u.user_id_string, u.email AS user_email, u.phone AS user_phone,
                u.first_name, u.middle_name, u.last_name
         FROM orders o
         JOIN registrations r ON o.registration_id = r.id
         JOIN users u ON r.user_id = u.id
         LEFT JOIN seminars s ON r.seminar_id = s.id
         LEFT JOIN tickets t ON t.order_id = o.id
         WHERE r.user_id = ?
         ORDER BY o.id DESC`,
        [uid],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        }
    );
});

// Doctor participant / QR event tickets
app.get('/api/doctor/event-tickets/:userId', (req, res) => {
    const uid = parseInt(req.params.userId, 10);
    if (Number.isNaN(uid)) return res.status(400).json({ error: 'Invalid user' });
    db.all(
        `SELECT t.id as ticket_row_id, t.ticket_id_string, t.qr_code_data, t.is_scanned, t.scan_time, IFNULL(t.is_valid, 1) AS is_valid,
                o.order_id_string, o.amount, o.status as order_status, o.payment_date,
                r.application_no, r.status as registration_status, s.title as seminar_title, s.id as seminar_id
         FROM tickets t
         JOIN orders o ON t.order_id = o.id
         JOIN registrations r ON o.registration_id = r.id
         LEFT JOIN seminars s ON r.seminar_id = s.id
         WHERE r.user_id = ?
         ORDER BY t.id DESC`,
        [uid],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        }
    );
});

// Change password (doctor portal)
app.post('/api/auth/change-password', (req, res) => {
    const { userId, currentPassword, newPassword } = req.body;
    const uid = parseInt(userId, 10);
    if (Number.isNaN(uid) || !newPassword || String(newPassword).length < 4) {
        return res.status(400).json({ error: 'Invalid request. New password must be at least 4 characters.' });
    }
    db.get(`SELECT id FROM users WHERE id = ? AND password = ?`, [uid, currentPassword], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(401).json({ error: 'Current password is incorrect.' });
        db.run(`UPDATE users SET password = ? WHERE id = ?`, [newPassword, uid], function (e2) {
            if (e2) return res.status(500).json({ error: e2.message });
            res.json({ success: true, message: 'Password updated successfully.' });
        });
    });
});

// Forgot password — email + WhatsApp (no plain password stored)
app.post('/api/auth/forgot-password', (req, res) => {
    const emailNorm = String((req.body && req.body.email) || '')
        .trim()
        .toLowerCase();
    if (!emailNorm) return res.status(400).json({ error: 'Email is required' });
    const respond = () => res.json({ success: true, message: 'If an account exists, reset instructions were sent.' });
    db.get(`SELECT id FROM users WHERE lower(trim(email)) = ? AND IFNULL(is_disabled,0) = 0`, [emailNorm], (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user) return respond();
        const token = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        db.run(`UPDATE password_reset_tokens SET used = 1 WHERE user_id = ? AND used = 0`, [user.id], () => {
            db.run(
                `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)`,
                [user.id, tokenHash, expiresAt],
                (ierr) => {
                    if (ierr) return respond();
                    const link =
                        notifEngine.publicBaseUrl() + '/index.html?resetToken=' + encodeURIComponent(token);
                    notifEngine.notify(db, 'FORGOT_PASSWORD', {
                        userId: user.id,
                        vars: { forgot_password_link: link }
                    });
                    respond();
                }
            );
        });
    });
});

app.post('/api/auth/reset-password', (req, res) => {
    const token = String((req.body && req.body.token) || '').trim();
    const newPassword = req.body && req.body.newPassword != null ? String(req.body.newPassword) : '';
    if (!token || newPassword.length < 4) {
        return res.status(400).json({ error: 'Valid token and new password (min 4 chars) required' });
    }
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    db.get(
        `SELECT id, user_id FROM password_reset_tokens WHERE token_hash = ? AND used = 0 AND expires_at > datetime('now')`,
        [tokenHash],
        (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!row) return res.status(400).json({ error: 'Invalid or expired reset link' });
            db.run(`UPDATE users SET password = ? WHERE id = ?`, [newPassword, row.user_id], function (uerr) {
                if (uerr) return res.status(500).json({ error: uerr.message });
                db.run(`UPDATE password_reset_tokens SET used = 1 WHERE id = ?`, [row.id], () => {
                    res.json({ success: true, message: 'Password updated. You can log in now.' });
                });
            });
        }
    );
});

// Meta WhatsApp webhook verification (https://developers.facebook.com/docs/whatsapp/cloud-api)
app.get('/api/webhooks/whatsapp', withIntegrationSettingsLoaded, (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const expected =
        integrationSettings.getWhatsAppConfig().verifyToken || process.env.WHATSAPP_VERIFY_TOKEN || '';
    if (mode === 'subscribe' && token && expected && token === expected) {
        return res.status(200).send(challenge);
    }
    res.sendStatus(403);
});

// Support Ticket Route (Create Ticket)
app.post('/api/support/ticket', (req, res) => {
    const { userId, subject, message } = req.body;
    const trackingId = generateId(); // 12-digit tracking id
    
    db.run(`INSERT INTO support_tickets (tracking_id, user_id, subject, status) VALUES (?, ?, ?, 'Open')`,
        [trackingId, userId, subject],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            const ticketId = this.lastID;
            
            db.run(`INSERT INTO support_messages (ticket_id, sender, message) VALUES (?, 'doctor', ?)`,
                [ticketId, message],
                function (err2) {
                    if (err2) return res.status(500).json({ error: err2.message });
                    res.json({ success: true, trackingId: trackingId, message: "Ticket raised successfully." });
                });
        });
});

// Get User's Tickets
app.get('/api/support/tickets/:userId', (req, res) => {
    db.all(`SELECT * FROM support_tickets WHERE user_id = ? ORDER BY created_at DESC`, [req.params.userId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// Get Messages for a Ticket
app.get('/api/support/ticket/:trackingId/messages', (req, res) => {
    db.get(`SELECT id FROM support_tickets WHERE tracking_id = ?`, [req.params.trackingId], (err, ticket) => {
        if (err || !ticket) return res.status(404).json({ error: 'Ticket not found' });
        db.all(`SELECT * FROM support_messages WHERE ticket_id = ? ORDER BY created_at ASC`, [ticket.id], (err2, msgs) => {
            if (err2) return res.status(500).json({ error: err2.message });
            res.json(msgs || []);
        });
    });
});

// Reply to a Ticket
app.post('/api/support/ticket/:trackingId/reply', (req, res) => {
    const { message, sender } = req.body; // sender: 'doctor' or 'admin'
    db.get(`SELECT id FROM support_tickets WHERE tracking_id = ?`, [req.params.trackingId], (err, ticket) => {
        if (err || !ticket) return res.status(404).json({ error: 'Ticket not found' });
        db.run(`INSERT INTO support_messages (ticket_id, sender, message) VALUES (?, ?, ?)`,
            [ticket.id, sender, message],
            function (err2) {
                if (err2) return res.status(500).json({ error: err2.message });
                res.json({ success: true, message: "Reply sent." });
            });
    });
});

// Notices / Announcements
app.get('/api/notices', (req, res) => {
    db.all(`SELECT * FROM notices ORDER BY created_at DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

app.get('/api/payments/options', (req, res) => {
    listDoctorPaymentOptions((err, options) => {
        if (err) {
            const msg = String(err.message || err);
            if (/does not exist/i.test(msg) && pgDb && pgDb.ensureAuxiliaryTables) {
                return pgDb
                    .ensureAuxiliaryTables()
                    .then(() => {
                        listDoctorPaymentOptions((err2, opts2) => {
                            if (err2) {
                                return res.status(500).json({ success: false, error: err2.message });
                            }
                            res.json({
                                success: true,
                                options: (opts2 || []).map((o) => ({
                                    id: o.id,
                                    gateway: o.gateway,
                                    mode: o.mode,
                                    label: o.label
                                })),
                                mockAvailable: !(opts2 && opts2.length)
                            });
                        });
                    })
                    .catch((e2) => res.status(500).json({ success: false, error: e2.message }));
            }
            return res.status(500).json({ success: false, error: msg });
        }
        res.json({
            success: true,
            options: (options || []).map((o) => ({
                id: o.id,
                gateway: o.gateway,
                mode: o.mode,
                label: o.label
            })),
            mockAvailable: !(options && options.length)
        });
    });
});

// 6. Payments: Process Payment (Dynamic Gateway)
app.post('/api/payments/process', (req, res) => {
    const { registrationId, amount, userId, paymentOption } = req.body;
    const regId = parseInt(registrationId, 10);
    const uid = parseInt(userId, 10);
    if (Number.isNaN(regId) || regId < 1) {
        return res.status(400).json({
            success: false,
            error: 'Invalid registration id. Open “My Applications”, refresh the page, and use the Pay button again (do not bookmark an old payment link).'
        });
    }
    if (Number.isNaN(uid) || uid < 1) {
        return res.status(400).json({ success: false, error: 'Invalid user. Please log in again.' });
    }

    db.get(`SELECT id, user_id, status FROM registrations WHERE id = ?`, [regId], (eReg, reg) => {
        if (eReg) return res.status(500).json({ success: false, error: eReg.message });
        if (!reg) return res.status(404).json({ success: false, error: 'Registration not found.' });
        if (Number(reg.user_id) !== uid) {
            return res.status(403).json({ success: false, error: 'This registration does not belong to your account.' });
        }
        const regStatus = String(reg.status || '').toLowerCase();
        if (regStatus === 'rejected' || regStatus === 'cancelled') {
            return res.status(403).json({
                success: false,
                error: 'Payment is not available for rejected or cancelled applications.'
            });
        }
        if (regStatus === 'completed' || regStatus === 'checked_in') {
            return res.status(400).json({ success: false, error: 'Payment is already completed for this application.' });
        }
        if (regStatus !== 'approved_pending_payment') {
            return res.status(403).json({
                success: false,
                error: 'Payment opens after admin approval. Current status: ' + (reg.status || 'unknown') + '.'
            });
        }

    const orderIdStr = 'ORD_' + generateId();

        const startPayment = (gateway) => {
        if (!gateway) {
                const mockTxn = 'MOCK' + generateId();
                db.run(
                    `INSERT INTO orders (order_id_string, registration_id, amount, status, payment_date, payment_gateway, provider_transaction_id) VALUES (?, ?, ?, 'success', CURRENT_TIMESTAMP, 'mock', ?)`,
                    [orderIdStr, regId, amount, mockTxn],
                function (err) {
                        if (err) return res.status(500).json({ success: false, error: err.message });
                    
                    const newOrderId = this.lastID;

                        db.run(`UPDATE registrations SET status = 'completed' WHERE id = ?`, [regId]);
                        db.get(`SELECT application_no FROM registrations WHERE id = ?`, [regId], (gErr, regRow) => {
                            if (gErr) return res.status(500).json({ success: false, error: gErr.message });
                            insertParticipantTicket(newOrderId, uid, orderIdStr, regId, regRow && regRow.application_no, (err, _etk, _qr, meta) => {
                                if (err) return res.status(500).json({ success: false, error: err.message });
                                const msg = meta && meta.skipped
                                    ? 'Payment recorded. No e-ticket was issued because this registration is not eligible.'
                                    : 'Payment successful, e-ticket generated.';
                                res.json({
                                    success: true,
                                    orderId: orderIdStr,
                                    gateway: 'mock',
                                    message: msg,
                                    transactionId: mockTxn,
                                    eTicketSkipped: !!(meta && meta.skipped)
                        });
                });
                        });
                    }
                );
            return;
        }

        if (gateway.name === 'razorpay') {
            const razorpay = new Razorpay({
                key_id: gateway.config.key_id,
                    key_secret: gateway.config.key_secret
            });
            const options = {
                    amount: amount * 100,
                currency: 'INR',
                    receipt: orderIdStr.length > 40 ? orderIdStr.slice(0, 40) : orderIdStr
                };
                const gwTag =
                    gateway.mode === 'live' ? 'razorpay_live' : gateway.mode === 'test' ? 'razorpay_test' : 'razorpay';
                db.run(
                    `INSERT INTO orders (order_id_string, registration_id, amount, status, payment_gateway) VALUES (?, ?, ?, 'pending', ?)`,
                    [orderIdStr, regId, amount, gwTag],
                    function (insErr) {
                        if (insErr) return res.status(500).json({ success: false, error: insErr.message });
                        const localOrderId = this.lastID;
                        razorpay.orders.create(options, (err, rzOrder) => {
                            if (err) {
                                db.run(`DELETE FROM orders WHERE id = ? AND status = 'pending'`, [localOrderId]);
                                return res.status(500).json({
                                    success: false,
                                    error: err.message || 'Razorpay order could not be created. Check Admin payment keys.'
                                });
                            }
                            db.run(`UPDATE orders SET provider_order_id = ? WHERE id = ?`, [rzOrder.id, localOrderId], (uErr) => {
                                if (uErr) return res.status(500).json({ success: false, error: uErr.message });
                                res.json({
                                    success: true,
                                    order: rzOrder,
                                    keyId: gateway.config.key_id,
                                    gateway: 'razorpay',
                                    mode: gateway.mode,
                                    paymentOption: paymentOption || gateway.mode
                                });
                            });
                        });
                    }
                );
        } else if (gateway.name === 'payu') {
            res.json({ success: true, message: 'PayU integration pending', gateway: 'payu' });
        } else if (gateway.name === 'easebuzz') {
            res.json({ success: true, message: 'Easebuzz integration pending', gateway: 'easebuzz' });
        } else if (gateway.name === 'paytm') {
            res.json({ success: true, message: 'Paytm integration pending', gateway: 'paytm' });
        } else if (gateway.name === 'phonepe') {
            res.json({ success: true, message: 'PhonePe integration pending', gateway: 'phonepe' });
        } else if (gateway.name === 'cashfree') {
            res.json({ success: true, message: 'Cashfree integration pending', gateway: 'cashfree' });
        } else {
                res.status(400).json({ success: false, error: 'Unsupported gateway' });
            }
        };

        if (paymentOption) {
            resolveDoctorPaymentOption(paymentOption, (eGw, gateway) => {
                if (eGw) return res.status(500).json({ success: false, error: eGw.message });
                if (!gateway) {
                    return res.status(400).json({
                        success: false,
                        error: 'Selected payment method is not available. Refresh the page and choose another option.'
                    });
                }
                startPayment(gateway);
            });
        } else {
            listDoctorPaymentOptions((eList, options) => {
                if (eList) return res.status(500).json({ success: false, error: eList.message });
                if (options && options.length === 1) {
                    return startPayment({
                        name: options[0].gateway,
                        mode: options[0].mode,
                        config: options[0].config
                    });
                }
                if (options && options.length > 1) {
                    return res.status(400).json({
                        success: false,
                        error: 'Choose a payment method from the dropdown before paying.',
                        options: options.map((o) => ({ id: o.id, label: o.label }))
                    });
                }
                startPayment(null);
            });
        }
    });
});

const SCANNER_TICKET_LOOKUP_SQL = `
        SELECT t.id AS ticket_id, t.is_scanned, t.ticket_id_string, IFNULL(t.is_valid, 1) AS is_valid,
               t.qr_code_data,
               s.id AS seminar_id, s.checkin_enabled, s.checkin_date, s.title AS seminar_title,
               u.id AS doctor_user_id, u.user_id_string AS doctor_user_id_string,
               u.first_name AS doctor_first_name, u.last_name AS doctor_last_name, u.email AS doctor_email, u.phone AS doctor_phone,
               r.id AS registration_id, r.application_no, r.form_data, r.status AS registration_status, o.status AS payment_status
        FROM tickets t
        JOIN orders o ON t.order_id = o.id
        JOIN registrations r ON o.registration_id = r.id
        JOIN seminars s ON r.seminar_id = s.id
        JOIN users u ON t.user_id = u.id`;

function ticketLookupInvalid(row) {
    if (!row) return false;
    if (Number(row.is_valid) === 0 || row.is_valid === false) return true;
    const regSt = String(row.registration_status || '').toLowerCase();
    return regSt === 'cancelled' || regSt === 'rejected';
}

function lookupTicketForScan(qrData, cb) {
    const raw = String(qrData || '').trim();
    if (!raw) return cb(null, null);

    const strategies = [];
    const seen = new Set();
    const add = (clause, param) => {
        const key = clause + '\0' + String(param);
        if (seen.has(key)) return;
        seen.add(key);
        strategies.push([clause, param]);
    };

    add('t.qr_code_data = ?', raw);
    add('TRIM(t.ticket_id_string) = ?', raw);
    add('LOWER(TRIM(t.ticket_id_string)) = LOWER(?)', raw);
    add('o.order_id_string = ?', raw);
    add('r.application_no = ?', raw);

    let jsonTicketId = null;
    if (raw.startsWith('{')) {
        try {
            const j = JSON.parse(raw);
            if (j.ticketId) jsonTicketId = String(j.ticketId).trim();
        } catch (_) {
            /* ignore */
        }
    }

    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 10) {
        add('TRIM(t.ticket_id_string) = ?', digits);
        add('t.qr_code_data LIKE ?', `%"ticketId":"${digits}"%`);
        add('t.qr_code_data LIKE ?', `%"ticketId": "${digits}"%`);
    }
    if (jsonTicketId) {
        add('TRIM(t.ticket_id_string) = ?', jsonTicketId);
        add('t.qr_code_data LIKE ?', `%"ticketId":"${jsonTicketId}"%`);
        add('t.qr_code_data LIKE ?', `%"ticketId": "${jsonTicketId}"%`);
    }
    const numericId = /^\d{1,9}$/.test(digits) ? parseInt(digits, 10) : NaN;
    if (Number.isInteger(numericId) && numericId > 0) {
        add('t.id = ?', numericId);
    }

    let i = 0;
    const nextStrategy = () => {
        if (i >= strategies.length) return cb(null, null);
        const [clause, param] = strategies[i++];
        db.get(SCANNER_TICKET_LOOKUP_SQL + ' WHERE ' + clause, [param], (err, row) => {
            if (err) return cb(err);
            if (row) return cb(null, row);
            nextStrategy();
        });
    };
    nextStrategy();
}

// Scanner: dry-run ticket lookup (same matching as /mark, no state change)
app.get('/api/scanner/verify', (req, res) => {
    const ticketId = String(req.query.ticketId || req.query.qrData || '').trim();
    if (!ticketId) {
        return res.status(400).json({ success: false, error: 'ticketId query parameter is required.' });
    }
    lookupTicketForScan(ticketId, (err, row) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (!row) {
            return res.status(404).json({
                success: false,
                found: false,
                error: 'Ticket not found. Use the 12-digit E-ticket ID or scan the QR on the e-ticket.'
            });
        }
        res.json({
            success: true,
            found: true,
            ticketId: row.ticket_id_string,
            seminarId: row.seminar_id,
            seminarTitle: row.seminar_title,
            paymentStatus: row.payment_status,
            registrationStatus: row.registration_status,
            isScanned: !!row.is_scanned,
            invalid: ticketLookupInvalid(row),
            checkinEnabled: !!row.checkin_enabled,
            checkinDate: row.checkin_date
        });
    });
});

// Scanner: seminars with check-in enabled (pick before scanning)
app.get('/api/scanner/checkin-seminars', (req, res) => {
    db.all(
        `SELECT id, title, checkin_date, event_date, checkin_enabled
         FROM seminars WHERE is_active = 1 AND IFNULL(checkin_enabled, 0) = 1
         ORDER BY event_date ASC, title ASC`,
        [],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(
                (rows || []).map((r) => ({
                    id: r.id,
                    title: r.title,
                    checkinDate: r.checkin_date,
                    eventDate: r.event_date,
                    checkinOpenToday: isCheckinDateToday(r.checkin_date)
                }))
            );
        }
    );
});

// 8. Scanner: Mark Attendance (requires scanner or admin user id)
app.post('/api/scanner/mark', (req, res) => {
    const { qrData, volunteerId, scannerUserId, seminarId } = req.body || {};
    const selectedSeminarId = parseInt(seminarId, 10);
    const staffId = parseInt(scannerUserId != null ? scannerUserId : volunteerId, 10);
    if (!Number.isInteger(staffId) || staffId < 1) {
        return res.status(401).json({
            success: false,
            error: 'scannerUserId is required. Open the scanner from the portal after logging in with a scanner-role account.'
        });
    }

    db.get(
        `SELECT id, role, user_role FROM users WHERE id = ? AND IFNULL(is_disabled,0) = 0`,
        [staffId],
        (eu, staff) => {
            if (eu) return res.status(500).json({ success: false, error: eu.message });
            if (!staff) return res.status(401).json({ success: false, error: 'Invalid scanner user id' });
            const ur = String(staff.user_role || '').toLowerCase();
            const r = String(staff.role || '').toLowerCase();
            if (ur !== 'scanner_portal_user' && r !== 'admin') {
                return res.status(403).json({ success: false, error: 'This account is not permitted to scan tickets.' });
            }

            if (!Number.isInteger(selectedSeminarId) || selectedSeminarId < 1) {
                return res.status(400).json({
                    success: false,
                    error: 'Select the seminar you are checking in for before scanning.',
                    sound: 'error'
                });
            }

            lookupTicketForScan(qrData, (err, row) => {
                if (err) return res.status(500).json({ success: false, error: err.message });
                if (!row) {
                    return res.status(404).json({
                        success: false,
                        error: 'Ticket not found. Scan the QR on the e-ticket or enter the 12-digit E-ticket ID.',
                        sound: 'error'
                    });
                }

                const payOk = String(row.payment_status || '').toLowerCase() === 'success';
                if (!payOk) {
                    return res.status(403).json({
                        success: false,
                        error: 'Payment is not confirmed for this ticket.',
                        sound: 'error',
                        doctor: {
                            userId: row.doctor_user_id,
                            userIdString: row.doctor_user_id_string,
                            name: buildDisplayNameFromFormData(row.form_data, row),
                            applicationNo: row.application_no,
                            seminarTitle: row.seminar_title,
                            ticketId: row.ticket_id_string,
                            paymentStatus: 'UNPAID'
                        }
                    });
                }
                const regSt = String(row.registration_status || '').toLowerCase();
                if (regSt === 'cancelled' || regSt === 'rejected') {
                    return res.status(403).json({
                        success: false,
                        error:
                            regSt === 'cancelled'
                                ? 'Ticket invalid — registration was cancelled.'
                                : 'Ticket invalid — registration was rejected.',
                        doctor: {
                            userId: row.doctor_user_id,
                            userIdString: row.doctor_user_id_string,
                            name: buildDisplayNameFromFormData(row.form_data, row),
                            email: row.doctor_email,
                            phone: row.doctor_phone,
                            applicationNo: row.application_no
                        }
                    });
                }
                if (Number(row.is_valid) === 0 || row.is_valid === false) {
                    return res.status(403).json({
                        success: false,
                        error: 'Ticket is no longer valid (cancelled registration).',
                        doctor: {
                            userId: row.doctor_user_id,
                            userIdString: row.doctor_user_id_string,
                            name: buildDisplayNameFromFormData(row.form_data, row),
                            email: row.doctor_email,
                            phone: row.doctor_phone,
                            applicationNo: row.application_no
                        }
                    });
                }
                if (row.is_scanned) {
                    return res.status(400).json({
                        success: false,
                        error: 'Ticket already scanned!',
                        doctor: {
                            userId: row.doctor_user_id,
                            userIdString: row.doctor_user_id_string,
                            name: buildDisplayNameFromFormData(row.form_data, row),
                            email: row.doctor_email,
                            phone: row.doctor_phone,
                            applicationNo: row.application_no
                        }
                    });
                }

                const ticketSeminarId = Number(row.seminar_id);
                if (ticketSeminarId !== selectedSeminarId) {
                    return res.status(403).json({
                        success: false,
                        error: `Wrong seminar selected. This ticket is for "${row.seminar_title}". Choose that seminar in the dropdown, then scan again.`,
                        sound: 'wrong_seminar',
                        doctor: {
                            userId: row.doctor_user_id,
                            userIdString: row.doctor_user_id_string,
                            name: buildDisplayNameFromFormData(row.form_data, row),
                            seminarTitle: row.seminar_title,
                            ticketId: row.ticket_id_string,
                            applicationNo: row.application_no,
                            orderId: row.order_id_string
                        }
                    });
                }

                if (!row.checkin_enabled) {
                    return res.status(403).json({
                        success: false,
                        error: 'Check-in is currently disabled for this seminar.',
                        sound: 'error'
                    });
                }

                const allowAnyCheckinDate =
                    process.env.SCANNER_ALLOW_ANY_CHECKIN_DATE === '1' || r === 'admin';
                if (row.checkin_date && !isCheckinDateToday(row.checkin_date) && !allowAnyCheckinDate) {
                    const today = localDateYmd();
                    const expected = String(row.checkin_date).slice(0, 10);
                    return res.status(403).json({
                        success: false,
                        error: `Check-in date mismatch. This seminar allows check-in on ${expected} (today is ${today}). In Admin → Seminars, clear "Check-in date" for open check-in, or set it to today.`,
                        sound: 'wrong_date',
                        doctor: {
                            userId: row.doctor_user_id,
                            userIdString: row.doctor_user_id_string,
                            name: buildDisplayNameFromFormData(row.form_data, row),
                            applicationNo: row.application_no,
                            seminarTitle: row.seminar_title
                        }
                    });
                }

                db.run(
                    `UPDATE tickets SET is_scanned = 1, scan_time = CURRENT_TIMESTAMP, scanned_by = ? WHERE id = ?`,
                    [staffId, row.ticket_id],
                    function (err2) {
                        if (err2) return res.status(500).json({ success: false, error: err2.message });
                        syncCertificateEligibilityForTicket(row.ticket_id, () => {
                            const doctorName = buildDisplayNameFromFormData(row.form_data, {
                                first_name: row.doctor_first_name,
                                last_name: row.doctor_last_name
                            });
                            notifEngine.notify(db, 'CHECK_IN_SUCCESS', {
                                userId: row.doctor_user_id,
                                seminarId: row.seminar_id,
                                registrationId: row.registration_id || null,
                                vars: {
                                    ticket_id: row.ticket_id_string,
                                    payment_status: row.payment_status === 'success' ? 'PAID' : 'UNPAID',
                                    approval_status: row.registration_status
                                }
                            });

                            res.json({
                                success: true,
                                sound: 'success',
                                message: 'Attendance marked. Certificate unlocked if a template is configured for this seminar.',
                                doctor: {
                                    userId: row.doctor_user_id,
                                    userIdString: row.doctor_user_id_string,
                                    name: doctorName,
                                    email: row.doctor_email,
                                    phone: row.doctor_phone,
                                    applicationNo: row.application_no,
                                    seminarTitle: row.seminar_title,
                                    ticketId: row.ticket_id_string,
                                    registrationType: row.registration_status,
                                    paymentStatus: row.payment_status === 'success' ? 'PAID' : 'UNPAID',
                                    checkedInAt: new Date().toISOString()
                                },
                                scannedByStaffId: staffId
                            });
                        });
                    }
                );
            });
        }
    );
});

// 6. QR Code Generation
app.get('/api/qrcode/:text', async (req, res) => {
    try {
        const text = req.params.text;
        const qrCodeDataUrl = await QRCode.toDataURL(text);
        const base64Data = qrCodeDataUrl.replace(/^data:image\/png;base64,/, "");
        const img = Buffer.from(base64Data, 'base64');
        res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': img.length
        });
        res.end(img);
    } catch (err) {
        res.status(500).json({ error: 'Failed to generate QR Code' });
    }
});

// --- ADMIN APIs ---

// Admin: Create Seminar
app.post('/api/admin/seminars', (req, res) => {
    const {
        title,
        description,
        registration_start,
        registration_end,
        event_date,
        capacity,
        price,
        checkin_enabled,
        checkin_date,
        location_url,
        terms_conditions,
        hero_image_path,
        flyer_path,
        gallery_paths,
        registration_form_json,
        cancellation_policy_json,
        whatsapp_group_url,
        otp_on_application,
        public_list_enabled,
        is_active
    } = req.body;
    const rfj = registration_form_json != null && String(registration_form_json).trim() !== '' ? String(registration_form_json) : null;
    const cpj = cancellation_policy_json != null && String(cancellation_policy_json).trim() !== '' ? String(cancellation_policy_json) : null;
    const wu = whatsapp_group_url != null && String(whatsapp_group_url).trim() !== '' ? String(whatsapp_group_url).trim() : null;
    const otpApp = otp_on_application ? 1 : 0;
    const pubList = public_list_enabled ? 1 : 0;
    const activeFlag = is_active === false || is_active === 0 || is_active === '0' ? 0 : 1;
    const regStart = seminarDt.normalizeSeminarDateTimeForStorage(registration_start);
    const regEnd = seminarDt.normalizeSeminarDateTimeForStorage(registration_end);
    const eventDt = seminarDt.normalizeSeminarDateTimeForStorage(event_date);
    const bodyYear = req.body && req.body.portal_year != null ? parseInt(req.body.portal_year, 10) : null;
    portalTracking.getPortalYear(db, (ePy, defaultYear) => {
        const portalYear =
            Number.isInteger(bodyYear) && bodyYear > 2000 ? bodyYear : defaultYear;
        db.run(
            `INSERT INTO seminars (title, description, registration_start, registration_end, event_date, capacity, price, checkin_enabled, checkin_date, location_url, terms_conditions, hero_image_path, flyer_path, gallery_paths, registration_form_json, cancellation_policy_json, whatsapp_group_url, otp_on_application, public_list_enabled, portal_year, is_active) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                title,
                description,
                regStart,
                regEnd,
                eventDt,
                capacity,
                price || 0,
                checkin_enabled ? 1 : 0,
                checkin_date || null,
                location_url || null,
                terms_conditions || null,
                hero_image_path || null,
                flyer_path || null,
                gallery_paths || null,
                rfj,
                cpj,
                wu,
                otpApp,
                pubList,
                portalYear,
                activeFlag
            ],
            function (err) {
            if (err) return res.status(500).json({ error: err.message });
                const newId = this.lastID;
                syncSeminarCmsAfterSave(newId, true, () => {});
                res.json({ success: true, seminarId: newId });
            }
        );
        });
});

// Admin: Update Seminar
app.put('/api/admin/seminars/:id', (req, res) => {
    const {
        title,
        description,
        registration_start,
        registration_end,
        event_date,
        capacity,
        price,
        checkin_enabled,
        checkin_date,
        is_active,
        location_url,
        terms_conditions,
        hero_image_path,
        flyer_path,
        gallery_paths,
        registration_form_json,
        cancellation_policy_json,
        whatsapp_group_url,
        otp_on_application,
        public_list_enabled,
        portal_year
    } = req.body;
    const rfj = registration_form_json != null && String(registration_form_json).trim() !== '' ? String(registration_form_json) : null;
    const cpj = cancellation_policy_json != null && String(cancellation_policy_json).trim() !== '' ? String(cancellation_policy_json) : null;
    const wu = whatsapp_group_url != null && String(whatsapp_group_url).trim() !== '' ? String(whatsapp_group_url).trim() : null;
    const otpApp = otp_on_application ? 1 : 0;
    const pubList = public_list_enabled ? 1 : 0;
    const py = portal_year != null ? parseInt(portal_year, 10) : null;
    const regStart = seminarDt.normalizeSeminarDateTimeForStorage(registration_start);
    const regEnd = seminarDt.normalizeSeminarDateTimeForStorage(registration_end);
    const eventDt = seminarDt.normalizeSeminarDateTimeForStorage(event_date);
    portalTracking.getPortalYear(db, (ePy, defaultYear) => {
        if (ePy) return res.status(500).json({ error: ePy.message });
        const finalPortalYear = Number.isInteger(py) && py > 2000 ? py : defaultYear;
        db.run(
            `UPDATE seminars SET title=?, description=?, registration_start=?, registration_end=?, event_date=?, capacity=?, price=?, checkin_enabled=?, checkin_date=?, is_active=?, location_url=?, terms_conditions=?, hero_image_path=?, flyer_path=?, gallery_paths=?, registration_form_json=?, cancellation_policy_json=?, whatsapp_group_url=?, otp_on_application=?, public_list_enabled=?, portal_year=? WHERE id=?`,
            [
                title,
                description,
                regStart,
                regEnd,
                eventDt,
                capacity,
                price || 0,
                checkin_enabled ? 1 : 0,
                checkin_date || null,
                is_active ? 1 : 0,
                location_url || null,
                terms_conditions || null,
                hero_image_path != null ? hero_image_path : null,
                flyer_path != null ? flyer_path : null,
                gallery_paths != null ? gallery_paths : null,
                rfj,
                cpj,
                wu,
                otpApp,
                pubList,
                finalPortalYear,
                req.params.id
            ],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                syncSeminarCmsAfterSave(parseInt(req.params.id, 10), false, () => {});
                res.json({ success: true, portalYear: finalPortalYear });
            }
        );
    });
});

function deleteRegistrationCascade(registrationId, cb) {
    const rid = parseInt(registrationId, 10);
    if (!Number.isInteger(rid) || rid < 1) return cb(new Error('Invalid registration id'));
    db.run(`DELETE FROM registration_status_log WHERE registration_id = ?`, [rid], () => {
        db.run(`DELETE FROM registration_reminder_log WHERE registration_id = ?`, [rid], () => {
            db.run(`DELETE FROM user_certificates WHERE registration_id = ?`, [rid], () => {
                db.get(`SELECT id FROM orders WHERE registration_id = ?`, [rid], (e0, orderRow) => {
                    const finishOrders = () => {
                        db.run(`DELETE FROM orders WHERE registration_id = ?`, [rid], () => {
                            db.run(`DELETE FROM registrations WHERE id = ?`, [rid], function (e3) {
                                if (e3) return cb(e3);
                                cb(null, { deleted: this.changes > 0 });
                            });
                        });
                    };
                    if (e0 || !orderRow) return finishOrders();
                    db.run(`DELETE FROM tickets WHERE order_id = ?`, [orderRow.id], () => finishOrders());
                });
            });
        });
    });
}

app.delete('/api/admin/registrations/:id', (req, res) => {
    deleteRegistrationCascade(req.params.id, (err, result) => {
        if (err) return res.status(400).json({ error: err.message });
        if (!result || !result.deleted) return res.status(404).json({ error: 'Registration not found' });
        res.json({ success: true });
    });
});

app.delete('/api/admin/seminars/:id', (req, res) => {
    const sid = parseInt(req.params.id, 10);
    if (!Number.isInteger(sid) || sid < 1) return res.status(400).json({ error: 'Invalid seminar id' });
    const permanent = String((req.query && req.query.permanent) || '') === '1';
    db.get(`SELECT COUNT(*) AS c FROM registrations WHERE seminar_id = ?`, [sid], (e0, row) => {
        if (e0) return res.status(500).json({ error: e0.message });
        const regCount = row && row.c != null ? Number(row.c) : 0;
        if (regCount > 0 && !permanent) {
            db.run(`UPDATE seminars SET is_active = 0 WHERE id = ?`, [sid], function (e1) {
                if (e1) return res.status(500).json({ error: e1.message });
                if (!this.changes) return res.status(404).json({ error: 'Seminar not found' });
                res.json({
                    success: true,
                    deactivated: true,
                    message:
                        'Seminar has registrations — marked inactive instead of permanent delete. Use permanent=1 to force delete.'
                });
            });
            return;
        }
        const removeSeminar = () => {
            db.run(`DELETE FROM seminars WHERE id = ?`, [sid], function (eDel) {
                if (eDel) return res.status(500).json({ error: eDel.message });
                if (!this.changes) return res.status(404).json({ error: 'Seminar not found' });
                res.json({ success: true, deleted: true });
            });
        };
        if (regCount === 0) return removeSeminar();
        db.all(`SELECT id FROM registrations WHERE seminar_id = ?`, [sid], (e2, regs) => {
            if (e2) return res.status(500).json({ error: e2.message });
            let i = 0;
            const next = () => {
                if (i >= (regs || []).length) {
                    db.run(`DELETE FROM notices WHERE seminar_id = ?`, [sid], () => {
                        db.run(`DELETE FROM certificate_templates WHERE seminar_id = ?`, [sid], () => removeSeminar());
                    });
                    return;
                }
                deleteRegistrationCascade(regs[i].id, (e3) => {
                    if (e3) return res.status(500).json({ error: e3.message });
                    i++;
                    next();
                });
            };
            next();
        });
    });
});

// Admin: Set Countdown Active
app.post('/api/admin/seminars/:id/countdown', (req, res) => {
    db.run(`UPDATE seminars SET is_countdown_active = 0`, [], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        db.run(`UPDATE seminars SET is_countdown_active = 1 WHERE id = ?`, [req.params.id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
    });
});

// Admin: Get Seminar Stats
app.get('/api/admin/seminars/:id/stats', (req, res) => {
    const seminarId = req.params.id;
    const stats = {
        pending_apps: 0,
        approved_apps: 0,
        pending_payments: 0,
        completed_payments: 0,
        total_revenue: 0
    };

    db.all(`SELECT status FROM registrations WHERE seminar_id = ?`, [seminarId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        rows.forEach(r => {
            if (r.status === 'pending_approval' || r.status === 'submitted') stats.pending_apps++;
            if (r.status !== 'pending_approval' && r.status !== 'submitted' && r.status !== 'rejected') stats.approved_apps++;
        });

        db.all(`
            SELECT o.status, o.amount 
            FROM orders o 
            JOIN registrations r ON o.registration_id = r.id 
            WHERE r.seminar_id = ?
        `, [seminarId], (err, orders) => {
            if (err) return res.status(500).json({ error: err.message });
            orders.forEach(o => {
                if (o.status === 'pending') stats.pending_payments++;
                if (o.status === 'success') {
                    stats.completed_payments++;
                    stats.total_revenue += (o.amount || 0);
                }
            });
            res.json(stats);
        });
    });
});

// Admin: Add Notice
app.post('/api/admin/notices', upload.single('pdf'), (req, res) => {
    const { seminar_id, message } = req.body;
    const pdfPath = req.file ? req.file.filename : null;
    
    db.run(`INSERT INTO notices (seminar_id, message, pdf_path) VALUES (?, ?, ?)`,
        [seminar_id || null, message, pdfPath],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, noticeId: this.lastID });
        });
});

// Admin: Get Seminar Live Scans
app.get('/api/admin/seminars/:id/scans', (req, res) => {
    const query = `
        SELECT t.scan_time, t.ticket_id_string, t.scanned_by,
               u.user_id_string, u.first_name, u.last_name, u.email AS doctor_email,
               r.application_no,
               v.first_name as vol_first, v.last_name as vol_last, v.user_id_string AS scanner_user_id_string
        FROM tickets t
        JOIN users u ON t.user_id = u.id
        LEFT JOIN users v ON t.scanned_by = v.id
        JOIN orders o ON t.order_id = o.id
        JOIN registrations r ON o.registration_id = r.id
        WHERE r.seminar_id = ? AND t.is_scanned = 1
        ORDER BY t.scan_time DESC
    `;
    db.all(query, [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// Admin: Get applications for specific seminar
app.get('/api/admin/seminars/:id/applications', (req, res) => {
    const query = `
        SELECT a.id, a.application_no, a.status, a.form_data, a.created_at, u.first_name, u.last_name, u.user_id_string
        FROM registrations a
        JOIN users u ON a.user_id = u.id
        WHERE a.seminar_id = ?
        ORDER BY a.created_at DESC
    `;
    db.all(query, [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// Admin: Get all applications
app.get('/api/admin/applications', (req, res) => {
    db.all(`
        SELECT a.id, a.application_no, a.status, a.form_data, a.created_at, u.first_name, u.last_name, u.user_id_string
        FROM registrations a
        JOIN users u ON a.user_id = u.id
        ORDER BY a.created_at DESC
    `, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// Admin: Update Application Status
app.post('/api/admin/applications/status', (req, res) => {
    const { applicationId, status } = req.body;
    db.get(`SELECT status FROM registrations WHERE id = ?`, [applicationId], (e0, prevRow) => {
        if (e0) return res.status(500).json({ error: e0.message });
        const prevStatus = String((prevRow && prevRow.status) || '').toLowerCase();
        const fromRejectedOrCancelled = prevStatus === 'rejected' || prevStatus === 'cancelled';

    db.run(`UPDATE registrations SET status = ? WHERE id = ?`, [status, applicationId], function(err) {
        if (err) return res.status(500).json({ error: err.message });

            const newSt = String(status || '').toLowerCase();
            const logEntries = portalTracking.registrationStatusToLog(newSt, prevStatus);
            logEntries.forEach((entry) => {
                portalTracking.logRegistrationEvent(
                    db,
                    applicationId,
                    entry.key,
                    entry.label,
                    entry.message,
                    () => {}
                );
            });
            if (newSt === 'cancelled' || newSt === 'rejected') {
                invalidateTicketsForRegistration(applicationId, () => {});
                if (newSt === 'cancelled') {
                    db.run(
                        `UPDATE user_certificates SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE registration_id = ?`,
                        [applicationId],
                        () => {}
                    );
                }
            }

            db.get(`SELECT user_id, seminar_id FROM registrations WHERE id = ?`, [applicationId], (eN, regRow) => {
                if (!eN && regRow) {
                    let ev = 'APPLICATION_UNDER_REVIEW';
                    if (newSt === 'approved_pending_payment' || newSt === 'completed') ev = 'APPLICATION_APPROVED';
                    else if (newSt === 'rejected') ev = 'APPLICATION_REJECTED';
                    else if (newSt === 'cancelled') ev = 'REGISTRATION_CANCELLED';
                    notifEngine.notify(db, ev, {
                        userId: regRow.user_id,
                        seminarId: regRow.seminar_id,
                        registrationId: applicationId,
                        vars: { approval_status: status, rejection_reason: req.body.rejection_reason || '' }
                    });
                }
            });
        
        if (status === 'approved_pending_payment' || status === 'completed') {
            const orderIdStr = 'ORD_' + generateId();
            db.run(`INSERT OR IGNORE INTO orders (order_id_string, registration_id, amount, status) VALUES (?, ?, 1500, 'pending')`,
                [orderIdStr, applicationId], function(err) {
                        if (status === 'completed' && !fromRejectedOrCancelled) {
                            db.get(`SELECT id, order_id_string FROM orders WHERE registration_id = ?`, [applicationId], (err, order) => {
                                if (order) {
                                db.run(`UPDATE orders SET status = 'success', payment_date = CURRENT_TIMESTAMP WHERE id = ?`, [order.id]);
                                
                                db.get(`SELECT id FROM tickets WHERE order_id = ?`, [order.id], (err, ticket) => {
                                        if (!ticket) {
                                            db.get(`SELECT user_id, application_no, status FROM registrations WHERE id = ?`, [applicationId], (err, reg) => {
                                                if (!reg) return;
                                                if (reg.status === 'rejected' || reg.status === 'cancelled') return;
                                                insertParticipantTicket(order.id, reg.user_id, order.order_id_string || '', applicationId, reg.application_no, () => {});
                                        });
                                    }
                                });
                            }
                        });
                    }
                });
        }
        res.json({ success: true });
        });
    });
});

// Payment Verification Endpoint
app.post('/api/payments/verify', (req, res) => {
    const { applicationId, paymentData, gateway, paymentOption, mode } = req.body;
    const optionId =
        paymentOption ||
        (gateway && mode ? gateway + ':' + mode : gateway === 'razorpay' ? 'razorpay:test' : null);
    
    resolveDoctorPaymentOption(optionId, (eGw, activeGateway) => {
        if (eGw) return res.status(500).json({ error: eGw.message });
        if (!activeGateway || activeGateway.name !== gateway) {
            return res.status(400).json({ error: 'Invalid gateway or payment option' });
        }

        if (gateway === 'razorpay') {
            const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = paymentData;
            const sign = razorpay_order_id + '|' + razorpay_payment_id;
            const expectedSign = crypto.createHmac('sha256', activeGateway.config.key_secret)
                .update(sign.toString())
                .digest('hex');
            
            if (razorpay_signature === expectedSign) {
                db.get(
                    `SELECT id, order_id_string, status FROM orders WHERE registration_id = ? AND provider_order_id = ?`,
                    [applicationId, razorpay_order_id],
                    (err, order) => {
                        if (err) return res.status(500).json({ error: err.message });
                        const tryFallback = (cb) => {
                            db.get(
                                `SELECT id, order_id_string, status FROM orders WHERE registration_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`,
                                [applicationId],
                                cb
                            );
                        };
                        const proceed = (ord) => {
                            if (!ord) {
                                return tryFallback((e2, ord2) => {
                                    if (e2) return res.status(500).json({ error: e2.message });
                                    if (!ord2) return res.status(404).json({ error: 'Order not found' });
                                    return proceed(ord2);
                                });
                            }
                            if (ord.status === 'success') {
                                return res.json({ success: true, message: 'Payment already verified', transactionId: razorpay_payment_id });
                            }
                            db.get(`SELECT status FROM registrations WHERE id = ?`, [applicationId], (ers, regSt) => {
                                if (ers) return res.status(500).json({ error: ers.message });
                                const st = String((regSt && regSt.status) || '').toLowerCase();
                                if (st === 'rejected' || st === 'cancelled') {
                                    return res.status(403).json({
                                        error: 'This registration is rejected or cancelled; e-tickets are not issued.'
                                    });
                                }
                                db.run(
                                    `UPDATE orders SET status = 'success', payment_date = CURRENT_TIMESTAMP, payment_gateway = 'razorpay', provider_transaction_id = ? WHERE id = ?`,
                                    [razorpay_payment_id, ord.id],
                                    function (uerr) {
                                        if (uerr) return res.status(500).json({ error: uerr.message });
                                        db.run(`UPDATE registrations SET status = 'completed' WHERE id = ?`, [applicationId], () => {
                                            portalTracking.registrationStatusToLog('completed', '').forEach((entry) => {
                                                portalTracking.logRegistrationEvent(
                                                    db,
                                                    applicationId,
                                                    entry.key,
                                                    entry.label,
                                                    entry.message,
                                                    () => {}
                                                );
                                            });
                                            db.get(
                                                `SELECT r.user_id, r.seminar_id, o.amount FROM registrations r JOIN orders o ON o.id = ? WHERE r.id = ?`,
                                                [ord.id, applicationId],
                                                (ePay, pr) => {
                                                    if (!ePay && pr) {
                                                        notifEngine.notify(db, 'PAYMENT_SUCCESS', {
                                                            userId: pr.user_id,
                                                            seminarId: pr.seminar_id,
                                                            registrationId: applicationId,
                                                            vars: {
                                                                payment_amount: pr.amount,
                                                                payment_status: 'PAID',
                                                                invoice_url:
                                                                    notifEngine.publicBaseUrl() +
                                                                    '/doctor.html#tab-orders'
                                                            }
                                                        });
                                                    }
                                                }
                                            );
                                        });
                                        db.get(`SELECT application_no FROM registrations WHERE id = ?`, [applicationId], (e2, regRow) => {
                                            db.get(
                                                `SELECT id, ticket_id_string, qr_code_data FROM tickets WHERE order_id = ?`,
                                                [ord.id],
                                                (et, existingTix) => {
                                                if (existingTix) {
                                                    const hasEtk =
                                                        existingTix.ticket_id_string &&
                                                        String(existingTix.ticket_id_string).trim();
                                                    if (hasEtk) {
                                                        return res.json({
                                                            success: true,
                                                            message: 'Payment verified',
                                                            transactionId: razorpay_payment_id
                                                        });
                                                    }
                                                    return ensureTicketIdString(
                                                        existingTix.id,
                                                        ord.order_id_string || '',
                                                        applicationId,
                                                        regRow && regRow.application_no,
                                                        req.body.userId,
                                                        ord.id,
                                                        existingTix.qr_code_data,
                                                        (eBackfill) => {
                                                            if (eBackfill) {
                                                                return res.status(500).json({ error: eBackfill.message });
                                                            }
                                                            res.json({
                                                                success: true,
                                                                message: 'Payment verified and e-ticket ID assigned',
                                                                transactionId: razorpay_payment_id
                                                            });
                                                        }
                                                    );
                                                }
                                                insertParticipantTicket(
                                                    ord.id,
                                                    req.body.userId,
                                                    ord.order_id_string || '',
                                                    applicationId,
                                                    regRow && regRow.application_no,
                                                    (e3) => {
                                                        if (e3) return res.status(500).json({ error: e3.message });
                                                        res.json({
                                                            success: true,
                                                            message: 'Payment verified and e-ticket generated',
                                                            transactionId: razorpay_payment_id
                                                        });
                                                    }
                                                );
                                            }
                                            );
                                        });
                                    }
                                );
                            });
                        };
                        if (order) return proceed(order);
                        tryFallback((e2, ord2) => {
                            if (e2) return res.status(500).json({ error: e2.message });
                            proceed(ord2);
                        });
                    }
                );
            } else {
                db.get(`SELECT user_id, seminar_id FROM registrations WHERE id = ?`, [applicationId], (ePf, pr) => {
                    if (!ePf && pr) {
                        notifEngine.notify(db, 'PAYMENT_FAILED', {
                            userId: pr.user_id,
                            seminarId: pr.seminar_id,
                            registrationId: applicationId,
                            vars: { payment_status: 'FAILED' }
                        });
                    }
                });
                res.status(400).json({ error: 'Payment verification failed' });
            }
        } else {
            // For other gateways, implement verification logic
            res.json({ success: true, message: `${gateway} verification pending` });
        }
    });
});

// Admin: full user detail (profile, registrations, orders, scans, activity)
app.get('/api/admin/users/:userId/detail', (req, res) => {
    const uid = parseInt(req.params.userId, 10);
    if (!Number.isInteger(uid) || uid < 1) return res.status(400).json({ error: 'Invalid user id' });

    db.get(
        `SELECT id, user_id_string, first_name, middle_name, last_name, email, phone, password, role, user_role, is_disabled, IFNULL(is_demo,0) AS is_demo, created_at FROM users WHERE id = ?`,
        [uid],
        (e, user) => {
            if (e) return res.status(500).json({ error: e.message });
            if (!user) return res.status(404).json({ error: 'User not found' });

            db.get(`SELECT * FROM doctor_profile WHERE user_id = ?`, [uid], (e2, profile) => {
                if (e2) return res.status(500).json({ error: e2.message });

                db.all(
                    `SELECT r.id, r.application_no, r.status, r.form_data, r.created_at, r.registration_source,
                            s.title AS seminar_title, s.id AS seminar_id
                     FROM registrations r
                     LEFT JOIN seminars s ON s.id = r.seminar_id
                     WHERE r.user_id = ?
                     ORDER BY r.created_at DESC`,
                    [uid],
                    (e3, registrations) => {
                        if (e3) return res.status(500).json({ error: e3.message });

                        db.all(
                            `SELECT o.id, o.order_id_string, o.amount, o.status, o.payment_date, o.payment_gateway,
                                    r.application_no, s.title AS seminar_title,
                                    t.ticket_id_string, t.is_scanned, t.scan_time,
                                    su.first_name AS scanned_by_first, su.last_name AS scanned_by_last, su.user_id_string AS scanned_by_id
                             FROM orders o
                             JOIN registrations r ON r.id = o.registration_id
                             LEFT JOIN seminars s ON s.id = r.seminar_id
                             LEFT JOIN tickets t ON t.order_id = o.id
                             LEFT JOIN users su ON su.id = t.scanned_by
                             WHERE r.user_id = ?
                             ORDER BY o.id DESC`,
                            [uid],
                            (e4, orders) => {
                                if (e4) return res.status(500).json({ error: e4.message });

                                db.all(
                                    `SELECT a.id, a.topic, a.status, a.marks, a.created_at FROM abstracts a WHERE a.user_id = ? ORDER BY a.created_at DESC`,
                                    [uid],
                                    (e5, abstracts) => {
                                        if (e5) return res.status(500).json({ error: e5.message });

                                        db.all(
                                            `SELECT * FROM support_tickets st WHERE st.user_id = ? ORDER BY st.created_at DESC LIMIT 20`,
                                            [uid],
                                            (e6, supportTickets) => {
                                                if (e6) return res.status(500).json({ error: e6.message });

                                                const finishDetail = (certificates, certErr) => {
                                                    if (certErr) {
                                                        console.warn('[admin] user_certificates:', certErr.message);
                                                    }
                                                    res.json({
                                                        user,
                                                        profile: profile || null,
                                                        registrations: registrations || [],
                                                        orders: orders || [],
                                                        abstracts: abstracts || [],
                                                        supportTickets: supportTickets || [],
                                                        certificates: certificates || [],
                                                        certificatesError:
                                                            certErr &&
                                                            /user_certificates|certificate_templates/i.test(
                                                                certErr.message
                                                            )
                                                                ? certErr.message
                                                                : undefined
                                                    });
                                                };
                                                db.all(
                                                    `SELECT uc.*, s.title AS seminar_title, ct.file_path AS template_path
                                                     FROM user_certificates uc
                                                     LEFT JOIN seminars s ON s.id = uc.seminar_id
                                                     LEFT JOIN certificate_templates ct ON ct.id = uc.template_id
                                                     WHERE uc.user_id = ?`,
                                                    [uid],
                                                    (e7, certificates) => {
                                                        if (
                                                            e7 &&
                                                            /relation .* does not exist/i.test(e7.message)
                                                        ) {
                                                            return finishDetail([], e7);
                                                        }
                                                        if (e7) return res.status(500).json({ error: e7.message });
                                                        finishDetail(certificates || [], null);
                                                    }
                                                );
                                            }
                                        );
                                    }
                                );
                            }
                        );
                    }
                );
            });
        }
    );
});

// Admin: set / reset user password
app.post('/api/admin/users/:userId/password', (req, res) => {
    const uid = parseInt(req.params.userId, 10);
    const { password, generate } = req.body || {};
    if (!Number.isInteger(uid) || uid < 1) return res.status(400).json({ error: 'Invalid user id' });

    let newPass = password != null ? String(password) : '';
    if (generate || !newPass.trim()) {
        newPass = '';
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$';
        for (let i = 0; i < 12; i++) newPass += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    if (newPass.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });

    db.run(`UPDATE users SET password = ? WHERE id = ?`, [newPass, uid], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'User not found' });
        notifEngine.notify(db, 'ACCOUNT_CREATED', {
            userId: uid,
            vars: { temporary_password: newPass }
        });
        res.json({ success: true, password: newPass });
    });
});

// Admin: scanner check-in log (which doctor was scanned, by whom)
app.get('/api/admin/scanner/logs', (req, res) => {
    const seminarId = req.query.seminarId ? parseInt(req.query.seminarId, 10) : null;
    let sql = `
        SELECT t.id, t.ticket_id_string, t.scan_time, t.is_scanned,
               doc.user_id_string AS doctor_user_id_string, doc.first_name AS doctor_first_name, doc.last_name AS doctor_last_name,
               doc.email AS doctor_email, doc.phone AS doctor_phone,
               scanner.first_name AS scanner_first_name, scanner.last_name AS scanner_last_name, scanner.user_id_string AS scanner_user_id_string,
               r.application_no, s.title AS seminar_title, s.id AS seminar_id
        FROM tickets t
        JOIN users doc ON doc.id = t.user_id
        LEFT JOIN users scanner ON scanner.id = t.scanned_by
        JOIN orders o ON o.id = t.order_id
        JOIN registrations r ON r.id = o.registration_id
        JOIN seminars s ON r.seminar_id = s.id
        WHERE t.is_scanned = 1
    `;
    const params = [];
    if (Number.isInteger(seminarId) && seminarId > 0) {
        sql += ` AND s.id = ?`;
        params.push(seminarId);
    }
    sql += ` ORDER BY t.scan_time DESC LIMIT 500`;
    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// Admin: certificate template upload
app.post('/api/admin/certificates/template', upload.single('templateFile'), (req, res) => {
    const seminarId = parseInt(req.body.seminarId, 10);
    const adminUserId = parseInt(req.body.adminUserId, 10);
    if (!req.file) return res.status(400).json({ error: 'templateFile is required (image or document)' });
    if (!Number.isInteger(seminarId) || seminarId < 1) return res.status(400).json({ error: 'seminarId is required' });

    const relPath = '/uploads/' + req.file.filename;
    const certType =
        req.body && String(req.body.certType || 'participant').toLowerCase() === 'volunteer'
            ? 'volunteer'
            : 'participant';
    db.run(
        `UPDATE certificate_templates SET is_active = 0 WHERE seminar_id = ? AND IFNULL(cert_type,'participant') = ?`,
        [seminarId, certType],
        () => {
        db.run(
            `INSERT INTO certificate_templates (seminar_id, file_path, original_name, mime_type, uploaded_by, is_active, cert_type) VALUES (?, ?, ?, ?, ?, 1, ?)`,
            [seminarId, relPath, req.file.originalname, req.file.mimetype, Number.isInteger(adminUserId) ? adminUserId : null, certType],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                const templateId = this.lastID;
                const linkEnabledCerts = (cbLink) => {
                    if (certType !== 'participant') return cbLink();
                    db.run(
                        `UPDATE user_certificates SET template_id = ?, updated_at = CURRENT_TIMESTAMP
                         WHERE seminar_id = ? AND enabled = 1`,
                        [templateId, seminarId],
                        () => cbLink()
                    );
                };
                linkEnabledCerts(() => {
                db.all(
                    `SELECT t.id FROM tickets t
                     JOIN orders o ON o.id = t.order_id AND o.status = 'success'
                     JOIN registrations r ON r.id = o.registration_id AND r.seminar_id = ?
                     WHERE t.is_scanned = 1`,
                    [seminarId],
                    (e2, tickets) => {
                        if (e2) return res.status(500).json({ error: e2.message });
                        const list = tickets || [];
                        let i = 0;
                        const next = () => {
                            if (i >= list.length) {
                                return res.json({
                                    success: true,
                                    templateId,
                                    filePath: relPath,
                                    refreshedEligible: list.length,
                                    linkedEnabledCertificates: true
                                });
                            }
                            syncCertificateEligibilityForTicket(list[i].id, () => {
                                i++;
                                next();
                            });
                        };
                        next();
                    }
                );
                });
            }
        );
    });
});

app.get('/api/admin/certificates/status', (req, res) => {
    const seminarId = req.query.seminarId ? parseInt(req.query.seminarId, 10) : null;
    let sql = `
        SELECT uc.*, u.user_id_string, u.first_name, u.last_name, u.email,
               s.title AS seminar_title, ct.file_path AS template_path
        FROM user_certificates uc
        JOIN users u ON u.id = uc.user_id
        LEFT JOIN seminars s ON s.id = uc.seminar_id
        LEFT JOIN certificate_templates ct ON ct.id = uc.template_id
        WHERE 1=1
    `;
    const params = [];
    if (Number.isInteger(seminarId) && seminarId > 0) {
        sql += ` AND uc.seminar_id = ?`;
        params.push(seminarId);
    }
    sql += ` ORDER BY uc.updated_at DESC`;
    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

app.post('/api/admin/certificates/:id/toggle', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const enabled = req.body && req.body.enabled ? 1 : 0;
    db.run(`UPDATE user_certificates SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [enabled, id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        if (enabled) {
            db.get(`SELECT user_id, seminar_id FROM user_certificates WHERE id = ?`, [id], (e2, cert) => {
                if (!e2 && cert) {
                    notifEngine.notify(db, 'CERTIFICATE_AVAILABLE', {
                        userId: cert.user_id,
                        seminarId: cert.seminar_id,
                        vars: {
                            certificate_url: notifEngine.publicBaseUrl() + '/doctor.html#tab-certificates'
                        }
                    });
                }
            });
        }
        res.json({ success: true });
    });
});

// Doctor: certificate eligibility for logged-in user
app.get('/api/doctor/certificates/:userId', (req, res) => {
    const uid = parseInt(req.params.userId, 10);
    if (!Number.isInteger(uid) || uid < 1) return res.status(400).json({ error: 'Invalid user id' });
    db.all(
        `SELECT uc.*, s.title AS seminar_title, ct.file_path AS template_path, ct.mime_type
         FROM user_certificates uc
         LEFT JOIN seminars s ON s.id = uc.seminar_id
         LEFT JOIN certificate_templates ct ON ct.id = uc.template_id
         WHERE uc.user_id = ?
         ORDER BY uc.seminar_id DESC`,
        [uid],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        }
    );
});

// Admin: Create User
app.post('/api/admin/users/create', (req, res) => {
    const { firstName, lastName, email, phone, password, role } = req.body;
    const userRole = role || 'doctor';
    const roleCol = String(userRole).toLowerCase() === 'co_admin' ? 'admin' : String(userRole).toLowerCase() === 'admin' ? 'admin' : 'doctor';

    if (userRole === 'doctor' || roleCol === 'doctor') {
        const fn = validateDoctorName(firstName);
        if (!fn.valid) return res.status(400).json({ error: fn.message });
        const ln = validateDoctorName(lastName);
        if (!ln.valid) return res.status(400).json({ error: ln.message });
    }

    let finalPassword = password != null ? String(password) : '';
    if (!finalPassword.trim()) {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$';
        for (let i = 0; i < 12; i++) finalPassword += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    const userIdStr = generateId();
    const cleanFirst = userRole === 'doctor' || roleCol === 'doctor' ? validateDoctorName(firstName).cleanedName : String(firstName).trim();
    const cleanLast = userRole === 'doctor' || roleCol === 'doctor' ? validateDoctorName(lastName).cleanedName : String(lastName).trim();

    db.run(
        `INSERT INTO users (user_id_string, first_name, last_name, email, phone, password, role, user_role) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [userIdStr, cleanFirst, cleanLast, email, phone, finalPassword, roleCol, userRole],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            const newId = this.lastID;
            notifEngine.notify(db, 'ACCOUNT_CREATED', {
                userId: newId,
                vars: { temporary_password: finalPassword }
            });
            res.json({
                success: true,
                userId: newId,
                user_id_string: userIdStr,
                generatedPassword: finalPassword
            });
        }
    );
});

// Admin: Get Users
app.get('/api/admin/users', (req, res) => {
    db.all(
        `SELECT id, user_id_string, first_name, last_name, email, phone, role, user_role, is_disabled, IFNULL(is_demo,0) AS is_demo, admin_modules FROM users ORDER BY id DESC`,
        [],
        (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// Admin: Update User Role
app.post('/api/admin/users/:userId/role', (req, res) => {
    const { user_role } = req.body;
    const validRoles = ['doctor', 'judge_user', 'co_admin', 'scanner_portal_user', 'reviewer'];
    
    if (!validRoles.includes(user_role)) {
        return res.status(400).json({ error: 'Invalid role' });
    }
    
    db.run(`UPDATE users SET user_role = ? WHERE id = ?`, [user_role, req.params.userId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: `User role updated to ${user_role}` });
    });
});

// Admin: Get user roles list
app.get('/api/admin/user-roles', (req, res) => {
    db.all(`SELECT * FROM user_roles`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// Admin: Toggle Disable User
app.post('/api/admin/users/toggle_disable', (req, res) => {
    const { userId, disable } = req.body;
    const val = disable ? 1 : 0;
    db.run(`UPDATE users SET is_disabled = ? WHERE id = ?`, [val, userId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

function setUserDemoFlag(userId, isDemo, res) {
    const uid = parseInt(userId, 10);
    if (!Number.isInteger(uid) || uid < 1) return res.status(400).json({ error: 'Invalid user id' });
    const val = isDemo ? 1 : 0;
    db.run(`ALTER TABLE users ADD COLUMN is_demo INTEGER DEFAULT 0`, (alterErr) => {
        if (alterErr && !/duplicate column/i.test(String(alterErr.message))) {
            return res.status(500).json({ error: alterErr.message });
        }
        db.run(`UPDATE users SET is_demo = ? WHERE id = ?`, [val, uid], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: 'User not found' });
            res.json({ success: true, isDemo: !!val });
        });
    });
}

app.post('/api/admin/users/toggle_demo', (req, res) => {
    const uid = req.body && req.body.userId != null ? req.body.userId : req.body && req.body.user_id;
    const isDemo =
        req.body &&
        (req.body.isDemo === true ||
            req.body.isDemo === 1 ||
            req.body.isDemo === '1' ||
            req.body.isDemo === 'true');
    setUserDemoFlag(uid, isDemo, res);
});

app.post('/api/admin/users/:userId/demo', (req, res) => {
    const isDemo =
        req.body &&
        (req.body.isDemo === true ||
            req.body.isDemo === 1 ||
            req.body.isDemo === '1' ||
            req.body.isDemo === 'true');
    setUserDemoFlag(req.params.userId, isDemo, res);
});

// Admin: Transfer Application
app.post('/api/admin/applications/transfer', (req, res) => {
    const { applicationId, newUserIdStr } = req.body;
    // Find new user id by string
    db.get(`SELECT id FROM users WHERE user_id_string = ?`, [newUserIdStr], (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user) return res.status(404).json({ error: 'Target User ID not found' });
        
        db.run(`UPDATE registrations SET user_id = ? WHERE id = ?`, [user.id, applicationId], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
    });
});

// Judge portal: case presentations / abstracts queue
app.get('/api/judge/abstracts', (req, res) => {
    const judgeUserId = parseInt(req.query.judgeUserId, 10);
    if (!Number.isInteger(judgeUserId) || judgeUserId < 1) {
        return res.status(400).json({ error: 'judgeUserId query parameter is required' });
    }
    db.get(`SELECT id, role, user_role FROM users WHERE id = ? AND IFNULL(is_disabled,0) = 0`, [judgeUserId], (e, u) => {
        if (e) return res.status(500).json({ error: e.message });
        if (!u) return res.status(401).json({ error: 'Invalid user' });
        const ur = String(u.user_role || '').toLowerCase();
        const r = String(u.role || '').toLowerCase();
        if (ur !== 'judge_user' && ur !== 'reviewer' && r !== 'admin') {
            return res.status(403).json({ error: 'Judge or reviewer role required' });
        }
        db.all(
            `SELECT a.id, a.user_id, a.topic, a.video_path, a.ppt_path, a.status, a.rejection_reason, a.marks, a.judge_remarks, a.created_at,
                    u.first_name, u.last_name, u.user_id_string, u.email
             FROM abstracts a
             JOIN users u ON u.id = a.user_id
             ORDER BY a.created_at DESC`,
            [],
            (e2, rows) => {
                if (e2) return res.status(500).json({ error: e2.message });
                res.json(rows || []);
            }
        );
    });
});

// Super admin: set co-admin module visibility (JSON map of tab id -> boolean)
app.post('/api/admin/users/:userId/modules', (req, res) => {
    const targetId = parseInt(req.params.userId, 10);
    const { admin_modules, actingAdminId } = req.body || {};
    const actorId = parseInt(actingAdminId, 10);
    if (!Number.isInteger(targetId) || !Number.isInteger(actorId)) {
        return res.status(400).json({ error: 'actingAdminId and user path id are required' });
    }
    db.get(`SELECT id, role, user_role FROM users WHERE id = ?`, [actorId], (e, actor) => {
        if (e) return res.status(500).json({ error: e.message });
        if (!isSuperAdminRow(actor)) {
            return res.status(403).json({ error: 'Only the super administrator can configure co-admin modules.' });
        }
        const payload = JSON.stringify(admin_modules && typeof admin_modules === 'object' ? admin_modules : {});
        db.run(`UPDATE users SET admin_modules = ? WHERE id = ?`, [payload, targetId], function (err2) {
            if (err2) return res.status(500).json({ error: err2.message });
            res.json({ success: true });
        });
    });
});

// Admin: create or update a registration on behalf of a doctor (admin-edited; distinct from doctor self-edit API)
app.post('/api/admin/registrations/upsert', (req, res) => {
    const { targetUserId, seminarId, formData, adminUserId } = req.body || {};
    const tid = parseInt(targetUserId, 10);
    const sid = parseInt(seminarId, 10);
    const aid = parseInt(adminUserId, 10);
    if (!Number.isInteger(tid) || !Number.isInteger(sid) || !Number.isInteger(aid)) {
        return res.status(400).json({ error: 'targetUserId, seminarId, and adminUserId are required' });
    }
    db.get(`SELECT id, role, user_role FROM users WHERE id = ? AND IFNULL(is_disabled,0) = 0`, [aid], (e, adm) => {
        if (e) return res.status(500).json({ error: e.message });
        if (!adm) return res.status(403).json({ error: 'Invalid admin user' });
        const ok =
            String(adm.role || '').toLowerCase() === 'admin' ||
            String(adm.user_role || '').toLowerCase() === 'co_admin';
        if (!ok) return res.status(403).json({ error: 'Admin portal access required' });
        const fd = formData && typeof formData === 'object' ? JSON.stringify(formData) : '{}';
        db.get(`SELECT id FROM registrations WHERE user_id = ? AND seminar_id = ?`, [tid, sid], (e2, reg) => {
            if (e2) return res.status(500).json({ error: e2.message });
            if (reg) {
                return db.run(
                    `UPDATE registrations SET form_data = ?, registration_source = 'admin', admin_editor_user_id = ? WHERE id = ?`,
                    [fd, aid, reg.id],
                    function (uerr) {
                        if (uerr) return res.status(500).json({ error: uerr.message });
                        res.json({ success: true, registrationId: reg.id, created: false });
                    }
                );
            }
            const applicationNo = generateId();
            db.run(
                `INSERT INTO registrations (user_id, seminar_id, application_no, status, form_data, registration_source, admin_editor_user_id) VALUES (?, ?, ?, 'submitted', ?, 'admin', ?)`,
                [tid, sid, applicationNo, fd, aid],
                function (ierr) {
                    if (ierr) return res.status(500).json({ error: ierr.message });
                    res.json({ success: true, registrationId: this.lastID, applicationNo, created: true });
                }
            );
        });
    });
});

// Admin: Get Global Settings
app.get('/api/global_settings', (req, res) => {
    db.all(`SELECT key, value FROM global_settings`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const settings = {};
        rows.forEach(r => settings[r.key] = r.value);
        res.json(settings);
    });
});

// Admin: Update Global Settings
app.post('/api/admin/global_settings', (req, res) => {
    const { settings } = req.body; // Array of {key, value}
    const stmt = db.prepare(`UPDATE global_settings SET value = ? WHERE key = ?`);
    settings.forEach(s => stmt.run(s.value, s.key));
    stmt.finalize();
    res.json({ success: true });
});

// Admin: Get Payment Gateways
app.get('/api/admin/payment_gateways', (req, res) => {
    db.all(`SELECT * FROM payment_gateways`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// Admin: Update Payment Gateway
app.post('/api/admin/payment_gateways/:name', (req, res) => {
    const { name } = req.params;
    const { is_active, config } = req.body;
    const finish = (finalConfig) => {
        db.run(
            `INSERT OR REPLACE INTO payment_gateways (name, is_active, config) VALUES (?, ?, ?)`,
            [name, is_active ? 1 : 0, JSON.stringify(finalConfig)],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true });
            }
        );
    };
    if (String(name).toLowerCase() === 'razorpay' && config) {
        return db.get(`SELECT config FROM payment_gateways WHERE name = ?`, [name], (e, row) => {
            if (e) return res.status(500).json({ error: e.message });
            const merged = row && row.config
                ? paymentGatewayOptions.mergeRazorpayConfig(row.config, config)
                : config;
            finish(merged);
        });
    }
    finish(config || {});
});

// ==================== EVENT SCHEDULE ENDPOINTS ====================

function parseEventScheduleSeminarId(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    const n = parseInt(raw, 10);
    return Number.isInteger(n) && n > 0 ? n : null;
}

// List all schedules (public + admin table)
app.get('/api/event-schedules', (req, res) => {
    db.all(
        `SELECT es.id, es.title, es.description, es.seminar_id, es.start_time, es.end_time,
                es.location, es.speaker_name, es.speaker_bio, s.title AS seminar_title
         FROM event_schedules es
         LEFT JOIN seminars s ON es.seminar_id = s.id
         ORDER BY es.start_time ASC`,
        [],
        (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
        }
    );
});

// Schedules for one seminar
app.get('/api/event-schedules/by-seminar/:seminarId', (req, res) => {
    const seminarId = parseInt(req.params.seminarId, 10);
    if (!Number.isInteger(seminarId) || seminarId < 1) {
        return res.status(400).json({ error: 'Invalid seminar id' });
    }
    db.all(
        `SELECT es.*, s.title AS seminar_title
         FROM event_schedules es
         LEFT JOIN seminars s ON es.seminar_id = s.id
         WHERE es.seminar_id = ?
         ORDER BY es.start_time ASC`,
        [seminarId],
        (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
        }
    );
});

// Admin: Create Event Schedule
app.post('/api/admin/event-schedules', (req, res) => {
    const { title, description, seminarId, startTime, endTime, location, speakerName, speakerBio } = req.body || {};
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title is required' });
    if (!startTime || !endTime) return res.status(400).json({ error: 'Start and end time are required' });
    const sid = parseEventScheduleSeminarId(seminarId);
    if (seminarId != null && seminarId !== '' && sid === null) {
        return res.status(400).json({ error: 'Invalid seminar selected' });
    }
    db.run(
        `INSERT INTO event_schedules (title, description, seminar_id, start_time, end_time, location, speaker_name, speaker_bio)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            String(title).trim(),
            description || null,
            sid,
            startTime,
            endTime,
            location || null,
            speakerName || null,
            speakerBio || null
        ],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, id: this.lastID });
        }
    );
});

// Admin: Update Event Schedule
app.put('/api/admin/event-schedules/:id', (req, res) => {
    const { id } = req.params;
    const { title, description, seminarId, startTime, endTime, location, speakerName, speakerBio } = req.body || {};
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title is required' });
    if (!startTime || !endTime) return res.status(400).json({ error: 'Start and end time are required' });
    const sid = parseEventScheduleSeminarId(seminarId);
    if (seminarId != null && seminarId !== '' && sid === null) {
        return res.status(400).json({ error: 'Invalid seminar selected' });
    }
    db.run(
        `UPDATE event_schedules SET title = ?, description = ?, seminar_id = ?, start_time = ?, end_time = ?,
         location = ?, speaker_name = ?, speaker_bio = ? WHERE id = ?`,
        [
            String(title).trim(),
            description || null,
            sid,
            startTime,
            endTime,
            location || null,
            speakerName || null,
            speakerBio || null,
            id
        ],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: 'Schedule not found' });
            res.json({ success: true });
        }
    );
});

// Admin: Delete Event Schedule
app.delete('/api/admin/event-schedules/:id', (req, res) => {
    const { id } = req.params;
    db.run(`DELETE FROM event_schedules WHERE id = ?`, [id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Schedule not found' });
        res.json({ success: true });
    });
});

// ==================== SEMINAR FEEDBACK ENDPOINTS ====================

// Submit Seminar Feedback
app.post('/api/feedback/submit', (req, res) => {
    const { userId, seminarId, registrationId, rating, contentQuality, speakerQuality, organizationQuality, overallExperience, suggestions, wouldAttendAgain } = req.body;
    
    db.run(`INSERT INTO seminar_feedback (user_id, seminar_id, registration_id, rating, content_quality, speaker_quality, organization_quality, overall_experience, suggestions, would_attend_again) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, seminarId, registrationId, rating || 5, contentQuality || 5, speakerQuality || 5, organizationQuality || 5, overallExperience, suggestions, wouldAttendAgain ? 1 : 0],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, id: this.lastID });
        });
});

// Get Feedback for a Seminar (Admin)
app.get('/api/admin/feedback/seminar/:seminarId', (req, res) => {
    const { seminarId } = req.params;
    db.all(`SELECT sf.*, u.first_name, u.last_name, u.email FROM seminar_feedback sf 
            LEFT JOIN users u ON sf.user_id = u.id 
            WHERE sf.seminar_id = ? 
            ORDER BY sf.created_at DESC`, [seminarId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// Get Feedback Statistics (Admin)
app.get('/api/admin/feedback/stats/:seminarId', (req, res) => {
    const { seminarId } = req.params;
    db.get(`SELECT 
                COUNT(*) as total_feedbacks,
                AVG(rating) as avg_rating,
                AVG(content_quality) as avg_content_quality,
                AVG(speaker_quality) as avg_speaker_quality,
                AVG(organization_quality) as avg_organization_quality,
                SUM(CASE WHEN would_attend_again = 1 THEN 1 ELSE 0 END) as would_attend_again_count
            FROM seminar_feedback 
            WHERE seminar_id = ?`, [seminarId], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row || {});
    });
});

// Get User's Feedback History
app.get('/api/feedback/user/:userId', (req, res) => {
    const { userId } = req.params;
    db.all(`SELECT sf.*, s.title as seminar_title FROM seminar_feedback sf 
            LEFT JOIN seminars s ON sf.seminar_id = s.id 
            WHERE sf.user_id = ? 
            ORDER BY sf.created_at DESC`, [userId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// ==================== SUPPORT TICKET ENDPOINTS ====================

// Create Support Ticket
app.post('/api/support-ticket/create', (req, res) => {
    const { userId, category, subject, description, attachment_path } = req.body;
    const uid = parseInt(userId, 10);
    if (Number.isNaN(uid)) return res.status(400).json({ error: 'Invalid user' });
    if (!subject || !String(subject).trim()) return res.status(400).json({ error: 'Subject is required' });
    if (!description || !String(description).trim()) return res.status(400).json({ error: 'Description is required' });
    const ticketId = 'TKT_' + generateId();
    const cat = category || 'general';

    db.run(
        `INSERT INTO support_tickets (ticket_id, user_id, category, subject, description, attachment_path, priority, status) 
            VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`,
        [ticketId, uid, cat, subject.trim(), description.trim(), attachment_path || null, 'medium'],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            const initialMsg = description.trim();
            db.run(
                `INSERT INTO ticket_messages (ticket_id, sender_id, sender_type, message) VALUES (?, ?, 'user', ?)`,
                [ticketId, uid, initialMsg],
                function (err2) {
                    if (err2) return res.status(500).json({ error: err2.message });
                    res.json({ success: true, ticketId: ticketId, id: ticketId });
                }
            );
        }
    );
});

// Get User's Support Tickets
app.get('/api/support-ticket/user/:userId', (req, res) => {
    const { userId } = req.params;
    db.all(`SELECT * FROM support_tickets WHERE user_id = ? ORDER BY created_at DESC`, [userId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// Get Ticket Details with Messages
app.get('/api/support-ticket/:ticketId', (req, res) => {
    const { ticketId } = req.params;
    db.get(`SELECT st.*, u.first_name, u.last_name, u.email FROM support_tickets st 
            LEFT JOIN users u ON st.user_id = u.id 
            WHERE st.ticket_id = ?`, [ticketId], (err, ticket) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
        
        db.all(`SELECT tm.*, u.first_name, u.last_name FROM ticket_messages tm 
                LEFT JOIN users u ON tm.sender_id = u.id 
                WHERE tm.ticket_id = ? 
                ORDER BY tm.created_at ASC`, [ticketId], (err, messages) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ...ticket, messages: messages || [] });
        });
    });
});

// Add Reply to Support Ticket
app.post('/api/support-ticket/:ticketId/reply', (req, res) => {
    const { ticketId } = req.params;
    const { senderId, senderType, message, attachment_path } = req.body;
    
    db.run(`INSERT INTO ticket_messages (ticket_id, sender_id, sender_type, message, attachment_path) 
            VALUES (?, ?, ?, ?, ?)`,
        [ticketId, senderId, senderType, message, attachment_path || null],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            
            // Update ticket's updated_at timestamp
            db.run(`UPDATE support_tickets SET updated_at = CURRENT_TIMESTAMP WHERE ticket_id = ?`, [ticketId]);
            res.json({ success: true, messageId: this.lastID });
        });
});

// Admin: Get All Support Tickets
app.get('/api/admin/support-tickets', (req, res) => {
    const { status, category, priority } = req.query;
    let query = `SELECT st.*, u.first_name, u.last_name, u.email FROM support_tickets st 
                 LEFT JOIN users u ON st.user_id = u.id WHERE 1=1`;
    const params = [];
    
    if (status) {
        query += ` AND st.status = ?`;
        params.push(status);
    }
    if (category) {
        query += ` AND st.category = ?`;
        params.push(category);
    }
    if (priority) {
        query += ` AND st.priority = ?`;
        params.push(priority);
    }
    
    query += ` ORDER BY st.priority DESC, st.created_at DESC`;
    
    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// Admin: Update Ticket Status
app.put('/api/admin/support-ticket/:ticketId/status', (req, res) => {
    const { ticketId } = req.params;
    const { status, adminId } = req.body;
    
    db.run(`UPDATE support_tickets SET status = ?, assigned_to_admin = ?, updated_at = CURRENT_TIMESTAMP WHERE ticket_id = ?`,
        [status, adminId || null, ticketId],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
});

// Admin: Update Ticket Priority
app.put('/api/admin/support-ticket/:ticketId/priority', (req, res) => {
    const { ticketId } = req.params;
    const { priority } = req.body;
    
    db.run(`UPDATE support_tickets SET priority = ?, updated_at = CURRENT_TIMESTAMP WHERE ticket_id = ?`,
        [priority, ticketId],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
});

function startBackgroundWorkers() {
    backfillMissingTicketIdStrings((eBf, count) => {
        if (eBf) console.warn('[tickets] E-ticket ID backfill failed:', eBf.message);
        else if (count) console.log(`[tickets] Backfilled ${count} missing e-ticket ID(s).`);
    });
    if (pgDb && pgDb.ensureAuxiliaryTables) {
        pgDb
            .ensureAuxiliaryTables()
            .then((stillMissing) => {
                if (stillMissing && stillMissing.length) {
                    console.warn('[pg-schema] auxiliary tables still missing:', stillMissing.join(', '));
                }
            })
            .catch((eAux) => console.warn('[pg-schema] ensureAuxiliaryTables:', eAux.message));
    }
    integrationSettings.loadFromDb(db, (eInt) => {
        if (eInt) console.warn('[integrations] load failed:', eInt.message);
        db.get(`SELECT value FROM global_settings WHERE key = ?`, ['notification_templates_sync_v'], (eSync, row) => {
            if (eSync) return;
            if (row && row.value === '20260517') return;
            notifEngine.syncDefaultNotificationTemplates(db, (syncErr) => {
                if (syncErr) console.warn('[notifications] template sync failed:', syncErr.message);
                else {
                    upsertGlobalSetting('notification_templates_sync_v', '20260517', () => {
                        console.log('[notifications] VGMF 2026 default templates synced');
                    });
                }
            });
        });
    });
    if (jobsModule && typeof jobsModule.startWorkers === 'function' && !process.env.VERCEL) {
        jobsModule.startWorkers(db);
    }
}

module.exports = app;

if (!process.env.VERCEL) {
    db.connect((err) => {
        if (err) {
            console.error('[db] connect failed:', err.message);
            process.exit(1);
        }
        bootstrapApp(() => {
            app.listen(PORT, () => {
                console.log(`Server is running on http://localhost:${PORT}`);
                console.log('[routes] Case presentation APIs: /api/admin/case/programs, /api/case/programs');
    });
});
    });
}
