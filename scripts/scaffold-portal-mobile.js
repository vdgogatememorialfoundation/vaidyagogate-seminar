/**
 * Scaffold Capacitor Android shells for VGMF portals (admin, judge, doctor, scanner).
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');

const PORTALS = [
    {
        dir: 'admin-mobile',
        appId: 'org.vaidyagogate.admin',
        appName: 'VGMF Admin',
        url: 'https://seminar.vaidyagogate.org/admin.html',
        title: 'VGMF Admin'
    },
    {
        dir: 'judge-mobile',
        appId: 'org.vaidyagogate.judge',
        appName: 'VGMF Judge',
        url: 'https://seminar.vaidyagogate.org/judge.html',
        title: 'VGMF Judge'
    },
    {
        dir: 'doctor-mobile',
        appId: 'org.vaidyagogate.doctor',
        appName: 'VGMF Doctor',
        url: 'https://seminar.vaidyagogate.org/doctor.html?app=1',
        title: 'VGMF Doctor'
    },
    {
        dir: 'scanner-mobile',
        appId: 'org.vaidyagogate.scanner',
        appName: 'VGMF Scanner',
        url: 'https://seminar.vaidyagogate.org/scanner.html',
        title: 'VGMF Scanner'
    }
];

const ALLOW_NAV = [
    'https://seminar.vaidyagogate.org',
    'https://admin.vaidyagogate.org',
    'https://judge.vaidyagogate.org',
    'https://vaidyagogate-seminar.vercel.app'
];

const packageJson = (name) => ({
    name,
    version: '1.0.0',
    private: true,
    description: `Android wrapper for ${name}`,
    scripts: {
        sync: 'npx cap sync android',
        'open:android': 'npx cap open android',
        'build:debug': 'npx cap sync android && cd android && gradlew.bat assembleDebug'
    },
    dependencies: {
        '@capacitor/android': '^6.2.0',
        '@capacitor/core': '^6.2.0'
    },
    devDependencies: {
        '@capacitor/cli': '^6.2.0'
    }
});

function writePortal(p) {
    const base = path.join(root, p.dir);
    fs.mkdirSync(path.join(base, 'www'), { recursive: true });

    fs.writeFileSync(
        path.join(base, 'package.json'),
        JSON.stringify(packageJson(p.dir), null, 2) + '\n'
    );

    fs.writeFileSync(
        path.join(base, 'capacitor.config.json'),
        JSON.stringify(
            {
                appId: p.appId,
                appName: p.appName,
                webDir: 'www',
                server: {
                    url: p.url,
                    hostname: 'seminar.vaidyagogate.org',
                    cleartext: false,
                    androidScheme: 'https',
                    allowNavigation: ALLOW_NAV
                },
                android: { allowMixedContent: false }
            },
            null,
            2
        ) + '\n'
    );

    fs.writeFileSync(
        path.join(base, 'www', 'index.html'),
        `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${p.title}</title>
</head>
<body>
    <p>${p.title} — configure server.url in capacitor.config.json</p>
</body>
</html>
`
    );

    console.log('[scaffold]', p.dir, '→', p.url);
}

for (const p of PORTALS) {
    writePortal(p);
    const base = path.join(root, p.dir);
    if (!fs.existsSync(path.join(base, 'node_modules'))) {
        console.log('[npm install]', p.dir);
        execSync('npm install', { cwd: base, stdio: 'inherit' });
    }
    if (!fs.existsSync(path.join(base, 'android'))) {
        console.log('[cap add android]', p.dir);
        execSync('npx cap add android', { cwd: base, stdio: 'inherit' });
    } else {
        execSync('npx cap sync android', { cwd: base, stdio: 'inherit' });
    }
}

console.log('Portal mobile projects ready.');
