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
        ? '<img class="maint-logo" src="' +
          escapeHtml(p.logo_url) +
          '" alt="' +
          siteName +
          '" draggable="false">'
        : '<div class="maint-logo-fallback" aria-hidden="true">VGMF</div>';

    const scheduleBlock = goLiveAt
        ? '<div class="maint-schedule anim d4">' +
          '<p class="maint-schedule-label">Expected back</p>' +
          '<p class="maint-schedule-time" id="maint-go-live-label">' +
          goLiveLabel +
          '</p>' +
          '<div class="maint-countdown" id="maint-countdown" aria-live="polite">' +
          '<span class="maint-countdown-unit"><strong id="maint-cd-d">00</strong><small>days</small></span>' +
          '<span class="maint-countdown-sep">:</span>' +
          '<span class="maint-countdown-unit"><strong id="maint-cd-h">00</strong><small>hours</small></span>' +
          '<span class="maint-countdown-sep">:</span>' +
          '<span class="maint-countdown-unit"><strong id="maint-cd-m">00</strong><small>mins</small></span>' +
          '<span class="maint-countdown-sep">:</span>' +
          '<span class="maint-countdown-unit"><strong id="maint-cd-s">00</strong><small>secs</small></span>' +
          '</div></div>'
        : '<div class="maint-progress anim d4" aria-hidden="true"><span class="maint-progress-bar"></span></div>';

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="robots" content="noindex, nofollow">
    <title>${headline} — ${siteName}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700;800&family=Libre+Baskerville:ital,wght@0,700;1,400&display=swap" rel="stylesheet">
    <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        html { height: 100%; }
        body {
            font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
            min-height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 24px 16px;
            overflow-x: hidden;
            color: #f8fafc;
            background: #0b1220;
            user-select: none;
            -webkit-user-select: none;
        }
        .maint-bg {
            position: fixed;
            inset: 0;
            z-index: 0;
            overflow: hidden;
            background:
                radial-gradient(ellipse 120% 80% at 50% -20%, rgba(45, 212, 191, 0.28) 0%, transparent 52%),
                radial-gradient(ellipse 70% 50% at 100% 100%, rgba(20, 184, 166, 0.18) 0%, transparent 55%),
                linear-gradient(165deg, #0f766e 0%, #115e59 32%, #0f172a 68%, #020617 100%);
        }
        .maint-orb {
            position: absolute;
            border-radius: 50%;
            filter: blur(60px);
            opacity: 0.55;
            animation: maint-float 14s ease-in-out infinite;
        }
        .maint-orb-1 {
            width: min(420px, 70vw);
            height: min(420px, 70vw);
            top: -12%;
            left: -8%;
            background: rgba(45, 212, 191, 0.35);
        }
        .maint-orb-2 {
            width: min(360px, 60vw);
            height: min(360px, 60vw);
            bottom: -10%;
            right: -6%;
            background: rgba(56, 189, 248, 0.22);
            animation-delay: -4s;
            animation-duration: 18s;
        }
        .maint-orb-3 {
            width: min(280px, 50vw);
            height: min(280px, 50vw);
            top: 42%;
            left: 58%;
            background: rgba(16, 185, 129, 0.2);
            animation-delay: -8s;
            animation-duration: 16s;
        }
        .maint-grid {
            position: absolute;
            inset: 0;
            opacity: 0.07;
            background-image:
                linear-gradient(rgba(255,255,255,0.9) 1px, transparent 1px),
                linear-gradient(90deg, rgba(255,255,255,0.9) 1px, transparent 1px);
            background-size: 48px 48px;
            mask-image: radial-gradient(ellipse 80% 70% at 50% 40%, #000 20%, transparent 100%);
        }
        @keyframes maint-float {
            0%, 100% { transform: translate(0, 0) scale(1); }
            33% { transform: translate(24px, -18px) scale(1.06); }
            66% { transform: translate(-16px, 14px) scale(0.94); }
        }
        .maint-shell {
            position: relative;
            z-index: 1;
            width: 100%;
            max-width: 520px;
            animation: maint-card-in 0.85s cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        @keyframes maint-card-in {
            from { opacity: 0; transform: translateY(28px) scale(0.96); }
            to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .maint-card {
            text-align: center;
            padding: 36px 28px 32px;
            border-radius: 24px;
            background: rgba(15, 23, 42, 0.72);
            border: 1px solid rgba(148, 163, 184, 0.22);
            box-shadow:
                0 24px 60px rgba(0, 0, 0, 0.35),
                0 0 0 1px rgba(255, 255, 255, 0.04) inset;
            backdrop-filter: blur(18px);
            -webkit-backdrop-filter: blur(18px);
        }
        .anim { opacity: 0; animation: maint-fade-up 0.7s cubic-bezier(0.22, 1, 0.36, 1) forwards; }
        .d1 { animation-delay: 0.12s; }
        .d2 { animation-delay: 0.22s; }
        .d3 { animation-delay: 0.32s; }
        .d4 { animation-delay: 0.42s; }
        .d5 { animation-delay: 0.52s; }
        @keyframes maint-fade-up {
            from { opacity: 0; transform: translateY(16px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .maint-logo {
            max-height: 64px;
            max-width: 220px;
            object-fit: contain;
            margin-bottom: 22px;
            filter: drop-shadow(0 10px 28px rgba(0,0,0,0.35));
        }
        .maint-logo-fallback {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 72px;
            height: 72px;
            border-radius: 20px;
            background: linear-gradient(145deg, rgba(255,255,255,0.16), rgba(255,255,255,0.06));
            border: 1px solid rgba(255,255,255,0.22);
            font-weight: 800;
            font-size: 1rem;
            letter-spacing: 0.08em;
            margin-bottom: 22px;
            box-shadow: 0 12px 32px rgba(0,0,0,0.25);
        }
        .maint-badge {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 7px 14px;
            border-radius: 999px;
            font-size: 0.72rem;
            font-weight: 700;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            color: #99f6e4;
            background: rgba(20, 184, 166, 0.14);
            border: 1px solid rgba(45, 212, 191, 0.35);
            margin-bottom: 18px;
        }
        .maint-badge-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #34d399;
            box-shadow: 0 0 0 0 rgba(52, 211, 153, 0.65);
            animation: maint-pulse 2s ease-out infinite;
        }
        @keyframes maint-pulse {
            0% { box-shadow: 0 0 0 0 rgba(52, 211, 153, 0.65); }
            70% { box-shadow: 0 0 0 10px rgba(52, 211, 153, 0); }
            100% { box-shadow: 0 0 0 0 rgba(52, 211, 153, 0); }
        }
        .maint-icon {
            width: 56px;
            height: 56px;
            margin: 0 auto 18px;
            border-radius: 16px;
            display: grid;
            place-items: center;
            background: linear-gradient(145deg, rgba(45, 212, 191, 0.2), rgba(15, 118, 110, 0.35));
            border: 1px solid rgba(94, 234, 212, 0.35);
            color: #5eead4;
            font-size: 1.35rem;
            animation: maint-wrench 4s ease-in-out infinite;
        }
        @keyframes maint-wrench {
            0%, 100% { transform: rotate(0deg); }
            25% { transform: rotate(-12deg); }
            75% { transform: rotate(12deg); }
        }
        h1 {
            font-family: 'Libre Baskerville', Georgia, serif;
            font-size: clamp(1.55rem, 4.5vw, 2rem);
            font-weight: 700;
            line-height: 1.28;
            margin-bottom: 14px;
            color: #f8fafc;
        }
        .maint-message {
            font-size: 1rem;
            line-height: 1.7;
            color: #cbd5e1;
            margin-bottom: 26px;
            max-width: 38ch;
            margin-left: auto;
            margin-right: auto;
        }
        .maint-schedule {
            padding: 18px 16px 16px;
            border-radius: 16px;
            background: rgba(2, 6, 23, 0.45);
            border: 1px solid rgba(148, 163, 184, 0.16);
            margin-bottom: 8px;
        }
        .maint-schedule-label {
            font-size: 0.78rem;
            font-weight: 600;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: #94a3b8;
            margin-bottom: 6px;
        }
        .maint-schedule-time {
            font-size: 0.95rem;
            font-weight: 700;
            color: #5eead4;
            margin-bottom: 16px;
        }
        .maint-countdown {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            flex-wrap: wrap;
        }
        .maint-countdown-unit {
            min-width: 58px;
            padding: 10px 8px 8px;
            border-radius: 12px;
            background: rgba(15, 23, 42, 0.85);
            border: 1px solid rgba(94, 234, 212, 0.2);
            transition: transform 0.25s ease, border-color 0.25s ease;
        }
        .maint-countdown-unit.is-tick {
            transform: scale(1.04);
            border-color: rgba(94, 234, 212, 0.55);
        }
        .maint-countdown-unit strong {
            display: block;
            font-size: 1.35rem;
            font-weight: 800;
            line-height: 1;
            color: #f0fdfa;
            font-variant-numeric: tabular-nums;
        }
        .maint-countdown-unit small {
            display: block;
            margin-top: 4px;
            font-size: 0.62rem;
            font-weight: 600;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            color: #64748b;
        }
        .maint-countdown-sep {
            font-size: 1.2rem;
            font-weight: 800;
            color: #475569;
            padding-bottom: 14px;
        }
        .maint-progress {
            height: 4px;
            border-radius: 999px;
            background: rgba(148, 163, 184, 0.2);
            overflow: hidden;
            margin-bottom: 8px;
        }
        .maint-progress-bar {
            display: block;
            height: 100%;
            width: 40%;
            border-radius: inherit;
            background: linear-gradient(90deg, transparent, #2dd4bf, #14b8a6, transparent);
            animation: maint-shimmer 2.2s ease-in-out infinite;
        }
        @keyframes maint-shimmer {
            0% { transform: translateX(-120%); }
            100% { transform: translateX(320%); }
        }
        .maint-foot {
            margin-top: 26px;
            padding-top: 18px;
            border-top: 1px solid rgba(148, 163, 184, 0.14);
            font-size: 0.82rem;
            color: #64748b;
            font-weight: 600;
        }
        @media (max-width: 480px) {
            .maint-card { padding: 28px 18px 24px; border-radius: 20px; }
            .maint-countdown-unit { min-width: 50px; padding: 8px 6px 6px; }
            .maint-countdown-unit strong { font-size: 1.15rem; }
            .maint-countdown-sep { padding-bottom: 12px; }
        }
        @media (prefers-reduced-motion: reduce) {
            *, *::before, *::after {
                animation-duration: 0.01ms !important;
                animation-iteration-count: 1 !important;
                transition-duration: 0.01ms !important;
            }
        }
    </style>
</head>
<body>
    <div class="maint-bg" aria-hidden="true">
        <div class="maint-orb maint-orb-1"></div>
        <div class="maint-orb maint-orb-2"></div>
        <div class="maint-orb maint-orb-3"></div>
        <div class="maint-grid"></div>
    </div>
    <div class="maint-shell">
        <div class="maint-card">
            <div class="anim d1">${logoBlock}</div>
            <div class="maint-badge anim d2"><span class="maint-badge-dot"></span>Maintenance in progress</div>
            <div class="maint-icon anim d2" aria-hidden="true">&#9881;</div>
            <h1 class="anim d3">${headline}</h1>
            <p class="maint-message anim d3">${message}</p>
            ${scheduleBlock}
            <p class="maint-foot anim d5">${siteName}</p>
        </div>
    </div>
    <script>
(function(){
  document.addEventListener('contextmenu', function(e) { e.preventDefault(); });
  document.addEventListener('dragstart', function(e) {
    if (e.target && e.target.tagName === 'IMG') e.preventDefault();
  });
  var iso = ${JSON.stringify(p.go_live_at || '')};
  if (!iso) return;
  var elD = document.getElementById('maint-cd-d');
  var elH = document.getElementById('maint-cd-h');
  var elM = document.getElementById('maint-cd-m');
  var elS = document.getElementById('maint-cd-s');
  var wrap = document.getElementById('maint-countdown');
  if (!elH || !wrap) return;
  function pad(n) { return String(n).padStart(2, '0'); }
  function tick() {
    var diff = Date.parse(iso) - Date.now();
    if (diff <= 0) {
      wrap.innerHTML = '<p style="font-weight:800;color:#5eead4;font-size:1.1rem;">Reopening now&hellip;</p>';
      setTimeout(function(){ location.reload(); }, 4000);
      return;
    }
    var s = Math.floor(diff / 1000);
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    if (elD) {
      elD.textContent = pad(d);
      elD.parentElement.style.display = d > 0 ? '' : 'none';
      var sepD = elD.parentElement.nextElementSibling;
      if (sepD && sepD.classList.contains('maint-countdown-sep')) sepD.style.display = d > 0 ? '' : 'none';
    }
    elH.textContent = pad(h);
    elM.textContent = pad(m);
    elS.textContent = pad(s);
    wrap.querySelectorAll('.maint-countdown-unit').forEach(function(u) {
      u.classList.add('is-tick');
      setTimeout(function(){ u.classList.remove('is-tick'); }, 180);
    });
  }
  tick();
  setInterval(tick, 1000);
})();
    </script>
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
