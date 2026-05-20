/** Platform-aware upload size caps for case presentation files. */

const r2Storage = require('./r2-storage');

const VERCEL_BODY_CAP_MB = 4;
const R2_DEFAULT_MB = 100;
const R2_MAX_MB = 250;
const ABSOLUTE_MAX_BYTES = R2_MAX_MB * 1024 * 1024;
const HARD_REJECT_BYTES = 1024 * 1024 * 1024;

function isR2Mode() {
    return r2Storage.isR2Configured();
}

function getHostMaxBytes() {
    if (isR2Mode()) return ABSOLUTE_MAX_BYTES;
    return (process.env.VERCEL ? VERCEL_BODY_CAP_MB : 200) * 1024 * 1024;
}

function clampProgramMaxMb(programMaxMb) {
    const requested = Math.max(1, parseInt(programMaxMb, 10) || (isR2Mode() ? R2_DEFAULT_MB : 50));
    if (isR2Mode()) return Math.min(requested, R2_MAX_MB);
    const hostCap = process.env.VERCEL ? VERCEL_BODY_CAP_MB : 200;
    return Math.min(requested, hostCap);
}

function getEffectiveMaxFileMb(programMaxMb) {
    return clampProgramMaxMb(programMaxMb);
}

function getEffectiveMaxFileBytes(programMaxMb) {
    return getEffectiveMaxFileMb(programMaxMb) * 1024 * 1024;
}

function validateFileSizeBytes(sizeBytes, programMaxMb) {
    const size = Number(sizeBytes) || 0;
    if (size < 1) return { ok: false, error: 'File is empty.' };
    if (size > HARD_REJECT_BYTES) {
        return { ok: false, error: 'Files over 1 GB are not allowed. Split or compress your submission.' };
    }
    const maxBytes = getEffectiveMaxFileBytes(programMaxMb);
    const maxMb = getEffectiveMaxFileMb(programMaxMb);
    if (size > maxBytes) {
        const hint = isR2Mode()
            ? ` Maximum ${maxMb} MB per file for this program.`
            : process.env.VERCEL
              ? ' Server limit is 4 MB per file on this hosting tier — enable R2 storage or compress the file.'
              : ` Maximum ${maxMb} MB per file.`;
        return { ok: false, error: `File is too large (${Math.ceil(size / (1024 * 1024))} MB).${hint}` };
    }
    return { ok: true, maxMb, maxBytes };
}

function uploadConfigForClient(programMaxMb) {
    return {
        r2Enabled: isR2Mode(),
        defaultMaxMb: isR2Mode() ? R2_DEFAULT_MB : process.env.VERCEL ? VERCEL_BODY_CAP_MB : 50,
        platformMaxMb: isR2Mode() ? R2_MAX_MB : process.env.VERCEL ? VERCEL_BODY_CAP_MB : 200,
        effectiveMaxMb: getEffectiveMaxFileMb(programMaxMb),
        multipartThresholdMb: Math.round(r2Storage.MULTIPART_THRESHOLD_BYTES / (1024 * 1024)),
        partSizeMb: Math.round(r2Storage.PART_SIZE_BYTES / (1024 * 1024)),
        absoluteMaxMb: R2_MAX_MB
    };
}

module.exports = {
    VERCEL_BODY_CAP_MB,
    R2_DEFAULT_MB,
    R2_MAX_MB,
    ABSOLUTE_MAX_BYTES,
    isR2Mode,
    getHostMaxBytes,
    clampProgramMaxMb,
    getEffectiveMaxFileMb,
    getEffectiveMaxFileBytes,
    validateFileSizeBytes,
    uploadConfigForClient
};
