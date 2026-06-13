/**
 * Live site + seminar application sessions for admin Live Radar.
 */
const crypto = require('crypto');
const supportLiveChat = require('./support-live-chat');
const ipGeo = require('./ip-geo');
const userClientTelemetry = require('./user-client-telemetry');
const liveRadarHub = require('./live-radar-hub');

const STEP_LABELS = ['Terms', 'Personal', 'Address', 'Qualification', 'College', 'Review & submit'];

function isPg() {
    return !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
}

function ignoreErr(e) {
    if (e && !/duplicate column|already exists/i.test(String(e.message))) {
        console.warn('[site-visitors]', e.message);
    }
}

function ensureSchema(db, cb) {
    const ts = isPg() ? 'TIMESTAMPTZ' : 'DATETIME';
    const steps = [
        `CREATE TABLE IF NOT EXISTS site_visitor_sessions (
            session_id TEXT PRIMARY KEY,
            user_id INTEGER,
            user_label TEXT,
            client_ip TEXT,
            location_label TEXT,
            geo_json TEXT,
            device_label TEXT,
            device_type TEXT,
            user_agent TEXT,
            current_path TEXT,
            referrer TEXT,
            activity_kind TEXT,
            seminar_id INTEGER,
            seminar_title TEXT,
            step_label TEXT,
            step_number INTEGER,
            form_progress INTEGER DEFAULT 0,
            first_seen ${ts} DEFAULT CURRENT_TIMESTAMP,
            last_seen ${ts} DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE INDEX IF NOT EXISTS idx_site_visitor_last_seen ON site_visitor_sessions(last_seen DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_site_visitor_activity ON site_visitor_sessions(activity_kind, last_seen DESC)`
    ];
    const pgAlters = [
        `ALTER TABLE site_visitor_sessions ADD COLUMN IF NOT EXISTS device_type TEXT`,
        `ALTER TABLE site_visitor_sessions ADD COLUMN IF NOT EXISTS activity_kind TEXT`,
        `ALTER TABLE site_visitor_sessions ADD COLUMN IF NOT EXISTS seminar_id INTEGER`,
        `ALTER TABLE site_visitor_sessions ADD COLUMN IF NOT EXISTS seminar_title TEXT`,
        `ALTER TABLE site_visitor_sessions ADD COLUMN IF NOT EXISTS step_label TEXT`,
        `ALTER TABLE site_visitor_sessions ADD COLUMN IF NOT EXISTS step_number INTEGER`,
        `ALTER TABLE site_visitor_sessions ADD COLUMN IF NOT EXISTS form_progress INTEGER DEFAULT 0`
    ];
    if (isPg()) steps.push.apply(steps, pgAlters);
    else {
        steps.push(
            `ALTER TABLE site_visitor_sessions ADD COLUMN device_type TEXT`,
            `ALTER TABLE site_visitor_sessions ADD COLUMN activity_kind TEXT`,
            `ALTER TABLE site_visitor_sessions ADD COLUMN seminar_id INTEGER`,
            `ALTER TABLE site_visitor_sessions ADD COLUMN seminar_title TEXT`,
            `ALTER TABLE site_visitor_sessions ADD COLUMN step_label TEXT`,
            `ALTER TABLE site_visitor_sessions ADD COLUMN step_number INTEGER`,
            `ALTER TABLE site_visitor_sessions ADD COLUMN form_progress INTEGER DEFAULT 0`
        );
    }
    let i = 0;
    const next = () => {
        if (i >= steps.length) return cb && cb(null);
        db.run(steps[i++], (e) => {
            ignoreErr(e);
            next();
        });
    };
    next();
}

function newSessionId() {
    return crypto.randomBytes(16).toString('hex');
}

function deviceFromDiagnostics(d) {
    if (d && d.platform) return String(d.platform);
    if (d && d.userAgent) return userClientTelemetry.deviceLabelFromDiagnostics(d);
    return '—';
}

function deviceTypeFromDiagnostics(d) {
    const ua = String((d && d.userAgent) || '');
    if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tablet';
    if (/Mobi|iPhone|iPod|Android/i.test(ua)) return 'mobile';
    return 'desktop';
}

function parseGeo(raw) {
    if (!raw) return null;
    try {
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (_) {
        return null;
    }
}

function inferActivityFromPath(path) {
    const p = String(path || '').toLowerCase();
    if (p.includes('/doctor') && (p.includes('tab-applications') || p.includes('applications'))) {
        return { kind: 'track_applications', stepLabel: 'Tracking applications' };
    }
    if (p.includes('/doctor') && (p.includes('tab-seminars') || p.includes('seminar'))) {
        return { kind: 'browse_seminars', stepLabel: 'Browsing seminars' };
    }
    if (p.includes('/doctor')) return { kind: 'doctor_portal', stepLabel: 'Doctor portal' };
    if (p === '/' || p.includes('index')) return { kind: 'homepage', stepLabel: 'Homepage' };
    if (p.includes('/admin')) return { kind: 'admin', stepLabel: 'Admin portal' };
    if (p.indexOf('signup') !== -1) return { kind: 'signup', stepLabel: 'Sign up' };
    if (p.indexOf('login') !== -1) return { kind: 'login', stepLabel: 'Sign in' };
    return { kind: 'browse', stepLabel: 'Browsing site' };
}

function normalizeActivity(body) {
    const act = (body && body.activity) || {};
    let kind = String(act.kind || body.activityKind || '').trim();
    let seminarId = act.seminarId != null ? parseInt(act.seminarId, 10) : null;
    let seminarTitle = String(act.seminarTitle || body.seminarTitle || '').trim().slice(0, 160) || null;
    let stepNumber = act.stepNumber != null ? parseInt(act.stepNumber, 10) : null;
    let stepLabel = String(act.stepLabel || body.stepLabel || '').trim().slice(0, 120) || null;
    let formProgress = act.formProgress != null ? parseInt(act.formProgress, 10) : null;

    if (!kind) {
        const inferred = inferActivityFromPath(body && body.path);
        kind = inferred.kind;
        if (!stepLabel) stepLabel = inferred.stepLabel;
    }

    if (kind === 'seminar_apply' && stepNumber != null && !stepLabel) {
        stepLabel = STEP_LABELS[stepNumber] || 'Step ' + stepNumber;
    }
    if (formProgress == null || Number.isNaN(formProgress)) {
        if (kind === 'seminar_apply' && stepNumber != null && !Number.isNaN(stepNumber)) {
            formProgress = Math.min(100, Math.max(0, Math.round((stepNumber / 5) * 100)));
        } else {
            formProgress = 0;
        }
    } else {
        formProgress = Math.min(100, Math.max(0, formProgress));
    }

    return {
        kind: kind || 'browse',
        seminarId: Number.isInteger(seminarId) ? seminarId : null,
        seminarTitle,
        stepNumber: Number.isInteger(stepNumber) ? stepNumber : null,
        stepLabel,
        formProgress
    };
}

function recordHeartbeat(db, req, body, cb) {
    let sessionId = String((body && body.sessionId) || '').trim();
    if (!sessionId || sessionId.length < 8) sessionId = newSessionId();

    const userId = body && body.userId != null ? parseInt(body.userId, 10) : null;
    const currentPath = String((body && body.path) || (body && body.page) || req.path || '/').slice(0, 500);
    const referrer = String((body && body.referrer) || req.get('referer') || '').slice(0, 500);
    const diagnostics = body && body.clientDiagnostics ? body.clientDiagnostics : {};
    const userAgent = String((diagnostics && diagnostics.userAgent) || req.get('user-agent') || '').slice(0, 500);
    const deviceLabel = deviceFromDiagnostics(diagnostics);
    const deviceType = deviceTypeFromDiagnostics(diagnostics);
    const userLabel = String((body && body.userLabel) || '').trim().slice(0, 120) || null;
    const ip = supportLiveChat.getClientIpFromReq(req) || null;
    const activity = normalizeActivity(body);

    ensureSchema(db, (schemaErr) => {
        if (schemaErr) return cb && cb(schemaErr);

        const upsert = (locationLabel, geoJson) => {
            db.get(`SELECT session_id, first_seen FROM site_visitor_sessions WHERE session_id = ?`, [sessionId], (e0, existing) => {
                const isNew = !existing;
                const sql = isPg()
                    ? `INSERT INTO site_visitor_sessions (
                        session_id, user_id, user_label, client_ip, location_label, geo_json,
                        device_label, device_type, user_agent, current_path, referrer,
                        activity_kind, seminar_id, seminar_title, step_label, step_number, form_progress,
                        first_seen, last_seen
                      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                      ON CONFLICT(session_id) DO UPDATE SET
                        user_id = COALESCE(EXCLUDED.user_id, site_visitor_sessions.user_id),
                        user_label = COALESCE(EXCLUDED.user_label, site_visitor_sessions.user_label),
                        client_ip = EXCLUDED.client_ip,
                        location_label = CASE
                          WHEN EXCLUDED.geo_json IS NOT NULL AND EXCLUDED.geo_json != '' THEN EXCLUDED.location_label
                          ELSE site_visitor_sessions.location_label
                        END,
                        geo_json = CASE
                          WHEN EXCLUDED.geo_json IS NOT NULL AND EXCLUDED.geo_json != '' THEN EXCLUDED.geo_json
                          ELSE site_visitor_sessions.geo_json
                        END,
                        device_label = EXCLUDED.device_label,
                        device_type = EXCLUDED.device_type,
                        user_agent = EXCLUDED.user_agent,
                        current_path = EXCLUDED.current_path,
                        referrer = EXCLUDED.referrer,
                        activity_kind = EXCLUDED.activity_kind,
                        seminar_id = EXCLUDED.seminar_id,
                        seminar_title = EXCLUDED.seminar_title,
                        step_label = EXCLUDED.step_label,
                        step_number = EXCLUDED.step_number,
                        form_progress = EXCLUDED.form_progress,
                        last_seen = CURRENT_TIMESTAMP`
                    : existing
                      ? `UPDATE site_visitor_sessions SET
                          user_id = COALESCE(?, user_id),
                          user_label = COALESCE(?, user_label),
                          client_ip = ?,
                          location_label = CASE WHEN ? IS NOT NULL AND ? != '' THEN ? ELSE location_label END,
                          geo_json = CASE WHEN ? IS NOT NULL AND ? != '' THEN ? ELSE geo_json END,
                          device_label = ?,
                          device_type = ?,
                          user_agent = ?,
                          current_path = ?,
                          referrer = ?,
                          activity_kind = ?,
                          seminar_id = ?,
                          seminar_title = ?,
                          step_label = ?,
                          step_number = ?,
                          form_progress = ?,
                          last_seen = CURRENT_TIMESTAMP
                        WHERE session_id = ?`
                      : `INSERT INTO site_visitor_sessions (
                          session_id, user_id, user_label, client_ip, location_label, geo_json,
                          device_label, device_type, user_agent, current_path, referrer,
                          activity_kind, seminar_id, seminar_title, step_label, step_number, form_progress,
                          first_seen, last_seen
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;

                const params = existing && !isPg()
                    ? [
                          Number.isInteger(userId) ? userId : null,
                          userLabel,
                          ip,
                          geoJson,
                          geoJson,
                          locationLabel,
                          geoJson,
                          geoJson,
                          geoJson,
                          deviceLabel,
                          deviceType,
                          userAgent,
                          currentPath,
                          referrer,
                          activity.kind,
                          activity.seminarId,
                          activity.seminarTitle,
                          activity.stepLabel,
                          activity.stepNumber,
                          activity.formProgress,
                          sessionId
                      ]
                    : [
                          sessionId,
                          Number.isInteger(userId) ? userId : null,
                          userLabel,
                          ip,
                          locationLabel,
                          geoJson,
                          deviceLabel,
                          deviceType,
                          userAgent,
                          currentPath,
                          referrer,
                          activity.kind,
                          activity.seminarId,
                          activity.seminarTitle,
                          activity.stepLabel,
                          activity.stepNumber,
                          activity.formProgress
                      ];

                db.run(sql, params, (uErr) => {
                    if (uErr) return cb && cb(uErr);
                    const out = { sessionId, isNew: !!isNew, activity: activity.kind };
                    if (liveRadarHub.subscriberCount() > 0) {
                        getLiveRadarSnapshot(db, { minutes: 10 }, (snapErr, snap) => {
                            if (!snapErr && snap) liveRadarHub.broadcast(snap);
                        });
                    }
                    cb(null, out);
                });
            });
        };

        const clientGeo = body && body.clientGeo ? body.clientGeo : null;

        const finishGeo = (locationLabel, geoJson) => {
            upsert(locationLabel, geoJson);
        };

        if (!ip && !clientGeo) return finishGeo(null, null);

        db.get(`SELECT location_label, geo_json FROM site_visitor_sessions WHERE session_id = ?`, [sessionId], (geoLookupErr, prev) => {
            const prevLabel = prev && prev.location_label ? prev.location_label : null;
            const prevGeo = prev && prev.geo_json ? prev.geo_json : null;

            if (!geoLookupErr && ipGeo.hasUsableGeo(prevGeo) && !clientGeo) {
                return finishGeo(prevLabel, prevGeo);
            }

            ipGeo.resolveVisitorGeo({ ip, clientGeo }, (geoErr, geo) => {
                if (geo && (geo.label || geo.city || geo.country)) {
                    return finishGeo(geo.label || ipGeo.buildGeoLabel(geo.city, geo.region, geo.country), JSON.stringify(geo));
                }
                finishGeo(prevLabel, prevGeo);
            });
        });
    });
}

function browserLabelFromUa(ua) {
    const s = String(ua || '');
    if (/Edg\//i.test(s)) return 'Edge';
    if (/Firefox/i.test(s)) return 'Firefox';
    if (/Chrome/i.test(s) && !/Edg/i.test(s)) return 'Chrome';
    if (/Safari/i.test(s) && !/Chrome/i.test(s)) return 'Safari';
    return 'Browser';
}

function isDoctorSeminarSession(r) {
    const path = String(r.current_path || '').toLowerCase();
    if (path.indexOf('/doctor') !== -1) return true;
    const kind = String(r.activity_kind || '');
    return /seminar_apply|payment|browse_seminars|track_applications|doctor_portal/.test(kind);
}

function enrichRow(r, now) {
    const lastMs = r.last_seen ? new Date(r.last_seen).getTime() : 0;
    const firstMs = r.first_seen ? new Date(r.first_seen).getTime() : 0;
    const ageSec = lastMs ? Math.round((now - lastMs) / 1000) : null;
    const geo = parseGeo(r.geo_json);
    let pulse = 'idle';
    if (ageSec != null && ageSec <= 20) pulse = 'live';
    else if (ageSec != null && ageSec <= 120) pulse = 'recent';

    const kind = r.activity_kind || 'browse';
    const path = String(r.current_path || '').toLowerCase();
    let activityLabel = r.step_label || '';
    if (!activityLabel) {
        if (kind === 'seminar_apply') activityLabel = 'Filling application';
        else if (kind === 'track_applications') activityLabel = 'Tracking applications';
        else if (kind === 'browse_seminars') activityLabel = 'Browsing seminars';
        else if (kind === 'payment') activityLabel = 'Payment checkout';
        else activityLabel = 'On site';
    }

    return {
        sessionId: r.session_id,
        userId: r.user_id,
        userLabel: r.user_label,
        ip: r.client_ip,
        location: r.location_label,
        city: geo && geo.city ? geo.city : null,
        region: geo && geo.region ? geo.region : null,
        country: geo && geo.country ? geo.country : null,
        geo,
        lat: geo && geo.lat != null ? geo.lat : null,
        lon: geo && geo.lon != null ? geo.lon : null,
        device: r.device_label,
        deviceType: r.device_type || 'desktop',
        browser: browserLabelFromUa(r.user_agent),
        userAgent: r.user_agent,
        page: r.current_path,
        referrer: r.referrer,
        activityKind: kind,
        activityLabel,
        seminarId: r.seminar_id,
        seminarTitle: r.seminar_title,
        stepNumber: r.step_number,
        stepLabel: r.step_label,
        formProgress: r.form_progress != null ? Number(r.form_progress) : 0,
        firstSeen: r.first_seen,
        lastSeen: r.last_seen,
        ageSec,
        pulse,
        isNew: firstMs > 0 && now - firstMs < 3 * 60 * 1000,
        isApplying: kind === 'seminar_apply',
        isPaying: kind === 'payment',
        isDoctorPortal:
            path.indexOf('/doctor') !== -1 ||
            /seminar_apply|payment|browse_seminars|track_applications|doctor_portal/.test(kind),
        visitorType: (function () {
            const p = String(r.current_path || '').toLowerCase();
            const onDoctor = p.indexOf('/doctor') !== -1 || /seminar_apply|payment|browse_seminars|track_applications|doctor_portal/.test(kind);
            if (onDoctor) return r.user_id ? 'doctor' : 'doctor_guest';
            if (r.user_id) return 'signed_in';
            return 'site_guest';
        })()
    };
}

function getLiveRadarSnapshot(db, opts, cb) {
    const minutes = Math.min(60, Math.max(1, parseInt(opts && opts.minutes, 10) || 10));
    const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();
    ensureSchema(db, (e) => {
        if (e) return cb(e);
        db.all(
            `SELECT session_id, user_id, user_label, client_ip, location_label, geo_json,
                    device_label, device_type, user_agent, current_path, referrer,
                    activity_kind, seminar_id, seminar_title, step_label, step_number, form_progress,
                    first_seen, last_seen
             FROM site_visitor_sessions
             WHERE last_seen >= ?
             ORDER BY last_seen DESC
             LIMIT 150`,
            [since],
            (err, rows) => {
                if (err) return cb(err);
                const now = Date.now();
                const allSessions = (rows || []).map((r) => enrichRow(r, now));
                allSessions.sort(function (a, b) {
                    if (a.isApplying !== b.isApplying) return a.isApplying ? -1 : 1;
                    if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
                    return (a.ageSec || 999) - (b.ageSec || 999);
                });
                const sessions = allSessions;
                const doctorSessions = sessions.filter((s) => s.isDoctorPortal);
                const siteGuests = sessions.filter((s) => s.visitorType === 'site_guest');
                const live = sessions.filter((s) => s.pulse === 'live');
                const applying = sessions.filter((s) => s.isApplying && s.ageSec != null && s.ageSec <= 120);
                const paying = sessions.filter((s) => s.isPaying && s.ageSec != null && s.ageSec <= 120);
                const mapPoints = sessions
                    .filter((s) => s.lat != null && s.lon != null)
                    .map((s) => ({
                        lat: s.lat,
                        lon: s.lon,
                        label: s.location,
                        pulse: s.pulse,
                        kind: s.activityKind
                    }));
                const bySeminar = {};
                applying.forEach((s) => {
                    const key = s.seminarTitle || 'Unknown seminar';
                    bySeminar[key] = (bySeminar[key] || 0) + 1;
                });
                cb(null, {
                    generatedAt: new Date().toISOString(),
                    stats: {
                        active: sessions.length,
                        liveNow: live.length,
                        newVisitors: sessions.filter((s) => s.isNew).length,
                        applying: applying.length,
                        paying: paying.length,
                        siteGuests: siteGuests.length,
                        doctorPortal: doctorSessions.length,
                        mobile: sessions.filter((s) => s.deviceType === 'mobile').length,
                        desktop: sessions.filter((s) => s.deviceType === 'desktop').length,
                        tablet: sessions.filter((s) => s.deviceType === 'tablet').length
                    },
                    seminarBreakdown: Object.keys(bySeminar)
                        .map((title) => ({ title, count: bySeminar[title] }))
                        .sort((a, b) => b.count - a.count),
                    mapPoints,
                    sessions,
                    applyingSessions: applying,
                    payingSessions: paying
                });
            }
        );
    });
}

function listLiveVisitors(db, opts, cb) {
    getLiveRadarSnapshot(db, opts, (err, snap) => {
        if (err) return cb(err);
        cb(null, {
            count: snap.stats.active,
            newCount: snap.stats.newVisitors,
            visitors: snap.sessions.map((s) => ({
                sessionId: s.sessionId,
                userId: s.userId,
                userLabel: s.userLabel,
                ip: s.ip,
                location: s.location,
                device: s.device,
                page: s.page,
                referrer: s.referrer,
                firstSeen: s.firstSeen,
                lastSeen: s.lastSeen,
                isNew: s.isNew,
                activityKind: s.activityKind,
                seminarTitle: s.seminarTitle,
                formProgress: s.formProgress
            }))
        });
    });
}

module.exports = {
    ensureSchema,
    recordHeartbeat,
    listLiveVisitors,
    getLiveRadarSnapshot,
    newSessionId,
    STEP_LABELS
};
