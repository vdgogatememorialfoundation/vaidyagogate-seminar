/**
 * Expand payment_gateways rows into doctor-selectable options (test / live per provider).
 */
const GATEWAY_LABELS = {
    razorpay: 'Razorpay',
    payu: 'PayU',
    easebuzz: 'Easebuzz',
    paytm: 'Paytm',
    phonepe: 'PhonePe',
    cashfree: 'Cashfree'
};

function parseGatewayConfig(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try {
        return JSON.parse(raw || '{}');
    } catch (_) {
        return {};
    }
}

function hasRazorpayKeys(cfg) {
    return !!(cfg && cfg.key_id && cfg.key_secret);
}

const MANUAL_PROVIDER_NAMES = new Set(['payu', 'easebuzz', 'paytm', 'phonepe', 'cashfree']);

function hasProviderRootCredentials(name, config) {
    const c = config || {};
    if (name === 'phonepe') {
        return !!(c.merchant_id && c.salt_key);
    }
    if (name === 'cashfree') {
        return !!(c.app_id && c.secret_key);
    }
    if (name === 'paytm') {
        return !!(c.merchant_id && c.merchant_key);
    }
    if (name === 'payu' || name === 'easebuzz') {
        return !!(c.merchant_key && c.merchant_salt);
    }
    return !!(c.merchant_key || c.merchant_id || c.app_id || c.key_id);
}

function migrateLegacyProviderConfig(name, config) {
    const c = { ...parseGatewayConfig(config) };
    if (!MANUAL_PROVIDER_NAMES.has(name)) return c;
    const test = { ...(c.test || {}) };
    const live = { ...(c.live || {}) };
    const rootCreds = hasProviderRootCredentials(name, c);
    if (rootCreds && test.enabled === undefined && !live.enabled) {
        test.enabled = true;
        if (name === 'phonepe') {
            test.merchant_id = test.merchant_id || c.merchant_id || '';
            test.salt_key = test.salt_key || c.salt_key || '';
        } else if (name === 'cashfree') {
            test.app_id = test.app_id || c.app_id || '';
            test.secret_key = test.secret_key || c.secret_key || '';
        } else if (name === 'paytm') {
            test.merchant_id = test.merchant_id || c.merchant_id || '';
            test.merchant_key = test.merchant_key || c.merchant_key || '';
            test.website = test.website || c.website || '';
        } else {
            test.merchant_key = test.merchant_key || c.merchant_key || '';
            test.merchant_salt = test.merchant_salt || c.merchant_salt || '';
            if (name === 'payu') test.merchant_id = test.merchant_id || c.merchant_id || '';
        }
    }
    if (!c.test) c.test = test;
    else c.test = { ...test, ...c.test };
    if (!c.live) c.live = live;
    else c.live = { ...live, ...c.live };
    return c;
}

function migrateLegacyRazorpay(config) {
    const c = { ...config };
    if (!c.test && !c.live && (c.key_id || c.key_secret)) {
        c.test = {
            enabled: true,
            key_id: c.key_id || '',
            key_secret: c.key_secret || ''
        };
    }
    if (!c.test) c.test = { enabled: false, key_id: '', key_secret: '' };
    if (!c.live) c.live = { enabled: false, key_id: '', key_secret: '' };
    return c;
}

function expandGatewayRow(row) {
    const name = String(row.name || '').toLowerCase();
    const config = parseGatewayConfig(row.config);
    const labelBase = GATEWAY_LABELS[name] || name;
    const options = [];

    if (name === 'razorpay') {
        const c = migrateLegacyRazorpay(config);
        if (hasRazorpayKeys(c.live) && (c.live.enabled || String(c.live.key_id).startsWith('rzp_live_'))) {
            options.push({
                id: 'razorpay:live',
                gateway: 'razorpay',
                mode: 'live',
                label: labelBase + ' (Live)',
                config: { key_id: c.live.key_id, key_secret: c.live.key_secret }
            });
        }
        if (c.test.enabled && hasRazorpayKeys(c.test)) {
            options.push({
                id: 'razorpay:test',
                gateway: 'razorpay',
                mode: 'test',
                label: labelBase + ' (Test)',
                config: { key_id: c.test.key_id, key_secret: c.test.key_secret }
            });
        }
        return options;
    }

    if (Number(row.is_active) !== 1) return options;

    const c = migrateLegacyProviderConfig(name, config);
    const test = c.test || {};
    const live = c.live || {};
    const legacyKeys = hasProviderRootCredentials(name, c);

    const testReady =
        test.enabled !== false &&
        (test.merchant_key ||
            test.key_id ||
            test.merchant_id ||
            test.app_id ||
            (name === 'phonepe' && test.salt_key) ||
            (name === 'cashfree' && test.secret_key) ||
            legacyKeys);
    const liveReady =
        live.enabled &&
        (live.merchant_key ||
            live.key_id ||
            live.merchant_id ||
            live.app_id ||
            (name === 'phonepe' && live.salt_key) ||
            (name === 'cashfree' && live.secret_key));

    if (testReady) {
        options.push({
            id: name + ':test',
            gateway: name,
            mode: 'test',
            label: labelBase + ' (Test)',
            config: { ...c, ...test, mode: 'test' }
        });
    }
    if (liveReady) {
        options.push({
            id: name + ':live',
            gateway: name,
            mode: 'live',
            label: labelBase + ' (Live)',
            config: { ...c, ...live, mode: 'live' }
        });
    }

    if (!options.length && legacyKeys) {
        options.push({
            id: name + ':live',
            gateway: name,
            mode: 'live',
            label: labelBase + ' (Live)',
            config: { ...c, mode: 'live' }
        });
        if (test.enabled || name === 'paytm') {
            options.push({
                id: name + ':test',
                gateway: name,
                mode: 'test',
                label: labelBase + ' (Test)',
                config: { ...c, mode: 'test' }
            });
        }
    }

    return options;
}

function mergeRazorpayConfig(existing, incoming) {
    const ex = migrateLegacyRazorpay(parseGatewayConfig(existing));
    const inc = migrateLegacyRazorpay(incoming || {});
    ['test', 'live'].forEach((mode) => {
        if (!inc[mode].key_secret && ex[mode].key_secret) inc[mode].key_secret = ex[mode].key_secret;
        if (!inc[mode].key_id && ex[mode].key_id) inc[mode].key_id = ex[mode].key_id;
    });
    if (hasRazorpayKeys(inc.live)) inc.live.enabled = true;
    return inc;
}

function resolvePaymentOption(paymentOptionId, rows) {
    const id = String(paymentOptionId || '').trim();
    if (!id) return null;
    const all = [];
    (rows || []).forEach((row) => {
        if (Number(row.is_active) !== 1) return;
        all.push(...expandGatewayRow(row));
    });
    return all.find((o) => o.id === id) || null;
}

function activateGatewaysWithCredentials(db, cb) {
    db.all(`SELECT name, is_active, config FROM payment_gateways`, [], (err, rows) => {
        if (err) return cb(err);
        let pending = 0;
        let done = false;
        const finish = (e) => {
            if (done) return;
            if (e) {
                done = true;
                return cb(e);
            }
            if (pending === 0) {
                done = true;
                cb(null);
            }
        };
        (rows || []).forEach((row) => {
            const expanded = expandGatewayRow({ ...row, is_active: 1 });
            if (!expanded.length) return;
            if (Number(row.is_active) === 1) return;
            pending++;
            db.run(`UPDATE payment_gateways SET is_active = 1 WHERE name = ?`, [row.name], (uErr) => {
                pending--;
                finish(uErr);
            });
        });
        finish(null);
    });
}

module.exports = {
    GATEWAY_LABELS,
    MANUAL_PROVIDER_NAMES,
    parseGatewayConfig,
    migrateLegacyRazorpay,
    migrateLegacyProviderConfig,
    mergeRazorpayConfig,
    expandGatewayRow,
    resolvePaymentOption,
    activateGatewaysWithCredentials
};
