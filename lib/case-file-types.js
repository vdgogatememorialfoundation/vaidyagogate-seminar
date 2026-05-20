/**
 * Allowed case presentation file types (no multi-GB uploads).
 */
const path = require('path');

const ALLOWED_EXTENSIONS = new Set([
    '.pdf',
    '.ppt',
    '.pptx',
    '.zip',
    '.docx',
    '.jpg',
    '.jpeg',
    '.png',
    '.webp',
    '.gif',
    '.heic',
    '.heif',
    '.mp4',
    '.mov',
    '.webm',
    '.mkv',
    '.m4v'
]);

const ALLOWED_MIME_PREFIXES = ['image/', 'video/'];

const ALLOWED_MIME_EXACT = new Set([
    'application/pdf',
    'application/zip',
    'application/x-zip-compressed',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'application/octet-stream'
]);

function extensionOf(name) {
    return path.extname(String(name || '')).toLowerCase();
}

function isAllowedCaseFile(originalName, mimeType) {
    const ext = extensionOf(originalName);
    if (ext && ALLOWED_EXTENSIONS.has(ext)) return { ok: true };
    const mime = String(mimeType || '').toLowerCase();
    if (ALLOWED_MIME_EXACT.has(mime)) return { ok: true };
    if (ALLOWED_MIME_PREFIXES.some((p) => mime.startsWith(p))) return { ok: true };
    if (ext === '.ppt' && (!mime || mime === 'application/octet-stream')) return { ok: true };
    return {
        ok: false,
        error:
            'File type not allowed. Use PDF, PPT/PPTX, ZIP, DOCX, images, or video (MP4/MOV/WebM).'
    };
}

function previewKind(originalName, mimeType) {
    const ext = extensionOf(originalName);
    const mime = String(mimeType || '').toLowerCase();
    if (ext === '.pdf' || mime === 'application/pdf') return 'pdf';
    if (mime.startsWith('image/') || ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif'].includes(ext)) {
        return 'image';
    }
    if (mime.startsWith('video/') || ['.mp4', '.mov', '.webm', '.mkv', '.m4v'].includes(ext)) {
        return 'video';
    }
    if (['.ppt', '.pptx', '.docx', '.zip'].includes(ext)) return 'download';
    return 'download';
}

module.exports = {
    ALLOWED_EXTENSIONS,
    isAllowedCaseFile,
    previewKind,
    extensionOf
};
