/**
 * Resolve Razorpay credentials from DB and/or environment; retry with env on auth failure.
 */
const Razorpay = require('razorpay');
const paymentGatewayOptions = require('./payment-gateway-options');
const razorpayCredentials = require('./razorpay-credentials');

function adminFlow() {
    return require('./admin-payment-flow');
}

function isRazorpayAuthError(err) {
    const msg = adminFlow().razorpayErrorMessage(err, '');
    return /authentication failed|unauthorized|invalid.*key|bad auth/i.test(msg);
}

function envToResolved(env, paymentOptionId) {
    const optId = String(paymentOptionId || '').trim();
    return {
        id: optId || `razorpay:${env.mode}`,
        gateway: 'razorpay',
        mode: env.mode,
        label: env.mode === 'live' ? 'Razorpay' : 'Razorpay (Test)',
        config: { key_id: env.key_id, key_secret: env.key_secret },
        source: 'env'
    };
}

function envMatchesRequestedMode(env, paymentOptionId) {
    const optId = String(paymentOptionId || '').trim();
    const requestedMode = optId.includes(':') ? optId.split(':')[1] : '';
    if (requestedMode === 'live') return env.mode === 'live';
    if (requestedMode === 'test') return env.mode === 'test';
    return true;
}

function resolveRazorpayForCheckout(db, paymentOptionId, cb) {
    const optId = String(paymentOptionId || '').trim();

    db.all(`SELECT * FROM payment_gateways`, [], (err, rows) => {
        if (err) return cb(err);

        const pickFromDb = (id) => {
            if (id) {
                const resolved = paymentGatewayOptions.resolvePaymentOption(id, rows);
                if (resolved && resolved.gateway === 'razorpay') return { ...resolved, source: 'db' };
            }
            const expanded = [];
            (rows || []).forEach((row) => {
                expanded.push(...paymentGatewayOptions.expandGatewayRow(row));
            });
            if (id) {
                const hit = expanded.find((o) => o.id === id);
                if (hit) return { ...hit, source: 'db' };
            }
            return null;
        };

        const fromDb = pickFromDb(optId || 'razorpay:test') || pickFromDb('razorpay:live');
        if (fromDb) {
            return cb(null, fromDb);
        }

        const env = razorpayCredentials.fromEnv();
        if (!env) return cb(null, null);
        if (!envMatchesRequestedMode(env, optId)) return cb(null, null);

        return cb(null, envToResolved(env, optId));
    });
}

function createRazorpayOrderWithFallback(paymentOptionId, primaryResolved, orderPayload, cb) {
    const optId = String(paymentOptionId || '').trim();
    let triedEnv = false;

    const attempt = (opt, source) => {
        const rz = new Razorpay({
            key_id: opt.config.key_id,
            key_secret: opt.config.key_secret
        });
        adminFlow().createRazorpayOrder(rz, orderPayload, (err, order) => {
            if (err && isRazorpayAuthError(err) && !triedEnv) {
                const env = razorpayCredentials.fromEnv();
                if (env && envMatchesRequestedMode(env, optId)) {
                    const samePair =
                        env.key_id === opt.config.key_id && env.key_secret === opt.config.key_secret;
                    if (!samePair) {
                        triedEnv = true;
                        console.warn('[razorpay] DB keys rejected; retrying with RAZORPAY_KEY_* env', {
                            dbKeyPrefix: razorpayCredentials.keyIdPrefix(opt.config.key_id),
                            envKeyPrefix: razorpayCredentials.keyIdPrefix(env.key_id)
                        });
                        return attempt(envToResolved(env, optId), 'env');
                    }
                }
            }
            if (err) return cb(err);
            cb(null, order, opt, source);
        });
    };

    attempt(primaryResolved, primaryResolved.source || 'db');
}

function razorpayDiagnostics(db, cb) {
    const env = razorpayCredentials.fromEnv();
    db.get(`SELECT config, is_active FROM payment_gateways WHERE name = ?`, ['razorpay'], (e, row) => {
        if (e) return cb(e);
        const c = paymentGatewayOptions.migrateLegacyRazorpay(
            paymentGatewayOptions.parseGatewayConfig(row && row.config)
        );
        const test = c.test || {};
        const live = c.live || {};
        cb(null, {
            gatewayActive: paymentGatewayOptions.isGatewayRowActive(row || {}),
            envConfigured: !!env,
            envMode: env ? env.mode : null,
            envKeyPrefix: env ? razorpayCredentials.keyIdPrefix(env.key_id) : null,
            dbTestEnabled: test.enabled === true,
            dbTestActive: paymentGatewayOptions.razorpayModeIsActive(test, 'test'),
            dbTestKeyPrefix: razorpayCredentials.keyIdPrefix(test.key_id),
            dbLiveEnabled: live.enabled === true,
            dbLiveActive: paymentGatewayOptions.razorpayModeIsActive(live, 'live'),
            dbLiveKeyPrefix: razorpayCredentials.keyIdPrefix(live.key_id),
            envMatchesDbTest: !!(env && test.key_id && env.key_id === test.key_id),
            envMatchesDbLive: !!(env && live.key_id && env.key_id === live.key_id),
            hint:
                env && paymentGatewayOptions.razorpayModeIsActive(test, 'test') && env.key_id !== test.key_id
                    ? 'Render env keys differ from admin test Key ID — remove RAZORPAY_KEY_* from Render or re-save matching keys in Admin.'
                    : !env && paymentGatewayOptions.razorpayModeIsActive(test, 'test')
                      ? 'Only admin DB keys are configured (no RAZORPAY_KEY_* on server).'
                      : null
        });
    });
}

module.exports = {
    isRazorpayAuthError,
    resolveRazorpayForCheckout,
    createRazorpayOrderWithFallback,
    envToResolved,
    envMatchesRequestedMode,
    razorpayDiagnostics
};
