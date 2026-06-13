/**
 * In-memory hub for admin live-radar SSE subscribers.
 */
const subscribers = new Set();

function subscribe(res) {
    subscribers.add(res);
    res.on('close', () => subscribers.delete(res));
    res.on('error', () => subscribers.delete(res));
}

function broadcast(payload) {
    if (!subscribers.size) return;
    const line = 'data: ' + JSON.stringify(payload) + '\n\n';
    subscribers.forEach((res) => {
        try {
            res.write(line);
        } catch (_) {
            subscribers.delete(res);
        }
    });
}

function subscriberCount() {
    return subscribers.size;
}

module.exports = {
    subscribe,
    broadcast,
    subscriberCount
};
