/**
 * Daily platform-wide data export — registrations, payments, users, cases, tickets, support.
 * Uploads to Cloudflare R2 and/or Google Drive (service account).
 */
const XLSX = require('xlsx');
const r2Storage = require('./r2-storage');
const googleDrive = require('./google-drive-upload');
const { flattenRow } = require('./export-reports');

const CONFIG_KEY = 'platform_backup_config';
const LOG_KEY = 'platform_backup_last_run';

const DEFAULT_CONFIG = {
    enabled: false,
    cron: '0 2 * * *',
    destination: 'r2',
    googleDriveFolderId: '',
    googleServiceAccountJson: '',
    notifyEmails: [],
    includeUserEmails: true
};

const EXPORT_QUERIES = [
    {
        sheet: 'registrations',
        sql: `SELECT r.id, r.application_no, r.status, r.seminar_id, r.user_id, r.form_data, r.doc_review_json,
              r.created_at, r.updated_at, r.registration_source, s.title AS seminar_title
              FROM registrations r LEFT JOIN seminars s ON s.id = r.seminar_id ORDER BY r.id DESC`
    },
    {
        sheet: 'orders',
        sql: `SELECT o.id, o.order_id_string, o.registration_id, o.amount, o.status, o.payment_date,
              o.payment_gateway, o.payment_method, o.transaction_id, o.created_at, o.refunded_amount,
              r.application_no, r.seminar_id, s.title AS seminar_title
              FROM orders o
              LEFT JOIN registrations r ON r.id = o.registration_id
              LEFT JOIN seminars s ON s.id = r.seminar_id
              ORDER BY o.id DESC`
    },
    {
        sheet: 'users',
        sql: `SELECT id, user_id_string, first_name, middle_name, last_name, email, phone, role, account_status,
              created_at, updated_at FROM users ORDER BY id DESC`
    },
    {
        sheet: 'seminars',
        sql: `SELECT id, title, event_date, registration_start, registration_end, capacity, price, portal_year,
              is_active, waiting_list_enabled, auto_confirm_registration, created_at FROM seminars ORDER BY id DESC`
    },
    {
        sheet: 'tickets',
        sql: `SELECT t.id, t.ticket_id_string, t.order_id, t.is_scanned, t.scan_time, t.is_valid,
              r.application_no, r.seminar_id, s.title AS seminar_title
              FROM tickets t
              LEFT JOIN orders o ON o.id = t.order_id
              LEFT JOIN registrations r ON r.id = o.registration_id
              LEFT JOIN seminars s ON s.id = r.seminar_id
              ORDER BY t.id DESC`
    },
    {
        sheet: 'case_submissions',
        sql: `SELECT cs.id, cs.application_no, cs.status, cs.category, cs.title, cs.user_id, cs.case_program_id,
              cs.form_data, cs.doc_review_json, cs.created_at, cs.updated_at, cp.title AS program_title
              FROM case_submissions cs LEFT JOIN case_programs cp ON cp.id = cs.case_program_id ORDER BY cs.id DESC`
    },
    {
        sheet: 'support_tickets',
        sql: `SELECT id, ticket_ref, subject, category, status, priority, user_id, assigned_to_staff,
              department_id, created_at, updated_at, closed_at FROM support_tickets ORDER BY id DESC`
    },
    {
        sheet: 'book_orders',
        sql: `SELECT id, order_ref, user_id, status, total_amount, payment_status, created_at, updated_at
              FROM book_orders ORDER BY id DESC`
    }
];

function todayStampIst() {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(new Date());
}

function normalizeConfig(raw) {
    const base = { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) };
    base.enabled = base.enabled === true || base.enabled === 1 || base.enabled === '1';
    base.destination = ['r2', 'google_drive', 'both'].includes(String(base.destination || '').toLowerCase())
        ? String(base.destination).toLowerCase()
        : 'r2';
    base.notifyEmails = Array.isArray(base.notifyEmails)
        ? base.notifyEmails.map((e) => String(e || '').trim()).filter(Boolean)
        : String(base.notifyEmails || '')
              .split(',')
              .map((e) => e.trim())
              .filter(Boolean);
    return base;
}

function loadConfig(db, cb) {
    db.get(`SELECT value FROM global_settings WHERE key = ?`, [CONFIG_KEY], (err, row) => {
        if (err) return cb(err);
        if (!row || !row.value) return cb(null, { ...DEFAULT_CONFIG });
        try {
            cb(null, normalizeConfig(JSON.parse(row.value)));
        } catch (_) {
            cb(null, { ...DEFAULT_CONFIG });
        }
    });
}

function saveConfig(db, config, cb) {
    const norm = normalizeConfig(config);
    const json = JSON.stringify(norm);
    db.run(`UPDATE global_settings SET value = ? WHERE key = ?`, [json, CONFIG_KEY], function (uErr) {
        if (uErr) return cb(uErr);
        if (this.changes) return cb(null, norm);
        db.run(`INSERT INTO global_settings (key, value) VALUES (?, ?)`, [CONFIG_KEY, json], (iErr) =>
            cb(iErr, norm)
        );
    });
}

function saveLastRun(db, payload, cb) {
    const json = JSON.stringify(payload || {});
    db.run(`UPDATE global_settings SET value = ? WHERE key = ?`, [json, LOG_KEY], function (uErr) {
        if (uErr) return cb && cb(uErr);
        if (this.changes) return cb && cb(null);
        db.run(`INSERT INTO global_settings (key, value) VALUES (?, ?)`, [LOG_KEY, json], cb);
    });
}

function loadLastRun(db, cb) {
    db.get(`SELECT value FROM global_settings WHERE key = ?`, [LOG_KEY], (err, row) => {
        if (err) return cb(err);
        if (!row || !row.value) return cb(null, null);
        try {
            cb(null, JSON.parse(row.value));
        } catch (_) {
            cb(null, null);
        }
    });
}

function queryAll(db, sql, cb) {
    db.all(sql, [], (err, rows) => {
        if (err && /no such table|does not exist/i.test(String(err.message))) return cb(null, []);
        cb(err, rows || []);
    });
}

function buildWorkbookBuffer(db, cb) {
    const wb = XLSX.utils.book_new();
    let idx = 0;
    const next = () => {
        if (idx >= EXPORT_QUERIES.length) {
            try {
                const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
                return cb(null, buf);
            } catch (e) {
                return cb(e);
            }
        }
        const q = EXPORT_QUERIES[idx++];
        queryAll(db, q.sql, (err, rows) => {
            if (err) return cb(err);
            const flat = (rows || []).map((r) => flattenRow(r));
            const sheet = flat.length
                ? XLSX.utils.json_to_sheet(flat)
                : XLSX.utils.aoa_to_sheet([['No data for ' + q.sheet]]);
            XLSX.utils.book_append_sheet(wb, sheet, q.sheet.slice(0, 31));
            next();
        });
    };
    next();
}

async function uploadToR2(filename, buffer) {
    if (!(await r2Storage.isR2Ready())) throw new Error('R2 storage is not configured');
    const key = `platform-backups/daily/${filename}`;
    await r2Storage.putObjectBuffer(key, buffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return { storage: 'r2', key };
}

async function uploadToGoogleDrive(config, filename, buffer) {
    const sa = config.googleServiceAccountJson;
    if (!googleDrive.parseServiceAccount(sa)) {
        throw new Error('Google service account JSON is not configured');
    }
    if (!String(config.googleDriveFolderId || '').trim()) {
        throw new Error(
            'Google Drive folder ID is required. Share a folder with the service account email (Editor) and paste its folder ID in backup settings.'
        );
    }
    const result = await googleDrive.uploadBuffer(
        sa,
        config.googleDriveFolderId,
        filename,
        buffer,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    return { storage: 'google_drive', fileId: result.id, webViewLink: result.webViewLink };
}

function runDailyBackup(db, opts, cb) {
    const force = !!(opts && opts.force);
    loadConfig(db, async (cfgErr, config) => {
        if (cfgErr) return cb && cb(cfgErr);
        if (!force && !config.enabled) return cb && cb(null, { skipped: true, reason: 'disabled' });

        const dateLabel = todayStampIst();
        const filename = `platform-backup-${dateLabel}.xlsx`;
        const startedAt = new Date().toISOString();

        buildWorkbookBuffer(db, async (bErr, buffer) => {
            if (bErr) return cb && cb(bErr);
            const result = {
                ok: true,
                date: dateLabel,
                filename,
                startedAt,
                finishedAt: null,
                destinations: [],
                errors: []
            };

            const dest = config.destination || 'r2';
            const tryR2 = dest === 'r2' || dest === 'both';
            const tryDrive = dest === 'google_drive' || dest === 'both';

            if (tryR2) {
                try {
                    result.destinations.push(await uploadToR2(filename, buffer));
                } catch (e) {
                    result.errors.push({ destination: 'r2', error: e.message });
                }
            }
            if (tryDrive) {
                try {
                    result.destinations.push(await uploadToGoogleDrive(config, filename, buffer));
                } catch (e) {
                    result.errors.push({ destination: 'google_drive', error: e.message });
                }
            }

            result.finishedAt = new Date().toISOString();
            result.ok = result.destinations.length > 0;
            saveLastRun(db, result, () => {
                cb && cb(null, result);
            });
        });
    });
}

function registerPlatformBackupRoutes(app, db, assertAdminPortalActor) {
    app.get('/api/admin/platform-backup/config', (req, res) => {
        const aid = parseInt(req.query.actingAdminId, 10);
        assertAdminPortalActor(aid, (e, adm) => {
            if (e && e.message === 'BAD_ACTOR') return res.status(400).json({ error: 'actingAdminId is required' });
            if (e && e.message === 'FORBIDDEN') return res.status(403).json({ error: 'Administrator access required' });
            if (e) return res.status(500).json({ error: e.message });
            if (!adm) return res.status(403).json({ error: 'Invalid administrator' });
            loadConfig(db, (err, config) => {
                if (err) return res.status(500).json({ error: err.message });
                loadLastRun(db, (lErr, lastRun) => {
                    if (lErr) return res.status(500).json({ error: lErr.message });
                    const safe = { ...config };
                    if (safe.googleServiceAccountJson) safe.googleServiceAccountJson = '********';
                    res.json({ config: safe, lastRun });
                });
            });
        });
    });

    app.post('/api/admin/platform-backup/config', (req, res) => {
        const { actingAdminId, config } = req.body || {};
        const aid = parseInt(actingAdminId, 10);
        if (!Number.isInteger(aid) || aid < 1) return res.status(400).json({ error: 'actingAdminId is required' });
        assertAdminPortalActor(aid, (e, adm) => {
            if (e && e.message === 'BAD_ACTOR') return res.status(400).json({ error: 'actingAdminId is required' });
            if (e && e.message === 'FORBIDDEN') return res.status(403).json({ error: 'Administrator access required' });
            if (e) return res.status(500).json({ error: e.message });
            if (!adm) return res.status(403).json({ error: 'Invalid administrator' });
            loadConfig(db, (loadErr, prev) => {
                if (loadErr) return res.status(500).json({ error: loadErr.message });
                const incoming = normalizeConfig(config || {});
                if (
                    incoming.googleServiceAccountJson === '********' ||
                    !String(incoming.googleServiceAccountJson || '').trim()
                ) {
                    incoming.googleServiceAccountJson = prev.googleServiceAccountJson || '';
                }
                saveConfig(db, incoming, (err, saved) => {
                    if (err) return res.status(500).json({ error: err.message });
                    const safe = { ...saved };
                    if (safe.googleServiceAccountJson) safe.googleServiceAccountJson = '********';
                    res.json({ success: true, config: safe });
                });
            });
        });
    });

    app.post('/api/admin/platform-backup/run', (req, res) => {
        const aid = parseInt(req.body && req.body.actingAdminId, 10);
        if (!Number.isInteger(aid) || aid < 1) return res.status(400).json({ error: 'actingAdminId is required' });
        assertAdminPortalActor(aid, (e, adm) => {
            if (e && e.message === 'BAD_ACTOR') return res.status(400).json({ error: 'actingAdminId is required' });
            if (e && e.message === 'FORBIDDEN') return res.status(403).json({ error: 'Administrator access required' });
            if (e) return res.status(500).json({ error: e.message });
            if (!adm) return res.status(403).json({ error: 'Invalid administrator' });
            runDailyBackup(db, { force: true }, (err, result) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json(result || { ok: false });
            });
        });
    });
}

function scheduleDailyBackup(db) {
    const cron = require('node-cron');
    loadConfig(db, (err, config) => {
        const expr = (config && config.cron) || process.env.PLATFORM_BACKUP_CRON || '0 2 * * *';
        if (!cron.validate(expr)) {
            console.warn('[platform-backup] Invalid cron expression:', expr);
            return;
        }
        cron.schedule(expr, () => {
            runDailyBackup(db, {}, (runErr, result) => {
                if (runErr) console.error('[platform-backup]', runErr.message);
                else if (result && result.ok) console.log('[platform-backup] uploaded', result.filename);
                else if (result && result.skipped) console.log('[platform-backup] skipped (disabled)');
                else console.warn('[platform-backup] finished with errors', result && result.errors);
            });
        });
        console.log('[platform-backup] Scheduled daily export:', expr);
    });
}

module.exports = {
    CONFIG_KEY,
    DEFAULT_CONFIG,
    loadConfig,
    saveConfig,
    runDailyBackup,
    registerPlatformBackupRoutes,
    scheduleDailyBackup
};
