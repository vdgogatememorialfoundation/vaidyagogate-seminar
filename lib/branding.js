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

module.exports = {
    getComputerGeneratedNotice,
    documentHeaderFooterHtml,
    receiptPrintExtrasCss,
    CG_NOTICE
};
