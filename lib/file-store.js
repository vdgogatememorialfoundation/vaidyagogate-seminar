/**
 * Upload persistence: disk on Render/local; DB blobs if UPLOAD_USE_DB=1.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function useBlobStore() {
    return process.env.UPLOAD_USE_DB === '1';
}

function makeStorageKey(originalname) {
    return Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(originalname || '');
}

function assignFilenames(req) {
    const list = req.files || (req.file ? [req.file] : []);
    list.forEach((f) => {
        if (!f.filename) f.filename = makeStorageKey(f.originalname);
    });
}

function ensureSchema(db, cb) {
    const isPg = !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
    const sql = isPg
        ? `CREATE TABLE IF NOT EXISTS file_blobs (
            storage_key TEXT PRIMARY KEY,
            mime_type TEXT,
            original_name TEXT,
            data BYTEA NOT NULL,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
        : `CREATE TABLE IF NOT EXISTS file_blobs (
            storage_key TEXT PRIMARY KEY,
            mime_type TEXT,
            original_name TEXT,
            data BLOB NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`;
    db.run(sql, [], (e) => cb && cb(e));
}

function publicPath(storageKey) {
    return '/uploads/' + storageKey;
}

/** Turn stored path (filename, /uploads/…, /api/assets/…) into a browser URL. */
function publicFileUrl(storedPath) {
    let p = String(storedPath || '').trim();
    if (!p) return '';
    if (/^https?:\/\//i.test(p)) return p;
    if (p.startsWith('/uploads/api/assets/')) {
        p = '/api/assets/' + p.slice('/uploads/api/assets/'.length);
    }
    if (p.startsWith('/')) return p;
    return publicPath(p);
}

function readUploadBuffer(file) {
    if (!file) return null;
    if (file.buffer && file.buffer.length) return file.buffer;
    if (file.path && fs.existsSync(file.path)) {
        try {
            return fs.readFileSync(file.path);
        } catch (_) {
            return null;
        }
    }
    return null;
}

/** Mirror /uploads/… files into file_blobs so ephemeral disk loss does not break URLs. */
function mirrorUploadPathToBlobStore(db, file, uploadPath, cb) {
    const storageKey = path.basename(
        String(uploadPath || '')
            .replace(/^\/uploads\//, '')
            .split('?')[0]
    );
    if (!storageKey) return cb(null, uploadPath);
    const buffer = readUploadBuffer(file);
    if (!buffer || !buffer.length) return cb(null, uploadPath);
    ensureSchema(db, (schemaErr) => {
        if (schemaErr) return cb(schemaErr);
        storeBlob(db, storageKey, buffer, file.mimetype, file.originalname, (storeErr) => {
            if (storeErr) return cb(storeErr);
            cb(null, uploadPath);
        });
    });
}

function storeBlob(db, storageKey, buffer, mime, originalName, cb) {
    db.run(
        `INSERT INTO file_blobs (storage_key, mime_type, original_name, data) VALUES (?, ?, ?, ?)`,
        [storageKey, mime || 'application/octet-stream', originalName || storageKey, buffer],
        (err) => {
            if (!err) return cb();
            const msg = String(err.message || err);
            if (!/unique|duplicate/i.test(msg)) return cb(err);
            db.run(
                `UPDATE file_blobs SET mime_type = ?, original_name = ?, data = ? WHERE storage_key = ?`,
                [mime || 'application/octet-stream', originalName || storageKey, buffer, storageKey],
                cb
            );
        }
    );
}

function persistMulterFile(db, file, uploadsDir, cb) {
    if (!file) return cb(null, null);
    const storageKey = file.filename || makeStorageKey(file.originalname);
    if (!file.filename) file.filename = storageKey;

    const r2 = require('./r2-storage');
    if (r2.isR2Configured()) {
        const buffer = readUploadBuffer(file);
        if (buffer && buffer.length) {
            return r2.putObjectBuffer(storageKey, buffer, file.mimetype)
                .then(() => {
                    const url = `https://${r2.getAccountId()}.r2.cloudflarestorage.com/${r2.getBucket()}/${storageKey}`;
                    cb(null, url);
                })
                .catch(cb);
        }
    }

    if (file.path && fs.existsSync(file.path)) {
        const uploadPath = publicPath(path.basename(file.path));
        return mirrorUploadPathToBlobStore(db, file, uploadPath, cb);
    }

    const buffer = readUploadBuffer(file);
    if (!buffer || !buffer.length) {
        const diskPath = path.join(uploadsDir, storageKey);
        if (fs.existsSync(diskPath)) {
            const uploadPath = publicPath(storageKey);
            return mirrorUploadPathToBlobStore(
                db,
                { path: diskPath, mimetype: file.mimetype, originalname: file.originalname },
                uploadPath,
                cb
            );
        }
        return cb(new Error('Upload file data missing'));
    }

    if (useBlobStore()) {
        return ensureSchema(db, (schemaErr) => {
            if (schemaErr) return cb(schemaErr);
            storeBlob(db, storageKey, buffer, file.mimetype, file.originalname, (storeErr) => {
                if (storeErr) return cb(storeErr);
                cb(null, publicPath(storageKey));
            });
        });
    }

    try {
        fs.mkdirSync(uploadsDir, { recursive: true });
        fs.writeFileSync(path.join(uploadsDir, storageKey), buffer);
        mirrorUploadPathToBlobStore(
            db,
            { buffer, mimetype: file.mimetype, originalname: file.originalname },
            publicPath(storageKey),
            cb
        );
    } catch (e) {
        cb(e);
    }
}

function persistMulterFiles(db, files, uploadsDir, cb) {
    const list = files || [];
    if (!list.length) return cb(null, []);
    const paths = [];
    let i = 0;
    const next = () => {
        if (i >= list.length) return cb(null, paths);
        persistMulterFile(db, list[i], uploadsDir, (err, p) => {
            if (err) return cb(err);
            paths.push(p);
            i++;
            next();
        });
    };
    next();
}

function wrapMulter(multerInstance) {
    return {
        single(field) {
            return (req, res, next) => {
                multerInstance.single(field)(req, res, (err) => {
                    if (err) return next(err);
                    assignFilenames(req);
                    next();
                });
            };
        },
        array(field, max) {
            return (req, res, next) => {
                multerInstance.array(field, max)(req, res, (err) => {
                    if (err) return next(err);
                    assignFilenames(req);
                    next();
                });
            };
        }
    };
}

function createUploadHandler(diskUpload, memoryUpload) {
    return wrapMulter(useBlobStore() ? memoryUpload : diskUpload);
}

function persistToGlobalAsset(db, upsertGlobalSetting, file, prefix, cb) {
    if (!file) return cb(null, null);
    if (!file.filename) file.filename = makeStorageKey(file.originalname);
    const key =
        (prefix || 'upload_asset_') + Date.now() + '_' + crypto.randomBytes(6).toString('hex');
    const buffer = file.buffer;

    const r2 = require('./r2-storage');
    if (r2.isR2Configured() && buffer && buffer.length) {
        return r2.putObjectBuffer(key, buffer, file.mimetype)
            .then(() => {
                const url = `https://${r2.getAccountId()}.r2.cloudflarestorage.com/${r2.getBucket()}/${key}`;
                cb(null, url);
            })
            .catch(cb);
    }

    if (useBlobStore() && buffer && buffer.length) {
        return ensureSchema(db, (schemaErr) => {
            if (schemaErr) return cb(schemaErr);
            storeBlob(db, key, buffer, file.mimetype, file.originalname, (storeErr) => {
                if (storeErr) return cb(storeErr);
                cb(null, '/api/assets/' + encodeURIComponent(key));
            });
        });
    }
    if (file.path) return cb(null, publicPath(path.basename(file.path)));
    if (buffer && buffer.length && upsertGlobalSetting) {
        const payload = JSON.stringify({
            mime: file.mimetype || 'application/octet-stream',
            data: buffer.toString('base64'),
            name: file.originalname || 'file'
        });
        return upsertGlobalSetting(key, payload, (err) => {
            if (err) return cb(err);
            cb(null, '/api/assets/' + encodeURIComponent(key));
        });
    }
    if (file.filename) return cb(null, publicPath(file.filename));
    cb(null, null);
}

function serveUploadHandler(db, uploadsDir) {
    return function serveUpload(req, res) {
        const raw = String(req.params.filename || req.params[0] || '');
        if (raw.startsWith('api/assets/') || raw.startsWith('api%2Fassets%2F')) {
            const key = decodeURIComponent(raw.replace(/^api\/assets\//i, '').replace(/^api%2Fassets%2F/i, ''));
            if (isAllowedAssetKey(key)) {
                req.params = { key };
                return serveAssetHandler(db)(req, res);
            }
        }
        const name = path.basename(raw);
        if (!name || name.includes('..')) return res.status(400).end();

        const diskPath = path.join(uploadsDir, name);
        if (fs.existsSync(diskPath)) {
            return res.sendFile(diskPath);
        }

        db.get(
            `SELECT mime_type, data FROM file_blobs WHERE storage_key = ?`,
            [name],
            (e, row) => {
                if (e) return res.status(500).end();
                if (!row || row.data == null) return res.status(404).end();
                const buf = normalizeBlobBuffer(row.data);
                if (!buf || !buf.length) return res.status(404).end();
                res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
                res.setHeader('Cache-Control', 'public, max-age=86400');
                res.send(buf);
            }
        );
    };
}

function isAllowedAssetKey(key) {
    return /^(upload_asset_|cert_|file_)[a-z0-9_]+$/i.test(key);
}

function normalizeBlobBuffer(data) {
    if (data == null) return null;
    let buf = data;
    if (Buffer.isBuffer(buf)) return buf.length ? buf : null;
    if (typeof buf === 'string') {
        if (/^\\x[0-9a-f]+$/i.test(buf)) {
            try {
                return Buffer.from(buf.slice(2), 'hex');
            } catch (_) {
                return null;
            }
        }
        try {
            return Buffer.from(buf, 'base64');
        } catch (_) {
            return Buffer.from(buf);
        }
    }
    try {
        return Buffer.from(buf);
    } catch (_) {
        return null;
    }
}

function serveAssetHandler(db) {
    return function serveAsset(req, res) {
        const key = decodeURIComponent(String(req.params.key || ''));
        if (!isAllowedAssetKey(key)) return res.status(400).json({ error: 'Invalid asset key' });

        db.get(`SELECT mime_type, data, original_name FROM file_blobs WHERE storage_key = ?`, [key], (eBlob, blobRow) => {
            if (eBlob) return res.status(500).end();
            if (blobRow && blobRow.data != null) {
                const buf = normalizeBlobBuffer(blobRow.data);
                if (!buf || !buf.length) {
                    /* fall through to global_settings */
                } else {
                    res.setHeader('Content-Type', blobRow.mime_type || 'application/octet-stream');
                    res.setHeader('Cache-Control', 'public, max-age=86400');
                    return res.send(buf);
                }
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
    };
}

module.exports = {
    useBlobStore,
    makeStorageKey,
    assignFilenames,
    ensureSchema,
    publicPath,
    publicFileUrl,
    normalizeBlobBuffer,
    persistMulterFile,
    persistMulterFiles,
    wrapMulter,
    createUploadHandler,
    persistToGlobalAsset,
    mirrorUploadPathToBlobStore,
    serveUploadHandler,
    serveAssetHandler,
    isAllowedAssetKey
};
