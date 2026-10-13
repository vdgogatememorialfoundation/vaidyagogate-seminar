/**
 * Per-day venue scan status for registrations (multi-day seminars): one entry per active
 * seminar day with that day's own scan time, so Day 1 never shows the Day 2 scan time.
 */

function toMs(v) {
    if (v == null || v === '') return null;
    const t = v instanceof Date ? v.getTime() : new Date(String(v).replace(' ', 'T')).getTime();
    return Number.isNaN(t) ? null : t;
}

function ymd(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) {
        const p = (n) => String(n).padStart(2, '0');
        return v.getFullYear() + '-' + p(v.getMonth() + 1) + '-' + p(v.getDate());
    }
    return String(v).slice(0, 10);
}

function isTruthy(v) {
    return v === true || v === 1 || v === '1' || v === 't' || v === 'true';
}

function scanTimeIso(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
    return String(v);
}

/** "Day 1 — Saturday, 3 October 2026, 3:21 pm; Day 2 — …" for certificate emails. */
function formatAttendedDays(days) {
    const seminarDt = require('./seminar-datetime');
    return (days || [])
        .filter((d) => d && d.scanned)
        .map((d) => {
            const when = d.scanTime ? seminarDt.formatScanDateTime(d.scanTime) : d.dayDate || '';
            return String(d.title || 'Day') + (when ? ' — ' + when : '');
        })
        .join('; ');
}

function formatDayDateLabel(ymd) {
    const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return '';
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return d.toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC'
    });
}

function dayAttendanceLabel(d) {
    const title = String((d && d.title) || 'Day').trim();
    const date = formatDayDateLabel(d && d.dayDate);
    return date ? title + ' (' + date + ')' : title;
}

function joinAnd(labels) {
    const list = labels || [];
    if (list.length <= 1) return list[0] || '';
    if (list.length === 2) return list[0] + ' and ' + list[1];
    return list.slice(0, -1).join(', ') + ', and ' + list[list.length - 1];
}

/** Sorted scanned day ids, e.g. "5" or "5,6". Empty when nothing was scanned. */
function attendanceKey(days) {
    return (days || [])
        .filter((d) => d && d.scanned)
        .map((d) => Number(d.dayId))
        .filter((n) => Number.isInteger(n) && n > 0)
        .sort((a, b) => a - b)
        .join(',');
}

/**
 * Sentence printed on a doctor certificate.
 * One scanned day of a multi-day seminar names that day only.
 * Every day of a two-day seminar says they attended both days.
 * A single-day seminar returns an empty string (the template already names the event).
 */
function attendanceCertificateLine(days) {
    const list = days || [];
    const scanned = list.filter((d) => d && d.scanned);
    if (list.length < 2 || !scanned.length) return '';
    const labels = scanned.map(dayAttendanceLabel);
    if (scanned.length === 1) return 'This certificate is for ' + labels[0] + ' only.';
    if (scanned.length === list.length && scanned.length === 2) {
        return 'Attended both days: ' + labels[0] + ' and ' + labels[1] + '.';
    }
    if (scanned.length === list.length) {
        return 'Attended all ' + scanned.length + ' days: ' + joinAnd(labels) + '.';
    }
    return 'Attended: ' + joinAnd(labels) + '.';
}

function collapseRows(rows) {
    const byReg = new Map();
    (rows || []).forEach((r) => {
        const regId = Number(r.registration_id);
        if (!byReg.has(regId)) byReg.set(regId, new Map());
        const days = byReg.get(regId);
        const dayId = Number(r.day_id);
        let d = days.get(dayId);
        if (!d) {
            d = {
                dayId,
                title: r.title || 'Day',
                dayDate: ymd(r.day_date),
                sortOrder: Number(r.sort_order) || 0,
                hasTicket: false,
                scanned: false,
                scanCount: 0,
                scanTime: null,
                ticketId: null,
                _ms: null
            };
            days.set(dayId, d);
        }
        if (r.ticket_id != null) {
            d.hasTicket = true;
            if (d.ticketId == null) d.ticketId = Number(r.ticket_id);
            const count = Number(r.scan_count) || 0;
            const scanned = isTruthy(r.is_scanned) || count > 0;
            if (scanned) {
                d.scanned = true;
                d.scanCount = Math.max(d.scanCount, count || 1);
                const ms = toMs(r.scan_time);
                if (r.scan_time != null && (d._ms == null || (ms != null && ms < d._ms))) {
                    d.scanTime = r.scan_time;
                    d._ms = ms;
                }
            }
        }
    });
    const out = new Map();
    byReg.forEach((days, regId) => {
        out.set(
            regId,
            Array.from(days.values())
                .sort((a, b) => a.sortOrder - b.sortOrder || String(a.dayDate).localeCompare(String(b.dayDate)) || a.dayId - b.dayId)
                .map((d) => ({
                    dayId: d.dayId,
                    title: d.title,
                    dayDate: d.dayDate,
                    hasTicket: d.hasTicket,
                    scanned: d.scanned,
                    scanCount: d.scanCount,
                    scanTime: scanTimeIso(d.scanTime),
                    ticketId: d.ticketId
                }))
        );
    });
    return out;
}

/** cb(err, Map<registrationId, day[]>) — days are empty for single-day seminars. */
function loadDayScans(db, registrationIds, cb) {
    const ids = Array.from(
        new Set((registrationIds || []).map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x) && x > 0))
    );
    if (!ids.length) return cb(null, new Map());
    const chunks = [];
    for (let i = 0; i < ids.length; i += 200) chunks.push(ids.slice(i, i + 200));
    const all = [];
    let idx = 0;
    const next = () => {
        if (idx >= chunks.length) return cb(null, collapseRows(all));
        const chunk = chunks[idx++];
        db.all(
            `SELECT r.id AS registration_id, sd.id AS day_id, sd.title, sd.day_date, sd.sort_order,
                    t.id AS ticket_id, t.is_scanned, t.scan_count, t.scan_time
             FROM registrations r
             JOIN seminar_days sd ON sd.seminar_id = r.seminar_id AND IFNULL(sd.is_active, 1) = 1
             LEFT JOIN orders o ON o.registration_id = r.id AND lower(trim(o.status)) = 'success'
             LEFT JOIN tickets t ON t.order_id = o.id AND t.day_id = sd.id
             WHERE r.id IN (${chunk.map(() => '?').join(',')})`,
            chunk,
            (err, rows) => {
                if (err) {
                    if (/no such table|does not exist|no such column/i.test(String(err.message || ''))) {
                        return cb(null, new Map());
                    }
                    return cb(err);
                }
                all.push.apply(all, rows || []);
                next();
            }
        );
    };
    next();
}

/** Attach `dayScans` to already-mapped rows that carry registrationId. */
function attachDayScansToRows(db, rows, cb) {
    const list = rows || [];
    loadDayScans(
        db,
        list.map((r) => r.registrationId),
        (err, map) => {
            if (err) {
                console.warn('[day-scans]', err.message);
                return cb(null, list);
            }
            list.forEach((r) => {
                const days = map.get(Number(r.registrationId)) || [];
                r.dayScans = days.length >= 2 ? days : [];
            });
            cb(null, list);
        }
    );
}

/** Attach `day_scans` onto rows keyed by registration id (admin application lists). */
function attachDayScansByRegistrationId(db, rows, idField, cb) {
    const field = idField || 'id';
    const list = rows || [];
    loadDayScans(
        db,
        list.map((r) => r && r[field]),
        (err, map) => {
            if (err) {
                console.warn('[day-scans]', err.message);
                return cb(null, list);
            }
            list.forEach((r) => {
                const days = map.get(Number(r[field])) || [];
                if (days.length >= 2) r.day_scans = days;
            });
            cb(null, list);
        }
    );
}

module.exports = {
    loadDayScans,
    attachDayScansToRows,
    attachDayScansByRegistrationId,
    formatAttendedDays,
    attendanceKey,
    attendanceCertificateLine
};
