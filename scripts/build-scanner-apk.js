/**
 * Build VGMF Seminar Scanner debug APK (Capacitor).
 * Requires: Node 20+, JDK 17, Android SDK (Android Studio).
 *
 * Usage: node scripts/build-scanner-apk.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const mobile = path.join(root, 'scanner-mobile');
const SEMINAR_SCANNER_URL = 'https://seminar.vaidyagogate.org/scanner.html?app=seminar';
const apkOut = path.join(mobile, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const distApk = path.join(root, 'dist', 'VGMF-Seminar-Scanner-debug.apk');

function run(cmd, cwd) {
    console.log('>', cmd);
    execSync(cmd, { cwd, stdio: 'inherit', shell: true });
}

console.log('[1/4] Verify scanner-mobile Capacitor config (seminar only)…');
const cfgPath = path.join(mobile, 'capacitor.config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
if (!String(cfg.server && cfg.server.url).includes('seminar.vaidyagogate.org')) {
    console.error('capacitor.config.json must point to seminar.vaidyagogate.org');
    process.exit(1);
}
if (cfg.appId !== 'org.vaidyagogate.seminar.scanner') {
    console.warn('Expected appId org.vaidyagogate.seminar.scanner, got', cfg.appId);
}

const wwwIndex = path.join(mobile, 'www', 'index.html');
fs.mkdirSync(path.dirname(wwwIndex), { recursive: true });
fs.writeFileSync(
    wwwIndex,
    `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="refresh" content="0;url=${SEMINAR_SCANNER_URL}">
<script>location.replace('${SEMINAR_SCANNER_URL}');</script></head><body></body></html>\n`
);

function ensureAndroidSdk() {
    const propsPath = path.join(mobile, 'android', 'local.properties');
    if (fs.existsSync(propsPath)) return;
    const candidates = [
        process.env.ANDROID_HOME,
        process.env.ANDROID_SDK_ROOT,
        path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk'),
        path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Android', 'Sdk')
    ].filter(Boolean);
    const sdk = candidates.find((p) => fs.existsSync(p));
    if (!sdk) {
        console.error('Android SDK not found. Install Android Studio or set ANDROID_HOME.');
        process.exit(1);
    }
    const escaped = sdk.replace(/\\/g, '\\\\');
    fs.writeFileSync(propsPath, `sdk.dir=${escaped}\n`);
    console.log('Wrote local.properties →', sdk);
}

console.log('[2/4] npm install + Capacitor sync…');
ensureAndroidSdk();
if (!fs.existsSync(path.join(mobile, 'node_modules'))) {
    run('npm install', mobile);
}
if (!fs.existsSync(path.join(mobile, 'android'))) {
    run('npx cap add android', mobile);
}
run('npx cap sync android', mobile);

console.log('[3/4] Assemble debug APK…');
const gradlew = path.join(mobile, 'android', 'gradlew.bat');
if (!fs.existsSync(gradlew)) {
    console.error('gradlew.bat not found. Install Android Studio SDK.');
    process.exit(1);
}
run('gradlew.bat assembleDebug', path.join(mobile, 'android'));

console.log('[4/4] Copy APK…');
if (!fs.existsSync(apkOut)) {
    console.error('APK not found at', apkOut);
    process.exit(1);
}
fs.mkdirSync(path.dirname(distApk), { recursive: true });
fs.copyFileSync(apkOut, distApk);
console.log('\n✓ Seminar scanner APK:\n  ', distApk);
