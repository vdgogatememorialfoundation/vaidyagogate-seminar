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
const portalAuthPolicy = require('./lib/portal-auth-policy');
const designatedNotify = require('./lib/designated-notify');
const ticketHtml = require('./lib/ticket-html');
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
const cancelPolicy = require('./lib/cancellation-policy');
const siteMarketing = require('./lib/site-marketing');
const siteKillSwitch = require('./lib/site-kill-switch');
const activityLog = require('./lib/activity-log');
const whatsappWebhook = require('./lib/whatsapp-webhook');
const { ensureSupportTicketSchema } = require('./lib/support-tickets-schema');
const { ensureContactInquiriesSchema } = require('./lib/contact-inquiries-schema');
const paymentsMod = require('./lib/payments-module');
const { registerPaymentsRoutes } = require('./lib/routes-payments');
const authUsers = require('./lib/auth-users');
const authLoginOtp = require('./lib/auth-login-otp');
const {
    isCheckinDateToday,
    isCheckinOpenForSeminar,
    isSeminarEnded,
    localDateYmd,
    normalizeCheckinDateYmd,
    normalizeCheckinDateForStorage
} = require('./lib/local-date');
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

function mountPaymentsRoutes() {
    registerPaymentsRoutes(app, {
        db,
        generateId,
        invalidateTicketsForRegistration,
        fulfillRegistrationPayment,
        insertParticipantTicket,
        notifEngine,
        activityLog,
        jobsModule
    });
}

function bootstrapApp(done) {
    mountExtendedRoutes();
    mountPaymentsRoutes();
    startBackgroundWorkers();
    persistScrollingAnnouncementsSanitizeIfNeeded(() => {});

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

app.use(siteKillSwitch.createSiteKillSwitchMiddleware(db));

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

app.get('/api/public/portal-urls', (req, res) => {
    res.json(portalUrls.getPortalUrls());
});

app.get('/api/public/portal-auth', (req, res) => {
    portalAuthPolicy.loadPortalAuthConfig(db, (e) => {
        if (e) console.warn('[portal-auth-policy]', e.message);
        res.json(portalAuthPolicy.publicPortalAuthPayload());
    });
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
const fileStore = require('./lib/file-store');
const caseUpload = fileStore.createUploadHandler(upload, memoryUpload);

app.get('/uploads/:filename', fileStore.serveUploadHandler(db, uploadsDir));
if (fileStore.useBlobStore()) {
    fileStore.ensureSchema(db, (e) => {
        if (e) console.warn('[file-store] schema:', e.message);
    });
}

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
        db.run(`ALTER TABLE users ADD COLUMN is_banned INTEGER DEFAULT 0`, (ban1) => {
            ignoreDup(ban1);
            db.run(`ALTER TABLE users ADD COLUMN ban_reason TEXT`, (ban2) => {
                ignoreDup(ban2);
                db.run(`ALTER TABLE users ADD COLUMN banned_at TEXT`, (ban3) => {
                    ignoreDup(ban3);
        db.run(`ALTER TABLE users ADD COLUMN user_role TEXT`, (err2) => {
            ignoreDup(err2);
            db.run(`ALTER TABLE users ADD COLUMN admin_modules TEXT`, (err3) => {
                ignoreDup(err3);
                db.run(`ALTER TABLE users ADD COLUMN last_login_at TEXT`, (err4) => {
                    ignoreDup(err4);
                    afterUsers();
                });
            });
        });
                });
            });
        });
    });
}

function recordUserLogin(userId, cb) {
    const uid = parseInt(userId, 10);
    if (!Number.isInteger(uid) || uid < 1) return cb && cb(null, { previousLoginAt: null, loginAt: new Date().toISOString() });
    db.get(`SELECT last_login_at FROM users WHERE id = ?`, [uid], (e, row) => {
        if (e && /does not exist|no such column/i.test(String(e.message || ''))) {
            return cb && cb(null, { previousLoginAt: null, loginAt: new Date().toISOString() });
        }
        if (e) return cb && cb(e);
        const previousLoginAt = row && row.last_login_at ? String(row.last_login_at) : null;
        db.run(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`, [uid], (e2) => {
            if (e2 && /does not exist|no such column/i.test(String(e2.message || ''))) {
                return cb && cb(null, { previousLoginAt, loginAt: new Date().toISOString() });
            }
            if (e2) return cb && cb(e2);
            cb && cb(null, { previousLoginAt, loginAt: new Date().toISOString() });
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
    speakers: [],
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
        db.run(`ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 1`, (evErr) => {
            ignoreSchemaMigrationErr(evErr);
        });
        db.run(
            `CREATE TABLE IF NOT EXISTS email_verify_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                token_hash TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                consumed INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )`,
            (evtErr) => {
                ignoreSchemaMigrationErr(evtErr);
            }
        );
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
                activityLog.ensureActivityLogSchema(db, () => {
                    if (next) next();
                });
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
                                                                                                            ensureSupportTicketSchema(
                                                                                                                db,
                                                                                                                ignoreSchemaMigrationErr,
                                                                                                                () => {
                                                                                                                    ensureContactInquiriesSchema(
                                                                                                                        db,
                                                                                                                        ignoreSchemaMigrationErr,
                                                                                                                        () => {
                                                                                                                            paymentsMod.ensurePaymentsModuleSchema(
                                                                                                                                db,
                                                                                                                                ignoreSchemaMigrationErr,
                                                                                                                                () => {
                                                                                                                            seedGlobalSettingIfMissing(
                                                                                                                                integrationSettings.SETTINGS_KEY,
                                                                                                                                '{}',
                                                                                                                                () => {
                                                                                                                                    integrationSettings.loadFromDb(db, () => {
                                                                                                                                        if (next) next();
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
        base.scrollingAnnouncements = sanitizeScrollingAnnouncements(base.scrollingAnnouncements);
        callback(null, base);
    });
}

function isSeminarRegistrationOpen(row) {
    const now = Date.now();
    const rs = seminarDt.parseSeminarMs(row.registration_start);
    const re = seminarDt.parseSeminarMs(row.registration_end);
    if (rs != null && now < rs) return false;
    if (re != null && now > re) return false;
    return true;
}

/** Drop verbose legacy auto-cards and test seminar clutter from CMS. */
function sanitizeScrollingAnnouncements(arr) {
    if (!Array.isArray(arr)) return [];
    const now = Date.now();
    return arr
        .filter((a) => {
            if (!a || (!a.title && !a.body)) return false;
            if (a.enabled === false || a.enabled === 0 || String(a.enabled).toLowerCase() === 'false') return false;
            const exp = a.expiresAt || a.expiry;
            if (exp) {
                const ex = new Date(String(exp));
                if (!Number.isNaN(ex.getTime()) && ex.getTime() < now) return false;
            }
            const t = String(a.title || '');
            const b = String(a.body || '');
            if (/test seminar/i.test(t) || /introduction to ayurveda/i.test(t)) return false;
            if (t.startsWith('Seminar — ') && b.includes('Apply from the doctor portal') && b.includes(' — ')) {
                return false;
            }
            return true;
        })
        .sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0));
}

function buildSeminarRegistrationAnnouncement(row) {
    const title = row.title || 'Seminar';
    const eventBit = row.event_date
        ? ` Event: ${seminarDt.formatSeminarDateTime(row.event_date)}.`
        : '';
    return {
        title: `Registration open — ${title}`,
        body: `Registration is now open. Apply from the doctor portal.${eventBit}`,
        date: new Date().toISOString().slice(0, 10),
        autoFromSeminarId: row.id,
        link: '/doctor.html'
    };
}

function upsertSeminarScrollingAnnouncement(cms, row, cb) {
    const sid = Number(row.id);
    const arr = sanitizeScrollingAnnouncements(Array.isArray(cms.scrollingAnnouncements) ? cms.scrollingAnnouncements : []);
    const filtered = arr.filter((a) => !(a && Number(a.autoFromSeminarId) === sid));
    filtered.unshift(buildSeminarRegistrationAnnouncement(row));
    cms.scrollingAnnouncements = filtered.slice(0, 40);
    upsertGlobalSetting('public_site_cms', JSON.stringify({ ...cms, version: 1 }), cb);
}

function removeSeminarScrollingAnnouncement(seminarId, cb) {
    const sid = parseInt(seminarId, 10);
    if (Number.isNaN(sid)) return cb && cb(null);
    loadPublicSiteCms((e, cms) => {
        if (e) return cb && cb(e);
        const before = (cms.scrollingAnnouncements || []).length;
        cms.scrollingAnnouncements = sanitizeScrollingAnnouncements(cms.scrollingAnnouncements).filter(
            (a) => !(a && Number(a.autoFromSeminarId) === sid)
        );
        if (cms.scrollingAnnouncements.length === before) return cb && cb(null);
        upsertGlobalSetting('public_site_cms', JSON.stringify({ ...cms, version: 1 }), cb);
    });
}

/** On seminar create only: short homepage slide + doctor notice when registration is already open. */
function announceSeminarRegistrationOnCreate(seminarId, cb) {
    const sid = parseInt(seminarId, 10);
    if (Number.isNaN(sid)) return cb && cb(null);
    db.get(
        `SELECT id, title, description, event_date, registration_start, registration_end, is_active FROM seminars WHERE id = ?`,
        [sid],
        (err, row) => {
            if (err || !row) return cb && cb(err);
            if (!Number(row.is_active) || !isSeminarRegistrationOpen(row)) return cb && cb(null);
            const msg = `${row.title || 'Seminar'}: registration is open. Apply from the doctor portal.`;
            const pushCms = () => {
                loadPublicSiteCms((e2, cms) => {
                    if (e2) return cb && cb(e2);
                    upsertSeminarScrollingAnnouncement(cms, row, cb);
                });
            };
            db.run(`INSERT INTO notices (seminar_id, message, pdf_path) VALUES (?, ?, NULL)`, [sid, msg], () => pushCms());
        }
    );
}

/** Persist CMS cleanup once if legacy verbose announcements were removed. */
function persistScrollingAnnouncementsSanitizeIfNeeded(callback) {
    db.get(`SELECT value FROM global_settings WHERE key = 'public_site_cms'`, [], (err, row) => {
        if (err || !row || !row.value) return callback && callback(null);
        try {
            const parsed = JSON.parse(row.value);
            if (!parsed || !Array.isArray(parsed.scrollingAnnouncements)) return callback && callback(null);
            const cleaned = sanitizeScrollingAnnouncements(parsed.scrollingAnnouncements);
            if (cleaned.length === parsed.scrollingAnnouncements.length) return callback && callback(null);
            parsed.scrollingAnnouncements = cleaned;
            upsertGlobalSetting('public_site_cms', JSON.stringify({ ...parsed, version: 1 }), callback);
        } catch (_) {
            callback && callback(null);
        }
    });
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
    fileStore.persistToGlobalAsset(db, upsertGlobalSetting, req.file, 'cert_', (err, assetPath) => {
        if (err) return cb(err);
        if (assetPath) return cb(null, assetPath);
        cb(null, req.file.filename ? '/uploads/' + req.file.filename : null);
    });
}

const PG_INT_MAX = 2147483647;

/** Internal tickets.id only — not 12-digit e-ticket strings (avoids PG integer overflow). */
function safeInternalTicketRowId(val) {
    const s = String(val || '').trim();
    if (!/^\d{1,9}$/.test(s)) return null;
    const n = parseInt(s, 10);
    if (!Number.isInteger(n) || n < 1 || n > PG_INT_MAX) return null;
    return n;
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

/** Create missing QR tickets for paid orders (Neon backfill / failed verify). */
function backfillTicketsForPaidOrders(cb) {
    db.all(
        `SELECT o.id AS order_db_id, o.order_id_string, o.registration_id, r.user_id, r.application_no
         FROM orders o
         JOIN registrations r ON r.id = o.registration_id
         LEFT JOIN tickets t ON t.order_id = o.id
         WHERE o.status = 'success' AND t.id IS NULL
           AND r.status NOT IN ('rejected', 'cancelled')
         ORDER BY o.id DESC
         LIMIT 500`,
        [],
        (err, rows) => {
            if (err) return cb && cb(err);
            const list = rows || [];
            if (!list.length) return cb && cb(null, 0);
            let i = 0;
            let created = 0;
            const next = () => {
                if (i >= list.length) return cb && cb(null, created);
                const row = list[i++];
                insertParticipantTicket(
                    row.order_db_id,
                    row.user_id,
                    row.order_id_string || '',
                    row.registration_id,
                    row.application_no,
                    (eT, etk) => {
                        if (eT) return cb && cb(eT);
                        if (etk) {
                            created++;
                            notifyTicketIssued(row.user_id, row.registration_id, etk);
                        }
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
    db.get(
        `SELECT r.seminar_id, r.application_no, t.qr_code_data, t.ticket_id_string, t.is_scanned, t.scan_time,
                IFNULL(t.is_valid, 1) AS is_valid, o.status AS payment_status,
                s.title AS seminar_title, s.event_date, s.location_url, s.portal_year,
                u.first_name, u.last_name
         FROM registrations r
         JOIN tickets t ON t.order_id IN (SELECT id FROM orders WHERE registration_id = r.id)
         JOIN orders o ON o.id = t.order_id
         JOIN seminars s ON s.id = r.seminar_id
         JOIN users u ON u.id = r.user_id
         WHERE r.id = ? AND TRIM(t.ticket_id_string) = TRIM(?)`,
        [registrationId, String(ticketId)],
        (e, row) => {
            if (e) return;
            const seminarId = row && row.seminar_id;
            const base = notifEngine.publicBaseUrl();
            const pdfUrl =
                base +
                '/api/doctor/ticket-document/' +
                encodeURIComponent(String(ticketId)) +
                '?userId=' +
                encodeURIComponent(String(userId));
            const vars = {
                ticket_id: ticketId,
                qr_code_url: base + '/doctor.html#tab-tickets',
                ticket_pdf_url: pdfUrl,
                payment_status: 'PAID'
            };
            notifEngine.notify(db, 'TICKET_ISSUED', {
                userId,
                seminarId,
                registrationId,
                vars
            });
            if (row && row.qr_code_data) {
                ticketHtml
                    .buildTicketHtmlFromRow(
                        {
                            ticket_id_string: row.ticket_id_string || ticketId,
                            application_no: row.application_no,
                            seminar_title: row.seminar_title,
                            event_date: row.event_date,
                            location_url: row.location_url,
                            portal_year: row.portal_year,
                            display_name: [row.first_name, row.last_name].filter(Boolean).join(' '),
                            qr_code_data: row.qr_code_data,
                            payment_status: row.payment_status || 'success',
                            is_scanned: row.is_scanned,
                            scan_time: row.scan_time,
                            is_valid: row.is_valid
                        },
                        db
                    )
                    .then((html) => {
                        db.get(`SELECT email, phone FROM users WHERE id = ?`, [userId], (eu, u) => {
                            if (eu || !u) return;
                            const attach = [
                                {
                                    filename: 'E-Ticket-' + String(ticketId).replace(/\W/g, '') + '.html',
                                    content: html,
                                    contentType: 'text/html'
                                }
                            ];
                            const waLine =
                                'Your e-ticket for ' +
                                (row.seminar_title || 'the seminar') +
                                ' is ready.\nTicket ID: ' +
                                ticketId +
                                '\nDownload / print: ' +
                                pdfUrl;
                            if (u.email) {
                                notifEngine.enqueueDirectMessage(
                                    db,
                                    {
                                        channel: 'email',
                                        destination: u.email,
                                        subject: 'Your e-ticket (printable)',
                                        html:
                                            '<p>Your e-ticket is attached. You can also open: <a href="' +
                                            pdfUrl +
                                            '">' +
                                            pdfUrl +
                                            '</a></p>',
                                        text: 'E-ticket: ' + pdfUrl,
                                        event_key: 'TICKET_ISSUED'
                                    },
                                    () => {}
                                );
                            }
                            if (u.phone) {
                                notifEngine.enqueueDirectMessage(
                                    db,
                                    {
                                        channel: 'whatsapp',
                                        destination: u.phone,
                                        body: waLine,
                                        event_key: 'TICKET_ISSUED'
                                    },
                                    () => {}
                                );
                            }
                        });
                    })
                    .catch(() => {});
            }
        }
    );
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
                        if (!err && etk) notifyTicketIssued(userId, registrationId, etk);
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

/** Reuse existing pending order or create one (avoids duplicate pending rows per registration). */
function getOrCreatePendingOrder(registrationId, amount, cb) {
    db.get(
        `SELECT id, order_id_string FROM orders WHERE registration_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`,
        [registrationId],
        (e, row) => {
            if (e) return cb && cb(e);
            if (row) return cb && cb(null, row);
            const orderIdStr = 'ORD_' + generateId();
            db.run(
                `INSERT INTO orders (order_id_string, registration_id, amount, status) VALUES (?, ?, ?, 'pending')`,
                [orderIdStr, registrationId, amount != null ? amount : 1500],
                function (insErr) {
                    if (insErr) return cb && cb(insErr);
                    cb && cb(null, { id: this.lastID, order_id_string: orderIdStr });
                }
            );
        }
    );
}

/**
 * Ensure a participant ticket exists for a registration (admin e_ticket_issued or post-payment).
 * Reuses success order, or promotes pending → success, or creates a success order when allowed.
 */
function ensureParticipantTicketForRegistration(registrationId, options, cb) {
    const opts = options || {};
    const done = typeof cb === 'function' ? cb : () => {};

    db.get(
        `SELECT id, user_id, application_no, status FROM registrations WHERE id = ?`,
        [registrationId],
        (eReg, reg) => {
            if (eReg) return done(eReg);
            if (!reg) return done(new Error('Registration not found'));
            const st = String(reg.status || '').toLowerCase();
            if (st === 'rejected' || st === 'cancelled') {
                return done(null, { skipped: true, reason: 'ineligible' });
            }

            const issueOnOrder = (orderRow, cb2) => {
                if (!orderRow || !orderRow.id) {
                    if (!opts.createOrderIfMissing) return cb2(null, { skipped: true, reason: 'no_order' });
                    const orderIdStr = 'ORD_' + generateId();
                    return db.run(
                        `INSERT INTO orders (order_id_string, registration_id, amount, status, payment_date) VALUES (?, ?, ?, 'success', CURRENT_TIMESTAMP)`,
                        [orderIdStr, registrationId, opts.amount != null ? opts.amount : 1500],
                        function (insErr) {
                            if (insErr) return cb2(insErr);
                            insertParticipantTicket(
                                this.lastID,
                                reg.user_id,
                                orderIdStr,
                                registrationId,
                                reg.application_no,
                                (eT, etk, qr, meta) => {
                                    if (eT) return cb2(eT);
                                    cb2(null, {
                                        orderId: this.lastID,
                                        orderIdString: orderIdStr,
                                        ticketId: etk,
                                        skipped: meta && meta.skipped
                                    });
                                }
                            );
                        }
                    );
                }
                insertParticipantTicket(
                    orderRow.id,
                    reg.user_id,
                    orderRow.order_id_string || '',
                    registrationId,
                    reg.application_no,
                    (eT, etk, qr, meta) => {
                        if (eT) return cb2(eT);
                        cb2(null, {
                            orderId: orderRow.id,
                            orderIdString: orderRow.order_id_string,
                            ticketId: etk,
                            skipped: meta && meta.skipped
                        });
                    }
                );
            };

            db.get(
                `SELECT id, order_id_string, status FROM orders WHERE registration_id = ? AND status = 'success' ORDER BY id DESC LIMIT 1`,
                [registrationId],
                (eS, successOrd) => {
                    if (eS) return done(eS);
                    if (successOrd) {
                        db.run(
                            `DELETE FROM orders WHERE registration_id = ? AND status = 'pending'`,
                            [registrationId],
                            () => issueOnOrder(successOrd, done)
                        );
                        return;
                    }

                    db.get(
                        `SELECT id, order_id_string, status FROM orders WHERE registration_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`,
                        [registrationId],
                        (eP, pendingOrd) => {
                            if (eP) return done(eP);
                            if (pendingOrd && opts.promotePendingToSuccess) {
                                return db.run(
                                    `UPDATE orders SET status = 'success', payment_date = COALESCE(payment_date, CURRENT_TIMESTAMP) WHERE id = ?`,
                                    [pendingOrd.id],
                                    (eU) => {
                                        if (eU) return done(eU);
                                        issueOnOrder(
                                            { id: pendingOrd.id, order_id_string: pendingOrd.order_id_string },
                                            done
                                        );
                                    }
                                );
                            }
                            issueOnOrder(pendingOrd, done);
                        }
                    );
                }
            );
        }
    );
}

/** Mark payment success on existing pending order (or insert one) and issue ticket — no duplicate rows. */
function fulfillRegistrationPayment(registrationId, userId, amount, gatewayName, providerTxnId, cb) {
    db.get(
        `SELECT id, order_id_string FROM orders WHERE registration_id = ? AND status = 'success' ORDER BY id DESC LIMIT 1`,
        [registrationId],
        (eExist, paid) => {
            if (eExist) return cb(eExist);
            if (paid) {
                return db.get(
                    `SELECT application_no FROM registrations WHERE id = ?`,
                    [registrationId],
                    (gErr, regRow) => {
                        if (gErr) return cb(gErr);
                        insertParticipantTicket(
                            paid.id,
                            userId,
                            paid.order_id_string || '',
                            registrationId,
                            regRow && regRow.application_no,
                            (eT, etk, qr, meta) =>
                                cb(eT, {
                                    orderId: paid.id,
                                    orderIdString: paid.order_id_string,
                                    alreadyPaid: true,
                                    ticketId: etk,
                                    skipped: meta && meta.skipped
                                })
                        );
                    }
                );
            }

            db.get(
                `SELECT id, order_id_string FROM orders WHERE registration_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`,
                [registrationId],
                (eP, pending) => {
                    if (eP) return cb(eP);

                    const applySuccess = (orderDbId, orderStr) => {
                        db.run(
                            `UPDATE orders SET status = 'success', payment_date = CURRENT_TIMESTAMP, payment_gateway = ?, provider_transaction_id = ? WHERE id = ?`,
                            [gatewayName || 'mock', providerTxnId || null, orderDbId],
                            (uErr) => {
                                if (uErr) return cb(uErr);
                                db.run(`DELETE FROM orders WHERE registration_id = ? AND status = 'pending' AND id != ?`, [
                                    registrationId,
                                    orderDbId
                                ]);
                                db.run(`UPDATE registrations SET status = 'completed' WHERE id = ?`, [registrationId]);
                                activityLog.logActivity(db, {
                                    user_id: userId,
                                    action: 'payment.completed',
                                    resource_type: 'registration',
                                    resource_id: String(registrationId),
                                    meta: {
                                        gateway: gatewayName || 'mock',
                                        order_id: orderStr,
                                        provider_txn: providerTxnId || null
                                    }
                                });
                                db.get(
                                    `SELECT application_no FROM registrations WHERE id = ?`,
                                    [registrationId],
                                    (gErr, regRow) => {
                                        if (gErr) return cb(gErr);
                                        insertParticipantTicket(
                                            orderDbId,
                                            userId,
                                            orderStr,
                                            registrationId,
                                            regRow && regRow.application_no,
                                            (eT, etk, qr, meta) =>
                                                cb(eT, {
                                                    orderId: orderDbId,
                                                    orderIdString: orderStr,
                                                    ticketId: etk,
                                                    skipped: meta && meta.skipped
                                                })
                                        );
                                    }
                                );
                            }
                        );
                    };

                    if (pending) return applySuccess(pending.id, pending.order_id_string);

                    const orderIdStr = 'ORD_' + generateId();
                    db.run(
                        `INSERT INTO orders (order_id_string, registration_id, amount, status, payment_date, payment_gateway, provider_transaction_id) VALUES (?, ?, ?, 'success', CURRENT_TIMESTAMP, ?, ?)`,
                        [orderIdStr, registrationId, amount, gatewayName || 'mock', providerTxnId || null],
                        function (insErr) {
                            if (insErr) return cb(insErr);
                            applySuccess(this.lastID, orderIdStr);
                        }
                    );
                }
            );
        }
    );
}

const casePresentation = require('./lib/case-presentation');

let extendedRoutesMounted = false;
function mountExtendedRoutes() {
    if (extendedRoutesMounted) return;
    extendedRoutesMounted = true;
    casePresentation.registerCasePresentationRoutes(app, {
        db,
        upload: caseUpload,
        generateId,
        fileStore,
        uploadsDir
    });
    try {
        require('./lib/routes-ext')(app, {
            db,
            upload: caseUpload,
            generateId,
            fileStore,
            uploadsDir,
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
        casePresentation.registerCasePresentationRoutes(app, {
        db,
        upload: caseUpload,
        generateId,
        fileStore,
        uploadsDir
    });
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
        portalAuthPolicy.loadPortalAuthConfig(db, (e2) => {
            if (e2) console.warn('[portal-auth-policy]', e2.message);
            next();
        });
    });
}

function integrationSettingsJson(data) {
    const masked = integrationSettings.maskSecretsForClient(data);
    masked.email_configured = integrationSettings.isEmailConfiguredFromSettings();
    masked.email_status = integrationSettings.getEmailConfigStatus();
    masked.whatsapp_configured = integrationSettings.isWhatsAppConfiguredFromSettings();
    masked.whatsapp_status = integrationSettings.getWhatsAppConfigStatus();
    return masked;
}

app.get('/api/admin/integrations', withIntegrationSettingsLoaded, (req, res) => {
    const masked = integrationSettingsJson(integrationSettings.getRuntimeIntegrations());
    db.get(
        `SELECT whatsapp_template_name, email_subject FROM notification_templates
         WHERE event_key = 'OTP_VERIFICATION' AND seminar_id IS NULL LIMIT 1`,
        [],
        async (e, row) => {
            if (!e && row) {
                if (row.whatsapp_template_name && !masked.whatsapp_otp_template_name) {
                    masked.whatsapp_otp_template_name = row.whatsapp_template_name;
                }
                if (row.email_subject) masked.otp_email_subject = row.email_subject;
            }
            try {
                const dbg = await notifEngine.getOtpWhatsAppTemplateDebug(db);
                masked.otp_template_resolved = dbg.resolved;
                masked.otp_template_source = dbg.source;
                if (dbg.resolved) {
                    const { debugWhatsAppTemplateLookup } = require('./lib/whatsapp-service');
                    const metaDbg = await debugWhatsAppTemplateLookup(dbg.resolved);
                    masked.otp_template_meta_languages = metaDbg.languages || [];
                    masked.whatsapp_waba_id = metaDbg.wabaId || '';
                    masked.whatsapp_template_check_error = metaDbg.error || '';
                    masked.whatsapp_template_check_hint = metaDbg.hint || '';
                }
            } catch (_) {}
            res.json(masked);
        }
    );
});

app.get('/api/admin/integrations/whatsapp-event-templates', withIntegrationSettingsLoaded, (req, res) => {
    const { EVENT_KEYS } = require('./lib/notification-defaults');
    const rt = integrationSettings.getRuntimeIntegrations();
    const langMap =
        rt.whatsapp_event_templates && typeof rt.whatsapp_event_templates === 'object'
            ? rt.whatsapp_event_templates
            : {};
    db.all(
        `SELECT event_key, channel, email_subject, whatsapp_template_name
         FROM notification_templates WHERE seminar_id IS NULL`,
        [],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            const byKey = {};
            (rows || []).forEach((r) => {
                byKey[r.event_key] = r;
            });
            const list = EVENT_KEYS.map((key) => {
                const row = byKey[key] || {};
                const extra = langMap[key] || {};
                return {
                    event_key: key,
                    channel: row.channel || 'both',
                    email_subject: row.email_subject || '',
                    whatsapp_template_name: row.whatsapp_template_name || extra.name || '',
                    whatsapp_template_lang: extra.lang || ''
                };
            });
            res.json(list);
        }
    );
});

app.post('/api/admin/integrations/whatsapp-event-templates', withIntegrationSettingsLoaded, (req, res) => {
    const templates = Array.isArray(req.body && req.body.templates) ? req.body.templates : [];
    if (!templates.length) return res.json({ success: true, updated: 0 });

    const langMap = {};
    let pending = templates.length;
    let updated = 0;
    let lastErr = null;

    templates.forEach((row) => {
        const eventKey = String(row.event_key || '').trim();
        if (!eventKey) {
            if (--pending === 0) finish();
            return;
        }
        const waName = String(row.whatsapp_template_name || '').trim();
        const waLang = String(row.whatsapp_template_lang || '').trim();
        langMap[eventKey] = { name: waName, lang: waLang };

        db.run(
            `UPDATE notification_templates SET whatsapp_template_name = ?, updated_at = CURRENT_TIMESTAMP
             WHERE event_key = ? AND seminar_id IS NULL`,
            [waName, eventKey],
            function (uerr) {
                if (uerr) {
                    lastErr = uerr;
                    if (--pending === 0) finish();
                    return;
                }
                updated += this.changes;
                if (this.changes === 0) {
                    db.run(
                        `INSERT INTO notification_templates (event_key, seminar_id, enabled, channel, whatsapp_template_name, whatsapp_body, version)
                         VALUES (?, NULL, 1, 'both', ?, '', 1)`,
                        [eventKey, waName],
                        function (ierr) {
                            if (!ierr) updated += 1;
                            else lastErr = ierr;
                            if (--pending === 0) finish();
                        }
                    );
                } else if (--pending === 0) finish();
            }
        );
    });

    function finish() {
        if (lastErr) return res.status(500).json({ error: lastErr.message });
        const rt = integrationSettings.getRuntimeIntegrations();
        const existing =
            rt.whatsapp_event_templates && typeof rt.whatsapp_event_templates === 'object'
                ? rt.whatsapp_event_templates
                : {};
        const mergedLang = Object.assign({}, existing, langMap);
        integrationSettings.saveToDb(db, { whatsapp_event_templates: mergedLang }, (err2) => {
            if (err2) return res.status(500).json({ error: err2.message });
            res.json({ success: true, updated, languages: langMap });
        });
    }
});

app.post('/api/admin/integrations', withIntegrationSettingsLoaded, (req, res) => {
    const body = req.body || {};
    integrationSettings.saveToDb(db, body, (err, merged) => {
        if (err) return res.status(500).json({ error: err.message });
        if (body.public_base_url) {
            upsertGlobalSetting('domain', String(body.public_base_url).replace(/^https?:\/\//, ''), () => {});
        }
        notifEngine.syncOtpNotificationDefaults(db, body, () => {
            res.json({
                success: true,
                settings: integrationSettingsJson(merged),
                email_configured: integrationSettings.isEmailConfiguredFromSettings(),
                email_status: integrationSettings.getEmailConfigStatus(),
                whatsapp_configured: integrationSettings.isWhatsAppConfiguredFromSettings()
            });
        });
    });
});

function smtpOverridesFromBody(body) {
    const b = body || {};
    const o = {};
    if (b.zoho_host != null && String(b.zoho_host).trim()) o.zoho_host = String(b.zoho_host).trim();
    if (b.zoho_port != null && String(b.zoho_port).trim()) o.zoho_port = String(b.zoho_port).trim();
    if (b.zoho_user != null && String(b.zoho_user).trim()) o.zoho_user = String(b.zoho_user).trim();
    if (b.zoho_from != null && String(b.zoho_from).trim()) o.zoho_from = String(b.zoho_from).trim();
    if (b.zoho_pass != null && String(b.zoho_pass).trim() && !integrationSettings.isMaskedSecretValue(b.zoho_pass)) {
        o.zoho_pass = String(b.zoho_pass).trim();
    }
    return Object.keys(o).length ? o : null;
}

app.post('/api/admin/integrations/test-email', withIntegrationSettingsLoaded, async (req, res) => {
    const to = String((req.body && req.body.to) || '').trim();
    if (!to) return res.status(400).json({ error: 'to email required' });
    const overrides = smtpOverridesFromBody(req.body);
    const { verifySmtpConnection, sendEmail } = require('./lib/email-service');
    const verify = await verifySmtpConnection(overrides || undefined);
    if (!verify.ok) {
        const errText = [verify.error, verify.hint].filter(Boolean).join(' ');
        notifEngine.logNotification(db, {
            event_key: 'INTEGRATION_TEST_EMAIL',
            channel: 'email',
            destination: to,
            status: 'failed',
            subject: 'VGMF test email',
            body_preview: 'SMTP verify failed',
            error: errText
        });
        return res.status(503).json({
            error: verify.error || 'SMTP login failed',
            hint: verify.hint,
            skipped: verify.skipped,
            logged: true
        });
    }
    const subject = 'VGMF test email';
    const html = '<p>SMTP test from seminar admin integrations panel.</p>';
    const r = await sendEmail(to, subject, html, {
        text: 'SMTP test from seminar admin.',
        smtpOverrides: overrides || undefined
    });
    const logStatus = r.ok ? 'sent' : r.skipped ? 'skipped' : 'failed';
    const logError = r.ok ? null : [r.error, r.hint].filter(Boolean).join(' ');
    notifEngine.logNotification(db, {
        event_key: 'INTEGRATION_TEST_EMAIL',
        channel: 'email',
        destination: to,
        status: logStatus,
        subject,
        body_preview: 'SMTP integration test',
        error: logError
    });
    if (r.ok) return res.json({ success: true, logged: true, from: verify.from });
    res.status(503).json({
        error: r.error || 'Send failed',
        hint: r.hint,
        skipped: r.skipped,
        logged: true
    });
});

app.get('/api/admin/integrations/whatsapp-template-check', withIntegrationSettingsLoaded, async (req, res) => {
    const name =
        (req.query && req.query.name) || (await notifEngine.getOtpWhatsAppTemplateName(db)) || 'vgmf_otp_auth';
    const { debugWhatsAppTemplateLookup } = require('./lib/whatsapp-service');
    try {
        const result = await debugWhatsAppTemplateLookup(name);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/integrations/test-whatsapp', withIntegrationSettingsLoaded, async (req, res) => {
    const phone = String((req.body && req.body.phone) || '').trim();
    if (!phone) return res.status(400).json({ error: 'phone required' });
    const {
        sendWhatsAppText,
        sendWhatsAppOtpTemplate,
        normalizePhoneE164,
        isWhatsAppConfigured
    } = require('./lib/whatsapp-service');
    if (!isWhatsAppConfigured()) {
        return res.status(503).json({ error: 'WhatsApp not configured — save access token and phone number ID first.' });
    }
    const to = normalizePhoneE164(phone);
    const tplDebug = await notifEngine.getOtpWhatsAppTemplateDebug(db);
    const otpTpl = tplDebug.resolved;
    let r;
    let method = 'plain_text';
    if (otpTpl) {
        method = 'otp_template:' + otpTpl + ' lang:' + (tplDebug.lang || 'en');
        r = await sendWhatsAppOtpTemplate(phone, otpTpl, '123456');
    } else {
        r = await sendWhatsAppText(
            phone,
            'VGMF test from admin. Reply to this chat to open the 24-hour window, or set OTP_VERIFICATION Meta template name for outbound OTP.'
        );
    }
    const logRow = {
        event_key: 'INTEGRATION_TEST_WHATSAPP',
        channel: 'whatsapp',
        destination: to,
        status: r.ok ? 'accepted' : 'failed',
        provider_message_id: r.messageId || null,
        subject: 'Admin WhatsApp test',
        body_preview:
            method +
            (otpTpl ? ' code=123456' : '') +
            (tplDebug.source ? ' src=' + tplDebug.source : '') +
            (r.triedMethods ? ' tries=' + String(r.triedMethods).slice(0, 200) : '') +
            (r.messageId ? ' id=' + r.messageId : ''),
        error: r.ok ? null : (r.error || '').slice(0, 900)
    };
    let deliveryInfo = null;
    if (r.ok && r.messageId) {
        deliveryInfo = await new Promise((resolve) => {
            whatsappWebhook.waitForDeliveryUpdate(db, r.messageId, 12000, (e, info) => {
                resolve(info || { status: 'accepted', events: [] });
            });
        });
        if (deliveryInfo && deliveryInfo.status && deliveryInfo.status !== 'accepted') {
            logRow.status = deliveryInfo.status;
            if (deliveryInfo.error) logRow.error = deliveryInfo.error;
        } else if (deliveryInfo && deliveryInfo.timeout) {
            logRow.error =
                (logRow.error || '') +
                ' No delivery webhook yet — fix Meta webhook (Check webhook in admin).';
        }
    }
    notifEngine.logNotification(db, logRow);

    const phoneDiag = await require('./lib/whatsapp-service').getWhatsAppPhoneDiagnostics();

    if (r.ok) {
        const lines = [
            deliveryInfo && deliveryInfo.status
                ? 'Delivery status: ' + deliveryInfo.status
                : 'Meta accepted the message (API ok).',
            r.messageId ? 'Message ID: ' + r.messageId : '',
            r.method ? 'Send method: ' + r.method : method,
            deliveryInfo && deliveryInfo.error ? 'Meta error: ' + deliveryInfo.error : '',
            phoneDiag.quality_rating ? 'Phone quality: ' + phoneDiag.quality_rating : '',
            phoneDiag.display_phone_number
                ? 'Business number: ' + phoneDiag.display_phone_number
                : ''
        ].filter(Boolean);
        if (deliveryInfo && deliveryInfo.status === 'failed') {
            lines.push(
                'Fix: add +' + to + ' as Meta test recipient (dev mode), or move app Live with approved template.'
            );
        } else if (!deliveryInfo || deliveryInfo.status === 'accepted' || deliveryInfo.timeout) {
            lines.push(
                'If still no message on phone: Meta → WhatsApp → API Setup → add +' +
                    to +
                    ' as test recipient. Then Check webhook and Save verify token.'
            );
        }
        return res.json({
            success: true,
            to,
            method: r.method || method,
            template: otpTpl,
            templateSource: tplDebug.source,
            lang: r.lang || tplDebug.lang,
            metaLangs: r.metaLangs || [],
            messageId: r.messageId || null,
            delivery: deliveryInfo,
            phoneDiagnostics: phoneDiag,
            hint: lines.join('\n')
        });
    }
    res.status(503).json({
        error: r.error || 'Send failed',
        to,
        method,
        template: otpTpl,
        templateSource: tplDebug.source,
        templateRaw: tplDebug.raw,
        lang: r.lang || tplDebug.lang,
        metaLangs: r.metaLangs || [],
        triedLangs: r.triedLangs || [],
        skipped: r.skipped,
        hint:
            'Meta rejected template "' +
            (otpTpl || tplDebug.raw || '?') +
            '". ' +
            (r.metaLangs && r.metaLangs.length
                ? 'Use Template language: ' + r.metaLangs.join(' or ') + ' (from Meta). '
                : 'Set Template language in Integrations (try en, then en_US). ') +
            (r.triedLangs && r.triedLangs.length ? 'Tried: ' + r.triedLangs.join(', ') + '. ' : '') +
            'Add +' +
            to +
            ' as test recipient in development mode.'
    });
});

function validateDoctorName(name) {
    return validatePersonName(name, 'Name');
}

// --- API ENDPOINTS ---

function signupOtpRequired() {
    return portalAuthPolicy.signupOtpRequired();
}

function loginOtpRequired() {
    return portalAuthPolicy.loginOtpRequired();
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

app.get('/api/auth/signup-otp-required', withIntegrationSettingsLoaded, (req, res) => {
    res.json({ required: signupOtpRequired() });
});

app.get('/api/auth/login-otp-required', withIntegrationSettingsLoaded, (req, res) => {
    res.json({ required: loginOtpRequired() });
});

app.get('/api/auth/email-available', (req, res) => {
    const email = String((req.query && req.query.email) || '')
        .trim()
        .toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email is required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Enter a valid email address' });
    }
    const emailNorm = authUsers.normalizeEmail(email);
    db.get(`SELECT id FROM users WHERE ${authUsers.sqlEmailMatches('email')}`, [emailNorm], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ available: !row });
    });
});

/** Check whether an email is registered before login OTP (no password). */
app.post('/api/auth/login-otp/precheck', (req, res) => {
    const emailNorm = authUsers.normalizeEmail((req.body && req.body.email) || '');
    if (!emailNorm) return res.status(400).json({ error: 'Email is required' });
    authUsers.findUserByEmail(db, emailNorm, (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) {
            return res.json({
                exists: false,
                needsSignup: true,
                message: 'No account found with this email. Please create an account first.'
            });
        }
        res.json({
            exists: true,
            needsSignup: false,
            disabled: false,
            maskedPhone: row.phone ? String(row.phone).replace(/\d(?=\d{4})/g, '•') : ''
        });
    });
});

function resolveLoginUserForOtp(email, password, cb) {
    const emailNorm = authUsers.normalizeEmail(email);
    if (!emailNorm) return cb(null, { status: 400, error: 'Email is required' });
    authUsers.findUserByEmail(db, emailNorm, (err, row) => {
        if (err) return cb(err);
        if (!row) {
            return cb(null, {
                status: 401,
                error: 'No account found with this email. Please create an account first.',
                needsSignup: true
            });
        }
        const pw = password != null && password !== undefined ? String(password) : '';
        if (pw && row.password !== pw) {
            return cb(null, {
                status: 401,
                error: 'Invalid password. Use Forgot password or check your password.',
                needsSignup: false
            });
        }
        cb(null, { status: 200, row });
    });
}

/** Find account by email and send login OTP to registered email + WhatsApp. */
app.post('/api/auth/login-otp/send-both', withIntegrationSettingsLoaded, (req, res) => {
    const { email, password } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email is required' });
    resolveLoginUserForOtp(email, password, (err, out) => {
        if (err) return res.status(500).json({ error: err.message });
        if (out.status !== 200) {
            return res.status(out.status).json({ error: out.error, needsSignup: !!out.needsSignup });
        }
        authLoginOtp.sendLoginOtpsForUser(db, out.row, (e2, result) => {
            if (e2) return res.status(500).json({ error: e2.message });
            if (!result.ok) {
                return res.status(result.status || 503).json({
                    error: result.error || 'Could not deliver OTP on all channels. Check messaging configuration.',
                    channels: result.results
                });
            }
            res.json({ success: true, ttlMinutes: result.ttlMinutes, channels: result.results });
        });
    });
});

/** Send login OTP to one channel (email or phone) for the account matching email. */
app.post('/api/auth/login-otp/send', withIntegrationSettingsLoaded, (req, res) => {
    const { email, password, channel } = req.body || {};
    if (!email || !channel) return res.status(400).json({ error: 'email and channel are required' });
    if (channel !== 'phone' && channel !== 'email') {
        return res.status(400).json({ error: 'channel must be phone or email' });
    }
    resolveLoginUserForOtp(email, password, (err, out) => {
        if (err) return res.status(500).json({ error: err.message });
        if (out.status !== 200) {
            return res.status(out.status).json({ error: out.error, needsSignup: !!out.needsSignup });
        }
        authLoginOtp.sendLoginOtpChannel(db, out.row, channel, (e2, result) => {
            if (e2) return res.status(500).json({ error: e2.message });
            if (!result.ok) {
                return res.status(result.status || 503).json({ error: result.error || 'Could not deliver OTP.' });
            }
            const payload = { success: true, ttlMinutes: result.ttlMinutes };
            if (result.debugCode) payload.debugCode = result.debugCode;
            if (result.warning) payload.warning = result.warning;
            res.json(payload);
        });
    });
});

app.post('/api/auth/login-otp/verify', (req, res) => {
    const { email, password, channel, code } = req.body || {};
    if (!email || !channel || !code) {
        return res.status(400).json({ error: 'email, channel, and code are required' });
    }
    if (channel !== 'phone' && channel !== 'email') {
        return res.status(400).json({ error: 'channel must be phone or email' });
    }
    resolveLoginUserForOtp(email, password, (err, out) => {
        if (err) return res.status(500).json({ error: err.message });
        if (out.status !== 200) {
            return res.status(out.status).json({ error: out.error, needsSignup: !!out.needsSignup });
        }
        const row = out.row;
        const dest = authUsers.loginOtpDestination(channel, row);
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
    });
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
    if (purpose === 'registration_submit' && Number.isNaN(meta.seminarId)) {
        return res.status(400).json({ error: 'seminarId required for submit OTP' });
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

function hashEmailVerifyToken(raw) {
    return crypto.createHash('sha256').update(String(raw).trim(), 'utf8').digest('hex');
}

function queuePortalEmailVerification(db, userId, cb) {
    portalAuthPolicy.loadPortalAuthConfig(db, (ePol) => {
        if (ePol) return cb && cb(ePol);
        if (!portalAuthPolicy.getPortalAuthConfig().requireEmailVerification) {
            return cb && cb(null, { skipped: true });
        }
        db.get(
            `SELECT id, first_name, middle_name, last_name, email, IFNULL(email_verified,1) AS email_verified FROM users WHERE id = ?`,
            [userId],
            (eu, u) => {
                if (eu) return cb && cb(eu);
                if (!u || !u.email) return cb && cb(null, { skipped: true });
                if (Number(u.email_verified) === 1) return cb && cb(null, { skipped: true });
                const rawToken = crypto.randomBytes(32).toString('hex');
                const th = hashEmailVerifyToken(rawToken);
                const exp = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
                db.run(`UPDATE email_verify_tokens SET consumed = 1 WHERE user_id = ? AND consumed = 0`, [userId], () => {
                    db.run(
                        `INSERT INTO email_verify_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)`,
                        [userId, th, exp],
                        function (ierr) {
                            if (ierr) return cb && cb(ierr);
                            const verify_link =
                                notifEngine.publicBaseUrl() + '/api/auth/verify-email?t=' + encodeURIComponent(rawToken);
                            notifEngine.notify(
                                db,
                                'EMAIL_VERIFICATION',
                                {
                                    userId,
                                    vars: { verify_link }
                                },
                                () => cb && cb(null, { queued: true })
                            );
                        }
                    );
                });
            }
        );
    });
}

function requireAdminSensitiveOtpIfEnabled(actorAdminId, phoneTok, emailTok, next) {
    portalAuthPolicy.loadPortalAuthConfig(db, () => {
        if (!portalAuthPolicy.getPortalAuthConfig().requireAdminOtpForSensitive) {
            return next(null, true, null);
        }
        const aid = parseInt(actorAdminId, 10);
        if (!Number.isInteger(aid) || aid < 1) {
            return next(null, false, 'actingAdminId is required when admin confirmation OTP is enabled.');
        }
        if (!phoneTok || !emailTok) {
            return next(
                null,
                false,
                'Admin email and WhatsApp OTP verification is required for this action. Send codes to your admin phone and email, then verify.'
            );
        }
        otpLib.validateAdminConfirmOtpTokens(db, aid, { phoneToken: phoneTok, emailToken: emailTok }, (e, vr) => {
            if (e) return next(e);
            if (!vr || !vr.ok) return next(null, false, (vr && vr.error) || 'Invalid admin OTP');
            next(null, true, null);
        });
    });
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

    portalAuthPolicy.loadPortalAuthConfig(db, (e0) => {
        if (e0) console.warn('[portal-auth-policy] signup', e0.message);
        if (!portalAuthPolicy.getPortalAuthConfig().showSignup) {
            return res.status(403).json({
                error: 'New account registration is currently closed. Please sign in if you already have an account.'
            });
        }
        const evFlag = portalAuthPolicy.getPortalAuthConfig().requireEmailVerification ? 0 : 1;

        function insertUser() {
            const userIdStr = generateId();
            const userRole = role || 'doctor';
            const cleanFirstName = firstNameValidation.cleanedName;
            const cleanLastName = lastNameValidation.cleanedName;
            db.run(
                `INSERT INTO users (user_id_string, first_name, last_name, email, phone, password, role, user_role, email_verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [userIdStr, cleanFirstName, cleanLastName, emailNorm, phoneNorm, password, userRole, userRole, evFlag],
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
                                temporary_password: String(password || '')
                            }
                        },
                        () => {}
                    );
                    designatedNotify.notifyDesignatedAccountCreated(
                        db,
                        newUserId,
                        { source: 'public signup', temporary_password: String(password || '') },
                        () => {}
                    );
                    if (evFlag === 0) {
                        queuePortalEmailVerification(db, newUserId, () => {});
                    }
                    activityLog.logFromRequest(db, req, {
                        user_id: newUserId,
                        action: 'auth.signup',
                        meta: { email: emailNorm, user_id_string: userIdStr }
                    });
                    res.json({
                        success: true,
                        userId: newUserId,
                        user_id_string: userIdStr,
                        needsEmailVerification: evFlag === 0,
                        message:
                            evFlag === 0
                                ? 'Signup successful! Check your email to verify your address, then sign in.'
                                : 'Signup successful! Please create your profile before applying.'
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
});

// 2. Auth: Login (optional phone + email OTP when messaging is configured)
app.post('/api/auth/login', (req, res) => {
    const { email, password, phoneOtpToken, emailOtpToken } = req.body;
    if (!email || password === undefined || password === null) {
        return res.status(400).json({ error: 'Email and password are required' });
    }
    const emailNorm = authUsers.normalizeEmail(email);
    portalAuthPolicy.loadPortalAuthConfig(db, (ePol) => {
        if (ePol) console.warn('[portal-auth-policy] login', ePol.message);
        authUsers.findUserByEmailAndPassword(db, emailNorm, password, (err, row) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!row) {
                    return authUsers.findUserByEmail(db, emailNorm, (e2, exists) => {
                        if (e2) return res.status(500).json({ error: e2.message });
                        if (!exists) {
                            return res.status(401).json({
                                error: 'No account found with this email. Please create an account first.',
                                needsSignup: true
                            });
                        }
                        return res.status(401).json({ error: 'Invalid password. Use Forgot password if needed.' });
                    });
                }
                if (Number(row.is_banned) === 1) {
                    return res.status(403).json({
                        error: 'Your account has been banned. Please contact the foundation office.',
                        accountBanned: true
                    });
                }
                if (Number(row.is_disabled) === 1) {
                    return res.status(403).json({ error: 'Your account has been disabled. Please contact support.' });
                }
                if (portalAuthPolicy.getPortalAuthConfig().requireEmailVerification && Number(row.email_verified) === 0) {
                    return res.status(403).json({
                        error: 'Please verify your email before signing in. Check your inbox for the verification link.',
                        needsEmailVerification: true,
                        email: row.email
                    });
                }

                function sendUser() {
                    recordUserLogin(row.id, (eLogin, times) => {
                        if (!eLogin && times) {
                            row.previous_login_at = times.previousLoginAt || null;
                            row.login_at = times.loginAt;
                            row.last_login_at = times.loginAt;
                        }
                        activityLog.logFromRequest(db, req, {
                            user_id: row.id,
                            user_role: row.role || row.user_role,
                            action: 'auth.login',
                            meta: { email: row.email, user_id_string: row.user_id_string }
                        });
                        delete row.password;
                        normalizeAuthUserRow(row);
                        res.json({ success: true, user: row });
                    });
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
        });
    });
});

app.get('/api/auth/verify-email', (req, res) => {
    const token = String((req.query && (req.query.token || req.query.t)) || '').trim();
    if (!token) return res.status(400).send('Missing verification token.');
    const th = hashEmailVerifyToken(token);
    const now = new Date().toISOString();
    db.get(
        `SELECT id, user_id FROM email_verify_tokens WHERE token_hash = ? AND consumed = 0 AND expires_at > ?`,
        [th, now],
        (e, tok) => {
            if (e) return res.status(500).send(e.message);
            if (!tok) return res.status(400).send('Invalid or expired verification link.');
            db.run(`UPDATE email_verify_tokens SET consumed = 1 WHERE id = ?`, [tok.id], () => {
                db.run(`UPDATE users SET email_verified = 1 WHERE id = ?`, [tok.user_id], () => {
                    const base = notifEngine.publicBaseUrl() || '';
                    res.redirect(base + '/?emailVerified=1');
                });
            });
        }
    );
});

app.post('/api/auth/resend-verification', (req, res) => {
    const { email, password } = req.body || {};
    const emailNorm = String(email || '').trim().toLowerCase();
    if (!emailNorm || password === undefined || password === null) {
        return res.status(400).json({ error: 'Email and password are required' });
    }
    authUsers.findUserByEmailAndPassword(db, emailNorm, password, (e, row) => {
            if (e) return res.status(500).json({ error: e.message });
            if (!row) return res.status(401).json({ error: 'Invalid credentials' });
            if (Number(row.email_verified) === 1) {
                return res.status(400).json({ error: 'This email is already verified.' });
            }
            queuePortalEmailVerification(db, row.id, (qe) => {
                if (qe) return res.status(500).json({ error: qe.message });
                res.json({ success: true, message: 'Verification email queued. Check your inbox.' });
            });
    });
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
                submitOtpRequired: false,
                ...flags
            };
            if (sid != null && !Number.isNaN(sid)) {
                db.get(`SELECT otp_on_application FROM seminars WHERE id = ?`, [sid], (e2, row) => {
                    if (e2) return res.status(500).json({ error: e2.message });
                    const otpOn = !!(row && Number(row.otp_on_application) === 1);
                    res.json({
                        ...base,
                        otpOnApplication: otpOn,
                        submitOtpRequired: otpOn,
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
        `SELECT id, title, event_date, public_list_enabled FROM seminars
         WHERE IFNULL(is_active, 1) = 1
         ORDER BY event_date DESC, id DESC`,
        [],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            const list = (rows || [])
                .filter((s) => isPublicListEnabled(s.public_list_enabled))
                .map((s) => ({ id: s.id, title: s.title, event_date: s.event_date }));
            res.json(list);
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
            if (!sem || !isPublicListEnabled(sem.public_list_enabled)) {
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

function enrichSiteCmsSpeakers(cms, cb) {
    const configured = (Array.isArray(cms.speakers) ? cms.speakers : []).filter(
        (s) => s && String(s.name || s.image || s.imagePath || '').trim()
    );
    if (configured.length) {
        cms.speakers = configured;
        return cb(null, cms);
    }
    db.all(
        `SELECT es.speaker_name, es.speaker_bio, es.description, es.title, s.title AS seminar_title
         FROM event_schedules es
         LEFT JOIN seminars s ON es.seminar_id = s.id
         WHERE TRIM(COALESCE(es.speaker_name, '')) <> ''
         ORDER BY es.start_time IS NULL, es.start_time ASC, es.id ASC
         LIMIT 48`,
        [],
        (err, rows) => {
            if (err) return cb(err);
            const seen = new Set();
            const speakers = [];
            (rows || []).forEach((r) => {
                const name = String(r.speaker_name || '').trim();
                if (!name) return;
                const key = name.toLowerCase();
                if (seen.has(key)) return;
                seen.add(key);
                const role =
                    String(r.title || r.description || r.speaker_bio || '').trim() || 'Featured faculty';
                speakers.push({
                    name,
                    role,
                    seminar: r.seminar_title || '',
                    org: ''
                });
            });
            cms.speakers = speakers;
            cb(null, cms);
        }
    );
}

function mergeScrollingAnnouncementsWithOpenSeminars(cms, cb) {
    db.all(
        `SELECT id, title, event_date, registration_start, registration_end, is_active
         FROM seminars WHERE is_active = 1
         ORDER BY COALESCE(registration_start, event_date) DESC`,
        [],
        (err, rows) => {
            if (err) return cb(err);
            const base = sanitizeScrollingAnnouncements(cms.scrollingAnnouncements || []);
            const bySeminarId = new Map();
            base.forEach((a) => {
                if (a && a.autoFromSeminarId != null) bySeminarId.set(Number(a.autoFromSeminarId), a);
            });
            (rows || []).forEach((row) => {
                if (!Number(row.is_active) || !isSeminarRegistrationOpen(row)) return;
                const rowTitle = String(row.title || '');
                if (/test seminar/i.test(rowTitle) || /introduction to ayurveda/i.test(rowTitle)) return;
                const sid = Number(row.id);
                if (!bySeminarId.has(sid)) bySeminarId.set(sid, buildSeminarRegistrationAnnouncement(row));
                else {
                    const built = buildSeminarRegistrationAnnouncement(row);
                    bySeminarId.set(sid, { ...bySeminarId.get(sid), ...built, title: built.title, body: built.body });
                }
            });
            const manual = base.filter((a) => !a || a.autoFromSeminarId == null);
            const auto = Array.from(bySeminarId.values());
            cms.scrollingAnnouncements = [...auto, ...manual].slice(0, 40);
            cb(null, cms);
        }
    );
}

app.get('/api/public/site-cms', (req, res) => {
    loadPublicSiteCms((e, cms) => {
        if (e) return res.status(500).json({ error: e.message });
        mergeScrollingAnnouncementsWithOpenSeminars(cms, (e2, enriched) => {
            if (e2) return res.status(500).json({ error: e2.message });
            enrichSiteCmsSpeakers(enriched, (e3, withSpeakers) => {
                if (e3) return res.status(500).json({ error: e3.message });
                res.json(withSpeakers);
            });
        });
    });
});

app.post('/api/admin/site-cms', (req, res) => {
    const incoming = req.body && req.body.cms;
    if (!incoming || typeof incoming !== 'object') {
        return res.status(400).json({ error: 'cms object required' });
    }
    for (let i = 0; i < ['doctorUpdates', 'slides', 'publicNotices', 'reviews', 'scrollingAnnouncements', 'aboutSections', 'socialLinks', 'pastSeminarGallery', 'speakers'].length; i++) {
        const k = ['doctorUpdates', 'slides', 'publicNotices', 'reviews', 'scrollingAnnouncements', 'aboutSections', 'socialLinks', 'pastSeminarGallery', 'speakers'][i];
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
        ['doctorUpdates', 'slides', 'publicNotices', 'reviews', 'scrollingAnnouncements', 'aboutSections', 'socialLinks', 'pastSeminarGallery', 'speakers'].forEach((k) => {
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
        if (Array.isArray(incoming.speakers)) merged.speakers = incoming.speakers;
        merged.scrollingAnnouncements = sanitizeScrollingAnnouncements(merged.scrollingAnnouncements);
        const payload = JSON.stringify(merged);
        upsertGlobalSetting('public_site_cms', payload, (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
    });
});

app.post('/api/admin/broadcast-venue-update', (req, res) => {
    const { actingAdminId, message, venue, seminarId, sendEmail, sendWhatsApp } = req.body || {};
    const aid = parseInt(actingAdminId, 10);
    const sid = seminarId != null && seminarId !== '' ? parseInt(seminarId, 10) : null;
    if (!Number.isInteger(aid) || aid < 1) return res.status(400).json({ error: 'actingAdminId is required' });
    const bodyText = String(message || venue || '').trim();
    if (!bodyText) return res.status(400).json({ error: 'message or venue text is required' });
    assertAdminPortalActor(aid, (e, adm) => {
        if (e && e.message === 'BAD_ACTOR') return res.status(400).json({ error: 'actingAdminId is required' });
        if (e && e.message === 'FORBIDDEN') return res.status(403).json({ error: 'Administrator access required' });
        if (e) return res.status(500).json({ error: e.message });
        if (!adm) return res.status(403).json({ error: 'Invalid administrator' });
        const doEmail = sendEmail !== false;
        const doWa = sendWhatsApp !== false;
        let sql = `SELECT DISTINCT u.id, u.email, u.phone, u.first_name, u.last_name, s.title AS seminar_title
                   FROM registrations r
                   JOIN users u ON u.id = r.user_id
                   JOIN orders o ON o.registration_id = r.id AND lower(trim(o.status)) = 'success'
                   JOIN seminars s ON s.id = r.seminar_id
                   WHERE r.status NOT IN ('rejected', 'cancelled')`;
        const params = [];
        if (Number.isInteger(sid) && sid > 0) {
            sql += ` AND r.seminar_id = ?`;
            params.push(sid);
        }
        db.all(sql, params, (e2, rows) => {
            if (e2) return res.status(500).json({ error: e2.message });
            const list = rows || [];
            if (!list.length) return res.json({ success: true, queued: 0, message: 'No paid registrants found.' });
            let queued = 0;
            let left = list.length;
            const waLine =
                'Venue update — ' +
                (list[0] && list[0].seminar_title ? list[0].seminar_title : 'National Seminar') +
                '\n' +
                bodyText;
            list.forEach((u) => {
                let pending = 0;
                if (doEmail && u.email) pending++;
                if (doWa && u.phone) pending++;
                const doneOne = () => {
                    pending--;
                    if (pending > 0) return;
                    left--;
                    if (left === 0) {
                        notifEngine.processQueueOnce(db);
                        res.json({ success: true, queued, recipients: list.length });
                    }
                };
                if (!pending) return doneOne();
                if (doEmail && u.email) {
                    queued++;
                    notifEngine.enqueueDirectMessage(
                        db,
                        {
                            channel: 'email',
                            destination: u.email,
                            subject: 'Venue / location update — VGMF Seminar',
                            html:
                                '<p>Dear ' +
                                (u.first_name || 'Doctor') +
                                ',</p><p>' +
                                bodyText.replace(/\n/g, '<br>') +
                                '</p>',
                            text: bodyText,
                            event_key: 'VENUE_UPDATE'
                        },
                        doneOne
                    );
                }
                if (doWa && u.phone) {
                    queued++;
                    notifEngine.enqueueDirectMessage(
                        db,
                        { channel: 'whatsapp', destination: u.phone, body: waLine, event_key: 'VENUE_UPDATE' },
                        doneOne
                    );
                }
            });
        });
    });
});

app.post('/api/admin/upload-asset', caseUpload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'file is required' });
    }
    fileStore.persistToGlobalAsset(db, upsertGlobalSetting, req.file, 'upload_asset_', (err, assetPath) => {
        if (err) return res.status(500).json({ error: err.message });
        if (assetPath) return res.json({ success: true, path: assetPath });
        if (!req.file.filename) return res.status(400).json({ error: 'file is required' });
        res.json({ success: true, path: '/uploads/' + req.file.filename });
    });
});

app.get('/api/assets/:key', fileStore.serveAssetHandler(db));

app.post('/api/admin/registration-form-config', (req, res) => {
    const { fields } = req.body;
    if (!Array.isArray(fields)) return res.status(400).json({ error: 'fields must be an array' });
    const normalized = fields.map((f) => ({
        ...f,
        required: f.enabled === false ? false : !!f.required
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
    let {
        userId,
        seminarId,
        formData,
        phoneOtpToken,
        emailOtpToken,
        submitPhoneOtpToken,
        submitEmailOtpToken,
        fieldOtpTokens
    } = req.body;
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
                                activityLog.logFromRequest(db, req, {
                                    user_id: userId,
                                    seminar_id: seminarId,
                                    action: 'application.submit',
                                    resource_type: 'registration',
                                    resource_id: applicationNo,
                                    meta: { applicationId: newId }
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
                            const subPhone = String(submitPhoneOtpToken || '').trim();
                            const subEmail = String(submitEmailOtpToken || '').trim();
                            if (needEmail && !subEmail) {
                                return res.status(400).json({
                                    error:
                                        'Enter the email confirmation code on the preview step (final verification) before submitting.'
                                });
                            }
                            if (needPhone && !subPhone) {
                                return res.status(400).json({
                                    error:
                                        'Enter the WhatsApp confirmation code on the preview step (final verification) before submitting.'
                                });
                            }
                            otpLib.validateRegistrationSubmitOtpTokens(
                                db,
                                sidNum,
                                {
                                    phoneToken: needPhone ? subPhone : null,
                                    emailToken: needEmail ? subEmail : null
                                },
                                (sErr, sv) => {
                                    if (sErr) return res.status(500).json({ error: sErr.message });
                                    if (!sv || !sv.ok) {
                                        return res.status(400).json({
                                            error: (sv && sv.error) || 'Final confirmation OTP failed. Request new codes on the preview step.'
                                        });
                                    }
                                    if (needEmail && !emailOtpToken) {
                                        return res.status(400).json({
                                            error: 'Verify your email with the code from the application form before submitting.'
                                        });
                                    }
                                    if (needPhone && !phoneOtpToken) {
                                        return res.status(400).json({
                                            error: 'Verify your phone with the WhatsApp code from the application form before submitting.'
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
                    integrationSettings.ensureIntegrationSettingsLoaded(db, () => {
                        const needEmail = integrationSettings.isEmailConfiguredFromSettings();
                        const needPhone = integrationSettings.isWhatsAppConfiguredFromSettings();
                        if (!needEmail && !needPhone) {
                            return runFieldOtps();
                        }
                        if (needEmail && !emailOtpToken) {
                            return res.status(400).json({
                                error: 'Verify your email with the code from the application form before saving changes.'
                            });
                        }
                        if (needPhone && !phoneOtpToken) {
                            return res.status(400).json({
                                error: 'Verify your phone with the WhatsApp code from the application form before saving changes.'
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
                                    return res.status(400).json({ error: (ov && ov.error) || 'OTP verification failed' });
                                }
                                runFieldOtps();
                            }
                        );
                    });
                    return;
                }
                runFieldOtps();
            });
        }
    );
});

// 5d. Cancel application — doctors must use cancellation request API (admin approves + refund)
app.post('/api/applications/:applicationId/cancel', (req, res) => {
    const applicationId = parseInt(req.params.applicationId, 10);
    const userId = parseInt((req.body && req.body.userId) || '', 10);
    if (Number.isNaN(applicationId) || applicationId < 1 || Number.isNaN(userId) || userId < 1) {
        return res.status(400).json({ error: 'Valid applicationId and userId are required.' });
    }
    return res.status(403).json({
        error: 'Direct cancellation is disabled. Submit a cancellation request from your Applications tab.',
        useCancellationRequest: true
    });
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

function isPublicListEnabled(val) {
    return val === 1 || val === true || val === '1' || val === 't' || val === 'true';
}

// Doctor dashboard statistics (tolerant of optional auxiliary tables on PostgreSQL)
app.get('/api/doctor/dashboard-stats/:userId', (req, res) => {
    const uid = parseInt(req.params.userId, 10);
    if (Number.isNaN(uid)) return res.status(400).json({ error: 'Invalid user' });
    const out = {
        registered_seminars: 0,
        paid_or_confirmed: 0,
        checked_in_seminars: 0,
        feedback_submitted: 0,
        case_presentations: 0,
        support_tickets: 0,
        participant_tickets: 0
    };
    const steps = [
        [
            `SELECT COUNT(*) AS c FROM registrations WHERE user_id = ? AND IFNULL(status,'') NOT IN ('rejected','cancelled')`,
            'registered_seminars'
        ],
        [
            `SELECT COUNT(*) AS c FROM registrations WHERE user_id = ? AND status IN ('completed','checked_in','approved_pending_payment')`,
            'paid_or_confirmed'
        ],
        [
            `SELECT COUNT(*) AS c FROM registrations WHERE user_id = ? AND status = 'checked_in'`,
            'checked_in_seminars'
        ],
        [
            `SELECT COUNT(*) AS c FROM seminar_feedback WHERE user_id = ?`,
            'feedback_submitted'
        ],
        [
            `SELECT COUNT(*) AS c FROM case_submissions WHERE user_id = ? AND IFNULL(status,'') NOT IN ('cancelled')`,
            'case_presentations'
        ],
        [`SELECT COUNT(*) AS c FROM support_tickets WHERE user_id = ?`, 'support_tickets'],
        [
            `SELECT COUNT(*) AS c FROM tickets t JOIN orders o ON t.order_id = o.id JOIN registrations r ON o.registration_id = r.id WHERE r.user_id = ?`,
            'participant_tickets'
        ]
    ];
    let i = 0;
    const next = () => {
        if (i >= steps.length) return res.json(out);
        const [sql, key] = steps[i];
        i++;
        db.get(sql, [uid], (err, row) => {
            if (!err && row) out[key] = row.c != null ? row.c : row.count || 0;
            next();
        });
    };
    next();
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

app.get('/api/doctor/ticket-document/:ticketId', (req, res) => {
    const ticketId = String(req.params.ticketId || '').trim();
    const uid = parseInt(req.query.userId, 10);
    if (!ticketId) return res.status(400).send('Ticket id required');
    const internalRowId = safeInternalTicketRowId(ticketId);
    const whereClause = internalRowId
        ? 'WHERE TRIM(t.ticket_id_string) = TRIM(?) OR t.id = ?'
        : 'WHERE TRIM(t.ticket_id_string) = TRIM(?)';
    const params = internalRowId ? [ticketId, internalRowId] : [ticketId];
    db.get(
        `SELECT t.ticket_id_string, t.qr_code_data, t.is_scanned, t.scan_time, IFNULL(t.is_valid, 1) AS is_valid,
                r.application_no, r.user_id, o.status AS payment_status,
                s.title AS seminar_title, s.event_date, s.location_url, s.portal_year,
                u.first_name, u.last_name
         FROM tickets t
         JOIN orders o ON t.order_id = o.id
         JOIN registrations r ON o.registration_id = r.id
         JOIN seminars s ON r.seminar_id = s.id
         JOIN users u ON u.id = r.user_id
         ${whereClause}`,
        params,
        (err, row) => {
            if (err) return res.status(500).send(err.message);
            if (!row) return res.status(404).send('Ticket not found');
            if (Number.isInteger(uid) && uid > 0 && Number(row.user_id) !== uid) {
                return res.status(403).send('Not your ticket');
            }
            ticketHtml
                .buildTicketHtmlFromRow(
                    {
                        ticket_id_string: row.ticket_id_string,
                        application_no: row.application_no,
                        seminar_title: row.seminar_title,
                        event_date: row.event_date,
                        location_url: row.location_url,
                        portal_year: row.portal_year,
                        display_name: [row.first_name, row.last_name].filter(Boolean).join(' '),
                        qr_code_data: row.qr_code_data,
                        is_scanned: row.is_scanned,
                        scan_time: row.scan_time,
                        payment_status: row.payment_status,
                        is_valid: row.is_valid
                    },
                    db
                )
                .then((html) => {
                    res.setHeader('Content-Type', 'text/html; charset=utf-8');
                    res.setHeader('Cache-Control', 'no-store');
                    res.send(html);
                })
                .catch((e) => res.status(500).send(e.message));
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
    authUsers.findUserByEmail(db, emailNorm, (err, user) => {
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

// Meta WhatsApp webhook (https://developers.facebook.com/docs/whatsapp/cloud-api)
app.get('/api/webhooks/whatsapp', (req, res) => {
    integrationSettings.ensureIntegrationSettingsLoaded(db, () => {
        const mode = req.query['hub.mode'];
        const token = String(req.query['hub.verify_token'] || '').trim();
        const challenge = req.query['hub.challenge'];
        if (mode === 'subscribe' && token && integrationSettings.matchesWhatsAppVerifyToken(token)) {
            return res.status(200).type('text/plain').send(String(challenge));
        }
        const candidates = integrationSettings.getWhatsAppVerifyCandidates();
        console.warn('[whatsapp-webhook] GET verify failed', {
            mode: mode || '(missing)',
            tokenPresent: !!token,
            tokenLength: token.length,
            configuredCount: candidates.length,
            configuredLengths: candidates.map((c) => c.length)
        });
        res.status(403)
            .type('text/plain')
            .send(
                'Forbidden — verify token mismatch. In Admin → Integrations, enter the exact Verify token you use in Meta, click Save integrations, then Verify in Meta again.'
            );
    });
});

app.post('/api/webhooks/whatsapp', (req, res) => {
    whatsappWebhook.handleWhatsAppWebhookPost(db, req.body || {}, (err, result) => {
        if (err) console.warn('[whatsapp-webhook] POST', err.message);
        else if (result && result.events) {
            console.log('[whatsapp-webhook]', JSON.stringify(result.statuses || result));
        }
        res.sendStatus(200);
    });
});

app.get('/api/admin/integrations/whatsapp-delivery-events', withIntegrationSettingsLoaded, (req, res) => {
    const messageId = String((req.query && req.query.messageId) || '').trim();
    if (!messageId) return res.status(400).json({ error: 'messageId required' });
    whatsappWebhook.getDeliveryEventsForMessage(db, messageId, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

app.get('/api/admin/integrations/whatsapp-phone-diagnostics', withIntegrationSettingsLoaded, async (req, res) => {
    try {
        const diag = await require('./lib/whatsapp-service').getWhatsAppPhoneDiagnostics();
        res.json(diag);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/integrations/whatsapp-webhook-status', withIntegrationSettingsLoaded, (req, res) => {
    const candidates = integrationSettings.getWhatsAppVerifyCandidates();
    const primary = candidates[0] || '';
    const probe = String((req.query && req.query.probe) || '').trim();
    const base = integrationSettings.getPublicBaseUrl() || '';
    const webhookUrl = (base.replace(/\/$/, '') || 'https://seminar.vaidyagogate.org') + '/api/webhooks/whatsapp';
    let probeMatch = null;
    let probeHint = '';
    if (probe) {
        probeMatch = integrationSettings.matchesWhatsAppVerifyToken(probe);
        if (!probeMatch) {
            probeHint =
                primary.length && probe.length !== primary.length
                    ? `Meta token is ${probe.length} characters; server token is ${primary.length} characters — they must match exactly.`
                    : 'Token does not match any value saved on the server. Re-enter it in Webhook verify token and Save integrations.';
        } else {
            probeHint = 'This token matches the server. Use the same string in Meta → Verify and save.';
        }
    }
    res.json({
        webhook_url: webhookUrl,
        verify_token_configured: candidates.length > 0,
        verify_token_length: primary.length,
        verify_token_candidate_count: candidates.length,
        probe_token_length: probe ? probe.length : null,
        probe_match: probeMatch,
        probe_hint: probeHint,
        hint: primary
            ? 'In Meta → WhatsApp → Configuration, use the same Verify token as Admin → Integrations (or add WHATSAPP_VERIFY_TOKEN_ALT on the server). Then click Verify and save.'
            : 'Set Webhook verify token in Admin → Integrations and Save, then use the same string in Meta webhook setup.'
    });
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
                    activityLog.logFromRequest(db, req, {
                        user_id: userId,
                        action: 'support.ticket_create',
                        resource_type: 'ticket',
                        resource_id: trackingId,
                        meta: { subject: String(subject || '').slice(0, 120) }
                    });
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

        const startPayment = (gateway) => {
        if (!gateway) {
                const mockTxn = 'MOCK' + generateId();
                fulfillRegistrationPayment(regId, uid, amount, 'mock', mockTxn, (err, meta) => {
                    if (err) return res.status(500).json({ success: false, error: err.message });
                    const msg =
                        meta && meta.skipped
                            ? 'Payment recorded. No e-ticket was issued because this registration is not eligible.'
                            : meta && meta.alreadyPaid
                              ? 'Payment was already recorded. Your e-ticket is in Participant tickets.'
                              : 'Payment successful, e-ticket generated.';
                    res.json({
                        success: true,
                        orderId: (meta && meta.orderIdString) || '',
                        gateway: 'mock',
                        message: msg,
                        transactionId: mockTxn,
                        eTicketSkipped: !!(meta && meta.skipped)
                    });
                });
            return;
        }

        if (gateway.name === 'razorpay') {
            const razorpay = new Razorpay({
                key_id: gateway.config.key_id,
                    key_secret: gateway.config.key_secret
            });
                const gwTag =
                    gateway.mode === 'live' ? 'razorpay_live' : gateway.mode === 'test' ? 'razorpay_test' : 'razorpay';

                const beginRazorpayOrder = (orderIdStr, localOrderId) => {
                    const options = {
                        amount: amount * 100,
                        currency: 'INR',
                        receipt: orderIdStr.length > 40 ? orderIdStr.slice(0, 40) : orderIdStr
                    };
                    razorpay.orders.create(options, (err, rzOrder) => {
                        if (err) {
                            db.run(`DELETE FROM orders WHERE id = ? AND status = 'pending' AND provider_order_id IS NULL`, [
                                localOrderId
                            ]);
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
                };

                db.get(
                    `SELECT id, order_id_string, provider_order_id FROM orders WHERE registration_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`,
                    [regId],
                    (ePend, pending) => {
                        if (ePend) return res.status(500).json({ success: false, error: ePend.message });
                        if (pending && pending.provider_order_id) {
                            return res.status(400).json({
                                success: false,
                                error: 'A payment is already in progress for this application. Complete it or contact support.'
                            });
                        }
                        if (pending) {
                            return db.run(
                                `UPDATE orders SET amount = ?, payment_gateway = ? WHERE id = ?`,
                                [amount, gwTag, pending.id],
                                (uAmt) => {
                                    if (uAmt) return res.status(500).json({ success: false, error: uAmt.message });
                                    beginRazorpayOrder(pending.order_id_string, pending.id);
                                }
                            );
                        }
                        const orderIdStr = 'ORD_' + generateId();
                        db.run(
                            `INSERT INTO orders (order_id_string, registration_id, amount, status, payment_gateway) VALUES (?, ?, ?, 'pending', ?)`,
                            [orderIdStr, regId, amount, gwTag],
                            function (insErr) {
                                if (insErr) return res.status(500).json({ success: false, error: insErr.message });
                                beginRazorpayOrder(orderIdStr, this.lastID);
                            }
                        );
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
               IFNULL(u.is_disabled, 0) AS doctor_is_disabled, IFNULL(u.is_banned, 0) AS doctor_is_banned, u.ban_reason AS doctor_ban_reason,
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

function doctorAccountBlockForScan(row) {
    if (!row) return null;
    if (Number(row.doctor_is_banned) === 1) {
        return {
            error: 'Entry denied — doctor account is banned.',
            accountStatus: 'BANNED',
            banReason: row.doctor_ban_reason || null
        };
    }
    if (Number(row.doctor_is_disabled) === 1) {
        return {
            error: 'Entry denied — doctor account is disabled.',
            accountStatus: 'DISABLED'
        };
    }
    return null;
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

const SCANNER_REG_LOOKUP_SQL = `
        SELECT r.id AS registration_id, r.application_no, r.form_data, r.status AS registration_status, r.user_id,
               o.id AS order_db_id, o.order_id_string, o.status AS payment_status,
               t.id AS ticket_id, t.ticket_id_string, t.is_scanned, t.qr_code_data, IFNULL(t.is_valid, 1) AS is_valid,
               s.id AS seminar_id, s.checkin_enabled, s.checkin_date, s.title AS seminar_title, s.event_date,
               u.id AS doctor_user_id, u.user_id_string AS doctor_user_id_string,
               u.first_name AS doctor_first_name, u.last_name AS doctor_last_name, u.email AS doctor_email, u.phone AS doctor_phone,
               IFNULL(u.is_disabled, 0) AS doctor_is_disabled, IFNULL(u.is_banned, 0) AS doctor_is_banned, u.ban_reason AS doctor_ban_reason
        FROM registrations r
        JOIN users u ON u.id = r.user_id
        JOIN seminars s ON s.id = r.seminar_id
        LEFT JOIN orders o ON o.registration_id = r.id AND lower(trim(o.status)) = 'success'
        LEFT JOIN tickets t ON t.order_id = o.id`;

function lookupRegistrationForScan(raw, cb) {
    const appNo = String(raw || '').trim();
    if (!appNo) return cb(null, null);
    db.get(SCANNER_REG_LOOKUP_SQL + ` WHERE r.application_no = ? ORDER BY o.id DESC, t.id DESC LIMIT 1`, [appNo], cb);
}

function registrationRowToTicketScanShape(row) {
    if (!row) return null;
    return {
        ticket_id: row.ticket_id,
        is_scanned: row.is_scanned,
        ticket_id_string: row.ticket_id_string,
        qr_code_data: row.qr_code_data,
        is_valid: row.is_valid,
        seminar_id: row.seminar_id,
        checkin_enabled: row.checkin_enabled,
        checkin_date: row.checkin_date,
        seminar_title: row.seminar_title,
        doctor_user_id: row.doctor_user_id,
        doctor_user_id_string: row.doctor_user_id_string,
        doctor_first_name: row.doctor_first_name,
        doctor_last_name: row.doctor_last_name,
        doctor_email: row.doctor_email,
        doctor_phone: row.doctor_phone,
        doctor_is_disabled: row.doctor_is_disabled,
        doctor_is_banned: row.doctor_is_banned,
        doctor_ban_reason: row.doctor_ban_reason,
        registration_id: row.registration_id,
        application_no: row.application_no,
        form_data: row.form_data,
        registration_status: row.registration_status,
        payment_status: row.payment_status,
        order_id_string: row.order_id_string,
        order_db_id: row.order_db_id,
        user_id: row.user_id
    };
}

function resolveScanRowFromApplicationId(qrData, selectedSeminarId, cb) {
    lookupRegistrationForScan(qrData, (eReg, regRow) => {
        if (eReg) return cb(eReg);
        if (!regRow) return cb(null, null);
        const payOk = String(regRow.payment_status || '').toLowerCase() === 'success';
        if (!payOk) return cb(null, { error: 'unpaid', regRow });
        if (regRow.ticket_id) {
            return lookupTicketForScan(regRow.ticket_id_string || qrData, (e2, tRow) => {
                if (e2) return cb(e2);
                cb(null, tRow || registrationRowToTicketScanShape(regRow));
            });
        }
        if (!regRow.order_db_id) {
            return cb(null, { error: 'no_order', regRow });
        }
        insertParticipantTicket(
            regRow.order_db_id,
            regRow.user_id,
            regRow.order_id_string,
            regRow.registration_id,
            regRow.application_no,
            (eIns, etk) => {
                if (eIns) return cb(eIns);
                lookupTicketForScan(etk || qrData, (e3, tRow) => cb(e3, tRow));
            }
        );
    });
}

function scannerVerifyJsonFromRow(row, extras) {
    return Object.assign(
        {
            success: true,
            found: true,
            ticketId: row.ticket_id_string,
            applicationNo: row.application_no || null,
            seminarId: row.seminar_id,
            seminarTitle: row.seminar_title,
            paymentStatus: row.payment_status,
            registrationStatus: row.registration_status,
            isScanned: !!row.is_scanned,
            invalid: ticketLookupInvalid(row),
            checkinEnabled: !!row.checkin_enabled,
            checkinDate: row.checkin_date
        },
        extras || {}
    );
}

// Scanner: dry-run ticket lookup (same matching as /mark, no state change)
app.get('/api/scanner/verify', (req, res) => {
    const ticketId = String(req.query.ticketId || req.query.qrData || '').trim();
    const seminarId = req.query.seminarId != null && req.query.seminarId !== '' ? parseInt(req.query.seminarId, 10) : null;
    if (!ticketId) {
        return res.status(400).json({ success: false, error: 'ticketId query parameter is required.' });
    }
    lookupTicketForScan(ticketId, (err, row) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (row) {
            return res.json(scannerVerifyJsonFromRow(row));
        }
        resolveScanRowFromApplicationId(ticketId, seminarId, (e2, row2) => {
            if (e2) return res.status(500).json({ success: false, error: e2.message });
            if (!row2) {
                return res.status(404).json({
                    success: false,
                    found: false,
                    error:
                        'Ticket not found. Scan the e-ticket QR, enter the 12-digit ticket ID, or enter the application ID for a paid registration.'
                });
            }
            if (row2.error === 'unpaid') {
                return res.status(400).json({
                    success: false,
                    found: true,
                    applicationNo: row2.regRow && row2.regRow.application_no,
                    error: 'Registration found but payment is not complete.'
                });
            }
            if (row2.error === 'no_order') {
                return res.status(400).json({
                    success: false,
                    found: true,
                    applicationNo: row2.regRow && row2.regRow.application_no,
                    error: 'Registration found but no paid order — cannot issue entry ticket.'
                });
            }
            res.json(
                scannerVerifyJsonFromRow(row2, {
                    resolvedViaApplicationId: true,
                    ticketAutoIssued: !row2.ticket_id && !!row2.ticket_id_string
                })
            );
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
            const todayYmd = localDateYmd();
            res.json(
                (rows || []).map((r) => {
                    const checkinYmd = normalizeCheckinDateYmd(r.checkin_date);
                    return {
                        id: r.id,
                        title: r.title,
                        checkinDate: checkinYmd || r.checkin_date,
                        eventDate: normalizeCheckinDateYmd(r.event_date) || r.event_date,
                        todayYmd,
                        checkinOpenToday: isCheckinOpenForSeminar(r)
                    };
                })
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

            function proceedWithScanRow(err, row, regHint) {
                if (err) return res.status(500).json({ success: false, error: err.message });
                if (!row) {
                    return res.status(404).json({
                        success: false,
                        error: 'Not found. Scan e-ticket QR, or enter E-ticket ID / Application ID.',
                        sound: 'error'
                    });
                }
                if (row.error === 'unpaid') {
                    return res.status(403).json({
                        success: false,
                        error: 'Application found but payment is not confirmed.',
                        sound: 'error',
                        doctor: {
                            applicationNo: row.regRow && row.regRow.application_no,
                            name: buildDisplayNameFromFormData(row.regRow && row.regRow.form_data, row.regRow)
                        }
                    });
                }

                const accountBlock = doctorAccountBlockForScan(row);
                if (accountBlock) {
                    return res.status(403).json({
                        success: false,
                        error: accountBlock.error,
                        sound: 'error',
                        accountStatus: accountBlock.accountStatus,
                        doctor: {
                            userId: row.doctor_user_id,
                            userIdString: row.doctor_user_id_string,
                            name: buildDisplayNameFromFormData(row.form_data, row),
                            applicationNo: row.application_no,
                            seminarTitle: row.seminar_title,
                            ticketId: row.ticket_id_string,
                            accountStatus: accountBlock.accountStatus,
                            banReason: accountBlock.banReason || undefined
                        }
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

                const checkinOn =
                    row.checkin_enabled === true ||
                    row.checkin_enabled === 1 ||
                    row.checkin_enabled === '1';
                if (!checkinOn) {
                    return res.status(403).json({
                        success: false,
                        error: 'Check-in is currently disabled for this seminar.',
                        sound: 'error'
                    });
                }

                const allowAnyCheckinDate =
                    process.env.SCANNER_ALLOW_ANY_CHECKIN_DATE === '1' || r === 'admin';
                const seminarForDate = {
                    checkin_enabled: row.checkin_enabled,
                    checkin_date: row.checkin_date,
                    event_date: row.event_date
                };
                if (!allowAnyCheckinDate && !isCheckinOpenForSeminar(seminarForDate)) {
                    const today = localDateYmd();
                    const expected =
                        normalizeCheckinDateYmd(row.checkin_date) ||
                        String(row.checkin_date || '').slice(0, 10);
                    return res.status(403).json({
                        success: false,
                        error: `Check-in is only open for ${expected || 'the configured date'} (today in India is ${today}). In Admin → Seminars, set "Check-in allowed date" to today (${today}), or leave it blank to allow any day while check-in is enabled.`,
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
                        const regId = row.registration_id;
                        const finishScanResponse = (checkedInAtIso) => {
                            syncCertificateEligibilityForTicket(row.ticket_id, () => {
                                const doctorName = buildDisplayNameFromFormData(row.form_data, {
                                    first_name: row.doctor_first_name,
                                    last_name: row.doctor_last_name
                                });
                                notifEngine.notify(db, 'CHECK_IN_SUCCESS', {
                                    userId: row.doctor_user_id,
                                    seminarId: row.seminar_id,
                                    registrationId: regId || null,
                                    vars: {
                                        ticket_id: row.ticket_id_string,
                                        payment_status: row.payment_status === 'success' ? 'PAID' : 'UNPAID',
                                        approval_status: 'checked_in'
                                    }
                                });

                                res.json({
                                    success: true,
                                    sound: 'success',
                                    message:
                                        'Attendance marked. Doctor tracking updated. Certificate unlocked if configured.',
                                    doctor: {
                                        userId: row.doctor_user_id,
                                        userIdString: row.doctor_user_id_string,
                                        name: doctorName,
                                        email: row.doctor_email,
                                        phone: row.doctor_phone,
                                        applicationNo: row.application_no,
                                        seminarTitle: row.seminar_title,
                                        ticketId: row.ticket_id_string,
                                        registrationType: 'checked_in',
                                        paymentStatus: row.payment_status === 'success' ? 'PAID' : 'UNPAID',
                                        checkedInAt: checkedInAtIso || new Date().toISOString()
                                    },
                                    scannedByStaffId: staffId
                                });
                            });
                        };

                        if (!regId) return finishScanResponse(new Date().toISOString());

                        db.run(
                            `UPDATE registrations SET status = 'checked_in' WHERE id = ? AND status NOT IN ('rejected', 'cancelled')`,
                            [regId],
                            () => {
                                portalTracking.logRegistrationEvent(
                                    db,
                                    regId,
                                    'checked_in',
                                    'Checked in at venue',
                                    'Venue check-in completed — QR scanned at entry.',
                                    (logErr) => {
                                        if (logErr) {
                                            console.warn('[scanner] check-in log:', logErr.message);
                                        }
                                        db.get(
                                            `SELECT scan_time FROM tickets WHERE id = ?`,
                                            [row.ticket_id],
                                            (eSt, tix) => {
                                                const at =
                                                    (tix && tix.scan_time) || new Date().toISOString();
                                                finishScanResponse(at);
                                            }
                                        );
                                    }
                                );
                            }
                        );
                    }
                );
            }

            lookupTicketForScan(qrData, (err, row) => {
                if (err) return res.status(500).json({ success: false, error: err.message });
                if (row) return proceedWithScanRow(null, row);
                resolveScanRowFromApplicationId(qrData, selectedSeminarId, (e2, row2) => {
                    if (e2) return res.status(500).json({ success: false, error: e2.message });
                    if (row2 && row2.error) return proceedWithScanRow(null, row2);
                    proceedWithScanRow(null, row2);
                });
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
    const otpApp =
        otp_on_application === false || otp_on_application === 0 || otp_on_application === '0' ? 0 : 1;
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
                normalizeCheckinDateForStorage(checkin_date),
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
                announceSeminarRegistrationOnCreate(newId, () => {});
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
                normalizeCheckinDateForStorage(checkin_date),
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
                if (!is_active) {
                    removeSeminarScrollingAnnouncement(parseInt(req.params.id, 10), () => {});
                }
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

const ALLOWED_REGISTRATION_STATUSES = new Set([
    'submitted',
    'pending_approval',
    'approved_pending_payment',
    'completed',
    'e_ticket_issued',
    'certificate_issued',
    'checked_in',
    'rejected',
    'cancelled'
]);

function safeDisableCertificatesForRegistration(registrationId, cb) {
    db.run(
        `UPDATE user_certificates SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE registration_id = ?`,
        [registrationId],
        (e) => {
            if (e && /relation .* does not exist/i.test(e.message)) return cb && cb(null);
            cb && cb(e);
        }
    );
}

function enableCertificateForRegistration(registrationId, cb) {
    db.get(
        `SELECT r.user_id, r.seminar_id, r.form_data, u.first_name, u.middle_name, u.last_name
         FROM registrations r JOIN users u ON u.id = r.user_id WHERE r.id = ?`,
        [registrationId],
        (e, row) => {
            if (e) return cb && cb(e);
            if (!row) return cb && cb(null);
            const displayName = buildDisplayNameFromFormData(row.form_data, row);
            db.get(
                `SELECT id FROM certificate_templates WHERE seminar_id = ? AND is_active = 1 ORDER BY id DESC LIMIT 1`,
                [row.seminar_id],
                (e2, tpl) => {
                    if (e2 && /relation .* does not exist/i.test(e2.message)) return cb && cb(null);
                    if (e2) return cb && cb(e2);
                    db.run(
                        `INSERT INTO user_certificates (user_id, seminar_id, registration_id, display_name, template_id, enabled, updated_at)
                         VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
                         ON CONFLICT (user_id, seminar_id) DO UPDATE SET
                           enabled = 1,
                           registration_id = excluded.registration_id,
                           display_name = excluded.display_name,
                           template_id = COALESCE(excluded.template_id, user_certificates.template_id),
                           updated_at = CURRENT_TIMESTAMP`,
                        [row.user_id, row.seminar_id, registrationId, displayName, tpl ? tpl.id : null],
                        (e3) => {
                            if (e3 && /relation .* does not exist/i.test(e3.message)) return cb && cb(null);
                            cb && cb(e3);
                        }
                    );
                }
            );
        }
    );
}

// Admin: Update Application Status
app.post('/api/admin/applications/status', (req, res) => {
    const { applicationId, status } = req.body;
    const newSt = String(status || '').toLowerCase();
    if (!ALLOWED_REGISTRATION_STATUSES.has(newSt)) {
        return res.status(400).json({ error: 'Invalid application status.' });
    }
    db.get(`SELECT status FROM registrations WHERE id = ?`, [applicationId], (e0, prevRow) => {
        if (e0) return res.status(500).json({ error: e0.message });
        const prevStatus = String((prevRow && prevRow.status) || '').toLowerCase();
        const fromRejectedOrCancelled = prevStatus === 'rejected' || prevStatus === 'cancelled';

    db.run(`UPDATE registrations SET status = ? WHERE id = ?`, [status, applicationId], function(err) {
        if (err) return res.status(500).json({ error: err.message });

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
                    safeDisableCertificatesForRegistration(applicationId, () => {});
                }
            }
            if (newSt === 'certificate_issued') {
                enableCertificateForRegistration(applicationId, () => {});
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
        
        if (newSt === 'approved_pending_payment') {
            getOrCreatePendingOrder(applicationId, 1500, () => {});
        }
        if (
            (newSt === 'e_ticket_issued' || newSt === 'completed') &&
            !fromRejectedOrCancelled
        ) {
            ensureParticipantTicketForRegistration(
                applicationId,
                { createOrderIfMissing: true, promotePendingToSuccess: true, amount: 1500 },
                (eTix, tixMeta) => {
                    if (eTix || !tixMeta || tixMeta.skipped || !tixMeta.ticketId) return;
                    db.get(`SELECT user_id FROM registrations WHERE id = ?`, [applicationId], (eU, regU) => {
                        if (!eU && regU) notifyTicketIssued(regU.user_id, applicationId, tixMeta.ticketId);
                    });
                }
            );
        }
        res.json({
            success: true,
            message:
                newSt === 'approved_pending_payment'
                    ? 'Status updated. An order was created for payment.'
                    : 'Status updated successfully.'
        });
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
                                return db.get(
                                    `SELECT user_id, application_no FROM registrations WHERE id = ?`,
                                    [applicationId],
                                    (eReg, regRow) => {
                                        if (eReg) return res.status(500).json({ error: eReg.message });
                                        if (!regRow) return res.status(404).json({ error: 'Registration not found' });
                                        insertParticipantTicket(
                                            ord.id,
                                            regRow.user_id,
                                            ord.order_id_string || '',
                                            applicationId,
                                            regRow.application_no,
                                            (eTix) => {
                                                if (eTix) return res.status(500).json({ error: eTix.message });
                                                res.json({
                                                    success: true,
                                                    message:
                                                        'Payment already recorded. Your e-ticket is under Participant tickets.',
                                                    transactionId: razorpay_payment_id
                                                });
                                            }
                                        );
                                    }
                                );
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
                                        db.run(
                                            `DELETE FROM orders WHERE registration_id = ? AND status = 'pending' AND id != ?`,
                                            [applicationId, ord.id],
                                            () => {}
                                        );
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
        `SELECT id, user_id_string, first_name, middle_name, last_name, email, phone, password, role, user_role,
                is_disabled, IFNULL(is_banned,0) AS is_banned, ban_reason, banned_at,
                IFNULL(is_demo,0) AS is_demo, created_at FROM users WHERE id = ?`,
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

                                                const finishDetail = (certificates, certErr, cancellationRequests) => {
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
                                                        cancellationRequests: cancellationRequests || [],
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
                                                            return finishDetail([], e7, []);
                                                        }
                                                        if (e7) return res.status(500).json({ error: e7.message });
                                                        db.all(
                                                            `SELECT cr.*, r.application_no, s.title AS seminar_title
                                                             FROM cancellation_requests cr
                                                             JOIN registrations r ON r.id = cr.registration_id
                                                             LEFT JOIN seminars s ON s.id = r.seminar_id
                                                             WHERE cr.user_id = ?
                                                             ORDER BY cr.id DESC`,
                                                            [uid],
                                                            (eCr, cancelRows) => {
                                                                if (eCr && /no such table|does not exist/i.test(eCr.message)) {
                                                                    return finishDetail(certificates || [], null, []);
                                                                }
                                                                if (eCr) {
                                                                    return finishDetail(certificates || [], null, []);
                                                                }
                                                                finishDetail(certificates || [], null, cancelRows || []);
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

app.get('/api/admin/activity-logs', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const userId = req.query.userId ? parseInt(req.query.userId, 10) : null;
    const action = req.query.action ? String(req.query.action).trim() : '';
    const role = req.query.role ? String(req.query.role).trim() : '';
    let sql = `
        SELECT a.*, u.user_id_string, u.first_name, u.last_name, u.email, u.phone, u.role AS account_role
        FROM user_activity_logs a
        LEFT JOIN users u ON u.id = a.user_id
        WHERE 1=1
    `;
    const params = [];
    if (Number.isInteger(userId) && userId > 0) {
        sql += ` AND a.user_id = ?`;
        params.push(userId);
    }
    if (action) {
        sql += ` AND a.action LIKE ?`;
        params.push('%' + action + '%');
    }
    if (role) {
        sql += ` AND (a.user_role = ? OR u.role = ?)`;
        params.push(role, role);
    }
    sql += ` ORDER BY a.created_at DESC LIMIT ?`;
    params.push(limit);
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

function assertAdminPortalActor(adminId, cb) {
    const aid = parseInt(adminId, 10);
    if (!Number.isInteger(aid) || aid < 1) return cb(new Error('BAD_ACTOR'), null);
    db.get(
        `SELECT id, role, user_role FROM users WHERE id = ? AND IFNULL(is_disabled,0) = 0`,
        [aid],
        (e, adm) => {
            if (e) return cb(e, null);
            if (!adm) return cb(new Error('FORBIDDEN'), null);
            const ok =
                String(adm.role || '').toLowerCase() === 'admin' || String(adm.user_role || '').toLowerCase() === 'co_admin';
            if (!ok) return cb(new Error('FORBIDDEN'), null);
            cb(null, adm);
        }
    );
}

app.get('/api/admin/portal-auth-config', (req, res) => {
    const aid = parseInt(req.query.actingAdminId, 10);
    if (!Number.isInteger(aid) || aid < 1) {
        return res.status(400).json({ error: 'actingAdminId query parameter is required' });
    }
    assertAdminPortalActor(aid, (e, adm) => {
        if (e && e.message === 'BAD_ACTOR') return res.status(400).json({ error: 'actingAdminId is required' });
        if (e && e.message === 'FORBIDDEN') return res.status(403).json({ error: 'Administrator access required' });
        if (e) return res.status(500).json({ error: e.message });
        if (!adm) return res.status(403).json({ error: 'Invalid administrator' });
        portalAuthPolicy.loadPortalAuthConfig(db, () => {
            res.json({
                success: true,
                config: portalAuthPolicy.getPortalAuthConfig(),
                signupOtpEffective: portalAuthPolicy.signupOtpRequired(),
                loginOtpEffective: portalAuthPolicy.loginOtpRequired()
            });
        });
    });
});

app.get('/api/admin/designated-notify-config', (req, res) => {
    const aid = parseInt(req.query.actingAdminId, 10);
    if (!Number.isInteger(aid) || aid < 1) {
        return res.status(400).json({ error: 'actingAdminId query parameter is required' });
    }
    assertAdminPortalActor(aid, (e, adm) => {
        if (e && e.message === 'BAD_ACTOR') return res.status(400).json({ error: 'actingAdminId is required' });
        if (e && e.message === 'FORBIDDEN') return res.status(403).json({ error: 'Administrator access required' });
        if (e) return res.status(500).json({ error: e.message });
        if (!adm) return res.status(403).json({ error: 'Invalid administrator' });
        designatedNotify.loadConfig(db, (err, cfg) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, config: cfg });
        });
    });
});

app.post('/api/admin/designated-notify-config', (req, res) => {
    const { actingAdminId, config } = req.body || {};
    const aid = parseInt(actingAdminId, 10);
    if (!Number.isInteger(aid) || aid < 1) return res.status(400).json({ error: 'actingAdminId is required' });
    if (!config || typeof config !== 'object') return res.status(400).json({ error: 'config object required' });
    assertAdminPortalActor(aid, (e, adm) => {
        if (e && e.message === 'BAD_ACTOR') return res.status(400).json({ error: 'actingAdminId is required' });
        if (e && e.message === 'FORBIDDEN') return res.status(403).json({ error: 'Administrator access required' });
        if (e) return res.status(500).json({ error: e.message });
        if (!adm) return res.status(403).json({ error: 'Invalid administrator' });
        const emails = Array.isArray(config.emails)
            ? config.emails.map((x) => String(x || '').trim()).filter(Boolean)
            : [];
        const phones = Array.isArray(config.phones)
            ? config.phones.map((x) => String(x || '').trim()).filter(Boolean)
            : [];
        upsertGlobalSetting(designatedNotify.KEY, JSON.stringify({ emails, phones }), (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, config: { emails, phones } });
        });
    });
});

app.post('/api/admin/portal-auth-config', (req, res) => {
    const { actingAdminId, config } = req.body || {};
    const aid = parseInt(actingAdminId, 10);
    if (!Number.isInteger(aid) || aid < 1) return res.status(400).json({ error: 'actingAdminId is required' });
    if (!config || typeof config !== 'object') return res.status(400).json({ error: 'config object required' });
    assertAdminPortalActor(aid, (e, adm) => {
        if (e && e.message === 'BAD_ACTOR') return res.status(400).json({ error: 'actingAdminId is required' });
        if (e && e.message === 'FORBIDDEN') return res.status(403).json({ error: 'Administrator access required' });
        if (e) return res.status(500).json({ error: e.message });
        if (!adm) return res.status(403).json({ error: 'Invalid administrator' });
        const merged = portalAuthPolicy.merge(config);
        upsertGlobalSetting(portalAuthPolicy.KEY, JSON.stringify(merged), (err) => {
            if (err) return res.status(500).json({ error: err.message });
            portalAuthPolicy.loadPortalAuthConfig(db, () => {
                res.json({ success: true, config: portalAuthPolicy.getPortalAuthConfig() });
            });
        });
    });
});

app.post('/api/admin/otp/send', withIntegrationSettingsLoaded, (req, res) => {
    const adminUserId = parseInt((req.body || {}).adminUserId, 10);
    const channel = (req.body || {}).channel;
    if (!Number.isInteger(adminUserId) || adminUserId < 1) {
        return res.status(400).json({ error: 'adminUserId is required' });
    }
    if (channel !== 'phone' && channel !== 'email') {
        return res.status(400).json({ error: 'channel must be phone or email' });
    }
    db.get(
        `SELECT id, email, phone, role, user_role FROM users WHERE id = ? AND IFNULL(is_disabled,0) = 0`,
        [adminUserId],
        (e, adm) => {
            if (e) return res.status(500).json({ error: e.message });
            if (!adm) return res.status(404).json({ error: 'User not found' });
            const r0 = String(adm.role || '').toLowerCase();
            const ur0 = String(adm.user_role || '').toLowerCase();
            if (r0 !== 'admin' && ur0 !== 'co_admin') {
                return res.status(403).json({ error: 'Administrator access required' });
            }
            const dest =
                channel === 'email'
                    ? String(adm.email || '')
                          .trim()
                          .toLowerCase()
                    : otpLib.normalizeOtpDestination('phone', String(adm.phone || '').trim()) ||
                      String(adm.phone || '').trim();
            if (!dest) {
                return res.status(400).json({
                    error:
                        channel === 'email'
                            ? 'No email address on file for this admin account.'
                            : 'No phone number on file for this admin account.'
                });
            }
            otpLib.countRecentSends(db, channel, dest, (cerr, cnt) => {
                if (cerr) return res.status(500).json({ error: cerr.message });
                if (cnt >= otpLib.MAX_SENDS_PER_HOUR) {
                    return res.status(429).json({ error: 'Too many OTP requests. Try again later.' });
                }
                const code = otpLib.generateOtpDigits();
                const meta = { adminUserId };
                otpLib.saveOtp(db, { channel, destination: dest, purpose: 'admin_confirm', meta }, code, (serr) => {
                    if (serr) return res.status(500).json({ error: serr.message });
                    notifEngine
                        .sendOtpMessages({
                            email: channel === 'email' ? dest : null,
                            phone: channel === 'phone' ? dest : null,
                            code,
                            db,
                            eventKey: 'OTP_VERIFICATION'
                        })
                        .then((results) => {
                            const sent = channel === 'phone' ? results.whatsapp : results.email;
                            const debug = process.env.OTP_RETURN_CODE === '1' || process.env.NODE_ENV === 'development';
                            const payload = { success: true, ttlMinutes: otpLib.OTP_TTL_MIN };
                            if (debug) payload.debugCode = code;
                            if (!sent.ok && !sent.skipped) {
                                return res.status(503).json({
                                    error: sent.error || 'Could not deliver OTP.',
                                    debugCode: debug ? code : undefined
                                });
                            }
                            if (sent.skipped) {
                                payload.warning = 'Messaging not fully configured; use debugCode in development.';
                            }
                            res.json(payload);
                        });
                });
            });
        }
    );
});

app.post('/api/admin/otp/verify', (req, res) => {
    const adminUserId = parseInt((req.body || {}).adminUserId, 10);
    const channel = (req.body || {}).channel;
    const code = String((req.body || {}).code || '').trim();
    if (!Number.isInteger(adminUserId) || adminUserId < 1) {
        return res.status(400).json({ error: 'adminUserId is required' });
    }
    if (channel !== 'phone' && channel !== 'email') {
        return res.status(400).json({ error: 'channel must be phone or email' });
    }
    if (!code) return res.status(400).json({ error: 'code is required' });
    db.get(
        `SELECT id, email, phone, role, user_role FROM users WHERE id = ? AND IFNULL(is_disabled,0) = 0`,
        [adminUserId],
        (e, adm) => {
            if (e) return res.status(500).json({ error: e.message });
            if (!adm) return res.status(404).json({ error: 'User not found' });
            const r0 = String(adm.role || '').toLowerCase();
            const ur0 = String(adm.user_role || '').toLowerCase();
            if (r0 !== 'admin' && ur0 !== 'co_admin') {
                return res.status(403).json({ error: 'Administrator access required' });
            }
            const dest =
                channel === 'email'
                    ? String(adm.email || '')
                          .trim()
                          .toLowerCase()
                    : otpLib.normalizeOtpDestination('phone', String(adm.phone || '').trim()) ||
                      String(adm.phone || '').trim();
            if (!dest) return res.status(400).json({ error: 'Missing phone or email on admin profile' });
            const meta = { adminUserId };
            otpLib.verifyOtp(
                db,
                {
                    channel,
                    destination: dest,
                    purpose: 'admin_confirm',
                    code,
                    meta,
                    userId: adminUserId,
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

// Admin: Create User
app.post('/api/admin/users/create', (req, res) => {
    const {
        firstName,
        lastName,
        email,
        phone,
        password,
        role,
        actingAdminId,
        adminPhoneOtpToken,
        adminEmailOtpToken,
        isDemo
    } = req.body || {};
    const demoFlag =
        isDemo === true || isDemo === 1 || isDemo === '1' || isDemo === 'true' ? 1 : 0;
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

    requireAdminSensitiveOtpIfEnabled(actingAdminId, adminPhoneOtpToken, adminEmailOtpToken, (eOtp, okOtp, msgOtp) => {
        if (eOtp) return res.status(500).json({ error: eOtp.message });
        if (!okOtp) return res.status(400).json({ error: msgOtp || 'Admin verification required' });
        db.run(
            `INSERT INTO users (user_id_string, first_name, last_name, email, phone, password, role, user_role, email_verified, is_demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
            [userIdStr, cleanFirst, cleanLast, email, phone, finalPassword, roleCol, userRole, demoFlag],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                const newId = this.lastID;
            notifEngine.notify(db, 'ACCOUNT_CREATED', {
                userId: newId,
                vars: { temporary_password: finalPassword }
            });
            designatedNotify.notifyDesignatedAccountCreated(
                db,
                newId,
                { source: 'admin create user', temporary_password: finalPassword },
                () => {}
            );
            res.json({
                success: true,
                userId: newId,
                user_id_string: userIdStr,
                generatedPassword: finalPassword,
                isDemo: !!demoFlag
            });
            }
        );
    });
});

// Admin: Get Users
app.get('/api/admin/users', (req, res) => {
    db.all(
        `SELECT id, user_id_string, first_name, last_name, email, phone, role, user_role, is_disabled,
                IFNULL(is_banned,0) AS is_banned, ban_reason, IFNULL(is_demo,0) AS is_demo, admin_modules FROM users ORDER BY id DESC`,
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
    const userId = parseInt((req.body && req.body.userId) || '', 10);
    const disable = !!(req.body && req.body.disable);
    const actingAdminId = parseInt((req.body && req.body.actingAdminId) || '', 10);
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const applyDisable = () => {
        db.run(`UPDATE users SET is_disabled = ? WHERE id = ?`, [disable ? 1 : 0, userId], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: 'User not found' });
            activityLog.logActivity(db, {
                user_id: actingAdminId || null,
                action: disable ? 'admin.user.disabled' : 'admin.user.enabled',
                resource_type: 'user',
                resource_id: String(userId),
                meta: { targetUserId: userId }
            });
            res.json({ success: true, is_disabled: disable ? 1 : 0 });
        });
    };

    if (!disable) {
        return db.get(`SELECT IFNULL(is_banned,0) AS is_banned FROM users WHERE id = ?`, [userId], (e, row) => {
            if (e) return res.status(500).json({ error: e.message });
            if (!row) return res.status(404).json({ error: 'User not found' });
            if (Number(row.is_banned) === 1) {
                return res.status(400).json({ error: 'User is banned. Unban the account before enabling login.' });
            }
            applyDisable();
        });
    }
    applyDisable();
});

// Admin: Ban / unban user (blocks login and ticket check-in)
app.post('/api/admin/users/toggle_ban', (req, res) => {
    const userId = parseInt((req.body && req.body.userId) || '', 10);
    const ban = !!(req.body && req.body.ban);
    const reason = (req.body && req.body.reason) != null ? String(req.body.reason).trim() : '';
    const actingAdminId = parseInt((req.body && req.body.actingAdminId) || '', 10);
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (ban && reason.length < 3) {
        return res.status(400).json({ error: 'Ban reason is required (at least 3 characters).' });
    }

    const sql = ban
        ? `UPDATE users SET is_banned = 1, is_disabled = 1, ban_reason = ?, banned_at = CURRENT_TIMESTAMP WHERE id = ?`
        : `UPDATE users SET is_banned = 0, ban_reason = NULL, banned_at = NULL WHERE id = ?`;
    const params = ban ? [reason, userId] : [userId];

    db.run(sql, params, function (err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'User not found' });
        activityLog.logActivity(db, {
            user_id: actingAdminId || null,
            action: ban ? 'admin.user.banned' : 'admin.user.unbanned',
            resource_type: 'user',
            resource_id: String(userId),
            meta: { targetUserId: userId, reason: ban ? reason : null }
        });
        res.json({ success: true, is_banned: ban ? 1 : 0, ban_reason: ban ? reason : null });
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
    const aid = parseInt((req.body || {}).actingAdminId, 10);
    if (!Number.isInteger(aid) || aid < 1) {
        return res.status(400).json({ error: 'actingAdminId is required' });
    }
    assertAdminPortalActor(aid, (e, adm) => {
        if (e && e.message === 'BAD_ACTOR') return res.status(400).json({ error: 'actingAdminId is required' });
        if (e && e.message === 'FORBIDDEN') return res.status(403).json({ error: 'Administrator access required' });
        if (e) return res.status(500).json({ error: e.message });
        if (!adm) return res.status(403).json({ error: 'Invalid administrator' });
        const uid = req.body && req.body.userId != null ? req.body.userId : req.body && req.body.user_id;
        const isDemo =
            req.body &&
            (req.body.isDemo === true ||
                req.body.isDemo === 1 ||
                req.body.isDemo === '1' ||
                req.body.isDemo === 'true');
        setUserDemoFlag(uid, isDemo, res);
    });
});

app.post('/api/admin/users/:userId/demo', (req, res) => {
    const aid = parseInt((req.body || {}).actingAdminId, 10);
    if (!Number.isInteger(aid) || aid < 1) {
        return res.status(400).json({ error: 'actingAdminId is required' });
    }
    assertAdminPortalActor(aid, (e, adm) => {
        if (e && e.message === 'BAD_ACTOR') return res.status(400).json({ error: 'actingAdminId is required' });
        if (e && e.message === 'FORBIDDEN') return res.status(403).json({ error: 'Administrator access required' });
        if (e) return res.status(500).json({ error: e.message });
        if (!adm) return res.status(403).json({ error: 'Invalid administrator' });
        const isDemo =
            req.body &&
            (req.body.isDemo === true ||
                req.body.isDemo === 1 ||
                req.body.isDemo === '1' ||
                req.body.isDemo === 'true');
        setUserDemoFlag(req.params.userId, isDemo, res);
    });
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
    const { targetUserId, seminarId, formData, adminUserId, adminPhoneOtpToken, adminEmailOtpToken } = req.body || {};
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
        requireAdminSensitiveOtpIfEnabled(aid, adminPhoneOtpToken, adminEmailOtpToken, (eOtp, okOtp, msgOtp) => {
            if (eOtp) return res.status(500).json({ error: eOtp.message });
            if (!okOtp) return res.status(400).json({ error: msgOtp || 'Admin verification required' });
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
                        const newRegId = this.lastID;
                        notifEngine.notify(
                            db,
                            'SEMINAR_REGISTRATION_SUCCESS',
                            { userId: tid, seminarId: sid, registrationId: newRegId },
                            () => {}
                        );
                        res.json({ success: true, registrationId: newRegId, applicationNo, created: true });
                    }
                );
            });
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
    const { settings } = req.body;
    if (!Array.isArray(settings) || !settings.length) {
        return res.status(400).json({ error: 'settings array required' });
    }
    let pending = settings.length;
    let errOut = null;
    settings.forEach((s) => {
        upsertGlobalSetting(s.key, String(s.value ?? ''), (err) => {
            if (err && !errOut) errOut = err;
            pending -= 1;
            if (pending === 0) {
                if (errOut) return res.status(500).json({ error: errOut.message });
                res.json({ success: true });
            }
        });
    });
});

const maintenanceSettings = require('./lib/maintenance-settings');

app.get('/api/public/maintenance-status', (req, res) => {
    maintenanceSettings.readMaintenanceBundle(db, (err, bundle) => {
        if (err) return res.status(500).json({ error: err.message });
        siteKillSwitch.loadBrandingForMaintenance(db, (bErr, branding) => {
            const pub = maintenanceSettings.publicMaintenancePayload(bundle.config, branding);
            res.json({
                disabled: bundle.disabled,
                headline: pub.headline,
                message: pub.message,
                go_live_at: pub.go_live_at,
                go_live_label: pub.go_live_label,
                site_name: pub.site_name
            });
        });
    });
});

app.get('/api/admin/maintenance-settings', (req, res) => {
    maintenanceSettings.readMaintenanceBundle(db, (err, bundle) => {
        if (err) return res.status(500).json({ error: err.message });
        const rt = integrationSettings.getRuntimeIntegrations();
        let seminarBase = (rt.public_base_url || '').trim().replace(/\/$/, '');
        if (!seminarBase && rt.seminar_host) {
            seminarBase = 'https://' + String(rt.seminar_host).replace(/^https?:\/\//, '').replace(/\/$/, '');
        }
        res.json({
            disabled: bundle.disabled,
            config: bundle.config,
            go_live_due: maintenanceSettings.isGoLiveDue(bundle.config),
            seminar_preview_base: seminarBase || '',
            maintenance_preview_url: '/maintenance-preview'
        });
    });
});

app.post('/api/admin/maintenance-settings', (req, res) => {
    const body = req.body || {};
    maintenanceSettings.readMaintenanceBundle(db, (err, existing) => {
        if (err) return res.status(500).json({ error: err.message });
        const cfg = maintenanceSettings.parseConfig(existing.config);
        if (body.headline != null) cfg.headline = String(body.headline).trim();
        if (body.message != null) cfg.message = String(body.message).trim();
        if (body.go_live_at != null) cfg.go_live_at = String(body.go_live_at).trim();
        if (body.regenerate_preview_secret) {
            cfg.preview_secret = maintenanceSettings.randomPreviewSecret();
        } else if (!cfg.preview_secret) {
            cfg.preview_secret = maintenanceSettings.randomPreviewSecret();
        }
        const disabledVal =
            body.disabled != null
                ? body.disabled === true || body.disabled === '1' || body.disabled === 1
                    ? '1'
                    : '0'
                : existing.disabled
                  ? '1'
                  : '0';

        upsertGlobalSetting(maintenanceSettings.KEY_CONFIG, JSON.stringify(cfg), (e1) => {
            if (e1) return res.status(500).json({ error: e1.message });
            upsertGlobalSetting(maintenanceSettings.KEY_DISABLED, disabledVal, (e2) => {
                if (e2) return res.status(500).json({ error: e2.message });
                res.json({
                    success: true,
                    disabled: disabledVal === '1',
                    config: cfg,
                    preview_secret: cfg.preview_secret
                });
            });
        });
    });
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
    const {
        userId,
        seminarId,
        registrationId,
        rating,
        contentQuality,
        speakerQuality,
        organizationQuality,
        overallExperience,
        suggestions,
        wouldAttendAgain
    } = req.body;
    const uid = parsePositiveUserId(userId);
    const sid = parseInt(seminarId, 10);
    if (!uid) return res.status(400).json({ error: 'Invalid user' });
    if (!Number.isInteger(sid) || sid < 1) return res.status(400).json({ error: 'Invalid seminar' });

    db.get(`SELECT id, event_date, title FROM seminars WHERE id = ?`, [sid], (err, sem) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!sem) return res.status(400).json({ error: 'Seminar not found' });
        if (!isSeminarEnded(sem.event_date)) {
            return res.status(400).json({
                error: 'Feedback is only accepted after the seminar has ended.'
            });
        }

        db.get(
            `SELECT id FROM registrations WHERE user_id = ? AND seminar_id = ? ORDER BY id DESC LIMIT 1`,
            [uid, sid],
            (regErr, reg) => {
                if (regErr) return res.status(500).json({ error: regErr.message });
                if (!reg) {
                    return res.status(400).json({
                        error: 'You must be registered for this seminar before submitting feedback.'
                    });
                }

                db.get(
                    `SELECT id FROM seminar_feedback WHERE user_id = ? AND seminar_id = ?`,
                    [uid, sid],
                    (dupErr, existing) => {
                        if (dupErr) return res.status(500).json({ error: dupErr.message });
                        if (existing) {
                            return res.status(400).json({
                                error: 'You have already submitted feedback for this seminar.'
                            });
                        }

                        const regId =
                            registrationId != null && registrationId !== ''
                                ? parseInt(registrationId, 10)
                                : reg.id;
                        const storedRegId = Number.isInteger(regId) && regId > 0 ? regId : reg.id;

                        db.run(
                            `INSERT INTO seminar_feedback (user_id, seminar_id, registration_id, rating, content_quality, speaker_quality, organization_quality, overall_experience, suggestions, would_attend_again) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                            [
                                uid,
                                sid,
                                storedRegId,
                                rating || 5,
                                contentQuality || 5,
                                speakerQuality || 5,
                                organizationQuality || 5,
                                overallExperience,
                                suggestions,
                                wouldAttendAgain ? 1 : 0
                            ],
                            function (insErr) {
                                if (insErr) return res.status(500).json({ error: insErr.message });
                                res.json({ success: true, id: this.lastID });
                            }
                        );
                    }
                );
            }
        );
    });
});

app.get('/api/feedback/eligible-seminars/:userId', (req, res) => {
    const uid = parsePositiveUserId(req.params.userId);
    if (!uid) return res.status(400).json({ error: 'Invalid user id' });
    db.all(
        `SELECT s.id, s.title, s.event_date, r.id AS registration_id
         FROM registrations r
         JOIN seminars s ON s.id = r.seminar_id
         WHERE r.user_id = ?
         AND NOT EXISTS (
             SELECT 1 FROM seminar_feedback sf
             WHERE sf.user_id = r.user_id AND sf.seminar_id = r.seminar_id
         )
         ORDER BY s.event_date DESC, s.id DESC`,
        [uid],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            const eligible = (rows || []).filter((r) => isSeminarEnded(r.event_date));
            res.json(eligible);
        }
    );
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

// ==================== CONTACT INQUIRIES (public website) ====================

app.post('/api/public/contact-inquiry', (req, res) => {
    const { name, email, phone, subject, message } = req.body || {};
    const n = String(name || '').trim();
    const em = String(email || '').trim().toLowerCase();
    const sub = String(subject || '').trim();
    const msg = String(message || '').trim();
    if (!n || !em || !sub || !msg) {
        return res.status(400).json({ error: 'Name, email, subject, and message are required.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
        return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    ensureContactInquiriesSchema(db, ignoreSchemaMigrationErr, () => {
        db.run(
            `INSERT INTO contact_inquiries (name, email, phone, subject, message, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'new', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [n, em, String(phone || '').trim() || null, sub, msg],
            function (err) {
                if (err) {
                    const m = String(err.message || '');
                    if (/contact_inquiries/i.test(m) && /does not exist|no such table/i.test(m)) {
                        return res.status(503).json({
                            error:
                                'Contact form database is updating. Please try again in one minute, or ask the administrator to restart the seminar app.'
                        });
                    }
                    return res.status(500).json({ error: err.message });
                }
                res.json({ success: true, id: this.lastID });
            }
        );
    });
});

app.get('/api/admin/contact-inquiries', (req, res) => {
    const status = req.query.status ? String(req.query.status).trim() : '';
    const runList = () => {
    let sql = `SELECT * FROM contact_inquiries WHERE 1=1`;
    const params = [];
    if (status) {
        sql += ` AND status = ?`;
        params.push(status);
    }
    sql += ` ORDER BY created_at DESC LIMIT 500`;
    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
    };
    ensureContactInquiriesSchema(db, ignoreSchemaMigrationErr, runList);
});

app.put('/api/admin/contact-inquiries/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });
    const { status, admin_notes } = req.body || {};
    const st = status != null ? String(status).trim() : null;
    const notes = admin_notes != null ? String(admin_notes).trim() : null;
    db.get(`SELECT * FROM contact_inquiries WHERE id = ?`, [id], (e, row) => {
        if (e) return res.status(500).json({ error: e.message });
        if (!row) return res.status(404).json({ error: 'Inquiry not found' });
        const newStatus = st || row.status || 'new';
        const newNotes = notes !== null && notes !== '' ? notes : row.admin_notes;
        const repliedAt = newStatus === 'replied' || newStatus === 'closed' ? new Date().toISOString() : row.replied_at;
        db.run(
            `UPDATE contact_inquiries SET status = ?, admin_notes = ?, replied_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [newStatus, newNotes, repliedAt, id],
            (e2) => {
                if (e2) return res.status(500).json({ error: e2.message });
                res.json({ success: true });
            }
        );
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
        `INSERT INTO support_tickets (ticket_id, tracking_id, user_id, category, subject, description, attachment_path, priority, status, created_at, updated_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [ticketId, ticketId, uid, cat, subject.trim(), description.trim(), attachment_path || null, 'medium'],
        function (err) {
            if (err) {
                console.error('[support-ticket/create]', err.message);
                return res.status(500).json({ error: err.message || 'Could not create ticket. Please try again.' });
            }
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
    db.all(
        `SELECT *, COALESCE(ticket_id, tracking_id) AS ticket_id FROM support_tickets WHERE user_id = ? ORDER BY created_at DESC`,
        [userId],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        }
    );
});

// Get Ticket Details with Messages
app.get('/api/support-ticket/:ticketId', (req, res) => {
    const { ticketId } = req.params;
    db.get(`SELECT st.*, u.first_name, u.last_name, u.email FROM support_tickets st 
            LEFT JOIN users u ON st.user_id = u.id 
            WHERE st.ticket_id = ? OR st.tracking_id = ?`, [ticketId, ticketId], (err, ticket) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
        const tid = ticket.ticket_id || ticket.tracking_id;
        
        db.all(`SELECT tm.*, u.first_name, u.last_name FROM ticket_messages tm 
                LEFT JOIN users u ON tm.sender_id = u.id 
                WHERE tm.ticket_id = ? 
                ORDER BY tm.created_at ASC`, [tid, tid], (err, messages) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ...ticket, ticket_id: tid, messages: messages || [] });
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
    backfillTicketsForPaidOrders((ePaid, nPaid) => {
        if (ePaid) console.warn('[tickets] Paid-order ticket backfill failed:', ePaid.message);
        else if (nPaid) console.log(`[tickets] Created ${nPaid} missing e-ticket(s) for paid orders.`);
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
        db.get(`SELECT value FROM global_settings WHERE key = ?`, [portalAuthPolicy.KEY], (ePk, rowPk) => {
            if (!ePk && !rowPk) {
                upsertGlobalSetting(portalAuthPolicy.KEY, JSON.stringify(portalAuthPolicy.DEFAULTS), () => {});
            }
            portalAuthPolicy.loadPortalAuthConfig(db, () => {});
        });
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
