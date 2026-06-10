/**
 * Expand payment_gateways rows into doctor-selectable options (test / live per provider).
 */
const GATEWAY_LABELS = {
    razorpay: 'Razorpay',
    payu: 'PayU',
    easebuzz: 'Easebuzz',
    paytm: 'Paytm',
    phonepe: 'PhonePe',
    cashfree: 'Cashfree',
    juspay: 'Juspay',
    zoho: 'Zoho Payments'
};

/** Live checkout providers exposed to doctors and default site transactions. */
const LIVE_CHECKOUT_PROVIDERS = new Set([
    'razorpay',
    'cashfree',
    'juspay',
    'easebuzz',
    'payu',
    'paytm',
    'phonepe',
    'zoho'
]);

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

const MANUAL_PROVIDER_NAMES = new Set(['payu', 'easebuzz', 'paytm', 'phonepe', 'cashfree', 'juspay', 'zoho']);

function hasProviderRootCredentials(name, config) {
    const c = config || {};
    if (name === 'phonepe') {
        return !!((c.merchant_id && c.salt_key) || (c.client_id && c.client_secret));
    }
    if (name === 'cashfree') {
        return !!(c.app_id && c.secret_key);
    }
    if (name === 'juspay') {
        return !!(c.merchant_id && c.api_key && c.payment_page_client_id);
    }
    if (name === 'zoho') {
        return !!(c.client_id && c.client_secret && c.refresh_token && c.organization_id);
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
    if (rootCreds && live.enabled === undefined) {
        live.enabled = true;
        if (name === 'phonepe') {
            live.merchant_id = live.merchant_id || c.merchant_id || '';
            live.salt_key = live.salt_key || c.salt_key || '';
            live.salt_index = live.salt_index || c.salt_index || '1';
            live.client_id = live.client_id || c.client_id || '';
            live.client_secret = live.client_secret || c.client_secret || '';
            live.client_version = live.client_version || c.client_version || '1';
        } else if (name === 'cashfree') {
            live.app_id = live.app_id || c.app_id || '';
            live.secret_key = live.secret_key || c.secret_key || '';
        } else if (name === 'juspay') {
            live.merchant_id = live.merchant_id || c.merchant_id || '';
            live.api_key = live.api_key || c.api_key || '';
            live.payment_page_client_id = live.payment_page_client_id || c.payment_page_client_id || '';
        } else if (name === 'zoho') {
            live.client_id = live.client_id || c.client_id || '';
            live.client_secret = live.client_secret || c.client_secret || '';
            live.refresh_token = live.refresh_token || c.refresh_token || '';
            live.organization_id = live.organization_id || c.organization_id || '';
            live.signing_key = live.signing_key || c.signing_key || '';
        } else if (name === 'paytm') {
            live.merchant_id = live.merchant_id || c.merchant_id || '';
            live.merchant_key = live.merchant_key || c.merchant_key || '';
        } else {
            live.merchant_key = live.merchant_key || c.merchant_key || '';
            live.merchant_salt = live.merchant_salt || c.merchant_salt || '';
            if (name === 'payu') live.merchant_id = live.merchant_id || c.merchant_id || '';
        }
        if (name === 'phonepe') {
            test.merchant_id = test.merchant_id || c.merchant_id || '';
            test.salt_key = test.salt_key || c.salt_key || '';
            test.salt_index = test.salt_index || c.salt_index || '1';
            test.client_id = test.client_id || c.client_id || '';
            test.client_secret = test.client_secret || c.client_secret || '';
            test.client_version = test.client_version || c.client_version || '1';
        } else if (name === 'cashfree') {
            test.app_id = test.app_id || c.app_id || '';
            test.secret_key = test.secret_key || c.secret_key || '';
        } else if (name === 'juspay') {
            test.merchant_id = test.merchant_id || c.merchant_id || '';
            test.api_key = test.api_key || c.api_key || '';
            test.payment_page_client_id = test.payment_page_client_id || c.payment_page_client_id || '';
        } else if (name === 'zoho') {
            test.client_id = test.client_id || c.client_id || '';
            test.client_secret = test.client_secret || c.client_secret || '';
            test.refresh_token = test.refresh_token || c.refresh_token || '';
            test.organization_id = test.organization_id || c.organization_id || '';
            test.signing_key = test.signing_key || c.signing_key || '';
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
    if (!c.live && (c.key_id || c.key_secret)) {
        c.live = {
            enabled: true,
            key_id: c.key_id || '',
            key_secret: c.key_secret || ''
        };
    }
    if (!c.live) c.live = { enabled: false, key_id: '', key_secret: '' };
    return c;
}

function expandGatewayRow(row) {
    const name = String(row.name || '').toLowerCase();
    if (!LIVE_CHECKOUT_PROVIDERS.has(name)) return [];
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
                label: labelBase,
                config: { key_id: c.live.key_id, key_secret: c.live.key_secret }
            });
        }
        return options;
    }

    if (Number(row.is_active) !== 1) return options;

    const c = migrateLegacyProviderConfig(name, config);
    const live = c.live || {};
    const legacyKeys = hasProviderRootCredentials(name, c);

    if (live.enabled === false) {
        return options;
    }

    const liveReady =
        live.enabled !== false &&
        (live.merchant_key ||
            live.key_id ||
            live.merchant_id ||
            live.app_id ||
            (name === 'phonepe' &&
                ((live.client_id && live.client_secret) || (live.merchant_id && live.salt_key))) ||
            (name === 'cashfree' && live.secret_key) ||
            (name === 'juspay' && live.api_key && live.payment_page_client_id) ||
            (name === 'zoho' &&
                live.client_id &&
                live.client_secret &&
                live.refresh_token &&
                live.organization_id) ||
            legacyKeys);

    if (liveReady) {
        options.push({
            id: name + ':live',
            gateway: name,
            mode: 'live',
            label: labelBase,
            config: { ...c, ...live, mode: 'live' }
        });
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

function listLiveGatewayNames(rows) {
    const expanded = [];
    (rows || []).forEach((row) => {
        if (Number(row.is_active) !== 1) return;
        expanded.push(...expandGatewayRow(row));
    });
    return [...new Set(expanded.filter((o) => o.mode === 'live').map((o) => o.gateway))];
}

function normalizeGatewaySave(name, config, isActive) {
    const n = String(name || '').toLowerCase();
    let c =
        n === 'razorpay'
            ? migrateLegacyRazorpay(parseGatewayConfig(config))
            : migrateLegacyProviderConfig(n, parseGatewayConfig(config));

    const probe = expandGatewayRow({
        name: n,
        is_active: 1,
        config: { ...c, live: { ...(c.live || {}), enabled: true } }
    });
    let active = !!isActive;
    if (probe.some((o) => o.mode === 'live')) {
        if (n === 'razorpay') {
            if (!c.live) c.live = { enabled: true, key_id: '', key_secret: '' };
            c.live.enabled = true;
        } else {
            if (!c.live) c.live = {};
            c.live.enabled = true;
        }
        active = true;
    }
    return { config: c, is_active: active ? 1 : 0 };
}

function pickDefaultLiveGateway(rows) {
    const live = listLiveGatewayNames(rows);
    if (!live.length) return null;
    const priority = [
        'razorpay',
        'cashfree',
        'juspay',
        'easebuzz',
        'payu',
        'paytm',
        'phonepe',
        'zoho'
    ];
    for (const gw of priority) {
        if (live.includes(gw)) return gw;
    }
    return live[0];
}

module.exports = {
    GATEWAY_LABELS,
    LIVE_CHECKOUT_PROVIDERS,
    MANUAL_PROVIDER_NAMES,
    parseGatewayConfig,
    migrateLegacyRazorpay,
    migrateLegacyProviderConfig,
    mergeRazorpayConfig,
    expandGatewayRow,
    resolvePaymentOption,
    activateGatewaysWithCredentials,
    listLiveGatewayNames,
    normalizeGatewaySave,
    pickDefaultLiveGateway
};
