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
        ? '<div class="maint-logo-wrap anim d1"><span class="maint-logo-ring" aria-hidden="true"></span><img class="maint-logo" src="' +
          escapeHtml(p.logo_url) +
          '" alt="' +
          siteName +
          '" draggable="false"></div>'
        : '<div class="maint-logo-wrap anim d1"><span class="maint-logo-ring" aria-hidden="true"></span><div class="maint-logo-fallback" aria-hidden="true">VGMF</div></div>';

    const scheduleBlock = goLiveAt
        ? '<div class="maint-schedule anim d4">' +
          '<p class="maint-schedule-label">Expected back</p>' +
          '<p class="maint-schedule-time" id="maint-go-live-label">' +
          goLiveLabel +
          '</p>' +
          '<div class="maint-countdown" id="maint-countdown" aria-live="polite">' +
          '<span class="maint-countdown-unit u-days"><strong id="maint-cd-d">00</strong><small>days</small></span>' +
          '<span class="maint-countdown-sep sep-days">:</span>' +
          '<span class="maint-countdown-unit"><strong id="maint-cd-h">00</strong><small>hours</small></span>' +
          '<span class="maint-countdown-sep">:</span>' +
          '<span class="maint-countdown-unit"><strong id="maint-cd-m">00</strong><small>mins</small></span>' +
          '<span class="maint-countdown-sep">:</span>' +
          '<span class="maint-countdown-unit"><strong id="maint-cd-s">00</strong><small>secs</small></span>' +
          '</div></div>'
        : '<div class="maint-progress-wrap anim d4" aria-hidden="true">' +
          '<p class="maint-progress-label">Getting everything ready for you</p>' +
          '<div class="maint-progress"><span class="maint-progress-bar"></span></div></div>';

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
            padding: 28px 16px 48px;
            overflow-x: hidden;
            color: #115e59;
            background: #f0fdfa;
            user-select: none;
            -webkit-user-select: none;
        }
        .maint-scene {
            position: fixed;
            inset: 0;
            z-index: 0;
            overflow: hidden;
            background: linear-gradient(125deg, #ecfdf5, #fef9c3, #fce7f3, #e0f2fe, #ecfdf5);
            background-size: 400% 400%;
            animation: maint-sky 16s ease infinite;
        }
        @keyframes maint-sky {
            0%, 100% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; }
        }
        .maint-blob {
            position: absolute;
            border-radius: 50%;
            filter: blur(40px);
            opacity: 0.65;
            animation: maint-drift 12s ease-in-out infinite;
        }
        .maint-blob-1 { width: 340px; height: 340px; top: -8%; left: -6%; background: #99f6e4; animation-duration: 14s; }
        .maint-blob-2 { width: 280px; height: 280px; top: 18%; right: -4%; background: #fde68a; animation-delay: -3s; animation-duration: 18s; }
        .maint-blob-3 { width: 220px; height: 220px; bottom: 12%; left: 12%; background: #fbcfe8; animation-delay: -6s; }
        .maint-blob-4 { width: 260px; height: 260px; bottom: -6%; right: 18%; background: #bae6fd; animation-delay: -9s; animation-duration: 20s; }
        @keyframes maint-drift {
            0%, 100% { transform: translate(0, 0) scale(1); }
            33% { transform: translate(28px, -22px) scale(1.08); }
            66% { transform: translate(-20px, 16px) scale(0.92); }
        }
        .maint-shape {
            position: absolute;
            opacity: 0.45;
            animation: maint-spin-float 10s linear infinite;
        }
        .maint-shape-1 {
            top: 14%; left: 10%; width: 48px; height: 48px;
            border: 3px solid #2dd4bf; border-radius: 14px;
            animation-duration: 14s;
        }
        .maint-shape-2 {
            top: 62%; right: 8%; width: 36px; height: 36px;
            background: linear-gradient(135deg, #fbbf24, #f472b6);
            border-radius: 50%; animation-duration: 11s; animation-direction: reverse;
        }
        .maint-shape-3 {
            bottom: 22%; left: 6%; width: 0; height: 0;
            border-left: 14px solid transparent; border-right: 14px solid transparent;
            border-bottom: 24px solid #38bdf8; animation-duration: 16s;
        }
        .maint-shape-4 {
            top: 28%; right: 22%; width: 56px; height: 12px;
            background: #34d399; border-radius: 999px;
            animation-duration: 9s; animation-direction: reverse;
        }
        @keyframes maint-spin-float {
            0% { transform: translateY(0) rotate(0deg); }
            50% { transform: translateY(-18px) rotate(180deg); }
            100% { transform: translateY(0) rotate(360deg); }
        }
        .maint-sparkle {
            position: absolute;
            width: 6px; height: 6px;
            border-radius: 50%;
            background: #14b8a6;
            animation: maint-rise 6s ease-in infinite;
            opacity: 0;
        }
        .maint-sparkle:nth-child(1) { left: 8%; bottom: -4%; animation-delay: 0s; background: #0d9488; }
        .maint-sparkle:nth-child(2) { left: 22%; bottom: -4%; animation-delay: 1.2s; background: #f59e0b; width: 5px; height: 5px; }
        .maint-sparkle:nth-child(3) { left: 44%; bottom: -4%; animation-delay: 2.4s; background: #ec4899; }
        .maint-sparkle:nth-child(4) { left: 68%; bottom: -4%; animation-delay: 0.6s; background: #0ea5e9; width: 4px; height: 4px; }
        .maint-sparkle:nth-child(5) { left: 86%; bottom: -4%; animation-delay: 3s; background: #10b981; }
        .maint-sparkle:nth-child(6) { left: 54%; bottom: -4%; animation-delay: 4.2s; background: #8b5cf6; width: 5px; height: 5px; }
        @keyframes maint-rise {
            0% { transform: translateY(0) scale(0.5); opacity: 0; }
            15% { opacity: 0.85; }
            85% { opacity: 0.4; }
            100% { transform: translateY(-105vh) scale(1.2); opacity: 0; }
        }
        .maint-wave {
            position: absolute;
            left: 0; right: 0; bottom: 0;
            height: 120px;
            color: rgba(255, 255, 255, 0.55);
        }
        .maint-wave svg {
            width: 200%; height: 100%;
            animation: maint-wave-slide 12s linear infinite;
        }
        @keyframes maint-wave-slide {
            0% { transform: translateX(0); }
            100% { transform: translateX(-50%); }
        }
        .maint-shell {
            position: relative;
            z-index: 1;
            width: 100%;
            max-width: 540px;
            animation: maint-pop 0.9s cubic-bezier(0.34, 1.56, 0.64, 1) both;
        }
        @keyframes maint-pop {
            from { opacity: 0; transform: translateY(40px) scale(0.9); }
            to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .maint-card {
            text-align: center;
            padding: 38px 30px 34px;
            border-radius: 28px;
            background: rgba(255, 255, 255, 0.82);
            border: 2px solid rgba(255, 255, 255, 0.95);
            box-shadow:
                0 20px 50px rgba(13, 148, 136, 0.12),
                0 8px 24px rgba(251, 191, 36, 0.08),
                0 0 0 1px rgba(45, 212, 191, 0.15) inset;
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            position: relative;
            overflow: hidden;
        }
        .maint-card::before {
            content: '';
            position: absolute;
            top: 0; left: -120%; width: 80%; height: 100%;
            background: linear-gradient(90deg, transparent, rgba(255,255,255,0.55), transparent);
            animation: maint-sheen 5s ease-in-out infinite;
            pointer-events: none;
        }
        @keyframes maint-sheen {
            0%, 70%, 100% { left: -120%; }
            85% { left: 140%; }
        }
        .anim { opacity: 0; animation: maint-fade-up 0.75s cubic-bezier(0.22, 1, 0.36, 1) forwards; }
        .d1 { animation-delay: 0.1s; }
        .d2 { animation-delay: 0.22s; }
        .d3 { animation-delay: 0.34s; }
        .d4 { animation-delay: 0.46s; }
        .d5 { animation-delay: 0.58s; }
        @keyframes maint-fade-up {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .maint-logo-wrap {
            position: relative;
            display: inline-block;
            margin-bottom: 20px;
        }
        .maint-logo-ring {
            position: absolute;
            inset: -14px;
            border-radius: 50%;
            border: 2px dashed rgba(45, 212, 191, 0.55);
            animation: maint-ring 8s linear infinite;
        }
        @keyframes maint-ring {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }
        .maint-logo {
            max-height: 68px;
            max-width: 230px;
            object-fit: contain;
            position: relative;
            z-index: 1;
            filter: drop-shadow(0 6px 16px rgba(13, 148, 136, 0.18));
            animation: maint-logo-bob 3.5s ease-in-out infinite;
        }
        @keyframes maint-logo-bob {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-6px); }
        }
        .maint-logo-fallback {
            position: relative;
            z-index: 1;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 76px;
            height: 76px;
            border-radius: 22px;
            background: linear-gradient(145deg, #ccfbf1, #99f6e4);
            border: 2px solid #5eead4;
            font-weight: 800;
            font-size: 1rem;
            letter-spacing: 0.08em;
            color: #0f766e;
            box-shadow: 0 10px 28px rgba(45, 212, 191, 0.35);
            animation: maint-logo-bob 3.5s ease-in-out infinite;
        }
        .maint-badge {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 8px 16px;
            border-radius: 999px;
            font-size: 0.72rem;
            font-weight: 800;
            letter-spacing: 0.07em;
            text-transform: uppercase;
            color: #0f766e;
            background: linear-gradient(90deg, #ccfbf1, #fef3c7, #ccfbf1);
            background-size: 200% 100%;
            animation: maint-badge-flow 4s linear infinite;
            border: 1px solid rgba(45, 212, 191, 0.45);
            margin-bottom: 16px;
        }
        @keyframes maint-badge-flow {
            0% { background-position: 0% 50%; }
            100% { background-position: 200% 50%; }
        }
        .maint-badge-dot {
            width: 9px; height: 9px;
            border-radius: 50%;
            background: #10b981;
            animation: maint-dot-pulse 1.8s ease-out infinite;
        }
        @keyframes maint-dot-pulse {
            0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.55); transform: scale(1); }
            70% { box-shadow: 0 0 0 10px rgba(16, 185, 129, 0); transform: scale(1.1); }
            100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); transform: scale(1); }
        }
        .maint-tools {
            display: flex;
            justify-content: center;
            gap: 10px;
            margin-bottom: 18px;
        }
        .maint-tool {
            width: 44px; height: 44px;
            border-radius: 14px;
            display: grid;
            place-items: center;
            font-size: 1.15rem;
            animation: maint-tool-bounce 2.4s ease-in-out infinite;
        }
        .maint-tool-1 {
            background: linear-gradient(135deg, #a7f3d0, #6ee7b7);
            animation-delay: 0s;
        }
        .maint-tool-2 {
            background: linear-gradient(135deg, #fde68a, #fcd34d);
            animation-delay: 0.3s;
        }
        .maint-tool-3 {
            background: linear-gradient(135deg, #fbcfe8, #f9a8d4);
            animation-delay: 0.6s;
        }
        @keyframes maint-tool-bounce {
            0%, 100% { transform: translateY(0) rotate(0deg); }
            50% { transform: translateY(-8px) rotate(8deg); }
        }
        h1 {
            font-family: 'Libre Baskerville', Georgia, serif;
            font-size: clamp(1.6rem, 4.8vw, 2.05rem);
            font-weight: 700;
            line-height: 1.3;
            margin-bottom: 12px;
            color: #0f766e;
            background: linear-gradient(120deg, #0f766e, #0891b2, #0d9488, #0f766e);
            background-size: 300% 100%;
            -webkit-background-clip: text;
            background-clip: text;
            -webkit-text-fill-color: transparent;
            animation: maint-title-shine 6s ease infinite;
        }
        @keyframes maint-title-shine {
            0%, 100% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; }
        }
        .maint-message {
            font-size: 1.02rem;
            line-height: 1.75;
            color: #047857;
            margin-bottom: 26px;
            max-width: 40ch;
            margin-left: auto;
            margin-right: auto;
        }
        .maint-schedule {
            padding: 20px 16px 18px;
            border-radius: 20px;
            background: linear-gradient(145deg, rgba(204, 251, 241, 0.65), rgba(254, 243, 199, 0.45));
            border: 1px solid rgba(45, 212, 191, 0.35);
            margin-bottom: 6px;
        }
        .maint-schedule-label {
            font-size: 0.76rem;
            font-weight: 700;
            letter-spacing: 0.1em;
            text-transform: uppercase;
            color: #0d9488;
            margin-bottom: 6px;
        }
        .maint-schedule-time {
            font-size: 1rem;
            font-weight: 800;
            color: #b45309;
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
            min-width: 60px;
            padding: 12px 8px 10px;
            border-radius: 16px;
            background: #fff;
            border: 2px solid transparent;
            background-clip: padding-box;
            position: relative;
            transition: transform 0.28s cubic-bezier(0.34, 1.56, 0.64, 1);
            box-shadow: 0 6px 18px rgba(13, 148, 136, 0.1);
        }
        .maint-countdown-unit::before {
            content: '';
            position: absolute;
            inset: -2px;
            border-radius: inherit;
            background: linear-gradient(135deg, #2dd4bf, #fbbf24, #f472b6, #38bdf8);
            background-size: 300% 300%;
            animation: maint-border-spin 4s linear infinite;
            z-index: -1;
        }
        @keyframes maint-border-spin {
            0% { background-position: 0% 50%; }
            100% { background-position: 300% 50%; }
        }
        .maint-countdown-unit.is-tick {
            transform: scale(1.08) translateY(-3px);
        }
        .maint-countdown-unit strong {
            display: block;
            font-size: 1.45rem;
            font-weight: 800;
            line-height: 1;
            color: #0f766e;
            font-variant-numeric: tabular-nums;
        }
        .maint-countdown-unit small {
            display: block;
            margin-top: 5px;
            font-size: 0.62rem;
            font-weight: 700;
            letter-spacing: 0.07em;
            text-transform: uppercase;
            color: #14b8a6;
        }
        .maint-countdown-sep {
            font-size: 1.35rem;
            font-weight: 800;
            color: #2dd4bf;
            padding-bottom: 16px;
            animation: maint-blink 1s step-end infinite;
        }
        @keyframes maint-blink {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.25; }
        }
        .maint-progress-wrap { margin-bottom: 6px; }
        .maint-progress-label {
            font-size: 0.82rem;
            font-weight: 700;
            color: #0d9488;
            margin-bottom: 12px;
            letter-spacing: 0.04em;
        }
        .maint-progress {
            height: 10px;
            border-radius: 999px;
            background: rgba(204, 251, 241, 0.8);
            overflow: hidden;
            border: 1px solid rgba(45, 212, 191, 0.35);
        }
        .maint-progress-bar {
            display: block;
            height: 100%;
            width: 45%;
            border-radius: inherit;
            background: linear-gradient(90deg, #2dd4bf, #fbbf24, #f472b6, #38bdf8, #2dd4bf);
            background-size: 200% 100%;
            animation: maint-progress-run 2s linear infinite;
        }
        @keyframes maint-progress-run {
            0% { transform: translateX(-110%); background-position: 0% 50%; }
            100% { transform: translateX(320%); background-position: 200% 50%; }
        }
        .maint-foot {
            margin-top: 24px;
            padding-top: 18px;
            border-top: 2px dashed rgba(45, 212, 191, 0.35);
            font-size: 0.84rem;
            color: #0d9488;
            font-weight: 700;
        }
        @media (max-width: 480px) {
            .maint-card { padding: 30px 18px 26px; border-radius: 22px; }
            .maint-countdown-unit { min-width: 52px; padding: 10px 6px 8px; }
            .maint-countdown-unit strong { font-size: 1.2rem; }
            .maint-countdown-sep { padding-bottom: 14px; }
        }
        @media (prefers-reduced-motion: reduce) {
            *, *::before, *::after {
                animation-duration: 0.01ms !important;
                animation-iteration-count: 1 !important;
                transition-duration: 0.01ms !important;
            }
            h1 { -webkit-text-fill-color: #0f766e; color: #0f766e; }
        }
    </style>
</head>
<body>
    <div class="maint-scene" aria-hidden="true">
        <div class="maint-blob maint-blob-1"></div>
        <div class="maint-blob maint-blob-2"></div>
        <div class="maint-blob maint-blob-3"></div>
        <div class="maint-blob maint-blob-4"></div>
        <span class="maint-shape maint-shape-1"></span>
        <span class="maint-shape maint-shape-2"></span>
        <span class="maint-shape maint-shape-3"></span>
        <span class="maint-shape maint-shape-4"></span>
        <span class="maint-sparkle"></span>
        <span class="maint-sparkle"></span>
        <span class="maint-sparkle"></span>
        <span class="maint-sparkle"></span>
        <span class="maint-sparkle"></span>
        <span class="maint-sparkle"></span>
        <div class="maint-wave">
            <svg viewBox="0 0 1200 120" preserveAspectRatio="none" aria-hidden="true">
                <path fill="currentColor" d="M0,64 C150,120 350,0 600,64 C850,128 1050,8 1200,64 L1200,120 L0,120 Z"></path>
            </svg>
        </div>
    </div>
    <div class="maint-shell">
        <div class="maint-card">
            ${logoBlock}
            <div class="maint-badge anim d2"><span class="maint-badge-dot"></span>Maintenance in progress</div>
            <div class="maint-tools anim d2" aria-hidden="true">
                <span class="maint-tool maint-tool-1">&#9881;</span>
                <span class="maint-tool maint-tool-2">&#10024;</span>
                <span class="maint-tool maint-tool-3">&#9829;</span>
            </div>
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
  function setDaysVisible(show) {
    var u = wrap.querySelector('.u-days');
    var s = wrap.querySelector('.sep-days');
    if (u) u.style.display = show ? '' : 'none';
    if (s) s.style.display = show ? '' : 'none';
  }
  function tick() {
    var diff = Date.parse(iso) - Date.now();
    if (diff <= 0) {
      wrap.innerHTML = '<p style="font-weight:800;color:#0f766e;font-size:1.15rem;padding:8px 0;">Reopening now&hellip;</p>';
      setTimeout(function(){ location.reload(); }, 4000);
      return;
    }
    var s = Math.floor(diff / 1000);
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    if (elD) {
      elD.textContent = pad(d);
      setDaysVisible(d > 0);
    }
    elH.textContent = pad(h);
    elM.textContent = pad(m);
    elS.textContent = pad(s);
    wrap.querySelectorAll('.maint-countdown-unit').forEach(function(u) {
      u.classList.add('is-tick');
      setTimeout(function(){ u.classList.remove('is-tick'); }, 220);
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
