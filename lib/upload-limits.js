/** Platform-aware upload size caps (Vercel serverless ~4.5 MB body limit). */

const HOST_CAP_MB = process.env.VERCEL ? 4 : 200;

function getHostMaxBytes() {
    return HOST_CAP_MB * 1024 * 1024;
}

function getEffectiveMaxFileMb(programMaxMb) {
    const requested = Math.max(1, parseInt(programMaxMb, 10) || 50);
    return Math.min(requested, HOST_CAP_MB);
}

function getEffectiveMaxFileBytes(programMaxMb) {
    return getEffectiveMaxFileMb(programMaxMb) * 1024 * 1024;
}

module.exports = {
    HOST_CAP_MB,
    getHostMaxBytes,
    getEffectiveMaxFileMb,
    getEffectiveMaxFileBytes
};
