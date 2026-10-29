/**
 * Pushes a delivery rider's position to open tracking pages.
 * Small GPS jitter is not sent. A real move is.
 */
const crypto = require('crypto');
const { URL } = require('url');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PATH = '/api/public/commerce/rider-live';
const TRACK_PATH = '/api/public/commerce/track-live';
const STILL_M = 18;
const rooms = new Map();
const trackRooms = new Map();

function haversine(a, b) {
    if (!a || !b) return Infinity;
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const s =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function sendFrame(socket, opcode, payload) {
    if (!socket || socket.destroyed) return;
    const data = payload ? Buffer.from(payload) : Buffer.alloc(0);
    const len = data.length;
    let header;
    if (len < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x80 | opcode;
        header[1] = len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        return;
    }
    try {
        socket.write(Buffer.concat([header, data]));
    } catch (e) {}
}

function sendText(socket, text) {
    sendFrame(socket, 0x1, Buffer.from(String(text)));
}

function consumeFrames(socket, chunk, state) {
    state.buf = state.buf.length ? Buffer.concat([state.buf, chunk]) : chunk;
    while (state.buf.length >= 2) {
        const b1 = state.buf[1];
        let len = b1 & 0x7f;
        let offset = 2;
        if (len === 126) {
            if (state.buf.length < 4) return;
            len = state.buf.readUInt16BE(2);
            offset = 4;
        } else if (len === 127) {
            socket.destroy();
            return;
        }
        if (len > 65536) {
            socket.destroy();
            return;
        }
        const masked = (b1 & 0x80) !== 0;
        const maskLen = masked ? 4 : 0;
        if (state.buf.length < offset + maskLen + len) return;
        const opcode = state.buf[0] & 0x0f;
        let payload = state.buf.subarray(offset + maskLen, offset + maskLen + len);
        if (masked) {
            const mask = state.buf.subarray(offset, offset + 4);
            payload = Buffer.from(payload);
            for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        }
        state.buf = state.buf.subarray(offset + maskLen + len);
        if (opcode === 0x8) {
            sendFrame(socket, 0x8, payload);
            socket.end();
            return;
        }
        if (opcode === 0x9) sendFrame(socket, 0xa, payload);
    }
}

function payloadFor(sample, prev) {
    const agent = sample && sample.agent;
    const leg = (sample && sample.leg) || 'preview';
    if (!agent) {
        if (prev && prev.agent) return { type: 'rider', leg: leg, agent: null };
        return null;
    }
    const moved = !!(prev && prev.agent && haversine(prev.agent, agent) >= STILL_M);
    const legChanged = !!(prev && prev.leg && prev.leg !== leg);
    if (prev && prev.agent && !moved && !legChanged) return null;
    return { type: 'rider', leg: leg, agent: { lat: agent.lat, lng: agent.lng } };
}

function broadcast(room, body) {
    const text = JSON.stringify(body);
    room.sockets.forEach((socket) => sendText(socket, text));
}

function tick(room, sample) {
    if (room.inflight || !room.sockets.size) return;
    room.inflight = true;
    sample(room.token, (err, row) => {
        room.inflight = false;
        if (!room.sockets.size) return;
        if (err) return;
        if (!row) {
            broadcast(room, { type: 'error' });
            clearInterval(room.timer);
            rooms.delete(room.token);
            room.sockets.forEach((socket) => {
                try { socket.end(); } catch (e) {}
            });
            room.sockets.clear();
            return;
        }
        const body = payloadFor(row, room.last);
        if (!body) return;
        room.last = { agent: body.agent, leg: body.leg };
        broadcast(room, body);
    });
}

function join(socket, token, sample, intervalMs) {
    let room = rooms.get(token);
    if (!room) {
        room = { token: token, sockets: new Set(), timer: null, inflight: false, last: null };
        room.timer = setInterval(() => tick(room, sample), intervalMs);
        if (room.timer.unref) room.timer.unref();
        rooms.set(token, room);
    }
    if (room.sockets.size >= 30) {
        socket.destroy();
        return;
    }
    room.sockets.add(socket);
    if (room.last) sendText(socket, JSON.stringify({ type: 'rider', leg: room.last.leg, agent: room.last.agent }));
    tick(room, sample);
    const leave = () => {
        if (!room.sockets.has(socket)) return;
        room.sockets.delete(socket);
        if (!room.sockets.size) {
            clearInterval(room.timer);
            rooms.delete(token);
        }
    };
    return leave;
}

function snapshotSig(body) {
    if (!body || typeof body !== 'object') return '';
    const copy = {};
    Object.keys(body).forEach((key) => {
        if (key === 'at') return;
        copy[key] = body[key];
    });
    return JSON.stringify(copy);
}

function tickTrack(room, sample) {
    if (room.inflight || !room.sockets.size) return;
    room.inflight = true;
    sample(room.token, (err, row) => {
        room.inflight = false;
        if (!room.sockets.size) return;
        if (err) return;
        if (!row) return;
        const body = Object.assign({ type: 'track', source: 'poll' }, row);
        const sig = snapshotSig(body);
        if (sig === room.sig) return;
        room.sig = sig;
        room.last = body;
        broadcast(room, body);
    });
}

function joinTrack(socket, token, sample, intervalMs) {
    let room = trackRooms.get(token);
    if (!room) {
        room = { token: token, sockets: new Set(), timer: null, inflight: false, last: null, sig: '' };
        room.timer = setInterval(() => tickTrack(room, sample), intervalMs);
        if (room.timer.unref) room.timer.unref();
        trackRooms.set(token, room);
    }
    if (room.sockets.size >= 30) {
        socket.destroy();
        return null;
    }
    room.sockets.add(socket);
    if (room.last) sendText(socket, JSON.stringify(room.last));
    tickTrack(room, sample);
    return () => {
        if (!room.sockets.has(socket)) return;
        room.sockets.delete(socket);
        if (!room.sockets.size) {
            clearInterval(room.timer);
            trackRooms.delete(token);
        }
    };
}

function publishTrack(token, body) {
    const key = String(token || '').trim();
    const room = trackRooms.get(key);
    if (!room || !room.sockets.size) return false;
    const msg = Object.assign({ type: 'track', source: 'webhook' }, body || {});
    room.last = msg;
    room.sig = snapshotSig(msg);
    broadcast(room, msg);
    return true;
}

function attach(httpServer, db, opts) {
    if (!httpServer || httpServer.__riderLive) return;
    httpServer.__riderLive = true;
    const intervalMs = (opts && opts.intervalMs) || 6000;
    const sample =
        opts && typeof opts.sample === 'function'
            ? opts.sample
            : (token, cb) => require('./commerce-routes').sampleRider(db, token, cb);
    const sampleTrack =
        opts && typeof opts.sampleTrack === 'function'
            ? opts.sampleTrack
            : (token, cb) => require('./commerce-routes').sampleTrack(db, token, cb);
    const trackInterval = (opts && opts.trackIntervalMs) || 8000;
    httpServer.on('upgrade', (req, socket, head) => {
        let url;
        try {
            url = new URL(req.url, 'http://localhost');
        } catch (e) {
            socket.destroy();
            return;
        }
        const riderLive = url.pathname === PATH;
        const trackLive = url.pathname === TRACK_PATH;
        if (!riderLive && !trackLive) {
            socket.destroy();
            return;
        }
        const token = String(url.searchParams.get('token') || '').trim();
        const key = req.headers['sec-websocket-key'];
        if (!key || token.length < 8 || token.length > 200 || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
            socket.destroy();
            return;
        }
        const accept = crypto.createHash('sha1').update(String(key) + GUID).digest('base64');
        socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
                'Upgrade: websocket\r\n' +
                'Connection: Upgrade\r\n' +
                'Sec-WebSocket-Accept: ' +
                accept +
                '\r\n\r\n'
        );
        const state = { buf: Buffer.alloc(0) };
        const leave = riderLive
            ? join(socket, token, sample, intervalMs)
            : joinTrack(socket, token, sampleTrack, trackInterval);
        const ping = setInterval(() => sendFrame(socket, 0x9, Buffer.from('p')), 25000);
        if (ping.unref) ping.unref();
        const done = () => {
            clearInterval(ping);
            if (leave) leave();
        };
        if (head && head.length) consumeFrames(socket, head, state);
        socket.on('data', (chunk) => consumeFrames(socket, chunk, state));
        socket.on('close', done);
        socket.on('error', done);
    });
    console.log('[rider-live] websocket on ' + PATH);
    console.log('[track-live] websocket on ' + TRACK_PATH);
}

module.exports = { attach, payloadFor, haversine, STILL_M, PATH, TRACK_PATH, publishTrack };
