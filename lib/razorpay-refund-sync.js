/**
 * Razorpay refund status sync — webhooks, polling, portal updates.
 */
const crypto = require('crypto');
const Razorpay = require('razorpay');
const pgOpts = require('./payment-gateway-options');

function mapRazorpayRefundStatus(rzpStatus) {
    const s = String(rzpStatus || '').toLowerCase();
    if (s === 'processed') return 'completed';
    if (s === 'failed') return 'failed';
    if (s === 'pending') return 'processing';
    return 'processing';
}

function deriveRefundStatusFromGatewayResult(gwResult, refundAmt) {
    const amt = Number(refundAmt) || 0;
    if (amt <= 0) return 'none';
    if (!gwResult) return 'pending';
    if (gwResult.manualRequired) return 'manual_pending';
    if (!gwResult.ok) return 'failed';
    if (gwResult.gateway === 'razorpay' && gwResult.raw && gwResult.raw.status) {
        return mapRazorpayRefundStatus(gwResult.raw.status);
    }
    return gwResult.ok ? 'processing' : 'failed';
}

function getWebhookSecret(db, cb) {
    if (process.env.RAZORPAY_WEBHOOK_SECRET) {
        return cb(null, String(process.env.RAZORPAY_WEBHOOK_SECRET).trim());
    }
    pgOpts.loadGatewayCredentials(db, 'razorpay', (err, opt) => {
        if (err) return cb(err);
        const secret =
            (opt && opt.config && (opt.config.webhook_secret || opt.config.webhookSecret)) || '';
        cb(null, String(secret || '').trim());
    });
}

function verifyWebhookSignature(rawBody, signature, secret) {
    if (!secret) return { ok: true, skipped: true, reason: 'no_webhook_secret' };
    if (!signature || !rawBody) return { ok: false, error: 'missing signature or body' };
    try {
        const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
        const a = Buffer.from(expected, 'utf8');
        const b = Buffer.from(String(signature).trim(), 'utf8');
        if (a.length !== b.length) return { ok: false, error: 'signature length mismatch' };
        return { ok: crypto.timingSafeEqual(a, b) };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

function parseWebhookRefundEntity(body) {
    const event = body && body.event ? String(body.event) : '';
    const entity =
        (body &&
            body.payload &&
            body.payload.refund &&
            (body.payload.refund.entity || body.payload.refund)) ||
        null;
    return { event, entity };
}

function fetchRazorpayRefund(credentials, refundId, cb) {
    if (!credentials || !credentials.key_id || !credentials.key_secret) {
        return cb(null, { ok: false, error: 'Razorpay credentials missing' });
    }
    const rz = new Razorpay({
        key_id: credentials.key_id,
        key_secret: credentials.key_secret
    });
    rz.refunds.fetch(refundId, (err, refund) => {
        if (err) {
            const msg =
                (err.error && err.error.description) || err.message || 'Razorpay fetch failed';
            return cb(null, { ok: false, error: msg });
        }
        cb(null, { ok: true, refund });
    });
}

function loadRazorpayCredentials(db, cb) {
    pgOpts.loadGatewayCredentials(db, 'razorpay', (err, opt) => {
        if (err) return cb(err);
        if (!opt || !opt.config) return cb(null, null);
        cb(null, { key_id: opt.config.key_id, key_secret: opt.config.key_secret });
    });
}

function extractBankUtrFromRazorpayRefund(raw) {
    if (!raw || typeof raw !== 'object') return '';
    const ad = raw.acquirer_data && typeof raw.acquirer_data === 'object' ? raw.acquirer_data : {};
    const candidates = [ad.rrn, ad.utr, ad.arn, raw.utr, raw.bank_utr, raw.rrn];
    for (const c of candidates) {
        const s = String(c || '').trim();
        if (s) return s;
    }
    return '';
}

function summarizeRazorpayRefund(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const bankUtr = extractBankUtrFromRazorpayRefund(raw);
    return {
        id: raw.id || null,
        paymentId: raw.payment_id || null,
        amountPaisa: raw.amount != null ? Number(raw.amount) : null,
        amountRupees:
            raw.amount != null ? Math.round((Number(raw.amount) / 100) * 100) / 100 : null,
        status: raw.status || null,
        speedProcessed: raw.speed_processed || raw.speed || null,
        bankUtr: bankUtr || null,
        createdAt: raw.created_at != null ? new Date(Number(raw.created_at) * 1000).toISOString() : null
    };
}

function applyRefundStatusUpdate(db, opts, cb) {
    const providerRefundId = String((opts && opts.providerRefundId) || '').trim();
    if (!providerRefundId) return cb && cb(null, { ok: false, error: 'providerRefundId required' });

    const providerStatus = opts.providerStatus || null;
    const internalStatus =
        opts.internalStatus ||
        (providerStatus ? mapRazorpayRefundStatus(providerStatus) : opts.status || 'processing');
    const failureReason = opts.failureReason || null;
    const raw = opts.raw || null;
    const source = opts.source || 'sync';
    const now = new Date().toISOString();
    const extractedUtr = extractBankUtrFromRazorpayRefund(raw);

    db.get(
        `SELECT * FROM refunds WHERE provider_refund_id = ? ORDER BY id DESC LIMIT 1`,
        [providerRefundId],
        (err, row) => {
            if (err) return cb && cb(err);
            if (!row) {
                return cb && cb(null, { ok: false, error: 'Refund row not found', providerRefundId });
            }

            const prevStatus = String(row.status || '').toLowerCase();
            const rawJson = raw ? JSON.stringify(raw).slice(0, 4000) : row.raw_response;
            const bankUtr = extractedUtr || row.bank_utr || null;

            db.run(
                `UPDATE refunds SET status = ?, provider_status = ?, failure_reason = ?, raw_response = COALESCE(?, raw_response), bank_utr = COALESCE(?, bank_utr), updated_at = ? WHERE id = ?`,
                [
                    internalStatus,
                    providerStatus,
                    failureReason,
                    rawJson,
                    extractedUtr || null,
                    now,
                    row.id
                ],
                (uErr) => {
                    if (uErr) return cb && cb(uErr);

                    const orderUpdate =
                        internalStatus === 'completed'
                            ? new Promise((res) => {
                                  db.run(
                                      `UPDATE orders SET refund_status = 'refunded' WHERE id = ?`,
                                      [row.order_id],
                                      () => res()
                                  );
                              })
                            : Promise.resolve();

                    orderUpdate.then(() => {
                        db.run(
                            `UPDATE cancellation_requests SET refund_status = ?, provider_refund_id = COALESCE(provider_refund_id, ?)
                             WHERE registration_id = ? AND status = 'approved'`,
                            [internalStatus, providerRefundId, row.registration_id],
                            () => {
                                const becameCompleted =
                                    internalStatus === 'completed' && prevStatus !== 'completed';
                                if (!becameCompleted) {
                                    return cb && cb(null, {
                                        ok: true,
                                        refundId: row.id,
                                        status: internalStatus,
                                        providerStatus,
                                        source,
                                        notified: false
                                    });
                                }
                                db.get(
                                    `SELECT user_id, seminar_id FROM registrations WHERE id = ?`,
                                    [row.registration_id],
                                    (eReg, reg) => {
                                        if (eReg || !reg) {
                                            return cb && cb(null, {
                                                ok: true,
                                                refundId: row.id,
                                                status: internalStatus,
                                                notified: false
                                            });
                                        }
                                        try {
                                            const notifEngine = require('./notification-engine');
                                            notifEngine.notify(
                                                db,
                                                'REFUND_COMPLETED',
                                                {
                                                    userId: reg.user_id,
                                                    registrationId: row.registration_id,
                                                    seminarId: reg.seminar_id,
                                                    vars: {
                                                        refund_amount: String(row.amount || ''),
                                                        refund_percent: row.percent != null ? String(row.percent) : '',
                                                        provider_refund_id: providerRefundId,
                                                        refund_status: internalStatus,
                                                        refund_status_label: require('./refund-tracking').refundStatusLabel(
                                                            internalStatus
                                                        ),
                                                        refund_gateway: row.gateway || 'razorpay',
                                                        bank_utr: bankUtr || ''
                                                    }
                                                },
                                                () => {}
                                            );
                                        } catch (_) {}
                                        cb && cb(null, {
                                            ok: true,
                                            refundId: row.id,
                                            status: internalStatus,
                                            providerStatus,
                                            source,
                                            notified: true
                                        });
                                    }
                                );
                            }
                        );
                    });
                }
            );
        }
    );
}

function handleRazorpayWebhook(db, body, cb) {
    const { event, entity } = parseWebhookRefundEntity(body || {});
    if (!entity || !entity.id) {
        return cb && cb(null, { ok: true, skipped: true, reason: 'not a refund event' });
    }
    if (!/^refund\./.test(event) && !entity.status) {
        return cb && cb(null, { ok: true, skipped: true, reason: 'ignored event ' + event });
    }

    applyRefundStatusUpdate(
        db,
        {
            providerRefundId: entity.id,
            providerStatus: entity.status,
            failureReason:
                entity.status === 'failed'
                    ? entity.error_description || entity.description || 'Refund failed at Razorpay'
                    : null,
            raw: entity,
            source: 'webhook:' + event
        },
        cb
    );
}

function reconcilePendingRazorpayRefunds(db, cb) {
    db.all(
        `SELECT r.* FROM refunds r
         WHERE LOWER(COALESCE(r.gateway, '')) = 'razorpay'
           AND LOWER(COALESCE(r.status, '')) IN ('processing', 'pending', 'manual_pending')
           AND r.provider_refund_id IS NOT NULL AND TRIM(r.provider_refund_id) != ''
         ORDER BY r.id ASC
         LIMIT 40`,
        [],
        (err, rows) => {
            if (err) return cb && cb(err);
            if (!rows || !rows.length) return cb && cb(null, { checked: 0, updated: 0 });

            loadRazorpayCredentials(db, (credErr, creds) => {
                if (credErr) return cb && cb(credErr);
                if (!creds) return cb && cb(null, { checked: 0, updated: 0, error: 'no credentials' });

                let checked = 0;
                let updated = 0;
                let left = rows.length;
                const results = [];

                rows.forEach((row) => {
                    fetchRazorpayRefund(creds, row.provider_refund_id, (fErr, fetched) => {
                        checked++;
                        if (fErr || !fetched || !fetched.ok || !fetched.refund) {
                            results.push({
                                id: row.id,
                                providerRefundId: row.provider_refund_id,
                                ok: false,
                                error: (fetched && fetched.error) || 'fetch failed'
                            });
                            if (--left === 0) cb && cb(null, { checked, updated, results });
                            return;
                        }
                        const rz = fetched.refund;
                        const nextStatus = mapRazorpayRefundStatus(rz.status);
                        if (String(row.status || '').toLowerCase() === nextStatus) {
                            results.push({ id: row.id, providerRefundId: row.provider_refund_id, ok: true, unchanged: true });
                            if (--left === 0) cb && cb(null, { checked, updated, results });
                            return;
                        }
                        applyRefundStatusUpdate(
                            db,
                            {
                                providerRefundId: row.provider_refund_id,
                                providerStatus: rz.status,
                                internalStatus: nextStatus,
                                failureReason:
                                    rz.status === 'failed'
                                        ? rz.error_description || 'Refund failed at Razorpay'
                                        : null,
                                raw: rz,
                                source: 'poll'
                            },
                            (aErr, applied) => {
                                if (!aErr && applied && applied.ok) updated++;
                                results.push({
                                    id: row.id,
                                    providerRefundId: row.provider_refund_id,
                                    ok: !!(applied && applied.ok),
                                    status: nextStatus,
                                    error: applied && applied.error
                                });
                                if (--left === 0) cb && cb(null, { checked, updated, results });
                            }
                        );
                    });
                });
            });
        }
    );
}

function syncRefundByProviderId(db, providerRefundId, cb) {
    const id = String(providerRefundId || '').trim();
    if (!id) return cb && cb(null, { ok: false, error: 'refund id required' });
    loadRazorpayCredentials(db, (credErr, creds) => {
        if (credErr) return cb && cb(credErr);
        if (!creds) return cb && cb(null, { ok: false, error: 'Razorpay not configured' });
        fetchRazorpayRefund(creds, id, (fErr, fetched) => {
            if (fErr) return cb && cb(fErr);
            if (!fetched.ok) return cb && cb(null, fetched);
            const rz = fetched.refund;
            applyRefundStatusUpdate(
                db,
                {
                    providerRefundId: rz.id,
                    providerStatus: rz.status,
                    internalStatus: mapRazorpayRefundStatus(rz.status),
                    failureReason:
                        rz.status === 'failed'
                            ? rz.error_description || 'Refund failed at Razorpay'
                            : null,
                    raw: rz,
                    source: 'manual_sync'
                },
                cb
            );
        });
    });
}

module.exports = {
    mapRazorpayRefundStatus,
    deriveRefundStatusFromGatewayResult,
    getWebhookSecret,
    verifyWebhookSignature,
    parseWebhookRefundEntity,
    fetchRazorpayRefund,
    summarizeRazorpayRefund,
    extractBankUtrFromRazorpayRefund,
    applyRefundStatusUpdate,
    handleRazorpayWebhook,
    reconcilePendingRazorpayRefunds,
    syncRefundByProviderId
};
