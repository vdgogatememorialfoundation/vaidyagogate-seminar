/** Site branding for receipts, tickets, certificates. */

const fs = require('fs');
const path = require('path');

const CG_NOTICE =
    'This is a computer-generated document. It does not require a physical signature.';

function getComputerGeneratedNotice() {
    return CG_NOTICE;
}

function documentHeaderFooterHtml(opts) {
    const logoUrl = (opts && opts.logoUrl) || '';
    const title = (opts && opts.title) || 'Vaidya Gogate Memorial Foundation';
    const logoBlock = logoUrl
        ? '<img src="' + logoUrl + '" alt="Logo" style="max-height:48px;max-width:160px;object-fit:contain;">'
        : '';
    return {
        header:
            '<div class="doc-brand-header" style="display:flex;align-items:center;gap:14px;margin-bottom:12px;">' +
            logoBlock +
            '<div><strong style="color:#0f766e;">' +
            title +
            '</strong></div></div>',
        footer:
            '<div class="doc-cg-footer" style="margin-top:16px;padding-top:8px;border-top:1px solid #cbd5e1;font-size:8.5pt;color:#64748b;text-align:center;">' +
            CG_NOTICE +
            '</div>'
    };
}

function receiptPrintExtrasCss() {
    return '.doc-logo-row{display:flex;align-items:center;gap:12px;margin-bottom:10px}.doc-logo-row img{max-height:44px}';
}

function guessMimeFromPath(filePath) {
    const ext = String(filePath || '')
        .split('.')
        .pop()
        .toLowerCase();
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'svg') return 'image/svg+xml';
    return 'image/png';
}

function readPublicAssetBuffer(relativePath) {
    const rel = String(relativePath || '').replace(/^\/+/, '');
    if (!rel || rel.includes('..')) return null;
    const disk = path.join(__dirname, '..', 'public', rel);
    if (!fs.existsSync(disk)) return null;
    try {
        return { mime: guessMimeFromPath(disk), buffer: fs.readFileSync(disk) };
    } catch (_) {
        return null;
    }
}

function parseLogoB64Value(rawValue) {
    if (!rawValue) return null;
    try {
        const payload = JSON.parse(rawValue);
        if (payload && payload.data) {
            return {
                mime: payload.mime || 'image/png',
                buffer: Buffer.from(payload.data, 'base64')
            };
        }
    } catch (_) {
        /* legacy plain base64 or data URL */
    }
    const raw = String(rawValue).trim();
    if (raw.startsWith('data:')) {
        const m = raw.match(/^data:([^;]+);base64,(.+)$/);
        if (m) return { mime: m[1], buffer: Buffer.from(m[2], 'base64') };
    }
    if (raw.length > 40) {
        return { mime: 'image/png', buffer: Buffer.from(raw, 'base64') };
    }
    return null;
}

/** Resolve versioned logo URL for img src / favicon link tags. */
function resolveSiteLogoUrl(db, cb) {
    if (!db || typeof db.all !== 'function') return cb(null, '');
    db.all(
        `SELECT key, value FROM global_settings WHERE key IN ('site_logo_meta', 'site_logo_path')`,
        [],
        (e, rows) => {
            if (e) return cb(e);
            const map = {};
            (rows || []).forEach((r) => {
                map[r.key] = r.value;
            });
            if (map.site_logo_meta) {
                try {
                    const meta = JSON.parse(map.site_logo_meta);
                    if (meta && meta.version) {
                        return cb(null, '/api/branding/logo/file?v=' + meta.version);
                    }
                } catch (_) {}
            }
            const legacy = String(map.site_logo_path || '').trim();
            if (legacy && !legacy.startsWith('/api/branding/logo/file')) {
                return cb(null, legacy);
            }
            cb(null, legacy || '/api/branding/logo/file');
        }
    );
}

/** Raw logo bytes for favicon / HTTP responses. */
function loadSiteLogoFile(db, cb) {
    if (!db || typeof db.all !== 'function') return cb(null, null);
    db.all(
        `SELECT key, value FROM global_settings WHERE key IN ('site_logo_b64', 'site_logo_path', 'site_logo_meta')`,
        [],
        (e, rows) => {
            if (e) return cb(e);
            const map = {};
            (rows || []).forEach((r) => {
                map[r.key] = r.value;
            });
            const fromB64 = parseLogoB64Value(map.site_logo_b64);
            if (fromB64) return cb(null, fromB64);

            const legacyPath = String(map.site_logo_path || '').trim();
            if (legacyPath && !legacyPath.startsWith('/api/branding/logo/file')) {
                const fromDisk = readPublicAssetBuffer(legacyPath);
                if (fromDisk) return cb(null, fromDisk);
            }
            cb(null, null);
        }
    );
}

/** Inline logo for offline HTML (e-ticket email attachment). */
function loadSiteLogoDataUrl(db, cb) {
    loadSiteLogoFile(db, (e, file) => {
        if (e) return cb(e);
        if (!file || !file.buffer) return cb(null, null);
        const mime = file.mime || 'image/png';
        cb(null, `data:${mime};base64,${file.buffer.toString('base64')}`);
    });
}

const FOUNDATION_NAME = 'Vaidya Gogate Memorial Foundation';

module.exports = {
    getComputerGeneratedNotice,
    documentHeaderFooterHtml,
    receiptPrintExtrasCss,
    loadSiteLogoDataUrl,
    loadSiteLogoFile,
    resolveSiteLogoUrl,
    FOUNDATION_NAME,
    CG_NOTICE
};
