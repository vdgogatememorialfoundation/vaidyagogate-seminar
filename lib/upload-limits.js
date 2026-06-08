/** Platform-aware upload size caps for case presentation files. */

const r2Storage = require('./r2-storage');

const LEGACY_BODY_CAP_MB = 4;
/** Case presentation uploads without R2 (CV, video) — matches competition rules. */
const CASE_HOST_CAP_MB = 50;
const R2_DEFAULT_MB = 100;
const R2_MAX_MB = 250;
const ABSOLUTE_MAX_BYTES = R2_MAX_MB * 1024 * 1024;
const HARD_REJECT_BYTES = 1024 * 1024 * 1024;

function isR2Mode() {
    return r2Storage.isR2ReadySync();
}

function isR2Operational() {
    return r2Storage.isR2ReadySync();
}

function getHostMaxBytes(r2On) {
    const useR2 = r2On !== undefined ? !!r2On : isR2Operational();
    if (useR2) return ABSOLUTE_MAX_BYTES;
    return 200 * 1024 * 1024;
}

function clampProgramMaxMb(programMaxMb, r2On) {
    const useR2 = r2On !== undefined ? !!r2On : isR2Operational();
    const requested = Math.max(1, parseInt(programMaxMb, 10) || (useR2 ? R2_DEFAULT_MB : 50));
    if (useR2) return Math.min(requested, R2_MAX_MB);
    return Math.min(requested, 200);
}

function getEffectiveMaxFileMb(programMaxMb, r2On) {
    return clampProgramMaxMb(programMaxMb, r2On);
}

function getEffectiveMaxFileBytes(programMaxMb, r2On) {
    return getEffectiveMaxFileMb(programMaxMb, r2On) * 1024 * 1024;
}

function validateFileSizeBytes(sizeBytes, programMaxMb, r2On) {
    const size = Number(sizeBytes) || 0;
    if (size < 1) return { ok: false, error: 'File is empty.' };
    if (size > HARD_REJECT_BYTES) {
        return { ok: false, error: 'Files over 1 GB are not allowed. Split or compress your submission.' };
    }
    const useR2 = r2On !== undefined ? !!r2On : isR2Operational();
    const maxBytes = getEffectiveMaxFileBytes(programMaxMb, useR2);
    const maxMb = getEffectiveMaxFileMb(programMaxMb, useR2);
    if (size > maxBytes) {
        const hint = useR2
            ? ` Maximum ${maxMb} MB per file for this program.`
            : ` Maximum ${maxMb} MB per file — enable R2 storage for large uploads.`;
        return { ok: false, error: `File is too large (${Math.ceil(size / (1024 * 1024))} MB).${hint}` };
    }
    return { ok: true, maxMb, maxBytes };
}

function getCaseHostMaxBytes() {
    return CASE_HOST_CAP_MB * 1024 * 1024;
}

function getServerProxyMaxMb() {
    return 100;
}

function uploadConfigForClient(programMaxMb, r2EnabledOverride) {
    const serverProxyMaxMb = getServerProxyMaxMb();
    const r2On =
        r2EnabledOverride !== undefined && r2EnabledOverride !== null
            ? !!r2EnabledOverride
            : isR2Operational();
    return {
        r2Enabled: r2On,
        defaultMaxMb: r2On ? R2_DEFAULT_MB : 50,
        platformMaxMb: r2On ? R2_MAX_MB : 200,
        effectiveMaxMb: getEffectiveMaxFileMb(programMaxMb, r2On),
        serverProxyMaxMb,
        serverProxyEnabled: r2On,
        multipartThresholdMb: Math.round(r2Storage.MULTIPART_THRESHOLD_BYTES / (1024 * 1024)),
        partSizeMb: Math.round(r2Storage.PART_SIZE_BYTES / (1024 * 1024)),
        absoluteMaxMb: R2_MAX_MB,
        r2SetupError: r2On ? null : r2Storage.isR2Configured() ? r2Storage.getR2SetupHint() : null
    };
}

module.exports = {
    LEGACY_BODY_CAP_MB,
    CASE_HOST_CAP_MB,
    getCaseHostMaxBytes,
    R2_DEFAULT_MB,
    R2_MAX_MB,
    ABSOLUTE_MAX_BYTES,
    isR2Mode,
    isR2Operational,
    getHostMaxBytes,
    clampProgramMaxMb,
    getEffectiveMaxFileMb,
    getEffectiveMaxFileBytes,
    validateFileSizeBytes,
    uploadConfigForClient,
    getServerProxyMaxMb
};
