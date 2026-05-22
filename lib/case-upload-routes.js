/**
 * Direct-to-R2 case file uploads (presigned + multipart).
 */
const multer = require('multer');
const r2Storage = require('./r2-storage');
const uploadLimits = require('./upload-limits');
const caseFileTypes = require('./case-file-types');
const caseFileAccess = require('./case-file-access');
const { safeInternalUserRowId } = require('./internal-user-id');

const serverUploadMulter = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: uploadLimits.getHostMaxBytes() }
});

function ignoreSchemaErr(e) {
    if (e && !/duplicate column|already exists/i.test(String(e.message))) {
        console.warn('[case-upload]', e.message);
    }
}

function ensureCaseUploadSchema(db, cb) {
    const isPg = !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
    const pendingSql = isPg
        ? `CREATE TABLE IF NOT EXISTS case_pending_uploads (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            case_program_id INTEGER NOT NULL,
            storage_key TEXT NOT NULL,
            original_name TEXT,
            mime_type TEXT,
            size_bytes BIGINT NOT NULL,
            multipart_upload_id TEXT,
            status TEXT DEFAULT 'initiated',
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
        : `CREATE TABLE IF NOT EXISTS case_pending_uploads (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            case_program_id INTEGER NOT NULL,
            storage_key TEXT NOT NULL,
            original_name TEXT,
            mime_type TEXT,
            size_bytes INTEGER NOT NULL,
            multipart_upload_id TEXT,
            status TEXT DEFAULT 'initiated',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`;
    const fileAlters = [
        'ALTER TABLE case_files ADD COLUMN storage_key TEXT',
        'ALTER TABLE case_files ADD COLUMN mime_type TEXT',
        'ALTER TABLE case_files ADD COLUMN size_bytes INTEGER'
    ];
    db.run(pendingSql, [], (e0) => {
        ignoreSchemaErr(e0);
        let i = 0;
        const next = () => {
            if (i >= fileAlters.length) return cb && cb();
            db.run(fileAlters[i], (e) => {
                ignoreSchemaErr(e);
                i++;
                next();
            });
        };
        next();
    });
}

function registerCaseUploadRoutes(app, deps) {
    const { db } = deps;
    if (!r2Storage.isR2Configured()) {
        console.log('[case-upload] R2 not configured — large direct uploads disabled');
        return;
    }
    ensureCaseUploadSchema(db);

    app.get('/api/case/uploads/config', async (req, res) => {
        try {
            const programId = parseInt(req.query.caseProgramId, 10);
            const r2Ok = await r2Storage.isR2Ready();
            const loadProgram = (cb) => {
                if (!Number.isInteger(programId)) return cb(null, null);
                db.get(`SELECT max_file_size_mb FROM case_programs WHERE id = ?`, [programId], (e, row) => {
                    if (e) return cb(e);
                    cb(null, row);
                });
            };
            loadProgram((e, row) => {
                if (e) return res.status(500).json({ error: e.message });
                res.json(uploadLimits.uploadConfigForClient(row && row.max_file_size_mb, r2Ok));
            });
        } catch (err) {
            res.status(500).json({ error: err.message || 'Config failed' });
        }
    });

    app.post('/api/case/uploads/init', async (req, res) => {
        try {
            const r2Ok = await r2Storage.isR2Ready();
            if (!r2Ok) {
                return res.status(503).json({
                    error: r2Storage.getR2SetupHint(),
                    r2Enabled: false
                });
            }
            const body = req.body || {};
            const userId = parseInt(body.userId, 10);
            const programId = parseInt(body.caseProgramId, 10);
            const fileName = String(body.fileName || '').trim();
            const mimeType = String(body.mimeType || 'application/octet-stream').trim();
            const sizeBytes = parseInt(body.sizeBytes, 10);
            if (!Number.isInteger(userId) || !Number.isInteger(programId)) {
                return res.status(400).json({ error: 'userId and caseProgramId required' });
            }
            if (!fileName) return res.status(400).json({ error: 'fileName required' });

            const typeCheck = caseFileTypes.isAllowedCaseFile(fileName, mimeType);
            if (!typeCheck.ok) return res.status(400).json({ error: typeCheck.error });

            db.get(`SELECT * FROM case_programs WHERE id = ? AND IFNULL(is_active, 1) = 1`, [programId], async (e0, program) => {
                if (e0) return res.status(500).json({ error: e0.message });
                if (!program) return res.status(404).json({ error: 'Case program not found' });

                const sizeCheck = uploadLimits.validateFileSizeBytes(sizeBytes, program.max_file_size_mb, true);
                if (!sizeCheck.ok) return res.status(400).json({ error: sizeCheck.error });

                const uploadId = r2Storage.newUploadId();
                const storageKey = r2Storage.makeCaseStorageKey(userId, programId, uploadId, fileName);

                const useMultipart = sizeBytes >= r2Storage.MULTIPART_THRESHOLD_BYTES;
                let multipartUploadId = null;
                let parts = [];

                if (useMultipart) {
                    multipartUploadId = await r2Storage.createMultipartUpload(storageKey, mimeType);
                    const planned = r2Storage.planMultipartParts(sizeBytes);
                    for (const p of planned) {
                        const signed = await r2Storage.presignUploadPart(storageKey, multipartUploadId, p.partNumber);
                        parts.push({
                            partNumber: p.partNumber,
                            size: p.size,
                            url: signed.url
                        });
                    }
                } else {
                    const signed = await r2Storage.presignPut(storageKey, mimeType);
                    parts = [{ partNumber: 1, size: sizeBytes, url: signed.url, method: 'PUT' }];
                }

                db.run(
                    `INSERT INTO case_pending_uploads (id, user_id, case_program_id, storage_key, original_name, mime_type, size_bytes, multipart_upload_id, status)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'initiated')`,
                    [uploadId, userId, programId, storageKey, fileName, mimeType, sizeBytes, multipartUploadId],
                    (insErr) => {
                        if (insErr) return res.status(500).json({ error: insErr.message });
                        res.json({
                            uploadId,
                            storageKey,
                            multipart: useMultipart,
                            multipartUploadId,
                            partSize: r2Storage.PART_SIZE_BYTES,
                            parts,
                            maxMb: sizeCheck.maxMb
                        });
                    }
                );
            });
        } catch (err) {
            console.error('[case-upload/init]', err);
            res.status(500).json({ error: err.message || 'Upload init failed' });
        }
    });

    app.post('/api/case/uploads/multipart/list', async (req, res) => {
        try {
            const { uploadId, userId } = req.body || {};
            if (!uploadId || !userId) return res.status(400).json({ error: 'uploadId and userId required' });
            db.get(
                `SELECT * FROM case_pending_uploads WHERE id = ? AND user_id = ? AND status IN ('initiated','uploading')`,
                [uploadId, parseInt(userId, 10)],
                async (e, row) => {
                    if (e) return res.status(500).json({ error: e.message });
                    if (!row) return res.status(404).json({ error: 'Upload session not found' });
                    if (!row.multipart_upload_id) {
                        return res.json({ parts: [] });
                    }
                    const existing = await r2Storage.listUploadedParts(row.storage_key, row.multipart_upload_id);
                    res.json({ parts: existing });
                }
            );
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /** Browser → server → R2 when direct presigned PUT fails (CORS) or on small files. */
    app.post('/api/case/uploads/via-server', async (req, res) => {
        const r2Ok = await r2Storage.isR2Ready();
        if (!r2Ok) {
            return res.status(503).json({ error: r2Storage.getR2SetupHint(), r2Enabled: false });
        }
        serverUploadMulter.single('file')(req, res, async (multerErr) => {
            if (multerErr) {
                const msg =
                    multerErr.code === 'LIMIT_FILE_SIZE'
                        ? `File exceeds server upload limit (${uploadLimits.getServerProxyMaxMb()} MB on this host).`
                        : multerErr.message || 'Upload failed';
                return res.status(400).json({ error: msg });
            }
            try {
                const uploadId = String((req.body && req.body.uploadId) || '').trim();
                const userId = safeInternalUserRowId(req.body && req.body.userId);
                if (!uploadId || userId == null) {
                    return res.status(400).json({ error: 'uploadId and userId required' });
                }
                if (!req.file || !req.file.buffer) {
                    return res.status(400).json({ error: 'file required' });
                }
                db.get(
                    `SELECT * FROM case_pending_uploads WHERE id = ? AND user_id = ? AND status IN ('initiated','uploading')`,
                    [uploadId, userId],
                    async (e, row) => {
                        if (e) return res.status(500).json({ error: e.message });
                        if (!row) return res.status(404).json({ error: 'Upload session not found' });
                        const proxyMax = uploadLimits.getServerProxyMaxMb() * 1024 * 1024;
                        if (req.file.size > proxyMax) {
                            return res.status(400).json({
                                error:
                                    `File is too large for server relay (${uploadLimits.getServerProxyMaxMb()} MB max). ` +
                                    'Enable CORS on your R2 bucket for direct browser uploads, or compress the PDF.'
                            });
                        }
                        try {
                            await r2Storage.putObjectBuffer(
                                row.storage_key,
                                req.file.buffer,
                                req.file.mimetype || row.mime_type
                            );
                            if (row.multipart_upload_id) {
                                await r2Storage.abortMultipartUpload(row.storage_key, row.multipart_upload_id);
                            }
                            db.run(
                                `UPDATE case_pending_uploads SET status = 'completed', multipart_upload_id = NULL WHERE id = ?`,
                                [uploadId],
                                (uErr) => {
                                    if (uErr) return res.status(500).json({ error: uErr.message });
                                    res.json({
                                        success: true,
                                        uploadId,
                                        viaServer: true
                                    });
                                }
                            );
                        } catch (putErr) {
                            console.error('[case-upload/via-server]', putErr);
                            res.status(500).json({ error: putErr.message || 'Could not store file' });
                        }
                    }
                );
            } catch (err) {
                res.status(500).json({ error: err.message || 'Upload failed' });
            }
        });
    });

    app.post('/api/case/uploads/complete', async (req, res) => {
        try {
            const body = req.body || {};
            const uploadId = String(body.uploadId || '').trim();
            const userId = parseInt(body.userId, 10);
            const parts = Array.isArray(body.parts) ? body.parts : [];
            if (!uploadId || !Number.isInteger(userId)) {
                return res.status(400).json({ error: 'uploadId and userId required' });
            }

            db.get(
                `SELECT * FROM case_pending_uploads WHERE id = ? AND user_id = ?`,
                [uploadId, userId],
                async (e, row) => {
                    if (e) return res.status(500).json({ error: e.message });
                    if (!row) return res.status(404).json({ error: 'Upload session not found' });
                    if (row.status === 'completed') {
                        return res.json({
                            success: true,
                            uploadId,
                            storageKey: row.storage_key,
                            originalName: row.original_name,
                            mimeType: row.mime_type,
                            sizeBytes: row.size_bytes
                        });
                    }

                    try {
                        if (row.multipart_upload_id) {
                            if (!parts.length) {
                                return res.status(400).json({ error: 'parts array required for multipart upload' });
                            }
                            const normalized = parts
                                .map((p) => ({
                                    PartNumber: parseInt(p.partNumber || p.PartNumber, 10),
                                    ETag: String(p.etag || p.ETag || '').replace(/^"|"$/g, '')
                                }))
                                .filter((p) => p.PartNumber > 0 && p.ETag);
                            if (!normalized.length) {
                                return res.status(400).json({ error: 'Valid part ETags required' });
                            }
                            await r2Storage.completeMultipartUpload(
                                row.storage_key,
                                row.multipart_upload_id,
                                normalized
                            );
                        }
                    } catch (completeErr) {
                        return res.status(400).json({ error: completeErr.message || 'Could not complete upload' });
                    }

                    db.run(
                        `UPDATE case_pending_uploads SET status = 'completed' WHERE id = ?`,
                        [uploadId],
                        (uErr) => {
                            if (uErr) return res.status(500).json({ error: uErr.message });
                            res.json({
                                success: true,
                                uploadId,
                                storageKey: row.storage_key,
                                originalName: row.original_name,
                                mimeType: row.mime_type,
                                sizeBytes: row.size_bytes
                            });
                        }
                    );
                }
            );
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/case/files/:fileId/access', async (req, res) => {
        const fileId = parseInt(req.params.fileId, 10);
        const userId = parseInt(req.query.userId, 10);
        const judgeUserId = parseInt(req.query.judgeUserId, 10);
        const download = req.query.download === '1' || req.query.download === 'true';
        if (!Number.isInteger(fileId)) return res.status(400).json({ error: 'Invalid file id' });

        db.get(`SELECT cf.*, cs.user_id AS owner_id FROM case_files cf JOIN case_submissions cs ON cs.id = cf.submission_id WHERE cf.id = ?`, [fileId], async (e, fileRow) => {
            if (e) return res.status(500).json({ error: e.message });
            if (!fileRow) return res.status(404).json({ error: 'File not found' });

            const authorize = (cb) => {
                if (Number.isInteger(userId) && userId === fileRow.owner_id) return cb(null, true);
                if (!Number.isInteger(judgeUserId)) return cb(null, false);
                db.get(
                    `SELECT 1 FROM case_judge_assignments WHERE submission_id = ? AND judge_user_id = ?`,
                    [fileRow.submission_id, judgeUserId],
                    (eJ, row) => {
                        if (eJ) return cb(eJ);
                        cb(null, !!row);
                    }
                );
            };

            authorize(async (authErr, ok) => {
                if (authErr) return res.status(500).json({ error: authErr.message });
                if (!ok) return res.status(403).json({ error: 'Access denied' });

                const key = caseFileAccess.storageKeyFromRow(fileRow);
                if (key && (await r2Storage.isR2Ready())) {
                    try {
                        const signed = await r2Storage.presignGet(key, {
                            mimeType: fileRow.mime_type,
                            filename: fileRow.original_name,
                            download
                        });
                        return res.json({
                            url: signed.url,
                            expiresAt: signed.expiresAt,
                            previewKind: caseFileTypes.previewKind(fileRow.original_name, fileRow.mime_type)
                        });
                    } catch (signErr) {
                        return res.status(500).json({ error: signErr.message });
                    }
                }
                if (fileRow.file_path) {
                    return res.json({
                        url: fileRow.file_path,
                        previewKind: caseFileTypes.previewKind(fileRow.original_name, fileRow.mime_type)
                    });
                }
                res.status(404).json({ error: 'File storage not available' });
            });
        });
    });

    console.log('[case-upload] R2 direct upload routes registered');
}

function attachPendingUploads(db, userId, programId, uploadIds, cb) {
    if (!uploadIds || !uploadIds.length) return cb(null, []);
    const placeholders = uploadIds.map(() => '?').join(',');
    db.all(
        `SELECT * FROM case_pending_uploads WHERE id IN (${placeholders}) AND user_id = ? AND case_program_id = ? AND status = 'completed'`,
        [...uploadIds, userId, programId],
        (e, rows) => {
            if (e) return cb(e);
            if ((rows || []).length !== uploadIds.length) {
                return cb(new Error('One or more uploads are missing or not finished. Wait for upload to complete.'));
            }
            cb(
                null,
                (rows || []).map((r) => ({
                    storageKey: r.storage_key,
                    originalName: r.original_name,
                    mimeType: r.mime_type,
                    sizeBytes: r.size_bytes,
                    uploadId: r.id
                }))
            );
        }
    );
}

function insertCaseFilesFromR2(db, submissionId, uploads, startOrder, cb) {
    const list = uploads || [];
    if (!list.length) return cb(null);
    let i = 0;
    const r2 = require('./r2-storage');
    const next = () => {
        if (i >= list.length) return cb(null);
        const u = list[i];
        const order = startOrder + i;
        const marker = r2.r2FilePathMarker(u.storageKey);
        db.run(
            `INSERT INTO case_files (submission_id, file_path, storage_key, original_name, mime_type, size_bytes, sort_order, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
            [submissionId, marker, u.storageKey, u.originalName, u.mimeType, u.sizeBytes, order],
            (err) => {
                if (err) return cb(err);
                db.run(`UPDATE case_pending_uploads SET status = 'attached' WHERE id = ?`, [u.uploadId], () => {
                    i++;
                    next();
                });
            }
        );
    };
    next();
}

module.exports = {
    ensureCaseUploadSchema,
    registerCaseUploadRoutes,
    attachPendingUploads,
    insertCaseFilesFromR2
};
