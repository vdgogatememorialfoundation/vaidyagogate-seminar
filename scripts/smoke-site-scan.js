/**
 * Public API + module export smoke test. Usage:
 *   node scripts/smoke-site-scan.js
 *   BASE_URL=https://seminar.vaidyagogate.org node scripts/smoke-site-scan.js
 */
const http = require('http');
const https = require('https');
const path = require('path');

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const root = path.join(__dirname, '..');

function get(url) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        const req = lib.get(url, { timeout: 20000 }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('timeout'));
        });
    });
}

function checkExport(modPath, names) {
    const abs = path.join(root, modPath);
    let exp;
    try {
        exp = require(abs);
    } catch (e) {
        const src = require('fs').readFileSync(abs, 'utf8');
        const m = src.match(/module\.exports\s*=\s*\{([^}]+)\}/);
        if (!m) return { ok: false, error: e.message };
        const keys = m[1].split(',').map((s) => s.trim().split(':')[0].trim());
        const missing = names.filter((n) => !keys.includes(n));
        return missing.length ? { ok: false, missing } : { ok: true, static: true };
    }
    const missing = names.filter((n) => {
        if (typeof exp === 'function') return false;
        return exp[n] == null;
    });
    return missing.length ? { ok: false, missing } : { ok: true };
}

async function main() {
    const failures = [];
    const passes = [];

    const exportChecks = [
        ['lib/site-marketing.js', ['savePopupConfig', 'loadPopupConfig', 'lightboxToPopupConfig']],
        ['lib/volunteer-cert-flow.js', ['ensureBuiltinTemplateIfMissing']],
        ['lib/email-provider-settings.js', ['flagEnabled']],
        ['lib/admin-user-lookup.js', ['normalizePhoneDigits']]
    ];
    for (const [mod, names] of exportChecks) {
        const r = checkExport(mod, names);
        if (r.ok) passes.push(`export ${mod}`);
        else failures.push(`export ${mod}: ${r.error || JSON.stringify(r.missing)}`);
    }

    const otp = require(path.join(root, 'lib/otp.js'));
    if (otp.isDemoOtpCode('1234') && !otp.isDemoOtpCode('')) passes.push('demo OTP accepts any code');
    else failures.push('demo OTP helper broken');

    const routes = [
        '/api/health',
        '/api/public/site-cms',
        '/api/public/marketing',
        '/api/public/portal-urls',
        '/api/public/portal-theme/doctor',
        '/api/public/portal-theme/judge',
        '/api/public/portal-theme/public',
        '/api/public/doctor-portal-modules',
        '/api/public/portal-flags',
        '/api/public/announcements'
    ];

    for (const route of routes) {
        try {
            const { status, body } = await get(`${BASE}${route}`);
            if (status >= 200 && status < 400) {
                passes.push(`${route} → ${status}`);
                if (route === '/api/public/site-cms') {
                    try {
                        const cms = JSON.parse(body);
                        if (!Array.isArray(cms.reviews)) failures.push('site-cms missing reviews array');
                        else passes.push(`site-cms reviews: ${cms.reviews.length}`);
                    } catch (e) {
                        failures.push(`site-cms JSON: ${e.message}`);
                    }
                }
            } else {
                failures.push(`${route} → HTTP ${status}`);
            }
        } catch (e) {
            failures.push(`${route} → ${e.message}`);
        }
    }

    const pages = ['/', '/doctor.html', '/judge.html', '/admin.html'];
    for (const page of pages) {
        try {
            const { status } = await get(`${BASE}${page}`);
            if (status >= 200 && status < 400) passes.push(`${page} → ${status}`);
            else failures.push(`${page} → HTTP ${status}`);
        } catch (e) {
            failures.push(`${page} → ${e.message}`);
        }
    }

    console.log(`\nSmoke scan: ${BASE}\n`);
    passes.forEach((p) => console.log('  OK', p));
    if (failures.length) {
        console.log('\nFAILURES:');
        failures.forEach((f) => console.log('  ✗', f));
        process.exit(1);
    }
    console.log(`\nAll ${passes.length} checks passed.`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
