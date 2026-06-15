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

/** SQLite 0/1, PostgreSQL boolean, and stringy legacy values. */
function isGatewayRowActive(row) {
    const v = row && row.is_active;
    if (v === true || v === 1 || v === '1' || v === 't' || v === 'true') return true;
    if (v === false || v === 0 || v === '0' || v === 'f' || v === 'false' || v == null) return false;
    return Number(v) === 1;
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
    const c = { ...parseGatewayConfig(config) };
    const rootId = String(c.key_id || '').trim();
    const rootSecret = String(c.key_secret || '').trim();
    if (!c.test && !c.live && (rootId || rootSecret)) {
        if (rootId.startsWith('rzp_test_')) {
            c.test = { enabled: true, key_id: rootId, key_secret: rootSecret };
        } else {
            c.live = { enabled: true, key_id: rootId, key_secret: rootSecret };
        }
    }
    if (!c.live) c.live = { enabled: false, key_id: '', key_secret: '' };
    if (!c.test) c.test = { enabled: false, key_id: '', key_secret: '' };
    delete c.key_id;
    delete c.key_secret;
    return c;
}

function razorpayModeIsActive(modeCfg, mode) {
    const m = modeCfg || {};
    if (m.enabled !== true) return false;
    if (!hasRazorpayKeys(m)) return false;
    const id = String(m.key_id || '');
    if (mode === 'test') return id.startsWith('rzp_test_');
    if (mode === 'live') return id.startsWith('rzp_live_');
    return true;
}

function normalizeRazorpayModeSave(modeCfg) {
    const m = { ...(modeCfg || {}) };
    const enabled = m.enabled === true;
    if (!enabled) {
        return { enabled: false, key_id: '', key_secret: '' };
    }
    const key_id = String(m.key_id || '').trim();
    let key_secret = String(m.key_secret || '').trim();
    if (!key_id) {
        return { enabled: false, key_id: '', key_secret: '' };
    }
    return { enabled: true, key_id, key_secret };
}

function mergedProviderCredentials(name, config) {
    const n = String(name || '').toLowerCase();
    const c = migrateLegacyProviderConfig(n, parseGatewayConfig(config));
    const live = c.live || {};
    return { ...c, ...live };
}

function hasLiveCredentials(name, config) {
    const n = String(name || '').toLowerCase();
    if (n === 'razorpay') {
        const c = migrateLegacyRazorpay(parseGatewayConfig(config));
        return hasRazorpayKeys(c.live || {});
    }
    return hasProviderRootCredentials(n, mergedProviderCredentials(n, config));
}

function expandGatewayRow(row) {
    const name = String(row.name || '').toLowerCase();
    if (!LIVE_CHECKOUT_PROVIDERS.has(name)) return [];
    if (!isGatewayRowActive(row)) return [];
    const config = parseGatewayConfig(row.config);
    const labelBase = GATEWAY_LABELS[name] || name;
    const options = [];

    if (name === 'razorpay') {
        const c = migrateLegacyRazorpay(config);
        const test = c.test || {};
        const live = c.live || {};
        if (razorpayModeIsActive(test, 'test')) {
            options.push({
                id: 'razorpay:test',
                gateway: 'razorpay',
                mode: 'test',
                label: labelBase + ' (Test)',
                config: { key_id: test.key_id, key_secret: test.key_secret }
            });
        }
        if (razorpayModeIsActive(live, 'live')) {
            options.push({
                id: 'razorpay:live',
                gateway: 'razorpay',
                mode: 'live',
                label: labelBase,
                config: { key_id: live.key_id, key_secret: live.key_secret }
            });
        }
        return options;
    }

    if (!hasLiveCredentials(name, config)) return options;

    const c = migrateLegacyProviderConfig(name, config);
    const live = c.live || {};
    options.push({
        id: name + ':live',
        gateway: name,
        mode: 'live',
        label: labelBase,
        config: { ...c, ...live, mode: 'live' }
    });

    return options;
}

function mergeRazorpayConfig(existing, incoming) {
    const ex = migrateLegacyRazorpay(parseGatewayConfig(existing));
    const inc = migrateLegacyRazorpay(incoming || {});
    ['test', 'live'].forEach((mode) => {
        const incM = normalizeRazorpayModeSave(inc[mode]);
        const exM = ex[mode] || {};
        if (incM.enabled && incM.key_id && !incM.key_secret && exM.key_id === incM.key_id && exM.key_secret) {
            incM.key_secret = exM.key_secret;
        }
        inc[mode] = incM;
    });
    const incSecret = String(inc.webhook_secret || inc.webhookSecret || '').trim();
    const exSecret = String(ex.webhook_secret || ex.webhookSecret || '').trim();
    if (!incSecret && exSecret) {
        inc.webhook_secret = exSecret;
    } else if (incSecret) {
        inc.webhook_secret = incSecret;
    }
    return inc;
}

function resolvePaymentOption(paymentOptionId, rows) {
    const id = String(paymentOptionId || '').trim();
    if (!id) return null;
    const all = [];
    (rows || []).forEach((row) => {
        if (!isGatewayRowActive(row)) return;
        all.push(...expandGatewayRow(row));
    });
    return all.find((o) => o.id === id) || null;
}

function activateGatewaysWithCredentials(db, cb) {
    cb(null);
}

function listLiveGatewayNames(rows) {
    const expanded = [];
    (rows || []).forEach((row) => {
        if (!isGatewayRowActive(row)) return;
        expanded.push(...expandGatewayRow(row));
    });
    return [...new Set(expanded.filter((o) => o.mode === 'live').map((o) => o.gateway))];
}

function listCheckoutGatewayNames(rows) {
    const expanded = [];
    (rows || []).forEach((row) => {
        if (!isGatewayRowActive(row)) return;
        expanded.push(...expandGatewayRow(row));
    });
    return [...new Set(expanded.map((o) => o.label || o.id))];
}

function normalizeGatewaySave(name, config, isActive) {
    const n = String(name || '').toLowerCase();
    let c =
        n === 'razorpay'
            ? migrateLegacyRazorpay(parseGatewayConfig(config))
            : migrateLegacyProviderConfig(n, parseGatewayConfig(config));

    if (!isActive) {
        if (c.live) c.live.enabled = false;
        if (n === 'razorpay' && c.test) c.test.enabled = false;
        return { config: c, is_active: 0 };
    }

    if (n === 'razorpay') {
        c.test = normalizeRazorpayModeSave(c.test);
        c.live = normalizeRazorpayModeSave(c.live);
        if (c.test.enabled && !razorpayModeIsActive(c.test, 'test')) {
            c.test = { enabled: false, key_id: '', key_secret: '' };
        }
        if (c.live.enabled && !razorpayModeIsActive(c.live, 'live')) {
            c.live = { enabled: false, key_id: '', key_secret: '' };
        }
        return { config: c, is_active: 1 };
    }

    if (n !== 'razorpay' && hasLiveCredentials(n, c)) {
        if (!c.live) c.live = {};
        c.live.enabled = true;
        if (n === 'payu' || n === 'easebuzz') {
            c.live.merchant_key = c.live.merchant_key || c.merchant_key || '';
            c.live.merchant_salt = c.live.merchant_salt || c.merchant_salt || '';
        } else if (n === 'paytm') {
            c.live.merchant_id = c.live.merchant_id || c.merchant_id || '';
            c.live.merchant_key = c.live.merchant_key || c.merchant_key || '';
        } else if (n === 'cashfree') {
            c.live.app_id = c.live.app_id || c.app_id || '';
            c.live.secret_key = c.live.secret_key || c.secret_key || '';
        } else if (n === 'phonepe') {
            c.live.client_id = c.live.client_id || c.client_id || '';
            c.live.client_secret = c.live.client_secret || c.client_secret || '';
            c.live.merchant_id = c.live.merchant_id || c.merchant_id || '';
            c.live.salt_key = c.live.salt_key || c.salt_key || '';
        } else if (n === 'juspay') {
            c.live.merchant_id = c.live.merchant_id || c.merchant_id || '';
            c.live.api_key = c.live.api_key || c.api_key || '';
            c.live.payment_page_client_id =
                c.live.payment_page_client_id || c.payment_page_client_id || '';
        } else if (n === 'zoho') {
            c.live.client_id = c.live.client_id || c.client_id || '';
            c.live.client_secret = c.live.client_secret || c.client_secret || '';
            c.live.refresh_token = c.live.refresh_token || c.refresh_token || '';
            c.live.organization_id = c.live.organization_id || c.organization_id || '';
            c.live.signing_key = c.live.signing_key || c.signing_key || '';
        }
    }

    const probe = expandGatewayRow({
        name: n,
        is_active: 1,
        config: c
    });
    if (probe.some((o) => o.mode === 'live')) {
        if (n === 'razorpay') {
            if (!c.live) c.live = { enabled: true, key_id: '', key_secret: '' };
            if (c.live.enabled !== false) c.live.enabled = true;
        } else if (!c.live) {
            c.live = { enabled: true };
        } else if (c.live.enabled !== false) {
            c.live.enabled = true;
        }
    }
    return { config: c, is_active: 1 };
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

function loadGatewayCredentials(db, gatewayName, cb) {
    db.get(`SELECT name, config, is_active FROM payment_gateways WHERE name = ?`, [gatewayName], (err, row) => {
        if (err) return cb(err);
        if (!row) return cb(null, null);
        let config = {};
        try {
            config = row.config ? JSON.parse(row.config) : {};
        } catch (_) {
            config = {};
        }
        const options = expandGatewayRow({ name: row.name, config: JSON.stringify(config), is_active: row.is_active });
        cb(null, options[0] || null);
    });
}

module.exports = {
    GATEWAY_LABELS,
    LIVE_CHECKOUT_PROVIDERS,
    MANUAL_PROVIDER_NAMES,
    parseGatewayConfig,
    isGatewayRowActive,
    migrateLegacyRazorpay,
    migrateLegacyProviderConfig,
    mergeRazorpayConfig,
    razorpayModeIsActive,
    normalizeRazorpayModeSave,
    expandGatewayRow,
    resolvePaymentOption,
    activateGatewaysWithCredentials,
    hasLiveCredentials,
    listLiveGatewayNames,
    listCheckoutGatewayNames,
    normalizeGatewaySave,
    pickDefaultLiveGateway,
    loadGatewayCredentials
};
