/**
 * VGMF Hall room state. Media bytes stay on this server.
 * The host publishes one program feed. Speakers talk to the host over WebRTC.
 * The audience watches the program feed (HLS when ffmpeg is present, otherwise the same bytes).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const MAX_CHAT = 80;
const MAX_TEXT = 500;
const MAX_CHUNK = 1500000;

function createRoom(seminarId, opts) {
    const options = opts || {};
    return {
        seminarId: Number(seminarId),
        locked: false,
        live: false,
        ended: false,
        waitingRoom: !!options.waitingRoom,
        maxDirect: Number.isInteger(options.maxDirect) ? options.maxDirect : 12,
        directIds: new Set(),
        banned: new Set(options.banned || []),
        clients: new Set(),
        chat: [],
        questions: [],
        hands: new Set(),
        ffmpeg: null,
        hlsReady: false,
        mediaDir: null,
        seq: 0
    };
}

function people(room, forClient) {
    const hostView = forClient && forClient.role === 'host';
    const list = [];
    room.clients.forEach((c) => {
        if (!hostView && c.waiting) return;
        list.push({
            userId: c.userId,
            name: c.name,
            role: c.role,
            waiting: !!c.waiting,
            hand: room.hands.has(c.userId)
        });
    });
    return list;
}

function snapshot(room, client) {
    return {
        type: 'snapshot',
        seminarId: room.seminarId,
        role: client.role,
        live: room.live,
        ended: room.ended,
        locked: room.locked,
        hls: room.hlsReady,
        you: { userId: client.userId, name: client.name, role: client.role, waiting: !!client.waiting },
        people: people(room, client),
        chat: room.chat.slice(-40),
        questions: room.questions.slice(-40)
    };
}

function deliver(client, obj) {
    if (client && typeof client.deliver === 'function') client.deliver(obj);
}

function broadcast(room, obj, except) {
    room.clients.forEach((c) => {
        if (c === except) return;
        if (c.waiting && obj.type !== 'snapshot' && obj.type !== 'admitted' && obj.type !== 'kicked' && obj.type !== 'ended') return;
        deliver(c, obj);
    });
}

function presence(room) {
    room.clients.forEach((c) => deliver(c, { type: 'people', people: people(room, c) }));
}

function cleanText(raw) {
    return String(raw || '')
        .replace(/[\u0000-\u001f]/g, ' ')
        .trim()
        .slice(0, MAX_TEXT);
}

function addClient(room, client) {
    if (room.banned.has(Number(client.userId))) return { ok: false, error: 'You were removed from this hall.' };
    if (room.ended && client.role !== 'host') return { ok: false, error: 'This online seminar has ended.' };
    if (room.locked && client.role !== 'host') return { ok: false, error: 'The host has locked the hall.' };
    room.clients.forEach((existing) => {
        if (Number(existing.userId) === Number(client.userId)) {
            room.clients.delete(existing);
            if (typeof existing.close === 'function') existing.close();
        }
    });
    client.waiting = room.waitingRoom && client.role === 'audience';
    client.chatAt = [];
    room.clients.add(client);
    deliver(client, snapshot(room, client));
    presence(room);
    return { ok: true, waiting: client.waiting };
}

function removeClient(room, client) {
    if (!room.clients.has(client)) return;
    room.clients.delete(client);
    room.directIds.delete(Number(client.userId));
    room.hands.delete(Number(client.userId));
    presence(room);
}

function allowChat(client) {
    const now = Date.now();
    client.chatAt = (client.chatAt || []).filter((t) => now - t < 60000);
    if (client.chatAt.length >= 20) return false;
    client.chatAt.push(now);
    return true;
}

function applyHallMessage(room, client, msg) {
    const type = msg && msg.type;
    if (client.waiting && type !== 'host') {
        return { ok: false, error: 'The host has not admitted you yet.' };
    }
    if (type === 'chat') {
        if (!allowChat(client)) return { ok: false, error: 'Too many messages. Wait a moment.' };
        const text = cleanText(msg.text);
        if (!text) return { ok: false };
        const row = { id: ++room.seq, userId: client.userId, name: client.name, role: client.role, text, at: Date.now() };
        room.chat.push(row);
        if (room.chat.length > MAX_CHAT) room.chat.shift();
        broadcast(room, { type: 'chat', message: row }, client);
        deliver(client, { type: 'chat', message: row });
        return { ok: true };
    }
    if (type === 'question') {
        const text = cleanText(msg.text);
        if (!text) return { ok: false };
        const row = { id: ++room.seq, userId: client.userId, name: client.name, text, at: Date.now(), answered: false };
        room.questions.push(row);
        broadcast(room, { type: 'question', question: row }, client);
        deliver(client, { type: 'question', question: row });
        return { ok: true };
    }
    if (type === 'hand') {
        if (msg.up) room.hands.add(Number(client.userId));
        else room.hands.delete(Number(client.userId));
        presence(room);
        return { ok: true };
    }
    if (type === 'signal') {
        const to = Number(msg.toUserId);
        if (!to) return { ok: false };
        const audienceDirect = client.role === 'audience';
        if (audienceDirect && !room.directIds.has(Number(client.userId)) && room.directIds.size >= room.maxDirect) {
            return { ok: false, error: 'The direct video seats are full. Watch the program feed.' };
        }
        if (audienceDirect) room.directIds.add(Number(client.userId));
        let target = null;
        room.clients.forEach((c) => {
            if (Number(c.userId) === to) target = c;
        });
        if (!target || target.waiting) return { ok: false };
        deliver(target, { type: 'signal', fromUserId: client.userId, fromRole: client.role, payload: msg.payload || null });
        return { ok: true };
    }
    if (type === 'program-mime') {
        if (client.role !== 'host') return { ok: false };
        const mime = String(msg.mime || '').slice(0, 80);
        broadcast(room, { type: 'program-mime', mime: mime });
        deliver(client, { type: 'program-mime', mime: mime });
        return { ok: true };
    }
    if (type === 'feed-restart' || type === 'go-live' || type === 'host') {
        if (client.role !== 'host') return { ok: false, error: 'Only the host can do that.' };
        return applyHost(room, client, type === 'host' ? msg : { action: type === 'go-live' ? 'go-live' : 'feed-restart', userId: msg.userId });
    }
    return { ok: false };
}

function findClient(room, userId) {
    let found = null;
    room.clients.forEach((c) => {
        if (Number(c.userId) === Number(userId)) found = c;
    });
    return found;
}

function applyHost(room, client, msg) {
    const action = String(msg.action || '');
    if (action === 'go-live') {
        room.live = true;
        room.ended = false;
        broadcast(room, { type: 'live', live: true });
        deliver(client, { type: 'live', live: true });
        return { ok: true, effects: ['start-feed'] };
    }
    if (action === 'feed-restart') {
        return { ok: true, effects: ['restart-feed'] };
    }
    if (action === 'end') {
        room.live = false;
        room.ended = true;
        room.clients.forEach((c) => deliver(c, { type: 'ended' }));
        return { ok: true, effects: ['stop-feed'] };
    }
    if (action === 'lock') {
        room.locked = true;
        broadcast(room, { type: 'locked', locked: true });
        return { ok: true };
    }
    if (action === 'unlock') {
        room.locked = false;
        broadcast(room, { type: 'locked', locked: false });
        return { ok: true };
    }
    if (action === 'admit') {
        const target = findClient(room, msg.userId);
        if (!target) return { ok: false, error: 'That person is not in the lobby.' };
        target.waiting = false;
        deliver(target, { type: 'admitted' });
        deliver(target, snapshot(room, target));
        presence(room);
        return { ok: true };
    }
    if (action === 'promote' || action === 'demote') {
        const target = findClient(room, msg.userId);
        if (!target || target.role === 'host') return { ok: false };
        target.role = action === 'promote' ? 'speaker' : 'audience';
        target.waiting = false;
        deliver(target, { type: 'role', role: target.role });
        presence(room);
        return { ok: true };
    }
    if (action === 'kick') {
        const target = findClient(room, msg.userId);
        const uid = Number(msg.userId);
        if (!uid || (target && target.role === 'host')) return { ok: false };
        room.banned.add(uid);
        if (target) {
            deliver(target, { type: 'kicked' });
            room.clients.delete(target);
            if (typeof target.close === 'function') target.close();
        }
        presence(room);
        return { ok: true, effects: ['ban'], userId: uid };
    }
    if (action === 'answer') {
        const q = room.questions.find((row) => Number(row.id) === Number(msg.questionId));
        if (q) q.answered = true;
        broadcast(room, { type: 'question-answered', questionId: msg.questionId });
        return { ok: true };
    }
    return { ok: false, error: 'Unknown host action.' };
}

function hallMediaDir(seminarId) {
    return path.join(os.tmpdir(), 'vgmf-hall', String(Number(seminarId) || 0));
}

function safeMediaName(name) {
    const base = path.basename(String(name || ''));
    if (base === 'live.m3u8' || /^seg\d+\.ts$/.test(base)) return base;
    return '';
}

function ffmpegArgs(dir) {
    return [
        '-hide_banner',
        '-loglevel',
        'error',
        '-fflags',
        '+genpts',
        '-f',
        'webm',
        '-i',
        'pipe:0',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-tune',
        'zerolatency',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-f',
        'hls',
        '-hls_time',
        '2',
        '-hls_list_size',
        '8',
        '-hls_flags',
        'delete_segments+append_list+omit_endlist',
        '-hls_segment_filename',
        path.join(dir, 'seg%d.ts'),
        path.join(dir, 'live.m3u8')
    ];
}

function startFeed(room, bin) {
    stopFeed(room);
    const dir = hallMediaDir(room.seminarId);
    fs.mkdirSync(dir, { recursive: true });
    room.mediaDir = dir;
    room.hlsReady = false;
    let child;
    try {
        child = spawn(bin || 'ffmpeg', ffmpegArgs(dir), { stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (err) {
        room.ffmpeg = null;
        return false;
    }
    child.on('error', () => {
        if (room.ffmpeg === child) room.ffmpeg = null;
    });
    child.on('exit', () => {
        if (room.ffmpeg === child) room.ffmpeg = null;
    });
    room.ffmpeg = child;
    return true;
}

function stopFeed(room) {
    const child = room.ffmpeg;
    room.ffmpeg = null;
    room.hlsReady = false;
    if (child && !child.killed) {
        try {
            child.stdin.end();
        } catch (_) {}
        try {
            child.kill('SIGTERM');
        } catch (_) {}
    }
}

function writeProgramChunk(room, buf) {
    if (!Buffer.isBuffer(buf) || !buf.length || buf.length > MAX_CHUNK) return false;
    if (room.ffmpeg && room.ffmpeg.stdin && room.ffmpeg.stdin.writable) {
        room.ffmpeg.stdin.write(buf);
    }
    room.clients.forEach((c) => {
        if (c.role === 'host' || c.waiting) return;
        if (typeof c.deliverBinary === 'function') c.deliverBinary(buf);
    });
    return true;
}

function noteHlsReady(room) {
    if (room.hlsReady) return false;
    const file = room.mediaDir && path.join(room.mediaDir, 'live.m3u8');
    if (!file || !fs.existsSync(file)) return false;
    room.hlsReady = true;
    broadcast(room, { type: 'playback', hls: true });
    room.clients.forEach((c) => deliver(c, { type: 'playback', hls: true }));
    return true;
}

module.exports = {
    createRoom,
    addClient,
    removeClient,
    applyHallMessage,
    snapshot,
    hallMediaDir,
    safeMediaName,
    ffmpegArgs,
    startFeed,
    stopFeed,
    writeProgramChunk,
    noteHlsReady,
    cleanText
};
