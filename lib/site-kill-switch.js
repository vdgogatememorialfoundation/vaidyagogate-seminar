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
    <title>Maintenance — VGMF Seminar Portal</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700;800&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 24px;
            background: radial-gradient(ellipse 80% 60% at 50% 0%, #ccfbf1 0%, transparent 55%),
                linear-gradient(165deg, #0f766e 0%, #134e4a 45%, #1e293b 100%);
            color: #f8fafc;
        }
        .card {
            width: 100%;
            max-width: 520px;
            background: rgba(255,255,255,0.08);
            backdrop-filter: blur(16px);
            border: 1px solid rgba(255,255,255,0.18);
            border-radius: 24px;
            padding: 40px 36px;
            text-align: center;
            box-shadow: 0 24px 64px rgba(0,0,0,0.35);
        }
        .badge {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 8px 14px;
            border-radius: 999px;
            background: rgba(251,191,36,0.15);
            border: 1px solid rgba(251,191,36,0.35);
            color: #fde68a;
            font-size: 0.78rem;
            font-weight: 700;
            letter-spacing: 0.04em;
            text-transform: uppercase;
            margin-bottom: 20px;
        }
        .badge svg { width: 16px; height: 16px; }
        h1 { font-size: 1.75rem; font-weight: 800; margin-bottom: 12px; line-height: 1.25; }
        .lead { font-size: 1rem; color: #cbd5e1; line-height: 1.6; margin-bottom: 28px; }
        .steps {
            text-align: left;
            background: rgba(15,23,42,0.45);
            border-radius: 14px;
            padding: 18px 20px;
            margin-bottom: 24px;
        }
        .steps li {
            list-style: none;
            padding: 10px 0;
            border-bottom: 1px solid rgba(255,255,255,0.08);
            font-size: 0.9rem;
            color: #e2e8f0;
            display: flex;
            gap: 12px;
            align-items: flex-start;
        }
        .steps li:last-child { border-bottom: none; }
        .steps .num {
            flex-shrink: 0;
            width: 26px;
            height: 26px;
            border-radius: 8px;
            background: #0d9488;
            color: #fff;
            font-weight: 800;
            font-size: 0.75rem;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .contact {
            font-size: 0.88rem;
            color: #94a3b8;
        }
        .contact a { color: #5eead4; font-weight: 700; text-decoration: none; }
        .contact a:hover { text-decoration: underline; }
        .pulse {
            width: 10px; height: 10px; border-radius: 50%;
            background: #34d399;
            box-shadow: 0 0 0 0 rgba(52,211,153,0.6);
            animation: pulse 2s infinite;
            display: inline-block;
            margin-right: 6px;
            vertical-align: middle;
        }
        @keyframes pulse {
            0% { box-shadow: 0 0 0 0 rgba(52,211,153,0.5); }
            70% { box-shadow: 0 0 0 12px rgba(52,211,153,0); }
            100% { box-shadow: 0 0 0 0 rgba(52,211,153,0); }
        }
    </style>
</head>
<body>
    <div class="card">
        <div class="badge">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>
            Scheduled maintenance
        </div>
        <h1>We&rsquo;ll be back shortly</h1>
        <p class="lead">The Vaidya Gogate Memorial Foundation National Seminar Portal is temporarily unavailable while we apply updates.</p>
        <ul class="steps">
            <li><span class="num">1</span><span>Registrations and sign-in are paused for doctors and the public site.</span></li>
            <li><span class="num">2</span><span>Administrators can still use the admin portal if your host allows it.</span></li>
            <li><span class="num">3</span><span>Your existing applications, tickets, and payments are safe.</span></li>
        </ul>
        <p class="contact"><span class="pulse"></span>Working on it &mdash; urgent help: <a href="mailto:support@vaidyagogate.org">support@vaidyagogate.org</a></p>
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
            if (err) return next();
            if (disabled) return sendMaintenancePage(res);
            next();
        });
    };
}

module.exports = {
    isDisabledValue,
    isMaintenanceExempt,
    readSiteDisabled,
    maintenanceHtml,
    sendMaintenancePage,
    createSiteKillSwitchMiddleware
};
