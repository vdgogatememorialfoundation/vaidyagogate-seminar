'use strict';

/**
 * Adds `previousDay` to live scan events of multi-day seminars:
 * whether the same applicant checked in on the day before, and when.
 */
function attachPreviousDay(db, seminarId, events, cb) {
    const list = events || [];
    const apps = Array.from(new Set(list.filter((e) => e.applicationNo && e.dayId).map((e) => String(e.applicationNo))));
    if (!apps.length) return cb(null, list);
    db.all(
        `SELECT id, title, day_date, sort_order FROM seminar_days
         WHERE seminar_id = ? AND IFNULL(is_active, 1) = 1
         ORDER BY day_date ASC, sort_order ASC, id ASC`,
        [seminarId],
        (e1, days) => {
            if (e1 || !days || days.length < 2) return cb(null, list);
            const ph = apps.map(() => '?').join(',');
            db.all(
                `SELECT r.application_no, t.day_id, t.is_scanned, t.scan_time
                 FROM registrations r
                 JOIN orders o ON o.registration_id = r.id
                 JOIN tickets t ON t.order_id = o.id
                 WHERE r.seminar_id = ? AND r.application_no IN (${ph}) AND t.day_id IS NOT NULL`,
                [seminarId].concat(apps),
                (e2, rows) => {
                    if (e2) return cb(null, list);
                    const byKey = new Map();
                    (rows || []).forEach((r) => {
                        const k = r.application_no + '|' + r.day_id;
                        const scanned = r.is_scanned === true || Number(r.is_scanned) === 1;
                        const prev = byKey.get(k);
                        if (!prev || (scanned && !prev.scanned)) {
                            byKey.set(k, { scanned, scanTime: scanned ? r.scan_time || null : null });
                        }
                    });
                    const idx = new Map(days.map((d, i) => [Number(d.id), i]));
                    list.forEach((ev) => {
                        const i = idx.get(Number(ev.dayId));
                        if (i == null || i === 0 || !ev.applicationNo) return;
                        const pd = days[i - 1];
                        const t = byKey.get(ev.applicationNo + '|' + pd.id);
                        ev.previousDay = {
                            dayId: pd.id,
                            title: pd.title,
                            dayDate: pd.day_date ? String(pd.day_date).slice(0, 10) : null,
                            hasTicket: !!t,
                            attended: !!(t && t.scanned),
                            scanTime: t && t.scanned ? t.scanTime : null
                        };
                    });
                    cb(null, list);
                }
            );
        }
    );
}

module.exports = { attachPreviousDay };
