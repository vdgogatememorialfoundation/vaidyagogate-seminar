/**
 * OTP resend cooldown UI — 1 min wait, show remaining resends.
 */
(function (global) {
    const timers = {};

    function formatWait(sec) {
        const s = Math.max(0, parseInt(sec, 10) || 0);
        const m = Math.floor(s / 60);
        const r = s % 60;
        return m > 0 ? m + ':' + String(r).padStart(2, '0') : String(r) + 's';
    }

    function startResendCooldown(buttonIds, seconds, opts) {
        const ids = Array.isArray(buttonIds) ? buttonIds : [buttonIds];
        const sec = Math.max(1, parseInt(seconds, 10) || 60);
        const o = opts || {};
        const remaining = o.resendsRemaining;
        const key = ids.join('|');

        ids.forEach(function (id) {
            const btn = document.getElementById(id);
            if (!btn) return;
            btn.disabled = true;
            const base = btn.getAttribute('data-otp-label') || btn.textContent.trim() || 'Resend';
            btn.setAttribute('data-otp-label', base);
            let left = sec;
            const tick = function () {
                let suffix = ' (' + formatWait(left) + ')';
                if (remaining != null) suffix += ' · ' + remaining + ' left';
                btn.textContent = base + suffix;
                if (left <= 0) {
                    btn.disabled = false;
                    btn.textContent = base;
                    if (timers[key]) clearInterval(timers[key]);
                    delete timers[key];
                    return;
                }
                left--;
            };
            tick();
            if (timers[key]) clearInterval(timers[key]);
            timers[key] = setInterval(tick, 1000);
        });
    }

    function applyOtpSendResponse(channel, data, buttonIds) {
        if (!data || !data.success) return;
        const ids =
            buttonIds ||
            (channel === 'email'
                ? [
                      'doctor-signup-resend-otp-email',
                      'signup-resend-email-otp',
                      'signup-send-email-otp'
                  ]
                : [
                      'doctor-signup-resend-otp-phone',
                      'signup-resend-phone-otp',
                      'signup-send-phone-otp'
                  ]);
        startResendCooldown(ids, data.cooldownSeconds || 60, {
            resendsRemaining: data.resendsRemaining
        });
    }

    function notifyOtpSent(channel, data, options) {
        const opts = options || {};
        let msg = opts.customMessage;
        if (!msg) {
            if (opts.both) {
                msg = 'OTP sent successfully to your email and WhatsApp.';
            } else {
                msg =
                    'OTP sent successfully to your ' +
                    (channel === 'email' ? 'email' : channel === 'phone' ? 'WhatsApp' : channel || 'contact') +
                    '.';
            }
        }
        if (data && data.resendsRemaining != null) {
            msg += ' (' + data.resendsRemaining + ' resend' + (data.resendsRemaining === 1 ? '' : 's') + ' left this hour)';
        }
        if (data && data.warning) {
            alert(data.warning + '\n\n' + msg);
        } else {
            alert(msg);
        }
        if (data && data.success && (opts.purpose === 'signup' || opts.signupCooldown)) {
            applyOtpSendResponse(channel, data, opts.resendButtonIds);
        }
    }

    global.OtpUi = {
        channelLabel: function (channel) {
            if (channel === 'email') return 'email';
            if (channel === 'phone') return 'WhatsApp';
            return String(channel || '').trim();
        },
        notifyOtpSent: notifyOtpSent,
        startResendCooldown: startResendCooldown,
        applyOtpSendResponse: applyOtpSendResponse
    };
})(typeof window !== 'undefined' ? window : global);
