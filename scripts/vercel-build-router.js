/**
 * Single-repo, dual Vercel projects:
 * - Frontend project: VERCEL_DEPLOYMENT_TYPE=static (default) → static public/ only
 * - Backend project:  VERCEL_DEPLOYMENT_TYPE=api → server.js serverless + maxDuration 60
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const mode = String(process.env.VERCEL_DEPLOYMENT_TYPE || 'static').toLowerCase();

if (mode === 'api' || mode === 'backend') {
    const src = path.join(root, 'deploy', 'vercel-backend.json');
    const dest = path.join(root, 'vercel.json');
    fs.copyFileSync(src, dest);
    console.log('[vercel-build] API deployment — server.js (maxDuration 60)');
    execSync('node scripts/validate-syntax.js', { stdio: 'inherit', cwd: root });
} else {
    console.log('[vercel-build] Static frontend — public/ only (zero Node CPU on page loads)');
    execSync('node scripts/prepare-static-deploy.js', { stdio: 'inherit', cwd: root });
}
