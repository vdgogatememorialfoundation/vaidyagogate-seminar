/**
 * Consistent success popup when OTP is sent.
 */
(function (global) {
    function channelLabel(channel) {
        if (channel === 'email') return 'email';
        if (channel === 'phone') return 'WhatsApp';
        return String(channel || '').trim();
    }

    /**
     * @param {string} channel - 'email' | 'phone'
     * @param {object} [data] - API response (optional warning)
     * @param {{ both?: boolean, customMessage?: string }} [options]
     */
    function notifyOtpSent(channel, data, options) {
        const opts = options || {};
        let msg = opts.customMessage;
        if (!msg) {
            if (opts.both) {
                msg = 'OTP sent successfully to your email and WhatsApp.';
            } else {
                msg = 'OTP sent successfully to your ' + channelLabel(channel) + '.';
            }
        }
        if (data && data.warning) {
            alert(data.warning + '\n\n' + msg);
        } else {
            alert(msg);
        }
    }

    global.OtpUi = {
        channelLabel,
        notifyOtpSent
    };
})(typeof window !== 'undefined' ? window : global);
