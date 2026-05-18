/**
 * Maintenance mode configuration (global_settings.maintenance_config JSON).
 */
const KEY_DISABLED = 'is_site_disabled';
const KEY_CONFIG = 'maintenance_config';
const PREVIEW_COOKIE = 'vgmf_maint_preview';

function parseConfig(raw) {
    const base = {
        headline: '',
        message: '',
        go_live_at: '',
        preview_secret: ''
    };
    if (!raw) return base;
    try {
        const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return {
            headline: String(o.headline || '').trim(),
            message: String(o.message || '').trim(),
            go_live_at: String(o.go_live_at || '').trim(),
            preview_secret: String(o.preview_secret || '').trim()
        };
    } catch (_) {
        return base;
    }
}

function randomPreviewSecret() {
    return (
        Math.random().toString(36).slice(2, 10) +
        Math.random().toString(36).slice(2, 10)
    );
}

function readMaintenanceBundle(db, cb) {
    db.all(
        `SELECT key, value FROM global_settings WHERE key IN (?, ?)`,
        [KEY_DISABLED, KEY_CONFIG],
        (err, rows) => {
            if (err) return cb(err);
            const map = {};
            (rows || []).forEach((r) => {
                map[r.key] = r.value;
            });
            const disabled =
                map[KEY_DISABLED] != null &&
                ['1', 'true', 'yes'].includes(String(map[KEY_DISABLED]).trim().toLowerCase());
            const config = parseConfig(map[KEY_CONFIG]);
            cb(null, { disabled, config });
        }
    );
}

function isGoLiveDue(config) {
    if (!config || !config.go_live_at) return false;
    const t = Date.parse(config.go_live_at);
    if (!Number.isFinite(t)) return false;
    return t <= Date.now();
}

function getPreviewTokenFromRequest(req) {
    const q = req.query && (req.query.vgmf_preview || req.query.preview);
    if (q) return String(q).trim();
    const cookie = req.headers.cookie || '';
    const m = cookie.match(new RegExp(PREVIEW_COOKIE + '=([^;]+)'));
    return m ? decodeURIComponent(m[1]).trim() : '';
}

function isPreviewBypass(req, config) {
    const secret = config && config.preview_secret;
    if (!secret) return false;
    const token = getPreviewTokenFromRequest(req);
    return token && token === secret;
}

function publicMaintenancePayload(config, branding) {
    const b = branding || {};
    const goLiveAt = config.go_live_at || '';
    let goLiveLabel = '';
    if (goLiveAt) {
        try {
            goLiveLabel = new Date(goLiveAt).toLocaleString('en-IN', {
                timeZone: 'Asia/Kolkata',
                dateStyle: 'medium',
                timeStyle: 'short',
                hour12: true
            });
        } catch (_) {
            goLiveLabel = goLiveAt;
        }
    }
    return {
        headline: config.headline || "We'll be back soon",
        message:
            config.message ||
            'The Vaidya Gogate Memorial Foundation seminar portal is temporarily unavailable.',
        go_live_at: goLiveAt,
        go_live_label: goLiveLabel,
        site_name: b.site_name || 'Vaidya Gogate Memorial Foundation',
        logo_url: b.logo_url || ''
    };
}

module.exports = {
    KEY_DISABLED,
    KEY_CONFIG,
    PREVIEW_COOKIE,
    parseConfig,
    randomPreviewSecret,
    readMaintenanceBundle,
    isGoLiveDue,
    getPreviewTokenFromRequest,
    isPreviewBypass,
    publicMaintenancePayload
};
