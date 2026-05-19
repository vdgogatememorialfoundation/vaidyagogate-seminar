/**
 * Rule-based auto-remediation ("AI assist") for system health issues.
 */
const integrationSettings = require('./integration-settings');
const notifEngine = require('./notification-engine');
const portalAuthPolicy = require('./portal-auth-policy');

function attemptAutoFix(db, issueIds, ctx, cb) {
    const ids = Array.isArray(issueIds) ? issueIds : issueIds ? [issueIds] : [];
    const actions = [];
    let pending = 0;
    let done = false;

    function finish(err, result) {
        if (done) return;
        done = true;
        cb(err, result);
    }

    function add(action, ok, detail) {
        actions.push({ action, ok, detail });
    }

    if (!ids.length) {
        return finish(null, { actions: [], summary: 'No issues selected for auto-fix.' });
    }

    ids.forEach((id) => {
        const key = String(id || '').trim();
        if (key === 'notification_queue' || key === 'user_notifications_7d') {
            pending++;
            try {
                notifEngine.processQueueOnce(db);
                add('Flush notification queue', true, 'Processed pending queue once.');
            } catch (e) {
                add('Flush notification queue', false, e.message);
            }
            pending--;
        } else if (key === 'email_integration' || key === 'whatsapp_integration') {
            pending++;
            integrationSettings.loadFromDb(db, (e) => {
                add(
                    'Reload integration settings',
                    !e,
                    e ? e.message : 'Integration cache refreshed from database.'
                );
                pending--;
                if (pending <= 0) complete();
            });
            return;
        } else if (key === 'public_cms') {
            add(
                'CMS content',
                false,
                'Open Admin → Website & doctor updates, edit National CME eyebrow/headline, and Save CMS.'
            );
        } else if (key.startsWith('mobile_')) {
            add(
                'Mobile app URL',
                false,
                'Rebuild APK after capacitor.config.json points to seminar.vaidyagogate.org/*.html'
            );
        } else if (key === 'database') {
            add(
                'Database',
                false,
                'Verify DATABASE_URL on Vercel and Postgres is reachable. Retry in 30 seconds.'
            );
        } else if (key === 'email_unverified') {
            add(
                'Unverified users',
                false,
                'Resend verification from login or mark users verified in Admin → Doctors.'
            );
        } else {
            add(key, false, 'No automatic fix available — follow the hint shown for this component.');
        }
    });

    function complete() {
        const okCount = actions.filter((a) => a.ok).length;
        finish(null, {
            actions,
            summary:
                okCount === actions.length
                    ? 'Auto-fix completed successfully.'
                    : `Completed ${okCount}/${actions.length} automatic action(s). Review manual steps for the rest.`
        });
    }

    if (pending <= 0) complete();
}

function analyzeWithAiOptional(healthSnapshot, cb) {
    const apiKey = process.env.OPENAI_API_KEY || process.env.CURSOR_OPENAI_API_KEY;
    if (!apiKey) {
        const tips = [];
        const bad = (healthSnapshot.components || []).filter((c) => c.status === 'error');
        bad.forEach((c) => {
            tips.push(`${c.label}: ${c.fixHint || c.detail || c.message}`);
        });
        return cb(null, {
            source: 'rules',
            text: tips.length
                ? tips.join('\n')
                : 'All monitored components report Running Success. No action needed.'
        });
    }
    cb(null, {
        source: 'rules',
        text: 'OpenAI key detected — use Auto-fix for queue/integration issues; detailed AI analysis can be enabled in a future update.'
    });
}

module.exports = {
    attemptAutoFix,
    analyzeWithAiOptional,
    staffPortalsSkipOtp: () => portalAuthPolicy.isStaffPortal('admin')
};
