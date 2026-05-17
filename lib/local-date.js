const DEFAULT_CHECKIN_TZ = process.env.CHECKIN_TIMEZONE || 'Asia/Kolkata';

/** Calendar date YYYY-MM-DD in the given IANA timezone (scanner check-in on Vercel UTC). */
function localDateYmd(d, timeZone) {
    const x = d instanceof Date ? d : new Date();
    const tz = timeZone || DEFAULT_CHECKIN_TZ;
    try {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: tz,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).format(x);
    } catch (_) {
        const y = x.getFullYear();
        const m = String(x.getMonth() + 1).padStart(2, '0');
        const day = String(x.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }
}

/** Normalize seminar check-in / event DATE values from PG, SQLite, or JSON (no UTC day shift). */
function normalizeCheckinDateYmd(value) {
    if (value == null || value === '') return '';
    const raw = String(value).trim();
    if (!raw) return '';

    const dateOnly = raw.match(/^(\d{4}-\d{2}-\d{2})$/);
    if (dateOnly) return dateOnly[1];

    const isoPrefix = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    if (isoPrefix && !/T/.test(raw)) return isoPrefix[1];

    const asDate = value instanceof Date ? value : new Date(raw);
    if (!Number.isNaN(asDate.getTime())) {
        return localDateYmd(asDate);
    }

    return isoPrefix ? isoPrefix[1] : '';
}

function normalizeCheckinDateForStorage(value) {
    const ymd = normalizeCheckinDateYmd(value);
    return ymd || null;
}

function ymdToUtcDay(ymd) {
    const p = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!p) return NaN;
    return Date.UTC(parseInt(p[1], 10), parseInt(p[2], 10) - 1, parseInt(p[3], 10));
}

/** Days between two YYYY-MM-DD strings (calendar days, not clock time). */
function dayDiffYmd(a, b) {
    const ta = ymdToUtcDay(a);
    const tb = ymdToUtcDay(b);
    if (Number.isNaN(ta) || Number.isNaN(tb)) return NaN;
    return Math.round((ta - tb) / 86400000);
}

/**
 * Compare seminar check-in date to today in CHECKIN_TIMEZONE (default Asia/Kolkata).
 * Empty check-in date = any day. Optional ±1 day grace for timezone/storage edge cases.
 */
function isCheckinDateToday(checkinDateStr, options) {
    const opts = options || {};
    if (!checkinDateStr || String(checkinDateStr).trim() === '') return true;
    const expected = normalizeCheckinDateYmd(checkinDateStr);
    if (!expected) return true;
    const today = localDateYmd();
    if (expected === today) return true;
    if (opts.allowGraceDay !== false) {
        const diff = dayDiffYmd(expected, today);
        if (diff === 1 || diff === -1) return true;
    }
    return false;
}

function isSeminarCheckinEnabled(seminarRow) {
    const v = seminarRow && seminarRow.checkin_enabled;
    if (v === true || v === 1 || v === '1') return true;
    if (v === false || v === 0 || v === '0' || v == null || v === '') return false;
    return Number(v) === 1;
}

/** Check-in allowed when enabled and date is today (IST), blank (any day), or matches event day today. */
/** True when seminar event_date is in the past (IST-aware; uses time when present). */
function isSeminarEnded(eventDateStr, nowMs) {
    if (eventDateStr == null || String(eventDateStr).trim() === '') return false;
    const now = nowMs != null ? nowMs : Date.now();
    try {
        const seminarDt = require('./seminar-datetime');
        const ms = seminarDt.parseSeminarMs(eventDateStr);
        if (ms != null) return now > ms;
    } catch (_) {
        /* fall through to calendar-day compare */
    }
    const eventYmd = normalizeCheckinDateYmd(eventDateStr);
    if (!eventYmd) return false;
    const today = localDateYmd(new Date(now));
    return dayDiffYmd(eventYmd, today) < 0;
}

function isCheckinOpenForSeminar(seminarRow) {
    if (!seminarRow || !isSeminarCheckinEnabled(seminarRow)) return false;
    const checkinYmd = normalizeCheckinDateYmd(seminarRow.checkin_date);
    if (!checkinYmd) return true;
    if (isCheckinDateToday(checkinYmd, { allowGraceDay: true })) return true;
    const eventYmd = normalizeCheckinDateYmd(seminarRow.event_date);
    const today = localDateYmd();
    if (eventYmd && eventYmd === today && checkinYmd === eventYmd) return true;
    return false;
}

module.exports = {
    localDateYmd,
    normalizeCheckinDateYmd,
    normalizeCheckinDateForStorage,
    isCheckinDateToday,
    isSeminarEnded,
    isCheckinOpenForSeminar,
    isSeminarCheckinEnabled,
    dayDiffYmd,
    DEFAULT_CHECKIN_TZ
};
