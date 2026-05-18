/**
 * Send login OTP codes to a user's registered email and phone.
 */
const otpLib = require('./otp');
const authUsers = require('./auth-users');
const notifEngine = require('./notification-engine');

function sendLoginOtpsForUser(db, row, cb) {
    const meta = { userId: row.id };
    const channels = [];
    if (row.email) {
        channels.push({ channel: 'email', dest: authUsers.loginOtpDestination('email', row) });
    }
    const phoneDest = authUsers.loginOtpDestination('phone', row);
    if (phoneDest) channels.push({ channel: 'phone', dest: phoneDest });
    if (!channels.length) {
        return cb(null, { ok: false, status: 400, error: 'No email or phone on file for this account.' });
    }

    let left = channels.length;
    const results = {};
    let lastErr = null;

    channels.forEach(({ channel, dest }) => {
        otpLib.countRecentSends(db, channel, dest, (cerr, cnt) => {
            if (cerr) {
                results[channel] = { ok: false, error: cerr.message };
                lastErr = cerr;
                if (--left === 0) finish();
                return;
            }
            if (cnt >= otpLib.MAX_SENDS_PER_HOUR) {
                results[channel] = { ok: false, error: 'Too many OTP requests' };
                if (--left === 0) finish();
                return;
            }
            const code = otpLib.generateOtpDigits();
            otpLib.saveOtp(db, { channel, destination: dest, purpose: 'login', meta }, code, (serr) => {
                if (serr) {
                    results[channel] = { ok: false, error: serr.message };
                    lastErr = serr;
                    if (--left === 0) finish();
                    return;
                }
                const done = (sent) => {
                    results[channel] = sent;
                    if (--left === 0) finish();
                };
                if (channel === 'phone') {
                    notifEngine
                        .sendOtpMessages({ phone: dest, code, db, eventKey: 'OTP_VERIFICATION' })
                        .then((r) => done(r.whatsapp || { ok: false }));
                } else {
                    notifEngine
                        .sendOtpMessages({ email: dest, code, db, eventKey: 'OTP_VERIFICATION' })
                        .then((r) => done(r.email || { ok: false }));
                }
            });
        });
    });

    function finish() {
        const anyFail = Object.values(results).some((r) => r && !r.ok && !r.skipped);
        cb(lastErr, {
            ok: !anyFail,
            status: anyFail ? 503 : 200,
            results,
            ttlMinutes: otpLib.OTP_TTL_MIN
        });
    }
}

function sendLoginOtpChannel(db, row, channel, cb) {
    const dest = authUsers.loginOtpDestination(channel, row);
    if (!dest) {
        return cb(null, {
            ok: false,
            status: 400,
            error: channel === 'email' ? 'No email on file.' : 'No phone on file.'
        });
    }
    const meta = { userId: row.id };
    otpLib.countRecentSends(db, channel, dest, (cerr, cnt) => {
        if (cerr) return cb(cerr);
        if (cnt >= otpLib.MAX_SENDS_PER_HOUR) {
            return cb(null, { ok: false, status: 429, error: 'Too many OTP requests. Try again later.' });
        }
        const code = otpLib.generateOtpDigits();
        otpLib.saveOtp(db, { channel, destination: dest, purpose: 'login', meta }, code, (serr) => {
            if (serr) return cb(serr);
            const finish = (sent) => {
                const debug = process.env.OTP_RETURN_CODE === '1' || process.env.NODE_ENV === 'development';
                const payload = { ok: true, status: 200, ttlMinutes: otpLib.OTP_TTL_MIN };
                if (debug) payload.debugCode = code;
                if (!sent.ok && !sent.skipped) {
                    payload.ok = false;
                    payload.status = 503;
                    payload.error = sent.error || 'Could not deliver OTP.';
                    if (debug) payload.debugCode = code;
                }
                if (sent.skipped) payload.warning = 'Messaging not fully configured; use debugCode in development.';
                cb(null, payload);
            };
            if (channel === 'phone') {
                notifEngine
                    .sendOtpMessages({ phone: dest, code, db, eventKey: 'OTP_VERIFICATION' })
                    .then((r) => finish(r.whatsapp || { ok: false }));
            } else {
                notifEngine
                    .sendOtpMessages({ email: dest, code, db, eventKey: 'OTP_VERIFICATION' })
                    .then((r) => finish(r.email || { ok: false }));
            }
        });
    });
}

module.exports = { sendLoginOtpsForUser, sendLoginOtpChannel };
