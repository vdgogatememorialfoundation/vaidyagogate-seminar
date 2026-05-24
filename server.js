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
const pincodeLookup = require('./lib/pincode-lookup');
const countriesList = require('./lib/countries');
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
const contactValidation = require('./lib/contact-validation');
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
const supportTicketNotify = require('./lib/support-ticket-notify');
const supportTicketSla = require('./lib/support-ticket-sla');
const { ensureContactInquiriesSchema } = require('./lib/contact-inquiries-schema');
const paymentsMod = require('./lib/payments-module');
const adminPaymentFlow = require('./lib/admin-payment-flow');
const { registerPaymentsRoutes } = require('./lib/routes-payments');
const seminarCapacity = require('./lib/seminar-capacity');
const ticketScanEvents = require('./lib/ticket-scan-events');
const feedbackFormConfig = require('./lib/feedback-form-config');
const { registerLiveScannerRoutes } = require('./lib/routes-live-scanner');
const { registerPosRoutes } = require('./lib/pos-onspot');
const siteSeoMod = require('./lib/site-seo');
const emailDeliveryPolicy = require('./lib/email-delivery-policy');
const volunteerCertFlow = require('./lib/volunteer-cert-flow');
const volunteerTicketFlow = require('./lib/volunteer-ticket-flow');
const regPaymentStatus = require('./lib/registration-payment-status');
const userAccountLifecycle = require('./lib/user-account-lifecycle');

function volunteerTicketDeps() {
    return {
        generateId,
        insertParticipantTicket,
        syncCertificateEligibilityForTicket,
        certVerify,
        notifEngine,
        notifyTicketIssued,
        buildDisplayNameFromFormData,
        markRegistrationETicketIssued: regPaymentStatus.markRegistrationETicketIssued
    };
}
const authUsers = require('./lib/auth-users');
const authLoginOtp = require('./lib/auth-login-otp');
const certRender = require('./lib/certificate-render');
const certTemplateCfg = require('./lib/certificate-template-config');
const certVerify = require('./lib/certificate-verify');
const docVerify = require('./lib/application-document-verify');
const seminarPurge = require('./lib/seminar-purge');
const supplementalPayments = require('./lib/supplemental-payments');
const { safeInternalUserRowId } = require('./lib/internal-user-id');
const regCertVerify = require('./lib/registration-certificate-verify');
const seminarAnalytics = require('./lib/seminar-analytics');
const { filterConfirmedRows } = require('./lib/confirmed-participants');
const adminLiveEdit = require('./lib/admin-live-edit');
const adminComposeMail = require('./lib/admin-compose-mail');
const systemHealth = require('./lib/system-health');
const systemHealthAi = require('./lib/system-health-ai');
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

function paymentAmountForSeminar(row) {
    const p = row && row.price != null ? Number(row.price) : NaN;
    return Number.isFinite(p) && p > 0 ? p : 1500;
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
        jobsModule,
        getOrCreatePendingOrder,
        portalTracking,
        notifyTicketIssued,
        assertAdminPortalActor
    });
    supplementalPayments.registerSupplementalPaymentRoutes(app, db, {
        fileStore,
        parsePositiveUserId
    });
}

function bootstrapApp(done) {
    mountExtendedRoutes();
    mountPaymentsRoutes();
    const r2Storage = require('./lib/r2-storage');
    r2Storage.warmupR2().catch((e) => console.warn('[r2] warmup:', e.message));
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
        if (pgDb && pgDb.ensureAuxiliaryTables) {
            return pgDb
                .ensureAuxiliaryTables()
                .then((stillMissing) => {
                    if (stillMissing && stillMissing.length) {
                        console.warn('[bootstrap] auxiliary tables still missing:', stillMissing.join(', '));
                    }
                    scheduleDeferredMigrations();
                })
                .catch((e) => {
                    console.warn('[bootstrap] auxiliary tables:', e.message);
                    scheduleDeferredMigrations();
                });
        }
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
    const runPgColumnPatches = () => {
        const tasks = [];
        if (pgDb.ensureCertificateVerifyColumns) {
            tasks.push(
                pgDb.ensureCertificateVerifyColumns().catch((e) => {
                    console.warn('[bootstrap] certificate verify columns:', e.message);
                })
            );
        }
        if (pgDb.ensureAuxiliaryTables) {
            tasks.push(
                pgDb.ensureAuxiliaryTables().catch((e) => {
                    console.warn('[bootstrap] auxiliary tables:', e.message);
                })
            );
        }
        tasks.push(
            new Promise((resolve) => {
                paymentGatewayOptions.activateGatewaysWithCredentials(db, (err) => {
                    if (err) console.warn('[payment-gateways] auto-activate:', err.message);
                    resolve();
                });
            })
        );
        return tasks.length ? Promise.all(tasks) : Promise.resolve();
    };
    if (pgDb.ensureMissingCoreTables) {
        return pgDb
            .ensureMissingCoreTables()
            .then(() => runPgColumnPatches())
            .then(() => startMigrations())
            .catch(() => runFullMigrations());
    }
    runPgColumnPatches().then(() => startMigrations()).catch(() => startMigrations());
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
                const reportSchema = () =>
                    Promise.all([
                        pgDb.listMissingCoreTables(),
                        pgDb.listMissingAuxTables ? pgDb.listMissingAuxTables() : Promise.resolve([])
                    ]).then(([coreMissing, auxMissing]) => {
                        const missing = [...coreMissing, ...auxMissing];
                        if (pgDb.getSchemaApplyErrors) {
                            const errs = pgDb.getSchemaApplyErrors();
                            if (errs.length) payload.schemaApplyErrors = errs.slice(0, 5);
                        }
                        if (missing.length) {
                            payload.ok = false;
                            payload.schema = { missingTables: missing };
                            payload.hint =
                                'PostgreSQL schema is incomplete. Redeploy after fixing DATABASE_URL, or run schema-postgres.sql on Neon.';
                        }
                        res.json(payload);
                    });
                if (pgDb.ensureAuxiliaryTables) {
                    return pgDb
                        .ensureAuxiliaryTables()
                        .then(() => reportSchema())
                        .catch(() => reportSchema());
                }
                return reportSchema().catch((e) => {
                    payload.ok = false;
                    payload.schema = { checkError: sanitizeDbError(e) };
                    payload.hint = publicDatabaseHint('DB_CONNECT_FAILED');
                    res.json(payload);
                });
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

app.get('/certificate/view', (req, res) => {
    certRender.handleViewRequest(db, req, res);
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

app.get('/api/public/countries', (req, res) => {
    res.json({ countries: countriesList.getCountries() });
});

app.get('/api/public/pincode-lookup', async (req, res) => {
    try {
        const result = await pincodeLookup.lookupPincode(req.query.pin);
        res.json(result);
    } catch (e) {
        res.status(500).json({ ok: false, error: 'PIN lookup failed' });
    }
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
const UPLOAD_MAX_BYTES = 4 * 1024 * 1024; // match Vercel ~4.5 MB request body limit
const upload = multer({ storage: storage, limits: { fileSize: UPLOAD_MAX_BYTES } });
const memoryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: UPLOAD_MAX_BYTES } });

function uploadErrorMessage(err) {
    if (!err) return 'Upload failed';
    if (err.code === 'LIMIT_FILE_SIZE') {
        return 'File is too large (max 4 MB per file on this server). Compress PDF/photos and try again.';
    }
    if (err.code === 'LIMIT_FILE_COUNT') return 'Too many files in one upload.';
    return err.message || 'Upload failed';
}

function withCertificateUpload(req, res, next) {
    (process.env.VERCEL ? memoryUpload : upload).single('certificate')(req, res, (err) => {
        if (err) {
            return res.status(400).json({ error: uploadErrorMessage(err) });
        }
        next();
    });
}
const fileStore = require('./lib/file-store');

/** Multer middleware: memory on Vercel, disk locally; assigns stable filenames. */
function withMemoryAwareUpload(field) {
    const mw = fileStore.createUploadHandler(upload, memoryUpload).single(field);
    return (req, res, next) => {
        mw(req, res, (err) => {
            if (err) {
                return res.status(400).json({ error: uploadErrorMessage(err) });
            }
            next();
        });
    };
}
const siteCmsHelpers = require('./lib/site-cms-helpers');
const caseUpload = fileStore.createUploadHandler(upload, memoryUpload);

app.get('/uploads/api/assets/:key', fileStore.serveAssetHandler(db));
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
                    db.run(`ALTER TABLE users ADD COLUMN activated_at TEXT`, (err4b) => {
                        ignoreDup(err4b);
                        userAccountLifecycle.backfillAccountActivatedAt(db, () => {});
                        db.run(`ALTER TABLE users ADD COLUMN doctor_category TEXT DEFAULT 'regular'`, (err5) => {
                            ignoreDup(err5);
                            db.run(`ALTER TABLE users ADD COLUMN doctor_modules TEXT`, (err6) => {
                                ignoreDup(err6);
                                afterUsers();
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

function recordUserLogin(userId, cb) {
    const uid = parseInt(userId, 10);
    if (!Number.isInteger(uid) || uid < 1) return cb && cb(null, { previousLoginAt: null, loginAt: new Date().toISOString() });
    db.get(`SELECT last_login_at FROM users WHERE id = ?`, [uid], (e, row) => {
        if (e && /does not exist|no such column/i.test(String(e.message || ''))) {
            return cb && cb(null, { previousLoginAt: null, loginAt: new Date().toISOString() });
        }
        if (e) return cb && cb(e);
        const previousLoginAt = row && row.last_login_at ? String(row.last_login_at) : null;
        db.run(
            `UPDATE users SET last_login_at = CURRENT_TIMESTAMP, activated_at = COALESCE(activated_at, CURRENT_TIMESTAMP) WHERE id = ?`,
            [uid],
            (e2) => {
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
        { key: 'mname', label: 'Middle name', type: 'text', step: 1, enabled: true, required: false },
        { key: 'lname', label: 'Last name', type: 'text', step: 1, enabled: true, required: true },
        { key: 'email', label: 'Email', type: 'email', step: 1, enabled: true, required: true, verifyOtp: true },
        { key: 'phone', label: 'Phone', type: 'tel', step: 1, enabled: true, required: true, verifyOtp: true },
        { key: 'dob', label: 'Date of birth', type: 'date', step: 1, enabled: true, required: true },
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
        { key: 'cpin', label: 'College PIN code', type: 'text', step: 4, enabled: true, required: true, onlyWhenPgCollege: true },
        { key: 'college', label: 'College name', type: 'text', step: 4, enabled: true, required: true, onlyWhenPgCollege: true },
        { key: 'ccity', label: 'College city', type: 'text', step: 4, enabled: true, required: true, onlyWhenPgCollege: true },
        { key: 'cstate', label: 'College state', type: 'text', step: 4, enabled: true, required: true, onlyWhenPgCollege: true },
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
    seminarGalleryYears: [],
    siteMenu: siteCmsHelpers.DEFAULT_SITE_MENU,
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
        eyebrow: 'National CME Congress',
        title: 'National Seminar 2026',
        subtitle: 'Advancements in Ayurveda & Integrative Medicine',
        venue: 'Convention Centre, Pune',
        image: '',
        ctaPrimary: 'Register now',
        ctaSecondary: 'View programme'
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
    seo: { ...siteSeoMod.DEFAULT_SEO },
    footer: {
        tagline: 'Promoting Ayurveda education since 1972',
        copyright: '© 2026 Vaidya Gogate Memorial Foundation. All rights reserved.',
        exploreTitle: 'Explore',
        doctorTitle: 'Doctor access',
        contactTitle: 'Contact',
        creditHtml:
            'Developed by <a href="https://capturevisualstudios.com" target="_blank" rel="noopener noreferrer">Capture Visual Studios</a>',
        exploreLinks: [
            { label: 'Home', section: 'home' },
            { label: 'About', section: 'about' },
            { label: 'Schedule', section: 'schedule' },
            { label: 'Gallery', section: 'gallery' }
        ],
        doctorLinks: [
            { label: 'Sign in', action: 'login' },
            { label: 'Create account', action: 'signup' }
        ]
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
        db.run(
            `CREATE TABLE IF NOT EXISTS application_edits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            application_id INTEGER,
            edited_by_user_id INTEGER,
            changes TEXT,
            edited_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (application_id) REFERENCES registrations(id)
        )`,
            (aeErr) => ignoreSchemaMigrationErr(aeErr)
        );
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
                                        db.run(`ALTER TABLE seminars ADD COLUMN otp_on_step1 INTEGER DEFAULT 1`, (h7a) => {
                                            ignoreSchemaMigrationErr(h7a);
                                            db.run(`ALTER TABLE seminars ADD COLUMN otp_on_submit INTEGER DEFAULT 1`, (h7a2) => {
                                                ignoreSchemaMigrationErr(h7a2);
                                                db.run(`ALTER TABLE seminars ADD COLUMN public_list_enabled INTEGER DEFAULT 0`, (h7b) => {
                                            ignoreSchemaMigrationErr(h7b);
                                        db.run(`ALTER TABLE seminars ADD COLUMN cert_scans_required INTEGER DEFAULT 1`, (h7c) => {
                                            ignoreSchemaMigrationErr(h7c);
                                        db.run(`ALTER TABLE seminars ADD COLUMN certificate_verify_enabled INTEGER DEFAULT 0`, (h7d) => {
                                            ignoreSchemaMigrationErr(h7d);
                                        db.run(`ALTER TABLE seminars ADD COLUMN show_seats_public INTEGER DEFAULT 1`, (h7s) => {
                                            ignoreSchemaMigrationErr(h7s);
                                            ticketScanEvents.ensureTicketScanEventsTable(db, () => {});
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
                                                                seedGlobalSettingIfMissing(
                                                                    emailDeliveryPolicy.KEY,
                                                                    JSON.stringify(emailDeliveryPolicy.DEFAULT_CONFIG),
                                                                    () => {
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
                                                                                                                                    judgeContact.ensureSchema(
                                                                                                                                        db,
                                                                                                                                        () => {
                                                                                                                                            pendingRegReminders.ensureSchema(
                                                                                                                                                db,
                                                                                                                                                () => {
                                                                                                                                    paymentGatewayOptions.activateGatewaysWithCredentials(
                                                                                                                                        db,
                                                                                                                                        (pgActErr) => {
                                                                                                                                            if (pgActErr) {
                                                                                                                                                console.warn(
                                                                                                                                                    '[payment-gateways] auto-activate:',
                                                                                                                                                    pgActErr.message
                                                                                                                                                );
                                                                                                                                            }
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
                        });
                    });
                });
            });
        });
        });
    });
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
                    certVerify.ensureCertificateVerifySchema(db, ignoreSchemaMigrationErr, () => {
                        docVerify.ensureDocumentVerifySchema(db, ignoreSchemaMigrationErr, () => {
                            if (next) next();
                        });
                    });
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
    volunteerCertFlow.syncDualCertEligibilityFromTicketScan(
        db,
        certVerify,
        ticketId,
        buildDisplayNameFromFormData,
        cb
    );
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

const regFormCfg = require('./lib/registration-form-config');

function loadGlobalRegistrationFormConfig(callback) {
    db.get(`SELECT value FROM global_settings WHERE key = 'registration_form_config'`, [], (err, row) => {
        if (err || !row || !row.value) {
            const def = regFormCfg.buildConfigPayload(DEFAULT_REGISTRATION_FORM_CONFIG.fields, {});
            return callback(null, def);
        }
        try {
            const parsed = regFormCfg.parseRegistrationFormPayload(JSON.parse(row.value));
            if (!parsed.fields.length) {
                parsed.fields = DEFAULT_REGISTRATION_FORM_CONFIG.fields;
            }
            callback(null, regFormCfg.buildConfigPayload(parsed.fields, parsed));
        } catch (_) {
            callback(null, regFormCfg.buildConfigPayload(DEFAULT_REGISTRATION_FORM_CONFIG.fields, {}));
        }
    });
}

function loadGlobalRegistrationFormFields(callback) {
    loadGlobalRegistrationFormConfig((e, cfg) => {
        if (e) return callback(e);
        callback(null, cfg.fields);
    });
}

function loadRegistrationFormConfig(seminarIdOrNull, callback) {
    let seminarId = seminarIdOrNull;
    let cb = callback;
    if (typeof seminarIdOrNull === 'function') {
        cb = seminarIdOrNull;
        seminarId = null;
    }
    const finish = (cfg) => cb(null, cfg);

    loadGlobalRegistrationFormConfig((eGlobal, globalCfg) => {
        if (eGlobal) return cb(eGlobal);
        if (seminarId == null || seminarId === '' || Number.isNaN(Number(seminarId))) {
            return finish(globalCfg);
        }
        const sid = Number(seminarId);
        db.get(`SELECT registration_form_json FROM seminars WHERE id = ?`, [sid], (err, row) => {
            if (err) return cb(err);
            if (!row || !row.registration_form_json || !String(row.registration_form_json).trim()) {
                return finish(globalCfg);
            }
            const seminarParsed = regFormCfg.parseRegistrationFormPayload(row.registration_form_json);
            if (!seminarParsed.fields.length) {
                return finish({
                    ...globalCfg,
                    birthYearMin: seminarParsed.birthYearMin != null ? seminarParsed.birthYearMin : globalCfg.birthYearMin,
                    birthYearMax: seminarParsed.birthYearMax != null ? seminarParsed.birthYearMax : globalCfg.birthYearMax
                });
            }
            const mergedFields = regFormCfg.mergeRegistrationFields(globalCfg.fields, seminarParsed.fields);
            finish(
                regFormCfg.buildConfigPayload(mergedFields, {
                    birthYearMin:
                        seminarParsed.birthYearMin != null ? seminarParsed.birthYearMin : globalCfg.birthYearMin,
                    birthYearMax:
                        seminarParsed.birthYearMax != null ? seminarParsed.birthYearMax : globalCfg.birthYearMax
                })
            );
        });
    });
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
                    if (!base.hero.eyebrow) base.hero.eyebrow = DEFAULT_PUBLIC_SITE_CMS.hero.eyebrow;
                    if (!Array.isArray(base.heroStats)) base.heroStats = DEFAULT_PUBLIC_SITE_CMS.heroStats;
                    if (!Array.isArray(base.featureCards)) base.featureCards = DEFAULT_PUBLIC_SITE_CMS.featureCards;
                    if (!base.contact || typeof base.contact !== 'object') base.contact = { ...DEFAULT_PUBLIC_SITE_CMS.contact };
                    if (!base.schedulePage || typeof base.schedulePage !== 'object') {
                        base.schedulePage = { ...DEFAULT_PUBLIC_SITE_CMS.schedulePage };
                    }
                    if (!Array.isArray(base.faq)) base.faq = DEFAULT_PUBLIC_SITE_CMS.faq;
                    if (!base.footer || typeof base.footer !== 'object') base.footer = { ...DEFAULT_PUBLIC_SITE_CMS.footer };
                    base.seo = siteSeoMod.normalizeSeo(base.seo || DEFAULT_PUBLIC_SITE_CMS.seo);
                }
            } catch (_) {
                /* keep defaults */
            }
        }
        if (!base.seo) base.seo = siteSeoMod.normalizeSeo(DEFAULT_PUBLIC_SITE_CMS.seo);
        base.scrollingAnnouncements = sanitizeScrollingAnnouncements(base.scrollingAnnouncements);
        callback(null, siteCmsHelpers.normalizeSiteCms(base));
    });
}

siteSeoMod.registerSiteSeoRoutes(app, { db, loadPublicSiteCms });

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

function validateFormDataAgainstRegistrationConfig(formData, hasCertificateFile, fields, qualOverride, policy) {
    const fd = formData && typeof formData === 'object' ? formData : {};
    if (fd.source === 'pos' || fd.onSpot === true) {
        return null;
    }
    const nameErr = validateRegistrationPersonNames(formData);
    if (nameErr) return nameErr;
    const contactErr = contactValidation.validateFormContactFields(formData, fields);
    if (contactErr) return contactErr;
    return regFormCfg.validateFormWithPolicy(formData, hasCertificateFile, fields, qualOverride, policy);
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

function certificateFileFromReq(req) {
    if (req.file) return req.file;
    if (req.files && req.files.certificate && req.files.certificate[0]) return req.files.certificate[0];
    return null;
}

function additionalDocFileFromReq(req) {
    if (req.files && req.files.additionalDoc && req.files.additionalDoc[0]) return req.files.additionalDoc[0];
    return null;
}

function persistUploadedCertificate(req, cb) {
    const certFile = certificateFileFromReq(req);
    if (!certFile) return cb(null, null);
    fileStore.persistToGlobalAsset(db, upsertGlobalSetting, certFile, 'cert_', (err, assetPath) => {
        if (err) return cb(err);
        if (assetPath) return cb(null, assetPath);
        cb(null, certFile.filename ? '/uploads/' + certFile.filename : null);
    });
}

function withApplicationDocUpload(req, res, next) {
    (process.env.VERCEL ? memoryUpload : upload).fields([
        { name: 'certificate', maxCount: 1 },
        { name: 'additionalDoc', maxCount: 1 }
    ])(req, res, (err) => {
        if (err) return res.status(400).json({ error: uploadErrorMessage(err) });
        next();
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
                            markRegistrationETicketIssued(row.registration_id, () => {});
                        }
                        next();
                    }
                );
            };
            next();
        }
    );
}

function notifyTicketIssued(userId, registrationId, ticketId, channelOpts) {
    channelOpts = channelOpts || {};
    if (!userId || !registrationId || !ticketId) return;
    emailDeliveryPolicy.loadConfig(db, (eCfg, deliveryCfg) => {
        const skipPosEmail = emailDeliveryPolicy.shouldSkipPosParticipantEmail(deliveryCfg, channelOpts);
        const sendEmail = !skipPosEmail && channelOpts.email !== false;
        const sendWhatsapp = !!(channelOpts.whatsapp === true);
        const sendTemplateNotify = !!(channelOpts.templateNotify === true || channelOpts.whatsapp === true);
        const drainImmediate = channelOpts.immediate === true && !emailDeliveryPolicy.shouldDeferImmediateEmail(deliveryCfg);
        runNotifyTicketIssued(
            userId,
            registrationId,
            ticketId,
            { sendEmail, sendWhatsapp, sendTemplateNotify, drainImmediate }
        );
    });
}

function runNotifyTicketIssued(userId, registrationId, ticketId, opts) {
    const sendEmail = opts.sendEmail;
    const sendWhatsapp = opts.sendWhatsapp;
    const sendTemplateNotify = opts.sendTemplateNotify;
    const drainImmediate = opts.drainImmediate;
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
            if (sendTemplateNotify) {
                notifEngine.notify(
                    db,
                    'TICKET_ISSUED',
                    {
                        userId,
                        seminarId,
                        registrationId,
                        vars,
                        immediate: drainImmediate,
                        skipWhatsapp: !sendWhatsapp
                    },
                    () => {
                        if (!drainImmediate) return;
                        try {
                            notifEngine.drainNotificationQueue(db, 1);
                        } catch (_) {}
                    }
                );
            }
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
                            if (sendEmail && u.email) {
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
                                        event_key: 'TICKET_ISSUED',
                                        immediate: drainImmediate
                                    },
                                    () => {}
                                );
                            }
                            if (sendWhatsapp && u.phone) {
                                notifEngine.enqueueDirectMessage(
                                    db,
                                    {
                                        channel: 'whatsapp',
                                        destination: u.phone,
                                        body: waLine,
                                        event_key: 'TICKET_ISSUED',
                                        immediate: drainImmediate,
                                        userId
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
                                                cb && cb(e3, etk2, qr2);
                                            }
                                        );
                                    }
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
                        cb && cb(eFix, etk, qr);
                    }
                );
            }
            attemptInsert(0);
        });
    });
}

function markRegistrationETicketIssued(registrationId, cb) {
    regPaymentStatus.markRegistrationETicketIssued(db, registrationId, cb);
}

function recordScanEventForDashboard(seminarId, staffId, payload) {
    const sid = parseInt(seminarId, 10);
    if (!Number.isInteger(sid) || sid < 1) return;
    ticketScanEvents.recordTicketScanEvent(
        db,
        {
            seminar_id: sid,
            scanned_by: staffId,
            ticket_db_id: payload.ticket_db_id,
            ticket_id_string: payload.ticket_id_string,
            application_no: payload.application_no,
            doctor_user_id: payload.doctor_user_id,
            doctor_name: payload.doctor_name,
            outcome: payload.outcome || 'failed',
            message: payload.message || null
        },
        () => {}
    );
}

function logScanDashboard(seminarId, staffId, outcome, message, row) {
    const name = row
        ? buildDisplayNameFromFormData(row.form_data, {
              first_name: row.doctor_first_name,
              last_name: row.doctor_last_name
          })
        : null;
    recordScanEventForDashboard(seminarId, staffId, {
        ticket_db_id: row && row.ticket_id,
        ticket_id_string: row && row.ticket_id_string,
        application_no: row && row.application_no,
        doctor_user_id: row && row.doctor_user_id,
        doctor_name: name,
        outcome: outcome || 'failed',
        message: message || null
    });
}

/** Reuse existing pending order or create one (avoids duplicate pending rows per registration). */
function getOrCreatePendingOrder(registrationId, amount, cb) {
    const amt = amount != null && !Number.isNaN(Number(amount)) ? Number(amount) : 1500;
    db.get(
        `SELECT id, order_id_string, amount FROM orders WHERE registration_id = ? AND status = 'success' ORDER BY id DESC LIMIT 1`,
        [registrationId],
        (eSuccess, paid) => {
            if (eSuccess) return cb && cb(eSuccess);
            if (paid) return cb(null, paid);
            db.get(
        `SELECT id, order_id_string, amount FROM orders WHERE registration_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`,
        [registrationId],
        (e, row) => {
            if (e) return cb && cb(e);
            if (row) {
                if (Math.abs(Number(row.amount) - amt) > 0.009) {
                    return db.run(
                        `UPDATE orders SET amount = ? WHERE id = ? AND status = 'pending'`,
                        [amt, row.id],
                        (uErr) => {
                            if (uErr) return cb(uErr);
                            cb(null, { id: row.id, order_id_string: row.order_id_string });
                        }
                    );
                }
                return cb(null, row);
            }
            const orderIdStr = 'ORD_' + generateId();
            db.run(
                `INSERT INTO orders (order_id_string, registration_id, amount, status) VALUES (?, ?, ?, 'pending')`,
                [orderIdStr, registrationId, amt],
                function (insErr) {
                    if (insErr) return cb(insErr);
                    cb(null, { id: this.lastID, order_id_string: orderIdStr });
                }
            );
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
                markRegistrationETicketIssued(registrationId, () => {});
                return db.run(
                    `DELETE FROM orders WHERE registration_id = ? AND status = 'pending'`,
                    [registrationId],
                    () => {
                        db.get(
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
                                    (eT, etk, qr, meta) => {
                                        if (!eT) markRegistrationETicketIssued(registrationId, () => {});
                                        cb(eT, {
                                            orderId: paid.id,
                                            orderIdString: paid.order_id_string,
                                            alreadyPaid: true,
                                            ticketId: etk,
                                            skipped: meta && meta.skipped
                                        });
                                    }
                                );
                            }
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
                                markRegistrationETicketIssued(registrationId, () => {});
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
                                            (eT, etk, qr, meta) => {
                                                if (!eT) markRegistrationETicketIssued(registrationId, () => {});
                                                cb(eT, {
                                                    orderId: orderDbId,
                                                    orderIdString: orderStr,
                                                    ticketId: etk,
                                                    skipped: meta && meta.skipped
                                                });
                                            }
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
const judgeContact = require('./lib/judge-participant-contact');
const pendingRegReminders = require('./lib/pending-registration-reminders');
const portalThemeMod = require('./lib/portal-theme');

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
            ignoreSchemaMigrationErr,
            certVerify,
            docVerify,
            portalTracking,
            notifEngine,
            notifyTicketIssued,
            volunteerTicketDeps: volunteerTicketDeps(),
            requireAdminSensitiveOtpIfEnabled
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
    db.all(`SELECT * FROM payment_gateways`, [], (err, rows) => {
        if (err) return callback(err);
        adminPaymentFlow.loadUpiConfig(db, (eUpi, upiCfg) => {
            if (eUpi) return callback(eUpi);
            callback(null, adminPaymentFlow.buildDoctorPaymentMethods(rows || [], upiCfg));
        });
    });
}

const doctorPaymentDeps = () => ({
    getOrCreatePendingOrder,
    fulfillRegistrationPayment,
    portalTracking,
    notifEngine,
    notifyTicketIssued
});

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

function withAuxiliaryTables(req, res, next) {
    if (pgDb && typeof pgDb.ensureAuxiliaryTables === 'function') {
        return pgDb
            .ensureAuxiliaryTables()
            .then(() => next())
            .catch((e) => {
                console.warn('[aux-tables]', e.message);
                next();
            });
    }
    next();
}

function withSupportTickets(req, res, next) {
    const run = () => ensureSupportTicketSchema(db, ignoreSchemaMigrationErr, next);
    if (pgDb && typeof pgDb.ensureAuxiliaryTables === 'function') {
        return pgDb
            .ensureAuxiliaryTables()
            .then(run)
            .catch((e) => {
                console.warn('[support-tickets-schema]', e.message);
                run();
            });
    }
    run();
}

function formatCheckInTimeForNotify(at) {
    try {
        const d = at ? new Date(at) : new Date();
        return d.toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            weekday: 'short',
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch (_) {
        return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    }
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

function loginOtpRequired(portal) {
    if (portal) return portalAuthPolicy.loginOtpRequiredForPortal(portal);
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

function parseDoctorModulesJson(str) {
    if (str == null || !String(str).trim()) return null;
    try {
        const o = JSON.parse(str);
        return o && typeof o === 'object' ? o : null;
    } catch (_) {
        return null;
    }
}

function sanitizeDoctorCategory(v) {
    const c = String(v == null ? '' : v).trim().toLowerCase();
    return c === 'volunteer' ? 'volunteer' : 'regular';
}

function sanitizeDoctorModulesInput(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const out = {};
    Object.keys(src).forEach((k) => {
        if (!k) return;
        out[String(k)] = !!src[k];
    });
    return out;
}

app.get('/api/auth/signup-otp-required', withIntegrationSettingsLoaded, (req, res) => {
    res.json({ required: signupOtpRequired() });
});

app.get('/api/auth/login-otp-required', withIntegrationSettingsLoaded, (req, res) => {
    const portal = portalAuthPolicy.normalizeLoginPortal(req.query && req.query.portal);
    res.json({
        required: loginOtpRequired(portal),
        portal,
        staffPortal: portalAuthPolicy.isStaffPortal(portal)
    });
});

/** Signup/login: detect existing account (optional password match → suggest login). */
app.post('/api/auth/account-check', (req, res) => {
    const emailNormRaw = authUsers.normalizeEmail((req.body && req.body.email) || '');
    const password = req.body && req.body.password != null ? String(req.body.password) : '';
    const phoneRaw = (req.body && req.body.phone) || '';
    const acEmailV = contactValidation.validateEmail(emailNormRaw);
    if (!acEmailV.valid) return res.status(400).json({ error: acEmailV.message });
    const emailNorm = acEmailV.cleanedEmail;

    function respondEmail(row) {
        if (!row) {
            return res.json({
                exists: false,
                available: true,
                passwordMatch: false,
                needsLogin: false,
                phoneTaken: false,
                emailTaken: false
            });
        }
        const passwordMatch = !!(password && row.password === password);
        res.json({
            exists: true,
            available: false,
            passwordMatch,
            needsLogin: true,
            phoneTaken: false,
            emailTaken: true,
            message: passwordMatch
                ? 'An account with this email already exists. Please sign in with your password.'
                : 'This email is already registered. Please sign in or use Forgot password.'
        });
    }

    function checkEmail() {
        authUsers.findUserByEmail(db, emailNorm, (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            respondEmail(row);
        });
    }

    const phoneTrim = String(phoneRaw || '').trim();
    if (!phoneTrim) return checkEmail();
    const acPhoneV = contactValidation.validatePhone(phoneTrim);
    if (!acPhoneV.valid) return res.status(400).json({ error: acPhoneV.message });
    authUsers.findUserByPhone(db, acPhoneV.cleanedPhone, (pErr, phoneRow) => {
        if (pErr) return res.status(500).json({ error: pErr.message });
        if (phoneRow) {
            return res.json({
                exists: true,
                available: false,
                passwordMatch: false,
                needsLogin: true,
                phoneTaken: true,
                emailTaken: false,
                message:
                    'This mobile number is already registered. Sign in with that account or use a different number (email can be new, but phone cannot be reused).'
            });
        }
        checkEmail();
    });
});

app.get('/api/auth/email-available', (req, res) => {
    const emailAvailV = contactValidation.validateEmail((req.query && req.query.email) || '');
    if (!emailAvailV.valid) return res.status(400).json({ error: emailAvailV.message });
    const emailNorm = emailAvailV.cleanedEmail;
    db.get(`SELECT id FROM users WHERE ${authUsers.sqlEmailMatches('email')}`, [emailNorm], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ available: !row });
    });
});

/** Check whether an email is registered before login OTP (no password). */
app.post('/api/auth/login-otp/precheck', (req, res) => {
    const precheckEmailV = contactValidation.validateEmail((req.body && req.body.email) || '');
    if (!precheckEmailV.valid) return res.status(400).json({ error: precheckEmailV.message });
    const emailNorm = precheckEmailV.cleanedEmail;
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

function resolveLoginUserForOtp(email, password, cb, options) {
    const requirePassword = options && options.requirePassword === true;
    const loginOtpEmailV = contactValidation.validateEmail(email);
    if (!loginOtpEmailV.valid) {
        return cb(null, { status: 400, error: loginOtpEmailV.message });
    }
    const emailNorm = loginOtpEmailV.cleanedEmail;
    authUsers.findUserByEmail(db, emailNorm, (err, row) => {
        if (err) return cb(err);
        if (!row) {
            return cb(null, {
                status: 401,
                error: 'No account found with this email. Please create an account first.',
                needsSignup: true
            });
        }
        if (requirePassword) {
            const pw = password != null && password !== undefined ? String(password) : '';
            if (!pw || row.password !== pw) {
                return cb(null, {
                    status: 401,
                    error: 'Invalid password. Use Forgot password or check your password.',
                    needsSignup: false
                });
            }
        }
        cb(null, { status: 200, row });
    });
}

/** Find account by email and send login OTP to registered email + WhatsApp. */
app.post('/api/auth/login-otp/send-both', withIntegrationSettingsLoaded, withAuxiliaryTables, (req, res) => {
    const { email, password } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email is required' });
    resolveLoginUserForOtp(email, password, (err, out) => {
        if (err) return res.status(500).json({ error: err.message });
        if (out.status !== 200) {
            return res.status(out.status).json({ error: out.error, needsSignup: !!out.needsSignup });
        }
        if (portalAuthPolicy.isStaffPortalAccount(out.row)) {
            return res.status(400).json({
                error:
                    'Login OTP is not used for staff accounts. Sign in with email and password at the admin, judge, or scanner portal.'
            });
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
app.post('/api/auth/login-otp/send', withIntegrationSettingsLoaded, withAuxiliaryTables, (req, res) => {
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
        if (portalAuthPolicy.isStaffPortalAccount(out.row)) {
            return res.status(400).json({
                error:
                    'Login OTP is not used for staff accounts. Sign in with email and password at the admin, judge, or scanner portal.'
            });
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

app.post('/api/auth/login-otp/verify', withAuxiliaryTables, (req, res) => {
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
app.post('/api/otp/send', withIntegrationSettingsLoaded, withAuxiliaryTables, (req, res) => {
    const { channel, destination, purpose, seminarId, fieldKey, userId } = req.body || {};
    if (!channel || !destination || !purpose) {
        return res.status(400).json({ error: 'channel, destination, and purpose are required' });
    }
    if (channel !== 'phone' && channel !== 'email') {
        return res.status(400).json({ error: 'channel must be phone or email' });
    }
    let dest = String(destination).trim();
    if (!dest) return res.status(400).json({ error: 'destination required' });
    if (channel === 'email') {
        const ev = contactValidation.validateEmail(dest);
        if (!ev.valid) return res.status(400).json({ error: ev.message });
        dest = ev.cleanedEmail;
    } else {
        const pv = contactValidation.validatePhone(dest);
        if (!pv.valid) return res.status(400).json({ error: pv.message });
        dest = otpLib.normalizeOtpDestination('phone', pv.cleanedPhone) || pv.cleanedPhone;
    }

    const meta = {};
    if (seminarId != null && seminarId !== '') {
        const sidMeta = parseInt(seminarId, 10);
        if (!Number.isInteger(sidMeta) || sidMeta < 1) {
            return res.status(400).json({ error: 'Invalid seminarId for OTP' });
        }
        meta.seminarId = sidMeta;
    }
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
    if (purpose === 'proxy_applicant' && Number.isNaN(meta.seminarId)) {
        return res.status(400).json({ error: 'seminarId required for proxy applicant OTP' });
    }
    if (purpose === 'certificate_verify') {
        const certId = req.body && req.body.certId != null ? parseInt(req.body.certId, 10) : NaN;
        if (Number.isNaN(certId) || certId < 1) {
            return res.status(400).json({ error: 'certId required for certificate verification OTP' });
        }
        meta.certId = certId;
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

app.post('/api/otp/verify', withAuxiliaryTables, (req, res) => {
    const { channel, destination, purpose, code, seminarId, fieldKey, userId } = req.body || {};
    if (!channel || !destination || !purpose || !code) {
        return res.status(400).json({ error: 'channel, destination, purpose, and code are required' });
    }
    let dest = String(destination).trim();
    if (!dest) return res.status(400).json({ error: 'destination required' });
    if (channel === 'email') {
        const ev = contactValidation.validateEmail(dest);
        if (!ev.valid) return res.status(400).json({ error: ev.message });
        dest = ev.cleanedEmail;
    } else if (channel === 'phone') {
        const pv = contactValidation.validatePhone(dest);
        if (!pv.valid) return res.status(400).json({ error: pv.message });
        dest = otpLib.normalizeOtpDestination('phone', pv.cleanedPhone) || pv.cleanedPhone;
    } else {
        return res.status(400).json({ error: 'channel must be phone or email' });
    }
    const meta = {};
    if (seminarId != null && seminarId !== '') {
        const sidMeta = parseInt(seminarId, 10);
        if (!Number.isInteger(sidMeta) || sidMeta < 1) {
            return res.status(400).json({ error: 'Invalid seminarId for OTP' });
        }
        meta.seminarId = sidMeta;
    }
    if (fieldKey) meta.fieldKey = String(fieldKey);
    const uidNum = userId != null && userId !== '' ? parseInt(userId, 10) : null;
    if (purpose === 'login') {
        if (uidNum == null || Number.isNaN(uidNum)) {
            return res.status(400).json({ error: 'userId required for login OTP' });
        }
        meta.userId = uidNum;
    }
    if (purpose === 'certificate_verify') {
        const certId = req.body && req.body.certId != null ? parseInt(req.body.certId, 10) : NaN;
        if (Number.isNaN(certId) || certId < 1) {
            return res.status(400).json({ error: 'certId required for certificate verification OTP' });
        }
        meta.certId = certId;
        if (seminarId != null && seminarId !== '') meta.seminarId = parseInt(seminarId, 10);
        if (uidNum != null && !Number.isNaN(uidNum)) meta.userId = uidNum;
    }
    otpLib.verifyOtp(
        db,
        {
            channel,
            destination: dest,
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
                            const base = String(notifEngine.publicBaseUrl() || '')
                                .trim()
                                .replace(/\/$/, '');
                            if (!base || !/^https?:\/\//i.test(base)) {
                                return cb(null, { skipped: true, reason: 'no_public_base_url' });
                            }
                            const verify_link =
                                base + '/api/auth/verify-email?t=' + encodeURIComponent(rawToken);
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

function requireAdminSensitiveOtpIfEnabled(actorAdminId, phoneTok, emailTok, next, meta) {
    meta = meta || {};
    const runOtpGate = () => {
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
    };
    if (meta.targetUserRole && portalAuthPolicy.isStaffUserRole(meta.targetUserRole)) {
        return next(null, true, null);
    }
    const targetUid = parseInt(meta.targetUserId, 10);
    if (Number.isInteger(targetUid) && targetUid > 0) {
        return db.get(`SELECT user_role, role FROM users WHERE id = ?`, [targetUid], (e, row) => {
            if (!e && row && portalAuthPolicy.isStaffPortalAccount(row)) {
                return next(null, true, null);
            }
            runOtpGate();
        });
    }
    runOtpGate();
}

app.post('/api/auth/signup', (req, res) => {
    const runSignup = () => {
    const { firstName, lastName, email, phone, password, role, phoneOtpToken, emailOtpToken } = req.body;
    const emailV = contactValidation.validateEmail(email);
    if (!emailV.valid) {
        return res.status(400).json({ error: emailV.message });
    }
    const phoneV = contactValidation.validatePhone(phone);
    if (!phoneV.valid) {
        return res.status(400).json({ error: phoneV.message });
    }
    const emailNorm = emailV.cleanedEmail;
    const phoneNorm = phoneV.cleanedPhone;

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
        const requireEv = portalAuthPolicy.getPortalAuthConfig().requireEmailVerification;
        const evFlag = requireEv && !signupOtpRequired() ? 0 : 1;

        function insertUser() {
            authUsers.findUserByPhone(db, phoneNorm, (phErr, phoneExisting) => {
                if (phErr) return res.status(500).json({ error: phErr.message });
                if (phoneExisting) {
                    return res.status(409).json({
                        error:
                            'This mobile number is already registered to another account. Sign in with that account or use a different number.',
                        needsLogin: true,
                        phoneTaken: true
                    });
                }
                const usersEmailPolicy = require('./lib/users-email-policy');
                usersEmailPolicy.doctorEmailTaken(db, emailNorm, null, (dupErr, taken, existing) => {
                    if (dupErr) return res.status(500).json({ error: dupErr.message });
                    if (taken) {
                        const pw = password != null ? String(password) : '';
                        const passwordMatch = !!(pw && existing && existing.password === pw);
                        return res.status(409).json({
                            error: passwordMatch
                                ? 'An account with this email already exists. Please sign in.'
                                : 'Email already registered. Please sign in instead.',
                            needsLogin: true,
                            passwordMatch,
                            emailTaken: true
                        });
                    }
                    doInsertUser();
                });
            });
        }

        function doInsertUser() {
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
                        () => {
                            flushNotificationQueue();
                        }
                    );
                    designatedNotify.notifyDesignatedAccountCreated(
                        db,
                        newUserId,
                        { source: 'public signup', temporary_password: String(password || '') },
                        () => {
                            flushNotificationQueue();
                        }
                    );
                    if (evFlag === 0) {
                        queuePortalEmailVerification(db, newUserId, () => {});
                    }
                    activityLog.logFromRequest(db, req, {
                        user_id: newUserId,
                        action: 'auth.signup',
                        meta: { email: emailNorm, user_id_string: userIdStr }
                    });
                    if (evFlag === 1) {
                        userAccountLifecycle.stampAccountActivated(db, newUserId, () => {});
                    }
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
    };

    if (pgDb && typeof pgDb.ensureAuxiliaryTables === 'function') {
        return pgDb
            .ensureAuxiliaryTables()
            .then(() => runSignup())
            .catch((e) => {
                console.warn('[signup] ensureAuxiliaryTables:', e.message);
                runSignup();
            });
    }
    runSignup();
});

// 2. Auth: Login (optional phone + email OTP when messaging is configured)
app.post('/api/auth/login', withAuxiliaryTables, (req, res) => {
    const { email, password, phoneOtpToken, emailOtpToken } = req.body;
    if (!email || password === undefined || password === null) {
        return res.status(400).json({ error: 'Email or portal user ID and password are required' });
    }
    const usersEmailPolicy = require('./lib/users-email-policy');
    const portalIdLogin = usersEmailPolicy.isPortalIdLogin(email);
    let loginEmailV = { valid: true, cleanedEmail: '' };
    if (!portalIdLogin) {
        loginEmailV = contactValidation.validateEmail(email);
        if (!loginEmailV.valid) {
            return res.status(400).json({ error: loginEmailV.message });
        }
    }
    portalAuthPolicy.loadPortalAuthConfig(db, (ePol) => {
        if (ePol) console.warn('[portal-auth-policy] login', ePol.message);
        const loginPortal = portalAuthPolicy.normalizeLoginPortal(
            (req.body && req.body.portal) || 'public'
        );
        usersEmailPolicy.findUserForLogin(
            db,
            { identifier: email, password, portal: loginPortal },
            (err, row, extra) => {
        if (err) return res.status(500).json({ error: err.message });
                if (extra && extra.ambiguous) {
                    return res.status(400).json({
                        error: extra.hint || 'Multiple accounts use this email. Sign in with your 12-digit Portal User ID.'
                    });
                }
                if (!row) {
                    if (portalIdLogin) {
                        return res.status(401).json({
                            error: 'No account found with this portal user ID, or password is wrong.',
                            needsLogin: true
                        });
                    }
                    const emailNorm = loginEmailV.cleanedEmail;
                    return authUsers.findUserByEmail(db, emailNorm, (e2, exists) => {
                        if (e2) return res.status(500).json({ error: e2.message });
                        if (!exists) {
                            return res.status(401).json({
                                error: 'No account found with this email. Please create an account first.',
                                needsSignup: true
                            });
                        }
                        return res.status(401).json({
                            error: 'Invalid password. Use Forgot password or sign in with OTP if enabled.',
                            needsLogin: true,
                            accountExists: true
                        });
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

                function markEmailVerifiedFromOtp(cb) {
                    if (!portalAuthPolicy.getPortalAuthConfig().requireEmailVerification) {
                        return cb();
                    }
                    if (Number(row.email_verified) === 1) return cb();
                    db.run(`UPDATE users SET email_verified = 1 WHERE id = ?`, [row.id], (uErr) => {
                        if (!uErr) {
                            row.email_verified = 1;
                            userAccountLifecycle.stampAccountActivated(db, row.id, () => {});
                        }
                        cb(uErr);
                    });
                }

                function blockUnverifiedEmailLinkOnly() {
                    if (
                        portalAuthPolicy.getPortalAuthConfig().requireEmailVerification &&
                        Number(row.email_verified) === 0
                    ) {
                        return res.status(403).json({
                            error:
                                'Verify your email with the OTP code above (Email → Send → Verify), then sign in again.',
                            needsEmailVerification: true,
                            email: row.email,
                            useLoginOtp: true
                        });
                    }
                    return null;
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

                if (loginOtpRequired(loginPortal) && !portalAuthPolicy.isStaffPortalAccount(row)) {
                    if (!phoneOtpToken || !emailOtpToken) {
                        return res.status(400).json({ error: 'Phone and email OTP verification is required to log in.' });
                    }
                    otpLib.validateLoginOtpTokens(
                        db,
                        row.id,
                        { phoneToken: phoneOtpToken, emailToken: emailOtpToken },
                        (verr, vr) => {
                            if (verr) return res.status(500).json({ error: verr.message });
                            if (!vr || !vr.ok) {
                                return res.status(400).json({ error: (vr && vr.error) || 'Invalid OTP verification' });
                            }
                            markEmailVerifiedFromOtp((uErr) => {
                                if (uErr) return res.status(500).json({ error: uErr.message });
                                sendUser();
                            });
                        }
                    );
                    return;
                }
                const block = blockUnverifiedEmailLinkOnly();
                if (block) return block;
                sendUser();
        }
        );
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
                    userAccountLifecycle.stampAccountActivated(db, tok.user_id, () => {
                        const base = notifEngine.publicBaseUrl() || '';
                        res.redirect(base + '/?emailVerified=1');
                    });
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
    loadRegistrationFormConfig(Number.isNaN(sid) ? null : sid, (e, cfg) => {
        if (e) return res.status(500).json({ error: e.message });
        registrationOtpChannelFlags((eFlags, flags) => {
            if (eFlags) return res.status(500).json({ error: eFlags.message });
            const base = {
                fields: (cfg && cfg.fields) || [],
                birthYearMin: cfg && cfg.birthYearMin != null ? cfg.birthYearMin : null,
                birthYearMax: cfg && cfg.birthYearMax != null ? cfg.birthYearMax : null,
                otpOnApplication: false,
                submitOtpRequired: false,
                ...flags
            };
            if (sid != null && !Number.isNaN(sid)) {
                db.get(
                    `SELECT otp_on_application, otp_on_step1, otp_on_submit FROM seminars WHERE id = ?`,
                    [sid],
                    (e2, row) => {
                    if (e2) return res.status(500).json({ error: e2.message });
                    const otpOn = !!(row && Number(row.otp_on_application) === 1);
                    const otpStep1 = otpOn && row && Number(row.otp_on_step1) !== 0;
                    const otpSubmit = otpOn && row && Number(row.otp_on_submit) !== 0;
                    res.json({
                        ...base,
                        otpOnApplication: otpOn,
                        otpOnStep1: otpStep1,
                        otpOnSubmit: otpSubmit,
                        submitOtpRequired: otpSubmit,
                        otpRequiresEmail: (otpStep1 || otpSubmit) && flags.otpRequiresEmail,
                        otpRequiresPhone: (otpStep1 || otpSubmit) && flags.otpRequiresPhone
                    });
                }
                );
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
                `SELECT r.application_no, r.status, r.form_data, r.doc_review_json,
                        u.first_name, u.middle_name, u.last_name, u.user_id_string,
                        o.status AS payment_status, o.payment_date
                 FROM registrations r
                 JOIN users u ON r.user_id = u.id
                 INNER JOIN orders o ON o.registration_id = r.id AND o.status = 'success'
                 WHERE r.seminar_id = ?
                 ORDER BY r.application_no ASC`,
                [sid],
                (e2, rows) => {
                    if (e2) return res.status(500).json({ error: e2.message });
                    const confirmed = filterConfirmedRows(
                        (rows || []).map((r) => ({
                            ...r,
                            order_status: r.payment_status
                        }))
                    );
                    let list = confirmed.map((r) => {
                        let fd = {};
                        try {
                            fd = JSON.parse(r.form_data || '{}');
                        } catch (_) {}
                        return {
                            applicationNo: r.application_no,
                            name: [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' '),
                            city: fd.city || '',
                            state: fd.state || '',
                            status: r.status,
                            paid: r.payment_status === 'success',
                            userIdString: r.user_id_string
                        };
                    });
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

app.get('/api/public/announcements', (req, res) => {
    loadPublicSiteCms((e, cms) => {
        if (e) return res.status(500).json({ error: e.message });
        mergeScrollingAnnouncementsWithOpenSeminars(cms, (e2, enriched) => {
            if (e2) return res.status(500).json({ error: e2.message });
            const out = {
                updatedAt: new Date().toISOString(),
                ticker: enriched.ticker || null,
                scrollingAnnouncements: enriched.scrollingAnnouncements || [],
                publicNotices: enriched.publicNotices || [],
                portalUrls: {
                    seminar: portalUrls.getPortalUrls().seminar,
                    wix: portalUrls.getPortalUrls().wix
                }
            };
            res.setHeader('Cache-Control', 'public, max-age=120');
            res.json(out);
        });
    });
});

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
    const arrayKeys = [
        'doctorUpdates',
        'slides',
        'publicNotices',
        'reviews',
        'scrollingAnnouncements',
        'aboutSections',
        'socialLinks',
        'pastSeminarGallery',
        'seminarGalleryYears',
        'siteMenu',
        'speakers'
    ];
    for (let i = 0; i < arrayKeys.length; i++) {
        const k = arrayKeys[i];
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
        [
            'doctorUpdates',
            'slides',
            'publicNotices',
            'reviews',
            'scrollingAnnouncements',
            'aboutSections',
            'socialLinks',
            'pastSeminarGallery',
            'seminarGalleryYears',
            'siteMenu',
            'speakers'
        ].forEach((k) => {
            if (incoming[k] !== undefined) merged[k] = incoming[k];
        });
        if (incoming.seminarGalleryYears !== undefined) {
            merged.seminarGalleryYears = incoming.seminarGalleryYears;
            merged.pastSeminarGallery = siteCmsHelpers.flattenGalleryYears(incoming.seminarGalleryYears);
        } else if (incoming.pastSeminarGallery !== undefined) {
            merged.pastSeminarGallery = incoming.pastSeminarGallery;
            merged.seminarGalleryYears = siteCmsHelpers.groupGalleryToYears(incoming.pastSeminarGallery);
        }
        if (incoming.siteMenu !== undefined) {
            merged.siteMenu = siteCmsHelpers.normalizeSiteMenu(incoming.siteMenu);
        }
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
        if (incoming.seo && typeof incoming.seo === 'object') {
            merged.seo = siteSeoMod.normalizeSeo({ ...(merged.seo || {}), ...incoming.seo });
        }
        merged.scrollingAnnouncements = sanitizeScrollingAnnouncements(merged.scrollingAnnouncements);
        const normalized = siteCmsHelpers.normalizeSiteCms(merged);
        const payload = JSON.stringify(normalized);
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

function withUploadAsset(req, res, next) {
    caseUpload.single('file')(req, res, (err) => {
        if (err) return res.status(400).json({ error: uploadErrorMessage(err) });
        next();
    });
}

function withUploadAssets(req, res, next) {
    caseUpload.array('files', 40)(req, res, (err) => {
        if (err) return res.status(400).json({ error: uploadErrorMessage(err) });
        next();
    });
}

function persistOneUploadAsset(file, cb) {
    if (!file) return cb(null, null);
    fileStore.persistToGlobalAsset(db, upsertGlobalSetting, file, 'upload_asset_', (err, assetPath) => {
        if (err) return cb(err);
        if (assetPath) return cb(null, assetPath);
        if (file.filename) return cb(null, '/uploads/' + file.filename);
        cb(new Error('Upload could not be saved'));
    });
}

app.post('/api/admin/upload-asset', withUploadAsset, (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'file is required' });
    }
    persistOneUploadAsset(req.file, (err, assetPath) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, path: assetPath });
    });
});

app.post('/api/admin/upload-assets', withUploadAssets, (req, res) => {
    const files = req.files || [];
    if (!files.length) {
        return res.status(400).json({ error: 'At least one file is required' });
    }
    const paths = [];
    let i = 0;
    const nextFile = () => {
        if (i >= files.length) return res.json({ success: true, paths });
        persistOneUploadAsset(files[i], (err, assetPath) => {
            if (err) return res.status(500).json({ error: err.message });
            if (assetPath) paths.push(assetPath);
            i += 1;
            nextFile();
        });
    };
    nextFile();
});

app.get('/api/assets/:key', fileStore.serveAssetHandler(db));

app.post('/api/admin/registration-form-config', (req, res) => {
    const { fields, birthYearMin, birthYearMax } = req.body;
    if (!Array.isArray(fields)) return res.status(400).json({ error: 'fields must be an array' });
    const normalized = sanitizeRegistrationFormFields(
        fields.map((f) => ({
            ...f,
            required: f.enabled === false ? false : !!f.required,
            options:
                f.key === 'qual' && Array.isArray(f.options)
                    ? regFormCfg.normalizeQualOptions(f.options)
                    : f.options
        }))
    );
    const payload = JSON.stringify(
        regFormCfg.buildConfigPayload(normalized, { birthYearMin, birthYearMax })
    );
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
    return safeInternalUserRowId(raw);
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
    const baseSelect = `SELECT r.id, r.seminar_id, r.application_no, r.status, r.form_data, r.created_at,
                r.created_at AS updated_at,
                s.title AS seminar_title, s.whatsapp_group_url, s.cancellation_policy_json, s.terms_conditions,
                s.event_date AS seminar_event_date, s.price AS seminar_price, s.portal_year`;
    const fromWhere = ` FROM registrations r
         LEFT JOIN seminars s ON r.seminar_id = s.id
         WHERE r.user_id = ?`;
    const params = [uid];
    let yearClause = '';
    if (Number.isInteger(yearFilter)) {
        if (isPostgresConfigured()) {
            yearClause = ` AND (s.portal_year = ? OR EXTRACT(YEAR FROM COALESCE(s.event_date, r.created_at))::INTEGER = ?)`;
        } else {
            yearClause = ` AND (s.portal_year = ? OR CAST(strftime('%Y', COALESCE(s.event_date, r.created_at)) AS INTEGER) = ?)`;
        }
        params.push(yearFilter, yearFilter);
    }
    const order = ` ORDER BY r.id DESC`;
    const sqlWithDoc = `${baseSelect}, r.doc_review_json${fromWhere}${yearClause}${order}`;
    const sqlWithoutDoc = `${baseSelect}${fromWhere}${yearClause}${order}`;
    db.all(sqlWithDoc, params, (err, rows) => {
        if (err && /doc_review_json|column.*does not exist/i.test(String(err.message))) {
            return db.all(sqlWithoutDoc, params, cb);
        }
        cb(err, rows);
    });
}

function respondApplicationsList(uid, yearFilter, res) {
    fetchApplicationsForUser(uid, yearFilter, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const finish = (list) => {
            const withReview = (list || []).map((r) => {
                let doc_review = null;
                if (r.doc_review_json) {
                    try {
                        doc_review = JSON.parse(r.doc_review_json);
                    } catch (_) {
                        doc_review = null;
                    }
                }
                return { ...r, doc_review };
            });
            portalTracking.attachRegistrationTimelines(db, withReview, (e2, enriched) => {
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
app.post('/api/applications/submit', withCertificateUpload, (req, res) => {
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
            `SELECT registration_start, registration_end, otp_on_application, otp_on_step1, otp_on_submit, title FROM seminars WHERE id = ? AND is_active = 1`,
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

                loadRegistrationFormConfig(seminarId, (cfgErr, regCfg) => {
                    if (cfgErr) return res.status(500).json({ error: cfgErr.message });
                    const list = (regCfg && regCfg.fields) || [];
                    const hasCertFile =
                        !!req.file || !!(formData && formData.certificate_path);
                    const validationError = validateFormDataAgainstRegistrationConfig(
                        formData || {},
                        hasCertFile,
                        list,
                        null,
                        regCfg
                    );
                    if (validationError) {
                        return res.status(400).json({ error: validationError });
                    }

                    const sidNum = parseInt(seminarId, 10);
                    const otpApp = !!(sem && Number(sem.otp_on_application) === 1);
                    const otpStep1 = otpApp && sem && Number(sem.otp_on_step1) !== 0;
                    const otpSubmit = otpApp && sem && Number(sem.otp_on_submit) !== 0;
                    const skipFieldKeys = otpStep1 ? ['email', 'phone'] : [];

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
                        seminarCapacity.assertSeminarHasCapacity(db, seminarId, (capErr, cap) => {
                            if (capErr) return res.status(500).json({ error: capErr.message });
                            if (!cap || !cap.ok) {
                                return res.status(400).json({
                                    error: (cap && cap.error) || 'Seminar is full.',
                                    capacity: cap && cap.capacity
                                });
                            }
                            doInsertRegistration();
                        });
                    }

                    const otpTokensToConsume = [];

                    function doInsertRegistration() {
                        const applicationNo = generateId();
                        const finishInsert = () => {
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
                                activityLog.logFromRequest(db, req, {
                                    user_id: userId,
                                    seminar_id: seminarId,
                                    action: 'application.submit',
                                    resource_type: 'registration',
                                    resource_id: applicationNo,
                                    meta: { applicationId: newId }
                                });
                                const finishResponse = (extra) => {
                                    const payload = {
                                        success: true,
                                        applicationId: newId,
                                        applicationNo,
                                        ...(extra || {})
                                    };
                                    res.json(payload);
                                };
                                const afterVolunteerTicket = () => {
                                    volunteerTicketFlow.tryFulfillVolunteerAfterRegistration(
                                        db,
                                        volunteerTicketDeps(),
                                        { userId, seminarId, registrationId: newId },
                                        (vErr, vRes) => {
                                            const extra = {};
                                            if (vRes && vRes.issued) {
                                                extra.volunteerTicketIssued = true;
                                                extra.volunteerTicketId = vRes.ticketId;
                                                extra.message = vRes.message;
                                            }
                                            if (!otpTokensToConsume.length) return finishResponse(extra);
                                            otpLib.consumeVerificationTokens(db, otpTokensToConsume, (cErr) => {
                                                if (cErr) console.warn('[otp] consume after submit:', cErr.message);
                                                finishResponse(extra);
                                            });
                                        }
                                    );
                                };
                                if (!otpTokensToConsume.length) return afterVolunteerTicket();
                                otpLib.consumeVerificationTokens(db, otpTokensToConsume, (cErr) => {
                                    if (cErr) console.warn('[otp] consume after submit:', cErr.message);
                                    afterVolunteerTicket();
                                });
                                    }
                                );
                            }
                        );
                        };
                        if (formData && formData.certificate_path && formData.ncism) {
                            regCertVerify.verifyCertificateForRegistration(
                                db,
                                fileStore,
                                uploadsDir,
                                formData,
                                (verr, check) => {
                                    if (verr) console.warn('[ncism-verify]', verr.message);
                                    if (check) formData.ncism_certificate_check = check;
                                    finishInsert();
                                }
                            );
                            return;
                        }
                        finishInsert();
                    }

                    if (otpStep1 || otpSubmit) {
                        integrationSettings.ensureIntegrationSettingsLoaded(db, () => {
                            const needEmail = integrationSettings.isEmailConfiguredFromSettings();
                            const needPhone = integrationSettings.isWhatsAppConfiguredFromSettings();
                            if (!needEmail && !needPhone) {
                                return runFieldOtpsThenInsert();
                            }

                            const afterSubmitOtp = () => {
                                if (!otpStep1) return runFieldOtpsThenInsert();
                                if (needEmail && !emailOtpToken) {
                                    return res.status(400).json({
                                        error: 'Verify your email with the code on the personal details step before submitting.'
                                    });
                                }
                                if (needPhone && !phoneOtpToken) {
                                    return res.status(400).json({
                                        error: 'Verify your phone with the WhatsApp code on the personal details step before submitting.'
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
                                                error: (ov && ov.error) || 'OTP verification failed on personal details step.'
                                            });
                                        }
                                        if (needPhone && phoneOtpToken) otpTokensToConsume.push(phoneOtpToken);
                                        if (needEmail && emailOtpToken) otpTokensToConsume.push(emailOtpToken);
                                        runFieldOtpsThenInsert();
                                    },
                                    { peekOnly: true }
                                );
                            };

                            if (!otpSubmit) return afterSubmitOtp();

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
                                    if (needPhone && subPhone) otpTokensToConsume.push(subPhone);
                                    if (needEmail && subEmail) otpTokensToConsume.push(subEmail);
                                    afterSubmitOtp();
                                },
                                { peekOnly: true }
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
app.put('/api/applications/:applicationId', withCertificateUpload, (req, res) => {
    let { formData, phoneOtpToken, emailOtpToken, fieldOtpTokens } = req.body;
    
    if (typeof formData === 'string') {
        try {
            formData = JSON.parse(formData);
        } catch (e) {}
    }
    const fieldOtpTokensObj = parseMaybeJson(fieldOtpTokens) || (fieldOtpTokens && typeof fieldOtpTokens === 'object' ? fieldOtpTokens : {});
    
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
            if (st !== 'submitted' && st !== 'pending_approval' && st !== 'revision_required') {
                return res.status(400).json({
                    error: 'This application can no longer be edited after it has moved forward in the workflow.'
                });
            }
            if (st === 'revision_required') {
                return res.status(400).json({
                    error: 'Use Re-upload documents for this application (certificate and NCISM only).'
                });
            }

            let prev = {};
            try {
                prev = JSON.parse(row.form_data || '{}');
            } catch (_) {
                prev = {};
            }

            persistUploadedCertificate(req, (certErr, certPath) => {
                if (certErr) return res.status(500).json({ error: certErr.message });
                const merged = { ...prev, ...(formData || {}) };
                if (certPath) merged.certificate_path = certPath;
                const hasCert = !!req.file || !!merged.certificate_path;

            loadRegistrationFormConfig(row.seminar_id, (cfgErr, regCfg) => {
                if (cfgErr) return res.status(500).json({ error: cfgErr.message });
                const list = (regCfg && regCfg.fields) || [];
                const validationError = validateFormDataAgainstRegistrationConfig(
                    merged,
                    hasCert,
                    list,
                    null,
                    regCfg
                );
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
app.post('/api/doctor/profile', withMemoryAwareUpload('profilePhoto'), (req, res) => {
        const userId = parseInt(req.body.userId, 10);
        if (!Number.isInteger(userId) || userId < 1) {
            return res.status(400).json({ error: 'Invalid session. Please sign in again.' });
        }
        const {
            specialization,
            registration_no,
            qualifications,
            experience_years,
            hospital_name,
            contact_number,
            bio
        } = req.body;

        const saveProfile = (profilePhotoPath) => {
        db.get(`SELECT id, profile_photo_path FROM doctor_profile WHERE user_id = ?`, [userId], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });

            const expYears = parseInt(experience_years, 10);
            const expVal = Number.isFinite(expYears) && expYears >= 0 ? expYears : 0;

            if (row) {
                const sql = profilePhotoPath
                    ? `UPDATE doctor_profile SET specialization=?, registration_no=?, qualifications=?, experience_years=?, hospital_name=?, contact_number=?, bio=?, profile_photo_path=?, updated_at=CURRENT_TIMESTAMP WHERE user_id=?`
                    : `UPDATE doctor_profile SET specialization=?, registration_no=?, qualifications=?, experience_years=?, hospital_name=?, contact_number=?, bio=?, updated_at=CURRENT_TIMESTAMP WHERE user_id=?`;
                const params = profilePhotoPath
                    ? [
                          specialization,
                          registration_no,
                          qualifications,
                          expVal,
                          hospital_name,
                          contact_number,
                          bio,
                          profilePhotoPath,
                          userId
                      ]
                    : [
                          specialization,
                          registration_no,
                          qualifications,
                          expVal,
                          hospital_name,
                          contact_number,
                          bio,
                          userId
                      ];
                db.run(sql, params, function (runErr) {
                    if (runErr) return res.status(500).json({ error: runErr.message });
                    res.json({
                        success: true,
                        message: 'Profile updated successfully',
                        profilePhotoUrl: profilePhotoPath || fileStore.publicFileUrl(row.profile_photo_path)
                    });
                });
            } else {
                db.run(
                    `INSERT INTO doctor_profile (user_id, specialization, registration_no, qualifications, experience_years, hospital_name, contact_number, bio, profile_photo_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        userId,
                        specialization,
                        registration_no,
                        qualifications,
                        expVal,
                        hospital_name,
                        contact_number,
                        bio,
                        profilePhotoPath
                    ],
                    function (runErr) {
                        if (runErr) return res.status(500).json({ error: runErr.message });
                        res.json({
                            success: true,
                            message: 'Profile created successfully',
                            profileId: this.lastID,
                            profilePhotoUrl: profilePhotoPath || null
                        });
                    }
                );
            }
        });
        };

        if (req.file) {
            return fileStore.persistMulterFile(db, req.file, uploadsDir, (pErr, photoPath) => {
                if (pErr) return res.status(500).json({ error: pErr.message });
                saveProfile(photoPath);
            });
        }
        saveProfile(null);
});

// Doctor portal: account created / activated timestamps
app.get('/api/doctor/account/:userId', (req, res) => {
    const uid = parseInt(req.params.userId, 10);
    if (!Number.isInteger(uid) || uid < 1) return res.status(400).json({ error: 'Invalid user' });
    db.get(
        `SELECT id, user_id_string, first_name, last_name, email, phone, role, user_role,
                created_at, activated_at, last_login_at, IFNULL(email_verified,1) AS email_verified,
                IFNULL(is_disabled,0) AS is_disabled, COALESCE(is_banned,0) AS is_banned
         FROM users WHERE id = ?`,
        [uid],
        (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!row) return res.status(404).json({ error: 'User not found' });
            res.json({
                userId: row.id,
                userIdString: row.user_id_string,
                createdAt: row.created_at,
                activatedAt: row.activated_at,
                lastLoginAt: row.last_login_at,
                emailVerified: Number(row.email_verified) === 1,
                pendingActivation: Number(row.email_verified) !== 1 && !row.activated_at
            });
        }
    );
});

// Get doctor profile
app.get('/api/doctor/profile/:userId', (req, res) => {
    db.get(`SELECT * FROM doctor_profile WHERE user_id = ?`, [req.params.userId], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.json({});
        const out = { ...row };
        if (out.profile_photo_path) {
            out.profile_photo_url = fileStore.publicFileUrl(out.profile_photo_path);
        }
        res.json(out);
    });
});

function isPublicListEnabled(val) {
    return val === 1 || val === true || val === '1' || val === 't' || val === 'true';
}

function mapDoctorCertificateTrackingRows(rows) {
    return (rows || []).map((row) => {
                const scansRequired = certVerify.normalizeCertScansRequired(row.cert_scans_required);
                const scanCount = Number(row.scan_count) || 0;
                const paid = String(row.order_status || '').toLowerCase() === 'success';
                const checkinComplete = certVerify.ticketMeetsScanRequirement(scanCount, scansRequired);
                let certStatus = 'not_applicable';
                let certStatusLabel = '—';
                if (!paid) {
                    certStatus = 'awaiting_payment';
                    certStatusLabel = 'Awaiting payment';
                } else if (!checkinComplete) {
                    certStatus = 'awaiting_checkin';
                    certStatusLabel =
                        scansRequired === 2
                            ? `Check-in ${scanCount}/${scansRequired} scans`
                            : 'Awaiting venue check-in';
                } else if (!Number(row.cert_enabled)) {
                    certStatus = Number(row.scan_verified) ? 'awaiting_approval' : 'checked_in';
                    certStatusLabel = Number(row.scan_verified)
                        ? 'Checked in — awaiting certificate approval'
                        : 'Checked in at venue';
                } else if (!row.template_path) {
                    certStatus = 'approved_pending_design';
                    certStatusLabel = 'Approved — certificate preparing';
                } else {
                    certStatus = 'issued';
                    certStatusLabel = 'Certificate issued — download available';
                }
        return {
            registrationId: row.registration_id,
            seminarId: row.seminar_id,
            seminarTitle: row.seminar_title,
            applicationNo: row.application_no,
            ticketId: row.ticket_id_string,
            regStatus: row.reg_status,
            paid,
            scanCount,
            scansRequired,
            checkinComplete,
            scanTime: row.scan_time,
            scanVerified: !!Number(row.scan_verified),
            certEnabled: !!Number(row.cert_enabled),
            certId: row.cert_id,
            templatePath: row.template_path,
            certStatus,
            certStatusLabel,
            canDownload: !!Number(row.cert_enabled) && !!row.template_path
        };
    });
}

const DOCTOR_CERT_TRACKING_SQL = `SELECT r.id AS registration_id, r.application_no, r.status AS reg_status, r.seminar_id,
                s.title AS seminar_title, COALESCE(s.cert_scans_required, 1) AS cert_scans_required,
                o.status AS order_status,
                t.id AS ticket_id, COALESCE(t.scan_count, 0) AS scan_count, COALESCE(t.is_scanned, 0) AS is_scanned,
                t.scan_time, t.ticket_id_string,
                uc.id AS cert_id, COALESCE(uc.scan_verified, 0) AS scan_verified, COALESCE(uc.enabled, 0) AS cert_enabled,
                ct.file_path AS template_path
         FROM registrations r
         JOIN seminars s ON s.id = r.seminar_id
         LEFT JOIN orders o ON o.registration_id = r.id AND lower(trim(o.status)) = 'success'
         LEFT JOIN tickets t ON t.order_id = o.id
         LEFT JOIN user_certificates uc ON uc.user_id = r.user_id AND uc.seminar_id = r.seminar_id
         LEFT JOIN certificate_templates ct ON ct.id = uc.template_id AND COALESCE(ct.is_active, 1) = 1
         WHERE r.user_id = ? AND COALESCE(r.status, '') NOT IN ('rejected', 'cancelled')
         ORDER BY r.id DESC`;

const DOCTOR_CERT_TRACKING_SQL_LEGACY = `SELECT r.id AS registration_id, r.application_no, r.status AS reg_status, r.seminar_id,
                s.title AS seminar_title, 1 AS cert_scans_required,
                o.status AS order_status,
                t.id AS ticket_id, CASE WHEN COALESCE(t.is_scanned, 0) = 1 THEN 1 ELSE 0 END AS scan_count,
                COALESCE(t.is_scanned, 0) AS is_scanned,
                t.scan_time, t.ticket_id_string,
                uc.id AS cert_id, COALESCE(uc.scan_verified, 0) AS scan_verified, COALESCE(uc.enabled, 0) AS cert_enabled,
                ct.file_path AS template_path
         FROM registrations r
         JOIN seminars s ON s.id = r.seminar_id
         LEFT JOIN orders o ON o.registration_id = r.id AND lower(trim(o.status)) = 'success'
         LEFT JOIN tickets t ON t.order_id = o.id
         LEFT JOIN user_certificates uc ON uc.user_id = r.user_id AND uc.seminar_id = r.seminar_id
         LEFT JOIN certificate_templates ct ON ct.id = uc.template_id AND COALESCE(ct.is_active, 1) = 1
         WHERE r.user_id = ? AND COALESCE(r.status, '') NOT IN ('rejected', 'cancelled')
         ORDER BY r.id DESC`;

function queryDoctorCertificateTracking(uid, res, sql, retried) {
    db.all(sql, [uid], (err, rows) => {
        if (err && !retried && /scan_count|cert_scans_required|does not exist|column/i.test(String(err.message || ''))) {
            return queryDoctorCertificateTracking(uid, res, DOCTOR_CERT_TRACKING_SQL_LEGACY, true);
        }
        if (err) return res.status(500).json({ error: err.message });
        res.json(mapDoctorCertificateTrackingRows(rows));
    });
}

// Doctor certificate tracking (live check-in + approval status per seminar) — Certificates tab only
app.get('/api/doctor/certificate-tracking/:userId', withAuxiliaryTables, (req, res) => {
    const uid = parseInt(req.params.userId, 10);
    if (!Number.isInteger(uid) || uid < 1) return res.status(400).json({ error: 'Invalid user' });
    certVerify.ensureCertificateVerifySchema(db, () => {}, () => {
        queryDoctorCertificateTracking(uid, res, DOCTOR_CERT_TRACKING_SQL, false);
    });
});

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
app.post('/api/auth/forgot-password', withAuxiliaryTables, (req, res) => {
    const forgotEmailV = contactValidation.validateEmail((req.body && req.body.email) || '');
    if (!forgotEmailV.valid) return res.status(400).json({ error: forgotEmailV.message });
    const emailNorm = forgotEmailV.cleanedEmail;
    const respond = () => res.json({ success: true, message: 'If an account exists, reset instructions were sent.' });
    let returnPage = String((req.body && req.body.returnTo) || 'index.html').trim();
    if (!/^[a-z0-9._-]+\.html$/i.test(returnPage)) returnPage = 'index.html';
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
                        notifEngine.publicBaseUrl() +
                        '/' +
                        returnPage +
                        '?resetToken=' +
                        encodeURIComponent(token);
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

app.post('/api/auth/reset-password', withAuxiliaryTables, (req, res) => {
    const token = String((req.body && req.body.token) || '').trim();
    const newPassword = req.body && req.body.newPassword != null ? String(req.body.newPassword) : '';
    if (!token || newPassword.length < 4) {
        return res.status(400).json({ error: 'Valid token and new password (min 4 chars) required' });
    }
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    db.get(
        `SELECT id, user_id FROM password_reset_tokens WHERE token_hash = ? AND used = 0 AND expires_at > ?`,
        [tokenHash, new Date().toISOString()],
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

const inboundMailReply = require('./lib/inbound-mail-reply');
app.post('/api/webhooks/inbound-email', (req, res) => {
    inboundMailReply.handleInboundMail(db, req, res);
});
app.post('/api/webhooks/mailparser', (req, res) => {
    inboundMailReply.handleInboundMail(db, req, res);
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
                type: o.type,
                gateway: o.gateway,
                mode: o.mode,
                label: o.label,
                description: o.description || ''
            })),
            mockAvailable: !(options && options.length)
        });
    });
});

function finishDoctorPayment(res, err, out) {
    if (err) return res.status(500).json({ success: false, error: err.message });
    if (!out) return res.status(500).json({ success: false, error: 'No response from payment service' });
    if (out.error) return res.status(400).json({ success: false, error: out.error });
    if (out.paid) {
        return res.json({
            success: true,
            paid: true,
            message: out.message,
            gateway: out.gateway,
            orderId: out.orderIdString,
            orderDbId: out.orderDbId
        });
    }
    const body = {
        success: true,
        paid: false,
        message: out.message,
        paymentType: out.paymentType,
        orderDbId: out.orderDbId,
        orderId: out.orderIdString,
        amount: out.amount,
        pollRequired: !!out.pollRequired,
        qrImageUrl: out.qrImageUrl,
        qrShortUrl: out.qrShortUrl,
        manualConfirm: !!out.manualConfirm
    };
    if (out.paymentType === 'razorpay_checkout') {
        body.gateway = 'razorpay';
        body.keyId = out.keyId;
        body.order = out.razorpayOrder;
        body.mode = out.mode;
    }
    if (out.paymentType && String(out.paymentType).endsWith('_checkout') && out.gateway !== 'razorpay') {
        body.gateway = out.gateway;
        body.mode = out.mode;
        if (out.paymentUrl) body.paymentUrl = out.paymentUrl;
        if (out.formPost) body.formPost = out.formPost;
        if (out.easebuzzAccessKey) {
            body.easebuzzAccessKey = out.easebuzzAccessKey;
            body.easebuzzKey = out.easebuzzKey;
            body.easebuzzEnv = out.easebuzzEnv;
        }
    }
    res.json(body);
}

// 6. Payments: Process Payment (unified — DQR, Razorpay checkout, mock)
app.post('/api/payments/process', (req, res) => {
    const { registrationId, userId, paymentOption, methodId, cancelPending } = req.body;
    const regId = parseInt(registrationId, 10);
    const uid = parseInt(userId, 10);
    const mid = String(methodId || paymentOption || '').trim();
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

        const runInitiate = () => {
            if (!mid) {
                return listDoctorPaymentOptions((eList, options) => {
                    if (eList) return res.status(500).json({ success: false, error: eList.message });
                    if (options && options.length === 1) {
                        return adminPaymentFlow.initiateAdminPayment(
                            db,
                            doctorPaymentDeps(),
                            { registrationId: regId, methodId: options[0].id },
                            (e, o) => finishDoctorPayment(res, e, o)
                        );
                    }
                    if (options && options.length > 1) {
                        return res.status(400).json({
                            success: false,
                            error: 'Choose a payment method from the dropdown before paying.',
                            options: options.map((o) => ({
                                id: o.id,
                                label: o.label,
                                type: o.type,
                                description: o.description || ''
                            }))
                        });
                    }
                    return adminPaymentFlow.initiateAdminPayment(
                        db,
                        doctorPaymentDeps(),
                        { registrationId: regId, methodId: 'mock' },
                        (e, o) => finishDoctorPayment(res, e, o)
                    );
                });
            }
            adminPaymentFlow.initiateAdminPayment(
                db,
                doctorPaymentDeps(),
                { registrationId: regId, methodId: mid },
                (e, o) => finishDoctorPayment(res, e, o)
            );
        };

        if (cancelPending) {
            return adminPaymentFlow.cancelPendingOrdersForRegistration(db, regId, () => runInitiate());
        }
        runInitiate();
    });
});

function doctorProfileUrlFromRow(row) {
    if (!row || !row.profile_photo_path) return null;
    return fileStore.publicFileUrl(row.profile_photo_path);
}

function doctorPayloadFromScanRow(row, extra) {
    const base = {
        userId: row.doctor_user_id,
        userIdString: row.doctor_user_id_string,
        name: buildDisplayNameFromFormData(row.form_data, row),
        email: row.doctor_email,
        phone: row.doctor_phone,
        applicationNo: row.application_no,
        seminarTitle: row.seminar_title,
        ticketId: row.ticket_id_string,
        profilePhotoUrl: doctorProfileUrlFromRow(row)
    };
    return extra ? Object.assign(base, extra) : base;
}

const SCANNER_TICKET_LOOKUP_SQL = `
        SELECT t.id AS ticket_id, t.is_scanned, IFNULL(t.scan_count, 0) AS scan_count, t.ticket_id_string, IFNULL(t.is_valid, 1) AS is_valid,
               t.qr_code_data,
               s.id AS seminar_id, s.checkin_enabled, s.checkin_date, s.title AS seminar_title,
               s.event_date, IFNULL(s.cert_scans_required, 1) AS cert_scans_required,
               u.id AS doctor_user_id, u.user_id_string AS doctor_user_id_string,
               u.first_name AS doctor_first_name, u.last_name AS doctor_last_name, u.email AS doctor_email, u.phone AS doctor_phone,
               IFNULL(u.is_disabled, 0) AS doctor_is_disabled, IFNULL(u.is_banned, 0) AS doctor_is_banned, u.ban_reason AS doctor_ban_reason,
               dp.profile_photo_path AS profile_photo_path,
               r.id AS registration_id, r.application_no, r.form_data, r.status AS registration_status, o.status AS payment_status
        FROM tickets t
        JOIN orders o ON t.order_id = o.id
        JOIN registrations r ON o.registration_id = r.id
        JOIN seminars s ON r.seminar_id = s.id
        JOIN users u ON t.user_id = u.id
        LEFT JOIN doctor_profile dp ON dp.user_id = u.id`;

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
               t.id AS ticket_id, t.ticket_id_string, t.is_scanned, IFNULL(t.scan_count, 0) AS scan_count, t.qr_code_data, IFNULL(t.is_valid, 1) AS is_valid,
               s.id AS seminar_id, s.checkin_enabled, s.checkin_date, s.title AS seminar_title, s.event_date,
               IFNULL(s.cert_scans_required, 1) AS cert_scans_required,
               u.id AS doctor_user_id, u.user_id_string AS doctor_user_id_string,
               u.first_name AS doctor_first_name, u.last_name AS doctor_last_name, u.email AS doctor_email, u.phone AS doctor_phone,
               IFNULL(u.is_disabled, 0) AS doctor_is_disabled, IFNULL(u.is_banned, 0) AS doctor_is_banned, u.ban_reason AS doctor_ban_reason,
               dp.profile_photo_path AS profile_photo_path
        FROM registrations r
        JOIN users u ON u.id = r.user_id
        JOIN seminars s ON s.id = r.seminar_id
        LEFT JOIN doctor_profile dp ON dp.user_id = u.id
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
                    logScanDashboard(selectedSeminarId, staffId, 'not_found', 'Ticket or application not found', null);
                    return res.status(404).json({
                        success: false,
                        error: 'Not found. Scan e-ticket QR, or enter E-ticket ID / Application ID.',
                        sound: 'error'
                    });
                }
                if (row.error === 'unpaid') {
                    const unpaidRow = row.regRow || row;
                    logScanDashboard(
                        selectedSeminarId,
                        staffId,
                        'unpaid',
                        'Payment not confirmed',
                        unpaidRow
                    );
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
                    logScanDashboard(selectedSeminarId, staffId, 'account_blocked', accountBlock.error, row);
                    return res.status(403).json({
                        success: false,
                        error: accountBlock.error,
                        sound: 'error',
                        accountStatus: accountBlock.accountStatus,
                        doctor: doctorPayloadFromScanRow(row, {
                            ticketId: row.ticket_id_string,
                            accountStatus: accountBlock.accountStatus,
                            banReason: accountBlock.banReason || undefined
                        })
                    });
                }

                const payOk = String(row.payment_status || '').toLowerCase() === 'success';
                if (!payOk) {
                    logScanDashboard(selectedSeminarId, staffId, 'unpaid', 'Payment is not confirmed for this ticket', row);
                    return res.status(403).json({
                        success: false,
                        error: 'Payment is not confirmed for this ticket.',
                        sound: 'error',
                        doctor: doctorPayloadFromScanRow(row, {
                            ticketId: row.ticket_id_string,
                            paymentStatus: 'UNPAID'
                        })
                    });
                }
                const regSt = String(row.registration_status || '').toLowerCase();
                if (regSt === 'cancelled' || regSt === 'rejected') {
                    logScanDashboard(
                        selectedSeminarId,
                        staffId,
                        'invalid',
                        regSt === 'cancelled' ? 'Registration cancelled' : 'Registration rejected',
                        row
                    );
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
                    logScanDashboard(selectedSeminarId, staffId, 'invalid', 'Ticket no longer valid', row);
                    return res.status(403).json({
                        success: false,
                        error: 'Ticket is no longer valid (cancelled registration).',
                        doctor: doctorPayloadFromScanRow(row)
                    });
                }
                const scansRequired = certVerify.normalizeCertScansRequired(row.cert_scans_required);
                const currentScanCount = Number(row.scan_count) || (row.is_scanned ? 1 : 0);
                if (currentScanCount >= scansRequired) {
                    logScanDashboard(
                        selectedSeminarId,
                        staffId,
                        'duplicate',
                        scansRequired === 2 ? 'Entry and exit scans already recorded' : 'Check-in already completed',
                        row
                    );
                    return res.status(400).json({
                        success: false,
                        error:
                            scansRequired === 2
                                ? 'Both entry and exit scans are already recorded for this ticket.'
                                : 'Check-in already completed for this ticket.',
                        scanCount: currentScanCount,
                        scansRequired,
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
                    logScanDashboard(
                        selectedSeminarId,
                        staffId,
                        'wrong_seminar',
                        'Ticket is for ' + (row.seminar_title || 'another seminar'),
                        row
                    );
                    return res.status(403).json({
                        success: false,
                        error: `Wrong seminar selected. This ticket is for "${row.seminar_title}". Choose that seminar in the dropdown, then scan again.`,
                        sound: 'wrong_seminar',
                        doctor: doctorPayloadFromScanRow(row, {
                            ticketId: row.ticket_id_string,
                            orderId: row.order_id_string
                        })
                    });
                }

                const checkinOn =
                    row.checkin_enabled === true ||
                    row.checkin_enabled === 1 ||
                    row.checkin_enabled === '1';
                if (!checkinOn) {
                    logScanDashboard(selectedSeminarId, staffId, 'checkin_disabled', 'Check-in disabled for seminar', row);
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
                    const dateMsg = `Check-in only for ${expected || 'configured date'} (today ${today})`;
                    logScanDashboard(selectedSeminarId, staffId, 'wrong_date', dateMsg, row);
                    return res.status(403).json({
                        success: false,
                        error: `Check-in is only open for ${expected || 'the configured date'} (today in India is ${today}). In Admin → Seminars, set "Check-in allowed date" to today (${today}), or leave it blank to allow any day while check-in is enabled.`,
                        sound: 'wrong_date',
                        doctor: doctorPayloadFromScanRow(row)
                    });
                }

                const newScanCount = currentScanCount + 1;
                const scanAtIst = seminarDt.scanTimeNowForStorage();
                db.run(
                    `UPDATE tickets SET scan_count = ?, is_scanned = 1, scan_time = ?, scanned_by = ? WHERE id = ?`,
                    [newScanCount, scanAtIst, staffId, row.ticket_id],
                    function (err2) {
                        if (err2) return res.status(500).json({ success: false, error: err2.message });
                        const regId = row.registration_id;
                        const finishScanResponse = (scanAtIso) => {
                            syncCertificateEligibilityForTicket(row.ticket_id, () => {
                                const doctorName = buildDisplayNameFromFormData(row.form_data, {
                                    first_name: row.doctor_first_name,
                                    last_name: row.doctor_last_name
                                });
                                const atIso = scanAtIso || new Date().toISOString();
                                notifEngine.notify(
                                    db,
                                    'CHECK_IN_SUCCESS',
                                    {
                                        userId: row.doctor_user_id,
                                        seminarId: row.seminar_id,
                                        registrationId: regId || null,
                                        immediate: true,
                                        vars: {
                                            ticket_id: row.ticket_id_string,
                                            payment_status:
                                                row.payment_status === 'success' ? 'PAID' : 'UNPAID',
                                            approval_status: 'checked_in',
                                            check_in_time: formatCheckInTimeForNotify(atIso)
                                        }
                                    },
                                    (nErr) => {
                                        if (nErr) console.warn('[scanner] check-in notify:', nErr.message);
                                    }
                                );

                                const certEligibleNow =
                                    String(row.payment_status || '').toLowerCase() === 'success' &&
                                    newScanCount >= scansRequired;
                                let scanMsg =
                                    'Attendance marked. Doctor tracking updated.';
                                if (scansRequired === 2) {
                                    if (newScanCount === 1) {
                                        scanMsg =
                                            'Entry scan recorded (1 of 2). Exit scan still required for certificate eligibility.';
                                    } else {
                                        scanMsg =
                                            'Exit scan recorded (2 of 2). Certificate eligibility updated pending admin approval.';
                                    }
                                } else if (certEligibleNow) {
                                    scanMsg +=
                                        ' Participation & Volunteer certificate attendance recorded (if assigned as seminar volunteer).';
                                }
                                db.get(
                                    `SELECT 1 AS ok FROM seminar_volunteers WHERE user_id = ? AND seminar_id = ? AND status = 'approved' LIMIT 1`,
                                    [row.doctor_user_id, row.seminar_id],
                                    (_eSv, svRow) => {
                                        if (svRow && svRow.ok) {
                                            scanMsg +=
                                                ' Dual certificates (Participation + Volunteer) updated from this QR scan.';
                                        }
                                        sendScanSuccess();
                                    }
                                );
                                function sendScanSuccess() {
                                recordScanEventForDashboard(selectedSeminarId, staffId, {
                                    ticket_db_id: row.ticket_id,
                                    ticket_id_string: row.ticket_id_string,
                                    application_no: row.application_no,
                                    doctor_user_id: row.doctor_user_id,
                                    doctor_name: doctorName,
                                    outcome: 'success',
                                    message: scanMsg
                                });
                                res.json({
                                    success: true,
                                    sound: 'success',
                                    message: scanMsg,
                                    scanCount: newScanCount,
                                    scansRequired,
                                    certificateEligible: certEligibleNow,
                                    doctor: doctorPayloadFromScanRow(row, {
                                        name: doctorName,
                                        ticketId: row.ticket_id_string,
                                        registrationType: 'checked_in',
                                        paymentStatus: row.payment_status === 'success' ? 'PAID' : 'UNPAID',
                                        checkedInAt: atIso
                                    }),
                                    scannedByStaffId: staffId
                                });
                                }
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
        otp_on_step1,
        otp_on_submit,
        public_list_enabled,
        cert_scans_required,
        is_active,
        show_seats_public
    } = req.body;
    const certScansReq = certVerify.normalizeCertScansRequired(cert_scans_required);
    const rfj = registration_form_json != null && String(registration_form_json).trim() !== '' ? String(registration_form_json) : null;
    const cpj = cancellation_policy_json != null && String(cancellation_policy_json).trim() !== '' ? String(cancellation_policy_json) : null;
    const wu = whatsapp_group_url != null && String(whatsapp_group_url).trim() !== '' ? String(whatsapp_group_url).trim() : null;
    const otpApp =
        otp_on_application === false || otp_on_application === 0 || otp_on_application === '0' ? 0 : 1;
    const otpStep1 =
        !otpApp || otp_on_step1 === false || otp_on_step1 === 0 || otp_on_step1 === '0' ? 0 : 1;
    const otpSubmit =
        !otpApp || otp_on_submit === false || otp_on_submit === 0 || otp_on_submit === '0' ? 0 : 1;
    const pubList = public_list_enabled ? 1 : 0;
    const activeFlag = is_active === false || is_active === 0 || is_active === '0' ? 0 : 1;
    const showSeats =
        show_seats_public === false || show_seats_public === 0 || show_seats_public === '0' ? 0 : 1;
    const regStart = seminarDt.normalizeSeminarDateTimeForStorage(registration_start);
    const regEnd = seminarDt.normalizeSeminarRegistrationEndForStorage(registration_end);
    const eventDt = seminarDt.normalizeSeminarDateTimeForStorage(event_date);
    const bodyYear = req.body && req.body.portal_year != null ? parseInt(req.body.portal_year, 10) : null;
    portalTracking.getPortalYear(db, (ePy, defaultYear) => {
        const portalYear =
            Number.isInteger(bodyYear) && bodyYear > 2000 ? bodyYear : defaultYear;
        db.run(
            `INSERT INTO seminars (title, description, registration_start, registration_end, event_date, capacity, price, checkin_enabled, checkin_date, location_url, terms_conditions, hero_image_path, flyer_path, gallery_paths, registration_form_json, cancellation_policy_json, whatsapp_group_url, otp_on_application, otp_on_step1, otp_on_submit, public_list_enabled, cert_scans_required, portal_year, is_active, show_seats_public) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
                otpStep1,
                otpSubmit,
                pubList,
                certScansReq,
                portalYear,
                activeFlag,
                showSeats
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
        otp_on_step1,
        otp_on_submit,
        public_list_enabled,
        cert_scans_required,
        portal_year,
        show_seats_public
    } = req.body;
    const certScansReq = certVerify.normalizeCertScansRequired(cert_scans_required);
    const rfj = registration_form_json != null && String(registration_form_json).trim() !== '' ? String(registration_form_json) : null;
    const cpj = cancellation_policy_json != null && String(cancellation_policy_json).trim() !== '' ? String(cancellation_policy_json) : null;
    const wu = whatsapp_group_url != null && String(whatsapp_group_url).trim() !== '' ? String(whatsapp_group_url).trim() : null;
    const otpApp =
        otp_on_application === false || otp_on_application === 0 || otp_on_application === '0' ? 0 : 1;
    const otpStep1 =
        !otpApp || otp_on_step1 === false || otp_on_step1 === 0 || otp_on_step1 === '0' ? 0 : 1;
    const otpSubmit =
        !otpApp || otp_on_submit === false || otp_on_submit === 0 || otp_on_submit === '0' ? 0 : 1;
    const pubList = public_list_enabled ? 1 : 0;
    const showSeats =
        show_seats_public === false || show_seats_public === 0 || show_seats_public === '0' ? 0 : 1;
    const py = portal_year != null ? parseInt(portal_year, 10) : null;
    const regStart = seminarDt.normalizeSeminarDateTimeForStorage(registration_start);
    const regEnd = seminarDt.normalizeSeminarRegistrationEndForStorage(registration_end);
    const eventDt = seminarDt.normalizeSeminarDateTimeForStorage(event_date);
    portalTracking.getPortalYear(db, (ePy, defaultYear) => {
        if (ePy) return res.status(500).json({ error: ePy.message });
        const finalPortalYear = Number.isInteger(py) && py > 2000 ? py : defaultYear;
        db.run(
            `UPDATE seminars SET title=?, description=?, registration_start=?, registration_end=?, event_date=?, capacity=?, price=?, checkin_enabled=?, checkin_date=?, is_active=?, location_url=?, terms_conditions=?, hero_image_path=?, flyer_path=?, gallery_paths=?, registration_form_json=?, cancellation_policy_json=?, whatsapp_group_url=?, otp_on_application=?, otp_on_step1=?, otp_on_submit=?, public_list_enabled=?, cert_scans_required=?, portal_year=?, show_seats_public=? WHERE id=?`,
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
                otpStep1,
                otpSubmit,
                pubList,
                certScansReq,
                finalPortalYear,
                showSeats,
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

    const steps = [
        [`DELETE FROM registration_status_log WHERE registration_id = ?`, [rid]],
        [`DELETE FROM registration_reminder_log WHERE registration_id = ?`, [rid]],
        [`DELETE FROM pending_registration_reminder_log WHERE registration_id = ?`, [rid]],
        [`DELETE FROM cancellation_requests WHERE registration_id = ?`, [rid]],
        [`DELETE FROM seminar_feedback WHERE registration_id = ?`, [rid]],
        [`DELETE FROM application_edits WHERE application_id = ?`, [rid]],
        [`DELETE FROM user_certificates WHERE registration_id = ?`, [rid]],
        [`DELETE FROM volunteer_certificates WHERE registration_id = ?`, [rid]],
        [`DELETE FROM interactive_session_registrations WHERE registration_id = ?`, [rid]],
        [`UPDATE case_submissions SET registration_id = NULL WHERE registration_id = ?`, [rid]],
        [`DELETE FROM refunds WHERE registration_id = ?`, [rid]],
        [`DELETE FROM supplemental_payments WHERE registration_id = ?`, [rid]],
        [
            `DELETE FROM refunds WHERE order_id IN (SELECT id FROM orders WHERE registration_id = ?)`,
            [rid]
        ],
        [
            `DELETE FROM tickets WHERE order_id IN (SELECT id FROM orders WHERE registration_id = ?)`,
            [rid]
        ],
        [`DELETE FROM orders WHERE registration_id = ?`, [rid]],
        [`DELETE FROM registrations WHERE id = ?`, [rid]]
    ];

    let i = 0;
    const next = (err) => {
        if (err) return cb(err);
        if (i >= steps.length) return cb(null, { deleted: true });
        const [sql, params] = steps[i++];
        db.run(sql, params, function (runErr) {
            if (runErr && !/no such table|does not exist|undefined table/i.test(String(runErr.message))) {
                return cb(runErr);
            }
            if (i === steps.length) return cb(null, { deleted: this.changes > 0 });
            next();
        });
    };
    next();
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
                    seminarPurge.purgeSeminarOrphanData(db, sid, (eOrphan) => {
                        if (eOrphan) return res.status(500).json({ error: eOrphan.message });
                        removeSeminar();
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

// Admin: purge test seminar data (registrations/orders/tickets/scans) — keeps doctor accounts
app.post('/api/admin/seminars/:id/purge-test-data', (req, res) => {
    const sid = parseInt(req.params.id, 10);
    if (!Number.isInteger(sid) || sid < 1) return res.status(400).json({ error: 'Invalid seminar id' });
    const deleteSeminar = String((req.query && req.query.deleteSeminar) || (req.body && req.body.deleteSeminar) || '') === '1';
    seminarPurge.purgeSeminarTestData(db, sid, deleteRegistrationCascade, { deleteSeminar }, (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({
            success: true,
            message: deleteSeminar
                ? 'Seminar and all related registration data removed. Doctor accounts were not deleted.'
                : 'All registrations and seminar activity data removed. Seminar record kept. Doctor accounts were not deleted.',
            ...result
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
            if (r.status === 'pending_approval' || r.status === 'submitted' || r.status === 'revision_required') {
                stats.pending_apps++;
            }
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
            seminarCapacity.getSeminarCapacity(db, seminarId, (eCap, cap) => {
                if (!eCap && cap) {
                    stats.capacity = cap.capacity;
                    stats.filled = cap.filled;
                    stats.remaining = cap.remaining;
                    stats.seats_full = cap.full;
                    stats.unlimited_seats = cap.unlimited;
                }
            res.json(stats);
            });
        });
    });
});

app.get('/api/admin/seminars/:id/capacity', (req, res) => {
    const seminarId = parseInt(req.params.id, 10);
    if (!Number.isInteger(seminarId) || seminarId < 1) {
        return res.status(400).json({ error: 'Invalid seminar id' });
    }
    seminarCapacity.getSeminarCapacity(db, seminarId, (err, cap) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!cap) return res.status(404).json({ error: 'Seminar not found' });
        res.json(cap);
    });
});

// Admin: Add Notice
app.post('/api/admin/notices', withMemoryAwareUpload('pdf'), (req, res) => {
    const { seminar_id, message } = req.body;
    const finish = (pdfPath) => {
        db.run(
            `INSERT INTO notices (seminar_id, message, pdf_path) VALUES (?, ?, ?)`,
            [seminar_id || null, message, pdfPath],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true, noticeId: this.lastID });
            }
        );
    };
    if (!req.file) return finish(null);
    fileStore.persistMulterFile(db, req.file, uploadsDir, (pErr, stored) => {
        if (pErr) return res.status(500).json({ error: pErr.message });
        finish(stored ? stored.replace(/^\/uploads\//, '') : null);
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
    'revision_required',
    'documents_requested',
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

function promoteRegistrationToCertificateIssued(registrationId, cb) {
    if (!registrationId) return cb && cb(null);
    db.run(
        `UPDATE registrations SET status = 'certificate_issued'
         WHERE id = ? AND COALESCE(status, '') NOT IN ('rejected', 'cancelled')
           AND status IN ('checked_in', 'completed', 'e_ticket_issued', 'approved_pending_payment', 'certificate_issued')`,
        [registrationId],
        (err) => {
            if (err) return cb && cb(err);
            portalTracking.logRegistrationEvent(
                db,
                registrationId,
                'certificate_issued',
                'E-certificate issued',
                'Your e-certificate has been approved and is ready for download.',
                () => cb && cb(null)
            );
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
                            if (e3) return cb && cb(e3);
                            promoteRegistrationToCertificateIssued(registrationId, cb);
                        }
                    );
                }
            );
        }
    );
}

app.get('/api/admin/analytics/seminar/:seminarId', (req, res) => {
    seminarAnalytics.loadSeminarAnalytics(db, req.params.seminarId, (err, data) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(data);
    });
});

app.post('/api/applications/check-ncism-certificate', withCertificateUpload, (req, res) => {
    let entered = String((req.body && req.body.ncism) || '').trim();
    if (!entered && req.body && req.body.formData) {
        try {
            const fd =
                typeof req.body.formData === 'string' ? JSON.parse(req.body.formData) : req.body.formData;
            entered = String((fd && fd.ncism) || '').trim();
        } catch (_) {}
    }
    if (!entered) return res.status(400).json({ error: 'Enter your NCISM / registration number first.' });

    const runCheck = (formData) => {
        regCertVerify.verifyCertificateForRegistration(db, fileStore, uploadsDir, formData, (e, check) => {
            if (e) return res.status(500).json({ error: e.message });
            res.json({ success: true, check });
        });
    };

    if (req.file) {
        return persistUploadedCertificate(req, (certErr, certPath) => {
            if (certErr) return res.status(500).json({ error: certErr.message });
            runCheck({ ncism: entered, certificate_path: certPath });
        });
    }
    const existingPath = String((req.body && req.body.certificate_path) || '').trim();
    if (existingPath) return runCheck({ ncism: entered, certificate_path: existingPath });
    return res.status(400).json({ error: 'Upload your registration certificate to compare with the number you entered.' });
});

app.post('/api/admin/applications/:applicationId/recheck-ncism', (req, res) => {
    const appId = parseInt(req.params.applicationId, 10);
    if (!Number.isInteger(appId) || appId < 1) return res.status(400).json({ error: 'Invalid application id' });
    db.get(`SELECT form_data FROM registrations WHERE id = ?`, [appId], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Application not found' });
        let formData = {};
        try {
            formData = JSON.parse(row.form_data || '{}');
        } catch (_) {}
        regCertVerify.verifyCertificateForRegistration(db, fileStore, uploadsDir, formData, (e2, check) => {
            if (e2) return res.status(500).json({ error: e2.message });
            formData.ncism_certificate_check = check;
            db.run(
                `UPDATE registrations SET form_data = ? WHERE id = ?`,
                [JSON.stringify(sanitizeFormDataForStorage(formData)), appId],
                (e3) => {
                    if (e3) return res.status(500).json({ error: e3.message });
                    res.json({ success: true, check });
                }
            );
        });
    });
});

// Admin: verify seminar application (documents + details)
app.post('/api/admin/applications/:applicationId/document-verify', (req, res) => {
    docVerify.verifySeminarApplication(
        db,
        req.params.applicationId,
        req.body || {},
        { portalTracking, notifEngine, getOrCreatePendingOrder },
        (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!result || !result.ok) return res.status(400).json({ error: (result && result.error) || 'Verify failed' });
            res.json({ success: true, status: result.status, message: result.message });
        }
    );
});

// Doctor: re-upload certificate / NCISM on same application after admin document rejection
app.post('/api/applications/:applicationId/resubmit-documents', withApplicationDocUpload, (req, res) => {
    const appId = parseInt(req.params.applicationId, 10);
    const userId = parsePositiveUserId(req.body && req.body.userId);
    if (!Number.isInteger(appId) || appId < 1) {
        return res.status(400).json({ error: 'Invalid application id' });
    }
    if (!userId) {
        return res.status(400).json({ error: 'Invalid user. Please sign in again.' });
    }
    db.get(
        `SELECT id, user_id, seminar_id, status, form_data, application_no FROM registrations WHERE id = ?`,
        [appId],
        (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!row) return res.status(404).json({ error: 'Application not found' });
            if (Number(row.user_id) !== userId) {
                return res.status(403).json({ error: 'This application does not belong to your account.' });
            }
            const resubmitSt = String(row.status || '').toLowerCase();
            if (resubmitSt !== 'revision_required' && resubmitSt !== 'documents_requested') {
                return res.status(400).json({
                    error: 'Document resubmission is only available when admin requested corrections or additional documents.'
                });
            }
            let formData = {};
            try {
                formData = JSON.parse(row.form_data || '{}');
            } catch (_) {
                formData = {};
            }
            if (req.body && req.body.ncism) {
                formData.ncism = String(req.body.ncism).trim();
            } else if (req.body && req.body.formData) {
                try {
                    const fd =
                        typeof req.body.formData === 'string' ? JSON.parse(req.body.formData) : req.body.formData;
                    if (fd && fd.ncism) formData.ncism = String(fd.ncism).trim();
                } catch (_) {
                    /* ignore */
                }
            }
            const saveAdditionalDoc = (next) => {
                const addFile = additionalDocFileFromReq(req);
                if (!addFile) return next();
                return fileStore.persistMulterFile(db, addFile, uploadsDir, (aErr, addPath) => {
                    if (aErr) return res.status(500).json({ error: aErr.message });
                    if (addPath) {
                        formData.additional_documents = formData.additional_documents || [];
                        if (!Array.isArray(formData.additional_documents)) formData.additional_documents = [];
                        formData.additional_documents.push({
                            path: addPath,
                            label: String((req.body && req.body.additionalDocLabel) || 'Additional document').trim(),
                            uploaded_at: new Date().toISOString()
                        });
                    }
                    next();
                });
            };
            persistUploadedCertificate(req, (certErr, certPath) => {
                if (certErr) return res.status(500).json({ error: certErr.message });
                if (certPath) formData.certificate_path = certPath;
                if (resubmitSt === 'revision_required' && docVerify.needsAdvancedQualDocs(formData)) {
                    if (!formData.ncism || !String(formData.ncism).trim()) {
                        return res.status(400).json({ error: 'NCISM / registration number is required.' });
                    }
                    if (!formData.certificate_path || !String(formData.certificate_path).trim()) {
                        return res.status(400).json({ error: 'Please upload your certificate document.' });
                    }
                }
                if (resubmitSt === 'documents_requested') {
                    const hasAdd =
                        (formData.additional_documents && formData.additional_documents.length) ||
                        additionalDocFileFromReq(req);
                    if (!hasAdd && !certPath) {
                        return res.status(400).json({ error: 'Upload at least one additional document.' });
                    }
                }
                saveAdditionalDoc(() => {
                    const saveResubmit = (mergedStored) => {
                        db.run(
                            `UPDATE registrations SET form_data = ?, status = 'pending_approval', doc_review_json = NULL WHERE id = ?`,
                            [JSON.stringify(mergedStored), appId],
                            (e2) => {
                                if (e2) return res.status(500).json({ error: e2.message });
                                portalTracking.logRegistrationEvent(
                                    db,
                                    appId,
                                    'pending_approval',
                                    'Documents resubmitted',
                                    resubmitSt === 'documents_requested'
                                        ? 'Additional verification documents received — under review again.'
                                        : 'Updated certificate/NCISM received — under review again.',
                                    () => {}
                                );
                                notifEngine.notify(db, 'APPLICATION_UNDER_REVIEW', {
                                    userId: row.user_id,
                                    seminarId: row.seminar_id,
                                    registrationId: appId,
                                    vars: { application_no: row.application_no || '' }
                                });
                                res.json({
                                    success: true,
                                    message:
                                        'Documents resubmitted on application ' +
                                        (row.application_no || appId) +
                                        '. Admin will review again.'
                                });
                            }
                        );
                    };
                    if (formData.certificate_path && formData.ncism && resubmitSt === 'revision_required') {
                        return regCertVerify.verifyCertificateForRegistration(
                            db,
                            fileStore,
                            uploadsDir,
                            formData,
                            (verr, check) => {
                                if (verr) console.warn('[ncism-verify]', verr.message);
                                if (check) formData.ncism_certificate_check = check;
                                saveResubmit(sanitizeFormDataForStorage(formData));
                            }
                        );
                    }
                    saveResubmit(sanitizeFormDataForStorage(formData));
                });
            });
        }
    );
});

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
                    if (newSt === 'approved_pending_payment') ev = 'APPLICATION_APPROVED';
                    else if (newSt === 'rejected') ev = 'APPLICATION_REJECTED';
                    else if (newSt === 'revision_required') ev = 'APPLICATION_REVISION_REQUIRED';
                    else if (newSt === 'cancelled') ev = 'REGISTRATION_CANCELLED';
                    else if (
                        newSt === 'completed' ||
                        newSt === 'e_ticket_issued' ||
                        newSt === 'checked_in' ||
                        newSt === 'certificate_issued'
                    ) {
                        ev = null;
                    }
                    if (!ev) return;
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
            db.get(
                `SELECT s.price FROM registrations r LEFT JOIN seminars s ON s.id = r.seminar_id WHERE r.id = ?`,
                [applicationId],
                (eAmt2, semRow2) => {
                    const amt = paymentAmountForSeminar(semRow2 || {});
                    ensureParticipantTicketForRegistration(
                        applicationId,
                        { createOrderIfMissing: true, promotePendingToSuccess: true, amount: amt },
                        (eTix, tixMeta) => {
                            if (eTix || !tixMeta || tixMeta.skipped || !tixMeta.ticketId) return;
                            db.get(`SELECT user_id FROM registrations WHERE id = ?`, [applicationId], (eU, regU) => {
                                if (!eU && regU) {
                                    notifyTicketIssued(regU.user_id, applicationId, tixMeta.ticketId, {
                                        email: true,
                                        whatsapp: false
                                    });
                                }
                            });
                        }
                    );
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
                                markRegistrationETicketIssued(applicationId, () => {});
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
                                                markRegistrationETicketIssued(applicationId, () => {});
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
                                        markRegistrationETicketIssued(applicationId, () => {
                                            portalTracking.registrationStatusToLog('e_ticket_issued', '').forEach((entry) => {
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
                                                        notifEngine.notifyRegistrationPaid(db, {
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
                                                        markRegistrationETicketIssued(applicationId, () => {});
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
                                                        markRegistrationETicketIssued(applicationId, () => {});
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

// Admin: find account(s) — register before /:userId routes
app.get('/api/admin/users/lookup', (req, res) => {
    const adminUserLookup = require('./lib/admin-user-lookup');
    const email = String(req.query.email || '').trim();
    const portalId = String(req.query.portalId || req.query.user_id_string || '').trim();
    const q = String(req.query.q || req.query.query || email || portalId || '').trim();
    if (!q) {
        return res.status(400).json({
            error: 'Enter email, 12-digit portal ID, phone, or name (e.g. Nitin).'
        });
    }
    adminUserLookup.searchAdminUsers(db, q, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!rows.length) {
            return res.json({
                found: false,
                hint:
                    'No account in the database matches that search. If you just created a user, the save may have failed — create again. For Mr Nitin Thatte, search Nitin or thattenitin13@gmail.com (portal ID 645390302736, Doctors tab).'
            });
        }
        const matches = rows.map(adminUserLookup.mapUserForAdminResponse);
        const user = matches[0];
        const accountList = user.account_list;
        res.json({
            found: true,
            accountList,
            user,
            matches,
            multiple: matches.length > 1,
            hint:
                matches.length > 1
                    ? `${matches.length} accounts match — pick the correct one in the list below.`
                    : accountList === 'staff'
                      ? 'Open Staff users tab'
                      : 'Open Doctors tab (includes public website sign-ups)'
        });
    });
});

// Admin: full user detail (profile, registrations, orders, scans, activity)
app.get('/api/admin/users/:userId/detail', (req, res) => {
    const uid = parseInt(req.params.userId, 10);
    if (!Number.isInteger(uid) || uid < 1) return res.status(400).json({ error: 'Invalid user id' });

    db.get(
        `SELECT id, user_id_string, first_name, middle_name, last_name, email, phone, password, role, user_role,
                doctor_category, doctor_modules,
                is_disabled, IFNULL(is_banned,0) AS is_banned, ban_reason, banned_at,
                IFNULL(is_demo,0) AS is_demo, created_at, activated_at, last_login_at,
                IFNULL(email_verified,1) AS email_verified FROM users WHERE id = ?`,
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
        notifEngine.notify(
            db,
            'ACCOUNT_CREATED',
            {
                userId: uid,
                vars: { temporary_password: newPass }
            },
            () => {
                flushNotificationQueue();
            }
        );
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

app.post('/api/admin/certificates/builtin-template', (req, res) => {
    const seminarId = parseInt(req.body && req.body.seminarId, 10);
    const adminUserId = parseInt(req.body && req.body.adminUserId, 10);
    const certType =
        req.body && String(req.body.certType || 'participant').toLowerCase() === 'volunteer'
            ? 'volunteer'
            : 'participant';
    if (!Number.isInteger(seminarId) || seminarId < 1) {
        return res.status(400).json({ error: 'seminarId is required' });
    }
    certRender.applyBuiltinTemplate(db, { seminarId, certType, adminUserId }, (err, out) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({
            success: true,
            templateId: out.templateId,
            filePath: out.filePath,
            certType: out.certType,
            message: 'VGMF standard certificate design applied for this seminar.'
        });
    });
});

app.get('/api/admin/certificates/template-config', (req, res) => {
    const seminarId = parseInt(req.query.seminarId, 10);
    const certType =
        String(req.query.certType || 'participant').toLowerCase() === 'volunteer' ? 'volunteer' : 'participant';
    if (!Number.isInteger(seminarId) || seminarId < 1) {
        return res.status(400).json({ error: 'seminarId is required' });
    }
    certRender.getActiveTemplate(db, seminarId, certType, (err, tpl) => {
        if (err) return res.status(500).json({ error: err.message });
        const config = certTemplateCfg.parseConfig(tpl && tpl.config_json);
        if (tpl && tpl.signature_left_path) config.sigLeftImagePath = tpl.signature_left_path;
        if (tpl && tpl.signature_right_path) config.sigRightImagePath = tpl.signature_right_path;
        res.json({
            success: true,
            config,
            templateId: tpl ? tpl.id : null,
            filePath: tpl ? tpl.file_path : null,
            signatureLeftPath: tpl ? tpl.signature_left_path : null,
            signatureRightPath: tpl ? tpl.signature_right_path : null,
            isBuiltin: tpl ? certRender.isBuiltinPath(tpl.file_path) : false
        });
    });
});

app.post('/api/admin/certificates/signature-image', withMemoryAwareUpload('signatureFile'), (req, res) => {
    const seminarId = parseInt(req.body && req.body.seminarId, 10);
    const certType =
        req.body && String(req.body.certType || 'participant').toLowerCase() === 'volunteer'
            ? 'volunteer'
            : 'participant';
    const side = String((req.body && req.body.side) || 'right').toLowerCase() === 'left' ? 'left' : 'right';
    if (!req.file) return res.status(400).json({ error: 'signatureFile is required (PNG or JPEG)' });
    if (!Number.isInteger(seminarId) || seminarId < 1) {
        return res.status(400).json({ error: 'seminarId is required' });
    }
    const applySignature = (relPath) => {
    const col = side === 'left' ? 'signature_left_path' : 'signature_right_path';
    certRender.getActiveTemplate(db, seminarId, certType, (e, tpl) => {
        if (e) return res.status(500).json({ error: e.message });
        const applyPath = (templateId, cb) => {
            db.run(`UPDATE certificate_templates SET ${col} = ? WHERE id = ?`, [relPath, templateId], (e2) => {
                if (e2) return res.status(500).json({ error: e2.message });
                cb(null, { templateId, path: relPath, side });
            });
        };
        if (tpl && tpl.id) return applyPath(tpl.id, (e2, out) => res.json({ success: true, ...out }));
        certRender.applyBuiltinTemplate(
            db,
            { seminarId, certType, adminUserId: parseInt(req.body.adminUserId, 10) },
            (e3, out) => {
                if (e3) return res.status(500).json({ error: e3.message });
                applyPath(out.templateId, (e4, done) => {
                    if (e4) return res.status(500).json({ error: e4.message });
                    res.json({ success: true, ...done });
                });
            }
        );
    });
    };
    fileStore.persistMulterFile(db, req.file, uploadsDir, (pErr, relPath) => {
        if (pErr) return res.status(500).json({ error: pErr.message });
        applySignature(relPath);
    });
});

app.put('/api/admin/certificates/template-config', (req, res) => {
    const { seminarId, certType, config, adminUserId } = req.body || {};
    const sid = parseInt(seminarId, 10);
    const aid = parseInt(adminUserId, 10);
    if (!Number.isInteger(sid) || sid < 1) return res.status(400).json({ error: 'seminarId is required' });
    certRender.saveTemplateConfig(
        db,
        { seminarId: sid, certType, config: config || {}, adminUserId: aid },
        (err, out) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, ...out });
        }
    );
});

app.post('/api/admin/certificates/preview', (req, res) => {
    const { seminarId, certType, config } = req.body || {};
    certRender.renderPreviewHtml(db, { seminarId, certType, config }, (err, html) => {
        if (err) return res.status(500).json({ error: err.message });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    });
});

// Admin: certificate template upload
app.post('/api/admin/certificates/template', withMemoryAwareUpload('templateFile'), (req, res) => {
    const seminarId = parseInt(req.body.seminarId, 10);
    const adminUserId = parseInt(req.body.adminUserId, 10);
    if (!req.file) return res.status(400).json({ error: 'templateFile is required (image or document)' });
    if (!Number.isInteger(seminarId) || seminarId < 1) return res.status(400).json({ error: 'seminarId is required' });

    const certType =
        req.body && String(req.body.certType || 'participant').toLowerCase() === 'volunteer'
            ? 'volunteer'
            : 'participant';
    fileStore.persistMulterFile(db, req.file, uploadsDir, (pErr, relPath) => {
        if (pErr) return res.status(500).json({ error: pErr.message });
        db.run(
            `UPDATE certificate_templates SET is_active = 0 WHERE seminar_id = ? AND IFNULL(cert_type,'participant') = ?`,
            [seminarId, certType],
            () => {
                db.run(
                    `INSERT INTO certificate_templates (seminar_id, file_path, original_name, mime_type, uploaded_by, is_active, cert_type) VALUES (?, ?, ?, ?, ?, 1, ?)`,
                    [
                        seminarId,
                        relPath,
                        req.file.originalname,
                        req.file.mimetype,
                        Number.isInteger(adminUserId) ? adminUserId : null,
                        certType
                    ],
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
    if (enabled) {
        return         db.get(
            `SELECT uc.id, uc.user_id, uc.seminar_id, uc.registration_id, r.application_no, u.user_id_string
             FROM user_certificates uc
             JOIN users u ON u.id = uc.user_id
             LEFT JOIN registrations r ON r.id = uc.registration_id
             WHERE uc.id = ?`,
            [id],
            (e0, row) => {
                if (e0) return res.status(500).json({ error: e0.message });
                if (!row) return res.status(404).json({ error: 'Certificate not found' });
                const chk = certVerify.validateCertMandatoryFields(row);
                if (!chk.ok) return res.status(400).json({ error: chk.error });
                certVerify.ensureUserCertVerifyToken(db, id, (eTok) => {
                    if (eTok) return res.status(500).json({ error: eTok.message });
                    db.run(
                        `UPDATE user_certificates SET enabled = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                        [id],
                        function (err) {
                            if (err) return res.status(500).json({ error: err.message });
                            const finishEnable = () => {
                            notifEngine.notify(db, 'CERTIFICATE_AVAILABLE', {
                                userId: row.user_id,
                                seminarId: row.seminar_id,
                                immediate: true,
                                vars: {
                                    certificate_url:
                                        notifEngine.publicBaseUrl() + '/doctor.html#tab-certificates'
                                }
                            });
                                res.json({ success: true });
                            };
                            if (row.registration_id) {
                                return promoteRegistrationToCertificateIssued(row.registration_id, finishEnable);
                            }
                            finishEnable();
                        }
                    );
                });
            }
        );
    }
    db.run(
        `UPDATE user_certificates SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [id],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

// Public certificate verification (enabled per seminar after event ends)
app.get('/api/public/certificate-verify/seminars', (req, res) => {
    certVerify.listPublicVerifySeminars(db, (err, list) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(list || []);
    });
});

app.get('/api/public/certificate-verify/schedule', (req, res) => {
    certVerify.listPublicVerifySchedule(db, (err, list) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(list || []);
    });
});

app.post('/api/public/certificate-verify/lookup', (req, res) => {
    const { seminarId, applicationNo, prn, token, certKind } = req.body || {};
    certVerify.resolveCertForPublicLookup(
        db,
        { seminarId, applicationNo, prn, token, certKind },
        (err, out) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!out || !out.ok) return res.status(400).json(out || { ok: false, error: 'Lookup failed' });
            res.json({
                ok: true,
                seminar: out.seminar,
                certId: out.cert.id,
                certKind: out.cert.kind || 'participant',
                displayName: out.cert.displayName,
                applicationNo: out.cert.applicationNo,
                prn: out.cert.prn,
                maskedEmail: certVerify.maskEmail(out.cert.email),
                maskedPhone: certVerify.maskPhone(out.cert.phone)
            });
        }
    );
});

function sendCertificateVerifyOtpChannel(channel, destination, meta, cb) {
    otpLib.countRecentSends(db, channel, destination, (cerr, cnt) => {
        if (cerr) return cb(cerr);
        if (cnt >= otpLib.MAX_SENDS_PER_HOUR) {
            return cb(null, { rateLimited: true });
        }
        const code = otpLib.generateOtpDigits();
        otpLib.saveOtp(db, { channel, destination, purpose: 'certificate_verify', meta }, code, (serr) => {
            if (serr) return cb(serr);
            notifEngine
                .sendOtpMessages({
                    email: channel === 'email' ? destination : null,
                    phone: channel === 'phone' ? destination : null,
                    code,
                    db,
                    eventKey: 'OTP_VERIFICATION'
                })
                .then((results) => {
                    const sent = channel === 'phone' ? results.whatsapp : results.email;
                    const debug =
                        process.env.OTP_RETURN_CODE === '1' || process.env.NODE_ENV === 'development';
                    if (!sent.ok && !sent.skipped) {
                        return cb(null, {
                            deliverError:
                                sent.error ||
                                'Could not deliver OTP. Configure Zoho email and/or WhatsApp API.',
                            debugCode: debug ? code : undefined
                        });
                    }
                    cb(null, { debugCode: debug ? code : undefined });
                })
                .catch((e) => cb(e));
        });
    });
}

app.post('/api/public/certificate-verify/otp/send-both', withIntegrationSettingsLoaded, (req, res) => {
    const { seminarId, applicationNo, prn, token } = req.body || {};
    certVerify.resolveCertForPublicLookup(
        db,
        { seminarId, applicationNo, prn, token },
        (err, out) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!out || !out.ok) return res.status(400).json(out || { ok: false, error: 'Lookup failed' });
            const email = String(out.cert.email || '').trim();
            const phone = String(out.cert.phone || '').trim();
            const ev = contactValidation.validateEmail(email);
            const pv = contactValidation.validatePhone(phone);
            if (!ev.valid) return res.status(400).json({ error: 'Certificate holder email is not on file.' });
            if (!pv.valid) return res.status(400).json({ error: 'Certificate holder mobile is not on file.' });
            const meta = {
                certId: out.cert.id,
                certKind: out.cert.kind || 'participant',
                seminarId: out.seminar.id,
                userId: out.cert.userId
            };
            sendCertificateVerifyOtpChannel('email', ev.cleanedEmail, meta, (e1, r1) => {
                if (e1) return res.status(500).json({ error: e1.message });
                if (r1 && r1.rateLimited) {
                    return res.status(429).json({ error: 'Too many OTP requests. Try again later.' });
                }
                if (r1 && r1.deliverError) {
                    return res.status(503).json({ error: r1.deliverError, debugCode: r1.debugCode });
                }
                sendCertificateVerifyOtpChannel('phone', pv.cleanedPhone, meta, (e2, r2) => {
                    if (e2) return res.status(500).json({ error: e2.message });
                    if (r2 && r2.rateLimited) {
                        return res.status(429).json({ error: 'Too many OTP requests. Try again later.' });
                    }
                    if (r2 && r2.deliverError) {
                        return res.status(503).json({ error: r2.deliverError, debugCode: r2.debugCode });
                    }
                    const debug =
                        process.env.OTP_RETURN_CODE === '1' || process.env.NODE_ENV === 'development';
                    const payload = {
                        success: true,
                        ttlMinutes: otpLib.OTP_TTL_MIN,
                        maskedEmail: certVerify.maskEmail(ev.cleanedEmail),
                        maskedPhone: certVerify.maskPhone(pv.cleanedPhone),
                        certId: out.cert.id
                    };
                    if (debug) {
                        payload.debugEmailCode = r1 && r1.debugCode;
                        payload.debugPhoneCode = r2 && r2.debugCode;
                    }
                    res.json(payload);
                });
            });
        }
    );
});

app.post('/api/public/certificate-verify/confirm', (req, res) => {
    const { seminarId, applicationNo, prn, token, emailCode, phoneCode } = req.body || {};
    if (!emailCode || !phoneCode) {
        return res.status(400).json({ error: 'Email and WhatsApp OTP codes are both required.' });
    }
    certVerify.resolveCertForPublicLookup(
        db,
        { seminarId, applicationNo, prn, token },
        (err, out) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!out || !out.ok) return res.status(400).json(out || { ok: false, error: 'Lookup failed' });
            const ev = contactValidation.validateEmail(out.cert.email);
            const pv = contactValidation.validatePhone(out.cert.phone);
            if (!ev.valid || !pv.valid) {
                return res.status(400).json({ error: 'Certificate contact details are incomplete.' });
            }
            const meta = {
                certId: out.cert.id,
                certKind: out.cert.kind || 'participant',
                seminarId: out.seminar.id,
                userId: out.cert.userId
            };
            otpLib.verifyOtp(
                db,
                {
                    channel: 'email',
                    destination: ev.cleanedEmail,
                    purpose: 'certificate_verify',
                    code: String(emailCode).trim(),
                    meta,
                    userId: out.cert.userId,
                    seminarId: out.seminar.id
                },
                (e1, r1) => {
                    if (e1) return res.status(500).json({ error: e1.message });
                    if (!r1 || !r1.ok) {
                        return res.status(400).json({
                            error: (r1 && r1.error) || 'Invalid or expired email OTP.'
                        });
                    }
                    otpLib.verifyOtp(
                        db,
                        {
                            channel: 'phone',
                            destination: pv.cleanedPhone,
                            purpose: 'certificate_verify',
                            code: String(phoneCode).trim(),
                            meta,
                            userId: out.cert.userId,
                            seminarId: out.seminar.id
                        },
                        (e2, r2) => {
                            if (e2) return res.status(500).json({ error: e2.message });
                            if (!r2 || !r2.ok) {
                                return res.status(400).json({
                                    error: (r2 && r2.error) || 'Invalid or expired WhatsApp OTP.'
                                });
                            }
                            certVerify.validateBothOtpTokens(
                                db,
                                {
                                    certId: out.cert.id,
                                    certKind: out.cert.kind || 'participant',
                                    emailToken: r1.token,
                                    phoneToken: r2.token
                                },
                                (e3, v) => {
                                    if (e3) return res.status(500).json({ error: e3.message });
                                    if (!v || !v.ok) {
                                        return res.status(400).json(
                                            v || { ok: false, error: 'OTP validation failed' }
                                        );
                                    }
                                    res.json({
                                        ok: true,
                                        valid: true,
                                        seminarTitle: out.seminar.title,
                                        displayName: out.cert.displayName,
                                        applicationNo: out.cert.applicationNo,
                                        prn: out.cert.prn,
                                        message:
                                            'This certificate is authentic and was issued by the Vaidya Gogate Memorial Foundation.'
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
            const ur = String(adm.user_role || '').toLowerCase();
            const ok =
                String(adm.role || '').toLowerCase() === 'admin' ||
                ur === 'co_admin' ||
                ur === 'scanner_dashboard_user';
            if (!ok) return cb(new Error('FORBIDDEN'), null);
            cb(null, adm);
        }
    );
}

function requireAdminActor(req, res, next) {
    const aid = parseInt(
        (req.query && req.query.actingAdminId) || (req.body && req.body.actingAdminId) || '',
        10
    );
    if (!Number.isInteger(aid) || aid < 1) {
        res.status(400).json({ error: 'actingAdminId is required' });
        return;
    }
    assertAdminPortalActor(aid, (err, adm) => {
        if (err || !adm) return res.status(403).json({ error: 'Admin access required' });
        next(adm);
    });
}

registerLiveScannerRoutes(app, { db, requireAdminActor });
registerPosRoutes(app, {
    db,
    generateId,
    requireAdminActor,
    getOrCreatePendingOrder,
    fulfillRegistrationPayment,
    seminarCapacity,
    activityLog,
    notifyTicketIssued,
    emailDeliveryPolicy
});

app.get('/api/public/feedback-form', (req, res) => {
    feedbackFormConfig.loadFeedbackFormConfig(db, (err, cfg) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(cfg);
    });
});

app.get('/api/admin/feedback-form', (req, res) => {
    requireAdminActor(req, res, () => {
        feedbackFormConfig.loadFeedbackFormConfig(db, (err, cfg) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(cfg);
        });
    });
});

app.post('/api/admin/feedback-form', (req, res) => {
    requireAdminActor(req, res, () => {
        feedbackFormConfig.saveFeedbackFormConfig(db, req.body && req.body.config, (err, cfg) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, config: cfg });
        });
    });
});

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

app.get('/api/public/portal-theme/:portal', (req, res) => {
    const portal = String(req.params.portal || 'public').toLowerCase();
    if (!['public', 'doctor', 'judge'].includes(portal)) {
        return res.status(400).json({ error: 'Invalid portal (public, doctor, judge)' });
    }
    portalThemeMod.loadTheme(db, portal, (err, theme) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ portal, theme });
    });
});

app.get('/api/admin/portal-themes', (req, res) => {
    const aid = parseInt(req.query.actingAdminId, 10);
    if (!Number.isInteger(aid) || aid < 1) {
        return res.status(400).json({ error: 'actingAdminId query parameter is required' });
    }
    assertAdminPortalActor(aid, (e, adm) => {
        if (e && e.message === 'BAD_ACTOR') return res.status(400).json({ error: 'actingAdminId is required' });
        if (e && e.message === 'FORBIDDEN') return res.status(403).json({ error: 'Administrator access required' });
        if (e) return res.status(500).json({ error: e.message });
        if (!adm) return res.status(403).json({ error: 'Invalid administrator' });
        portalThemeMod.loadAllThemes(db, (err, themes) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, themes });
        });
    });
});

app.post('/api/admin/portal-themes', (req, res) => {
    const { actingAdminId, themes } = req.body || {};
    const aid = parseInt(actingAdminId, 10);
    if (!Number.isInteger(aid) || aid < 1) return res.status(400).json({ error: 'actingAdminId is required' });
    if (!themes || typeof themes !== 'object') return res.status(400).json({ error: 'themes object required' });
    assertAdminPortalActor(aid, (e, adm) => {
        if (e && e.message === 'BAD_ACTOR') return res.status(400).json({ error: 'actingAdminId is required' });
        if (e && e.message === 'FORBIDDEN') return res.status(403).json({ error: 'Administrator access required' });
        if (e) return res.status(500).json({ error: e.message });
        if (!adm) return res.status(403).json({ error: 'Invalid administrator' });
        const portals = ['public', 'doctor', 'judge'].filter((p) => themes[p]);
        if (!portals.length) return res.status(400).json({ error: 'No themes provided' });
        let i = 0;
        const saved = {};
        const nextPortal = (err) => {
            if (err) return res.status(500).json({ error: err.message });
            if (i >= portals.length) return res.json({ success: true, themes: saved });
            const p = portals[i++];
            portalThemeMod.saveTheme(db, p, themes[p], (e2, norm) => {
                if (e2) return res.status(500).json({ error: e2.message });
                saved[p] = norm;
                nextPortal();
            });
        };
        nextPortal();
    });
});

app.get('/api/admin/pending-registration-reminder-config', (req, res) => {
    const aid = parseInt(req.query.actingAdminId, 10);
    if (!Number.isInteger(aid) || aid < 1) {
        return res.status(400).json({ error: 'actingAdminId query parameter is required' });
    }
    assertAdminPortalActor(aid, (e, adm) => {
        if (e && e.message === 'BAD_ACTOR') return res.status(400).json({ error: 'actingAdminId is required' });
        if (e && e.message === 'FORBIDDEN') return res.status(403).json({ error: 'Administrator access required' });
        if (e) return res.status(500).json({ error: e.message });
        if (!adm) return res.status(403).json({ error: 'Invalid administrator' });
        pendingRegReminders.loadConfig(db, (err, config) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, config });
        });
    });
});

app.get('/api/admin/support-ticket-config', (req, res) => {
    const aid = parseInt(req.query.actingAdminId, 10);
    if (!Number.isInteger(aid) || aid < 1) {
        return res.status(400).json({ error: 'actingAdminId query parameter is required' });
    }
    assertAdminPortalActor(aid, (e, adm) => {
        if (e && e.message === 'BAD_ACTOR') return res.status(400).json({ error: 'actingAdminId is required' });
        if (e && e.message === 'FORBIDDEN') return res.status(403).json({ error: 'Administrator access required' });
        if (e) return res.status(500).json({ error: e.message });
        if (!adm) return res.status(403).json({ error: 'Invalid administrator' });
        supportTicketSla.loadConfig(db, (err, config) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, config });
        });
    });
});

app.post('/api/admin/support-ticket-config', (req, res) => {
    const { actingAdminId, config } = req.body || {};
    const aid = parseInt(actingAdminId, 10);
    if (!Number.isInteger(aid) || aid < 1) return res.status(400).json({ error: 'actingAdminId is required' });
    if (!config || typeof config !== 'object') return res.status(400).json({ error: 'config object required' });
    assertAdminPortalActor(aid, (e, adm) => {
        if (e && e.message === 'BAD_ACTOR') return res.status(400).json({ error: 'actingAdminId is required' });
        if (e && e.message === 'FORBIDDEN') return res.status(403).json({ error: 'Administrator access required' });
        if (e) return res.status(500).json({ error: e.message });
        if (!adm) return res.status(403).json({ error: 'Invalid administrator' });
        supportTicketSla.saveConfig(db, config, (err, norm) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, config: norm });
        });
    });
});

app.post('/api/admin/pending-registration-reminder-config', (req, res) => {
    const { actingAdminId, config } = req.body || {};
    const aid = parseInt(actingAdminId, 10);
    if (!Number.isInteger(aid) || aid < 1) return res.status(400).json({ error: 'actingAdminId is required' });
    if (!config || typeof config !== 'object') return res.status(400).json({ error: 'config object required' });
    assertAdminPortalActor(aid, (e, adm) => {
        if (e && e.message === 'BAD_ACTOR') return res.status(400).json({ error: 'actingAdminId is required' });
        if (e && e.message === 'FORBIDDEN') return res.status(403).json({ error: 'Administrator access required' });
        if (e) return res.status(500).json({ error: e.message });
        if (!adm) return res.status(403).json({ error: 'Invalid administrator' });
        pendingRegReminders.saveConfig(db, config, (err, norm) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, config: norm });
        });
    });
});

app.get('/api/admin/judge-communications', (req, res) => {
    const aid = parseInt(req.query.actingAdminId, 10);
    if (!Number.isInteger(aid) || aid < 1) {
        return res.status(400).json({ error: 'actingAdminId query parameter is required' });
    }
    assertAdminPortalActor(aid, (e, adm) => {
        if (e && e.message === 'BAD_ACTOR') return res.status(400).json({ error: 'actingAdminId is required' });
        if (e && e.message === 'FORBIDDEN') return res.status(403).json({ error: 'Administrator access required' });
        if (e) return res.status(500).json({ error: e.message });
        if (!adm) return res.status(403).json({ error: 'Invalid administrator' });
        judgeContact.listCommunications(
            db,
            { limit: req.query.limit, offset: req.query.offset },
            (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true, communications: rows });
            }
        );
    });
});

app.get('/api/admin/notification-delivery-config', (req, res) => {
    const aid = parseInt(req.query.actingAdminId, 10);
    if (!Number.isInteger(aid) || aid < 1) {
        return res.status(400).json({ error: 'actingAdminId query parameter is required' });
    }
    assertAdminPortalActor(aid, (e, adm) => {
        if (e && e.message === 'BAD_ACTOR') return res.status(400).json({ error: 'actingAdminId is required' });
        if (e && e.message === 'FORBIDDEN') return res.status(403).json({ error: 'Administrator access required' });
        if (e) return res.status(500).json({ error: e.message });
        if (!adm) return res.status(403).json({ error: 'Invalid administrator' });
        emailDeliveryPolicy.loadConfig(db, (err, config) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, config });
        });
    });
});

app.post('/api/admin/notification-delivery-config', (req, res) => {
    const { actingAdminId, config } = req.body || {};
    const aid = parseInt(actingAdminId, 10);
    if (!Number.isInteger(aid) || aid < 1) return res.status(400).json({ error: 'actingAdminId is required' });
    if (!config || typeof config !== 'object') return res.status(400).json({ error: 'config object required' });
    assertAdminPortalActor(aid, (e, adm) => {
        if (e && e.message === 'BAD_ACTOR') return res.status(400).json({ error: 'actingAdminId is required' });
        if (e && e.message === 'FORBIDDEN') return res.status(403).json({ error: 'Administrator access required' });
        if (e) return res.status(500).json({ error: e.message });
        if (!adm) return res.status(403).json({ error: 'Invalid administrator' });
        emailDeliveryPolicy.saveConfig(db, config, (err, norm) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, config: norm });
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
        const isSuper =
            String(adm.role || '').toLowerCase() === 'admin' &&
            String(adm.user_role || '').toLowerCase() !== 'co_admin';
        if (!isSuper) {
            delete merged.adminEnabledPages;
            delete merged.websiteMenuPages;
        }
        upsertGlobalSetting(portalAuthPolicy.KEY, JSON.stringify(merged), (err) => {
            if (err) return res.status(500).json({ error: err.message });
            portalAuthPolicy.loadPortalAuthConfig(db, () => {
                res.json({ success: true, config: portalAuthPolicy.getPortalAuthConfig() });
            });
        });
    });
});

app.get('/api/admin/system-health/platform', (req, res) => {
    const aid = parseInt(req.query.actingAdminId, 10);
    if (!Number.isInteger(aid) || aid < 1) {
        return res.status(400).json({ error: 'actingAdminId query parameter is required' });
    }
    assertAdminPortalActor(aid, (e, adm) => {
        if (e && e.message === 'FORBIDDEN') return res.status(403).json({ error: 'Administrator access required' });
        if (e) return res.status(500).json({ error: e.message });
        if (!adm) return res.status(403).json({ error: 'Invalid administrator' });
        integrationSettings.loadFromDb(db, () => {
            systemHealth.runPlatformHealth(db, (err, report) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true, report });
            });
        });
    });
});

app.get('/api/admin/system-health/users', (req, res) => {
    const aid = parseInt(req.query.actingAdminId, 10);
    if (!Number.isInteger(aid) || aid < 1) {
        return res.status(400).json({ error: 'actingAdminId query parameter is required' });
    }
    assertAdminPortalActor(aid, (e, adm) => {
        if (e && e.message === 'FORBIDDEN') return res.status(403).json({ error: 'Administrator access required' });
        if (e) return res.status(500).json({ error: e.message });
        if (!adm) return res.status(403).json({ error: 'Invalid administrator' });
        systemHealth.runUserHealth(db, (err, report) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, report });
        });
    });
});

app.post('/api/admin/system-health/auto-fix', (req, res) => {
    const { actingAdminId, issueIds } = req.body || {};
    const aid = parseInt(actingAdminId, 10);
    if (!Number.isInteger(aid) || aid < 1) return res.status(400).json({ error: 'actingAdminId is required' });
    assertAdminPortalActor(aid, (e, adm) => {
        if (e && e.message === 'FORBIDDEN') return res.status(403).json({ error: 'Administrator access required' });
        if (e) return res.status(500).json({ error: e.message });
        if (!adm) return res.status(403).json({ error: 'Invalid administrator' });
        systemHealthAi.attemptAutoFix(db, issueIds, {}, (fixErr, result) => {
            if (fixErr) return res.status(500).json({ error: fixErr.message });
            try {
                flushNotificationQueue();
            } catch (_) {}
            res.json({ success: true, ...result });
        });
    });
});

app.post('/api/admin/system-health/ai-analyze', (req, res) => {
    const { actingAdminId, report } = req.body || {};
    const aid = parseInt(actingAdminId, 10);
    if (!Number.isInteger(aid) || aid < 1) return res.status(400).json({ error: 'actingAdminId is required' });
    assertAdminPortalActor(aid, (e, adm) => {
        if (e && e.message === 'FORBIDDEN') return res.status(403).json({ error: 'Administrator access required' });
        if (e) return res.status(500).json({ error: e.message });
        if (!adm) return res.status(403).json({ error: 'Invalid administrator' });
        systemHealthAi.analyzeWithAiOptional(report || {}, (aErr, out) => {
            if (aErr) return res.status(500).json({ error: aErr.message });
            res.json({ success: true, analysis: out });
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
        middleName,
        lastName,
        email,
        phone,
        password,
        role,
        actingAdminId,
        adminPhoneOtpToken,
        adminEmailOtpToken,
        isDemo,
        userIdString,
        user_id_string
    } = req.body || {};
    const demoFlag =
        isDemo === true || isDemo === 1 || isDemo === '1' || isDemo === 'true' ? 1 : 0;
    const userRoles = require('./lib/user-roles');
    const createKind = String((req.body && req.body.createKind) || '')
        .trim()
        .toLowerCase();
    let userRole = userRoles.normalizeUserRole(role);
    if (createKind === 'staff') {
        if (!userRole || userRole === 'doctor') {
            return res.status(400).json({
                error: 'Select a staff role (Judge, Co Admin, Scanner, or Reviewer). Doctor accounts belong under Doctors → Create doctor.'
            });
        }
        if (!userRoles.ADMIN_CREATABLE_STAFF_ROLES.includes(userRole)) {
            return res.status(400).json({ error: 'Invalid staff role selected.' });
        }
    } else if (!userRole) {
        userRole = 'doctor';
    }
    const roleCol = userRoles.roleColumnForUserRole(userRole);
    const emailNorm = String(email || '')
        .trim()
        .toLowerCase();

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

    let userIdStr = String(userIdString || user_id_string || '').trim().replace(/\D/g, '');
    if (!userIdStr) userIdStr = generateId();
    else if (userIdStr.length < 10) {
        return res.status(400).json({ error: 'Custom portal user ID must be at least 10 digits.' });
    }
    const cleanFirst = userRole === 'doctor' || roleCol === 'doctor' ? validateDoctorName(firstName).cleanedName : String(firstName).trim();
    const cleanMiddle = String(middleName || '').trim() || null;
    const cleanLast = userRole === 'doctor' || roleCol === 'doctor' ? validateDoctorName(lastName).cleanedName : String(lastName).trim();

    requireAdminSensitiveOtpIfEnabled(
        actingAdminId,
        adminPhoneOtpToken,
        adminEmailOtpToken,
        (eOtp, okOtp, msgOtp) => {
        if (eOtp) return res.status(500).json({ error: eOtp.message });
        if (!okOtp) return res.status(400).json({ error: msgOtp || 'Admin verification required' });
        db.get(`SELECT id FROM users WHERE user_id_string = ? LIMIT 1`, [userIdStr], (eDup, dup) => {
            if (eDup) return res.status(500).json({ error: eDup.message });
            if (dup) return res.status(400).json({ error: 'That portal user ID is already in use.' });
            const usersEmailPolicy = require('./lib/users-email-policy');
            const adminUserLookup = require('./lib/admin-user-lookup');

            const proceedInsert = () => {
                db.run(
                    `INSERT INTO users (user_id_string, first_name, middle_name, last_name, email, phone, password, role, user_role, email_verified, is_demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
                    [
                        userIdStr,
                        cleanFirst,
                        cleanMiddle,
                        cleanLast,
                        emailNorm,
                        phone,
                        finalPassword,
                        roleCol,
                        userRole,
                        demoFlag
                    ],
                    function (err) {
                        if (err) {
                            if (/unique|duplicate/i.test(String(err.message || ''))) {
                                return res.status(409).json({
                                    error:
                                        'Portal user ID already exists, or email is already used by a doctor account. Staff test accounts may share an email — use a new portal ID.'
                                });
                            }
                            return res.status(500).json({ error: err.message });
                        }
                        const insertedId = this.lastID;
                        db.get(
                            `SELECT id, user_id_string, user_role, role FROM users WHERE user_id_string = ? LIMIT 1`,
                            [userIdStr],
                            (eVerify, saved) => {
                                if (eVerify) return res.status(500).json({ error: eVerify.message });
                                if (!saved || !saved.id) {
                                    return res.status(500).json({
                                        error:
                                            'Account was not saved to the database. Wait a few seconds and try again, or check Vercel DATABASE_URL for Production.'
                                    });
                                }
                                const newId = saved.id || insertedId;
                                userAccountLifecycle.stampAccountActivated(db, newId, () => {});
                                notifEngine.notify(
                                    db,
                                    'ACCOUNT_CREATED',
                                    {
                                        userId: newId,
                                        vars: { temporary_password: finalPassword }
                                    },
                                    () => {
                                        flushNotificationQueue();
                                    }
                                );
                                designatedNotify.notifyDesignatedAccountCreated(
                                    db,
                                    newId,
                                    { source: 'admin create user', temporary_password: finalPassword },
                                    () => {
                                        flushNotificationQueue();
                                    }
                                );
                                res.json({
                                    success: true,
                                    verified: true,
                                    userId: newId,
                                    user_id_string: saved.user_id_string || userIdStr,
                                    user_role: userRole,
                                    accountList: userRoles.isDoctorPortalAccount({
                                        user_role: saved.user_role || userRole,
                                        role: saved.role || roleCol
                                    })
                                        ? 'doctors'
                                        : 'staff',
                                    generatedPassword: finalPassword,
                                    isDemo: !!demoFlag,
                                    loginHint:
                                        createKind === 'staff'
                                            ? 'Staff login: use this portal ID + password (same email as another account is allowed for testing).'
                                            : undefined
                                });
                            }
                        );
                    }
                );
            };

            if (createKind === 'staff') {
                return proceedInsert();
            }

            usersEmailPolicy.doctorEmailTaken(db, emailNorm, null, (eEmail, taken, existing) => {
                if (eEmail) return res.status(500).json({ error: eEmail.message });
                if (taken) {
                    const list = userRoles.isDoctorPortalAccount(existing) ? 'Doctors' : 'Staff users';
                    return res.status(409).json({
                        error: `This email is already used by a doctor account (${list}, portal ID ${existing && existing.user_id_string ? existing.user_id_string : '—'}). Create a staff test account with the same email under Staff users instead.`,
                        existingUserId: existing && existing.id,
                        existingUser: existing ? adminUserLookup.mapUserForAdminResponse(existing) : null,
                        accountList: userRoles.isDoctorPortalAccount(existing) ? 'doctors' : 'staff'
                    });
                }
                proceedInsert();
            });
        });
    },
        { targetUserRole: userRole }
    );
});

// Admin: Get Users
app.get('/api/admin/users', (req, res) => {
    const userRoles = require('./lib/user-roles');
    const adminUserLookup = require('./lib/admin-user-lookup');
    const filterQ = String(req.query.q || req.query.search || '').trim();
    const sendList = (list) => {
        res.json(
            (list || []).map((r) => {
                const eff = userRoles.effectiveUserRole(r);
                return {
                    ...r,
                    effective_user_role: eff || r.user_role || r.role,
                    account_list: userRoles.isDoctorPortalAccount(r) ? 'doctors' : 'staff'
                };
            })
        );
    };
    const fullCols = `id, user_id_string, first_name, middle_name, last_name, email, phone, role, user_role, doctor_category, doctor_modules, is_disabled,
                IFNULL(is_banned,0) AS is_banned, ban_reason, IFNULL(is_demo,0) AS is_demo, admin_modules,
                created_at, activated_at, last_login_at, IFNULL(email_verified,1) AS email_verified`;
    if (filterQ) {
        return adminUserLookup.searchAdminUsers(db, filterQ, (sErr, matched) => {
            if (sErr) return res.status(500).json({ error: sErr.message });
            const ids = (matched || []).map((m) => m.id);
            if (!ids.length) return sendList([]);
            const placeholders = ids.map(() => '?').join(',');
            db.all(
                `SELECT ${fullCols} FROM users WHERE id IN (${placeholders}) ORDER BY id DESC`,
                ids,
                (err, rows) => {
                    if (err) return res.status(500).json({ error: err.message });
                    sendList(rows);
                }
            );
        });
    }
    db.all(`SELECT ${fullCols} FROM users ORDER BY id DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        sendList(rows);
    });
});

// Admin: Update User Role
app.post('/api/admin/users/:userId/role', (req, res) => {
    const { user_role } = req.body;
    const userRoles = require('./lib/user-roles');
    const validRoles = ['doctor'].concat(userRoles.ADMIN_CREATABLE_STAFF_ROLES);

    if (!validRoles.includes(user_role)) {
        return res.status(400).json({ error: 'Invalid role' });
    }

    const roleCol = userRoles.roleColumnForUserRole(user_role);
    db.run(
        `UPDATE users SET user_role = ?, role = ? WHERE id = ?`,
        [user_role, roleCol, req.params.userId],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, message: `User role updated to ${user_role}` });
        }
    );
});

// Admin: Update doctor category + per-user doctor modules
app.post('/api/admin/users/:userId/doctor-access', (req, res) => {
    const uid = parseInt(req.params.userId, 10);
    if (!Number.isInteger(uid) || uid < 1) return res.status(400).json({ error: 'Invalid user id' });
    const doctor_category = sanitizeDoctorCategory(req.body && req.body.doctor_category);
    const modulesObj = sanitizeDoctorModulesInput(req.body && req.body.doctor_modules);
    const hasModules = Object.keys(modulesObj).length > 0;
    const categoryPreset =
        doctor_category === 'volunteer'
            ? {
                  'tab-dashboard': true,
                  'tab-profile': true,
                  'tab-volunteer': true,
                  'tab-ticket': true,
                  'tab-certificate': true,
                  'tab-reset-pwd': true
              }
            : null;
    const finalModules = hasModules ? modulesObj : categoryPreset;
    const modulesJson = finalModules ? JSON.stringify(finalModules) : null;
    db.get(`SELECT id, role, user_role FROM users WHERE id = ?`, [uid], (e0, row0) => {
        if (e0) return res.status(500).json({ error: e0.message });
        if (!row0) return res.status(404).json({ error: 'User not found' });
        const ur = String(row0.user_role || row0.role || '').toLowerCase();
        if (ur !== 'doctor') return res.status(400).json({ error: 'Doctor access settings are only valid for doctor accounts.' });
        db.run(
            `UPDATE users SET doctor_category = ?, doctor_modules = ? WHERE id = ?`,
            [doctor_category, modulesJson, uid],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({
                    success: true,
                    doctor_category,
                    doctor_modules: finalModules || null
                });
            }
        );
    });
});

// Admin: Get user roles list
app.get('/api/admin/user-roles', (req, res) => {
    db.all(`SELECT * FROM user_roles`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// Admin: permanently delete doctor or staff account (requires portal ID confirmation)
app.post('/api/admin/users/:userId/delete', (req, res) => {
    const targetId = parseInt(req.params.userId, 10);
    const actingAdminId = parseInt((req.body && req.body.actingAdminId) || '', 10);
    const confirmPortalId = (req.body && req.body.confirmPortalId) || '';
    if (!Number.isInteger(targetId) || targetId < 1) {
        return res.status(400).json({ error: 'Invalid user id' });
    }
    assertAdminPortalActor(actingAdminId, (err) => {
        if (err && err.message === 'BAD_ACTOR') {
            return res.status(400).json({ error: 'actingAdminId is required' });
        }
        if (err && err.message === 'FORBIDDEN') {
            return res.status(403).json({ error: 'Administrator access required' });
        }
        if (err) return res.status(500).json({ error: err.message });
        const adminDeleteUser = require('./lib/admin-delete-user');
        adminDeleteUser.deleteUserAccount(
            db,
            targetId,
            deleteRegistrationCascade,
            { actingAdminId, confirmPortalId },
            (delErr, result) => {
                if (delErr) {
                    const msg = delErr.message || 'Delete failed';
                    const code =
                        /not found|confirmation|cannot delete|invalid/i.test(msg) ? 400 : 500;
                    return res.status(code).json({ error: msg });
                }
                activityLog.logActivity(db, {
                    user_id: actingAdminId,
                    action: 'admin.user.deleted',
                    resource_type: 'user',
                    resource_id: String(targetId),
                    meta: {
                        portalId: result && result.portalId,
                        accountType: result && result.accountType
                    }
                });
                res.json({
                    success: true,
                    message:
                        'Account ' +
                        (result && result.portalId ? result.portalId : targetId) +
                        ' and related portal data were permanently removed.'
                });
            }
        );
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

// Admin: Transfer Application (seminar registration and/or case presentation)
app.post('/api/admin/applications/transfer', (req, res) => {
    const body = req.body || {};
    const actingAdminId = parseInt(body.actingAdminId, 10);
    const applicationRef = String(
        body.applicationRef || body.applicationId || body.applicationNo || ''
    ).trim();
    const targetUserRef = String(
        body.targetUserRef || body.newUserIdStr || body.targetUserId || ''
    ).trim();
    const transferType = String(body.transferType || body.type || 'auto').toLowerCase();

    if (!applicationRef) return res.status(400).json({ error: 'Application number or ID is required' });
    if (!targetUserRef) return res.status(400).json({ error: 'Target user portal ID or email is required' });

    assertAdminPortalActor(actingAdminId, (eAct) => {
        if (eAct) return res.status(eAct.message === 'FORBIDDEN' ? 403 : 500).json({ error: 'Admin access required' });
        resolvePortalUserRef(targetUserRef, (eU, targetUser) => {
            if (eU) return res.status(400).json({ error: eU.message });

            const asInt = parseInt(applicationRef, 10);
            const trySeminar = transferType === 'seminar' || transferType === 'registration' || transferType === 'auto';
            const tryCase = transferType === 'case' || transferType === 'case_presentation' || transferType === 'auto';

            const transferSeminar = (cb) => {
                if (!trySeminar) return cb(null, null);
                const sql =
                    Number.isInteger(asInt) && asInt > 0 && /^\d+$/.test(applicationRef)
                        ? `SELECT id, user_id, application_no, status FROM registrations WHERE id = ? OR TRIM(application_no) = TRIM(?) LIMIT 1`
                        : `SELECT id, user_id, application_no, status FROM registrations WHERE TRIM(application_no) = TRIM(?) LIMIT 1`;
                const params =
                    Number.isInteger(asInt) && asInt > 0 && /^\d+$/.test(applicationRef)
                        ? [asInt, applicationRef]
                        : [applicationRef];
                db.get(sql, params, (eR, reg) => {
                    if (eR) return cb(eR);
                    if (!reg) return cb(null, null);
                    if (reg.user_id === targetUser.id) {
                        return cb(new Error('Seminar application already belongs to that user'));
                    }
                    db.run(`UPDATE registrations SET user_id = ? WHERE id = ?`, [targetUser.id, reg.id], (eUp) => {
                        if (eUp) return cb(eUp);
                        db.run(
                            `UPDATE tickets SET user_id = ?
                             WHERE order_id IN (SELECT id FROM orders WHERE registration_id = ?)`,
                            [targetUser.id, reg.id],
                            () => {
                                db.run(
                                    `UPDATE user_certificates SET user_id = ? WHERE registration_id = ?`,
                                    [targetUser.id, reg.id],
                                    () => {
                                        db.run(
                                            `UPDATE seminar_feedback SET user_id = ? WHERE registration_id = ?`,
                                            [targetUser.id, reg.id],
                                            () =>
                                                cb(null, {
                                                    kind: 'seminar',
                                                    id: reg.id,
                                                    applicationNo: reg.application_no,
                                                    status: reg.status
                                                })
                                        );
                                    }
                                );
                            }
                        );
                    });
                });
            };

            const transferCase = (cb) => {
                if (!tryCase) return cb(null, null);
                const sql =
                    Number.isInteger(asInt) && asInt > 0 && /^\d+$/.test(applicationRef)
                        ? `SELECT id, user_id, application_no, status FROM case_submissions WHERE id = ? OR TRIM(application_no) = TRIM(?) LIMIT 1`
                        : `SELECT id, user_id, application_no, status FROM case_submissions WHERE TRIM(application_no) = TRIM(?) LIMIT 1`;
                const params =
                    Number.isInteger(asInt) && asInt > 0 && /^\d+$/.test(applicationRef)
                        ? [asInt, applicationRef]
                        : [applicationRef];
                db.get(sql, params, (eC, sub) => {
                    if (eC) return cb(eC);
                    if (!sub) return cb(null, null);
                    if (sub.user_id === targetUser.id) {
                        return cb(new Error('Case application already belongs to that user'));
                    }
                    db.run(`UPDATE case_submissions SET user_id = ? WHERE id = ?`, [targetUser.id, sub.id], (eUp) => {
                        if (eUp) return cb(eUp);
                        cb(null, {
                            kind: 'case',
                            id: sub.id,
                            applicationNo: sub.application_no,
                            status: sub.status
                        });
                    });
                });
            };

            transferSeminar((eS, seminarOut) => {
                if (eS) return res.status(400).json({ error: eS.message });
                transferCase((eC, caseOut) => {
                    if (eC) return res.status(400).json({ error: eC.message });
                    if (!seminarOut && !caseOut) {
                        return res.status(404).json({
                            error: 'No matching seminar registration or case application found for that reference.'
                        });
                    }
                    activityLog.logActivity(db, {
                        user_id: actingAdminId,
                        action: 'application.transfer',
                        resource_type: seminarOut ? 'registration' : 'case_submission',
                        resource_id: String((seminarOut && seminarOut.id) || (caseOut && caseOut.id)),
                        meta: {
                            applicationRef,
                            targetUserId: targetUser.id,
                            targetUserRef: targetUser.user_id_string,
                            seminar: seminarOut,
                            case: caseOut
                        }
                    });
                    res.json({
                        success: true,
                        targetUser: {
                            id: targetUser.id,
                            userIdString: targetUser.user_id_string,
                            name: [targetUser.first_name, targetUser.last_name].filter(Boolean).join(' ')
                        },
                        seminar: seminarOut,
                        case: caseOut
                    });
                });
            });
        });
    });
});

// Admin: preview application transfer lookup
app.get('/api/admin/applications/transfer-lookup', (req, res) => {
    const applicationRef = String(req.query.applicationRef || req.query.q || '').trim();
    const transferType = String(req.query.transferType || 'auto').toLowerCase();
    const actingAdminId = parseInt(req.query.actingAdminId, 10);
    if (!applicationRef) return res.status(400).json({ error: 'applicationRef is required' });
    assertAdminPortalActor(actingAdminId, (eAct) => {
        if (eAct) return res.status(eAct.message === 'FORBIDDEN' ? 403 : 500).json({ error: 'Admin access required' });
        const asInt = parseInt(applicationRef, 10);
        const out = { seminar: null, case: null };
        let pending = 0;
        const done = () => {
            pending--;
            if (pending > 0) return;
            if (!out.seminar && !out.case) {
                return res.status(404).json({ error: 'No application found', applicationRef });
            }
            res.json({ success: true, ...out });
        };
        if (transferType === 'seminar' || transferType === 'registration' || transferType === 'auto') {
            pending++;
            const sql =
                Number.isInteger(asInt) && asInt > 0 && /^\d+$/.test(applicationRef)
                    ? `SELECT r.id, r.application_no, r.status, u.first_name, u.last_name, u.user_id_string
                       FROM registrations r JOIN users u ON u.id = r.user_id
                       WHERE r.id = ? OR TRIM(r.application_no) = TRIM(?) LIMIT 1`
                    : `SELECT r.id, r.application_no, r.status, u.first_name, u.last_name, u.user_id_string
                       FROM registrations r JOIN users u ON u.id = r.user_id
                       WHERE TRIM(r.application_no) = TRIM(?) LIMIT 1`;
            const params =
                Number.isInteger(asInt) && asInt > 0 && /^\d+$/.test(applicationRef)
                    ? [asInt, applicationRef]
                    : [applicationRef];
            db.get(sql, params, (e, row) => {
                if (!e && row) {
                    out.seminar = {
                        id: row.id,
                        applicationNo: row.application_no,
                        status: row.status,
                        ownerName: [row.first_name, row.last_name].filter(Boolean).join(' '),
                        ownerPortalId: row.user_id_string
                    };
                }
                done();
            });
        }
        if (transferType === 'case' || transferType === 'case_presentation' || transferType === 'auto') {
            pending++;
            const sql =
                Number.isInteger(asInt) && asInt > 0 && /^\d+$/.test(applicationRef)
                    ? `SELECT cs.id, cs.application_no, cs.status, cs.title, u.first_name, u.last_name, u.user_id_string
                       FROM case_submissions cs JOIN users u ON u.id = cs.user_id
                       WHERE cs.id = ? OR TRIM(cs.application_no) = TRIM(?) LIMIT 1`
                    : `SELECT cs.id, cs.application_no, cs.status, cs.title, u.first_name, u.last_name, u.user_id_string
                       FROM case_submissions cs JOIN users u ON u.id = cs.user_id
                       WHERE TRIM(cs.application_no) = TRIM(?) LIMIT 1`;
            const params =
                Number.isInteger(asInt) && asInt > 0 && /^\d+$/.test(applicationRef)
                    ? [asInt, applicationRef]
                    : [applicationRef];
            db.get(sql, params, (e, row) => {
                if (!e && row) {
                    out.case = {
                        id: row.id,
                        applicationNo: row.application_no,
                        status: row.status,
                        topic: row.title,
                        ownerName: [row.first_name, row.last_name].filter(Boolean).join(' '),
                        ownerPortalId: row.user_id_string
                    };
                }
                done();
            });
        }
        if (pending === 0) res.status(400).json({ error: 'Invalid transferType' });
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

// Admin proxy: OTP to applicant phone/email on the form
app.post('/api/admin/proxy-otp/send', withIntegrationSettingsLoaded, (req, res) => {
    const { adminUserId, channel, destination, seminarId } = req.body || {};
    assertAdminPortalActor(adminUserId, (eAct) => {
        if (eAct) return res.status(eAct.message === 'FORBIDDEN' ? 403 : 500).json({ error: 'Admin access required' });
        if (channel !== 'phone' && channel !== 'email') {
            return res.status(400).json({ error: 'channel must be phone or email' });
        }
        const dest = String(destination || '').trim();
        if (!dest) return res.status(400).json({ error: 'destination required' });
        const sid = parseInt(seminarId, 10);
        if (!Number.isInteger(sid) || sid < 1) return res.status(400).json({ error: 'seminarId required' });
        const meta = { seminarId: sid };
        otpLib.countRecentSends(db, channel, dest, (cerr, cnt) => {
            if (cerr) return res.status(500).json({ error: cerr.message });
            if (cnt >= otpLib.MAX_SENDS_PER_HOUR) {
                return res.status(429).json({ error: 'Too many OTP requests. Try again later.' });
            }
            const code = otpLib.generateOtpDigits();
            otpLib.saveOtp(db, { channel, destination: dest, purpose: 'proxy_applicant', meta }, code, (serr) => {
                if (serr) return res.status(500).json({ error: serr.message });
                notifEngine.sendOtpMessages({
                    email: channel === 'email' ? dest : null,
                    phone: channel === 'phone' ? dest : null,
                    code,
                    db,
                    eventKey: 'OTP_VERIFICATION'
                }).then((results) => {
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
                    if (sent.skipped) payload.warning = 'Messaging not fully configured.';
                    res.json(payload);
                });
            });
        });
    });
});

app.post('/api/admin/proxy-otp/verify', (req, res) => {
    const { adminUserId, channel, destination, code, seminarId } = req.body || {};
    assertAdminPortalActor(adminUserId, (eAct) => {
        if (eAct) return res.status(eAct.message === 'FORBIDDEN' ? 403 : 500).json({ error: 'Admin access required' });
        const sid = parseInt(seminarId, 10);
        if (!Number.isInteger(sid) || sid < 1) return res.status(400).json({ error: 'seminarId required' });
        otpLib.verifyOtp(
            db,
            {
                channel,
                destination,
                purpose: 'proxy_applicant',
                code,
                meta: { seminarId: sid },
                seminarId: sid
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
});

// Admin: lookup registration + payment/ticket summary for doctor + seminar
app.get('/api/admin/registrations/lookup', (req, res) => {
    const tid = parseInt(req.query.userId, 10);
    const sid = parseInt(req.query.seminarId, 10);
    if (!Number.isInteger(tid) || tid < 1 || !Number.isInteger(sid) || sid < 1) {
        return res.status(400).json({ error: 'userId and seminarId are required' });
    }
    db.get(
        `SELECT r.id, r.application_no, r.status, r.form_data, r.registration_source, r.created_at,
                s.title AS seminar_title, s.price AS seminar_price
         FROM registrations r
         JOIN seminars s ON s.id = r.seminar_id
         WHERE r.user_id = ? AND r.seminar_id = ?`,
        [tid, sid],
        (e, reg) => {
            if (e) return res.status(500).json({ error: e.message });
            if (!reg) {
                return res.json({
                    found: false,
                    registration: null,
                    order: null,
                    ticket: null
                });
            }
            db.get(
                `SELECT o.id, o.order_id_string, o.status, o.amount, o.payment_gateway
                 FROM orders o
                 WHERE o.registration_id = ?
                 ORDER BY o.id DESC
                 LIMIT 1`,
                [reg.id],
                (e2, ord) => {
                    if (e2) return res.status(500).json({ error: e2.message });
                    const loadTicket = (cb) => {
                        if (!ord) return cb(null, null);
                        db.get(
                            `SELECT t.ticket_id_string, IFNULL(t.is_scanned, 0) AS is_scanned,
                                    IFNULL(t.scan_count, 0) AS scan_count, t.scan_time
                             FROM tickets t WHERE t.order_id = ? LIMIT 1`,
                            [ord.id],
                            (e3, tix) => {
                                if (e3) return cb(e3);
                                cb(null, tix);
                            }
                        );
                    };
                    loadTicket((e3, tix) => {
                        if (e3) return res.status(500).json({ error: e3.message });
                        let formData = {};
                        try {
                            formData = JSON.parse(reg.form_data || '{}');
                        } catch (_) {
                            formData = {};
                        }
                        res.json({
                            found: true,
                            registration: {
                                id: reg.id,
                                applicationNo: reg.application_no,
                                status: reg.status,
                                registrationSource: reg.registration_source,
                                createdAt: reg.created_at,
                                seminarTitle: reg.seminar_title,
                                seminarPrice: reg.seminar_price,
                                formData
                            },
                            order: ord
                                ? {
                                      id: ord.id,
                                      orderIdString: ord.order_id_string,
                                      status: ord.status,
                                      amount: ord.amount,
                                      gateway: ord.payment_gateway
                                  }
                                : null,
                            ticket: tix
                                ? {
                                      ticketIdString: tix.ticket_id_string,
                                      isScanned: !!Number(tix.is_scanned),
                                      scanCount: Number(tix.scan_count) || 0,
                                      scanTime: tix.scan_time
                                  }
                                : null
                        });
                    });
                }
            );
        }
    );
});

function respondAdminRegUpsertWithVolunteerTicket(res, payload, tid, sid, registrationId) {
    volunteerTicketFlow.tryFulfillVolunteerAfterRegistration(
        db,
        volunteerTicketDeps(),
        { userId: tid, seminarId: sid, registrationId },
        (vErr, vRes) => {
            if (vErr) console.warn('[volunteer-ticket] admin upsert:', vErr.message);
            if (vRes && vRes.issued) {
                payload.volunteerTicketIssued = true;
                payload.volunteerTicketId = vRes.ticketId;
                if (vRes.message) payload.volunteerMessage = vRes.message;
            }
            res.json(payload);
        }
    );
}

function runAdminRegistrationUpsertBody(req, res, tid, sid, aid, formData) {
    const stored =
        formData && typeof formData === 'object'
            ? sanitizeFormDataForStorage(formData)
            : sanitizeFormDataForStorage({});
    const fdJson = JSON.stringify(stored);
    const hasCert = !!stored.certificate_path;

    loadRegistrationFormConfig(sid, (cfgErr, regCfg) => {
        if (cfgErr) return res.status(500).json({ error: cfgErr.message });
        const validationError = validateFormDataAgainstRegistrationConfig(
            stored,
            hasCert,
            (regCfg && regCfg.fields) || [],
            null,
            regCfg
        );
        if (validationError) return res.status(400).json({ error: validationError });

        db.get(`SELECT id, form_data FROM registrations WHERE user_id = ? AND seminar_id = ?`, [tid, sid], (e2, reg) => {
            if (e2) return res.status(500).json({ error: e2.message });
            if (reg) {
                return adminLiveEdit.adminUpdateRegistrationFormData(
                    db,
                    {
                        validateFormDataAgainstRegistrationConfig,
                        sanitizeFormDataForStorage,
                        loadRegistrationFormConfig
                    },
                    { registrationId: reg.id, formData: stored, adminUserId: aid },
                    (eUp, result) => {
                        if (eUp) return res.status(500).json({ error: eUp.message });
                        if (!result || !result.ok) {
                            return res.status(400).json({ error: (result && result.error) || 'Update failed' });
                        }
                        respondAdminRegUpsertWithVolunteerTicket(
                            res,
                            {
                                success: true,
                                registrationId: reg.id,
                                applicationNo: result.applicationNo,
                                created: false
                            },
                            tid,
                            sid,
                            reg.id
                        );
                    }
                );
            }
            seminarCapacity.assertSeminarHasCapacity(db, sid, (capErr, cap) => {
                if (capErr) return res.status(500).json({ error: capErr.message });
                if (!cap || !cap.ok) {
                    return res.status(400).json({
                        error: (cap && cap.error) || 'Seminar is full.',
                        capacity: cap && cap.capacity
                    });
                }
                const applicationNo = generateId();
                db.run(
                    `INSERT INTO registrations (user_id, seminar_id, application_no, status, form_data, registration_source, admin_editor_user_id) VALUES (?, ?, ?, 'submitted', ?, 'admin', ?)`,
                    [tid, sid, applicationNo, fdJson, aid],
                    function (ierr) {
                        if (ierr) return res.status(500).json({ error: ierr.message });
                        const newRegId = this.lastID;
                        notifEngine.notify(
                            db,
                            'SEMINAR_REGISTRATION_SUCCESS',
                            { userId: tid, seminarId: sid, registrationId: newRegId },
                            () => {}
                        );
                        respondAdminRegUpsertWithVolunteerTicket(
                            res,
                            {
                                success: true,
                                registrationId: newRegId,
                                applicationNo,
                                created: true
                            },
                            tid,
                            sid,
                            newRegId
                        );
                    }
                );
            });
        });
    });
}

// Admin: create or update a registration on behalf of a doctor (admin-edited; distinct from doctor self-edit API)
app.post('/api/admin/registrations/upsert', (req, res) => {
    const {
        targetUserId,
        seminarId,
        formData,
        adminUserId,
        adminPhoneOtpToken,
        adminEmailOtpToken,
        applicantPhoneOtpToken,
        applicantEmailOtpToken
    } = req.body || {};
    const tid = parseInt(targetUserId, 10);
    const sid = parseInt(seminarId, 10);
    const aid = parseInt(adminUserId, 10);
    if (!Number.isInteger(tid) || !Number.isInteger(sid) || !Number.isInteger(aid)) {
        return res.status(400).json({ error: 'targetUserId, seminarId, and adminUserId are required' });
    }
    adminLiveEdit.assertAdminAccess(db, aid, (eAdm, admResult) => {
        if (eAdm) return res.status(500).json({ error: eAdm.message });
        if (!admResult || !admResult.ok) {
            return res.status(403).json({ error: (admResult && admResult.error) || 'Forbidden' });
        }
        const needApplicantOtp = portalAuthPolicy.behalfApplicantOtpRequired();
        if (needApplicantOtp) {
            if (!applicantPhoneOtpToken || !applicantEmailOtpToken) {
                return res.status(400).json({
                    error: 'Verify applicant phone and email OTP before saving this application.'
                });
            }
            return otpLib.validateProxyApplicantOtpTokens(
                db,
                sid,
                { phoneToken: applicantPhoneOtpToken, emailToken: applicantEmailOtpToken },
                (eApp, appOk) => {
                    if (eApp) return res.status(500).json({ error: eApp.message });
                    if (!appOk || !appOk.ok) {
                        return res.status(400).json({
                            error:
                                (appOk && appOk.error) ||
                                'Verify applicant phone and email OTP before saving this application.'
                        });
                    }
                    runAdminRegistrationUpsertBody(req, res, tid, sid, aid, formData);
                }
            );
        }
        runAdminRegistrationUpsertBody(req, res, tid, sid, aid, formData);
    });
});

// Admin: edit seminar application form_data after doctor submit
app.put('/api/admin/applications/:applicationId/form-data', (req, res) => {
    const rid = parseInt(req.params.applicationId, 10);
    const { formData, adminUserId, adminPhoneOtpToken, adminEmailOtpToken } = req.body || {};
    const aid = parseInt(adminUserId, 10);
    if (!Number.isInteger(rid) || rid < 1 || !Number.isInteger(aid)) {
        return res.status(400).json({ error: 'applicationId and adminUserId are required' });
    }
    adminLiveEdit.assertAdminAccess(db, aid, (eAdm, admResult) => {
        if (eAdm) return res.status(500).json({ error: eAdm.message });
        if (!admResult || !admResult.ok) {
            return res.status(403).json({ error: (admResult && admResult.error) || 'Forbidden' });
        }
        requireAdminSensitiveOtpIfEnabled(aid, adminPhoneOtpToken, adminEmailOtpToken, (eOtp, okOtp, msgOtp) => {
            if (eOtp) return res.status(500).json({ error: eOtp.message });
            if (!okOtp) return res.status(400).json({ error: msgOtp || 'Admin verification required' });
            adminLiveEdit.adminUpdateRegistrationFormData(
                db,
                {
                    validateFormDataAgainstRegistrationConfig,
                    sanitizeFormDataForStorage,
                    loadRegistrationFormConfig
                },
                { registrationId: rid, formData, adminUserId: aid },
                (eUp, result) => {
                    if (eUp) return res.status(500).json({ error: eUp.message });
                    if (!result || !result.ok) {
                        return res.status(400).json({ error: (result && result.error) || 'Update failed' });
                    }
                    db.get(
                        `SELECT user_id, seminar_id FROM registrations WHERE id = ?`,
                        [result.registrationId],
                        (eMeta, regMeta) => {
                            const payload = {
                                success: true,
                                registrationId: result.registrationId,
                                applicationNo: result.applicationNo,
                                formData: result.formData
                            };
                            if (eMeta || !regMeta) return res.json(payload);
                            volunteerTicketFlow.tryFulfillVolunteerAfterRegistration(
                                db,
                                volunteerTicketDeps(),
                                {
                                    userId: regMeta.user_id,
                                    seminarId: regMeta.seminar_id,
                                    registrationId: result.registrationId
                                },
                                (vErr, vRes) => {
                                    if (vErr) console.warn('[volunteer-ticket] admin form edit:', vErr.message);
                                    if (vRes && vRes.issued) {
                                        payload.volunteerTicketIssued = true;
                                        payload.volunteerTicketId = vRes.ticketId;
                                    }
                                    res.json(payload);
                                }
                            );
                        }
                    );
                }
            );
        });
    });
});

// Admin: edit user account (portal login identity)
app.put('/api/admin/users/:userId/account', (req, res) => {
    const uid = parseInt(req.params.userId, 10);
    const {
        firstName,
        middleName,
        lastName,
        email,
        phone,
        whatsapp,
        qualification,
        adminUserId,
        adminPhoneOtpToken,
        adminEmailOtpToken
    } = req.body || {};
    const aid = parseInt(adminUserId, 10);
    if (!Number.isInteger(uid) || uid < 1 || !Number.isInteger(aid)) {
        return res.status(400).json({ error: 'userId and adminUserId are required' });
    }
    adminLiveEdit.assertAdminAccess(db, aid, (eAdm, admResult) => {
        if (eAdm) return res.status(500).json({ error: eAdm.message });
        if (!admResult || !admResult.ok) {
            return res.status(403).json({ error: (admResult && admResult.error) || 'Forbidden' });
        }
        requireAdminSensitiveOtpIfEnabled(
            aid,
            adminPhoneOtpToken,
            adminEmailOtpToken,
            (eOtp, okOtp, msgOtp) => {
            if (eOtp) return res.status(500).json({ error: eOtp.message });
            if (!okOtp) return res.status(400).json({ error: msgOtp || 'Admin verification required' });

            const emailV = contactValidation.validateEmail(email);
            if (!emailV.valid) return res.status(400).json({ error: emailV.message });
            const phoneV = contactValidation.validatePhone(phone);
            if (!phoneV.valid) return res.status(400).json({ error: phoneV.message });

            const cleanFirst = String(firstName || '').trim();
            const cleanLast = String(lastName || '').trim();
            if (!cleanFirst || !cleanLast) {
                return res.status(400).json({ error: 'First name and last name are required.' });
            }

            db.run(
                `UPDATE users SET first_name = ?, middle_name = ?, last_name = ?, email = ?, phone = ?, whatsapp = ?, qualification = ? WHERE id = ?`,
                [
                    cleanFirst,
                    String(middleName || '').trim() || null,
                    cleanLast,
                    emailV.cleanedEmail || String(email || '').trim().toLowerCase(),
                    phoneV.cleanedPhone || String(phone || '').trim(),
                    whatsapp != null && String(whatsapp).trim()
                        ? String(whatsapp).trim()
                        : phoneV.cleanedPhone,
                    qualification != null ? String(qualification).trim() : null,
                    uid
                ],
                function (err) {
                    if (err) return res.status(500).json({ error: err.message });
                    if (this.changes === 0) return res.status(404).json({ error: 'User not found' });
                    activityLog.logFromRequest(db, req, {
                        user_id: uid,
                        action: 'admin.edit_account',
                        resource_type: 'user',
                        resource_id: String(uid),
                        meta: { adminUserId: aid }
                    });
                    res.json({ success: true, message: 'Account updated' });
                }
            );
        },
            { targetUserId: uid }
        );
    });
});

// Admin: edit doctor profile
app.put('/api/admin/users/:userId/doctor-profile', (req, res) => {
    const uid = parseInt(req.params.userId, 10);
    const {
        specialization,
        registration_no,
        qualifications,
        experience_years,
        hospital_name,
        contact_number,
        bio,
        adminUserId,
        adminPhoneOtpToken,
        adminEmailOtpToken
    } = req.body || {};
    const aid = parseInt(adminUserId, 10);
    if (!Number.isInteger(uid) || uid < 1 || !Number.isInteger(aid)) {
        return res.status(400).json({ error: 'userId and adminUserId are required' });
    }
    adminLiveEdit.assertAdminAccess(db, aid, (eAdm, admResult) => {
        if (eAdm) return res.status(500).json({ error: eAdm.message });
        if (!admResult || !admResult.ok) {
            return res.status(403).json({ error: (admResult && admResult.error) || 'Forbidden' });
        }
        requireAdminSensitiveOtpIfEnabled(aid, adminPhoneOtpToken, adminEmailOtpToken, (eOtp, okOtp, msgOtp) => {
            if (eOtp) return res.status(500).json({ error: eOtp.message });
            if (!okOtp) return res.status(400).json({ error: msgOtp || 'Admin verification required' });

            const exp = parseInt(experience_years, 10);
            const expVal = Number.isInteger(exp) && exp >= 0 ? exp : 0;
            const vals = [
                String(specialization || '').trim(),
                String(registration_no || '').trim(),
                String(qualifications || '').trim(),
                expVal,
                String(hospital_name || '').trim(),
                String(contact_number || '').trim(),
                String(bio || '').trim()
            ];

            db.get(`SELECT id FROM doctor_profile WHERE user_id = ?`, [uid], (e, row) => {
                if (e) return res.status(500).json({ error: e.message });
                const done = (err2) => {
                    if (err2) return res.status(500).json({ error: err2.message });
                    activityLog.logFromRequest(db, req, {
                        user_id: uid,
                        action: 'admin.edit_doctor_profile',
                        resource_type: 'doctor_profile',
                        resource_id: String(uid),
                        meta: { adminUserId: aid }
                    });
                    res.json({ success: true, message: 'Doctor profile updated' });
                };
                if (row) {
                    return db.run(
                        `UPDATE doctor_profile SET specialization=?, registration_no=?, qualifications=?, experience_years=?, hospital_name=?, contact_number=?, bio=?, updated_at=CURRENT_TIMESTAMP WHERE user_id=?`,
                        [...vals, uid],
                        done
                    );
                }
                db.run(
                    `INSERT INTO doctor_profile (user_id, specialization, registration_no, qualifications, experience_years, hospital_name, contact_number, bio) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [uid, ...vals],
                    done
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

app.get('/api/public/portal-flags', (req, res) => {
    db.get(
        `SELECT value FROM global_settings WHERE key = 'portal_flags'`,
        [],
        (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            let flags = {};
            try {
                flags = row && row.value ? JSON.parse(row.value) : {};
            } catch (_) {
                flags = {};
            }
            res.json({
                ncism_disable_ocr: !!(flags && flags.ncism_disable_ocr)
            });
        }
    );
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
        const out = (rows || []).map((row) => ({
            ...row,
            start_time: seminarDt.normalizeSeminarDateTimeForStorage(row.start_time) || row.start_time,
            end_time: seminarDt.normalizeSeminarDateTimeForStorage(row.end_time) || row.end_time
        }));
        res.json(out);
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
    if (sid === null) {
        return res.status(400).json({ error: 'Seminar is required for each schedule item' });
    }
    const startStored = seminarDt.fromDatetimeLocalInput(startTime) || startTime;
    const endStored = seminarDt.fromDatetimeLocalInput(endTime) || endTime;
    db.run(
        `INSERT INTO event_schedules (title, description, seminar_id, start_time, end_time, location, speaker_name, speaker_bio)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            String(title).trim(),
            description || null,
            sid,
            startStored,
            endStored,
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
    if (sid === null) {
        return res.status(400).json({ error: 'Seminar is required for each schedule item' });
    }
    const startStored = seminarDt.fromDatetimeLocalInput(startTime) || startTime;
    const endStored = seminarDt.fromDatetimeLocalInput(endTime) || endTime;
    db.run(
        `UPDATE event_schedules SET title = ?, description = ?, seminar_id = ?, start_time = ?, end_time = ?,
         location = ?, speaker_name = ?, speaker_bio = ? WHERE id = ?`,
        [
            String(title).trim(),
            description || null,
            sid,
            startStored,
            endStored,
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

const FEEDBACK_ELIGIBLE_STATUSES = new Set([
    'completed',
    'e_ticket_issued',
    'checked_in',
    'approved_pending_payment'
]);

function isFeedbackEligibleRegistration(row) {
    if (!row) return false;
    if (isSeminarEnded(row.event_date)) return true;
    const st = String(row.status || '').toLowerCase();
    return FEEDBACK_ELIGIBLE_STATUSES.has(st);
}

// Submit Seminar Feedback
app.post('/api/feedback/submit', (req, res) => {
    const { userId, seminarId, registrationId, answers } = req.body;
    const uid = parsePositiveUserId(userId);
    const sid = parseInt(seminarId, 10);
    if (!uid) return res.status(400).json({ error: 'Invalid user' });
    if (!Number.isInteger(sid) || sid < 1) return res.status(400).json({ error: 'Invalid seminar' });

    feedbackFormConfig.loadFeedbackFormConfig(db, (cfgErr, formCfg) => {
        if (cfgErr) return res.status(500).json({ error: cfgErr.message });
        const mapped = feedbackFormConfig.mapFeedbackAnswers(formCfg.fields, { answers, ...req.body });
        if (mapped.error) return res.status(400).json({ error: mapped.error });

    db.get(`SELECT id, event_date, title FROM seminars WHERE id = ?`, [sid], (err, sem) => {
            if (err) return res.status(500).json({ error: err.message });
        if (!sem) return res.status(400).json({ error: 'Seminar not found' });
        db.get(
            `SELECT id, status FROM registrations WHERE user_id = ? AND seminar_id = ? ORDER BY id DESC LIMIT 1`,
            [uid, sid],
            (regErr, reg) => {
                if (regErr) return res.status(500).json({ error: regErr.message });
                if (!reg) {
                    return res.status(400).json({
                        error: 'You must be registered for this seminar before submitting feedback.'
                    });
                }
                if (
                    !isFeedbackEligibleRegistration({
                        event_date: sem.event_date,
                        status: reg.status
                    })
                ) {
                    return res.status(400).json({
                        error:
                            'Feedback is available after the seminar ends, or once your registration is approved or completed.'
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

                        const answersJson = JSON.stringify(mapped.answersJson || {});
                        db.run(
                            `INSERT INTO seminar_feedback (user_id, seminar_id, registration_id, rating, content_quality, speaker_quality, organization_quality, overall_experience, suggestions, would_attend_again, answers_json) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                            [
                                uid,
                                sid,
                                storedRegId,
                                mapped.rating || 5,
                                mapped.contentQuality || 5,
                                mapped.speakerQuality || 5,
                                mapped.organizationQuality || 5,
                                mapped.overallExperience,
                                mapped.suggestions,
                                mapped.wouldAttendAgain ? 1 : 0,
                                answersJson
                            ],
                            function (insErr) {
                                if (insErr && /no such column|answers_json/i.test(String(insErr.message))) {
                                    return db.run(
                                        `INSERT INTO seminar_feedback (user_id, seminar_id, registration_id, rating, content_quality, speaker_quality, organization_quality, overall_experience, suggestions, would_attend_again) 
                                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                                        [
                                            uid,
                                            sid,
                                            storedRegId,
                                            mapped.rating || 5,
                                            mapped.contentQuality || 5,
                                            mapped.speakerQuality || 5,
                                            mapped.organizationQuality || 5,
                                            mapped.overallExperience,
                                            mapped.suggestions,
                                            mapped.wouldAttendAgain ? 1 : 0
                                        ],
                                        function (insErr2) {
                                            if (insErr2) return res.status(500).json({ error: insErr2.message });
                                            res.json({ success: true, id: this.lastID });
                                        }
                                    );
                                }
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
});

app.get('/api/feedback/eligible-seminars/:userId', (req, res) => {
    const uid = parsePositiveUserId(req.params.userId);
    if (!uid) return res.status(400).json({ error: 'Invalid user id' });
    db.all(
        `SELECT s.id, s.title, s.event_date, r.id AS registration_id, r.status
         FROM registrations r
         JOIN seminars s ON s.id = r.seminar_id
         WHERE r.user_id = ?
         AND LOWER(IFNULL(r.status, '')) NOT IN ('rejected', 'cancelled')
         AND NOT EXISTS (
             SELECT 1 FROM seminar_feedback sf
             WHERE sf.user_id = r.user_id AND sf.seminar_id = r.seminar_id
         )
         ORDER BY s.event_date DESC, s.id DESC`,
        [uid],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            const eligible = (rows || []).filter(isFeedbackEligibleRegistration);
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
    const sub = String(subject || '').trim();
    const msg = String(message || '').trim();
    const contactEmailV = contactValidation.validateEmail(email);
    if (!n || !sub || !msg) {
        return res.status(400).json({ error: 'Name, email, subject, and message are required.' });
    }
    if (!contactEmailV.valid) {
        return res.status(400).json({ error: contactEmailV.message });
    }
    const em = contactEmailV.cleanedEmail;
    const phoneRaw = String(phone || '').trim();
    let phoneStored = null;
    if (phoneRaw) {
        const contactPhoneV = contactValidation.validatePhone(phoneRaw, 'Phone', { required: false });
        if (!contactPhoneV.valid) {
            return res.status(400).json({ error: contactPhoneV.message });
        }
        phoneStored = contactPhoneV.cleanedPhone;
    }
    ensureContactInquiriesSchema(db, ignoreSchemaMigrationErr, () => {
        db.run(
            `INSERT INTO contact_inquiries (name, email, phone, subject, message, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'new', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [n, em, phoneStored, sub, msg],
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

app.post('/api/admin/contact-inquiries/:id/send-email', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { actingAdminId, subject, body } = req.body || {};
    const aid = parseInt(actingAdminId, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid inquiry id' });
    if (!Number.isInteger(aid) || aid < 1) return res.status(400).json({ error: 'actingAdminId is required' });
    const sub = String(subject || '').trim();
    const b = String(body || '').trim();
    if (!sub || !b) return res.status(400).json({ error: 'Subject and message are required' });
    assertAdminPortalActor(aid, async (e, adm) => {
        if (e && e.message === 'BAD_ACTOR') return res.status(400).json({ error: 'actingAdminId is required' });
        if (e && e.message === 'FORBIDDEN') return res.status(403).json({ error: 'Administrator access required' });
        if (e) return res.status(500).json({ error: e.message });
        if (!adm) return res.status(403).json({ error: 'Invalid administrator' });
        db.get(`SELECT * FROM contact_inquiries WHERE id = ?`, [id], async (e2, row) => {
            if (e2) return res.status(500).json({ error: e2.message });
            if (!row) return res.status(404).json({ error: 'Inquiry not found' });
            const replyIntro =
                'Thank you for contacting the Vaidya Gogate Memorial Foundation.\n\nRegarding your message: "' +
                String(row.subject || '').slice(0, 120) +
                '"\n\n';
            const fullBody = replyIntro + b;
            const result = await adminComposeMail.sendSingleMail({
                to: row.email,
                name: row.name,
                subject: sub,
                body: fullBody,
                replyTo: adm.email || undefined
            });
            if (!result.ok) {
                return res.status(result.skipped ? 503 : 500).json({
                    error: result.error || 'Send failed',
                    hint: result.hint || null
                });
            }
            const noteLine = '[Email sent ' + new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + '] ' + sub;
            const mergedNotes = row.admin_notes ? row.admin_notes + '\n' + noteLine : noteLine;
            db.run(
                `UPDATE contact_inquiries SET status = 'replied', admin_notes = ?, replied_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [mergedNotes, id],
                (e3) => {
                    if (e3) return res.status(500).json({ error: e3.message });
                    res.json({ success: true, message: 'Email sent to ' + row.email });
                }
            );
        });
    });
});

app.get('/api/admin/email/recipient-count', (req, res) => {
    const aid = parseInt(req.query.actingAdminId, 10);
    if (!Number.isInteger(aid) || aid < 1) {
        return res.status(400).json({ error: 'actingAdminId is required' });
    }
    assertAdminPortalActor(aid, (e) => {
        if (e && e.message === 'BAD_ACTOR') return res.status(400).json({ error: 'actingAdminId is required' });
        if (e && e.message === 'FORBIDDEN') return res.status(403).json({ error: 'Administrator access required' });
        if (e) return res.status(500).json({ error: e.message });
        const audience = String(req.query.audience || '').trim();
        const seminarId = req.query.seminarId != null ? parseInt(req.query.seminarId, 10) : null;
        const emails = req.query.emails ? String(req.query.emails).split(/[,\s;]+/) : [];
        adminComposeMail.countRecipients(db, { audience, seminarId, emails }, (err, out) => {
            if (err) return res.status(400).json({ error: err.message });
            res.json({ success: true, count: out.count });
        });
    });
});

app.post('/api/admin/email/send', (req, res) => {
    const { actingAdminId, to, name, subject, body } = req.body || {};
    const aid = parseInt(actingAdminId, 10);
    if (!Number.isInteger(aid) || aid < 1) return res.status(400).json({ error: 'actingAdminId is required' });
    assertAdminPortalActor(aid, async (e) => {
        if (e && e.message === 'BAD_ACTOR') return res.status(400).json({ error: 'actingAdminId is required' });
        if (e && e.message === 'FORBIDDEN') return res.status(403).json({ error: 'Administrator access required' });
        if (e) return res.status(500).json({ error: e.message });
        const result = await adminComposeMail.sendSingleMail({
            to,
            name,
            subject,
            body,
            audience: 'single_email'
        });
        if (!result.ok) {
            return res.status(result.skipped ? 503 : 500).json({ error: result.error || 'Send failed', hint: result.hint });
        }
        res.json({ success: true, message: 'Email sent.' });
    });
});

app.post('/api/admin/email/bulk', (req, res) => {
    const { actingAdminId, audience, seminarId, userIds, emails, subject, body } = req.body || {};
    const aid = parseInt(actingAdminId, 10);
    if (!Number.isInteger(aid) || aid < 1) return res.status(400).json({ error: 'actingAdminId is required' });
    assertAdminPortalActor(aid, (e) => {
        if (e && e.message === 'BAD_ACTOR') return res.status(400).json({ error: 'actingAdminId is required' });
        if (e && e.message === 'FORBIDDEN') return res.status(403).json({ error: 'Administrator access required' });
        if (e) return res.status(500).json({ error: e.message });
        adminComposeMail.resolveRecipients(
            db,
            {
                audience: audience || 'custom_emails',
                seminarId: seminarId != null ? parseInt(seminarId, 10) : null,
                userIds: Array.isArray(userIds) ? userIds : [],
                emails: Array.isArray(emails) ? emails : String(emails || '').split(/[,\s;]+/)
            },
            (err, recipients) => {
                if (err) return res.status(400).json({ error: err.message });
                if (!recipients.length) {
                    return res.json({ success: true, queued: 0, total: 0, message: 'No recipients with valid email.' });
                }
                adminComposeMail.sendBulkMail(db, { recipients, subject, body, useQueue: true }, (err2, out) => {
                    if (err2) return res.status(500).json({ error: err2.message });
                    res.json({
                        success: true,
                        queued: out.queued,
                        failed: out.failed,
                        total: out.total,
                        message: 'Queued ' + out.queued + ' email(s). Delivery runs within about a minute.'
                    });
                });
            }
        );
    });
});

// ==================== SUPPORT TICKET ENDPOINTS ====================

/** Resolve portal user ID (12-digit), USR_… string, email, or small internal users.id. */
function resolveDoctorUserRef(raw, cb) {
    const s = String(raw || '').trim();
    if (!s) return cb(new Error('Doctor user identifier is required'));

    const finish = (e, row) => {
        if (e) return cb(e);
        if (!row) return cb(new Error('No doctor account found for that identifier.'));
        const role = String(row.user_role || row.role || '').toLowerCase();
        if (role && role !== 'doctor' && role !== 'judge_user') {
            return cb(new Error('That account is not a doctor portal user (role: ' + role + ').'));
        }
        if (Number(row.is_disabled) === 1) {
            return cb(new Error('That doctor account is disabled.'));
        }
        cb(null, row);
    };

    const selectCols = `id, user_id_string, first_name, middle_name, last_name, email, phone, role, user_role, IFNULL(is_disabled, 0) AS is_disabled`;

    if (s.includes('@')) {
        return db.get(
            `SELECT ${selectCols} FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM(?)) LIMIT 1`,
            [s],
            finish
        );
    }

    const digitsOnly = s.replace(/\D/g, '');
    const looksLikePortalId = digitsOnly.length >= 10 || /^USR_/i.test(s);
    if (looksLikePortalId) {
        const portalId = /^USR_/i.test(s) ? s : digitsOnly;
        return db.get(
            `SELECT ${selectCols} FROM users
             WHERE TRIM(user_id_string) = TRIM(?)
                OR TRIM(user_id_string) = TRIM(?)
             LIMIT 1`,
            [portalId, s],
            finish
        );
    }

    const asInt = parseInt(s, 10);
    const normalizedNum = s.replace(/^0+/, '') || '0';
    const isInternalId =
        !Number.isNaN(asInt) &&
        asInt >= 1 &&
        asInt <= PG_INT_MAX &&
        (String(asInt) === normalizedNum || String(asInt) === s);
    if (isInternalId) {
        return db.get(`SELECT ${selectCols} FROM users WHERE id = ? LIMIT 1`, [asInt], (e, row) => {
            if (e) return cb(e);
            if (row) return finish(null, row);
            db.get(
                `SELECT ${selectCols} FROM users WHERE TRIM(user_id_string) = TRIM(?) LIMIT 1`,
                [s],
                finish
            );
        });
    }

    return cb(
        new Error(
            'Enter the doctor 12-digit portal user ID (shown in admin user list), or the small internal account number — not the portal ID in the numeric-only field.'
        )
    );
}

function doctorSupportTicketLookupPayload(userRow, cb) {
    const uid = userRow.id;
    db.all(
        `SELECT r.id AS registration_id, r.application_no, r.status, s.title AS seminar_title, s.event_date
         FROM registrations r
         LEFT JOIN seminars s ON s.id = r.seminar_id
         WHERE r.user_id = ?
         ORDER BY r.id DESC
         LIMIT 8`,
        [uid],
        (e, regs) => {
            if (e) return cb(e);
            const name = [userRow.first_name, userRow.middle_name, userRow.last_name].filter(Boolean).join(' ').trim();
            cb(null, {
                id: uid,
                userIdString: userRow.user_id_string || '',
                name,
                email: userRow.email || '',
                phone: userRow.phone || '',
                role: userRow.user_role || userRow.role || 'doctor',
                registrations: (regs || []).map((r) => ({
                    registrationId: r.registration_id,
                    applicationNo: r.application_no,
                    status: r.status,
                    seminarTitle: r.seminar_title,
                    eventDate: r.event_date
                }))
            });
        }
    );
}

const SUPPORT_TICKET_LIST_COLS = `st.id, st.user_id, st.category, st.subject, st.description, st.priority, st.status,
    st.attachment_path, st.created_at, st.updated_at, st.expected_response_at, st.assigned_to_admin,
    st.ticket_id AS ticket_id_raw, st.tracking_id,
    COALESCE(NULLIF(TRIM(st.ticket_id), ''), NULLIF(TRIM(st.tracking_id), '')) AS ticket_id`;

function resolveSupportTicketByRef(ticketRef, cb) {
    const ref = String(ticketRef || '').trim();
    if (!ref) return cb(new Error('Ticket id required'));
    db.get(
        `SELECT st.id, st.ticket_id, st.tracking_id, st.user_id, st.category, st.subject, st.description,
                st.priority, st.status, st.expected_response_at, st.created_at, st.updated_at, st.attachment_path,
                u.first_name, u.last_name, u.email
         FROM support_tickets st
         LEFT JOIN users u ON st.user_id = u.id
         WHERE TRIM(COALESCE(st.ticket_id, '')) = TRIM(?)
            OR TRIM(COALESCE(st.tracking_id, '')) = TRIM(?)
            OR CAST(st.id AS TEXT) = TRIM(?)`,
        [ref, ref, ref],
        cb
    );
}

function canonicalTicketMessageId(ticketRow) {
    if (!ticketRow) return '';
    const tid = ticketRow.ticket_id && String(ticketRow.ticket_id).trim();
    if (tid) return tid;
    const trk = ticketRow.tracking_id && String(ticketRow.tracking_id).trim();
    return trk || '';
}

function fetchTicketMessages(ticketRow, cb) {
    const ids = [];
    const canonical = canonicalTicketMessageId(ticketRow);
    if (canonical) ids.push(canonical);
    const rawTid = ticketRow.ticket_id && String(ticketRow.ticket_id).trim();
    const rawTrk = ticketRow.tracking_id && String(ticketRow.tracking_id).trim();
    if (rawTid && !ids.includes(rawTid)) ids.push(rawTid);
    if (rawTrk && !ids.includes(rawTrk)) ids.push(rawTrk);

    const loadNewMessages = (next) => {
        if (!ids.length) return next(null, []);
        const ph = ids.map(() => '?').join(',');
        db.all(
            `SELECT tm.id, tm.ticket_id, tm.sender_id, tm.sender_type, tm.message, tm.attachment_path, tm.created_at,
                    tm.source, u.first_name, u.last_name
             FROM ticket_messages tm
             LEFT JOIN users u ON tm.sender_id = u.id
             WHERE tm.ticket_id IN (${ph})
             ORDER BY tm.created_at ASC`,
            ids,
            (err, rows) => next(err, rows || [])
        );
    };

    const loadLegacyMessages = (next) => {
        if (!ticketRow.id) return next(null, []);
        db.all(
            `SELECT sm.id, sm.sender, sm.message, sm.created_at
             FROM support_messages sm
             WHERE sm.ticket_id = ?
             ORDER BY sm.created_at ASC`,
            [ticketRow.id],
            (err, rows) => {
                if (err && /does not exist|relation/i.test(String(err.message || ''))) {
                    return next(null, []);
                }
                if (err) return next(err);
                const mapped = (rows || []).map((m) => ({
                    id: 'legacy_' + m.id,
                    message: m.message,
                    created_at: m.created_at,
                    sender_type: String(m.sender || '').toLowerCase() === 'admin' ? 'admin' : 'user',
                    first_name: String(m.sender || '').toLowerCase() === 'admin' ? 'Admin' : '',
                    last_name: ''
                }));
                next(null, mapped);
            }
        );
    };

    loadNewMessages((e1, newMsgs) => {
        if (e1) return cb(e1);
        loadLegacyMessages((e2, legacyMsgs) => {
            if (e2) return cb(e2);
            const all = [...(newMsgs || []), ...(legacyMsgs || [])];
            all.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
            if (!all.length && ticketRow.description) {
                all.push({
                    id: 'initial_description',
                    message: ticketRow.description,
                    created_at: ticketRow.created_at,
                    sender_type: 'user',
                    first_name: ticketRow.first_name || 'Doctor',
                    last_name: ticketRow.last_name || ''
                });
            }
            cb(null, all);
        });
    });
}

function getSupportTicketPayload(ticketRef, cb) {
    resolveSupportTicketByRef(ticketRef, (err, ticket) => {
        if (err) return cb(err);
        if (!ticket) return cb(null, null);
        fetchTicketMessages(ticket, (e2, messages) => {
            if (e2) return cb(e2);
            const tid = canonicalTicketMessageId(ticket);
            cb(null, Object.assign({}, ticket, { ticket_id: tid, messages: messages || [] }));
        });
    });
}

function createSupportTicketRecord(opts, cb) {
    const uid = parseInt(opts.userId, 10);
    if (Number.isNaN(uid) || uid < 1 || uid > PG_INT_MAX) return cb(new Error('Invalid user'));
    const subject = opts.subject && String(opts.subject).trim();
    const description = opts.description && String(opts.description).trim();
    if (!subject) return cb(new Error('Subject is required'));
    if (!description) return cb(new Error('Description is required'));
    const ticketId = 'TKT_' + generateId();
    const cat = opts.category || 'general';
    const senderType = opts.senderType || 'user';
    const senderId = parseInt(opts.senderId, 10) || uid;

    const runInsert = (slaMeta) => {
        const expectedAt = slaMeta && slaMeta.iso ? slaMeta.iso : null;
        db.run(
            `INSERT INTO support_tickets (ticket_id, tracking_id, user_id, category, subject, description, attachment_path, priority, status, expected_response_at, created_at, updated_at) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [ticketId, ticketId, uid, cat, subject, description, opts.attachment_path || null, opts.priority || 'medium', expectedAt],
            function (err) {
                if (err) return cb(err);
                db.run(
                    `INSERT INTO ticket_messages (ticket_id, sender_id, sender_type, message) VALUES (?, ?, ?, ?)`,
                    [ticketId, senderId, senderType, description],
                    function (err2) {
                        if (err2) return cb(err2);
                        supportTicketNotify.notifySupportTicketCreated(db, ticketId, (nErr) => {
                            if (nErr) console.warn('[support-ticket] create notify:', nErr.message);
                            cb(null, {
                                ticketId,
                                userId: uid,
                                expectedResponseAt: expectedAt,
                                expectedResponseHours: slaMeta && slaMeta.hours,
                                expectedResponseDisplay: supportTicketSla.formatExpectedDisplay(expectedAt)
                            });
                        });
                    }
                );
            }
        );
    };

    const afterSla = (slaMeta) => {
        if (pgDb && pgDb.ensureAuxiliaryTables) {
            return pgDb.ensureAuxiliaryTables().then(() => runInsert(slaMeta)).catch((e) => cb(e));
        }
        ensureSupportTicketSchema(db, ignoreSchemaMigrationErr, () => runInsert(slaMeta));
    };
    supportTicketSla.loadConfig(db, (slaErr) => {
        if (slaErr) console.warn('[support-ticket-sla]', slaErr.message);
        afterSla(supportTicketSla.computeExpectedResponseAt(cat));
    });
}

app.use('/api/support-ticket', withSupportTickets);
app.use('/api/admin/support-ticket', withSupportTickets);
app.use('/api/admin/support-tickets', withSupportTickets);

// Create Support Ticket (doctor portal)
app.post('/api/support-ticket/create', (req, res) => {
    const { userId, category, subject, description, attachment_path } = req.body;
    createSupportTicketRecord(
        { userId, category, subject, description, attachment_path, senderType: 'user', senderId: userId },
        (err, out) => {
            if (err) {
                console.error('[support-ticket/create]', err.message);
                return res.status(500).json({ error: err.message || 'Could not create ticket. Please try again.' });
            }
            res.json({
                success: true,
                ticketId: out.ticketId,
                id: out.ticketId,
                expectedResponseAt: out.expectedResponseAt,
                expectedResponseHours: out.expectedResponseHours,
                expectedResponseDisplay: out.expectedResponseDisplay
            });
        }
    );
});

// Admin: look up doctor before creating a support ticket (portal ID or internal id)
app.get('/api/admin/support-ticket/doctor-lookup', (req, res) => {
    const actingAdminId = parseInt(req.query.actingAdminId, 10);
    const q = String(req.query.q || '').trim();
    if (!Number.isInteger(actingAdminId) || actingAdminId < 1) {
        return res.status(400).json({ error: 'actingAdminId is required' });
    }
    if (!q) return res.status(400).json({ error: 'q is required (portal user ID, email, or internal account number)' });
    assertAdminPortalActor(actingAdminId, (eAct) => {
        if (eAct) return res.status(eAct.message === 'FORBIDDEN' ? 403 : 500).json({ error: 'Admin access required' });
        resolveDoctorUserRef(q, (e, row) => {
            if (e) return res.status(400).json({ error: e.message });
            doctorSupportTicketLookupPayload(row, (e2, doctor) => {
                if (e2) return res.status(500).json({ error: e2.message });
                res.json({ success: true, doctor });
            });
        });
    });
});

// Admin: create support ticket on behalf of a doctor
app.post('/api/admin/support-ticket/create', (req, res) => {
    const body = req.body || {};
    const actingAdminId = parseInt(body.actingAdminId, 10);
    const targetRef =
        body.targetUserRef != null
            ? String(body.targetUserRef).trim()
            : body.targetUserId != null
              ? String(body.targetUserId).trim()
              : '';
    if (!Number.isInteger(actingAdminId) || actingAdminId < 1) {
        return res.status(400).json({ error: 'actingAdminId is required' });
    }
    if (!targetRef) {
        return res.status(400).json({ error: 'Doctor portal user ID or account reference is required' });
    }
    assertAdminPortalActor(actingAdminId, (eAct) => {
        if (eAct) return res.status(eAct.message === 'FORBIDDEN' ? 403 : 500).json({ error: 'Admin access required' });
        resolveDoctorUserRef(targetRef, (eU, doc) => {
            if (eU) return res.status(400).json({ error: eU.message });
            const targetUserId = doc.id;
            createSupportTicketRecord(
                {
                    userId: targetUserId,
                    category: body.category,
                    subject: body.subject,
                    description: body.description,
                    attachment_path: body.attachment_path,
                    senderType: 'admin',
                    senderId: actingAdminId
                },
                (err, out) => {
                    if (err) {
                        console.error('[admin/support-ticket/create]', err.message);
                        return res.status(500).json({ error: err.message || 'Could not create ticket' });
                    }
                    activityLog.logActivity(db, {
                        user_id: actingAdminId,
                        action: 'support_ticket.create',
                        resource_type: 'support_ticket',
                        resource_id: out.ticketId,
                        meta: { targetUserId, targetUserRef: doc.user_id_string || targetRef }
                    });
                    res.json({
                        success: true,
                        ticketId: out.ticketId,
                        doctor: {
                            id: targetUserId,
                            userIdString: doc.user_id_string
                        }
                    });
                }
            );
        });
    });
});

// Get User's Support Tickets
app.get('/api/support-ticket/user/:userId', (req, res) => {
    const { userId } = req.params;
    db.all(
        `SELECT ${SUPPORT_TICKET_LIST_COLS} FROM support_tickets st WHERE st.user_id = ? ORDER BY st.created_at DESC`,
        [userId],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        }
    );
});

// Get Ticket Details with Messages
app.get('/api/support-ticket/:ticketId', (req, res) => {
    getSupportTicketPayload(req.params.ticketId, (err, payload) => {
        if (err) {
            console.error('[support-ticket/get]', err.message);
            return res.status(500).json({ error: err.message });
        }
        if (!payload) return res.status(404).json({ error: 'Ticket not found' });
        res.json(payload);
    });
});

// Add Reply to Support Ticket
app.post('/api/support-ticket/:ticketId/reply', (req, res) => {
    const { ticketId } = req.params;
    const { senderId, senderType, message, attachment_path } = req.body;
    const msg = message && String(message).trim();
    if (!msg) return res.status(400).json({ error: 'Message is required' });

    resolveSupportTicketByRef(ticketId, (err, ticket) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
        const canonical = canonicalTicketMessageId(ticket);

        db.run(
            `INSERT INTO ticket_messages (ticket_id, sender_id, sender_type, message, attachment_path) 
            VALUES (?, ?, ?, ?, ?)`,
            [canonical, senderId, senderType, msg, attachment_path || null],
            function (err2) {
                if (err2) return res.status(500).json({ error: err2.message });
                const messageId = this.lastID;

                db.run(
                    `UPDATE support_tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                    [ticket.id],
                    () => {
                        supportTicketNotify.notifySupportTicketReply(
                            db,
                            canonical,
                            senderType,
                            msg,
                            (nErr) => {
                                if (nErr) console.warn('[support-ticket] reply notify:', nErr.message);
                                flushNotificationQueue();
                                res.json({ success: true, messageId });
                            }
                        );
                    }
                );
            }
        );
    });
});

// ==================== ADMIN E-TICKETS (lookup / generate / send) ====================

const ADMIN_ETICKET_LOOKUP_SQL = `
        SELECT r.id AS registration_id, r.application_no, r.status AS registration_status,
               u.id AS user_id, u.first_name, u.last_name, u.email, u.phone,
               s.id AS seminar_id, s.title AS seminar_title, s.price AS seminar_price,
               o.id AS order_db_id, o.order_id_string, o.status AS payment_status, o.payment_date,
               t.id AS ticket_row_id, t.ticket_id_string, t.is_scanned, IFNULL(t.scan_count, 0) AS scan_count,
               t.scan_time, IFNULL(t.is_valid, 1) AS is_valid, t.qr_code_data
        FROM registrations r
        JOIN users u ON u.id = r.user_id
        JOIN seminars s ON s.id = r.seminar_id
        LEFT JOIN orders o ON o.registration_id = r.id AND LOWER(TRIM(o.status)) = 'success'
        LEFT JOIN tickets t ON t.order_id = o.id`;

function adminLookupEtickets(db, q, cb) {
    const raw = String(q || '').trim();
    if (!raw) return cb(null, []);
    const clauses = [
        'TRIM(r.application_no) = TRIM(?)',
        'TRIM(t.ticket_id_string) = TRIM(?)'
    ];
    const params = [raw, raw];
    if (raw.includes('@')) {
        clauses.push('LOWER(TRIM(u.email)) = LOWER(TRIM(?))');
        params.push(raw);
    }
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 10) {
        const tail = digits.slice(-10);
        clauses.push(
            `REPLACE(REPLACE(REPLACE(REPLACE(u.phone,' ',''),'-',''),'+',''),'.','') LIKE ?`
        );
        params.push('%' + tail + '%');
    }
    db.all(
        `${ADMIN_ETICKET_LOOKUP_SQL} WHERE (${clauses.join(' OR ')}) ORDER BY r.id DESC, t.id DESC LIMIT 25`,
        params,
        cb
    );
}

app.get('/api/admin/e-tickets/lookup', (req, res) => {
    const q = String(req.query.q || '').trim();
    const actingAdminId = parseInt(req.query.actingAdminId, 10);
    if (!q) return res.status(400).json({ error: 'q is required (ticket ID, application ID, email, or phone)' });
    assertAdminPortalActor(actingAdminId, (eAct) => {
        if (eAct) return res.status(eAct.message === 'FORBIDDEN' ? 403 : 500).json({ error: 'Admin access required' });
        adminLookupEtickets(db, q, (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            const base = notifEngine.publicBaseUrl();
            const list = (rows || []).map((row) => ({
                registrationId: row.registration_id,
                applicationNo: row.application_no,
                registrationStatus: row.registration_status,
                userId: row.user_id,
                doctorName: [row.first_name, row.last_name].filter(Boolean).join(' ').trim(),
                email: row.email,
                phone: row.phone,
                seminarId: row.seminar_id,
                seminarTitle: row.seminar_title,
                paymentStatus: row.payment_status,
                orderIdString: row.order_id_string,
                ticketIdString: row.ticket_id_string,
                ticketRowId: row.ticket_row_id,
                isScanned: !!Number(row.is_scanned),
                scanCount: Number(row.scan_count) || 0,
                scanTime: row.scan_time,
                isValid: row.is_valid !== 0 && row.is_valid !== false,
                hasTicket: !!row.ticket_id_string,
                ticketPreviewUrl:
                    row.ticket_id_string && row.user_id
                        ? `${base}/api/doctor/ticket-document/${encodeURIComponent(row.ticket_id_string)}?userId=${encodeURIComponent(String(row.user_id))}`
                        : null
            }));
            res.json({ success: true, results: list });
        });
    });
});

app.post('/api/admin/e-tickets/generate', (req, res) => {
    const registrationId = parseInt((req.body && req.body.registrationId) || '', 10);
    const actingAdminId = parseInt((req.body && req.body.actingAdminId) || '', 10);
    if (!Number.isInteger(registrationId) || registrationId < 1) {
        return res.status(400).json({ error: 'registrationId is required' });
    }
    assertAdminPortalActor(actingAdminId, (eAct) => {
        if (eAct) return res.status(eAct.message === 'FORBIDDEN' ? 403 : 500).json({ error: 'Admin access required' });
        db.get(
            `SELECT r.id, s.price FROM registrations r JOIN seminars s ON s.id = r.seminar_id WHERE r.id = ?`,
            [registrationId],
            (eReg, reg) => {
                if (eReg) return res.status(500).json({ error: eReg.message });
                if (!reg) return res.status(404).json({ error: 'Registration not found' });
                ensureParticipantTicketForRegistration(
                    registrationId,
                    { createOrderIfMissing: true, amount: Number(reg.price) || 0 },
                    (err, out) => {
                        if (err) return res.status(500).json({ error: err.message });
                        if (out && out.skipped) {
                            return res.status(400).json({
                                error: 'Cannot issue e-ticket for a rejected or cancelled registration.'
                            });
                        }
                        if (out && out.reason === 'no_order' && !out.ticketId) {
                            return res.status(400).json({
                                error: 'No successful payment order found. Use Payments → waive/issue or confirm payment first.'
                            });
                        }
                        const afterGenerate = () => {
                            activityLog.logActivity(db, {
                                user_id: actingAdminId,
                                action: 'eticket.generate',
                                resource_type: 'registration',
                                resource_id: String(registrationId),
                                meta: { ticketId: out && out.ticketId }
                            });
                            res.json({
                                success: true,
                                registrationId,
                                ticketId: (out && out.ticketId) || null,
                                orderIdString: (out && out.orderIdString) || null,
                                message: out && out.ticketId ? 'E-ticket generated or refreshed.' : 'No ticket was created.'
                            });
                        };
                        const afterTicketRow = () => {
                            if (out && out.ticketId) {
                                db.run(
                                    `UPDATE registrations SET status = 'e_ticket_issued'
                                     WHERE id = ? AND IFNULL(status,'') NOT IN ('checked_in','completed','certificate_issued','cancelled','rejected')`,
                                    [registrationId],
                                    () => afterGenerate()
                                );
                            } else {
                                afterGenerate();
                            }
                        };
                        if (out && out.ticketId) {
                            db.get(
                                `SELECT t.id, t.ticket_id_string, t.qr_code_data, o.order_id_string, o.id AS order_db_id,
                                        r.application_no, r.user_id
                                 FROM tickets t
                                 JOIN orders o ON o.id = t.order_id
                                 JOIN registrations r ON r.id = o.registration_id
                                 WHERE r.id = ?
                                 ORDER BY t.id DESC LIMIT 1`,
                                [registrationId],
                                (eTix, tixRow) => {
                                    if (
                                        eTix ||
                                        !tixRow ||
                                        (tixRow.ticket_id_string && String(tixRow.ticket_id_string).trim())
                                    ) {
                                        return afterTicketRow();
                                    }
                                    ensureTicketIdString(
                                        tixRow.id,
                                        tixRow.order_id_string,
                                        registrationId,
                                        tixRow.application_no,
                                        tixRow.user_id,
                                        tixRow.order_db_id,
                                        tixRow.qr_code_data,
                                        () => afterTicketRow()
                                    );
                                }
                            );
                        } else {
                            afterGenerate();
                        }
                    }
                );
            }
        );
    });
});

app.post('/api/admin/e-tickets/send', (req, res) => {
    const registrationId = parseInt((req.body && req.body.registrationId) || '', 10);
    const ticketIdString = String((req.body && req.body.ticketIdString) || '').trim();
    const sendEmail = !!(req.body && req.body.sendEmail);
    const sendWhatsapp = !!(req.body && req.body.sendWhatsapp);
    const actingAdminId = parseInt((req.body && req.body.actingAdminId) || '', 10);
    if (!sendEmail && !sendWhatsapp) {
        return res.status(400).json({ error: 'Select at least one channel: email or WhatsApp' });
    }
    if (!Number.isInteger(registrationId) || registrationId < 1) {
        return res.status(400).json({ error: 'registrationId is required' });
    }
    assertAdminPortalActor(actingAdminId, (eAct) => {
        if (eAct) return res.status(eAct.message === 'FORBIDDEN' ? 403 : 500).json({ error: 'Admin access required' });
        const finishSend = (userId, regId, ticketId) => {
            if (!ticketId) {
                return res.status(400).json({ error: 'No e-ticket ID on file. Click Generate ticket first.' });
            }
            notifyTicketIssued(userId, regId, ticketId, {
                email: sendEmail,
                whatsapp: sendWhatsapp,
                templateNotify: sendEmail || sendWhatsapp
            });
            flushNotificationQueue();
            activityLog.logActivity(db, {
                user_id: actingAdminId,
                action: 'eticket.send',
                resource_type: 'registration',
                resource_id: String(regId),
                meta: { ticketId, sendEmail, sendWhatsapp }
            });
            const parts = [];
            if (sendEmail) parts.push('email');
            if (sendWhatsapp) parts.push('WhatsApp');
            res.json({
                success: true,
                message: 'E-ticket sent via ' + parts.join(' and ') + '.',
                ticketId
            });
        };
        if (ticketIdString) {
            db.get(
                `SELECT r.id AS registration_id, r.user_id, t.ticket_id_string
                 FROM tickets t
                 JOIN orders o ON o.id = t.order_id
                 JOIN registrations r ON r.id = o.registration_id
                 WHERE TRIM(t.ticket_id_string) = TRIM(?) AND r.id = ?`,
                [ticketIdString, registrationId],
                (e, row) => {
                    if (e) return res.status(500).json({ error: e.message });
                    if (!row) return res.status(404).json({ error: 'Ticket not found for this registration' });
                    finishSend(row.user_id, row.registration_id, row.ticket_id_string);
                }
            );
            return;
        }
        db.get(
            `SELECT r.user_id, t.ticket_id_string
             FROM registrations r
             LEFT JOIN orders o ON o.registration_id = r.id AND LOWER(TRIM(o.status)) = 'success'
             LEFT JOIN tickets t ON t.order_id = o.id
             WHERE r.id = ?
             ORDER BY t.id DESC
             LIMIT 1`,
            [registrationId],
            (e, row) => {
                if (e) return res.status(500).json({ error: e.message });
                if (!row) return res.status(404).json({ error: 'Registration not found' });
                finishSend(row.user_id, registrationId, row.ticket_id_string);
            }
        );
    });
});

// Admin: Get All Support Tickets
app.get('/api/admin/support-tickets', (req, res) => {
    const { status, category, priority } = req.query;
    let query = `SELECT ${SUPPORT_TICKET_LIST_COLS},
                        u.first_name, u.last_name, u.email FROM support_tickets st 
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
    if (!status) return res.status(400).json({ error: 'status is required' });

    resolveSupportTicketByRef(ticketId, (err, ticket) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
        const oldStatus = ticket.status;
        const canonical = canonicalTicketMessageId(ticket);

        db.run(
            `UPDATE support_tickets SET status = ?, assigned_to_admin = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [status, adminId || null, ticket.id],
            function (updErr) {
                if (updErr) return res.status(500).json({ error: updErr.message });
                supportTicketNotify.notifySupportTicketStatusChange(
                    db,
                    canonical,
                    oldStatus,
                    status,
                    (nErr) => {
                        if (nErr) console.warn('[support-ticket] status notify:', nErr.message);
                        flushNotificationQueue();
                        res.json({ success: true });
                    }
                );
            }
        );
    });
});

// Admin: Update Ticket Priority
app.put('/api/admin/support-ticket/:ticketId/priority', (req, res) => {
    const { ticketId } = req.params;
    const { priority } = req.body;
    if (!priority) return res.status(400).json({ error: 'priority is required' });

    resolveSupportTicketByRef(ticketId, (err, ticket) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
        const oldPriority = ticket.priority;
        const canonical = canonicalTicketMessageId(ticket);

        db.run(
            `UPDATE support_tickets SET priority = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [priority, ticket.id],
            function (updErr) {
                if (updErr) return res.status(500).json({ error: updErr.message });
                supportTicketNotify.notifySupportTicketPriorityChange(
                    db,
                    canonical,
                    oldPriority,
                    priority,
                    (nErr) => {
                        if (nErr) console.warn('[support-ticket] priority notify:', nErr.message);
                        flushNotificationQueue();
                        res.json({ success: true });
                    }
                );
            }
        );
    });
});

/** Resolve any portal user (doctor, judge, admin, etc.) by portal ID, email, or internal id. */
function resolvePortalUserRef(raw, cb) {
    const s = String(raw || '').trim();
    if (!s) return cb(new Error('User identifier is required'));

    const finish = (e, row) => {
        if (e) return cb(e);
        if (!row) return cb(new Error('No account found for that identifier.'));
        if (Number(row.is_disabled) === 1) return cb(new Error('That account is disabled.'));
        cb(null, row);
    };

    const selectCols = `id, user_id_string, first_name, middle_name, last_name, email, phone, role, user_role, IFNULL(is_disabled, 0) AS is_disabled`;

    if (s.includes('@')) {
        return db.get(
            `SELECT ${selectCols} FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM(?)) LIMIT 1`,
            [s],
            finish
        );
    }

    const digitsOnly = s.replace(/\D/g, '');
    const looksLikePortalId = digitsOnly.length >= 10 || /^USR_/i.test(s);
    if (looksLikePortalId) {
        const portalId = /^USR_/i.test(s) ? s : digitsOnly;
        return db.get(
            `SELECT ${selectCols} FROM users
             WHERE TRIM(user_id_string) = TRIM(?) OR TRIM(user_id_string) = TRIM(?)
             LIMIT 1`,
            [portalId, s],
            finish
        );
    }

    const asInt = parseInt(s, 10);
    if (Number.isInteger(asInt) && asInt > 0 && /^\d+$/.test(s)) {
        return db.get(`SELECT ${selectCols} FROM users WHERE id = ? LIMIT 1`, [asInt], finish);
    }

    return cb(new Error('Could not parse user identifier. Use portal user ID, email, or internal account number.'));
}

// Admin: transfer support ticket to another user account
app.put('/api/admin/support-ticket/:ticketId/transfer', (req, res) => {
    const { ticketId } = req.params;
    const body = req.body || {};
    const actingAdminId = parseInt(body.actingAdminId, 10);
    const targetRef =
        body.targetUserRef != null
            ? String(body.targetUserRef).trim()
            : body.targetUserId != null
              ? String(body.targetUserId).trim()
              : '';
    if (!targetRef) return res.status(400).json({ error: 'Target user ID is required' });

    assertAdminPortalActor(actingAdminId, (eAct) => {
        if (eAct) return res.status(eAct.message === 'FORBIDDEN' ? 403 : 500).json({ error: 'Admin access required' });
        resolveSupportTicketByRef(ticketId, (err, ticket) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
            resolvePortalUserRef(targetRef, (eU, targetUser) => {
                if (eU) return res.status(400).json({ error: eU.message });
                const oldUserId = ticket.user_id;
                const canonical = canonicalTicketMessageId(ticket);
                if (oldUserId === targetUser.id) {
                    return res.status(400).json({ error: 'Ticket already belongs to that user' });
                }

                db.run(
                    `UPDATE support_tickets SET user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                    [targetUser.id, ticket.id],
                    (updErr) => {
                        if (updErr) return res.status(500).json({ error: updErr.message });
                        const note =
                            'Ticket transferred to account ' +
                            (targetUser.user_id_string || targetUser.id) +
                            ' by admin.';
                        db.run(
                            `INSERT INTO ticket_messages (ticket_id, sender_id, sender_type, message) VALUES (?, ?, ?, ?)`,
                            [canonical, actingAdminId || 0, 'admin', note],
                            () => {
                                supportTicketNotify.notifySupportTicketTransferred(
                                    db,
                                    canonical,
                                    oldUserId,
                                    targetUser,
                                    (nErr) => {
                                        if (nErr) console.warn('[support-ticket] transfer notify:', nErr.message);
                                        flushNotificationQueue();
                                        res.json({
                                            success: true,
                                            userId: targetUser.id,
                                            userIdString: targetUser.user_id_string
                                        });
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
    } else if (process.env.VERCEL) {
        setInterval(() => {
            try {
                notifEngine.processQueueOnce(db);
            } catch (e) {
                console.warn('[notifications] queue tick', e.message);
            }
        }, 8000);
    }
}

function flushNotificationQueue() {
    try {
        if (notifEngine.drainNotificationQueue) {
            notifEngine.drainNotificationQueue(db, 1).catch((e) => {
                console.warn('[notifications] drain', e.message);
            });
        } else {
            notifEngine.processQueueOnce(db);
        }
    } catch (e) {
        console.warn('[notifications] flush', e.message);
    }
}

function authorizeCron(req, res) {
    const secret = process.env.CRON_SECRET;
    if (secret) {
        const auth = req.headers.authorization || '';
        if (auth !== `Bearer ${secret}`) {
            res.status(401).json({ error: 'Unauthorized' });
            return false;
        }
    }
    return true;
}

app.get('/api/cron/process-notifications', (req, res) => {
    if (!authorizeCron(req, res)) return;
    const run = () => {
        if (!notifEngine.drainNotificationQueue) {
            notifEngine.processQueueOnce(db);
            return res.json({ ok: true, mode: 'once' });
        }
        notifEngine
            .drainNotificationQueue(db, 12)
            .then(() => res.json({ ok: true, mode: 'drain' }))
            .catch((e) => res.status(500).json({ error: e.message }));
    };
    if (appReadyResolved) return run();
    if (appReadyPromise) {
        return appReadyPromise.then(run).catch((e) => res.status(503).json({ error: e.message }));
    }
    run();
});

app.get('/api/cron/pending-registration-reminders', (req, res) => {
    if (!authorizeCron(req, res)) return;
    const run = () => {
        pendingRegReminders.runPendingRegistrationReminders(db, (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ok: true, ...(result || {}) });
        });
    };
    if (appReadyResolved) return run();
    if (appReadyPromise) {
        return appReadyPromise.then(run).catch((e) => res.status(503).json({ error: e.message }));
    }
    run();
});

app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    console.error('[express] unhandled error:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'Internal server error' });
});

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
