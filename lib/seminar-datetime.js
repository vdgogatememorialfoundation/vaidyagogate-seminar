/**
 * Seminar / portal datetimes are stored and shown in India Standard Time (IST).
 * datetime-local inputs are interpreted as IST wall clock, not UTC.
 */
const IST = 'Asia/Kolkata';
const IST_OFFSET = '+05:30';

function parseSeminarDateTime(val) {
    if (val == null || val === '') return null;
    if (val instanceof Date) return Number.isNaN(val.getTime()) ? null : val;
    const s = String(val).trim();
    if (!s) return null;
    if (/Z$|[+-]\d{2}(:?\d{2})?$/i.test(s)) {
        const d = new Date(s);
        return Number.isNaN(d.getTime()) ? null : d;
    }
    let norm = s.includes('T') ? s : s.replace(' ', 'T');
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(norm)) norm += ':00';
    // Naive values without offset: IST wall clock (datetime-local and event schedules).
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

/** Registration close time is inclusive for the full minute (e.g. 15:48 means open until 15:48:59 IST). */
function normalizeSeminarRegistrationEndForStorage(localStr) {
    const base = fromDatetimeLocalInput(localStr);
    if (!base) return null;
    const d = parseSeminarDateTime(base);
    if (!d) return base;
    const g = partsInIst(d);
    return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:59${IST_OFFSET}`;
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

/**
 * E-ticket: format using IST wall clock (same as admin datetime-local), not UTC-shifted display.
 * Returns { date, time } where time is null for midnight events.
 */
function formatSeminarDateForTicket(val) {
    const local = toDatetimeLocalInput(val);
    if (!local) return { date: val ? String(val).trim() : '', time: null };
    const [datePart, timePart] = local.split('T');
    const anchor = parseSeminarDateTime(`${datePart}T12:00:00${IST_OFFSET}`);
    const dateLine = anchor
        ? anchor.toLocaleDateString('en-IN', {
              timeZone: IST,
              weekday: 'long',
              day: 'numeric',
              month: 'long',
              year: 'numeric'
          })
        : datePart;
    const [hh, mm] = (timePart || '00:00').split(':').map((x) => parseInt(x, 10) || 0);
    if (hh === 0 && mm === 0) return { date: dateLine, time: null };
    const raw = String(val).trim();
    const storedAsUtc = /Z$/i.test(raw) || /[+-]00:00$/i.test(raw);
    if (storedAsUtc && hh > 0 && hh < 3) return { date: dateLine, time: null };
    const h12 = hh % 12 || 12;
    const ampm = hh >= 12 ? 'pm' : 'am';
    const timeLine = `${h12}:${String(mm).padStart(2, '0')} ${ampm} IST`;
    return { date: dateLine, time: timeLine };
}

function formatSeminarDateForTicketLine(val) {
    const parts = formatSeminarDateForTicket(val);
    if (!parts.date) return '';
    return parts.time ? `${parts.date} · ${parts.time}` : parts.date;
}

/** Venue scan timestamps: legacy DB values are UTC without offset; new rows store IST ISO. */
function parseScanDateTime(val) {
    if (val == null || val === '') return null;
    const s = String(val).trim();
    if (!s) return null;
    if (/Z$|[+-]\d{2}(:?\d{2})?$/i.test(s)) {
        return parseSeminarDateTime(s);
    }
    let norm = s.includes('T') ? s : s.replace(' ', 'T');
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(norm)) norm += ':00';
    const d = new Date(norm + 'Z');
    return Number.isNaN(d.getTime()) ? null : d;
}

function formatScanDateTime(val) {
    const d = parseScanDateTime(val);
    if (!d) return val ? String(val) : '';
    return d.toLocaleString('en-IN', {
        timeZone: IST,
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    });
}

function scanTimeNowForStorage() {
    return normalizeSeminarDateTimeForStorage(new Date().toISOString());
}

module.exports = {
    IST,
    IST_OFFSET,
    parseSeminarDateTime,
    parseSeminarMs,
    normalizeSeminarDateTimeForStorage,
    fromDatetimeLocalInput,
    normalizeSeminarRegistrationEndForStorage,
    toDatetimeLocalInput,
    formatSeminarDateTime,
    formatSeminarDateTimeLong,
    formatSeminarDateForTicket,
    formatSeminarDateForTicketLine,
    parseScanDateTime,
    formatScanDateTime,
    scanTimeNowForStorage
};
