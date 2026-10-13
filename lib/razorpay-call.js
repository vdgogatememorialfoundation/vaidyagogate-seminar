'use strict';

/**
 * The razorpay SDK (>= 2.9) returns a promise and never invokes a trailing
 * callback; older versions only invoke the callback. Run `invoke(next)` and
 * settle `cb` exactly once from whichever fires.
 */
function rzCall(invoke, cb) {
    let done = false;
    const finish = (err, out) => {
        if (done) return;
        done = true;
        cb(err, out);
    };
    try {
        const ret = invoke((err, out) => finish(err, out));
        if (ret && typeof ret.then === 'function') {
            ret.then((out) => finish(null, out)).catch((err) => finish(err));
        }
    } catch (e) {
        finish(e);
    }
}

module.exports = { rzCall };
