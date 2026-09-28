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
    // Calendar date only (seminar_days.day_date, DATE columns): midnight IST, never UTC.
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        return new Date(s + 'T00:00:00' + IST_OFFSET);
    }
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

/** Admin/doctor free-text or datetime-local (IST wall clock). */
function parseFlexibleAdminDatetimeInput(val) {
    if (val == null || val === '') return null;
    const s = String(val).trim();
    if (!s) return null;

    const direct = parseSeminarDateTime(s);
    if (direct) return direct;

    if (/^\d{4}-\d{2}-\d{2}T\d{1,2}:\d{2}$/.test(s)) {
        const d = parseSeminarDateTime(s + ':00' + IST_OFFSET);
        if (d) return d;
    }

    let m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (m) {
        const iso =
            `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}T` +
            `${m[4].padStart(2, '0')}:${m[5].padStart(2, '0')}:${(m[6] || '00').padStart(2, '0')}${IST_OFFSET}`;
        const d = parseSeminarDateTime(iso);
        if (d) return d;
    }

    m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (m) {
        const iso =
            `${m[1]}-${m[2]}-${m[3]}T` +
            `${m[4].padStart(2, '0')}:${m[5].padStart(2, '0')}:${(m[6] || '00').padStart(2, '0')}${IST_OFFSET}`;
        const d = parseSeminarDateTime(iso);
        if (d) return d;
    }

    return null;
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

/** Latest millisecond when override registration is still allowed (inclusive minute end in IST). */
function registrationOverrideDeadlineMs(registerUntil) {
    if (registerUntil == null || registerUntil === '') return null;
    const normalized = normalizeSeminarRegistrationEndForStorage(registerUntil);
    return parseSeminarMs(normalized || registerUntil);
}

/** Small grace for clock skew between browser, admin, and server. */
function isRegistrationOverrideOpenNow(registerUntil, nowMs) {
    const untilMs = registrationOverrideDeadlineMs(registerUntil);
    if (untilMs == null) return true;
    const now = nowMs != null ? nowMs : Date.now();
    return now <= untilMs + 2000;
}

/** Registration close time is inclusive for the full minute (e.g. 15:48 means open until 15:48:59 IST). */
function normalizeSeminarRegistrationEndForStorage(localStr) {
    let d = parseFlexibleAdminDatetimeInput(localStr);
    if (!d) {
        const base = fromDatetimeLocalInput(localStr);
        if (!base) return null;
        d = parseSeminarDateTime(base);
        if (!d) return base;
    }
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
    // UTC midnight (a DATE column serialised as timestamp) is 5:30 am IST — a date, not a timing.
    if (storedAsUtc && hh === 5 && mm === 30) return { date: dateLine, time: null };
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

/**
 * Human schedule for a seminar: single date (with timings) for 1-day events, or
 * "Fri 3 Apr – Sat 4 Apr 2026 · 9:00 am – 5:00 pm IST" when event_end_date falls on a later day.
 * When `days` (seminar_days rows) are supplied, every day is listed instead.
 */
/** seminar_days.day_date is a calendar date: normalise Date objects / ISO strings to YYYY-MM-DD so no time-of-day leaks in. */
function dayRowDate(d) {
    if (!d) return null;
    const v = d.day_date || d.dayDate || d.date || null;
    if (!v) return null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
    const s = String(v).trim();
    return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}

/** "09:00" / "09:00:00" → "9:00 am"; anything unparseable is returned trimmed. */
function formatClockTime(t) {
    if (t == null || t === '') return '';
    const m = String(t).trim().match(/^(\d{1,2}):(\d{2})/);
    if (!m) return String(t).trim();
    const hh = parseInt(m[1], 10);
    const mm = m[2];
    if (!Number.isFinite(hh)) return String(t).trim();
    const h12 = hh % 12 || 12;
    return `${h12}:${mm} ${hh >= 12 ? 'pm' : 'am'}`;
}

/** Admin-set day timings ("9:00 am – 5:00 pm IST") or '' when none were entered. */
function dayRowTimeRange(d) {
    if (!d) return '';
    const a = formatClockTime(d.start_time || d.startTime);
    const b = formatClockTime(d.end_time || d.endTime);
    if (a && b) return `${a} – ${b} IST`;
    if (a || b) return `${a || b} IST`;
    return '';
}

/** One line for a seminar day: "Day 1: Saturday, 3 October 2026 · 9:00 am – 5:00 pm IST". */
function formatSeminarDayLine(d) {
    const label = d && d.title ? String(d.title).trim() + ': ' : '';
    const date = formatSeminarDateForTicketLine(dayRowDate(d));
    const t = dayRowTimeRange(d);
    return label + date + (t ? ` · ${t}` : '');
}

function activeDayRows(seminar, days) {
    const src = Array.isArray(days) ? days : seminar && Array.isArray(seminar.days) ? seminar.days : [];
    return src.filter((d) => d && dayRowDate(d) && d.isActive !== false && Number(d.is_active == null ? 1 : d.is_active) !== 0);
}

function formatSeminarSchedule(seminar, days) {
    if (!seminar) return '';
    const dayRows = activeDayRows(seminar, days);
    if (dayRows.length > 1) {
        return dayRows.map(formatSeminarDayLine).join(' | ');
    }
    if (dayRows.length === 1 && dayRowTimeRange(dayRows[0])) {
        return formatSeminarDayLine(dayRows[0]);
    }
    const start = parseSeminarDateTime(seminar.event_date);
    if (!start) return seminar.event_date ? String(seminar.event_date) : '';
    const end = parseSeminarDateTime(seminar.event_end_date);
    const gs = partsInIst(start);
    const startYmd = `${gs('year')}-${gs('month')}-${gs('day')}`;
    const startParts = formatSeminarDateForTicket(seminar.event_date);
    if (!end || end.getTime() <= start.getTime()) return formatSeminarDateForTicketLine(seminar.event_date);
    const ge = partsInIst(end);
    const endYmd = `${ge('year')}-${ge('month')}-${ge('day')}`;
    const endParts = formatSeminarDateForTicket(seminar.event_end_date);
    const timeRange = (a, b) => {
        if (a && b) return a.replace(/ IST$/, '') + ' – ' + b;
        return a || b || '';
    };
    if (startYmd === endYmd) {
        const t = timeRange(startParts.time, endParts.time);
        return t ? `${startParts.date} · ${t}` : startParts.date;
    }
    const t = timeRange(startParts.time, endParts.time);
    return `${startParts.date} – ${endParts.date}` + (t ? ` · ${t}` : '');
}

/** All calendar dates (YYYY-MM-DD, IST) covered by a seminar — from seminar_days when present, else start..end. */
function seminarDateList(seminar, days) {
    const dayRows = activeDayRows(seminar, days);
    if (dayRows.length) {
        return dayRows.map((d) => String(dayRowDate(d)).slice(0, 10));
    }
    const start = parseSeminarDateTime(seminar && seminar.event_date);
    if (!start) return [];
    const end = parseSeminarDateTime(seminar && seminar.event_end_date) || start;
    const out = [];
    const cur = new Date(start.getTime());
    for (let i = 0; i < 31 && cur.getTime() <= end.getTime() + 1; i++) {
        const g = partsInIst(cur);
        const ymd = `${g('year')}-${g('month')}-${g('day')}`;
        if (!out.includes(ymd)) out.push(ymd);
        cur.setTime(cur.getTime() + 86400000);
    }
    const ge = partsInIst(end);
    const endYmd = `${ge('year')}-${ge('month')}-${ge('day')}`;
    if (!out.includes(endYmd)) out.push(endYmd);
    return out;
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
    formatSeminarDayLine,
    dayRowTimeRange,
    formatClockTime,
    IST,
    IST_OFFSET,
    parseSeminarDateTime,
    parseSeminarMs,
    normalizeSeminarDateTimeForStorage,
    fromDatetimeLocalInput,
    parseFlexibleAdminDatetimeInput,
    normalizeSeminarRegistrationEndForStorage,
    registrationOverrideDeadlineMs,
    isRegistrationOverrideOpenNow,
    toDatetimeLocalInput,
    formatSeminarDateTime,
    formatSeminarDateTimeLong,
    formatSeminarDateForTicket,
    formatSeminarDateForTicketLine,
    formatSeminarSchedule,
    seminarDateList,
    parseScanDateTime,
    formatScanDateTime,
    scanTimeNowForStorage
};
