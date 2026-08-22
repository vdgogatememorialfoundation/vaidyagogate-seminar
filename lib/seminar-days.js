/**
 * Multi-day seminars ("Day 1", "Day 2", ...).
 *
 * Days never change pricing — the seminar base fee covers the whole event.
 * Each day gets its own e-ticket (separate QR) and its own check-in allowed date.
 *
 * seminars.day_selection_mode:
 *   'required' — all days are mandatory; every paid registration gets a ticket per day.
 *   'optional' — doctors pick one or more days to attend; tickets only for those days.
 */
const localDate = require('./local-date');

const DAY_MODES = ['required', 'optional'];

function normalizeDaySelectionMode(v) {
    const m = String(v || '').trim().toLowerCase();
    return DAY_MODES.indexOf(m) >= 0 ? m : 'required';
}

function ensureSchema(db, ignoreErr, cb) {
    const steps = [
        `CREATE TABLE IF NOT EXISTS seminar_days (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            seminar_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            day_date TEXT,
            checkin_date TEXT,
            sort_order INTEGER DEFAULT 0,
            checkin_enabled INTEGER DEFAULT 1,
            is_active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE INDEX IF NOT EXISTS idx_seminar_days_seminar ON seminar_days (seminar_id)`,
        `ALTER TABLE seminars ADD COLUMN day_selection_mode TEXT`,
        `ALTER TABLE tickets ADD COLUMN day_id INTEGER`
    ];
    let i = 0;
    const run = () => {
        if (i >= steps.length) return cb && cb();
        db.run(steps[i], (e) => {
            ignoreErr(e);
            i++;
            run();
        });
    };
    run();
}

function mapDayRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        seminarId: row.seminar_id,
        title: row.title,
        dayDate: row.day_date,
        checkinDate: row.checkin_date,
        sortOrder: Number(row.sort_order) || 0,
        checkinEnabled: Number(row.checkin_enabled) !== 0,
        isActive: Number(row.is_active) !== 0
    };
}

function listForSeminar(db, seminarId, activeOnly, cb) {
    const sid = parseInt(seminarId, 10);
    if (!Number.isInteger(sid) || sid < 1) return cb(null, []);
    let sql = `SELECT * FROM seminar_days WHERE seminar_id = ?`;
    const params = [sid];
    if (activeOnly) {
        sql += ` AND IFNULL(is_active, 1) = 1`;
    }
    sql += ` ORDER BY sort_order ASC, day_date ASC, id ASC`;
    db.all(sql, params, (err, rows) => {
        if (err) return cb(err);
        cb(null, (rows || []).map(mapDayRow));
    });
}

function replaceForSeminar(db, seminarId, days, cb) {
    const sid = parseInt(seminarId, 10);
    if (!Number.isInteger(sid) || sid < 1) return cb(new Error('Invalid seminar id'));
    const list = Array.isArray(days) ? days : [];
    db.all(`SELECT id FROM seminar_days WHERE seminar_id = ?`, [sid], (selErr, existing) => {
        if (selErr) return cb(selErr);
        const existingIds = new Set((existing || []).map((r) => Number(r.id)));
        const items = [];
        list.forEach((d, idx) => {
            const title = String(d.title || d.name || '').trim();
            if (!title) return;
            const did = parseInt(d.id, 10);
            items.push({
                id: Number.isInteger(did) && existingIds.has(did) ? did : null,
                title,
                dayDate: localDate.normalizeCheckinDateForStorage(d.day_date || d.dayDate),
                checkinDate: localDate.normalizeCheckinDateForStorage(d.checkin_date || d.checkinDate),
                sortOrder: d.sort_order != null ? Number(d.sort_order) : idx,
                checkinEnabled:
                    d.checkin_enabled === false || d.checkinEnabled === false || d.checkin_enabled === 0 ? 0 : 1,
                isActive: d.is_active === false || d.isActive === false || d.is_active === 0 ? 0 : 1
            });
        });
        const keepIds = items.filter((d) => d.id).map((d) => d.id);
        const toDelete = [...existingIds].filter((id) => keepIds.indexOf(id) < 0);
        const saved = [];
        const upsertAll = () => {
            if (!items.length) return cb(null, saved);
            let left = items.length;
            items.forEach((d) => {
                const onSaved = (err, id) => {
                    if (err) return cb(err);
                    saved.push({
                        id,
                        seminarId: sid,
                        title: d.title,
                        dayDate: d.dayDate,
                        checkinDate: d.checkinDate,
                        sortOrder: d.sortOrder,
                        checkinEnabled: !!d.checkinEnabled,
                        isActive: !!d.isActive
                    });
                    if (--left === 0) cb(null, saved);
                };
                if (d.id) {
                    db.run(
                        `UPDATE seminar_days SET title = ?, day_date = ?, checkin_date = ?, sort_order = ?, checkin_enabled = ?, is_active = ? WHERE id = ?`,
                        [d.title, d.dayDate, d.checkinDate, d.sortOrder, d.checkinEnabled, d.isActive, d.id],
                        (updErr) => onSaved(updErr, d.id)
                    );
                } else {
                    db.run(
                        `INSERT INTO seminar_days (seminar_id, title, day_date, checkin_date, sort_order, checkin_enabled, is_active)
                         VALUES (?, ?, ?, ?, ?, ?, ?)`,
                        [sid, d.title, d.dayDate, d.checkinDate, d.sortOrder, d.checkinEnabled, d.isActive],
                        function (insErr) {
                            onSaved(insErr, this && this.lastID);
                        }
                    );
                }
            });
        };
        if (!toDelete.length) return upsertAll();
        const ph = toDelete.map(() => '?').join(',');
        db.run(`DELETE FROM seminar_days WHERE seminar_id = ? AND id IN (${ph})`, [sid, ...toDelete], (delErr) => {
            if (delErr) return cb(delErr);
            upsertAll();
        });
    });
}

function attachDaysToSeminarRows(db, rows, cb) {
    const list = rows || [];
    if (!list.length) return cb(null, list);
    const ids = [...new Set(list.map((r) => r.id).filter(Boolean))];
    if (!ids.length) return cb(null, list);
    const ph = ids.map(() => '?').join(',');
    db.all(
        `SELECT * FROM seminar_days WHERE seminar_id IN (${ph}) AND IFNULL(is_active, 1) = 1 ORDER BY sort_order ASC, day_date ASC, id ASC`,
        ids,
        (err, dayRows) => {
            if (err) return cb(err);
            const bySem = {};
            (dayRows || []).forEach((r) => {
                const sid = r.seminar_id;
                if (!bySem[sid]) bySem[sid] = [];
                bySem[sid].push(mapDayRow(r));
            });
            cb(
                null,
                list.map((r) => ({
                    ...r,
                    days: bySem[r.id] || [],
                    has_days: (bySem[r.id] || []).length > 0,
                    day_selection_mode: normalizeDaySelectionMode(r.day_selection_mode)
                }))
            );
        }
    );
}

function parseSelectedDayIds(formData) {
    let fd = formData;
    if (typeof fd === 'string') {
        try {
            fd = JSON.parse(fd);
        } catch (_) {
            fd = {};
        }
    }
    if (!fd || typeof fd !== 'object') return [];
    const raw = fd.selected_day_ids || fd.selectedDayIds || [];
    if (!Array.isArray(raw)) return [];
    return raw.map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * Days that should get their own e-ticket for a registration.
 * Returns [] when the seminar has no days (single-ticket flow).
 * 'required' mode → every active day. 'optional' mode → chosen days (fallback: all days).
 */
function getDayIdsForTicketIssue(db, registrationId, cb) {
    db.get(
        `SELECT r.seminar_id, r.form_data, s.day_selection_mode
         FROM registrations r JOIN seminars s ON s.id = r.seminar_id WHERE r.id = ?`,
        [registrationId],
        (err, reg) => {
            if (err) return cb(err);
            if (!reg) return cb(null, []);
            listForSeminar(db, reg.seminar_id, true, (e2, days) => {
                if (e2) return cb(e2);
                if (!days || !days.length) return cb(null, []);
                const mode = normalizeDaySelectionMode(reg.day_selection_mode);
                if (mode === 'required') return cb(null, days.map((d) => d.id));
                const selected = parseSelectedDayIds(reg.form_data).filter((id) =>
                    days.some((d) => Number(d.id) === Number(id))
                );
                cb(null, selected.length ? selected : days.map((d) => d.id));
            });
        }
    );
}

function getDayById(db, dayId, cb) {
    const id = parseInt(dayId, 10);
    if (!Number.isInteger(id) || id < 1) return cb(null, null);
    db.get(`SELECT * FROM seminar_days WHERE id = ?`, [id], (err, row) => {
        if (err) return cb(err);
        cb(null, mapDayRow(row));
    });
}

module.exports = {
    ensureSchema,
    normalizeDaySelectionMode,
    listForSeminar,
    replaceForSeminar,
    attachDaysToSeminarRows,
    parseSelectedDayIds,
    getDayIdsForTicketIssue,
    getDayById,
    mapDayRow
};
