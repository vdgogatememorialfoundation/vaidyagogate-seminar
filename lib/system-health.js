/**
 * Platform & user health checks for admin monitoring.
 */
const fs = require('fs');
const path = require('path');
const portalUrls = require('./portal-urls');
const integrationSettings = require('./integration-settings');

const EXPECTED_MOBILE_URLS = {
    admin: 'https://seminar.vaidyagogate.org/admin.html',
    judge: 'https://seminar.vaidyagogate.org/judge.html',
    doctor: 'https://seminar.vaidyagogate.org/doctor.html',
    scanner: 'https://seminar.vaidyagogate.org/scanner.html'
};

function statusRow(id, label, ok, detail, fixHint) {
    return {
        id,
        label,
        status: ok ? 'ok' : 'error',
        message: ok ? 'Running Success' : detail || 'Issue detected',
        detail: detail || '',
        fixHint: fixHint || '',
        checkedAt: new Date().toISOString()
    };
}

function fileExists(rel) {
    return fs.existsSync(path.join(__dirname, '..', 'public', rel));
}

/** Compare mobile server URLs without query/hash (doctor APK uses ?app=1). */
function normalizeMobileCompareUrl(url) {
    if (!url) return '';
    try {
        const u = new URL(String(url).trim());
        return `${u.origin}${u.pathname}`.replace(/\/$/, '');
    } catch (_) {
        return String(url).split('?')[0].split('#')[0].replace(/\/$/, '');
    }
}

function readMobileCapacitorUrl(appDir, fallbackKey) {
    const expected = EXPECTED_MOBILE_URLS[fallbackKey] || '';
    try {
        const p = path.join(__dirname, '..', appDir, 'capacitor.config.json');
        if (!fs.existsSync(p)) {
            return expected;
        }
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        const url = (raw.server && raw.server.url) || '';
        return url || expected;
    } catch (_) {
        return expected;
    }
}

function mobileCapacitorUrlOk(configured, expected) {
    return normalizeMobileCompareUrl(configured) === normalizeMobileCompareUrl(expected);
}

function checkIntegrations() {
    const rt = integrationSettings.getRuntimeIntegrations();
    const emailOk = !!(rt.smtp_host || rt.zoho_client_id || rt.email_from);
    const waOk = !!(rt.whatsapp_phone_number_id && rt.whatsapp_access_token);
    return { emailOk, waOk, rt };
}

function runPlatformHealth(db, cb) {
    const urls = portalUrls.getPortalUrls();
    const rows = [];
    const push = (r) => rows.push(r);

    const finish = (extra) => {
        const errors = rows.filter((r) => r.status === 'error');
        cb(null, {
            scope: 'platform',
            overall: errors.length ? 'error' : 'ok',
            overallLabel: errors.length ? `${errors.length} issue(s)` : 'Running Success',
            components: rows,
            portalUrls: urls,
            ...extra,
            checkedAt: new Date().toISOString()
        });
    };

    if (!db) {
        push(statusRow('database', 'Database', false, 'Database handle missing'));
        return finish();
    }

    db.get('SELECT 1 AS ok', [], (dbErr) => {
        push(
            statusRow(
                'database',
                'Database',
                !dbErr,
                dbErr ? dbErr.message : 'Connected',
                dbErr ? 'Check DATABASE_URL / Postgres on Vercel.' : ''
            )
        );

        push(statusRow('api_server', 'API server', true, 'Express API responding'));

        const pages = [
            ['admin_frontend', 'Admin panel (HTML)', 'admin.html'],
            ['doctor_portal', 'Doctor portal', 'doctor.html'],
            ['judge_portal', 'Judge portal', 'judge.html'],
            ['scanner_portal', 'Scanner portal', 'scanner.html'],
            ['public_home', 'Public homepage', 'index.html']
        ];
        pages.forEach(([id, label, file]) => {
            const ok = fileExists(file);
            push(
                statusRow(
                    id,
                    label,
                    ok,
                    ok ? 'Static file present' : `Missing public/${file}`,
                    ok ? '' : 'Redeploy or restore public files.'
                )
            );
        });

        push(
            statusRow(
                'admin_backend',
                'Admin backend routes',
                true,
                'Admin API mounted on same server'
            )
        );

        const mobileApps = [
            ['mobile_admin', 'Admin mobile app URL', 'admin-mobile', 'admin'],
            ['mobile_judge', 'Judge mobile app URL', 'judge-mobile', 'judge'],
            ['mobile_doctor', 'Doctor mobile app URL', 'doctor-mobile', 'doctor'],
            ['mobile_scanner', 'Scanner mobile app URL', 'scanner-mobile', 'scanner']
        ];
        mobileApps.forEach(([id, label, dir, key]) => {
            const expected = EXPECTED_MOBILE_URLS[key];
            const configured = readMobileCapacitorUrl(dir, key);
            const ok = mobileCapacitorUrlOk(configured, expected);
            push(
                statusRow(
                    id,
                    label,
                    ok,
                    ok
                        ? expected
                        : `Configured: ${configured || '(empty)'} — expected ${expected}`,
                    ok ? '' : `Update ${dir}/capacitor.config.json and rebuild APK.`
                )
            );
        });

        const integ = checkIntegrations();
        push(
            statusRow(
                'email_integration',
                'Email (SMTP / Zoho)',
                integ.emailOk,
                integ.emailOk ? 'Configured' : 'Not configured in Integrations',
                'Admin → Global Settings → Integrations'
            )
        );
        push(
            statusRow(
                'whatsapp_integration',
                'WhatsApp Cloud API',
                integ.waOk,
                integ.waOk ? 'Configured' : 'Missing token or phone number ID',
                'Admin → Integrations → WhatsApp'
            )
        );

        db.get(
            `SELECT COUNT(*) AS c FROM notification_queue WHERE status IN ('pending','failed')`,
            [],
            (qErr, qRow) => {
                const pending = qErr ? -1 : Number(qRow && qRow.c) || 0;
                push(
                    statusRow(
                        'notification_queue',
                        'Notification queue',
                        !qErr && pending < 50,
                        qErr
                            ? qErr.message
                            : pending
                              ? `${pending} pending/failed message(s)`
                              : 'Queue healthy',
                        pending ? 'Use Auto-fix or Admin → Notifications delivery log.' : ''
                    )
                );

                db.get(
                    `SELECT value FROM global_settings WHERE key = 'public_site_cms'`,
                    [],
                    (cmsErr, cmsRow) => {
                        let cmsOk = !cmsErr && !!(cmsRow && cmsRow.value);
                        if (cmsOk) {
                            try {
                                const cms = JSON.parse(cmsRow.value);
                                cmsOk = !!(cms && cms.hero && cms.hero.title);
                            } catch (_) {
                                cmsOk = false;
                            }
                        }
                        push(
                            statusRow(
                                'public_cms',
                                'Public website CMS',
                                cmsOk,
                                cmsOk ? 'CMS loaded' : 'CMS missing or invalid JSON',
                                'Admin → Website & doctor updates → Save CMS'
                            )
                        );

                        finish({ expectedMobileUrls: EXPECTED_MOBILE_URLS });
                    }
                );
            }
        );
    });
}

function runUserHealth(db, cb) {
    const rows = [];
    const push = (r) => rows.push(r);

    if (!db) {
        push(statusRow('users_db', 'User accounts', false, 'Database unavailable'));
        return cb(null, {
            scope: 'users',
            overall: 'error',
            overallLabel: 'Database unavailable',
            components: rows,
            checkedAt: new Date().toISOString()
        });
    }

    db.get(`SELECT COUNT(*) AS c FROM users WHERE COALESCE(is_disabled,0) = 0`, [], (e1, r1) => {
        const active = e1 ? 0 : Number(r1 && r1.c) || 0;
        push(
            statusRow(
                'active_users',
                'Active user accounts',
                !e1,
                e1 ? e1.message : `${active} active account(s)`,
                ''
            )
        );

        db.get(
            `SELECT COUNT(*) AS c FROM users WHERE COALESCE(email_verified,1) = 0 AND COALESCE(is_disabled,0) = 0`,
            [],
            (e2, r2) => {
                const unverified = e2 ? 0 : Number(r2 && r2.c) || 0;
                push(
                    statusRow(
                        'email_unverified',
                        'Unverified emails',
                        unverified === 0,
                        unverified ? `${unverified} user(s) awaiting email verification` : 'All verified or N/A',
                        unverified ? 'Users must verify email or admin can mark verified.' : ''
                    )
                );

                db.get(
                    `SELECT COUNT(*) AS c FROM users WHERE COALESCE(is_banned,0) = 1`,
                    [],
                    (e3, r3) => {
                        const banned = e3 ? 0 : Number(r3 && r3.c) || 0;
                        push(
                            statusRow(
                                'banned_users',
                                'Banned accounts',
                                true,
                                banned ? `${banned} banned` : 'None banned',
                                ''
                            )
                        );

                        const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
                        db.all(
                            `SELECT action, COUNT(*) AS c FROM user_activity_logs
                             WHERE created_at > ?
                             GROUP BY action ORDER BY c DESC LIMIT 8`,
                            [since24h],
                            (e4, acts) => {
                                push(
                                    statusRow(
                                        'activity_24h',
                                        'User activity (24h)',
                                        !e4,
                                        e4
                                            ? e4.message
                                            : acts && acts.length
                                              ? acts.map((a) => `${a.action}: ${a.c}`).join(' · ')
                                              : 'No activity logged yet',
                                        ''
                                    )
                                );

                                const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
                                db.all(
                                    `SELECT status, COUNT(*) AS c FROM notification_queue
                                     WHERE created_at > ?
                                     GROUP BY status`,
                                    [since7d],
                                    (e5, nq) => {
                                        const failed =
                                            (nq || []).find((x) => String(x.status).toLowerCase() === 'failed')
                                                ?.c || 0;
                                        push(
                                            statusRow(
                                                'user_notifications_7d',
                                                'User notifications (7d)',
                                                Number(failed) === 0,
                                                nq && nq.length
                                                    ? nq.map((x) => `${x.status}: ${x.c}`).join(' · ')
                                                    : 'No queued messages',
                                                Number(failed)
                                                    ? 'Check failed rows in Notifications delivery log.'
                                                    : ''
                                            )
                                        );

                                        const errors = rows.filter((r) => r.status === 'error');
                                        cb(null, {
                                            scope: 'users',
                                            overall: errors.length ? 'error' : 'ok',
                                            overallLabel: errors.length
                                                ? `${errors.length} issue(s)`
                                                : 'Running Success',
                                            components: rows,
                                            checkedAt: new Date().toISOString()
                                        });
                                    }
                                );
                            }
                        );
                    }
                );
            }
        );
    });
}

module.exports = {
    EXPECTED_MOBILE_URLS,
    runPlatformHealth,
    runUserHealth
};
