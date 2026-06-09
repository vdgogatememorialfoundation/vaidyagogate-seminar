/**
 * HTTP smoke tests for Seminar System (production or local).
 * Usage: node scripts/platform-smoke-test.js [baseUrl]
 *        BASE_URL=https://seminar.vaidyagogate.org node scripts/platform-smoke-test.js
 */
const https = require('https');
const http = require('http');

const base = String(process.env.BASE_URL || process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');

const results = { pass: 0, fail: 0, items: [] };

function record(name, ok, detail) {
    results.items.push({ name, ok, detail: detail || '' });
    if (ok) results.pass++;
    else results.fail++;
    const mark = ok ? 'OK' : 'FAIL';
    console.log(`[${mark}] ${name}${detail ? ' — ' + detail : ''}`);
}

function request(method, path, opts) {
    const options = opts || {};
    const url = new URL(path, base + '/');
    const lib = url.protocol === 'https:' ? https : http;
    const body = options.body;
    const headers = Object.assign({}, options.headers || {});
    if (body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

    return new Promise((resolve) => {
        const req = lib.request(
            url,
            { method, headers, timeout: 20000 },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    let json = null;
                    try {
                        json = JSON.parse(text);
                    } catch (_e) {
                        /* html or plain */
                    }
                    resolve({
                        status: res.statusCode,
                        text,
                        json,
                        headers: res.headers
                    });
                });
            }
        );
        req.on('error', (err) => resolve({ status: 0, error: err.message, text: '', json: null }));
        req.on('timeout', () => {
            req.destroy();
            resolve({ status: 0, error: 'timeout', text: '', json: null });
        });
        if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
    });
}

async function expectJson(name, path, predicate) {
    const res = await request('GET', path);
    if (res.error) return record(name, false, res.error);
    if (!res.json) return record(name, false, `HTTP ${res.status} non-JSON`);
    const ok = res.status >= 200 && res.status < 300 && predicate(res.json, res);
    record(name, ok, ok ? `HTTP ${res.status}` : `HTTP ${res.status} predicate failed`);
}

async function expectStatus(name, method, path, status, body) {
    const res = await request(method, path, body ? { body } : undefined);
    if (res.error) return record(name, false, res.error);
    const ok = res.status === status;
    record(name, ok, `HTTP ${res.status}${ok ? '' : ' expected ' + status}`);
}

async function expectHtml(name, path) {
    const res = await request('GET', path);
    if (res.error) return record(name, false, res.error);
    const ok = res.status === 200 && /<!DOCTYPE html|<html/i.test(res.text);
    record(name, ok, `HTTP ${res.status}`);
}

async function main() {
    console.log('Platform smoke test:', base);
    console.log('---');

    await expectJson('health', '/api/health', (j) => j && j.ok === true);
    await expectJson('public marketing', '/api/public/marketing', (j) => j && typeof j === 'object');
    await expectJson('public site-cms', '/api/public/site-cms', (j) => j && typeof j === 'object');
    await expectJson('portal flags', '/api/public/portal-flags', (j) => j && typeof j === 'object');
    await expectJson('seminars public', '/api/seminars', (j) => Array.isArray(j) || (j && Array.isArray(j.seminars)));
    await expectJson('case programs', '/api/case/programs', (j) => {
        const list = Array.isArray(j) ? j : j && (j.programs || j.value);
        return Array.isArray(list);
    });

    const caseCfg = await request('GET', '/api/case/uploads/config');
    if (caseCfg.error) {
        record('case upload config', false, caseCfg.error);
    } else {
        const ok =
            caseCfg.status === 200 &&
            caseCfg.json &&
            typeof caseCfg.json.r2Enabled === 'boolean' &&
            typeof caseCfg.json.effectiveMaxMb === 'number';
        record(
            'case upload config',
            ok,
            `HTTP ${caseCfg.status} r2=${caseCfg.json && caseCfg.json.r2Enabled} maxMb=${caseCfg.json && caseCfg.json.effectiveMaxMb}`
        );
    }

    await expectStatus('inbound webhook rejects unsigned', 'POST', '/api/webhooks/inbound-email', 401, {});
    await expectStatus('legacy support ticket retired', 'POST', '/api/support/ticket', 410, {});

    await expectHtml('homepage', '/index.html');
    await expectHtml('doctor portal', '/doctor.html');
    await expectHtml('admin portal', '/admin.html');
    await expectHtml('judge portal', '/judge.html');

    const mkt = await request('GET', '/api/public/marketing');
    if (mkt.json && Array.isArray(mkt.json.banners)) {
        for (let i = 0; i < Math.min(mkt.json.banners.length, 4); i++) {
            const b = mkt.json.banners[i];
            const src = b && (b.imagePath || b.imageUrl || b.image_url || b.url);
            if (!src) {
                record(`banner ${i + 1} image`, false, 'missing image url');
                continue;
            }
            const rel = src.startsWith('/') ? src : '/' + src;
            const imgRes = await request('GET', rel);
            record(`banner ${i + 1} image`, imgRes.status === 200, `HTTP ${imgRes.status} ${rel}`);
        }
    }

    console.log('---');
    console.log(`Done: ${results.pass} passed, ${results.fail} failed`);
    process.exit(results.fail > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
