/**
 * Site-wide maintenance / kill switch (is_site_disabled + maintenance_config).
 */
const { getHosts } = require('./portal-urls');
const maintenanceSettings = require('./maintenance-settings');

const MAINTENANCE_EXEMPT_PREFIXES = [
    '/admin',
    '/api/admin',
    '/api/auth',
    '/api/otp',
    '/api/global_settings',
    '/api/public/maintenance-status',
    '/api/webhooks',
    '/api/branding',
    '/api/assets/',
    '/maintenance-preview',
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
    db.get(`SELECT value FROM global_settings WHERE key = ?`, [maintenanceSettings.KEY_DISABLED], [], (err, row) => {
        if (err) return cb(err, false);
        cb(null, isDisabledValue(row));
    });
}

function escapeHtml(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function maintenanceHtml(payload) {
    const p = payload || {};
    const headline = escapeHtml(p.headline || "We'll be back soon");
    const message = escapeHtml(
        p.message ||
            'The Vaidya Gogate Memorial Foundation seminar portal is temporarily unavailable.'
    );
    const siteName = escapeHtml(p.site_name || 'Vaidya Gogate Memorial Foundation');
    const goLiveAt = p.go_live_at ? escapeHtml(p.go_live_at) : '';
    const goLiveLabel = p.go_live_label ? escapeHtml(p.go_live_label) : '';
    const logoBlock = p.logo_url
        ? '<img class="logo" src="' +
          escapeHtml(p.logo_url) +
          '" alt="' +
          siteName +
          '">'
        : '<div class="logo-fallback" aria-hidden="true">VGMF</div>';

    const scheduleBlock = goLiveAt
        ? '<p class="schedule">Expected back <strong id="maint-go-live-label">' +
          goLiveLabel +
          '</strong></p><p class="countdown" id="maint-countdown" aria-live="polite"></p>'
        : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="robots" content="noindex, nofollow">
    <title>${headline}</title>
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
            padding: 28px 20px;
            background:
                radial-gradient(ellipse 90% 70% at 50% -10%, rgba(45, 212, 191, 0.22) 0%, transparent 55%),
                linear-gradient(168deg, #0f766e 0%, #115e59 38%, #0f172a 100%);
            color: #f8fafc;
        }
        .shell { width: 100%; max-width: 440px; text-align: center; }
        .logo { max-height: 56px; max-width: 200px; object-fit: contain; margin-bottom: 28px; filter: drop-shadow(0 8px 24px rgba(0,0,0,0.25)); }
        .logo-fallback {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 64px;
            height: 64px;
            border-radius: 18px;
            background: rgba(255,255,255,0.12);
            border: 1px solid rgba(255,255,255,0.2);
            font-weight: 800;
            font-size: 1rem;
            letter-spacing: 0.06em;
            margin-bottom: 28px;
        }
        h1 {
            font-size: clamp(1.5rem, 4vw, 1.85rem);
            font-weight: 800;
            line-height: 1.25;
            margin-bottom: 14px;
        }
        .message {
            font-size: 1rem;
            line-height: 1.65;
            color: #cbd5e1;
            margin-bottom: 24px;
        }
        .schedule {
            font-size: 0.92rem;
            color: #94a3b8;
            margin-bottom: 8px;
        }
        .schedule strong { color: #5eead4; font-weight: 700; }
        .countdown {
            font-size: 1.35rem;
            font-weight: 800;
            color: #f0fdfa;
            letter-spacing: 0.02em;
            min-height: 1.6em;
        }
        .pulse {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #34d399;
            display: inline-block;
            margin-right: 8px;
            vertical-align: middle;
            animation: pulse 2.2s ease-in-out infinite;
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.45; transform: scale(0.85); }
        }
        .foot {
            margin-top: 32px;
            font-size: 0.8rem;
            color: #64748b;
        }
    </style>
</head>
<body>
    <div class="shell">
        ${logoBlock}
        <h1>${headline}</h1>
        <p class="message">${message}</p>
        ${scheduleBlock}
        <p class="foot"><span class="pulse"></span>${siteName}</p>
    </div>
    ${
        goLiveAt
            ? `<script>
(function(){
  var iso = ${JSON.stringify(p.go_live_at)};
  var el = document.getElementById('maint-countdown');
  if (!iso || !el) return;
  function tick() {
    var diff = Date.parse(iso) - Date.now();
    if (diff <= 0) {
      el.textContent = 'Reopening now…';
      setTimeout(function(){ location.reload(); }, 4000);
      return;
    }
    var s = Math.floor(diff / 1000);
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    var parts = [];
    if (d) parts.push(d + 'd');
    parts.push(String(h).padStart(2,'0') + 'h');
    parts.push(String(m).padStart(2,'0') + 'm');
    parts.push(String(s).padStart(2,'0') + 's');
    el.textContent = parts.join(' ');
  }
  tick();
  setInterval(tick, 1000);
})();
</script>`
            : ''
    }
</body>
</html>`;
}

function sendMaintenancePage(res, payload) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Retry-After', '3600');
    res.status(503).type('html').send(maintenanceHtml(payload));
}

function loadBrandingForMaintenance(db, cb) {
    db.all(
        `SELECT key, value FROM global_settings WHERE key IN ('site_name', 'site_logo_path', 'site_logo_meta')`,
        [],
        (err, rows) => {
            if (err) return cb(err, {});
            const map = {};
            (rows || []).forEach((r) => {
                map[r.key] = r.value;
            });
            let logoUrl = '';
            if (map.site_logo_meta) {
                try {
                    const meta = JSON.parse(map.site_logo_meta);
                    if (meta.version) logoUrl = '/api/branding/logo/file?v=' + meta.version;
                } catch (_) {}
            }
            if (!logoUrl && map.site_logo_path) logoUrl = map.site_logo_path;
            if (!logoUrl) logoUrl = '/api/branding/logo/file';
            cb(null, {
                site_name: map.site_name || 'Vaidya Gogate Memorial Foundation',
                logo_url: logoUrl
            });
        }
    );
}

function autoGoLiveIfDue(db, config, cb) {
    if (!maintenanceSettings.isGoLiveDue(config)) return cb(null, false);
    db.run(
        `UPDATE global_settings SET value = '0' WHERE key = ?`,
        [maintenanceSettings.KEY_DISABLED],
        (err) => cb(err, true)
    );
}

function createSiteKillSwitchMiddleware(db) {
    return function siteKillSwitchMiddleware(req, res, next) {
        if (isMaintenanceExempt(req)) return next();
        if (req.path === '/maintenance-preview') {
            return maintenanceSettings.readMaintenanceBundle(db, (err, bundle) => {
                if (err) return sendMaintenancePage(res, {});
                loadBrandingForMaintenance(db, (bErr, branding) => {
                    const payload = maintenanceSettings.publicMaintenancePayload(
                        bundle.config,
                        branding
                    );
                    sendMaintenancePage(res, payload);
                });
            });
        }

        maintenanceSettings.readMaintenanceBundle(db, (err, bundle) => {
            if (err) return next();
            if (!bundle.disabled) return next();

            if (maintenanceSettings.isPreviewBypass(req, bundle.config)) return next();

            autoGoLiveIfDue(db, bundle.config, (autoErr, wentLive) => {
                if (wentLive) return next();
                loadBrandingForMaintenance(db, (bErr, branding) => {
                    const payload = maintenanceSettings.publicMaintenancePayload(
                        bundle.config,
                        branding
                    );
                    sendMaintenancePage(res, payload);
                });
            });
        });
    };
}

module.exports = {
    isDisabledValue,
    isMaintenanceExempt,
    readSiteDisabled,
    maintenanceHtml,
    sendMaintenancePage,
    createSiteKillSwitchMiddleware,
    loadBrandingForMaintenance
};
