/**
 * Seminar / portal datetimes are stored and shown in India Standard Time (IST).
 * datetime-local inputs are interpreted as IST wall clock, not UTC.
 */
const IST = 'Asia/Kolkata';
const IST_OFFSET = '+05:30';

function parseSeminarDateTime(val) {
    if (val == null || val === '') return null;
    const s = String(val).trim();
    if (!s) return null;
    if (/Z$|[+-]\d{2}(:?\d{2})?$/i.test(s)) {
        const d = new Date(s);
        return Number.isNaN(d.getTime()) ? null : d;
    }
    let norm = s.includes('T') ? s : s.replace(' ', 'T');
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(norm)) norm += ':00';
    const d = new Date(norm + IST_OFFSET);
    return Number.isNaN(d.getTime()) ? null : d;
}

function parseSeminarMs(val) {
    const d = parseSeminarDateTime(val);
    return d ? d.getTime() : null;
}

function partsInIst(d) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: IST,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).formatToParts(d);
    const get = (t) => (parts.find((p) => p.type === t) || {}).value || '00';
    return get;
}

function normalizeSeminarDateTimeForStorage(val) {
    if (val == null || val === '') return null;
    const d = parseSeminarDateTime(val);
    if (!d) return String(val).trim();
    const g = partsInIst(d);
    return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}${IST_OFFSET}`;
}

/** datetime-local value (YYYY-MM-DDTHH:mm) → stored IST ISO */
function fromDatetimeLocalInput(localStr) {
    if (!localStr) return null;
    const s = String(localStr).trim();
    if (!s) return null;
    if (/Z$|[+-]\d{2}/i.test(s)) return normalizeSeminarDateTimeForStorage(s);
    const norm = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) ? s + ':00' : s;
    return norm + IST_OFFSET;
}

/** stored value → datetime-local in IST */
function toDatetimeLocalInput(stored) {
    const d = parseSeminarDateTime(stored);
    if (!d) return '';
    const g = partsInIst(d);
    return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`;
}

function formatSeminarDateTime(val, opts) {
    const d = parseSeminarDateTime(val);
    if (!d) return val ? String(val) : '';
    const base = {
        timeZone: IST,
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
    };
    return d.toLocaleString('en-IN', Object.assign(base, opts || {}));
}

function formatSeminarDateTimeLong(val) {
    const d = parseSeminarDateTime(val);
    if (!d) return val ? String(val) : '';
    return d.toLocaleString('en-IN', {
        timeZone: IST,
        weekday: 'long',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
    });
}

module.exports = {
    IST,
    IST_OFFSET,
    parseSeminarDateTime,
    parseSeminarMs,
    normalizeSeminarDateTimeForStorage,
    fromDatetimeLocalInput,
    toDatetimeLocalInput,
    formatSeminarDateTime,
    formatSeminarDateTimeLong
};
