/**
 * Prepare 100% static Vercel deployment (no server.js serverless on page loads).
 * Run: API_BACKEND_URL=https://your-api-host node scripts/prepare-static-deploy.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'public');

const DEFAULT_API_BACKEND = 'https://api.vaidyagogate.org';

let backend = String(process.env.API_BACKEND_URL || process.env.PUBLIC_API_BASE_URL || '')
    .trim()
    .replace(/\/$/, '');

// Production static builds: default API host if unset (override in Vercel → Environment Variables).
if (!backend && process.env.VERCEL_ENV === 'production') {
    backend = DEFAULT_API_BACKEND;
}

const adminHost = (process.env.ADMIN_HOST || 'admin.vaidyagogate.org').toLowerCase();
const judgeHost = (process.env.JUDGE_HOST || 'judge.vaidyagogate.org').toLowerCase();
const seminarHost = (process.env.SEMINAR_HOST || 'seminar.vaidyagogate.org').toLowerCase();
const frontendHosts = new Set(
    [seminarHost, adminHost, judgeHost, process.env.STATIC_FRONTEND_HOST]
        .filter(Boolean)
        .map((h) => String(h).toLowerCase())
);

function backendHost() {
    try {
        return new URL(backend).hostname.toLowerCase();
    } catch (_) {
        return '';
    }
}

function isRewriteLoopRisk() {
    const bh = backendHost();
    if (!bh) return false;
    if (frontendHosts.has(bh)) return true;
    const vercelUrl = String(process.env.VERCEL_URL || '').toLowerCase();
    if (vercelUrl && bh === vercelUrl) return true;
    return false;
}

const loopRisk = backend && isRewriteLoopRisk();

const apiConfig = {
    // Direct cross-origin API only when edge rewrites would loop; otherwise use same-origin /api + rewrites.
    apiBase: loopRisk ? backend : '',
    staticOnly: true,
    backendRewriteTarget: loopRisk ? null : backend || null,
    generatedAt: new Date().toISOString()
};

fs.writeFileSync(path.join(publicDir, 'api-config.json'), JSON.stringify(apiConfig, null, 2));

const rewrites = [];
if (backend && !loopRisk) {
    rewrites.push({ source: '/api/:path*', destination: `${backend}/api/:path*` });
    rewrites.push({ source: '/uploads/:path*', destination: `${backend}/uploads/:path*` });
}

const redirects = [
    {
        source: '/',
        has: [{ type: 'host', value: adminHost }],
        destination: '/admin.html',
        permanent: false
    },
    {
        source: '/index.html',
        has: [{ type: 'host', value: adminHost }],
        destination: '/admin.html',
        permanent: false
    },
    {
        source: '/',
        has: [{ type: 'host', value: judgeHost }],
        destination: '/judge.html',
        permanent: false
    },
    {
        source: '/index.html',
        has: [{ type: 'host', value: judgeHost }],
        destination: '/judge.html',
        permanent: false
    },
    { source: '/scanner', destination: '/scanner.html', permanent: false },
    // Path-based portals on seminar host (no admin.* / judge.* subdomain required)
    { source: '/admin', destination: '/admin.html', permanent: false },
    { source: '/judge', destination: '/judge.html', permanent: false },
    { source: '/doctor', destination: '/doctor.html', permanent: false }
];

const vercelConfig = {
    version: 2,
    buildCommand: 'node scripts/prepare-static-deploy.js',
    installCommand: 'npm install',
    outputDirectory: 'public',
    framework: null,
    rewrites,
    redirects,
    headers: [
        {
            source: '/api-config.json',
            headers: [{ key: 'Cache-Control', value: 'no-store' }]
        },
        {
            source: '/(.*\\.(html|js))',
            headers: [{ key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' }]
        }
    ]
};

fs.writeFileSync(path.join(root, 'vercel.json'), JSON.stringify(vercelConfig, null, 2) + '\n');

const htmlFiles = fs
    .readdirSync(publicDir)
    .filter((f) => f.endsWith('.html'))
    .map((f) => path.join(publicDir, f));

// Meta + api-base.js only when edge rewrites would loop (API host = static frontend host).
const injectMeta =
    backend && loopRisk
        ? `<meta name="api-base" content="${backend.replace(/"/g, '&quot;')}">\n    `
        : '';
const injectScript = '<script src="/js/api-base.js?v=static1"></script>\n    ';

htmlFiles.forEach((filePath) => {
    let html = fs.readFileSync(filePath, 'utf8');
    if (html.includes('api-base.js')) return;
    const headIdx = html.indexOf('<head>');
    if (headIdx === -1) return;
    const insertAt = headIdx + '<head>'.length;
    html =
        html.slice(0, insertAt) +
        '\n    ' +
        injectMeta +
        injectScript +
        html.slice(insertAt);
    fs.writeFileSync(filePath, html);
});

console.log('[prepare-static-deploy] outputDirectory=public');
console.log('[prepare-static-deploy] API_BACKEND_URL=', backend || '(not set)');
if (loopRisk) {
    console.warn(
        '[prepare-static-deploy] WARNING: API_BACKEND_URL host matches static frontend — using direct api-base.js (no edge rewrite) to avoid loops.'
    );
}
if (!backend && process.env.VERCEL) {
    console.warn(
        '[prepare-static-deploy] WARNING: Set API_BACKEND_URL=https://api.vaidyagogate.org on the static Vercel project.'
    );
}
console.log('[prepare-static-deploy] Updated', htmlFiles.length, 'HTML shells and vercel.json');
