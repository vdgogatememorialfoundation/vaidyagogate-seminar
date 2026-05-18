/** Site branding for receipts, tickets, certificates. */

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

/** Inline logo for offline HTML (e-ticket email attachment). */
function loadSiteLogoDataUrl(db, cb) {
    if (!db || typeof db.get !== 'function') return cb(null, null);
    db.get(`SELECT value FROM global_settings WHERE key = 'site_logo_b64'`, [], (e, row) => {
        if (e) return cb(e);
        if (!row || !row.value) return cb(null, null);
        try {
            const payload = JSON.parse(row.value);
            if (payload && payload.data) {
                const mime = payload.mime || 'image/png';
                return cb(null, `data:${mime};base64,${payload.data}`);
            }
        } catch (_) {
            /* legacy plain base64 */
        }
        const raw = String(row.value).trim();
        if (raw.startsWith('data:')) return cb(null, raw);
        if (raw.length > 40) return cb(null, 'data:image/png;base64,' + raw);
        cb(null, null);
    });
}

const FOUNDATION_NAME = 'Vaidya Gogate Memorial Foundation';

module.exports = {
    getComputerGeneratedNotice,
    documentHeaderFooterHtml,
    receiptPrintExtrasCss,
    loadSiteLogoDataUrl,
    FOUNDATION_NAME,
    CG_NOTICE
};
