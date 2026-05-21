/**
 * Fail CI / vercel-build if critical server modules have a syntax error.
 */
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const files = ['server.js', path.join('lib', 'extended-schema-pg.js')];

let failed = false;
for (const rel of files) {
    const abs = path.join(root, rel);
    try {
        execSync(`node --check "${abs}"`, { stdio: 'pipe' });
    } catch (e) {
        console.error('[validate-syntax] syntax error in', rel);
        failed = true;
    }
}

if (failed) process.exit(1);
console.log('[validate-syntax] OK', files.length, 'files');
