/**
 * Judge marking deadline helpers (IST-normalized datetimes on case_submissions).
 */
const seminarDt = require('./seminar-datetime');

function parseDeadlineMs(val) {
    return seminarDt.parseSeminarMs(val);
}

function isMarkingDeadlinePassed(deadlineVal, nowMs) {
    const ms = parseDeadlineMs(deadlineVal);
    if (ms == null) return false;
    const now = nowMs != null ? nowMs : Date.now();
    return now > ms;
}

function normalizeMarkingDeadlineInput(val) {
    if (val == null || String(val).trim() === '') return null;
    return seminarDt.normalizeSeminarDateTimeForStorage(val);
}

function formatMarkingDeadlineDisplay(val) {
    if (!val) return '';
    return seminarDt.formatSeminarDateTime(val, { withTime: true }) || String(val);
}

function msUntilDeadline(deadlineVal) {
    const ms = parseDeadlineMs(deadlineVal);
    if (ms == null) return null;
    return ms - Date.now();
}

module.exports = {
    parseDeadlineMs,
    isMarkingDeadlinePassed,
    normalizeMarkingDeadlineInput,
    formatMarkingDeadlineDisplay,
    msUntilDeadline
};
