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

function isR2Configured() {
    return !!(
        process.env.R2_ACCOUNT_ID &&
        process.env.R2_ACCESS_KEY_ID &&
        process.env.R2_SECRET_ACCESS_KEY &&
        process.env.R2_BUCKET_NAME
    );
}

function getBucket() {
    return process.env.R2_BUCKET_NAME;
}

function getClient() {
    if (_client) return _client;
    if (!isR2Configured()) return null;
    const { S3Client } = require('@aws-sdk/client-s3');
    _client = new S3Client({
        region: 'auto',
        endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
        },
        forcePathStyle: true
    });
    return _client;
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
    const url = await getSignedUrl(client, cmd, { expiresIn: expiresSec || UPLOAD_URL_EXPIRES_SEC });
    return { url, method: 'PUT', expiresIn: expiresSec || UPLOAD_URL_EXPIRES_SEC };
}

async function createMultipartUpload(storageKey, mimeType) {
    const client = getClient();
    if (!client) throw new Error('R2 is not configured');
    const { CreateMultipartUploadCommand } = require('@aws-sdk/client-s3');
    const out = await client.send(
        new CreateMultipartUploadCommand({
            Bucket: getBucket(),
            Key: storageKey,
            ContentType: mimeType || 'application/octet-stream'
        })
    );
    return out.UploadId;
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
    await client.send(
        new PutObjectCommand({
            Bucket: getBucket(),
            Key: storageKey,
            Body: buffer,
            ContentType: mimeType || 'application/octet-stream'
        })
    );
}

module.exports = {
    MULTIPART_THRESHOLD_BYTES,
    PART_SIZE_BYTES,
    UPLOAD_URL_EXPIRES_SEC,
    VIEW_URL_EXPIRES_SEC,
    isR2Configured,
    getBucket,
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
