/**
 * Every outbound message replies to the foundation care inboxes.
 * A noreply From address is not a reply destination.
 * An explicit mailbox (support-ticket plus-address, case thread) stays first,
 * and the care inboxes are included as well.
 */
const CARE_INBOXES = ['care@vaidyagogate.org', 'vd.gogatememorialfoundation@gmail.com'];

function splitAddresses(value) {
    if (Array.isArray(value)) return value.flatMap(splitAddresses);
    return String(value || '')
        .split(/[;,]/)
        .map((part) => part.trim())
        .filter((part) => part.includes('@'));
}

function replyAddresses(explicit) {
    const given = splitAddresses(explicit);
    const noreplyOnly = !given.length || given.every((address) => /noreply@/i.test(address));
    const out = [];
    const add = (address) => {
        if (!out.some((have) => have.toLowerCase() === address.toLowerCase())) out.push(address);
    };
    if (noreplyOnly) {
        CARE_INBOXES.forEach(add);
        return out;
    }
    given.forEach(add);
    CARE_INBOXES.forEach(add);
    return out;
}

function withDefaultReplyTo(opts) {
    const next = Object.assign({}, opts || {});
    next.replyToList = replyAddresses(next.replyTo);
    next.replyTo = next.replyToList.join(', ');
    return next;
}

module.exports = {
    CARE_INBOXES,
    replyAddresses,
    withDefaultReplyTo
};
