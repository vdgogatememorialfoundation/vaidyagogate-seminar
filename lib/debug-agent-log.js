/**
 * Debug session a89a58 — NDJSON to workspace log + optional ingest.
 */
const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, '..', 'debug-a89a58.log');
const INGEST = 'http://127.0.0.1:7809/ingest/8d7053de-ce1e-4259-8bca-3c6a3d14c29d';
const SESSION = 'a89a58';

function agentLog(location, message, data, hypothesisId, runId) {
    const payload = {
        sessionId: SESSION,
        location,
        message,
        data: data || {},
        hypothesisId: hypothesisId || '',
        runId: runId || process.env.DEBUG_RUN_ID || 'run',
        timestamp: Date.now()
    };
    try {
        fs.appendFileSync(LOG_PATH, JSON.stringify(payload) + '\n');
    } catch (_) {}
    if (process.env.VERCEL) {
        try {
            console.log('[debug-a89a58]', JSON.stringify(payload));
        } catch (_) {}
    }
    try {
        if (typeof fetch === 'function') {
            fetch(INGEST, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': SESSION },
                body: JSON.stringify(payload)
            }).catch(() => {});
        }
    } catch (_) {}
}

module.exports = { agentLog, LOG_PATH };
