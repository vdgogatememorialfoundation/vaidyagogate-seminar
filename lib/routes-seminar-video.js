'use strict';

const r2Storage = require('./r2-storage');

function registerSeminarVideoRoutes(app, deps) {
    if (!app) throw new Error('Express app is required');
    if (!deps || !deps.db) throw new Error('Database dependency is required');
    const db = deps.db;
    const assertAdminPortalActor = deps.assertAdminPortalActor;

    function admin(req, res, next) {
        try {
            if (typeof assertAdminPortalActor === 'function') return assertAdminPortalActor(req, res, next);
            return next();
        } catch (e) { return res.status(403).json({ success: false, error: e.message }); }
    }

    app.post('/api/admin/seminar-videos/upload/init', admin, async (req, res) => {
        try {
            const body = req.body || {};
            const seminarId = Number(body.seminarId || 0);
            const sizeBytes = Number(body.sizeBytes || 0);
            const originalName = String(body.originalName || 'video.mp4').trim();
            const mimeType = String(body.mimeType || 'video/mp4').trim();
            if (!seminarId || !sizeBytes || sizeBytes < 1) return res.status(400).json({ success: false, error: 'seminarId and sizeBytes are required.' });
            if (sizeBytes > 20 * 1024 * 1024 * 1024) return res.status(400).json({ success: false, error: 'Video exceeds the 20 GB upload limit.' });
            if (!/^video\//i.test(mimeType)) return res.status(400).json({ success: false, error: 'Only video files are allowed.' });
            const uploadId = r2Storage.newUploadId();
            const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
            const storageKey = 'seminar-videos/' + seminarId + '/' + uploadId + '/' + safeName;
            const multipartUploadId = await r2Storage.createMultipartUpload(storageKey, mimeType);
            const parts = r2Storage.planMultipartParts(sizeBytes);
            db.run('INSERT INTO seminar_video_uploads (id,seminar_id,storage_key,original_name,mime_type,size_bytes,multipart_upload_id,status,created_by) VALUES (?,?,?,?,?,?,?,?,?)', [uploadId,seminarId,storageKey,originalName,mimeType,sizeBytes,multipartUploadId,'initiated',Number(body.createdBy || 0) || null], function(err) {
                if (err) return res.status(500).json({ success: false, error: err.message });
                res.json({ success: true, uploadId, storageKey, multipartUploadId, parts });
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get('/api/admin/seminar-videos/upload/:uploadId/parts', admin, async (req, res) => {
        try {
            const id = String(req.params.uploadId || '');
            db.get('SELECT * FROM seminar_video_uploads WHERE id = ?', [id], async (err, row) => {
                if (err) return res.status(500).json({ success: false, error: err.message });
                if (!row) return res.status(404).json({ success: false, error: 'Upload not found.' });
                const parts = await r2Storage.listUploadedParts(row.storage_key, row.multipart_upload_id);
                res.json({ success: true, parts });
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/admin/seminar-videos/upload/:uploadId/part-url', admin, async (req, res) => {
        try {
            const id = String(req.params.uploadId || '');
            const partNumber = Number(req.body && req.body.partNumber || 0);
            if (!partNumber || partNumber < 1) return res.status(400).json({ success: false, error: 'partNumber is required.' });
            db.get('SELECT * FROM seminar_video_uploads WHERE id = ?', [id], async (err, row) => {
                if (err) return res.status(500).json({ success: false, error: err.message });
                if (!row) return res.status(404).json({ success: false, error: 'Upload not found.' });
                const out = await r2Storage.presignUploadPart(row.storage_key, row.multipart_upload_id, partNumber);
                res.json({ success: true, ...out });
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/admin/seminar-videos/upload/:uploadId/complete', admin, async (req, res) => {
        try {
            const id = String(req.params.uploadId || '');
            const parts = Array.isArray(req.body && req.body.parts) ? req.body.parts : [];
            if (!parts.length) return res.status(400).json({ success: false, error: 'Uploaded parts are required.' });
            db.get('SELECT * FROM seminar_video_uploads WHERE id = ?', [id], async (err, row) => {
                if (err) return res.status(500).json({ success: false, error: err.message });
                if (!row) return res.status(404).json({ success: false, error: 'Upload not found.' });
                await r2Storage.completeMultipartUpload(row.storage_key, row.multipart_upload_id, parts.map(x => ({ PartNumber: Number(x.PartNumber || x.partNumber), ETag: String(x.ETag || x.etag || '') })));
                db.run('UPDATE seminar_video_uploads SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['completed', id], function(uErr) {
                    if (uErr) return res.status(500).json({ success: false, error: uErr.message });
                    res.json({ success: true, storageKey: row.storage_key });
                });
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.delete('/api/admin/seminar-videos/upload/:uploadId', admin, async (req, res) => {
        try {
            const id = String(req.params.uploadId || '');
            db.get('SELECT * FROM seminar_video_uploads WHERE id = ?', [id], async (err, row) => {
                if (err) return res.status(500).json({ success: false, error: err.message });
                if (!row) return res.status(404).json({ success: false, error: 'Upload not found.' });
                await r2Storage.abortMultipartUpload(row.storage_key, row.multipart_upload_id);
                db.run('UPDATE seminar_video_uploads SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['aborted', id], function(uErr) {
                    if (uErr) return res.status(500).json({ success: false, error: uErr.message });
                    res.json({ success: true });
                });
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get('/api/admin/seminar-videos', admin, (req, res) => {
        const seminarId = Number(req.query.seminarId || 0);
        const sql = seminarId > 0
            ? 'SELECT * FROM seminar_videos WHERE seminar_id = ? ORDER BY sort_order ASC, id DESC'
            : 'SELECT * FROM seminar_videos ORDER BY seminar_id DESC, sort_order ASC, id DESC';
        db.all(sql, seminarId > 0 ? [seminarId] : [], (err, rows) => {
            if (err) return res.status(500).json({ success: false, error: err.message });
            res.json({ success: true, videos: rows || [] });
        });
    });

    app.post('/api/admin/seminar-videos', admin, (req, res) => {
        const body = req.body || {};
        const seminarId = Number(body.seminarId || 0);
        const title = String(body.title || '').trim();
        const storageKey = String(body.storageKey || '').trim();
        const originalName = String(body.originalName || '').trim();
        const mimeType = String(body.mimeType || 'video/mp4').trim();
        const sizeBytes = Math.max(0, Number(body.sizeBytes || 0));
        const price = Math.max(0, Number(body.accessPrice || 0));
        if (!seminarId || !title || !storageKey) return res.status(400).json({ success: false, error: 'seminarId, title and storageKey are required.' });
        db.run('INSERT INTO seminar_videos (seminar_id,title,description,storage_key,original_name,mime_type,size_bytes,access_price,is_free,is_published,sort_order,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [seminarId,title,String(body.description || ''),storageKey,originalName,mimeType,sizeBytes,price,body.isFree ? 1 : 0,body.isPublished ? 1 : 0,Number(body.sortOrder || 0),Number(body.createdBy || 0) || null], function(err) {
            if (err) return res.status(500).json({ success: false, error: err.message });
            res.json({ success: true, id: this.lastID });
        });
    });

    app.patch('/api/admin/seminar-videos/:id', admin, (req, res) => {
        const id = Number(req.params.id || 0);
        if (!id) return res.status(400).json({ success: false, error: 'Invalid video id.' });
        const body = req.body || {};
        db.run('UPDATE seminar_videos SET title = COALESCE(?,title), description = COALESCE(?,description), access_price = COALESCE(?,access_price), is_free = COALESCE(?,is_free), is_published = COALESCE(?,is_published), sort_order = COALESCE(?,sort_order), updated_at = CURRENT_TIMESTAMP WHERE id = ?', [body.title == null ? null : String(body.title).trim(),body.description == null ? null : String(body.description),body.accessPrice == null ? null : Math.max(0,Number(body.accessPrice)),body.isFree == null ? null : (body.isFree ? 1 : 0),body.isPublished == null ? null : (body.isPublished ? 1 : 0),body.sortOrder == null ? null : Number(body.sortOrder),id], function(err) {
            if (err) return res.status(500).json({ success: false, error: err.message });
            if (!this.changes) return res.status(404).json({ success: false, error: 'Video not found.' });
            res.json({ success: true });
        });
    });

    app.delete('/api/admin/seminar-videos/:id', admin, (req, res) => {
        const id = Number(req.params.id || 0);
        if (!id) return res.status(400).json({ success: false, error: 'Invalid video id.' });
        db.run('DELETE FROM seminar_videos WHERE id = ?', [id], function(err) {
            if (err) return res.status(500).json({ success: false, error: err.message });
            if (!this.changes) return res.status(404).json({ success: false, error: 'Video not found.' });
            res.json({ success: true });
        });
    });
}

module.exports = { registerSeminarVideoRoutes };
