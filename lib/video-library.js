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
 * served from /video-stream/<token>/... only while that session is valid. One session per doctor at a time.
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

const isPg = !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
const ROOT = path.resolve(process.env.VIDEO_LIBRARY_DIR || path.join(__dirname, '..', 'storage', 'videos'));
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const CHUNK_BYTES = Math.max(1, Math.min(64, parseInt(process.env.VIDEO_UPLOAD_CHUNK_MB, 10) || 8)) * 1024 * 1024;
const SESSION_HOURS = 8;
const SEGMENT_SECONDS = 6;
/** Registration statuses that already paid for the seminar; those doctors watch for free. */
const FREE_REGISTRATION_STATUSES = ['completed', 'e_ticket_issued', 'certificate_issued', 'checked_in'];
const KINDS = ['full', 'episode'];
const SEG_NAME = /^seg_\d{5}\.ts$/;

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
        `CREATE INDEX IF NOT EXISTS idx_video_access_user ON video_access (user_id, year)`,
        `CREATE INDEX IF NOT EXISTS idx_video_sessions_user ON video_sessions (user_id)`,
        `CREATE INDEX IF NOT EXISTS idx_video_progress_user ON video_progress (user_id, video_id)`
    ];
    let i = 0;
    const next = (err) => {
        if (err) return cb(err);
        if (i >= statements.length) return cb(null);
        db.run(statements[i++], [], next);
    };
    next();
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
                    updateVideo(
                        db,
                        id,
                        {
                            status: 'ready',
                            hls_dir: outDir,
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
                            updateVideo(db, id, { source_path: null }, () => done());
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

/* ------------------------------------------------------------- entitlement */

function yearExpr(alias) {
    return isPg ? `EXTRACT(YEAR FROM ${alias}.event_date)::INTEGER` : `CAST(strftime('%Y', ${alias}.event_date) AS INTEGER)`;
}

/** Finds why a doctor may watch a video: a paid registration for that seminar year, a grant, or a purchase. */
function resolveAccess(db, userId, video, cb) {
    const placeholders = FREE_REGISTRATION_STATUSES.map(() => '?').join(', ');
    db.get(
        `SELECT r.id, r.status, s.title AS seminar_title
         FROM registrations r JOIN seminars s ON s.id = r.seminar_id
         WHERE r.user_id = ? AND LOWER(COALESCE(r.status, '')) IN (${placeholders})
           AND (s.id = ? OR s.portal_year = ? OR ${yearExpr('s')} = ?)
         ORDER BY r.id DESC LIMIT 1`,
        [userId, ...FREE_REGISTRATION_STATUSES, video.seminar_id || -1, video.year, video.year],
        (err, reg) => {
            if (err) return cb(err);
            if (reg) return cb(null, { allowed: true, reason: 'registered', detail: reg.seminar_title || '' });
            db.get(
                `SELECT id, source, video_id FROM video_access
                 WHERE user_id = ? AND year = ? AND revoked_at IS NULL AND (video_id IS NULL OR video_id = ?)
                 ORDER BY id DESC LIMIT 1`,
                [userId, video.year, video.id],
                (e2, grant) => {
                    if (e2) return cb(e2);
                    if (grant) return cb(null, { allowed: true, reason: grant.source, detail: grant.video_id ? 'this video' : 'all ' + video.year + ' videos' });
                    cb(null, { allowed: false, reason: null, detail: '' });
                }
            );
        }
    );
}

function mapVideo(row, access, progress) {
    return {
        id: row.id,
        year: row.year,
        seminarId: row.seminar_id || null,
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
        `SELECT s.*, v.hls_dir, v.key_hex, v.status AS video_status, v.published
         FROM video_sessions s JOIN video_items v ON v.id = s.video_id WHERE s.token = ?`,
        [token],
        (err, row) => {
            if (err) return cb(err);
            if (!row || row.revoked_at) return cb(null, null);
            if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return cb(null, null);
            if (row.video_status !== 'ready' || !row.hls_dir) return cb(null, null);
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
                    db.run(
                        `INSERT INTO video_access (user_id, year, video_id, source, amount_inr, note, order_id, granted_by, created_at)
                         VALUES (?, ?, ?, 'purchase', ?, ?, ?, NULL, ?)`,
                        [purchase.user_id, purchase.year, purchase.video_id || null, purchase.amount_inr, 'Online payment ' + (txnId || ''), purchase.order_id, nowIso()],
                        (e4) => cb(e4 || null)
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
        db.all(
            `SELECT v.*, p.position_sec FROM video_items v
             LEFT JOIN video_progress p ON p.video_id = v.id AND p.user_id = ?
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
                                                bundlePriceInr: meta.bundle_price_inr != null ? Number(meta.bundle_price_inr) : null,
                                                allAllowed: true,
                                                videos: []
                                            };
                                        }
                                        years[v.year].videos.push(v);
                                        if (!v.access.allowed) years[v.year].allAllowed = false;
                                    });
                                    res.json({
                                        years: Object.values(years).sort((a, b) => b.year - a.year),
                                        pendingPurchases: pending || []
                                    });
                                    return;
                                }
                                const row = list[i++];
                                resolveAccess(db, userId, row, (aErr, access) => {
                                    if (aErr) return res.status(500).json({ error: aErr.message });
                                    out.push(mapVideo(row, access, row.position_sec));
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

    app.post('/api/doctor/videos/:id/session', (req, res) => {
        const userId = uid(req.body && req.body.userId);
        const id = parseInt(req.params.id, 10);
        if (!userId || !Number.isInteger(id)) return res.status(400).json({ error: 'userId and video are required' });
        db.get(`SELECT * FROM video_items WHERE id = ? AND published = 1 AND status = 'ready'`, [id], (err, video) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!video) return res.status(404).json({ error: 'This video is not available.' });
            resolveAccess(db, userId, video, (aErr, access) => {
                if (aErr) return res.status(500).json({ error: aErr.message });
                if (!access.allowed) return res.status(403).json({ error: 'You do not have access to this video yet.', access });
                db.get(`SELECT id, first_name, middle_name, last_name, email, user_id_string FROM users WHERE id = ?`, [userId], (uErr, user) => {
                    if (uErr) return res.status(500).json({ error: uErr.message });
                    if (!user) return res.status(404).json({ error: 'User not found' });
                    const token = newToken();
                    const now = nowIso();
                    const expires = new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString();
                    // One active playback per doctor: starting here ends playback anywhere else.
                    db.run(`UPDATE video_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`, [now, userId], (rErr) => {
                        if (rErr) return res.status(500).json({ error: rErr.message });
                        db.run(
                            `INSERT INTO video_sessions (token, user_id, video_id, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                            [token, userId, id, now, now, expires, cleanText(req.ip, 64), cleanText(req.get('user-agent'), 200)],
                            (iErr) => {
                                if (iErr) return res.status(500).json({ error: iErr.message });
                                db.get(`SELECT position_sec FROM video_progress WHERE user_id = ? AND video_id = ?`, [userId, id], (pErr, prog) => {
                                    res.json({
                                        token,
                                        playlistUrl: '/video-stream/' + token + '/index.m3u8',
                                        expiresAt: expires,
                                        positionSec: prog ? Number(prog.position_sec) || 0 : 0,
                                        watermark: {
                                            name: userDisplay(user),
                                            id: user.user_id_string || 'ID ' + user.id,
                                            email: user.email || ''
                                        },
                                        video: mapVideo(video, access, prog && prog.position_sec)
                                    });
                                });
                            }
                        );
                    });
                });
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
            touchSession(db, session.id);
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
        db.run(`UPDATE video_sessions SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL`, [nowIso(), token], () => res.json({ ok: true }));
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
            fs.readFile(path.join(session.hls_dir, 'index.m3u8'), 'utf8', (rErr, text) => {
                if (rErr) return res.status(404).end();
                const base = '/video-stream/' + session.token + '/';
                const out = text
                    .split('\n')
                    .map((line) => {
                        if (line.startsWith('#EXT-X-KEY')) return line.replace(/URI="[^"]*"/, 'URI="' + base + 'key"');
                        if (line && !line.startsWith('#')) return base + 'seg/' + path.basename(line.trim());
                        return line;
                    })
                    .join('\n');
                touchSession(db, session.id);
                noStore(res, 'application/vnd.apple.mpegurl');
                res.send(out);
            });
        });
    });

    app.get('/video-stream/:token/key', (req, res) => {
        loadSession(db, req.params.token, (err, session) => {
            if (err) return res.status(500).end();
            if (!session || !session.key_hex) return res.status(403).end();
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
        createdAt: row.created_at,
        updatedAt: row.updated_at
    });

    app.get('/api/admin/videos', admin, (req, res) => {
        db.all(`SELECT * FROM video_items ORDER BY year DESC, sort_order ASC, CASE WHEN kind = 'full' THEN 0 ELSE 1 END, part_no ASC, id ASC`, [], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            db.all(`SELECT * FROM video_years ORDER BY year DESC`, [], (eY, years) => {
                if (eY) return res.status(500).json({ error: eY.message });
                db.all(`SELECT id, title, portal_year, event_date FROM seminars ORDER BY event_date DESC, id DESC`, [], (eS, seminars) => {
                    if (eS) return res.status(500).json({ error: eS.message });
                    checkTools((tools) =>
                        diskFree((disk) =>
                            res.json({
                                videos: (rows || []).map(adminVideoRow),
                                years: (years || []).map((y) => ({
                                    year: y.year,
                                    title: y.title || '',
                                    description: y.description || '',
                                    bundlePriceInr: y.bundle_price_inr != null ? Number(y.bundle_price_inr) : null
                                })),
                                seminars: (seminars || []).map((s) => ({ id: s.id, title: s.title, year: s.portal_year || (s.event_date ? new Date(s.event_date).getFullYear() : null) })),
                                tools: Object.assign({}, tools, { storageDir: ROOT, inboxDir: path.join(ROOT, 'inbox'), chunkBytes: CHUNK_BYTES, disk }),
                                processing: { running, queued: queue.slice() }
                            })
                        )
                    );
                });
            });
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
        if (!title) return { error: 'Give the video a title.' };
        if (price == null) return { error: 'Price must be a number of rupees (0 for free).' };
        if (kind === 'episode' && partNo != null && !(Number.isInteger(partNo) && partNo > 0)) return { error: 'Part number must be a positive whole number.' };
        return {
            year,
            seminar_id: Number.isInteger(seminarId) && seminarId > 0 ? seminarId : null,
            title,
            description: cleanText(b.description != null ? b.description : existing && existing.description, 2000),
            kind,
            part_no: partNo,
            price_inr: price,
            published: b.published != null ? (b.published === true || b.published === 1 || b.published === '1' || b.published === 'true' ? 1 : 0) : existing ? existing.published : 0,
            sort_order: b.sortOrder != null ? parseInt(b.sortOrder, 10) || 0 : existing ? existing.sort_order : 0
        };
    }

    app.post('/api/admin/videos', admin, (req, res) => {
        const v = readVideoBody(req.body, null);
        if (v.error) return res.status(400).json({ error: v.error });
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

    app.put('/api/admin/videos/:id', admin, (req, res) => {
        const id = numId(req.params.id);
        if (!id) return res.status(404).json({ error: 'Video not found' });
        db.get(`SELECT * FROM video_items WHERE id = ?`, [id], (err, existing) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!existing) return res.status(404).json({ error: 'Video not found' });
            const v = readVideoBody(req.body, existing);
            if (v.error) return res.status(400).json({ error: v.error });
            if (v.published && existing.status !== 'ready') return res.status(400).json({ error: 'Upload and process the video before publishing it.' });
            updateVideo(db, id, v, (uErr) => {
                if (uErr) return res.status(500).json({ error: uErr.message });
                db.get(`SELECT * FROM video_items WHERE id = ?`, [id], (e2, row) => (e2 ? res.status(500).json({ error: e2.message }) : res.json({ video: adminVideoRow(row) })));
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
                    g.first_name AS g_first, g.last_name AS g_last
             FROM video_access a
             LEFT JOIN users u ON u.id = a.user_id
             LEFT JOIN video_items v ON v.id = a.video_id
             LEFT JOIN users g ON g.id = a.granted_by
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
                                year: a.year,
                                videoId: a.video_id || null,
                                videoTitle: a.video_title || '',
                                source: a.source,
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

    app.post('/api/admin/videos/access', admin, (req, res) => {
        const b = req.body || {};
        const userId = parseInt(b.userId, 10);
        const year = parseYear(b.year);
        const videoId = b.videoId === '' || b.videoId == null ? null : parseInt(b.videoId, 10);
        const source = b.source === 'admin_paid' ? 'admin_paid' : 'admin_free';
        const amount = source === 'admin_paid' ? parsePrice(b.amountInr) : null;
        if (!(userId > 0) || !year) return res.status(400).json({ error: 'Choose a doctor and a year.' });
        if (source === 'admin_paid' && !(amount > 0)) return res.status(400).json({ error: 'Enter the amount that was paid.' });
        const insert = () =>
            db.run(
                `INSERT INTO video_access (user_id, year, video_id, source, amount_inr, note, order_id, granted_by, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
                [userId, year, videoId, source, amount, cleanText(b.note, 300), req.adminId, nowIso()],
                function (err) {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ ok: true, id: this.lastID });
                }
            );
        if (!videoId) return insert();
        db.get(`SELECT id FROM video_items WHERE id = ? AND year = ?`, [videoId, year], (err, v) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!v) return res.status(400).json({ error: 'That video does not belong to the chosen year.' });
            insert();
        });
    });

    app.post('/api/admin/videos/access/:id/revoke', admin, (req, res) => {
        const id = numId(req.params.id);
        if (!id) return res.status(404).json({ error: 'Grant not found' });
        db.run(`UPDATE video_access SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, [nowIso(), id], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ok: true, changed: this.changes });
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
    hlsArgs,
    FREE_REGISTRATION_STATUSES,
    ROOT
};
