/**
 * Admin manual venue check-in (without scanner QR) — marks ticket scanned and syncs certificate eligibility.
 */
const seminarDt = require('./seminar-datetime');

function performManualCheckin(db, deps, registrationId, staffId, cb) {
    const rid = parseInt(registrationId, 10);
    const sid = parseInt(staffId, 10);
    if (!Number.isInteger(rid) || rid < 1) return cb(new Error('Invalid registration id'));

    db.get(
        `SELECT r.id AS registration_id, r.user_id, r.seminar_id, r.status,
                t.id AS ticket_id, IFNULL(t.scan_count, 0) AS scan_count,
                IFNULL(s.cert_scans_required, 1) AS cert_scans_required,
                o.status AS payment_status
         FROM registrations r
         JOIN seminars s ON s.id = r.seminar_id
         LEFT JOIN orders o ON o.registration_id = r.id AND lower(trim(o.status)) = 'success'
         LEFT JOIN tickets t ON t.order_id = o.id
         WHERE r.id = ?`,
        [rid],
        (err, row) => {
            if (err) return cb(err);
            if (!row) return cb(new Error('Registration not found'));
            if (String(row.payment_status || '').toLowerCase() !== 'success') {
                return cb(new Error('Payment must be confirmed before manual check-in.'));
            }
            if (!row.ticket_id) return cb(new Error('No e-ticket found for this registration. Issue ticket first.'));

            const scansRequired = Math.max(1, parseInt(row.cert_scans_required, 10) || 1);
            const newScanCount = Math.max(scansRequired, Number(row.scan_count) || 0);
            const scanAt = seminarDt.scanTimeNowForStorage ? seminarDt.scanTimeNowForStorage() : new Date().toISOString();

            db.run(
                `UPDATE tickets SET scan_count = ?, is_scanned = 1, scan_time = ?, scanned_by = ? WHERE id = ?`,
                [newScanCount, scanAt, Number.isInteger(sid) && sid > 0 ? sid : null, row.ticket_id],
                (uErr) => {
                    if (uErr) return cb(uErr);
                    const sync = deps.syncCertificateEligibilityForTicket;
                    const afterSync = () => {
                        db.run(
                            `UPDATE user_certificates SET enabled = 1, updated_at = CURRENT_TIMESTAMP
                             WHERE registration_id = ? AND IFNULL(scan_verified, 0) = 1`,
                            [rid],
                            () => {
                                db.run(
                                    `UPDATE registrations SET status = 'checked_in'
                                     WHERE id = ? AND status NOT IN ('rejected', 'cancelled')`,
                                    [rid],
                                    () => {
                                        if (deps.portalTracking) {
                                            deps.portalTracking.logRegistrationEvent(
                                                db,
                                                rid,
                                                'checked_in',
                                                'Checked in (admin manual)',
                                                'Marked checked in by admin without scanner',
                                                () => {}
                                            );
                                        }
                                        cb(null, {
                                            success: true,
                                            ticketId: row.ticket_id,
                                            scanCount: newScanCount,
                                            scansRequired
                                        });
                                    }
                                );
                            }
                        );
                    };
                    if (typeof sync === 'function') {
                        sync(row.ticket_id, afterSync);
                    } else {
                        afterSync();
                    }
                }
            );
        }
    );
}

module.exports = { performManualCheckin };
