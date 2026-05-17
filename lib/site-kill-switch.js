/**
 * Site-wide maintenance / kill switch (is_site_disabled in global_settings).
 */
const { getHosts } = require('./portal-urls');

const MAINTENANCE_EXEMPT_PREFIXES = [
    '/admin',
    '/api/admin',
    '/api/auth',
    '/api/otp',
    '/api/global_settings',
    '/api/branding',
    '/api/assets/',
    '/css/',
    '/js/',
    '/uploads'
];

function isDisabledValue(row) {
    if (!row || row.value == null) return false;
    const v = String(row.value).trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
}

function isMaintenanceExempt(req) {
    const p = req.path || '/';
    const reqHost = String(req.hostname || (req.headers.host || '').split(':')[0]).toLowerCase();
    try {
        const hosts = getHosts();
        if (reqHost === hosts.admin) return true;
    } catch (_) {
        /* portal-urls not ready */
    }
    return MAINTENANCE_EXEMPT_PREFIXES.some((pref) => p === pref || p.startsWith(pref));
}

function readSiteDisabled(db, cb) {
    db.get(`SELECT value FROM global_settings WHERE key = 'is_site_disabled'`, [], (err, row) => {
        if (err) return cb(err, false);
        cb(null, isDisabledValue(row));
    });
}

function maintenanceHtml() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Under Maintenance</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .maintenance-container {
            background: rgba(255, 255, 255, 0.95);
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            padding: 60px 40px;
            max-width: 600px;
            width: 90%;
            text-align: center;
        }
        .icon-wrapper { margin-bottom: 30px; }
        .icon-wrapper i {
            font-size: 80px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }
        h1 { font-size: 2.5rem; color: #2d3748; margin-bottom: 15px; }
        .subtitle { font-size: 1.1rem; color: #667eea; margin-bottom: 10px; font-weight: 600; }
        .description { font-size: 1rem; color: #4a5568; line-height: 1.6; margin-bottom: 30px; }
        .info-box {
            background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
            border-left: 4px solid #667eea;
            padding: 20px;
            border-radius: 10px;
            text-align: left;
        }
        .info-box p { color: #2d3748; font-size: 0.95rem; margin: 8px 0; }
        .contact-info { margin-top: 30px; padding-top: 20px; border-top: 1px solid #e2e8f0; }
        .contact-info a { color: #667eea; text-decoration: none; font-weight: 600; }
    </style>
</head>
<body>
    <div class="maintenance-container">
        <div class="icon-wrapper"><i class="fas fa-tools"></i></div>
        <h1>Under Maintenance</h1>
        <p class="subtitle">We'll be back soon!</p>
        <p class="description">
            The Vaidya Gogate Memorial Foundation National Seminar Portal is currently undergoing scheduled maintenance.
        </p>
        <div class="info-box">
            <p><strong>What's happening:</strong> We're upgrading our systems.</p>
            <p><strong>We appreciate your patience!</strong></p>
        </div>
        <div class="contact-info">
            <p>For urgent inquiries: <a href="mailto:support@vaidyagogate.org">support@vaidyagogate.org</a></p>
        </div>
    </div>
</body>
</html>`;
}

function sendMaintenancePage(res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.status(503).type('html').send(maintenanceHtml());
}

function createSiteKillSwitchMiddleware(db) {
    return function siteKillSwitchMiddleware(req, res, next) {
        if (isMaintenanceExempt(req)) return next();
        readSiteDisabled(db, (err, disabled) => {
            if (err) {
                console.error('Kill switch read global_settings:', err.message);
                return next();
            }
            if (!disabled) return next();
            if (req.path.startsWith('/api/')) {
                res.setHeader('Cache-Control', 'no-store');
                return res.status(503).json({
                    error: 'Site is under maintenance.',
                    maintenance: true
                });
            }
            return sendMaintenancePage(res);
        });
    };
}

module.exports = {
    createSiteKillSwitchMiddleware,
    readSiteDisabled,
    isDisabledValue,
    isMaintenanceExempt,
    sendMaintenancePage
};
