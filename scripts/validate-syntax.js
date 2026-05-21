/**
 * Fail CI / vercel-build if any server module has a syntax error.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const files = ['server.js', path.join('lib', 'event-pages.js'), path.join('lib', 'extended-schema-pg.js')];

function walk(dir, out) {
    for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) walk(p, out);
        else if (name.endsWith('.js')) out.push(p);
    }
}

const libDir = path.join(root, 'lib');
if (fs.existsSync(libDir)) walk(libDir, files);

let failed = false;
for (const rel of [...new Set(files)]) {
    const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
    if (!fs.existsSync(abs)) {
        console.error('[validate-syntax] missing:', rel);
        failed = true;
        continue;
    }
    try {
        execSync(`node --check "${abs}"`, { stdio: 'pipe' });
    } catch (e) {
        console.error('[validate-syntax] syntax error in', rel);
        failed = true;
    }
}

if (failed) process.exit(1);
console.log('[validate-syntax] OK', files.length, 'files');
