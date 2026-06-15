/**
 * Production portal HTML delivery: minify markup/scripts/styles and inject content protection.
 */
const fs = require('fs');
const path = require('path');

const PROTECTION_SNIPPET = '<script src="/js/portal-content-protection.js"></script>';

const PORTAL_HTML_FILES = new Set([
    'index.html',
    'admin.html',
    'doctor.html',
    'judge.html',
    'scanner.html',
    'support.html',
    'support-rate.html',
    'track-shipment.html',
    'verify-certificate.html',
    'legal.html',
    'live-chat.html',
    'staff.html',
    'admin-live-scanner.html'
]);

function isProduction() {
    return process.env.NODE_ENV === 'production';
}

function stripHtmlComments(html) {
    return String(html || '').replace(/<!--[\s\S]*?-->/g, '');
}

function minifyJs(code) {
    let out = String(code || '');
    if (!out.trim()) return out;
    // Whitespace only — never strip // comments (breaks https:// URLs and can corrupt syntax).
    out = out.replace(/[\r\n\t]+/g, ' ');
    out = out.replace(/  +/g, ' ');
    return out.trim();
}

function minifyCss(code) {
    let out = String(code || '');
    if (!out.trim()) return out;
    out = out.replace(/\/\*[\s\S]*?\*\//g, '');
    out = out.replace(/[\r\n\t]+/g, ' ');
    out = out.replace(/\s*([{}:;,>+~])\s*/g, '$1');
    out = out.replace(/  +/g, ' ');
    return out.trim();
}

function minifyInlineScripts(html) {
    return html.replace(/(<script(?:\s[^>]*)?>)([\s\S]*?)(<\/script>)/gi, (match, open, body, close) => {
        if (/\bsrc\s*=/.test(open)) return match;
        return open + minifyJs(body) + close;
    });
}

function minifyInlineStyles(html) {
    return html.replace(/(<style(?:\s[^>]*)?>)([\s\S]*?)(<\/style>)/gi, (match, open, body, close) => {
        return open + minifyCss(body) + close;
    });
}

function collapseHtmlWhitespace(html) {
    return String(html || '')
        .replace(/>\s+</g, '><')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/** Collapse inter-tag whitespace without touching inline script/style bodies. */
function collapseHtmlWhitespaceSafe(html) {
    const src = String(html || '');
    const re = /(<script(?:\s[^>]*)?>[\s\S]*?<\/script>|<style(?:\s[^>]*)?>[\s\S]*?<\/style>)/gi;
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
        out += collapseHtmlWhitespace(src.slice(last, m.index));
        out += m[1];
        last = m.index + m[0].length;
    }
    out += collapseHtmlWhitespace(src.slice(last));
    return out;
}

function ensureContentProtection(html) {
    if (/portal-content-protection\.js/i.test(html)) return html;
    if (/<\/body>/i.test(html)) {
        return html.replace(/<\/body>/i, PROTECTION_SNIPPET + '</body>');
    }
    return html + PROTECTION_SNIPPET;
}

function preparePortalHtml(raw, options = {}) {
    let html = String(raw || '');
    const minify = options.minify !== false;
    const protect = options.protect !== false;

    if (minify) {
        html = stripHtmlComments(html);
        html = collapseHtmlWhitespaceSafe(html);
    }
    if (protect) {
        html = ensureContentProtection(html);
    }
    return html;
}

function isPortalHtmlFile(file) {
    const base = path.basename(String(file || ''));
    return PORTAL_HTML_FILES.has(base);
}

function sendPortalHtml(res, publicDir, file, options = {}) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');

    const filePath = path.join(publicDir, file);
    const portal = isPortalHtmlFile(file);
    const shouldTransform = isProduction() && portal && options.transform !== false;

    if (!shouldTransform) {
        return res.sendFile(filePath);
    }

    fs.readFile(filePath, 'utf8', (err, raw) => {
        if (err) {
            if (err.code === 'ENOENT') return res.status(404).end();
            return res.status(500).end();
        }
        const html = preparePortalHtml(raw, options);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    });
}

module.exports = {
    PROTECTION_SNIPPET,
    PORTAL_HTML_FILES,
    isProduction,
    isPortalHtmlFile,
    preparePortalHtml,
    minifyJs,
    collapseHtmlWhitespace,
    collapseHtmlWhitespaceSafe,
    stripHtmlComments,
    sendPortalHtml
};
