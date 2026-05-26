/**
 * Prepare 100% static Vercel deployment (no server.js serverless on page loads).
 * Run: API_BACKEND_URL=https://your-api-host node scripts/prepare-static-deploy.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'public');

const backend =
    String(process.env.API_BACKEND_URL || process.env.PUBLIC_API_BASE_URL || '').trim().replace(/\/$/, '');
const adminHost = (process.env.ADMIN_HOST || 'admin.vaidyagogate.org').toLowerCase();
const judgeHost = (process.env.JUDGE_HOST || 'judge.vaidyagogate.org').toLowerCase();
const seminarHost = (process.env.SEMINAR_HOST || 'seminar.vaidyagogate.org').toLowerCase();

const apiConfig = {
    apiBase: backend,
    staticOnly: true,
    generatedAt: new Date().toISOString()
};

fs.writeFileSync(path.join(publicDir, 'api-config.json'), JSON.stringify(apiConfig, null, 2));

const rewrites = [];
if (backend) {
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
    { source: '/scanner', destination: '/scanner.html', permanent: false }
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

const injectMeta = backend
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
console.log('[prepare-static-deploy] API_BACKEND_URL=', backend || '(not set — set in Vercel env for /api rewrites)');
if (!backend && process.env.VERCEL) {
    console.warn(
        '[prepare-static-deploy] WARNING: API_BACKEND_URL is empty. Registration/API calls will fail unless you add Vercel rewrites manually.'
    );
}
console.log('[prepare-static-deploy] Updated', htmlFiles.length, 'HTML shells and vercel.json');
