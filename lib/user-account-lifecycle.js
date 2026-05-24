/**
 * Account created / activated timestamps on users.
 * Activation: first verified email, first login, or admin-created (pre-verified) account.
 */

function stampAccountActivated(db, userId, cb) {
    const uid = parseInt(userId, 10);
    if (!db || !Number.isInteger(uid) || uid < 1) return cb && cb();
    db.run(
        `UPDATE users SET activated_at = COALESCE(activated_at, CURRENT_TIMESTAMP) WHERE id = ?`,
        [uid],
        (err) => cb && cb(err)
    );
}

function backfillAccountActivatedAt(db, cb) {
    if (!db) return cb && cb();
    db.run(
        `UPDATE users SET activated_at = COALESCE(
            activated_at,
            last_login_at,
            CASE WHEN IFNULL(email_verified, 1) = 1 THEN created_at END
        )
        WHERE activated_at IS NULL`,
        [],
        (err) => cb && cb(err)
    );
}

module.exports = {
    stampAccountActivated,
    backfillAccountActivatedAt
};
