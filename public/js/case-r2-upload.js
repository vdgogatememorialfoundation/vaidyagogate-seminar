/**
 * Direct upload to Cloudflare R2 via presigned URLs (progress + multipart).
 */
(function (global) {
    let cachedConfig = null;

    function formatBytes(n) {
        const b = Number(n) || 0;
        if (b < 1024) return b + ' B';
        if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
        return (b / (1024 * 1024)).toFixed(1) + ' MB';
    }

    async function loadConfig(caseProgramId) {
        const q = caseProgramId ? '?caseProgramId=' + encodeURIComponent(caseProgramId) : '';
        const res = await fetch('/api/case/uploads/config' + q, { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not load upload settings');
        if (data.r2SetupError) {
            data.r2Enabled = false;
        }
        cachedConfig = data;
        return data;
    }

    function isEnabled(config) {
        return !!(config && config.r2Enabled);
    }

    function xhrPutWithProgress(url, file, mimeType, onProgress) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('PUT', url, true);
            if (mimeType) xhr.setRequestHeader('Content-Type', mimeType);
            xhr.upload.onprogress = (ev) => {
                if (ev.lengthComputable && onProgress) {
                    onProgress(Math.round((ev.loaded / ev.total) * 100), ev.loaded, ev.total);
                }
            };
            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    const etag = xhr.getResponseHeader('ETag') || xhr.getResponseHeader('etag');
                    resolve(etag ? etag.replace(/^"|"$/g, '') : '');
                } else {
                    reject(new Error('Upload failed (HTTP ' + xhr.status + ')'));
                }
            };
            xhr.onerror = () => reject(new Error('Network error during upload'));
            xhr.ontimeout = () => reject(new Error('Upload timed out — try again on stable Wi‑Fi'));
            xhr.timeout = 0;
            xhr.send(file);
        });
    }

    async function uploadSinglePart(url, blob, mimeType) {
        return xhrPutWithProgress(url, blob, mimeType);
    }

    async function uploadViaServer(file, init, userId, onProgress) {
        const proxyMaxMb = (cachedConfig && cachedConfig.serverProxyMaxMb) || 4;
        if (file.size > proxyMaxMb * 1024 * 1024) {
            throw new Error(
                'Direct upload blocked (browser/R2). File is over ' +
                    proxyMaxMb +
                    ' MB server relay limit — compress the PDF or configure R2 CORS for your site domain.'
            );
        }
        const fd = new FormData();
        fd.append('file', file);
        fd.append('uploadId', init.uploadId);
        fd.append('userId', String(userId));
        if (onProgress) onProgress(10, 0, file.size);
        const res = await fetch('/api/case/uploads/via-server', { method: 'POST', body: fd });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Server upload failed');
        if (onProgress) onProgress(100, file.size, file.size);
        return init.uploadId;
    }

    async function uploadFile(file, opts) {
        const options = opts || {};
        const userId = options.userId;
        const caseProgramId = options.caseProgramId;
        const onProgress = options.onProgress;
        if (!userId || !caseProgramId) throw new Error('userId and caseProgramId required');

        const initRes = await fetch('/api/case/uploads/init', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId,
                caseProgramId,
                fileName: file.name,
                mimeType: file.type || 'application/octet-stream',
                sizeBytes: file.size
            })
        });
        const init = await initRes.json().catch(() => ({}));
        if (!initRes.ok) throw new Error(init.error || 'Upload init failed');

        const tryDirectThenServer = async (directFn) => {
            try {
                return await directFn();
            } catch (directErr) {
                const msg = String(directErr && directErr.message ? directErr.message : '');
                const networkish =
                    /network error|failed to fetch|upload failed \(http/i.test(msg) ||
                    directErr.name === 'TypeError';
                if (!networkish || !cachedConfig || !cachedConfig.serverProxyEnabled) throw directErr;
                return uploadViaServer(file, init, userId, onProgress);
            }
        };

        if (init.multipart && init.parts && init.parts.length) {
            return tryDirectThenServer(async () => {
                const completedParts = [];
                let uploaded = 0;
                for (const part of init.parts) {
                    const start = (part.partNumber - 1) * (init.partSize || 8 * 1024 * 1024);
                    const end = Math.min(file.size, start + part.size);
                    const chunk = file.slice(start, end);
                    const etag = await uploadSinglePart(part.url, chunk, file.type);
                    completedParts.push({ partNumber: part.partNumber, etag });
                    uploaded += chunk.size;
                    if (onProgress) onProgress(Math.round((uploaded / file.size) * 100), uploaded, file.size);
                }
                const completeRes = await fetch('/api/case/uploads/complete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        uploadId: init.uploadId,
                        userId,
                        parts: completedParts
                    })
                });
                const complete = await completeRes.json().catch(() => ({}));
                if (!completeRes.ok) throw new Error(complete.error || 'Upload complete failed');
                return init.uploadId;
            });
        }

        const part = init.parts && init.parts[0];
        if (!part || !part.url) throw new Error('No upload URL returned');
        return tryDirectThenServer(async () => {
            await xhrPutWithProgress(part.url, file, file.type, onProgress);
            const completeRes = await fetch('/api/case/uploads/complete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uploadId: init.uploadId, userId })
            });
            const complete = await completeRes.json().catch(() => ({}));
            if (!completeRes.ok) throw new Error(complete.error || 'Upload complete failed');
            return init.uploadId;
        });
    }

    async function uploadFiles(files, opts) {
        const list = Array.from(files || []);
        const uploadIds = [];
        const options = opts || {};
        for (let i = 0; i < list.length; i++) {
            const file = list[i];
            const fileProgress = (pct, loaded, total) => {
                if (options.onFileProgress) {
                    options.onFileProgress(i, list.length, file.name, pct, loaded, total);
                }
            };
            const id = await uploadFile(file, {
                userId: options.userId,
                caseProgramId: options.caseProgramId,
                onProgress: fileProgress
            });
            uploadIds.push(id);
        }
        return uploadIds;
    }

    global.CaseR2Upload = {
        formatBytes,
        loadConfig,
        isEnabled,
        uploadFile,
        uploadFiles
    };
})(typeof window !== 'undefined' ? window : global);
