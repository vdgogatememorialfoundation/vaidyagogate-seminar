/**
 * Cloudflare R2 (S3-compatible) for large case presentation files.
 * Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME
 * Optional: R2_PUBLIC_URL (custom domain for public reads — not required with signed URLs)
 */
const crypto = require('crypto');
const path = require('path');

let _client = null;

const MULTIPART_THRESHOLD_BYTES = 10 * 1024 * 1024;
const PART_SIZE_BYTES = 8 * 1024 * 1024;
const UPLOAD_URL_EXPIRES_SEC = 7200;
const VIEW_URL_EXPIRES_SEC = 3600;

const READY_CACHE_MS = 120000;
let _readyCache = { at: 0, ok: false, error: '' };

function trimEnv(key) {
    const raw = process.env[key];
    if (raw == null || raw === '') return '';
    return String(raw).trim();
}

function normalizeR2Env() {
    const keys = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME'];
    keys.forEach((k) => {
        const v = trimEnv(k);
        if (v) process.env[k] = v;
    });
    if (!trimEnv('R2_BUCKET_NAME') && trimEnv('R2_BUCKET')) {
        process.env.R2_BUCKET_NAME = trimEnv('R2_BUCKET');
    }
}

normalizeR2Env();

function isR2Configured() {
    return !!(
        trimEnv('R2_ACCOUNT_ID') &&
        trimEnv('R2_ACCESS_KEY_ID') &&
        trimEnv('R2_SECRET_ACCESS_KEY') &&
        trimEnv('R2_BUCKET_NAME')
    );
}

function getBucket() {
    return trimEnv('R2_BUCKET_NAME');
}

function getAccountId() {
    return trimEnv('R2_ACCOUNT_ID');
}

function getClient() {
    if (_client) return _client;
    if (!isR2Configured()) return null;
    const accountId = getAccountId();
    const { S3Client } = require('@aws-sdk/client-s3');
    _client = new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: trimEnv('R2_ACCESS_KEY_ID'),
            secretAccessKey: trimEnv('R2_SECRET_ACCESS_KEY')
        },
        forcePathStyle: true
    });
    return _client;
}

function formatR2Error(err) {
    const msg = String((err && err.message) || err || 'R2 error');
    const code = String((err && err.name) || (err && err.Code) || '');
    if (/NoSuchBucket|bucket does not exist/i.test(msg + code)) {
        const bucket = getBucket() || '(not set)';
        return (
            `Cloudflare R2 bucket "${bucket}" was not found for account ${getAccountId() || '(not set)'}. ` +
            'In Vercel → Settings → Environment Variables, set R2_BUCKET_NAME to the exact bucket name shown in Cloudflare R2 (create the bucket first if needed).'
        );
    }
    if (/InvalidAccessKeyId|SignatureDoesNotMatch|Access Denied|403/i.test(msg)) {
        return 'R2 credentials are invalid or lack permission on this bucket. Regenerate the R2 API token with Object Read & Write for the bucket.';
    }
    return msg;
}

function getR2SetupHint() {
    if (!isR2Configured()) {
        return 'R2 is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET_NAME on Vercel.';
    }
    if (_readyCache.error) return _readyCache.error;
    return `Check R2 bucket name "${getBucket()}" in Cloudflare and Vercel env vars.`;
}

async function verifyBucketReachable() {
    if (!isR2Configured()) {
        _readyCache = { at: Date.now(), ok: false, error: 'R2 env vars missing' };
        return false;
    }
    const client = getClient();
    if (!client) {
        _readyCache = { at: Date.now(), ok: false, error: 'R2 client could not be created' };
        return false;
    }
    const { HeadBucketCommand } = require('@aws-sdk/client-s3');
    try {
        await client.send(new HeadBucketCommand({ Bucket: getBucket() }));
        _readyCache = { at: Date.now(), ok: true, error: '' };
        return true;
    } catch (err) {
        const hint = formatR2Error(err);
        console.warn('[r2] bucket check failed:', hint);
        _readyCache = { at: Date.now(), ok: false, error: hint };
        return false;
    }
}

/**
 * True only when env is set AND HeadBucket succeeds (cached ~2 min).
 */
async function isR2Ready() {
    if (!isR2Configured()) return false;
    if (Date.now() - _readyCache.at < READY_CACHE_MS && _readyCache.at > 0) {
        return _readyCache.ok;
    }
    return verifyBucketReachable();
}

function isR2ReadySync() {
    if (!isR2Configured()) return false;
    if (Date.now() - _readyCache.at < READY_CACHE_MS && _readyCache.at > 0) {
        return _readyCache.ok;
    }
    return false;
}

function invalidateR2ReadyCache() {
    _readyCache = { at: 0, ok: false, error: '' };
    _client = null;
    normalizeR2Env();
}

async function warmupR2() {
    if (!isR2Configured()) {
        console.log('[r2] not configured — case files use server upload (~4 MB on Vercel)');
        return false;
    }
    const ok = await verifyBucketReachable();
    if (ok) {
        console.log('[r2] bucket OK:', getBucket());
    } else {
        console.warn('[r2] bucket NOT ready:', _readyCache.error);
    }
    return ok;
}

function sanitizeExt(originalName) {
    const ext = path.extname(String(originalName || '')).toLowerCase().slice(0, 12);
    if (!ext || !/^\.[a-z0-9]+$/.test(ext)) return '';
    return ext;
}

function makeCaseStorageKey(userId, programId, uploadId, originalName) {
    const ext = sanitizeExt(originalName);
    return `case/${programId}/${userId}/${uploadId}${ext}`;
}

function r2FilePathMarker(storageKey) {
    return 'r2:' + storageKey;
}

function parseR2FilePath(filePath) {
    const p = String(filePath || '');
    if (p.startsWith('r2:')) return p.slice(3);
    return null;
}

async function presignPut(storageKey, mimeType, expiresSec) {
    const client = getClient();
    if (!client) throw new Error('R2 is not configured');
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const cmd = new PutObjectCommand({
        Bucket: getBucket(),
        Key: storageKey,
        ContentType: mimeType || 'application/octet-stream'
    });
    try {
        const url = await getSignedUrl(client, cmd, { expiresIn: expiresSec || UPLOAD_URL_EXPIRES_SEC });
        return { url, method: 'PUT', expiresIn: expiresSec || UPLOAD_URL_EXPIRES_SEC };
    } catch (err) {
        invalidateR2ReadyCache();
        throw new Error(formatR2Error(err));
    }
}

async function createMultipartUpload(storageKey, mimeType) {
    const client = getClient();
    if (!client) throw new Error('R2 is not configured');
    const { CreateMultipartUploadCommand } = require('@aws-sdk/client-s3');
    try {
        const out = await client.send(
            new CreateMultipartUploadCommand({
                Bucket: getBucket(),
                Key: storageKey,
                ContentType: mimeType || 'application/octet-stream'
            })
        );
        return out.UploadId;
    } catch (err) {
        invalidateR2ReadyCache();
        throw new Error(formatR2Error(err));
    }
}

async function presignUploadPart(storageKey, uploadId, partNumber) {
    const client = getClient();
    const { UploadPartCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const cmd = new UploadPartCommand({
        Bucket: getBucket(),
        Key: storageKey,
        UploadId: uploadId,
        PartNumber: partNumber
    });
    const url = await getSignedUrl(client, cmd, { expiresIn: UPLOAD_URL_EXPIRES_SEC });
    return { url, partNumber, expiresIn: UPLOAD_URL_EXPIRES_SEC };
}

async function listUploadedParts(storageKey, uploadId) {
    const client = getClient();
    const { ListPartsCommand } = require('@aws-sdk/client-s3');
    const out = await client.send(
        new ListPartsCommand({
            Bucket: getBucket(),
            Key: storageKey,
            UploadId: uploadId
        })
    );
    return (out.Parts || []).map((p) => ({
        PartNumber: p.PartNumber,
        ETag: p.ETag
    }));
}

async function completeMultipartUpload(storageKey, uploadId, parts) {
    const client = getClient();
    const { CompleteMultipartUploadCommand } = require('@aws-sdk/client-s3');
    const sorted = [...parts].sort((a, b) => a.PartNumber - b.PartNumber);
    await client.send(
        new CompleteMultipartUploadCommand({
            Bucket: getBucket(),
            Key: storageKey,
            UploadId: uploadId,
            MultipartUpload: { Parts: sorted }
        })
    );
}

async function abortMultipartUpload(storageKey, uploadId) {
    const client = getClient();
    if (!client || !uploadId) return;
    try {
        const { AbortMultipartUploadCommand } = require('@aws-sdk/client-s3');
        await client.send(
            new AbortMultipartUploadCommand({
                Bucket: getBucket(),
                Key: storageKey,
                UploadId: uploadId
            })
        );
    } catch (_) {}
}

async function presignGet(storageKey, opts) {
    const client = getClient();
    if (!client) throw new Error('R2 is not configured');
    const options = opts || {};
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const disposition = options.download
        ? `attachment; filename="${String(options.filename || 'file').replace(/"/g, '')}"`
        : 'inline';
    const cmd = new GetObjectCommand({
        Bucket: getBucket(),
        Key: storageKey,
        ResponseContentDisposition: disposition,
        ResponseContentType: options.mimeType || undefined
    });
    const url = await getSignedUrl(client, cmd, {
        expiresIn: options.expiresSec || VIEW_URL_EXPIRES_SEC
    });
    return {
        url,
        expiresIn: options.expiresSec || VIEW_URL_EXPIRES_SEC,
        expiresAt: new Date(Date.now() + (options.expiresSec || VIEW_URL_EXPIRES_SEC) * 1000).toISOString()
    };
}

function planMultipartParts(fileSize) {
    const partCount = Math.max(1, Math.ceil(fileSize / PART_SIZE_BYTES));
    const parts = [];
    for (let i = 1; i <= partCount; i++) {
        const start = (i - 1) * PART_SIZE_BYTES;
        const end = Math.min(fileSize, i * PART_SIZE_BYTES);
        parts.push({ partNumber: i, size: end - start });
    }
    return parts;
}

function newUploadId() {
    return crypto.randomBytes(16).toString('hex');
}

async function putObjectBuffer(storageKey, buffer, mimeType) {
    const client = getClient();
    if (!client) throw new Error('R2 is not configured');
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    try {
        await client.send(
            new PutObjectCommand({
                Bucket: getBucket(),
                Key: storageKey,
                Body: buffer,
                ContentType: mimeType || 'application/octet-stream'
            })
        );
    } catch (err) {
        invalidateR2ReadyCache();
        throw new Error(formatR2Error(err));
    }
}

module.exports = {
    MULTIPART_THRESHOLD_BYTES,
    PART_SIZE_BYTES,
    UPLOAD_URL_EXPIRES_SEC,
    VIEW_URL_EXPIRES_SEC,
    isR2Configured,
    isR2Ready,
    isR2ReadySync,
    warmupR2,
    getBucket,
    getR2SetupHint,
    formatR2Error,
    invalidateR2ReadyCache,
    makeCaseStorageKey,
    r2FilePathMarker,
    parseR2FilePath,
    presignPut,
    createMultipartUpload,
    presignUploadPart,
    listUploadedParts,
    completeMultipartUpload,
    abortMultipartUpload,
    presignGet,
    planMultipartParts,
    newUploadId,
    putObjectBuffer
};
