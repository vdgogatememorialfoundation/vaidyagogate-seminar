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
        if (hasRazorpayKeys(c.test)) {
            options.push({
                id: 'razorpay:test',
                gateway: 'razorpay',
                mode: 'test',
                label: labelBase + ' (Test)' + (c.test.enabled === false ? '' : ''),
                config: { key_id: c.test.key_id, key_secret: c.test.key_secret }
            });
        }
        if (c.live.enabled && hasRazorpayKeys(c.live)) {
            options.push({
                id: 'razorpay:live',
                gateway: 'razorpay',
                mode: 'live',
                label: labelBase + ' (Live)',
                config: { key_id: c.live.key_id, key_secret: c.live.key_secret }
            });
        }
        return options;
    }

    if (Number(row.is_active) !== 1) return options;

    const test = config.test || {};
    const live = config.live || {};
    const legacyKeys = config.merchant_key || config.key_id || config.app_id;

    if (test.enabled !== false && (test.merchant_key || test.key_id || legacyKeys)) {
        options.push({
            id: name + ':test',
            gateway: name,
            mode: 'test',
            label: labelBase + ' (Test)',
            config: { ...config, ...test, mode: 'test' }
        });
    }
    if (live.enabled && (live.merchant_key || live.key_id || live.app_id)) {
        options.push({
            id: name + ':live',
            gateway: name,
            mode: 'live',
            label: labelBase + ' (Live)',
            config: { ...config, ...live, mode: 'live' }
        });
    }

    return options;
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

module.exports = {
    GATEWAY_LABELS,
    parseGatewayConfig,
    migrateLegacyRazorpay,
    expandGatewayRow,
    resolvePaymentOption
};
