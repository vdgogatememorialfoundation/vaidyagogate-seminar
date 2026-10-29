/**
 * Seminar video library: encrypted HLS packaging, token-gated streaming, entitlement by registration,
 * admin grants, and Razorpay purchases.
 *
 * Storage layout (VIDEO_LIBRARY_DIR, default <app>/storage/videos):
 *   uploads/<uploadId>.part     chunked browser uploads being assembled
 *   inbox/                      files copied to the server by hand (scp/sftp) for "import from server"
 *   sources/<videoId>/<file>    the uploaded original until packaging succeeds
 *   hls/<videoId>/index.m3u8    AES-128 encrypted segments (seg_00000.ts ...); the key lives only in the DB
 *
 * Playback: the browser asks for a short-lived watch session; the playlist, key, and every segment are
 * served from /video-stream/<token>/... only while that session is valid. One session per doctor at a time,
 * on a limited number of registered devices; every session records its device, IP, and IP changes.
 *
 * VGMF playback license (our own DRM, not a studio system such as Widevine): the segments stay AES-128
 * encrypted, the key URL expires with the playlist, and the key and segments are released only to the
 * browser that holds this session's device cookie or device header. The license number is burned into
 * the picture. Right-click save and the download control are blocked in the player.
 *
 * Cloud storage: with VIDEO_STORAGE=r2 (or the admin setting), finished segments are moved to the
 * Cloudflare R2 bucket from lib/r2-storage and streamed through the same token gate, so the library is not
 * limited by the server disk.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const Razorpay = require('razorpay');
const adminPaymentFlow = require('./admin-payment-flow');
const paymentGatewayOptions = require('./payment-gateway-options');
const { verifyRazorpaySignature } = require('./razorpay-standard-checkout');
const { assertAdminAccess } = require('./admin-live-edit');
const r2 = require('./r2-storage');
const videoTheme = require('./video-theme');

const isPg = !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
const ROOT = path.resolve(process.env.VIDEO_LIBRARY_DIR || path.join(__dirname, '..', 'storage', 'videos'));
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const CHUNK_BYTES = Math.max(1, Math.min(64, parseInt(process.env.VIDEO_UPLOAD_CHUNK_MB, 10) || 8)) * 1024 * 1024;
const SESSION_HOURS = 8;
const SEGMENT_SECONDS = 6;
/** Registration statuses that mean the seminar fee is paid; with or without a ticket scan those doctors watch free. */
const PAID_REGISTRATION_STATUSES = ['completed', 'e_ticket_issued', 'checked_in', 'certificate_issued'];
/** Registration statuses that mean the ticket was scanned at the venue. */
const SCANNED_REGISTRATION_STATUSES = ['checked_in', 'certificate_issued'];
const DEAD_REGISTRATION_STATUSES = ['rejected', 'cancelled', 'expired'];
const FREE_REGISTRATION_STATUSES = PAID_REGISTRATION_STATUSES;
const KINDS = ['full', 'episode'];
/** How the office records a payment when it enables a doctor. Waiver unlocks with no charge. */
const PAYMENT_MODES = {
    waiver: { label: 'Waiver (complimentary)', paid: false, source: 'admin_free' },
    cash: { label: 'Cash', paid: true, source: 'admin_paid' },
    upi: { label: 'UPI', paid: true, source: 'admin_paid' },
    card: { label: 'Card', paid: true, source: 'admin_paid' },
    razorpay: { label: 'Razorpay', paid: true, source: 'admin_paid' },
    bank: { label: 'Bank transfer', paid: true, source: 'admin_paid' },
    cheque: { label: 'Cheque', paid: true, source: 'admin_paid' },
    other: { label: 'Other', paid: true, source: 'admin_paid' }
};
const SEG_NAME = /^seg_\d{5}\.ts$/;
const DEVICE_ID = /^[a-f0-9]{32}$/;
const R2_PREFIX = (process.env.VIDEO_R2_PREFIX || 'seminar-videos').replace(/^\/+|\/+$/g, '');
const DEFAULT_SETTINGS = {
    maxDevices: 2,
    volunteersFree: true,
    storageBackend: process.env.VIDEO_STORAGE === 'r2' ? 'r2' : 'local'
};

function nowIso() {
    return new Date().toISOString();
}

function dir(...parts) {
    const p = path.join(ROOT, ...parts);
    fs.mkdirSync(p, { recursive: true });
    return p;
}

function bigint() {
    return isPg ? 'BIGINT' : 'INTEGER';
}

function ensureVideoLibrarySchema(db, cb) {
    const pk = isPg ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
    const statements = [
        `CREATE TABLE IF NOT EXISTS video_items (
            id ${pk},
            year INTEGER NOT NULL,
            seminar_id INTEGER,
            title TEXT NOT NULL,
            description TEXT,
            kind TEXT NOT NULL DEFAULT 'episode',
            part_no INTEGER,
            price_inr REAL NOT NULL DEFAULT 0,
            published INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'draft',
            source_path TEXT,
            source_name TEXT,
            source_bytes ${bigint()},
            duration_sec REAL,
            hls_dir TEXT,
            key_hex TEXT,
            iv_hex TEXT,
            segment_count INTEGER,
            process_progress REAL,
            process_log TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_by INTEGER,
            created_at TEXT,
            updated_at TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS video_years (
            id ${pk},
            year INTEGER NOT NULL UNIQUE,
            title TEXT,
            description TEXT,
            bundle_price_inr REAL,
            created_at TEXT,
            updated_at TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS video_uploads (
            id ${pk},
            upload_id TEXT NOT NULL UNIQUE,
            video_id INTEGER NOT NULL,
            file_name TEXT,
            total_bytes ${bigint()} NOT NULL,
            received_bytes ${bigint()} NOT NULL DEFAULT 0,
            chunk_bytes INTEGER NOT NULL,
            chunks_done INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'open',
            temp_path TEXT,
            created_by INTEGER,
            created_at TEXT,
            updated_at TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS video_access (
            id ${pk},
            user_id INTEGER NOT NULL,
            year INTEGER NOT NULL,
            video_id INTEGER,
            source TEXT NOT NULL,
            amount_inr REAL,
            note TEXT,
            order_id INTEGER,
            granted_by INTEGER,
            created_at TEXT,
            revoked_at TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS video_purchases (
            id ${pk},
            user_id INTEGER NOT NULL,
            year INTEGER NOT NULL,
            video_id INTEGER,
            amount_inr REAL NOT NULL,
            order_id INTEGER,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT,
            paid_at TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS video_sessions (
            id ${pk},
            token TEXT NOT NULL UNIQUE,
            user_id INTEGER NOT NULL,
            video_id INTEGER NOT NULL,
            created_at TEXT,
            last_seen_at TEXT,
            expires_at TEXT,
            revoked_at TEXT,
            ip TEXT,
            user_agent TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS video_progress (
            id ${pk},
            user_id INTEGER NOT NULL,
            video_id INTEGER NOT NULL,
            position_sec REAL NOT NULL DEFAULT 0,
            updated_at TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS video_licenses (
            id ${pk},
            user_id INTEGER NOT NULL UNIQUE,
            license_id TEXT NOT NULL UNIQUE,
            device_limit INTEGER,
            created_at TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS video_devices (
            id ${pk},
            user_id INTEGER NOT NULL,
            device_id TEXT NOT NULL,
            label TEXT,
            user_agent TEXT,
            first_ip TEXT,
            last_ip TEXT,
            first_seen_at TEXT,
            last_seen_at TEXT,
            revoked_at TEXT,
            revoked_by INTEGER,
            UNIQUE (user_id, device_id)
        )`,
        `CREATE TABLE IF NOT EXISTS video_watch_log (
            id ${pk},
            user_id INTEGER NOT NULL,
            video_id INTEGER,
            session_id INTEGER,
            device_id TEXT,
            ip TEXT,
            event TEXT NOT NULL,
            detail TEXT,
            position_sec REAL,
            created_at TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS video_settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TEXT
        )`,
        `CREATE INDEX IF NOT EXISTS idx_video_access_user ON video_access (user_id, year)`,
        `CREATE INDEX IF NOT EXISTS idx_video_sessions_user ON video_sessions (user_id)`,
        `CREATE INDEX IF NOT EXISTS idx_video_progress_user ON video_progress (user_id, video_id)`,
        `CREATE INDEX IF NOT EXISTS idx_video_devices_user ON video_devices (user_id)`,
        `CREATE INDEX IF NOT EXISTS idx_video_watch_log_user ON video_watch_log (user_id, id)`
    ];
    // Columns added after the first release; errors (column exists on SQLite) are ignored.
    const alters = [
        ['video_sessions', 'device_id', 'TEXT'],
        ['video_sessions', 'license_id', 'TEXT'],
        ['video_sessions', 'last_ip', 'TEXT'],
        ['video_sessions', 'ip_changes', 'INTEGER DEFAULT 0'],
        ['video_sessions', 'watch_seconds', 'REAL DEFAULT 0'],
        ['video_sessions', 'last_position_sec', 'REAL'],
        ['video_items', 'storage', 'TEXT'],
        ['video_items', 'storage_prefix', 'TEXT'],
        ['video_items', 'playlist_m3u8', 'TEXT'],
        ['video_access', 'payment_mode', 'TEXT'],
        ['video_years', 'theme_brief', 'TEXT'],
        ['video_years', 'theme_accent', 'TEXT'],
        ['video_years', 'theme_source', 'TEXT']
    ].map(([t, c, type]) => (isPg ? `ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ${c} ${type}` : `ALTER TABLE ${t} ADD COLUMN ${c} ${type}`));
    let i = 0;
    const next = (err) => {
        if (err) return cb(err);
        if (i >= statements.length) return runAlters();
        db.run(statements[i++], [], next);
    };
    let j = 0;
    const runAlters = () => {
        if (j >= alters.length) return cb(null);
        db.run(alters[j++], [], () => runAlters());
    };
    next();
}

/* -------------------------------------------------------------- settings */

function loadSettings(db, cb) {
    db.all(`SELECT key, value FROM video_settings`, [], (err, rows) => {
        if (err) return cb(err);
        const out = Object.assign({}, DEFAULT_SETTINGS);
        (rows || []).forEach((r) => {
            if (r.key === 'max_devices') out.maxDevices = Math.max(1, Math.min(10, parseInt(r.value, 10) || DEFAULT_SETTINGS.maxDevices));
            if (r.key === 'volunteers_free') out.volunteersFree = r.value !== '0';
            if (r.key === 'storage_backend') out.storageBackend = r.value === 'r2' ? 'r2' : 'local';
        });
        cb(null, out);
    });
}

function saveSetting(db, key, value, cb) {
    db.get(`SELECT key FROM video_settings WHERE key = ?`, [key], (err, row) => {
        if (err) return cb(err);
        const sql = row ? `UPDATE video_settings SET value = ?, updated_at = ? WHERE key = ?` : `INSERT INTO video_settings (value, updated_at, key) VALUES (?, ?, ?)`;
        db.run(sql, [String(value), nowIso(), key], (e2) => cb(e2 || null));
    });
}

/* -------------------------------------------------------------- licenses */

function randomLicenseId() {
    // 12 digits, never starting with 0, built from crypto randomness.
    let s = String(1 + crypto.randomInt(9));
    while (s.length < 12) s += String(crypto.randomInt(10));
    return s;
}

function formatLicense(id) {
    const s = String(id || '');
    return s.length === 12 ? s.slice(0, 4) + ' ' + s.slice(4, 8) + ' ' + s.slice(8) : s;
}

/** Every doctor gets one permanent 12-digit license id the first time it is needed; it is burned into the watermark. */
function ensureLicense(db, userId, cb, attempt) {
    db.get(`SELECT license_id, device_limit FROM video_licenses WHERE user_id = ?`, [userId], (err, row) => {
        if (err) return cb(err);
        if (row) return cb(null, row.license_id, row.device_limit);
        const candidate = randomLicenseId();
        db.run(`INSERT INTO video_licenses (user_id, license_id, created_at) VALUES (?, ?, ?)`, [userId, candidate, nowIso()], (iErr) => {
            if (iErr) {
                if ((attempt || 0) < 5) return ensureLicense(db, userId, cb, (attempt || 0) + 1);
                return cb(iErr);
            }
            notifyVideo(db, 'VIDEO_LICENSE_ISSUED', userId, { video_license_id: formatLicense(candidate) });
            cb(null, candidate, null);
        });
    });
}

function paymentModeLabel(mode) {
    if (PAYMENT_MODES[mode]) return PAYMENT_MODES[mode].label;
    if (mode === 'upi_qr') return 'UPI QR';
    if (mode === 'purchase') return 'Online payment';
    if (mode === 'admin_free') return 'Complimentary';
    if (mode === 'admin_paid') return 'Paid at the office';
    return mode || '';
}

/** Queues a seminar email through the existing notification templates. Failures are logged and never block playback. */
function notifyVideo(db, eventKey, userId, vars) {
    if (!userId) return;
    let engine;
    try {
        engine = require('./notification-engine');
    } catch (_) {
        return;
    }
    if (!engine || typeof engine.notify !== 'function') return;
    engine.notify(db, eventKey, { userId, vars: vars || {}, immediate: true }, (err) => {
        if (err) console.warn('[video-library] email ' + eventKey + ':', err.message);
    });
}

function mailVideo(db, eventKey, userId, fields) {
    const f = fields || {};
    ensureLicense(db, userId, (err, license) => {
        notifyVideo(db, eventKey, userId, {
            video_license_id: formatLicense(license || ''),
            video_scope: f.scope || '',
            payment_mode_label: f.modeLabel || '',
            payment_amount: f.amount != null && f.amount !== '' ? String(f.amount) : '',
            payment_amount_line: Number(f.amount) > 0 ? 'Amount: ₹' + f.amount + '.' : '',
            order_id_string: f.orderRef || '',
            access_note: f.note || '',
            device_label: f.device || '',
            watch_ip: f.ip || ''
        });
    });
}

/* --------------------------------------------------------------- devices */

function describeDevice(ua) {
    const s = String(ua || '');
    const os = /iPhone|iPad/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android' : /Windows/.test(s) ? 'Windows' : /Mac OS X|Macintosh/.test(s) ? 'Mac' : /CrOS/.test(s) ? 'ChromeOS' : /Linux/.test(s) ? 'Linux' : 'Device';
    const browser = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /SamsungBrowser/.test(s) ? 'Samsung Internet' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'Browser';
    return os + ' · ' + browser;
}

function clientIp(req) {
    const xf = String(req.get('x-forwarded-for') || '').split(',')[0].trim();
    return cleanText(xf || req.ip || '', 64);
}

function logWatch(db, fields) {
    db.run(
        `INSERT INTO video_watch_log (user_id, video_id, session_id, device_id, ip, event, detail, position_sec, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [fields.userId, fields.videoId || null, fields.sessionId || null, fields.deviceId || null, fields.ip || null, fields.event, fields.detail || null, fields.positionSec != null ? fields.positionSec : null, nowIso()],
        () => {}
    );
}

/**
 * Registers the device or refuses it. A revoked device is always refused; a new device is refused once the
 * account already uses its allowed number of devices (per-user limit, else the global setting).
 */
function admitDevice(db, userId, deviceId, req, limit, cb) {
    if (!DEVICE_ID.test(deviceId)) return cb(null, { ok: false, code: 'device_required', error: 'This browser could not identify itself. Enable cookies and site data, then try again.' });
    const ip = clientIp(req);
    const ua = cleanText(req.get('user-agent'), 240);
    db.get(`SELECT * FROM video_devices WHERE user_id = ? AND device_id = ?`, [userId, deviceId], (err, row) => {
        if (err) return cb(err);
        const now = nowIso();
        if (row && row.revoked_at) {
            mailVideo(db, 'VIDEO_DEVICE_REFUSED', userId, { device: row.label || describeDevice(ua), ip, note: 'This device was removed by the seminar office.' });
            return cb(null, { ok: false, code: 'device_blocked', error: 'This device was removed from your account by the seminar office. Contact the office to restore it.' });
        }
        if (row) {
            return db.run(`UPDATE video_devices SET last_ip = ?, last_seen_at = ?, user_agent = ?, label = ? WHERE id = ?`, [ip, now, ua, describeDevice(ua), row.id], () => cb(null, { ok: true, device: row, ip }));
        }
        db.all(`SELECT id FROM video_devices WHERE user_id = ? AND revoked_at IS NULL`, [userId], (cErr, active) => {
            if (cErr) return cb(cErr);
            const used = (active || []).length;
            if (used >= limit) {
                logWatch(db, { userId, deviceId, ip, event: 'device_refused', detail: 'limit ' + limit });
                mailVideo(db, 'VIDEO_DEVICE_REFUSED', userId, { device: describeDevice(ua), ip, note: 'The account already uses its ' + limit + ' allowed devices.' });
                return cb(null, {
                    ok: false,
                    code: 'device_limit',
                    error: 'Your account already plays videos on ' + used + ' device' + (used === 1 ? '' : 's') + ', which is the limit. Videos are personal to your license; ask the seminar office to move your access to this device.',
                    used,
                    limit
                });
            }
            db.run(
                `INSERT INTO video_devices (user_id, device_id, label, user_agent, first_ip, last_ip, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [userId, deviceId, describeDevice(ua), ua, ip, ip, now, now],
                function (iErr) {
                    if (iErr) return cb(iErr);
                    logWatch(db, { userId, deviceId, ip, event: 'device_added', detail: describeDevice(ua) });
                    mailVideo(db, 'VIDEO_DEVICE_ADDED', userId, { device: describeDevice(ua), ip });
                    cb(null, { ok: true, device: { id: this.lastID, device_id: deviceId }, ip, added: true });
                }
            );
        });
    });
}

/* ---------------------------------------------------------------- tools */

function which(bin, cb) {
    const child = spawn(bin, ['-version']);
    let done = false;
    const finish = (ok) => {
        if (done) return;
        done = true;
        cb(ok);
    };
    child.on('error', () => finish(false));
    child.on('exit', (code) => finish(code === 0));
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
}

let toolStatus = null;
function checkTools(cb) {
    if (toolStatus) return cb(toolStatus);
    which(FFMPEG, (ffmpeg) =>
        which(FFPROBE, (ffprobe) => {
            toolStatus = { ffmpeg, ffprobe, ffmpegPath: FFMPEG, ffprobePath: FFPROBE };
            cb(toolStatus);
        })
    );
}

function diskFree(cb) {
    try {
        fs.statfs(ROOT, (err, st) => {
            if (err || !st) return cb(null);
            cb({ freeBytes: Number(st.bavail) * Number(st.bsize), totalBytes: Number(st.blocks) * Number(st.bsize) });
        });
    } catch (_) {
        cb(null);
    }
}

function probe(file, cb) {
    const args = ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name', '-of', 'json', file];
    const child = spawn(FFPROBE, args);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => cb(e));
    child.on('exit', (code) => {
        if (code !== 0) return cb(new Error('ffprobe failed: ' + err.trim().slice(0, 400)));
        try {
            const json = JSON.parse(out);
            const streams = json.streams || [];
            cb(null, {
                duration: Number(json.format && json.format.duration) || 0,
                video: (streams.find((s) => s.codec_type === 'video') || {}).codec_name || '',
                audio: (streams.find((s) => s.codec_type === 'audio') || {}).codec_name || ''
            });
        } catch (e) {
            cb(e);
        }
    });
}

/* -------------------------------------------------------------- packaging */

const queue = [];
let running = null;

function updateVideo(db, id, fields, cb) {
    const keys = Object.keys(fields);
    const sets = keys.map((k) => `${k} = ?`);
    const params = keys.map((k) => fields[k]);
    sets.push('updated_at = ?');
    params.push(nowIso());
    params.push(id);
    db.run(`UPDATE video_items SET ${sets.join(', ')} WHERE id = ?`, params, (err) => cb && cb(err));
}

function enqueueProcessing(db, videoId) {
    if (running === videoId || queue.includes(videoId)) return;
    queue.push(videoId);
    drain(db);
}

function drain(db) {
    if (running != null || !queue.length) return;
    const id = queue.shift();
    running = id;
    packageVideo(db, id, () => {
        running = null;
        drain(db);
    });
}

function rmrf(p) {
    try {
        fs.rmSync(p, { recursive: true, force: true });
    } catch (_) {}
}

function runFfmpeg(args, onProgress, cb) {
    const child = spawn(FFMPEG, args);
    let tail = '';
    child.stderr.on('data', (d) => {
        tail = (tail + d.toString()).slice(-2000);
    });
    let buf = '';
    child.stdout.on('data', (d) => {
        buf += d.toString();
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            const m = line.match(/^out_time_(?:us|ms)=(\d+)/);
            if (m) onProgress(Number(m[1]) / 1e6);
        }
    });
    child.on('error', (e) => cb(e, tail));
    child.on('exit', (code) => cb(code === 0 ? null : new Error('ffmpeg exited with ' + code), tail));
    return child;
}

function hlsArgs(src, outDir, keyInfo, transcode) {
    const codec = transcode
        ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-ac', '2']
        : ['-c', 'copy'];
    return [
        '-hide_banner',
        '-nostdin',
        '-y',
        '-i',
        src,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-sn',
        '-dn',
        ...codec,
        '-f',
        'hls',
        '-hls_time',
        String(SEGMENT_SECONDS),
        '-hls_playlist_type',
        'vod',
        '-hls_flags',
        'independent_segments',
        '-hls_list_size',
        '0',
        '-hls_key_info_file',
        keyInfo,
        '-hls_segment_filename',
        path.join(outDir, 'seg_%05d.ts'),
        '-progress',
        'pipe:1',
        '-loglevel',
        'error',
        path.join(outDir, 'index.m3u8')
    ];
}

function packageVideo(db, id, done) {
    db.get(`SELECT * FROM video_items WHERE id = ?`, [id], (err, video) => {
        if (err || !video || !video.source_path || !fs.existsSync(video.source_path)) {
            if (video) updateVideo(db, id, { status: 'failed', process_log: 'Source file is missing.' });
            return done();
        }
        const outDir = path.join(ROOT, 'hls', String(id));
        rmrf(outDir);
        fs.mkdirSync(outDir, { recursive: true });
        const key = crypto.randomBytes(16);
        const iv = crypto.randomBytes(16);
        const keyFile = path.join(outDir, 'enc.key');
        const keyInfo = path.join(outDir, 'enc.keyinfo');
        fs.writeFileSync(keyFile, key);
        fs.writeFileSync(keyInfo, 'KEYURI\n' + keyFile + '\n' + iv.toString('hex') + '\n');
        updateVideo(db, id, { status: 'processing', process_progress: 0, process_log: 'Reading the file...' }, () => {
            probe(video.source_path, (pErr, info) => {
                if (pErr) {
                    rmrf(outDir);
                    return updateVideo(db, id, { status: 'failed', process_log: pErr.message }, () => done());
                }
                const duration = info.duration || Number(video.duration_sec) || 0;
                let lastWrite = 0;
                const onProgress = (sec) => {
                    if (!duration) return;
                    const now = Date.now();
                    if (now - lastWrite < 2000) return;
                    lastWrite = now;
                    updateVideo(db, id, { process_progress: Math.min(0.99, sec / duration) });
                };
                const finish = (fErr, tail, transcoded) => {
                    try {
                        fs.unlinkSync(keyFile);
                        fs.unlinkSync(keyInfo);
                    } catch (_) {}
                    if (fErr) {
                        rmrf(outDir);
                        return updateVideo(
                            db,
                            id,
                            { status: 'failed', process_progress: null, process_log: ('Packaging failed. ' + (tail || fErr.message)).slice(0, 4000) },
                            () => done()
                        );
                    }
                    const segments = fs.readdirSync(outDir).filter((f) => SEG_NAME.test(f)).length;
                    if (!segments || !fs.existsSync(path.join(outDir, 'index.m3u8'))) {
                        rmrf(outDir);
                        return updateVideo(db, id, { status: 'failed', process_log: 'ffmpeg produced no segments.' }, () => done());
                    }
                    let playlist = '';
                    try {
                        playlist = fs.readFileSync(path.join(outDir, 'index.m3u8'), 'utf8');
                    } catch (_) {}
                    updateVideo(
                        db,
                        id,
                        {
                            status: 'ready',
                            hls_dir: outDir,
                            storage: 'local',
                            storage_prefix: null,
                            playlist_m3u8: playlist || null,
                            key_hex: key.toString('hex'),
                            iv_hex: iv.toString('hex'),
                            segment_count: segments,
                            duration_sec: duration || null,
                            process_progress: 1,
                            process_log: (transcoded ? 'Re-encoded to H.264/AAC and ' : 'Remuxed without re-encoding and ') + 'encrypted into ' + segments + ' segments.'
                        },
                        () => {
                            // The original is no longer needed once the encrypted copy exists.
                            rmrf(path.dirname(video.source_path));
                            updateVideo(db, id, { source_path: null }, () => {
                                loadSettings(db, (sErr, settings) => {
                                    if (!sErr && settings.storageBackend === 'r2' && r2.isR2Configured()) return offloadToR2(db, id, () => done());
                                    done();
                                });
                            });
                        }
                    );
                };
                const copyFriendly = /^(h264|hevc)$/.test(info.video) && (!info.audio || /^(aac|mp3|ac3|eac3)$/.test(info.audio));
                const attempt = (transcode) => {
                    updateVideo(db, id, { process_log: transcode ? 'Re-encoding to H.264/AAC (this can take a long time for large files)...' : 'Encrypting and splitting the video...' });
                    runFfmpeg(hlsArgs(video.source_path, outDir, keyInfo, transcode), onProgress, (fErr, tail) => {
                        if (fErr && !transcode) {
                            // Stream copy can fail on unusual containers; re-encode as the fallback.
                            fs.readdirSync(outDir).forEach((f) => {
                                if (f !== 'enc.key' && f !== 'enc.keyinfo') rmrf(path.join(outDir, f));
                            });
                            return attempt(true);
                        }
                        finish(fErr, tail, transcode);
                    });
                };
                attempt(!copyFriendly);
            });
        });
    });
}

/* ----------------------------------------------------------- cloud storage */

function r2Client() {
    const client = r2.isR2Configured() ? r2.getClient() : null;
    if (!client) throw new Error('Cloud storage (R2) is not configured on this server.');
    return client;
}

async function uploadDirToR2(dirPath, prefix, onProgress) {
    const client = r2Client();
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const files = fs.readdirSync(dirPath).filter((f) => SEG_NAME.test(f) || f === 'index.m3u8');
    let done = 0;
    for (const f of files) {
        const full = path.join(dirPath, f);
        const st = fs.statSync(full);
        await client.send(
            new PutObjectCommand({
                Bucket: r2.getBucket(),
                Key: prefix + '/' + f,
                Body: fs.createReadStream(full),
                ContentLength: st.size,
                ContentType: f.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/MP2T'
            })
        );
        done += 1;
        if (onProgress) onProgress(done, files.length);
    }
    return files.length;
}

async function deleteR2Prefix(prefix) {
    if (!prefix || !r2.isR2Configured()) return;
    const client = r2Client();
    const { ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
    let token;
    do {
        const out = await client.send(new ListObjectsV2Command({ Bucket: r2.getBucket(), Prefix: prefix + '/', ContinuationToken: token }));
        const keys = (out.Contents || []).map((o) => ({ Key: o.Key }));
        if (keys.length) await client.send(new DeleteObjectsCommand({ Bucket: r2.getBucket(), Delete: { Objects: keys } }));
        token = out.IsTruncated ? out.NextContinuationToken : null;
    } while (token);
}

/** Moves a packaged video's segments from the server disk to the R2 bucket; playback keeps working through the same token gate. */
function offloadToR2(db, id, cb) {
    db.get(`SELECT * FROM video_items WHERE id = ? AND status = 'ready'`, [id], (err, v) => {
        if (err || !v || v.storage === 'r2' || !v.hls_dir || !fs.existsSync(v.hls_dir)) return cb(err || null, false);
        const prefix = R2_PREFIX + '/' + id + '-' + crypto.randomBytes(4).toString('hex');
        let lastWrite = 0;
        updateVideo(db, id, { process_log: 'Moving to cloud storage...' });
        uploadDirToR2(v.hls_dir, prefix, (d, t) => {
            if (Date.now() - lastWrite < 2000) return;
            lastWrite = Date.now();
            updateVideo(db, id, { process_log: 'Moving to cloud storage ' + d + '/' + t + '...' });
        })
            .then((n) => {
                let playlist = v.playlist_m3u8 || '';
                try {
                    playlist = fs.readFileSync(path.join(v.hls_dir, 'index.m3u8'), 'utf8');
                } catch (_) {}
                updateVideo(db, id, { storage: 'r2', storage_prefix: prefix, playlist_m3u8: playlist, process_log: 'Stored in cloud storage (' + n + ' files).' }, () => {
                    rmrf(v.hls_dir);
                    cb(null, true);
                });
            })
            .catch((e) => {
                deleteR2Prefix(prefix).catch(() => {});
                updateVideo(db, id, { process_log: ('Cloud upload failed; the video stays on the server disk. ' + e.message).slice(0, 1000) }, () => cb(null, false));
            });
    });
}

/** After the office chooses the cloud bucket, move every finished video that is still on disk. */
function offloadReadyVideos(db) {
    db.all(
        `SELECT id FROM video_items WHERE status = 'ready' AND hls_dir IS NOT NULL AND (storage IS NULL OR storage <> 'r2')`,
        [],
        (err, rows) => {
            if (err || !rows || !rows.length) return;
            const ids = rows.map((r) => r.id);
            const next = () => {
                const id = ids.shift();
                if (!id) return;
                offloadToR2(db, id, () => next());
            };
            next();
        }
    );
}

function streamSegmentFromR2(prefix, name, req, res) {
    let client;
    try {
        client = r2Client();
    } catch (e) {
        return res.status(503).end();
    }
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const range = /^bytes=\d*-\d*$/.test(String(req.headers.range || '')) ? req.headers.range : undefined;
    client
        .send(new GetObjectCommand({ Bucket: r2.getBucket(), Key: prefix + '/' + name, Range: range }))
        .then((out) => {
            noStore(res, 'video/MP2T');
            res.setHeader('Accept-Ranges', 'bytes');
            if (out.ContentRange) {
                res.status(206);
                res.setHeader('Content-Range', out.ContentRange);
            }
            if (out.ContentLength != null) res.setHeader('Content-Length', out.ContentLength);
            const body = out.Body;
            req.on('close', () => {
                try {
                    body.destroy();
                } catch (_) {}
            });
            body.on('error', () => res.end()).pipe(res);
        })
        .catch((e) => {
            const code = e && e.$metadata && e.$metadata.httpStatusCode;
            res.status(code === 416 ? 416 : code === 404 ? 404 : 502).end();
        });
}

function drmSecret() {
    return String(process.env.VIDEO_DRM_SECRET || process.env.JWT_SECRET || 'vgmf-video-license').trim();
}

function playCookieValue(token, deviceId) {
    const mac = crypto.createHmac('sha256', drmSecret()).update(String(token) + '|' + String(deviceId || '')).digest('hex').slice(0, 24);
    return String(deviceId || '') + '.' + mac;
}

function readCookie(req, name) {
    const raw = String((req.headers && req.headers.cookie) || '');
    const parts = raw.split(';');
    for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const eq = p.indexOf('=');
        if (eq < 0) continue;
        if (p.slice(0, eq).trim() === name) return decodeURIComponent(p.slice(eq + 1).trim());
    }
    return '';
}

const LICENSE_WINDOW_MS = 10 * 60 * 1000;

function licenseQuery(token, deviceId, bucket) {
    const b = bucket == null ? Math.floor(Date.now() / LICENSE_WINDOW_MS) : bucket;
    const mac = crypto.createHmac('sha256', drmSecret()).update(String(token) + '|' + String(deviceId || '') + '|' + b).digest('hex').slice(0, 20);
    return b + '.' + mac;
}

function licenseQueryOk(raw, token, deviceId) {
    const q = String(raw || '');
    const nowB = Math.floor(Date.now() / LICENSE_WINDOW_MS);
    return [nowB, nowB - 1].some((b) => q === licenseQuery(token, deviceId, b));
}

function setPlayCookie(req, res, session) {
    if (!session || !session.device_id) return;
    const value = playCookieValue(session.token, session.device_id);
    const secure = req.secure || String(req.headers['x-forwarded-proto'] || '') === 'https' ? '; Secure' : '';
    res.append(
        'Set-Cookie',
        'vgmf_play=' + encodeURIComponent(value) + '; Path=/video-stream/' + session.token + '; HttpOnly; SameSite=Lax; Max-Age=' + SESSION_HOURS * 3600 + secure
    );
}

/** Key and segment requests must come from the browser session that opened the video. */
function playbackAuthorized(req, session) {
    if (!session || !session.device_id) return true;
    const header = String((req.headers && req.headers['x-vgmf-device']) || '');
    if (header && header === session.device_id) return true;
    const ua = String((req.headers && req.headers['user-agent']) || '');
    const browser = /Mozilla|Safari|Chrome|Firefox|Edg\//i.test(ua) && !/VLC|Lavf|libmpv|ffmpeg|okhttp|curl|wget|python|aria2|IDM/i.test(ua);
    if (!browser) return false;
    return readCookie(req, 'vgmf_play') === playCookieValue(session.token, session.device_id);
}

function quoteSelectedYears(years, videos, yearRows) {
    const lines = [];
    let total = 0;
    (years || []).forEach((year) => {
        const y = Number(year);
        const list = (videos || []).filter((v) => Number(v.year) === y);
        const meta = (yearRows || []).find((row) => Number(row.year) === y) || {};
        const bundle = meta.bundle_price_inr != null && meta.bundle_price_inr !== '' ? Number(meta.bundle_price_inr) : null;
        const videoSum = list.reduce((sum, v) => sum + (Number(v.price_inr) || 0), 0);
        const amount = bundle != null && !Number.isNaN(bundle) && bundle > 0 ? bundle : videoSum;
        lines.push({
            year: y,
            title: meta.title || 'Seminar ' + y,
            amountInr: Math.round((Number(amount) || 0) * 100) / 100,
            reason: bundle != null && bundle > 0 ? 'Year price' : 'Total of the videos in this year',
            videos: list.map((v) => ({
                id: v.id,
                title: v.title,
                kind: v.kind,
                partNo: v.part_no != null ? v.part_no : null,
                priceInr: Number(v.price_inr) || 0
            }))
        });
        total += Number(amount) || 0;
    });
    return { total: Math.round(total * 100) / 100, lines };
}

/** One payment unlocks every video of each selected year. */
function grantOfficeYears(db, spec, cb) {
    const years = spec.years || [];
    let i = 0;
    let added = 0;
    const next = (err) => {
        if (err) return cb(err);
        if (i >= years.length) {
            if (!added) return cb(null);
            const scope = years.map((y) => 'all ' + y + ' seminar videos').join(', ');
            mailVideo(db, 'VIDEO_ACCESS_GRANTED', spec.userId, {
                scope,
                modeLabel: spec.modeLabel,
                amount: spec.paid ? spec.amount : null,
                note: [spec.note, spec.orderRef ? 'Order ' + spec.orderRef : '', spec.razorpayOrderId ? 'Razorpay ' + spec.razorpayOrderId : ''].filter(Boolean).join(' · ')
            });
            return cb(null);
        }
        const year = years[i++];
        db.get(
            `SELECT id FROM video_access WHERE user_id = ? AND year = ? AND video_id IS NULL AND revoked_at IS NULL`,
            [spec.userId, year],
            (e, row) => {
                if (e) return cb(e);
                if (row) return next();
                added += 1;
                db.run(
                    `INSERT INTO video_access (user_id, year, video_id, source, amount_inr, note, order_id, granted_by, created_at, payment_mode) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
                    [spec.userId, year, spec.source, added === 1 ? spec.amount : null, spec.note || '', spec.orderDbId || null, spec.adminId || null, nowIso(), spec.mode],
                    next
                );
            }
        );
    };
    next();
}

function officeVideoQuote(videos, yearRows, regs) {
    const paidYears = new Set();
    const paidSeminars = new Set();
    (regs || []).forEach((r) => {
        const status = String(r.status || '').toLowerCase();
        const paid = PAID_REGISTRATION_STATUSES.includes(status) || Number(r.paid_rows) > 0;
        if (!paid) return;
        const yearMatch = String(r.event_date || '').match(/^(\d{4})/);
        const year = r.portal_year || (yearMatch ? parseInt(yearMatch[1], 10) : null);
        if (year) paidYears.add(Number(year));
        if (r.seminar_id) paidSeminars.add(Number(r.seminar_id));
    });
    const anyRegistration = (regs || []).length > 0;
    const byYear = new Map();
    (videos || []).forEach((v) => {
        const year = Number(v.year);
        if (!byYear.has(year)) byYear.set(year, []);
        byYear.get(year).push(v);
    });
    const lines = [];
    let total = 0;
    byYear.forEach((list, year) => {
        const covered = list.every((v) => paidYears.has(year) || (v.seminar_id && paidSeminars.has(Number(v.seminar_id))));
        const meta = (yearRows || []).find((y) => Number(y.year) === year) || {};
        const bundle = meta.bundle_price_inr != null && meta.bundle_price_inr !== '' ? Number(meta.bundle_price_inr) : null;
        if (covered) {
            list.forEach((v) => lines.push({ videoId: v.id, year, title: v.title, amountInr: 0, reason: 'Included with a paid registration' }));
            return;
        }
        if (bundle != null && !Number.isNaN(bundle)) {
            lines.push({
                year,
                title: (meta.title || 'Seminar ' + year) + ' — year amount',
                amountInr: bundle,
                reason: anyRegistration ? 'Not registered for this seminar year' : 'No seminar registration — year amount added',
                videoIds: list.map((v) => v.id)
            });
            total += bundle;
            return;
        }
        list.forEach((v) => {
            const price = Number(v.price_inr) || 0;
            lines.push({ videoId: v.id, year, title: v.title, amountInr: price, reason: 'Video price' });
            total += price;
        });
    });
    return { total: Math.round(total * 100) / 100, lines, anyRegistration };
}

function cloudStatus(cb) {
    if (!r2.isR2Configured()) return cb({ configured: false, ready: false, error: 'R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET_NAME are not all set.' });
    Promise.resolve(r2.isR2Ready())
        .then((ok) => cb({ configured: true, ready: !!ok, error: ok ? '' : String(r2.getR2SetupHint() || 'Bucket not reachable').replace(/ on Render\.?| in Cloudflare and Render env vars\.?/g, '.'), bucket: r2.getBucket() }))
        .catch((e) => cb({ configured: true, ready: false, error: e.message, bucket: r2.getBucket() }));
}

/* ------------------------------------------------------------- entitlement */

function yearExpr(alias) {
    return isPg ? `EXTRACT(YEAR FROM ${alias}.event_date)::INTEGER` : `CAST(strftime('%Y', ${alias}.event_date) AS INTEGER)`;
}

function statusRank(status) {
    const s = String(status || '').toLowerCase();
    if (SCANNED_REGISTRATION_STATUSES.includes(s)) return 3;
    if (PAID_REGISTRATION_STATUSES.includes(s)) return 2;
    if (DEAD_REGISTRATION_STATUSES.includes(s)) return 0;
    return 1;
}

/**
 * The doctor's best registration for the video's seminar (when the video is linked to one) or for any
 * seminar of that year, together with the three checks the office cares about.
 */
function registrationChecks(db, userId, video, cb) {
    db.all(
        `SELECT r.id, r.status, r.seminar_id, s.title AS seminar_title,
                (SELECT COUNT(*) FROM orders o WHERE o.registration_id = r.id AND LOWER(COALESCE(o.status, '')) = 'success') AS paid_rows
         FROM registrations r JOIN seminars s ON s.id = r.seminar_id
         WHERE r.user_id = ? AND (${video.seminar_id ? 's.id = ?' : `(s.portal_year = ? OR ${yearExpr('s')} = ?)`})
         ORDER BY r.id DESC`,
        video.seminar_id ? [userId, video.seminar_id] : [userId, video.year, video.year],
        (err, rows) => (err ? cb(err) : cb(null, summarizeRegistrations(rows || [])))
    );
}

function summarizeRegistrations(rows) {
    const live = rows.filter((r) => statusRank(r.status) > 0);
    if (!live.length) return { registered: false, paid: false, scanned: false, status: rows[0] ? rows[0].status : null, seminarTitle: rows[0] ? rows[0].seminar_title : '', registrationId: null };
    const best = live.slice().sort((a, b) => statusRank(b.status) - statusRank(a.status) || b.id - a.id)[0];
    const s = String(best.status || '').toLowerCase();
    return {
        registered: true,
        paid: PAID_REGISTRATION_STATUSES.includes(s) || Number(best.paid_rows) > 0,
        scanned: SCANNED_REGISTRATION_STATUSES.includes(s),
        status: best.status,
        seminarTitle: best.seminar_title || '',
        registrationId: best.id
    };
}

/**
 * Why a doctor may watch a video, in this order: volunteer account, seminar registration that is paid
 * (ticket scanned or not), an office grant or recorded payment, an online purchase. Otherwise the checks
 * explain what is missing so the doctor can pay.
 */
function resolveAccess(db, userId, video, cb, settings) {
    const finish = (allowed, reason, detail, checks, extra) => cb(null, Object.assign({ allowed, reason, detail, checks }, extra || {}));
    db.get(`SELECT id, doctor_category, user_role, role FROM users WHERE id = ?`, [userId], (uErr, user) => {
        if (uErr) return cb(uErr);
        const volunteer = !!user && String(user.doctor_category || '').toLowerCase() === 'volunteer';
        const volunteersFree = settings ? settings.volunteersFree !== false : DEFAULT_SETTINGS.volunteersFree;
        registrationChecks(db, userId, video, (rErr, reg) => {
            if (rErr) return cb(rErr);
            const checks = { registered: reg.registered, paid: reg.paid, scanned: reg.scanned, volunteer, status: reg.status || null, seminarTitle: reg.seminarTitle || '' };
            if (volunteer && volunteersFree) return finish(true, 'volunteer', 'Volunteer account', checks);
            if (reg.registered && reg.paid) return finish(true, reg.scanned ? 'registered_scanned' : 'registered_paid', reg.seminarTitle, checks);
            db.get(
                `SELECT id, source, video_id FROM video_access
                 WHERE user_id = ? AND year = ? AND revoked_at IS NULL AND (video_id IS NULL OR video_id = ?)
                 ORDER BY id DESC LIMIT 1`,
                [userId, video.year, video.id],
                (e2, grant) => {
                    if (e2) return cb(e2);
                    if (grant) return finish(true, grant.source, grant.video_id ? 'this video' : 'all ' + video.year + ' videos', checks);
                    finish(false, null, reg.registered ? (reg.paid ? '' : 'Seminar fee not paid') : 'Not registered for this seminar', checks);
                }
            );
        });
    });
}

function mapVideo(row, access, progress) {
    return {
        id: row.id,
        year: row.year,
        seminarId: row.seminar_id || null,
        seminarTitle: row.seminar_title || '',
        title: row.title,
        description: row.description || '',
        kind: row.kind,
        partNo: row.part_no != null ? row.part_no : null,
        priceInr: Number(row.price_inr) || 0,
        published: !!row.published,
        status: row.status,
        durationSec: row.duration_sec != null ? Number(row.duration_sec) : null,
        sizeBytes: row.source_bytes != null ? Number(row.source_bytes) : null,
        sortOrder: row.sort_order || 0,
        access: access || null,
        positionSec: progress != null ? Number(progress) : 0
    };
}

/* --------------------------------------------------------------- sessions */

function newToken() {
    return crypto.randomBytes(24).toString('hex');
}

function loadSession(db, token, cb) {
    if (!/^[a-f0-9]{48}$/.test(String(token || ''))) return cb(null, null);
    db.get(
        `SELECT s.*, v.hls_dir, v.key_hex, v.status AS video_status, v.published, v.storage, v.storage_prefix, v.playlist_m3u8
         FROM video_sessions s JOIN video_items v ON v.id = s.video_id WHERE s.token = ?`,
        [token],
        (err, row) => {
            if (err) return cb(err);
            if (!row || row.revoked_at) return cb(null, null);
            if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return cb(null, null);
            if (row.video_status !== 'ready' || (!row.hls_dir && row.storage !== 'r2')) return cb(null, null);
            cb(null, row);
        }
    );
}

function noStore(res, type) {
    res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (type) res.setHeader('Content-Type', type);
}

function touchSession(db, id) {
    db.run(`UPDATE video_sessions SET last_seen_at = ? WHERE id = ?`, [nowIso(), id], () => {});
}

/** Heartbeat bookkeeping: last seen, watched seconds (forward progress only), and any change of IP address. */
function trackHeartbeat(db, session, req, pos) {
    const ip = clientIp(req);
    const now = nowIso();
    const last = session.last_position_sec != null ? Number(session.last_position_sec) : null;
    const delta = pos != null && last != null && pos > last ? Math.min(pos - last, 30) : 0;
    const changed = ip && session.last_ip && ip !== session.last_ip;
    db.run(
        `UPDATE video_sessions SET last_seen_at = ?, last_position_sec = COALESCE(?, last_position_sec), watch_seconds = COALESCE(watch_seconds, 0) + ?,
                last_ip = ?, ip_changes = COALESCE(ip_changes, 0) + ? WHERE id = ?`,
        [now, pos, delta, ip || session.last_ip || null, changed ? 1 : 0, session.id],
        () => {}
    );
    if (changed) logWatch(db, { userId: session.user_id, videoId: session.video_id, sessionId: session.id, deviceId: session.device_id, ip, event: 'ip_change', detail: 'from ' + session.last_ip, positionSec: pos });
}

/* ----------------------------------------------------------------- admin */

function actingAdminId(req) {
    const raw =
        (req.get && req.get('X-Acting-User-Id')) ||
        (req.query && (req.query.actingAdminId || req.query.adminUserId)) ||
        (req.body && (req.body.actingAdminId || req.body.adminUserId)) ||
        '';
    const n = parseInt(raw, 10);
    return Number.isInteger(n) && n > 0 ? n : null;
}

function requireAdmin(db) {
    return (req, res, next) => {
        const aid = actingAdminId(req);
        if (!aid) return res.status(401).json({ error: 'Admin sign-in required' });
        assertAdminAccess(db, aid, (err, out) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!out.ok) return res.status(403).json({ error: out.error });
            req.adminId = aid;
            next();
        });
    };
}

function cleanText(v, max) {
    return String(v == null ? '' : v)
        .trim()
        .slice(0, max || 240);
}

function parseYear(v) {
    const n = parseInt(v, 10);
    return Number.isInteger(n) && n >= 2000 && n <= 2100 ? n : null;
}

function parsePrice(v) {
    if (v === '' || v == null) return 0;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

function userDisplay(u) {
    if (!u) return '';
    return [u.first_name, u.middle_name, u.last_name].filter(Boolean).join(' ').trim() || u.email || ('User #' + u.id);
}

/* -------------------------------------------------------------- payments */

function fulfillPurchase(db, purchase, gateway, txnId, cb) {
    db.run(
        `UPDATE orders SET status = 'success', payment_date = CURRENT_TIMESTAMP, payment_gateway = ?, provider_transaction_id = ? WHERE id = ? AND status <> 'success'`,
        [gateway, txnId || null, purchase.order_id],
        (err) => {
            if (err) return cb(err);
            db.run(`UPDATE video_purchases SET status = 'paid', paid_at = ? WHERE id = ? AND status <> 'paid'`, [nowIso(), purchase.id], (e2) => {
                if (e2) return cb(e2);
                db.get(`SELECT id FROM video_access WHERE order_id = ? AND revoked_at IS NULL`, [purchase.order_id], (e3, existing) => {
                    if (e3) return cb(e3);
                    if (existing) return cb(null);
                    const payMode = String(gateway || '').toLowerCase().startsWith('dqr') ? 'upi_qr' : 'razorpay';
                    db.run(
                        `INSERT INTO video_access (user_id, year, video_id, source, amount_inr, note, order_id, granted_by, created_at, payment_mode)
                         VALUES (?, ?, ?, 'purchase', ?, ?, ?, NULL, ?, ?)`,
                        [purchase.user_id, purchase.year, purchase.video_id || null, purchase.amount_inr, 'Online payment ' + (txnId || ''), purchase.order_id, nowIso(), payMode],
                        (e4) => {
                            if (e4) return cb(e4);
                            const scopeOf = (title) => (title ? title + ' (' + purchase.year + ')' : 'all ' + purchase.year + ' seminar videos');
                            db.get(`SELECT title FROM video_items WHERE id = ?`, [purchase.video_id || 0], (eT, video) => {
                                db.get(`SELECT order_id_string FROM orders WHERE id = ?`, [purchase.order_id], (eO, order) => {
                                    mailVideo(db, 'VIDEO_PAYMENT_RECEIVED', purchase.user_id, {
                                        scope: scopeOf(video && video.title),
                                        modeLabel: paymentModeLabel(payMode),
                                        amount: purchase.amount_inr,
                                        orderRef: order && order.order_id_string
                                    });
                                    cb(null);
                                });
                            });
                        }
                    );
                });
            });
        }
    );
}

function razorpayFor(gwRows, tag) {
    const mode = String(tag || '').includes('live') ? 'live' : 'test';
    const resolved = (gwRows || [])
        .flatMap((r) => paymentGatewayOptions.expandGatewayRow(r))
        .find((o) => o.gateway === 'razorpay' && o.mode === mode);
    return resolved || adminPaymentFlow.pickRazorpayGateway(gwRows);
}

function pollPurchase(db, purchase, order, cb) {
    const gw = String(order.payment_gateway || '');
    if (!order.provider_order_id) return cb(null, false);
    db.all(`SELECT * FROM payment_gateways WHERE is_active = 1`, [], (eG, gwRows) => {
        if (eG) return cb(eG);
        const opt = razorpayFor(gwRows, gw);
        if (!opt) return cb(null, false);
        if (gw.startsWith('dqr')) {
            return adminPaymentFlow.pollRazorpayDqr(opt, order.provider_order_id, Math.round(Number(order.amount) * 100), (pErr, poll) => {
                if (pErr || !poll || !poll.paid) return cb(null, false);
                cb(null, { gateway: gw, txnId: 'DQR_' + order.provider_order_id });
            });
        }
        const rz = new Razorpay({ key_id: opt.config.key_id, key_secret: opt.config.key_secret });
        rz.orders.fetchPayments(order.provider_order_id, (payErr, payments) => {
            if (payErr) return cb(null, false);
            const captured = ((payments && payments.items) || []).find((p) => String(p.status).toLowerCase() === 'captured');
            if (!captured) return cb(null, false);
            cb(null, { gateway: gw, txnId: captured.id });
        });
    });
}

/* ----------------------------------------------------------------- routes */

function registerVideoLibraryRoutes(app, db, deps) {
    const { listDoctorPaymentOptions, parsePositiveUserId } = deps || {};
    const express = require('express');
    const uid = (raw) => (parsePositiveUserId ? parsePositiveUserId(raw) : parseInt(raw, 10) > 0 ? parseInt(raw, 10) : null);
    const admin = requireAdmin(db);
    const numId = (raw) => {
        const n = parseInt(raw, 10);
        return Number.isInteger(n) && n > 0 && String(raw) === String(n) ? n : null;
    };
    dir('uploads');
    dir('inbox');
    dir('sources');
    dir('hls');

    ensureVideoLibrarySchema(db, (err) => {
        if (err) console.error('[video-library] schema:', err.message);
        // Anything that was mid-flight when the process stopped is picked up again.
        db.all(`SELECT id FROM video_items WHERE status IN ('uploaded', 'processing') AND source_path IS NOT NULL`, [], (e, rows) => {
            if (e) return;
            (rows || []).forEach((r) => enqueueProcessing(db, r.id));
        });
    });

    /* ----- doctor ----- */

    app.get('/api/doctor/videos', (req, res) => {
        const userId = uid(req.query.userId);
        if (!userId) return res.status(400).json({ error: 'userId is required' });
        loadSettings(db, (sErr, settings) => {
        if (sErr) return res.status(500).json({ error: sErr.message });
        db.all(
            `SELECT v.*, p.position_sec, s.title AS seminar_title FROM video_items v
             LEFT JOIN video_progress p ON p.video_id = v.id AND p.user_id = ?
             LEFT JOIN seminars s ON s.id = v.seminar_id
             WHERE v.published = 1 AND v.status = 'ready'
             ORDER BY v.year DESC, v.sort_order ASC, CASE WHEN v.kind = 'full' THEN 0 ELSE 1 END, v.part_no ASC, v.id ASC`,
            [userId],
            (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                db.all(`SELECT * FROM video_years`, [], (eY, yearRows) => {
                    if (eY) return res.status(500).json({ error: eY.message });
                    db.all(
                        `SELECT id, year, video_id, amount_inr, status, order_id, created_at FROM video_purchases WHERE user_id = ? AND status = 'pending' AND created_at > ? ORDER BY id DESC`,
                        [userId, new Date(Date.now() - 2 * 3600 * 1000).toISOString()],
                        (eP, pending) => {
                            if (eP) return res.status(500).json({ error: eP.message });
                            const list = rows || [];
                            const out = [];
                            let i = 0;
                            const next = () => {
                                if (i >= list.length) {
                                    const years = {};
                                    out.forEach((v) => {
                                        if (!years[v.year]) {
                                            const meta = (yearRows || []).find((y) => Number(y.year) === Number(v.year)) || {};
                                            years[v.year] = {
                                                year: v.year,
                                                title: meta.title || 'Seminar ' + v.year,
                                                description: meta.description || '',
                                                accent: /^#[0-9a-fA-F]{6}$/.test(meta.theme_accent || '') ? meta.theme_accent : '',
                                                bundlePriceInr: meta.bundle_price_inr != null ? Number(meta.bundle_price_inr) : null,
                                                allAllowed: true,
                                                videos: []
                                            };
                                        }
                                        years[v.year].videos.push(v);
                                        if (!v.access.allowed) years[v.year].allAllowed = false;
                                    });
                                    ensureLicense(db, userId, (lErr, license) => {
                                        db.get(`SELECT doctor_category FROM users WHERE id = ?`, [userId], (eC, viewer) => {
                                        res.json({
                                            years: Object.values(years).sort((a, b) => b.year - a.year),
                                            pendingPurchases: pending || [],
                                            license: lErr ? null : formatLicense(license),
                                            maxDevices: settings.maxDevices,
                                            viewer: { volunteer: !eC && viewer && String(viewer.doctor_category || '').toLowerCase() === 'volunteer' }
                                        });
                                        });
                                    });
                                    return;
                                }
                                const row = list[i++];
                                resolveAccess(db, userId, row, (aErr, access) => {
                                    if (aErr) return res.status(500).json({ error: aErr.message });
                                    out.push(mapVideo(row, access, row.position_sec));
                                    next();
                                }, settings);
                            };
                            next();
                        }
                    );
                });
            }
        );
        });
    });

    app.get('/api/doctor/videos/devices', (req, res) => {
        const userId = uid(req.query.userId);
        if (!userId) return res.status(400).json({ error: 'userId is required' });
        const current = String(req.query.deviceId || '');
        loadSettings(db, (sErr, settings) => {
            if (sErr) return res.status(500).json({ error: sErr.message });
            ensureLicense(db, userId, (lErr, license, limitOverride) => {
                if (lErr) return res.status(500).json({ error: lErr.message });
                db.all(`SELECT id, device_id, label, first_seen_at, last_seen_at FROM video_devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY id ASC`, [userId], (err, rows) => {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({
                        license: formatLicense(license),
                        limit: limitOverride || settings.maxDevices,
                        devices: (rows || []).map((d) => ({ id: d.id, label: d.label || 'Device', firstSeenAt: d.first_seen_at, lastSeenAt: d.last_seen_at, current: d.device_id === current }))
                    });
                });
            });
        });
    });

    app.post('/api/doctor/videos/:id/session', (req, res) => {
        const userId = uid(req.body && req.body.userId);
        const id = parseInt(req.params.id, 10);
        if (!userId || !Number.isInteger(id)) return res.status(400).json({ error: 'userId and video are required' });
        const deviceId = String((req.body && req.body.deviceId) || '').toLowerCase();
        db.get(`SELECT v.*, s.title AS seminar_title FROM video_items v LEFT JOIN seminars s ON s.id = v.seminar_id WHERE v.id = ? AND v.published = 1 AND v.status = 'ready'`, [id], (err, video) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!video) return res.status(404).json({ error: 'This video is not available.' });
            loadSettings(db, (sErr, settings) => {
            if (sErr) return res.status(500).json({ error: sErr.message });
            resolveAccess(db, userId, video, (aErr, access) => {
                if (aErr) return res.status(500).json({ error: aErr.message });
                if (!access.allowed) {
                    logWatch(db, { userId, videoId: id, deviceId, ip: clientIp(req), event: 'refused', detail: access.detail || 'no access' });
                    return res.status(403).json({ error: 'You do not have access to this video yet.', access });
                }
                db.get(`SELECT id, first_name, middle_name, last_name, email, user_id_string FROM users WHERE id = ?`, [userId], (uErr, user) => {
                    if (uErr) return res.status(500).json({ error: uErr.message });
                    if (!user) return res.status(404).json({ error: 'User not found' });
                    ensureLicense(db, userId, (lErr, license, limitOverride) => {
                        if (lErr) return res.status(500).json({ error: lErr.message });
                        admitDevice(db, userId, deviceId, req, limitOverride || settings.maxDevices, (dErr, admit) => {
                            if (dErr) return res.status(500).json({ error: dErr.message });
                            if (!admit.ok) return res.status(403).json({ error: admit.error, code: admit.code, used: admit.used, limit: admit.limit });
                            const token = newToken();
                            const now = nowIso();
                            const expires = new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString();
                            // One active playback per doctor: starting here ends playback anywhere else.
                            db.run(`UPDATE video_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`, [now, userId], (rErr) => {
                                if (rErr) return res.status(500).json({ error: rErr.message });
                                db.run(
                                    `INSERT INTO video_sessions (token, user_id, video_id, created_at, last_seen_at, expires_at, ip, user_agent, device_id, license_id, last_ip, ip_changes, watch_seconds)
                                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
                                    [token, userId, id, now, now, expires, admit.ip, cleanText(req.get('user-agent'), 200), deviceId, license, admit.ip],
                                    function (iErr) {
                                        if (iErr) return res.status(500).json({ error: iErr.message });
                                        logWatch(db, { userId, videoId: id, sessionId: this.lastID, deviceId, ip: admit.ip, event: 'start', detail: access.reason });
                                        db.get(`SELECT position_sec FROM video_progress WHERE user_id = ? AND video_id = ?`, [userId, id], (pErr, prog) => {
                                            res.json({
                                                token,
                                                playlistUrl: '/video-stream/' + token + '/index.m3u8',
                                                expiresAt: expires,
                                                positionSec: prog ? Number(prog.position_sec) || 0 : 0,
                                                watermark: {
                                                    name: userDisplay(user),
                                                    id: user.user_id_string || 'ID ' + user.id,
                                                    license: formatLicense(license),
                                                    email: user.email || ''
                                                },
                                                deviceAdded: !!admit.added,
                                                video: mapVideo(video, access, prog && prog.position_sec)
                                            });
                                        });
                                    }
                                );
                            });
                        });
                    });
                });
            }, settings);
            });
        });
    });

    app.post('/api/doctor/videos/:id/progress', (req, res) => {
        const userId = uid(req.body && req.body.userId);
        const id = parseInt(req.params.id, 10);
        const token = String((req.body && req.body.token) || '');
        const pos = Number(req.body && req.body.positionSec);
        if (!userId || !Number.isInteger(id)) return res.status(400).json({ error: 'userId and video are required' });
        loadSession(db, token, (err, session) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!session || session.user_id !== userId || session.video_id !== id) return res.status(410).json({ error: 'session_ended' });
            trackHeartbeat(db, session, req, Number.isFinite(pos) && pos >= 0 ? pos : null);
            if (!Number.isFinite(pos) || pos < 0) return res.json({ ok: true });
            db.get(`SELECT id FROM video_progress WHERE user_id = ? AND video_id = ?`, [userId, id], (gErr, row) => {
                if (gErr) return res.status(500).json({ error: gErr.message });
                const sql = row
                    ? `UPDATE video_progress SET position_sec = ?, updated_at = ? WHERE id = ?`
                    : `INSERT INTO video_progress (position_sec, updated_at, user_id, video_id) VALUES (?, ?, ?, ?)`;
                const params = row ? [pos, nowIso(), row.id] : [pos, nowIso(), userId, id];
                db.run(sql, params, (wErr) => (wErr ? res.status(500).json({ error: wErr.message }) : res.json({ ok: true })));
            });
        });
    });

    app.post('/api/doctor/videos/:id/session/end', (req, res) => {
        const token = String((req.body && req.body.token) || '');
        if (!/^[a-f0-9]{48}$/.test(token)) return res.json({ ok: true });
        db.get(`SELECT id, user_id, video_id, device_id, last_position_sec FROM video_sessions WHERE token = ? AND revoked_at IS NULL`, [token], (err, s) => {
            if (s) logWatch(db, { userId: s.user_id, videoId: s.video_id, sessionId: s.id, deviceId: s.device_id, ip: clientIp(req), event: 'end', positionSec: s.last_position_sec });
            db.run(`UPDATE video_sessions SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL`, [nowIso(), token], () => res.json({ ok: true }));
        });
    });

    app.get('/api/doctor/videos/payment-options', (req, res) => {
        if (!listDoctorPaymentOptions) return res.json([]);
        listDoctorPaymentOptions((err, options) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json((options || []).filter((o) => o.id === 'dqr' || o.gateway === 'razorpay'));
        });
    });

    app.post('/api/doctor/videos/purchase', (req, res) => {
        const body = req.body || {};
        const userId = uid(body.userId);
        const videoId = body.videoId != null ? parseInt(body.videoId, 10) : null;
        const year = parseYear(body.year);
        const mid = String(body.mid || '');
        if (!userId) return res.status(400).json({ error: 'userId is required' });
        if (!videoId && !year) return res.status(400).json({ error: 'Choose a video or a seminar year.' });
        const loadTarget = (cb) => {
            if (videoId) {
                return db.get(`SELECT * FROM video_items WHERE id = ? AND published = 1 AND status = 'ready'`, [videoId], (err, v) => {
                    if (err) return cb(err);
                    if (!v) return cb(null, null);
                    cb(null, { year: v.year, videoId: v.id, amount: Number(v.price_inr) || 0, label: v.title, video: v });
                });
            }
            db.get(`SELECT * FROM video_years WHERE year = ?`, [year], (err, y) => {
                if (err) return cb(err);
                if (!y || y.bundle_price_inr == null) return cb(null, null);
                cb(null, { year, videoId: null, amount: Number(y.bundle_price_inr) || 0, label: y.title || 'Seminar ' + year + ' videos', video: { id: 0, year, seminar_id: null } });
            });
        };
        loadTarget((tErr, target) => {
            if (tErr) return res.status(500).json({ error: tErr.message });
            if (!target) return res.status(404).json({ error: 'That item is not for sale.' });
            if (!(target.amount >= 1)) return res.status(400).json({ error: 'This item has no price set. Ask the seminar office to enable it for you.' });
            resolveAccess(db, userId, target.video, (aErr, access) => {
                if (aErr) return res.status(500).json({ error: aErr.message });
                if (access.allowed) return res.status(400).json({ error: 'You already have access to this.' });
                db.all(`SELECT * FROM payment_gateways`, [], (eGw, gwRows) => {
                    if (eGw) return res.status(500).json({ error: eGw.message });
                    const rzDqr = mid === 'dqr' ? adminPaymentFlow.pickRazorpayGateway(gwRows) : null;
                    const resolved = mid === 'dqr' ? null : paymentGatewayOptions.resolvePaymentOption(mid, gwRows);
                    if (mid === 'dqr' && !rzDqr) return res.status(400).json({ error: 'UPI QR is not configured. Use another method.' });
                    if (mid !== 'dqr' && (!resolved || resolved.gateway !== 'razorpay')) {
                        return res.status(400).json({ error: 'Choose Razorpay or UPI QR. Other methods are not available for videos.' });
                    }
                    const orderStr = 'VID' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
                    db.run(
                        `INSERT INTO orders (order_id_string, registration_id, amount, status) VALUES (?, NULL, ?, 'pending')`,
                        [orderStr, target.amount],
                        function (oErr) {
                            if (oErr) return res.status(500).json({ error: oErr.message });
                            const orderDbId = this.lastID;
                            db.run(
                                `INSERT INTO video_purchases (user_id, year, video_id, amount_inr, order_id, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
                                [userId, target.year, target.videoId, target.amount, orderDbId, nowIso()],
                                function (pErr) {
                                    if (pErr) return res.status(500).json({ error: pErr.message });
                                    const purchaseId = this.lastID;
                                    if (rzDqr) {
                                        return adminPaymentFlow.createRazorpayDqr(rzDqr, { amountRupee: target.amount, orderIdStr: orderStr, applicationNo: orderStr }, (dErr, dqr) => {
                                            if (dErr) return res.status(400).json({ error: dErr.message });
                                            db.run(`UPDATE orders SET payment_gateway = ?, provider_order_id = ? WHERE id = ?`, [dqr.gatewayTag, dqr.qrId, orderDbId], () =>
                                                res.json({
                                                    success: true,
                                                    paid: false,
                                                    paymentType: 'dqr',
                                                    purchaseId,
                                                    orderDbId,
                                                    amount: target.amount,
                                                    qrImageUrl: dqr.imageUrl,
                                                    qrShortUrl: dqr.shortUrl,
                                                    pollRequired: true,
                                                    message: 'Scan the UPI QR to pay. Access opens as soon as the payment is seen.'
                                                })
                                            );
                                        });
                                    }
                                    const rz = new Razorpay({ key_id: resolved.config.key_id, key_secret: resolved.config.key_secret });
                                    const gwTag = resolved.mode === 'live' ? 'razorpay_live' : resolved.mode === 'test' ? 'razorpay_test' : 'razorpay';
                                    adminPaymentFlow.createRazorpayOrder(rz, { amount: Math.round(target.amount * 100), currency: 'INR', receipt: orderStr.slice(0, 40) }, (rzErr, rzOrder) => {
                                        if (rzErr) return res.status(400).json({ error: adminPaymentFlow.razorpayErrorMessage(rzErr, 'Razorpay order failed') });
                                        db.run(`UPDATE orders SET payment_gateway = ?, provider_order_id = ? WHERE id = ?`, [gwTag, rzOrder.id, orderDbId], (uErr) => {
                                            if (uErr) return res.status(500).json({ error: uErr.message });
                                            res.json({
                                                success: true,
                                                paid: false,
                                                paymentType: 'razorpay_checkout',
                                                gateway: 'razorpay',
                                                mode: resolved.mode,
                                                keyId: resolved.config.key_id,
                                                razorpayOrder: rzOrder,
                                                purchaseId,
                                                orderDbId,
                                                amount: target.amount,
                                                label: target.label,
                                                pollRequired: true
                                            });
                                        });
                                    });
                                }
                            );
                        }
                    );
                });
            });
        });
    });

    const loadPurchase = (purchaseId, userId, cb) =>
        db.get(
            `SELECT p.*, o.payment_gateway, o.provider_order_id, o.amount, o.status AS order_status
             FROM video_purchases p JOIN orders o ON o.id = p.order_id WHERE p.id = ? AND p.user_id = ?`,
            [purchaseId, userId],
            cb
        );

    app.post('/api/doctor/videos/purchase/:id/verify', (req, res) => {
        const body = req.body || {};
        const userId = uid(body.userId);
        const purchaseId = parseInt(req.params.id, 10);
        if (!userId || !Number.isInteger(purchaseId)) return res.status(400).json({ error: 'userId and purchase are required' });
        if (!body.razorpay_order_id || !body.razorpay_payment_id || !body.razorpay_signature) return res.status(400).json({ error: 'Payment details are incomplete.' });
        loadPurchase(purchaseId, userId, (err, purchase) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
            if (purchase.provider_order_id !== body.razorpay_order_id) return res.status(400).json({ error: 'Payment does not match this purchase.' });
            db.all(`SELECT * FROM payment_gateways WHERE is_active = 1`, [], (eG, gwRows) => {
                if (eG) return res.status(500).json({ error: eG.message });
                const opt = razorpayFor(gwRows, purchase.payment_gateway);
                if (!opt) return res.status(400).json({ error: 'Razorpay is not configured.' });
                if (!verifyRazorpaySignature(body.razorpay_order_id, body.razorpay_payment_id, body.razorpay_signature, opt.config.key_secret)) {
                    return res.status(400).json({ error: 'Payment signature is invalid.' });
                }
                fulfillPurchase(db, purchase, purchase.payment_gateway, body.razorpay_payment_id, (fErr) => {
                    if (fErr) return res.status(500).json({ error: fErr.message });
                    res.json({ success: true, paid: true, message: 'Payment received. The video is unlocked.' });
                });
            });
        });
    });

    app.get('/api/doctor/videos/purchase/:id/status', (req, res) => {
        const userId = uid(req.query.userId);
        const purchaseId = parseInt(req.params.id, 10);
        if (!userId || !Number.isInteger(purchaseId)) return res.status(400).json({ error: 'userId and purchase are required' });
        loadPurchase(purchaseId, userId, (err, purchase) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
            if (purchase.status === 'paid' || purchase.order_status === 'success') {
                return fulfillPurchase(db, purchase, purchase.payment_gateway, null, () => res.json({ paid: true }));
            }
            pollPurchase(db, purchase, purchase, (pErr, hit) => {
                if (pErr) return res.status(500).json({ error: pErr.message });
                if (!hit) return res.json({ paid: false });
                fulfillPurchase(db, purchase, hit.gateway, hit.txnId, (fErr) => {
                    if (fErr) return res.status(500).json({ error: fErr.message });
                    res.json({ paid: true });
                });
            });
        });
    });

    /* ----- streaming ----- */

    app.get('/video-stream/:token/index.m3u8', (req, res) => {
        loadSession(db, req.params.token, (err, session) => {
            if (err) return res.status(500).end();
            if (!session) return res.status(403).end();
            const serve = (rErr, text) => {
                if (rErr || !text) return res.status(404).end();
                const base = '/video-stream/' + session.token + '/';
                const keyUrl = base + 'key?lic=' + encodeURIComponent(licenseQuery(session.token, session.device_id || ''));
                const out = text
                    .split('\n')
                    .map((line) => {
                        if (line.startsWith('#EXT-X-KEY')) return line.replace(/URI="[^"]*"/, 'URI="' + keyUrl + '"');
                        if (line && !line.startsWith('#')) return base + 'seg/' + path.basename(line.trim());
                        return line;
                    })
                    .join('\n');
                touchSession(db, session.id);
                setPlayCookie(req, res, session);
                noStore(res, 'application/vnd.apple.mpegurl');
                res.send(out);
            };
            if (session.playlist_m3u8) return serve(null, session.playlist_m3u8);
            fs.readFile(path.join(session.hls_dir || '', 'index.m3u8'), 'utf8', serve);
        });
    });

    app.get('/video-stream/:token/key', (req, res) => {
        loadSession(db, req.params.token, (err, session) => {
            if (err) return res.status(500).end();
            if (!session || !session.key_hex) return res.status(403).end();
            if (!licenseQueryOk(req.query && req.query.lic, session.token, session.device_id || '')) return res.status(403).end();
            if (!playbackAuthorized(req, session)) return res.status(403).end();
            noStore(res, 'application/octet-stream');
            res.send(Buffer.from(session.key_hex, 'hex'));
        });
    });

    app.get('/video-stream/:token/seg/:name', (req, res) => {
        const name = String(req.params.name || '');
        if (!SEG_NAME.test(name)) return res.status(404).end();
        loadSession(db, req.params.token, (err, session) => {
            if (err) return res.status(500).end();
            if (!session) return res.status(403).end();
            if (!playbackAuthorized(req, session)) return res.status(403).end();
            if (session.storage === 'r2' && session.storage_prefix) return streamSegmentFromR2(session.storage_prefix, name, req, res);
            const file = path.join(session.hls_dir, name);
            fs.stat(file, (sErr, st) => {
                if (sErr || !st.isFile()) return res.status(404).end();
                noStore(res, 'video/MP2T');
                res.setHeader('Accept-Ranges', 'bytes');
                const range = String(req.headers.range || '').match(/^bytes=(\d*)-(\d*)$/);
                let start = 0;
                let end = st.size - 1;
                if (range) {
                    if (range[1]) start = parseInt(range[1], 10);
                    if (range[2]) end = parseInt(range[2], 10);
                    if (!range[1] && range[2]) {
                        start = Math.max(0, st.size - parseInt(range[2], 10));
                        end = st.size - 1;
                    }
                    if (!(start <= end && end < st.size)) {
                        res.setHeader('Content-Range', 'bytes */' + st.size);
                        return res.status(416).end();
                    }
                    res.status(206);
                    res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + st.size);
                }
                res.setHeader('Content-Length', end - start + 1);
                fs.createReadStream(file, { start, end }).on('error', () => res.end()).pipe(res);
            });
        });
    });

    /* ----- admin ----- */

    const adminVideoRow = (row) => Object.assign(mapVideo(row, null, null), {
        processProgress: row.process_progress != null ? Number(row.process_progress) : null,
        processLog: row.process_log || '',
        segmentCount: row.segment_count || null,
        sourceName: row.source_name || '',
        hasSource: !!row.source_path,
        storage: row.storage || (row.hls_dir ? 'local' : ''),
        createdAt: row.created_at,
        updatedAt: row.updated_at
    });

    app.get('/api/admin/videos', admin, (req, res) => {
        db.all(`SELECT v.*, s.title AS seminar_title FROM video_items v LEFT JOIN seminars s ON s.id = v.seminar_id ORDER BY v.year DESC, v.sort_order ASC, CASE WHEN v.kind = 'full' THEN 0 ELSE 1 END, v.part_no ASC, v.id ASC`, [], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            db.all(`SELECT * FROM video_years ORDER BY year DESC`, [], (eY, years) => {
                if (eY) return res.status(500).json({ error: eY.message });
                db.all(`SELECT id, title, portal_year, event_date FROM seminars ORDER BY event_date DESC, id DESC`, [], (eS, seminars) => {
                    if (eS) return res.status(500).json({ error: eS.message });
                    loadSettings(db, (eSet, settings) => {
                        if (eSet) return res.status(500).json({ error: eSet.message });
                        checkTools((tools) =>
                            diskFree((disk) =>
                                cloudStatus((cloud) =>
                                    res.json({
                                        videos: (rows || []).map(adminVideoRow),
                                        years: (years || []).map((y) => ({
                                            year: y.year,
                                            title: y.title || '',
                                            description: y.description || '',
                                            themeBrief: y.theme_brief || '',
                                            themeAccent: /^#[0-9a-fA-F]{6}$/.test(y.theme_accent || '') ? y.theme_accent : '',
                                            themeSource: y.theme_source || '',
                                            bundlePriceInr: y.bundle_price_inr != null ? Number(y.bundle_price_inr) : null
                                        })),
                                        seminars: (seminars || []).map((s) => ({ id: s.id, title: s.title, year: s.portal_year || (s.event_date ? new Date(s.event_date).getFullYear() : null) })),
                                        tools: Object.assign({}, tools, { storageDir: ROOT, inboxDir: path.join(ROOT, 'inbox'), chunkBytes: CHUNK_BYTES, disk }),
                                        settings,
                                        cloud,
                                        processing: { running, queued: queue.slice() }
                                    })
                                )
                            )
                        );
                    });
                });
            });
        });
    });

    app.put('/api/admin/videos/settings', admin, (req, res) => {
        const b = req.body || {};
        const tasks = [];
        if (b.maxDevices != null) {
            const n = parseInt(b.maxDevices, 10);
            if (!(n >= 1 && n <= 10)) return res.status(400).json({ error: 'Devices per account must be between 1 and 10.' });
            tasks.push(['max_devices', String(n)]);
        }
        if (b.volunteersFree != null) tasks.push(['volunteers_free', b.volunteersFree === true || b.volunteersFree === 'true' || b.volunteersFree === 1 || b.volunteersFree === '1' ? '1' : '0']);
        if (b.storageBackend != null) {
            const backend = b.storageBackend === 'r2' ? 'r2' : 'local';
            if (backend === 'r2' && !r2.isR2Configured()) return res.status(400).json({ error: 'Cloud storage is not configured on this server (R2 environment variables are missing).' });
            tasks.push(['storage_backend', backend]);
        }
        let i = 0;
        const next = (err) => {
            if (err) return res.status(500).json({ error: err.message });
            if (i >= tasks.length) {
                return loadSettings(db, (e2, settings) => {
                    if (e2) return res.status(500).json({ error: e2.message });
                    if (settings.storageBackend === 'r2' && r2.isR2Configured()) offloadReadyVideos(db);
                    res.json({ ok: true, settings });
                });
            }
            const [k, v] = tasks[i++];
            saveSetting(db, k, v, next);
        };
        next();
    });

    /* who can watch: every account with access to a year (or one video), and those still to pay */

    app.get('/api/admin/videos/eligible', admin, (req, res) => {
        const year = parseYear(req.query.year);
        const videoId = req.query.videoId ? numId(req.query.videoId) : null;
        if (!year) return res.status(400).json({ error: 'Choose a year.' });
        const q = cleanText(req.query.q, 80).toLowerCase();
        const finishVideo = (video) => {
            loadSettings(db, (sErr, settings) => {
                if (sErr) return res.status(500).json({ error: sErr.message });
                // Candidates: anyone registered for the year/seminar, volunteers, grants, purchases, and anyone who ever opened a video.
                const seminarCond = video.seminar_id ? 's.id = ?' : `(s.portal_year = ? OR ${yearExpr('s')} = ?)`;
                const seminarParams = video.seminar_id ? [video.seminar_id] : [year, year];
                db.all(
                    `SELECT DISTINCT u.id, u.first_name, u.middle_name, u.last_name, u.email, u.phone, u.user_id_string, u.doctor_category
                     FROM users u
                     WHERE LOWER(COALESCE(u.role, '')) <> 'admin' AND (
                        u.id IN (SELECT r.user_id FROM registrations r JOIN seminars s ON s.id = r.seminar_id WHERE ${seminarCond})
                        OR LOWER(COALESCE(u.doctor_category, '')) = 'volunteer'
                        OR u.id IN (SELECT a.user_id FROM video_access a WHERE a.year = ? AND a.revoked_at IS NULL)
                        OR u.id IN (SELECT p.user_id FROM video_purchases p WHERE p.year = ?)
                     )
                     ORDER BY u.last_name, u.first_name, u.id LIMIT 3000`,
                    [...seminarParams, year, year],
                    (err, users) => {
                        if (err) return res.status(500).json({ error: err.message });
                        db.all(
                            `SELECT l.user_id, l.license_id, l.device_limit,
                                    (SELECT COUNT(*) FROM video_devices d WHERE d.user_id = l.user_id AND d.revoked_at IS NULL) AS devices,
                                    (SELECT MAX(s.last_seen_at) FROM video_sessions s WHERE s.user_id = l.user_id) AS last_watch,
                                    (SELECT s.last_ip FROM video_sessions s WHERE s.user_id = l.user_id ORDER BY s.id DESC LIMIT 1) AS last_ip,
                                    (SELECT COALESCE(SUM(s.watch_seconds), 0) FROM video_sessions s WHERE s.user_id = l.user_id) AS watch_seconds
                             FROM video_licenses l`,
                            [],
                            (eL, licenses) => {
                                if (eL) return res.status(500).json({ error: eL.message });
                                const byUser = {};
                                (licenses || []).forEach((l) => (byUser[l.user_id] = l));
                                const list = (users || []).filter((u) => !q || [u.first_name, u.last_name, u.email, u.phone, u.user_id_string, byUser[u.id] && byUser[u.id].license_id].join(' ').toLowerCase().includes(q));
                                const out = [];
                                let i = 0;
                                const next = () => {
                                    if (i >= list.length) {
                                        return res.json({
                                            year,
                                            video: videoId ? { id: video.id, title: video.title } : null,
                                            counts: {
                                                allowed: out.filter((r) => r.allowed).length,
                                                pending: out.filter((r) => !r.allowed && r.checks.registered).length,
                                                other: out.filter((r) => !r.allowed && !r.checks.registered).length
                                            },
                                            rows: out
                                        });
                                    }
                                    const u = list[i++];
                                    resolveAccess(db, u.id, video, (aErr, access) => {
                                        if (aErr) return res.status(500).json({ error: aErr.message });
                                        const lic = byUser[u.id] || {};
                                        out.push({
                                            userId: u.id,
                                            user: userDisplay(u),
                                            userIdString: u.user_id_string || '',
                                            email: u.email || '',
                                            phone: u.phone || '',
                                            volunteer: String(u.doctor_category || '').toLowerCase() === 'volunteer',
                                            license: lic.license_id ? formatLicense(lic.license_id) : '',
                                            allowed: access.allowed,
                                            reason: access.reason,
                                            detail: access.detail || '',
                                            checks: access.checks,
                                            devices: Number(lic.devices) || 0,
                                            deviceLimit: lic.device_limit || null,
                                            lastWatchedAt: lic.last_watch || null,
                                            lastIp: lic.last_ip || '',
                                            watchSeconds: Number(lic.watch_seconds) || 0
                                        });
                                        next();
                                    }, settings);
                                };
                                next();
                            }
                        );
                    }
                );
            });
        };
        if (videoId) {
            return db.get(`SELECT * FROM video_items WHERE id = ?`, [videoId], (err, v) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!v) return res.status(404).json({ error: 'Video not found' });
                finishVideo(v);
            });
        }
        finishVideo({ id: null, year, seminar_id: null, title: '' });
    });

    /* devices and account tracking */

    const sessionRow = (s) => ({
        id: s.id,
        userId: s.user_id,
        user: userDisplay(s),
        userIdString: s.user_id_string || '',
        videoId: s.video_id,
        videoTitle: s.video_title || '',
        device: s.device_label || '',
        deviceId: s.device_id ? String(s.device_id).slice(0, 8) : '',
        license: formatLicense(s.license_id),
        ip: s.ip || '',
        lastIp: s.last_ip || '',
        ipChanges: Number(s.ip_changes) || 0,
        watchSeconds: Number(s.watch_seconds) || 0,
        startedAt: s.created_at,
        lastSeenAt: s.last_seen_at,
        endedAt: s.revoked_at,
        active: !s.revoked_at && (!s.expires_at || Date.parse(s.expires_at) > Date.now())
    });

    app.get('/api/admin/videos/tracking', admin, (req, res) => {
        const userId = req.query.userId ? numId(req.query.userId) : null;
        const where = userId ? 'WHERE s.user_id = ?' : '';
        const params = userId ? [userId] : [];
        db.all(
            `SELECT s.*, u.first_name, u.middle_name, u.last_name, u.email, u.user_id_string, v.title AS video_title, d.label AS device_label
             FROM video_sessions s
             LEFT JOIN users u ON u.id = s.user_id
             LEFT JOIN video_items v ON v.id = s.video_id
             LEFT JOIN video_devices d ON d.user_id = s.user_id AND d.device_id = s.device_id
             ${where} ORDER BY s.id DESC LIMIT ${userId ? 200 : 150}`,
            params,
            (err, sessions) => {
                if (err) return res.status(500).json({ error: err.message });
                const respond = (devices, log, license, user) =>
                    res.json({
                        user: user ? { id: user.id, name: userDisplay(user), userIdString: user.user_id_string || '', email: user.email || '', phone: user.phone || '', volunteer: String(user.doctor_category || '').toLowerCase() === 'volunteer' } : null,
                        license: license ? { id: formatLicense(license.license_id), deviceLimit: license.device_limit || null, createdAt: license.created_at } : null,
                        devices: (devices || []).map((d) => ({ id: d.id, label: d.label || 'Device', shortId: String(d.device_id).slice(0, 8), firstIp: d.first_ip || '', lastIp: d.last_ip || '', firstSeenAt: d.first_seen_at, lastSeenAt: d.last_seen_at, revokedAt: d.revoked_at })),
                        sessions: (sessions || []).map(sessionRow),
                        log: (log || []).map((l) => ({ id: l.id, event: l.event, detail: l.detail || '', ip: l.ip || '', deviceId: l.device_id ? String(l.device_id).slice(0, 8) : '', videoTitle: l.video_title || '', positionSec: l.position_sec != null ? Number(l.position_sec) : null, at: l.created_at })),
                        flags: accountFlags(sessions || [], devices || [])
                    });
                if (!userId) {
                    return db.all(
                        `SELECT d.*, u.first_name, u.last_name, u.user_id_string FROM video_devices d LEFT JOIN users u ON u.id = d.user_id ORDER BY d.id DESC LIMIT 150`,
                        [],
                        (eD, devices) => (eD ? res.status(500).json({ error: eD.message }) : respond(devices, [], null, null))
                    );
                }
                db.get(`SELECT id, first_name, middle_name, last_name, email, phone, user_id_string, doctor_category FROM users WHERE id = ?`, [userId], (eU, user) => {
                    if (eU) return res.status(500).json({ error: eU.message });
                    db.all(`SELECT * FROM video_devices WHERE user_id = ? ORDER BY id ASC`, [userId], (eD, devices) => {
                        if (eD) return res.status(500).json({ error: eD.message });
                        db.all(`SELECT l.*, v.title AS video_title FROM video_watch_log l LEFT JOIN video_items v ON v.id = l.video_id WHERE l.user_id = ? ORDER BY l.id DESC LIMIT 200`, [userId], (eLog, log) => {
                            if (eLog) return res.status(500).json({ error: eLog.message });
                            db.get(`SELECT * FROM video_licenses WHERE user_id = ?`, [userId], (eLic, license) => {
                                if (eLic) return res.status(500).json({ error: eLic.message });
                                respond(devices, log, license, user);
                            });
                        });
                    });
                });
            }
        );
    });

    function accountFlags(sessions, devices) {
        const flags = [];
        const ipChanges = sessions.reduce((n, s) => n + (Number(s.ip_changes) || 0), 0);
        if (ipChanges) flags.push(ipChanges + ' IP change' + (ipChanges === 1 ? '' : 's') + ' during playback');
        const ips = new Set(sessions.map((s) => s.last_ip || s.ip).filter(Boolean));
        if (ips.size >= 4) flags.push('Played from ' + ips.size + ' different IP addresses');
        const active = devices.filter((d) => !d.revoked_at).length;
        if (active >= 3) flags.push(active + ' devices registered');
        const dayMs = 24 * 3600 * 1000;
        const recentNew = devices.filter((d) => d.first_seen_at && Date.now() - Date.parse(d.first_seen_at) < 7 * dayMs).length;
        if (recentNew >= 2) flags.push(recentNew + ' new devices in the last 7 days');
        return flags;
    }

    app.post('/api/admin/videos/devices/:id/revoke', admin, (req, res) => {
        const id = numId(req.params.id);
        if (!id) return res.status(404).json({ error: 'Device not found' });
        db.get(`SELECT * FROM video_devices WHERE id = ?`, [id], (err, d) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!d) return res.status(404).json({ error: 'Device not found' });
            db.run(`UPDATE video_devices SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL`, [nowIso(), req.adminId, id], (uErr) => {
                if (uErr) return res.status(500).json({ error: uErr.message });
                // Playback on that device stops at the next heartbeat.
                db.run(`UPDATE video_sessions SET revoked_at = ? WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL`, [nowIso(), d.user_id, d.device_id], () => {
                    logWatch(db, { userId: d.user_id, deviceId: d.device_id, ip: clientIp(req), event: 'device_removed', detail: 'by admin #' + req.adminId });
                    res.json({ ok: true });
                });
            });
        });
    });

    app.post('/api/admin/videos/devices/:id/restore', admin, (req, res) => {
        const id = numId(req.params.id);
        if (!id) return res.status(404).json({ error: 'Device not found' });
        db.run(`UPDATE video_devices SET revoked_at = NULL, revoked_by = NULL WHERE id = ?`, [id], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ok: true, changed: this.changes });
        });
    });

    app.post('/api/admin/videos/users/:userId/device-limit', admin, (req, res) => {
        const userId = numId(req.params.userId);
        if (!userId) return res.status(404).json({ error: 'User not found' });
        const raw = req.body && req.body.limit;
        const limit = raw === '' || raw == null ? null : parseInt(raw, 10);
        if (limit != null && !(limit >= 1 && limit <= 10)) return res.status(400).json({ error: 'Device limit must be between 1 and 10, or blank for the default.' });
        ensureLicense(db, userId, (err) => {
            if (err) return res.status(500).json({ error: err.message });
            db.run(`UPDATE video_licenses SET device_limit = ? WHERE user_id = ?`, [limit, userId], (uErr) => (uErr ? res.status(500).json({ error: uErr.message }) : res.json({ ok: true, limit })));
        });
    });

    app.post('/api/admin/videos/:id/offload', admin, (req, res) => {
        const id = numId(req.params.id);
        if (!id) return res.status(404).json({ error: 'Video not found' });
        if (!r2.isR2Configured()) return res.status(400).json({ error: 'Cloud storage is not configured on this server.' });
        offloadToR2(db, id, (err, moved) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ok: true, moved: !!moved });
        });
    });

    function readVideoBody(body, existing) {
        const b = body || {};
        const year = parseYear(b.year != null ? b.year : existing && existing.year);
        const title = cleanText(b.title != null ? b.title : existing && existing.title, 200);
        const kind = KINDS.includes(b.kind) ? b.kind : (existing && existing.kind) || 'episode';
        const partRaw = b.partNo != null ? b.partNo : existing && existing.part_no;
        const partNo = kind === 'episode' && partRaw !== '' && partRaw != null ? parseInt(partRaw, 10) : null;
        const price = parsePrice(b.priceInr != null ? b.priceInr : existing && existing.price_inr);
        const seminarRaw = b.seminarId != null ? b.seminarId : existing && existing.seminar_id;
        const seminarId = seminarRaw === '' || seminarRaw == null ? null : parseInt(seminarRaw, 10);
        if (!year) return { error: 'Choose the seminar year.' };
        if (!(Number.isInteger(seminarId) && seminarId > 0)) return { error: 'Choose the seminar this video belongs to.' };
        if (!title) return { error: 'Give the video a title.' };
        if (price == null) return { error: 'Price must be a number of rupees (0 for free).' };
        if (kind === 'episode' && partNo != null && !(Number.isInteger(partNo) && partNo > 0)) return { error: 'Part number must be a positive whole number.' };
        return {
            year,
            seminar_id: seminarId,
            title,
            description: cleanText(b.description != null ? b.description : existing && existing.description, 2000),
            kind,
            part_no: partNo,
            price_inr: price,
            published: b.published != null ? (b.published === true || b.published === 1 || b.published === '1' || b.published === 'true' ? 1 : 0) : existing ? existing.published : 0,
            sort_order: b.sortOrder != null ? parseInt(b.sortOrder, 10) || 0 : existing ? existing.sort_order : 0
        };
    }

    function seminarYearOf(row) {
        if (!row) return null;
        const portal = parseInt(row.portal_year, 10);
        if (Number.isInteger(portal) && portal >= 2000 && portal <= 2100) return portal;
        const match = String(row.event_date || '').match(/^(\d{4})/);
        return match ? parseInt(match[1], 10) : null;
    }

    function withSeminar(v, cb) {
        db.get(`SELECT id, title, portal_year, event_date FROM seminars WHERE id = ?`, [v.seminar_id], (err, row) => {
            if (err) return cb(err);
            if (!row) return cb(Object.assign(new Error('Choose a seminar that exists.'), { status: 400 }));
            const sy = seminarYearOf(row);
            if (sy && sy !== v.year) return cb(Object.assign(new Error('That seminar is not in ' + v.year + '. Choose the matching year.'), { status: 400 }));
            cb(null, row);
        });
    }

    app.post('/api/admin/videos', admin, (req, res) => {
        const v = readVideoBody(req.body, null);
        if (v.error) return res.status(400).json({ error: v.error });
        withSeminar(v, (sErr) => {
            if (sErr) return res.status(sErr.status || 500).json({ error: sErr.message });
        db.run(
            `INSERT INTO video_items (year, seminar_id, title, description, kind, part_no, price_inr, published, status, sort_order, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
            [v.year, v.seminar_id, v.title, v.description, v.kind, v.part_no, v.price_inr, v.published, v.sort_order, req.adminId, nowIso(), nowIso()],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                db.get(`SELECT * FROM video_items WHERE id = ?`, [this.lastID], (e2, row) => (e2 ? res.status(500).json({ error: e2.message }) : res.json({ video: adminVideoRow(row) })));
            }
        );
        });
    });

    app.put('/api/admin/videos/:id', admin, (req, res) => {
        const id = numId(req.params.id);
        if (!id) return res.status(404).json({ error: 'Video not found' });
        db.get(`SELECT * FROM video_items WHERE id = ?`, [id], (err, existing) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!existing) return res.status(404).json({ error: 'Video not found' });
            const v = readVideoBody(req.body, existing);
            if (v.error) return res.status(400).json({ error: v.error });
            if (v.published && existing.status !== 'ready') return res.status(400).json({ error: 'Upload and process the video before publishing it.' });
            withSeminar(v, (sErr) => {
            if (sErr) return res.status(sErr.status || 500).json({ error: sErr.message });
            updateVideo(db, id, v, (uErr) => {
                if (uErr) return res.status(500).json({ error: uErr.message });
                db.get(`SELECT * FROM video_items WHERE id = ?`, [id], (e2, row) => (e2 ? res.status(500).json({ error: e2.message }) : res.json({ video: adminVideoRow(row) })));
            });
            });
        });
    });

    app.delete('/api/admin/videos/:id', admin, (req, res) => {
        const id = numId(req.params.id);
        if (!id) return res.status(404).json({ error: 'Video not found' });
        db.get(`SELECT * FROM video_items WHERE id = ?`, [id], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!row) return res.status(404).json({ error: 'Video not found' });
            if (running === id) return res.status(409).json({ error: 'This video is being processed. Wait for it to finish.' });
            if (row.storage === 'r2' && row.storage_prefix) deleteR2Prefix(row.storage_prefix).catch((e) => console.warn('[video-library] cloud delete:', e.message));
            rmrf(path.join(ROOT, 'hls', String(id)));
            rmrf(path.join(ROOT, 'sources', String(id)));
            db.run(`DELETE FROM video_sessions WHERE video_id = ?`, [id], () =>
                db.run(`DELETE FROM video_uploads WHERE video_id = ?`, [id], () =>
                    db.run(`DELETE FROM video_progress WHERE video_id = ?`, [id], () =>
                        db.run(`UPDATE video_access SET revoked_at = ? WHERE video_id = ? AND revoked_at IS NULL`, [nowIso(), id], () =>
                            db.run(`DELETE FROM video_items WHERE id = ?`, [id], (dErr) => (dErr ? res.status(500).json({ error: dErr.message }) : res.json({ ok: true })))
                        )
                    )
                )
            );
        });
    });

    app.put('/api/admin/videos/years/:year', admin, (req, res) => {
        const year = parseYear(req.params.year);
        if (!year) return res.status(400).json({ error: 'Invalid year' });
        const b = req.body || {};
        const price = b.bundlePriceInr === '' || b.bundlePriceInr == null ? null : parsePrice(b.bundlePriceInr);
        if (b.bundlePriceInr !== '' && b.bundlePriceInr != null && price == null) return res.status(400).json({ error: 'Bundle price must be a number of rupees.' });
        const title = cleanText(b.title, 200);
        const description = cleanText(b.description, 2000);
        db.get(`SELECT id FROM video_years WHERE year = ?`, [year], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            const sql = row
                ? `UPDATE video_years SET title = ?, description = ?, bundle_price_inr = ?, updated_at = ? WHERE id = ?`
                : `INSERT INTO video_years (title, description, bundle_price_inr, updated_at, year, created_at) VALUES (?, ?, ?, ?, ?, ?)`;
            const params = row ? [title, description, price, nowIso(), row.id] : [title, description, price, nowIso(), year, nowIso()];
            db.run(sql, params, (wErr) => (wErr ? res.status(500).json({ error: wErr.message }) : res.json({ ok: true, year, title, description, bundlePriceInr: price })));
        });
    });

    app.post('/api/admin/videos/years/:year/theme', admin, async (req, res) => {
        const year = parseYear(req.params.year);
        if (!year) return res.status(400).json({ error: 'Invalid year' });
        const brief = cleanText(req.body && req.body.brief, 2000);
        if (!brief || brief.length < 8) return res.status(400).json({ error: 'Describe the theme in a sentence or two.' });
        let theme;
        try {
            theme = await videoTheme.suggestYearTheme(year, brief);
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
        db.get(`SELECT id FROM video_years WHERE year = ?`, [year], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            const sql = row
                ? `UPDATE video_years SET title = ?, description = ?, theme_brief = ?, theme_accent = ?, theme_source = ?, updated_at = ? WHERE id = ?`
                : `INSERT INTO video_years (title, description, theme_brief, theme_accent, theme_source, updated_at, year, created_at, bundle_price_inr) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`;
            const params = row
                ? [theme.title, theme.description, brief, theme.accent, theme.source, nowIso(), row.id]
                : [theme.title, theme.description, brief, theme.accent, theme.source, nowIso(), year, nowIso()];
            db.run(sql, params, (wErr) => {
                if (wErr) return res.status(500).json({ error: wErr.message });
                res.json({ ok: true, year, title: theme.title, description: theme.description, accent: theme.accent, source: theme.source });
            });
        });
    });

    /* uploads: chunked and resumable */

    app.post('/api/admin/videos/:id/upload/start', admin, (req, res) => {
        const id = numId(req.params.id);
        const body = req.body || {};
        const total = Number(body.totalBytes);
        if (!id) return res.status(404).json({ error: 'Video not found' });
        const fileName = cleanText(body.fileName, 200) || 'video';
        if (!(total > 0)) return res.status(400).json({ error: 'File size is required' });
        db.get(`SELECT * FROM video_items WHERE id = ?`, [id], (err, video) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!video) return res.status(404).json({ error: 'Video not found' });
            if (video.status === 'processing') return res.status(409).json({ error: 'This video is being processed.' });
            const resumeId = String(body.uploadId || '');
            const start = () => {
                const uploadId = crypto.randomBytes(16).toString('hex');
                const temp = path.join(dir('uploads'), uploadId + '.part');
                fs.writeFileSync(temp, '');
                db.run(
                    `INSERT INTO video_uploads (upload_id, video_id, file_name, total_bytes, received_bytes, chunk_bytes, chunks_done, status, temp_path, created_by, created_at, updated_at)
                     VALUES (?, ?, ?, ?, 0, ?, 0, 'open', ?, ?, ?, ?)`,
                    [uploadId, id, fileName, total, CHUNK_BYTES, temp, req.adminId, nowIso(), nowIso()],
                    (iErr) => {
                        if (iErr) return res.status(500).json({ error: iErr.message });
                        updateVideo(db, id, { status: 'uploading', source_name: fileName, source_bytes: total });
                        res.json({ uploadId, chunkBytes: CHUNK_BYTES, receivedBytes: 0, chunksDone: 0 });
                    }
                );
            };
            if (!resumeId) return start();
            db.get(`SELECT * FROM video_uploads WHERE upload_id = ? AND video_id = ? AND status = 'open'`, [resumeId, id], (uErr, up) => {
                if (uErr) return res.status(500).json({ error: uErr.message });
                if (!up || Number(up.total_bytes) !== total || !fs.existsSync(up.temp_path)) return start();
                const onDisk = fs.statSync(up.temp_path).size;
                const chunksDone = Math.floor(onDisk / up.chunk_bytes);
                res.json({ uploadId: up.upload_id, chunkBytes: up.chunk_bytes, receivedBytes: chunksDone * up.chunk_bytes, chunksDone, resumed: true });
            });
        });
    });

    app.put(
        '/api/admin/videos/upload/:uploadId/chunk',
        admin,
        express.raw({ type: () => true, limit: CHUNK_BYTES + 1024 * 1024 }),
        (req, res) => {
            const uploadId = String(req.params.uploadId || '');
            const index = parseInt(req.query.index, 10);
            if (!/^[a-f0-9]{32}$/.test(uploadId) || !Number.isInteger(index) || index < 0) return res.status(400).json({ error: 'Bad chunk request' });
            const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
            if (!data.length) return res.status(400).json({ error: 'Empty chunk' });
            db.get(`SELECT * FROM video_uploads WHERE upload_id = ? AND status = 'open'`, [uploadId], (err, up) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!up) return res.status(404).json({ error: 'Upload not found or already completed' });
                const offset = index * up.chunk_bytes;
                if (offset + data.length > Number(up.total_bytes)) return res.status(400).json({ error: 'Chunk exceeds the declared file size' });
                fs.open(up.temp_path, 'r+', (oErr, fd) => {
                    if (oErr) return res.status(500).json({ error: 'Upload file is missing. Start the upload again.' });
                    fs.write(fd, data, 0, data.length, offset, (wErr) => {
                        fs.close(fd, () => {
                            if (wErr) return res.status(500).json({ error: wErr.message });
                            const done = Math.max(Number(up.chunks_done), index + 1);
                            const received = Math.min(Number(up.total_bytes), done * up.chunk_bytes);
                            db.run(`UPDATE video_uploads SET chunks_done = ?, received_bytes = ?, updated_at = ? WHERE id = ?`, [done, received, nowIso(), up.id], () =>
                                res.json({ ok: true, chunksDone: done, receivedBytes: received })
                            );
                        });
                    });
                });
            });
        }
    );

    app.post('/api/admin/videos/upload/:uploadId/complete', admin, (req, res) => {
        const uploadId = String(req.params.uploadId || '');
        db.get(`SELECT * FROM video_uploads WHERE upload_id = ? AND status = 'open'`, [uploadId], (err, up) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!up) return res.status(404).json({ error: 'Upload not found or already completed' });
            fs.stat(up.temp_path, (sErr, st) => {
                if (sErr) return res.status(500).json({ error: 'Upload file is missing. Start the upload again.' });
                if (st.size !== Number(up.total_bytes)) {
                    return res.status(400).json({ error: 'Upload is incomplete (' + st.size + ' of ' + up.total_bytes + ' bytes). Resume it.', receivedBytes: st.size });
                }
                const destDir = dir('sources', String(up.video_id));
                const safeName = String(up.file_name || 'video').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'video';
                const dest = path.join(destDir, safeName);
                fs.rename(up.temp_path, dest, (mErr) => {
                    if (mErr) return res.status(500).json({ error: mErr.message });
                    db.run(`UPDATE video_uploads SET status = 'complete', updated_at = ? WHERE id = ?`, [nowIso(), up.id], () =>
                        updateVideo(db, up.video_id, { status: 'uploaded', source_path: dest, source_name: up.file_name, source_bytes: st.size, process_progress: 0, process_log: 'Queued for processing.' }, (uErr) => {
                            if (uErr) return res.status(500).json({ error: uErr.message });
                            checkTools((tools) => {
                                if (!tools.ffmpeg || !tools.ffprobe) {
                                    return updateVideo(db, up.video_id, { process_log: 'ffmpeg is not installed on the server. Install it and press Process.' }, () =>
                                        res.json({ ok: true, queued: false, warning: 'ffmpeg is not installed on this server.' })
                                    );
                                }
                                enqueueProcessing(db, up.video_id);
                                res.json({ ok: true, queued: true });
                            });
                        })
                    );
                });
            });
        });
    });

    app.get('/api/admin/videos/inbox', admin, (req, res) => {
        const inbox = dir('inbox');
        fs.readdir(inbox, (err, names) => {
            if (err) return res.status(500).json({ error: err.message });
            const files = (names || [])
                .filter((n) => !n.startsWith('.'))
                .map((n) => {
                    try {
                        const st = fs.statSync(path.join(inbox, n));
                        return st.isFile() ? { name: n, bytes: st.size, modifiedAt: st.mtime.toISOString() } : null;
                    } catch (_) {
                        return null;
                    }
                })
                .filter(Boolean);
            res.json({ inboxDir: inbox, files });
        });
    });

    app.post('/api/admin/videos/:id/import', admin, (req, res) => {
        const id = numId(req.params.id);
        const name = path.basename(String((req.body && req.body.fileName) || ''));
        if (!id) return res.status(404).json({ error: 'Video not found' });
        if (!name || name.startsWith('.')) return res.status(400).json({ error: 'Choose a file from the inbox folder.' });
        const src = path.join(dir('inbox'), name);
        db.get(`SELECT * FROM video_items WHERE id = ?`, [id], (err, video) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!video) return res.status(404).json({ error: 'Video not found' });
            if (video.status === 'processing') return res.status(409).json({ error: 'This video is being processed.' });
            fs.stat(src, (sErr, st) => {
                if (sErr || !st.isFile()) return res.status(404).json({ error: 'That file is not in the inbox folder.' });
                const dest = path.join(dir('sources', String(id)), name.replace(/[^A-Za-z0-9._-]+/g, '_'));
                fs.rename(src, dest, (mErr) => {
                    if (mErr) return res.status(500).json({ error: mErr.message });
                    updateVideo(db, id, { status: 'uploaded', source_path: dest, source_name: name, source_bytes: st.size, process_progress: 0, process_log: 'Imported from the server inbox. Queued for processing.' }, (uErr) => {
                        if (uErr) return res.status(500).json({ error: uErr.message });
                        checkTools((tools) => {
                            if (!tools.ffmpeg || !tools.ffprobe) return res.json({ ok: true, queued: false, warning: 'ffmpeg is not installed on this server.' });
                            enqueueProcessing(db, id);
                            res.json({ ok: true, queued: true });
                        });
                    });
                });
            });
        });
    });

    app.post('/api/admin/videos/:id/process', admin, (req, res) => {
        const id = numId(req.params.id);
        if (!id) return res.status(404).json({ error: 'Video not found' });
        db.get(`SELECT * FROM video_items WHERE id = ?`, [id], (err, video) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!video) return res.status(404).json({ error: 'Video not found' });
            if (!video.source_path) return res.status(400).json({ error: 'There is no source file for this video. Upload it again.' });
            checkTools((tools) => {
                if (!tools.ffmpeg || !tools.ffprobe) return res.status(400).json({ error: 'ffmpeg is not installed on this server.' });
                toolStatus = null;
                enqueueProcessing(db, id);
                res.json({ ok: true });
            });
        });
    });

    /* access: grants, recorded payments, purchases */

    app.get('/api/admin/videos/access', admin, (req, res) => {
        const year = parseYear(req.query.year);
        const where = year ? 'WHERE a.year = ?' : '';
        const params = year ? [year] : [];
        db.all(
            `SELECT a.*, u.first_name, u.middle_name, u.last_name, u.email, u.user_id_string, v.title AS video_title,
                    g.first_name AS g_first, g.last_name AS g_last, l.license_id
             FROM video_access a
             LEFT JOIN users u ON u.id = a.user_id
             LEFT JOIN video_items v ON v.id = a.video_id
             LEFT JOIN users g ON g.id = a.granted_by
             LEFT JOIN video_licenses l ON l.user_id = a.user_id
             ${where} ORDER BY a.id DESC LIMIT 500`,
            params,
            (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                db.all(
                    `SELECT p.*, u.first_name, u.middle_name, u.last_name, u.email, u.user_id_string, v.title AS video_title, o.order_id_string
                     FROM video_purchases p
                     LEFT JOIN users u ON u.id = p.user_id
                     LEFT JOIN video_items v ON v.id = p.video_id
                     LEFT JOIN orders o ON o.id = p.order_id
                     ${year ? 'WHERE p.year = ?' : ''} ORDER BY p.id DESC LIMIT 300`,
                    params,
                    (eP, purchases) => {
                        if (eP) return res.status(500).json({ error: eP.message });
                        res.json({
                            grants: (rows || []).map((a) => ({
                                id: a.id,
                                userId: a.user_id,
                                user: userDisplay(a),
                                userIdString: a.user_id_string || '',
                                email: a.email || '',
                                license: formatLicense(a.license_id),
                                year: a.year,
                                videoId: a.video_id || null,
                                videoTitle: a.video_title || '',
                                source: a.source,
                                paymentMode: a.payment_mode || '',
                                paymentModeLabel: paymentModeLabel(a.payment_mode || a.source),
                                amountInr: a.amount_inr != null ? Number(a.amount_inr) : null,
                                note: a.note || '',
                                grantedBy: [a.g_first, a.g_last].filter(Boolean).join(' '),
                                createdAt: a.created_at,
                                revokedAt: a.revoked_at
                            })),
                            purchases: (purchases || []).map((p) => ({
                                id: p.id,
                                user: userDisplay(p),
                                userIdString: p.user_id_string || '',
                                year: p.year,
                                videoTitle: p.video_title || ('All ' + p.year + ' videos'),
                                amountInr: Number(p.amount_inr),
                                status: p.status,
                                orderRef: p.order_id_string || '',
                                createdAt: p.created_at,
                                paidAt: p.paid_at
                            }))
                        });
                    }
                );
            }
        );
    });

    app.get('/api/admin/videos/lookup', admin, (req, res) => {
        const q = cleanText(req.query.q, 80);
        if (!q || q.length < 2) return res.json([]);
        const like = '%' + q.toLowerCase() + '%';
        const digits = q.replace(/\D/g, '');
        const phoneLike = digits.length >= 6 ? '%' + digits.slice(-10) + '%' : like;
        const appNo = q.replace(/^sem[-\s]*/i, '').trim().toLowerCase();
        const idExact = /^\d+$/.test(q.trim()) ? q.trim() : '';
        db.all(
            `SELECT DISTINCT u.id
             FROM users u
             LEFT JOIN registrations r ON r.user_id = u.id
             WHERE LOWER(COALESCE(u.role, '')) <> 'admin'
               AND (
                    LOWER(COALESCE(u.email, '')) LIKE ?
                    OR LOWER(COALESCE(u.phone, '')) LIKE ?
                    OR LOWER(COALESCE(u.first_name, '')) LIKE ?
                    OR LOWER(COALESCE(u.middle_name, '')) LIKE ?
                    OR LOWER(COALESCE(u.last_name, '')) LIKE ?
                    OR LOWER(COALESCE(u.user_id_string, '')) LIKE ?
                    OR LOWER(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) LIKE ?
                    OR LOWER(COALESCE(r.application_no, '')) LIKE ?
                    OR LOWER(COALESCE(r.application_no, '')) = ?
                    OR CAST(r.id AS TEXT) = ?
                    OR CAST(u.id AS TEXT) = ?
                    OR REPLACE(REPLACE(REPLACE(COALESCE(u.phone, ''), ' ', ''), '-', ''), '+', '') LIKE ?
               )
             ORDER BY u.id DESC
             LIMIT 8`,
            [like, like, like, like, like, like, like, like, appNo, idExact, idExact, phoneLike],
            (err, hits) => {
                if (err) return res.status(500).json({ error: err.message });
                const ids = (hits || []).map((h) => h.id);
                if (!ids.length) return res.json([]);
                const marks = ids.map(() => '?').join(',');
                db.all(
                    `SELECT u.id, u.user_id_string, u.first_name, u.middle_name, u.last_name, u.email, u.phone, u.doctor_category,
                            l.license_id
                     FROM users u
                     LEFT JOIN video_licenses l ON l.user_id = u.id
                     WHERE u.id IN (${marks})`,
                    ids,
                    (eU, users) => {
                        if (eU) return res.status(500).json({ error: eU.message });
                        db.all(
                            `SELECT r.id, r.user_id, r.application_no, r.status, r.seminar_id, s.title AS seminar_title, s.portal_year, s.event_date,
                                    (SELECT COUNT(*) FROM orders o WHERE o.registration_id = r.id AND LOWER(COALESCE(o.status, '')) = 'success') AS paid_rows
                             FROM registrations r
                             LEFT JOIN seminars s ON s.id = r.seminar_id
                             WHERE r.user_id IN (${marks})
                             ORDER BY r.id DESC`,
                            ids,
                            (eR, regs) => {
                                if (eR) return res.status(500).json({ error: eR.message });
                                db.all(
                                    `SELECT a.user_id, a.year, a.video_id, a.source, a.payment_mode, a.revoked_at, v.title AS video_title
                                     FROM video_access a
                                     LEFT JOIN video_items v ON v.id = a.video_id
                                     WHERE a.user_id IN (${marks})
                                     ORDER BY a.id DESC`,
                                    ids,
                                    (eA, grants) => {
                                        if (eA) return res.status(500).json({ error: eA.message });
                                        const byId = new Map((users || []).map((u) => [u.id, u]));
                                        res.json(
                                            ids
                                                .map((id) => byId.get(id))
                                                .filter(Boolean)
                                                .map((u) => {
                                                    const mine = (regs || []).filter((r) => r.user_id === u.id).slice(0, 8);
                                                    const access = (grants || []).filter((g) => g.user_id === u.id).slice(0, 6);
                                                    return {
                                                        id: u.id,
                                                        name: userDisplay(u),
                                                        email: u.email || '',
                                                        phone: u.phone || '',
                                                        userIdString: u.user_id_string || '',
                                                        category: String(u.doctor_category || '').toLowerCase() === 'volunteer' ? 'volunteer' : 'regular',
                                                        license: formatLicense(u.license_id),
                                                        registrations: mine.map((r) => {
                                                            const status = String(r.status || '').toLowerCase();
                                                            const yearMatch = String(r.event_date || '').match(/^(\d{4})/);
                                                            return {
                                                                id: r.id,
                                                                applicationNo: r.application_no || '',
                                                                seminarTitle: r.seminar_title || '',
                                                                year: r.portal_year || (yearMatch ? parseInt(yearMatch[1], 10) : null),
                                                                status,
                                                                paid: PAID_REGISTRATION_STATUSES.includes(status) || Number(r.paid_rows) > 0,
                                                                scanned: SCANNED_REGISTRATION_STATUSES.includes(status)
                                                            };
                                                        }),
                                                        access: access.map((a) => ({
                                                            year: a.year,
                                                            videoTitle: a.video_title || '',
                                                            source: a.source,
                                                            paymentModeLabel: paymentModeLabel(a.payment_mode || a.source),
                                                            revoked: !!a.revoked_at
                                                        }))
                                                    };
                                                })
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

    app.get('/api/admin/videos/users', admin, (req, res) => {
        const q = cleanText(req.query.q, 80);
        if (!q) return res.json([]);
        const like = '%' + q + '%';
        db.all(
            `SELECT id, user_id_string, first_name, middle_name, last_name, email, phone FROM users
             WHERE (email LIKE ? OR phone LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR user_id_string LIKE ?)
               AND LOWER(COALESCE(role, '')) <> 'admin'
             ORDER BY id DESC LIMIT 12`,
            [like, like, like, like, like],
            (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json((rows || []).map((u) => ({ id: u.id, name: userDisplay(u), userIdString: u.user_id_string || '', email: u.email || '', phone: u.phone || '' })));
            }
        );
    });

    app.post('/api/admin/videos/access/cart', admin, (req, res) => {
        const b = req.body || {};
        const userId = parseInt(b.userId, 10);
        const years = Array.isArray(b.years)
            ? Array.from(new Set(b.years.map((y) => parseYear(y)).filter(Boolean)))
            : [];
        let mode = String(b.paymentMode || '').toLowerCase();
        if (!PAYMENT_MODES[mode]) mode = 'waiver';
        const spec = PAYMENT_MODES[mode];
        const note = cleanText(b.note, 300);
        if (!(userId > 0)) return res.status(400).json({ error: 'Find the person and select the account first.' });
        if (!years.length) return res.status(400).json({ error: 'Select at least one seminar year.' });
        const yearMarks = years.map(() => '?').join(',');
        db.all(`SELECT * FROM video_items WHERE year IN (${yearMarks})`, years, (vErr, videos) => {
            if (vErr) return res.status(500).json({ error: vErr.message });
            db.all(`SELECT * FROM video_years`, [], (yErr, yearRows) => {
                if (yErr) return res.status(500).json({ error: yErr.message });
                const quote = quoteSelectedYears(years, videos || [], yearRows || []);
                const missing = quote.lines.filter((line) => !line.videos.length && !(line.amountInr > 0));
                if (missing.length) return res.status(400).json({ error: 'No videos or year price for ' + missing.map((line) => line.year).join(', ') + '.' });
                let amount = spec.paid ? parsePrice(b.amountInr) : 0;
                if (spec.paid && !(amount > 0)) amount = quote.total;
                if (spec.paid && !(amount > 0)) return res.status(400).json({ error: 'Set a price on the videos or the year, or enter the amount received.' });
                const done = (orderRef, extra) =>
                    res.json(Object.assign({ ok: true, paid: true, paymentMode: mode, amountInr: spec.paid ? amount : 0, orderRef: orderRef || '', years, quote }, extra || {}));
                const enable = (orderDbId, orderRef, razorpayOrderId) =>
                    grantOfficeYears(
                        db,
                        {
                            userId,
                            years,
                            amount,
                            orderDbId,
                            orderRef,
                            razorpayOrderId,
                            mode,
                            modeLabel: spec.label,
                            source: spec.source,
                            paid: spec.paid,
                            note,
                            adminId: req.adminId
                        },
                        (gErr) => (gErr ? res.status(500).json({ error: gErr.message }) : done(orderRef, { razorpayOrderId: razorpayOrderId || '' }))
                    );
                if (!spec.paid) return enable(null, '', '');
                const orderStr = 'VID' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
                const openOrder = (status, cb) =>
                    db.run(
                        `INSERT INTO orders (order_id_string, registration_id, amount, status) VALUES (?, NULL, ?, ?)`,
                        [orderStr, amount, status],
                        function (oErr) {
                            if (oErr) return cb(oErr);
                            cb(null, this.lastID);
                        }
                    );
                if (mode !== 'razorpay') {
                    return openOrder('success', (oErr, orderDbId) => {
                        if (oErr) return res.status(500).json({ error: oErr.message });
                        enable(orderDbId, orderStr, '');
                    });
                }
                db.all(`SELECT * FROM payment_gateways`, [], (eGw, gwRows) => {
                    if (eGw) return res.status(500).json({ error: eGw.message });
                    const resolved = razorpayFor(gwRows, 'live') || razorpayFor(gwRows, 'test');
                    if (!resolved || !resolved.config || !resolved.config.key_id) {
                        return res.status(400).json({ error: 'Razorpay is not configured, so an order could not be created.' });
                    }
                    openOrder('pending', (oErr, orderDbId) => {
                        if (oErr) return res.status(500).json({ error: oErr.message });
                        let i = 0;
                        const savePurchase = (pErr) => {
                            if (pErr) return res.status(500).json({ error: pErr.message });
                            if (i >= quote.lines.length) return createRz();
                            const line = quote.lines[i++];
                            db.run(
                                `INSERT INTO video_purchases (user_id, year, video_id, amount_inr, order_id, status, created_at) VALUES (?, ?, NULL, ?, ?, 'pending', ?)`,
                                [userId, line.year, line.amountInr, orderDbId, nowIso()],
                                savePurchase
                            );
                        };
                        const createRz = () => {
                            const rz = new Razorpay({ key_id: resolved.config.key_id, key_secret: resolved.config.key_secret });
                            const gwTag = resolved.mode === 'live' ? 'razorpay_live' : resolved.mode === 'test' ? 'razorpay_test' : 'razorpay';
                            adminPaymentFlow.createRazorpayOrder(
                                rz,
                                { amount: Math.round(amount * 100), currency: 'INR', receipt: orderStr.slice(0, 40) },
                                (rzErr, rzOrder) => {
                                    if (rzErr) return res.status(400).json({ error: adminPaymentFlow.razorpayErrorMessage(rzErr, 'Razorpay order failed') });
                                    db.run(`UPDATE orders SET payment_gateway = ?, provider_order_id = ? WHERE id = ?`, [gwTag, rzOrder.id, orderDbId], (uErr) => {
                                        if (uErr) return res.status(500).json({ error: uErr.message });
                                        res.json({
                                            ok: true,
                                            paid: false,
                                            paymentType: 'razorpay_checkout',
                                            paymentMode: mode,
                                            keyId: resolved.config.key_id,
                                            razorpayOrder: rzOrder,
                                            orderDbId,
                                            orderRef: orderStr,
                                            amountInr: amount,
                                            years,
                                            quote,
                                            label: years.join(', ') + ' seminar videos'
                                        });
                                    });
                                }
                            );
                        };
                        savePurchase();
                    });
                });
            });
        });
    });

    app.post('/api/admin/videos/access/cart/verify', admin, (req, res) => {
        const b = req.body || {};
        const orderDbId = parseInt(b.orderDbId, 10);
        if (!orderDbId || !b.razorpay_order_id || !b.razorpay_payment_id || !b.razorpay_signature) {
            return res.status(400).json({ error: 'Payment details are incomplete.' });
        }
        db.get(`SELECT * FROM orders WHERE id = ?`, [orderDbId], (oErr, order) => {
            if (oErr) return res.status(500).json({ error: oErr.message });
            if (!order) return res.status(404).json({ error: 'Order not found.' });
            if (order.provider_order_id !== b.razorpay_order_id) return res.status(400).json({ error: 'Payment does not match this order.' });
            db.all(`SELECT * FROM video_purchases WHERE order_id = ? ORDER BY id ASC`, [orderDbId], (pErr, purchases) => {
                if (pErr) return res.status(500).json({ error: pErr.message });
                if (!purchases || !purchases.length) return res.status(404).json({ error: 'This order has no seminar years.' });
                db.all(`SELECT * FROM payment_gateways WHERE is_active = 1`, [], (eG, gwRows) => {
                    if (eG) return res.status(500).json({ error: eG.message });
                    const opt = razorpayFor(gwRows, order.payment_gateway);
                    if (!opt) return res.status(400).json({ error: 'Razorpay is not configured.' });
                    if (!verifyRazorpaySignature(b.razorpay_order_id, b.razorpay_payment_id, b.razorpay_signature, opt.config.key_secret)) {
                        return res.status(400).json({ error: 'Payment signature is invalid.' });
                    }
                    const userId = purchases[0].user_id;
                    const years = Array.from(new Set(purchases.map((p) => Number(p.year))));
                    db.run(
                        `UPDATE orders SET status = 'success', payment_date = CURRENT_TIMESTAMP, provider_transaction_id = ? WHERE id = ?`,
                        [b.razorpay_payment_id, orderDbId],
                        (uErr) => {
                            if (uErr) return res.status(500).json({ error: uErr.message });
                            db.run(`UPDATE video_purchases SET status = 'paid', paid_at = ? WHERE order_id = ?`, [nowIso(), orderDbId], (p2) => {
                                if (p2) return res.status(500).json({ error: p2.message });
                                grantOfficeYears(
                                    db,
                                    {
                                        userId,
                                        years,
                                        amount: Number(order.amount) || 0,
                                        orderDbId,
                                        orderRef: order.order_id_string,
                                        razorpayOrderId: b.razorpay_order_id,
                                        mode: 'razorpay',
                                        modeLabel: paymentModeLabel('razorpay'),
                                        source: 'admin_paid',
                                        paid: true,
                                        note: 'Razorpay ' + b.razorpay_payment_id,
                                        adminId: req.adminId
                                    },
                                    (gErr) => (gErr ? res.status(500).json({ error: gErr.message }) : res.json({ ok: true, paid: true, years, orderRef: order.order_id_string }))
                                );
                            });
                        }
                    );
                });
            });
        });
    });

    app.post('/api/admin/videos/access', admin, (req, res) => {
        const b = req.body || {};
        const userId = parseInt(b.userId, 10);
        const year = parseYear(b.year);
        const videoId = b.videoId === '' || b.videoId == null ? null : parseInt(b.videoId, 10);
        let mode = String(b.paymentMode || '').toLowerCase();
        if (!PAYMENT_MODES[mode]) mode = b.source === 'admin_paid' ? 'cash' : 'waiver';
        const spec = PAYMENT_MODES[mode];
        const source = spec.source;
        const amount = spec.paid ? parsePrice(b.amountInr) : null;
        if (!(userId > 0) || !year) return res.status(400).json({ error: 'Choose a doctor and a year.' });
        if (spec.paid && !(amount > 0)) return res.status(400).json({ error: 'Enter the amount that was paid.' });
        const note = cleanText(b.note, 300);
        const insert = (videoTitle) =>
            db.run(
                `INSERT INTO video_access (user_id, year, video_id, source, amount_inr, note, order_id, granted_by, created_at, payment_mode) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
                [userId, year, videoId, source, amount, note, req.adminId, nowIso(), mode],
                function (err) {
                    if (err) return res.status(500).json({ error: err.message });
                    mailVideo(db, 'VIDEO_ACCESS_GRANTED', userId, {
                        scope: videoTitle ? videoTitle + ' (' + year + ')' : 'all ' + year + ' seminar videos',
                        modeLabel: spec.label,
                        amount: spec.paid ? amount : null,
                        note
                    });
                    res.json({ ok: true, id: this.lastID, paymentMode: mode });
                }
            );
        if (!videoId) return insert('');
        db.get(`SELECT id, title FROM video_items WHERE id = ? AND year = ?`, [videoId, year], (err, v) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!v) return res.status(400).json({ error: 'That video does not belong to the chosen year.' });
            insert(v.title);
        });
    });

    app.post('/api/admin/videos/access/:id/revoke', admin, (req, res) => {
        const id = numId(req.params.id);
        if (!id) return res.status(404).json({ error: 'Grant not found' });
        db.get(
            `SELECT a.user_id, a.year, a.video_id, v.title FROM video_access a LEFT JOIN video_items v ON v.id = a.video_id WHERE a.id = ? AND a.revoked_at IS NULL`,
            [id],
            (gErr, row) => {
                if (gErr) return res.status(500).json({ error: gErr.message });
                db.run(`UPDATE video_access SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, [nowIso(), id], function (err) {
                    if (err) return res.status(500).json({ error: err.message });
                    if (row && this.changes) {
                        mailVideo(db, 'VIDEO_ACCESS_REVOKED', row.user_id, {
                            scope: row.title ? row.title + ' (' + row.year + ')' : 'all ' + row.year + ' seminar videos'
                        });
                    }
                    res.json({ ok: true, changed: this.changes });
                });
            }
        );
    });

    app.get('/api/admin/videos/reports/:type', admin, (req, res) => {
        const type = String(req.params.type || '').toLowerCase();
        const format = String((req.query && req.query.format) || 'xlsx')
            .toLowerCase()
            .replace(/^\./, '');
        const year = parseYear(req.query.year);
        const exportReports = require('./export-reports');
        const specs = {
            catalog: {
                title: 'Seminar video catalog',
                sql: `SELECT v.year AS "Year", COALESCE(s.title, '') AS "Seminar", v.title AS "Title", v.kind AS "Type",
                        v.part_no AS "Part", v.price_inr AS "Price INR", v.status AS "Status",
                        CASE WHEN v.published = 1 THEN 'yes' ELSE 'no' END AS "Published",
                        v.duration_sec AS "Duration seconds", v.created_at AS "Created"
                      FROM video_items v
                      LEFT JOIN seminars s ON s.id = v.seminar_id
                      ${year ? 'WHERE v.year = ?' : ''}
                      ORDER BY v.year DESC, v.sort_order ASC, v.id ASC`,
                params: year ? [year] : []
            },
            access: {
                title: 'Seminar video access',
                sql: `SELECT a.year AS "Year",
                        TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.middle_name, '') || ' ' || COALESCE(u.last_name, '')) AS "Doctor",
                        COALESCE(u.user_id_string, '') AS "Portal ID", COALESCE(u.email, '') AS "Email", COALESCE(u.phone, '') AS "Phone",
                        COALESCE(l.license_id, '') AS "License", COALESCE(v.title, 'All videos of the year') AS "Video",
                        COALESCE(a.source, '') AS "Source", COALESCE(a.payment_mode, '') AS "Payment mode",
                        a.amount_inr AS "Amount INR", COALESCE(o.order_id_string, '') AS "Order",
                        COALESCE(a.note, '') AS "Note", a.created_at AS "Granted", a.revoked_at AS "Revoked"
                      FROM video_access a
                      LEFT JOIN users u ON u.id = a.user_id
                      LEFT JOIN video_items v ON v.id = a.video_id
                      LEFT JOIN video_licenses l ON l.user_id = a.user_id
                      LEFT JOIN orders o ON o.id = a.order_id
                      ${year ? 'WHERE a.year = ?' : ''}
                      ORDER BY a.id DESC`,
                params: year ? [year] : []
            },
            payments: {
                title: 'Seminar video payments',
                sql: `SELECT p.year AS "Year",
                        TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS "Doctor",
                        COALESCE(u.user_id_string, '') AS "Portal ID", COALESCE(u.email, '') AS "Email", COALESCE(u.phone, '') AS "Phone",
                        COALESCE(v.title, 'Year bundle') AS "Video", p.amount_inr AS "Amount INR", p.status AS "Purchase status",
                        COALESCE(o.order_id_string, '') AS "Order", COALESCE(o.status, '') AS "Order status",
                        p.created_at AS "Created", p.paid_at AS "Paid"
                      FROM video_purchases p
                      LEFT JOIN users u ON u.id = p.user_id
                      LEFT JOIN video_items v ON v.id = p.video_id
                      LEFT JOIN orders o ON o.id = p.order_id
                      ${year ? 'WHERE p.year = ?' : ''}
                      ORDER BY p.id DESC`,
                params: year ? [year] : []
            },
            devices: {
                title: 'Seminar video devices',
                sql: `SELECT TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS "Doctor",
                        COALESCE(u.user_id_string, '') AS "Portal ID", COALESCE(u.email, '') AS "Email",
                        COALESCE(l.license_id, '') AS "License", l.device_limit AS "Device limit",
                        COALESCE(d.label, '') AS "Device", d.first_seen_at AS "First seen", d.last_seen_at AS "Last seen",
                        COALESCE(d.first_ip, '') AS "First IP", COALESCE(d.last_ip, '') AS "Last IP", d.revoked_at AS "Removed"
                      FROM video_devices d
                      LEFT JOIN users u ON u.id = d.user_id
                      LEFT JOIN video_licenses l ON l.user_id = d.user_id
                      ORDER BY d.id DESC`,
                params: []
            },
            activity: {
                title: 'Seminar video activity',
                sql: `SELECT w.created_at AS "When",
                        TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS "Doctor",
                        COALESCE(u.user_id_string, '') AS "Portal ID", COALESCE(u.email, '') AS "Email",
                        COALESCE(v.year, 0) AS "Year", COALESCE(v.title, '') AS "Video",
                        w.event AS "Event", COALESCE(w.detail, '') AS "Detail", COALESCE(w.ip, '') AS "IP",
                        w.position_sec AS "Position seconds"
                      FROM video_watch_log w
                      LEFT JOIN users u ON u.id = w.user_id
                      LEFT JOIN video_items v ON v.id = w.video_id
                      ${year ? 'WHERE v.year = ?' : ''}
                      ORDER BY w.id DESC LIMIT 5000`,
                params: year ? [year] : []
            }
        };
        const spec = specs[type];
        if (!spec) return res.status(400).json({ error: 'Unknown video report' });
        db.all(spec.sql, spec.params, (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            const out = rows || [];
            const base = 'video-' + type + (year ? '-' + year : '');
            if (format === 'xlsx' || format === 'excel') {
                const buf = exportReports.toXlsxBuffer(out, spec.title);
                res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
                res.setHeader('Content-Disposition', 'attachment; filename="' + base + '.xlsx"');
                return res.send(buf);
            }
            if (format === 'pdf' || format === 'html') {
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                res.setHeader('Content-Disposition', 'attachment; filename="' + base + '.html"');
                return res.send(exportReports.toHtmlTable(out, spec.title));
            }
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename="' + base + '.csv"');
            res.send(exportReports.toCsv(out));
        });
    });

    app.get('/api/admin/videos/:id', admin, (req, res) => {
        const id = numId(req.params.id);
        if (!id) return res.status(404).json({ error: 'Video not found' });
        db.get(`SELECT * FROM video_items WHERE id = ?`, [id], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!row) return res.status(404).json({ error: 'Video not found' });
            db.all(
                `SELECT s.id, s.user_id, s.created_at, s.last_seen_at, s.expires_at, s.revoked_at, u.first_name, u.middle_name, u.last_name, u.email, u.user_id_string
                 FROM video_sessions s LEFT JOIN users u ON u.id = s.user_id WHERE s.video_id = ? ORDER BY s.id DESC LIMIT 50`,
                [id],
                (eS, sessions) => {
                    if (eS) return res.status(500).json({ error: eS.message });
                    res.json({
                        video: adminVideoRow(row),
                        sessions: (sessions || []).map((s) => ({
                            id: s.id,
                            user: userDisplay(s),
                            userIdString: s.user_id_string || '',
                            createdAt: s.created_at,
                            lastSeenAt: s.last_seen_at,
                            active: !s.revoked_at && (!s.expires_at || Date.parse(s.expires_at) > Date.now())
                        }))
                    });
                }
            );
        });
    });

    app.post('/api/admin/videos/sessions/:userId/end', admin, (req, res) => {
        const userId = numId(req.params.userId);
        if (!userId) return res.status(404).json({ error: 'User not found' });
        db.run(`UPDATE video_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`, [nowIso(), userId], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ok: true, changed: this.changes });
        });
    });
}

module.exports = {
    registerVideoLibraryRoutes,
    ensureVideoLibrarySchema,
    resolveAccess,
    summarizeRegistrations,
    hlsArgs,
    formatLicense,
    paymentModeLabel,
    PAYMENT_MODES,
    randomLicenseId,
    describeDevice,
    FREE_REGISTRATION_STATUSES,
    PAID_REGISTRATION_STATUSES,
    SCANNED_REGISTRATION_STATUSES,
    ROOT
};
