/**
 * Sync Capacitor configs & Android assets for portal mobile apps.
 * Run: node scripts/sync-mobile-capacitor.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const SEMINAR = 'https://seminar.vaidyagogate.org';
const ALLOW = [
    SEMINAR,
    'https://admin.vaidyagogate.org',
    'https://judge.vaidyagogate.org',
    'https://vaidyagogate-seminar.vercel.app'
];

const APPS = [
    { dir: 'admin-mobile', url: `${SEMINAR}/admin.html`, title: 'VGMF Admin' },
    { dir: 'judge-mobile', url: `${SEMINAR}/judge.html`, title: 'VGMF Judge' },
    { dir: 'doctor-mobile', url: `${SEMINAR}/doctor.html?app=1`, title: 'VGMF Doctor' },
    { dir: 'scanner-mobile', url: `${SEMINAR}/scanner.html`, title: 'VGMF Scanner' }
];

function writeConfig(app) {
    const base = path.join(root, app.dir);
    const config = {
        appId: require(path.join(base, 'package.json')).name.includes('admin')
            ? 'org.vaidyagogate.admin'
            : app.dir.includes('judge')
              ? 'org.vaidyagogate.judge'
              : app.dir.includes('doctor')
                ? 'org.vaidyagogate.doctor'
                : 'org.vaidyagogate.scanner',
        appName: app.title,
        webDir: 'www',
        server: {
            url: app.url,
            hostname: 'seminar.vaidyagogate.org',
            cleartext: false,
            androidScheme: 'https',
            allowNavigation: ALLOW
        },
        android: { allowMixedContent: false }
    };
    const existing = JSON.parse(fs.readFileSync(path.join(base, 'capacitor.config.json'), 'utf8'));
    config.appId = existing.appId;
    config.appName = existing.appName;
    fs.writeFileSync(path.join(base, 'capacitor.config.json'), JSON.stringify(config, null, 2) + '\n');

    const wwwIndex = path.join(base, 'www', 'index.html');
    fs.mkdirSync(path.dirname(wwwIndex), { recursive: true });
    fs.writeFileSync(
        wwwIndex,
        `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="refresh" content="0;url=${app.url}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${app.title}</title>
    <script>location.replace('${app.url}');</script>
</head>
<body><p><a href="${app.url}">Open ${app.title}</a></p></body>
</html>
`
    );
    console.log('[config]', app.dir, '→', app.url);
}

for (const app of APPS) {
    writeConfig(app);
    const cwd = path.join(root, app.dir);
    if (!fs.existsSync(path.join(cwd, 'node_modules'))) {
        execSync('npm install', { cwd, stdio: 'inherit' });
    }
    if (!fs.existsSync(path.join(cwd, 'android'))) {
        execSync('npx cap add android', { cwd, stdio: 'inherit' });
    }
    execSync('npx cap sync android', { cwd, stdio: 'inherit' });
    const assetCfg = path.join(cwd, 'android', 'app', 'src', 'main', 'assets', 'capacitor.config.json');
    if (fs.existsSync(assetCfg)) {
        const j = JSON.parse(fs.readFileSync(assetCfg, 'utf8'));
        console.log('[verified]', app.dir, 'android asset url =', j.server && j.server.url);
    }
}

console.log('\nDone. Rebuild APK: cd <app>-mobile/android && gradlew.bat assembleDebug');
