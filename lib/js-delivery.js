/**
 * Production minified delivery for /js/*.js (deter casual view-source browsing).
 */
const fs = require('fs');
const path = require('path');
const { isProduction } = require('./html-delivery');

const cache = new Map();

function registerProtectedJsDelivery(app, publicDir) {
    if (!isProduction()) return;

    app.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();

        const match = /^\/js\/(.+\.js)$/i.exec(req.path || '');
        if (!match) return next();

        const rel = match[1].replace(/\\/g, '/');
        if (rel.includes('..') || rel.startsWith('/')) return next();

        const filePath = path.resolve(publicDir, 'js', rel);
        const jsRoot = path.resolve(publicDir, 'js');
        if (!filePath.startsWith(jsRoot + path.sep) && filePath !== jsRoot) return next();

        fs.stat(filePath, (err, stat) => {
            if (err || !stat.isFile()) return next();

            const cached = cache.get(filePath);
            if (cached && cached.mtimeMs === stat.mtimeMs) {
                res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
                res.setHeader('Cache-Control', 'public, max-age=86400');
                if (req.method === 'HEAD') return res.end();
                return res.send(cached.body);
            }

            fs.readFile(filePath, 'utf8', (readErr, raw) => {
                if (readErr) return next();
                const body = raw;
                cache.set(filePath, { body, mtimeMs: stat.mtimeMs });
                res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
                res.setHeader('Cache-Control', 'public, max-age=86400');
                if (req.method === 'HEAD') return res.end();
                res.send(body);
            });
        });
    });
}

module.exports = { registerProtectedJsDelivery };
