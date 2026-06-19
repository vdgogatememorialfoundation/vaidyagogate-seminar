/**
 * Sub-events within a seminar (e.g. Workshop day + Main conference day).
 * Each event has its own price, check-in date, ticket, scan, and certificate.
 */
const seminarDt = require('./seminar-datetime');
const googleMaps = require('./google-maps');

function ensureSchema(db, ignoreErr, cb) {
    const steps = [
        `CREATE TABLE IF NOT EXISTS seminar_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            seminar_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            location_text TEXT,
            location_url TEXT,
            event_date TEXT,
            checkin_date TEXT,
            price REAL DEFAULT 0,
            capacity INTEGER,
            sort_order INTEGER DEFAULT 0,
            checkin_enabled INTEGER DEFAULT 1,
            cert_scans_required INTEGER DEFAULT 1,
            is_active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE INDEX IF NOT EXISTS idx_seminar_events_seminar ON seminar_events (seminar_id)`,
        `ALTER TABLE seminar_events ADD COLUMN description TEXT`,
        `ALTER TABLE seminar_events ADD COLUMN location_text TEXT`,
        `ALTER TABLE seminar_events ADD COLUMN location_url TEXT`,
        `ALTER TABLE seminar_events ADD COLUMN capacity INTEGER`,
        `ALTER TABLE tickets ADD COLUMN event_id INTEGER`,
        `ALTER TABLE user_certificates ADD COLUMN event_id INTEGER DEFAULT 0`,
        `ALTER TABLE ticket_scan_events ADD COLUMN event_id INTEGER`
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

function pgDdl() {
    return {
        table: `CREATE TABLE IF NOT EXISTS seminar_events (
            id SERIAL PRIMARY KEY,
            seminar_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            location_text TEXT,
            location_url TEXT,
            event_date TIMESTAMPTZ,
            checkin_date TEXT,
            price REAL DEFAULT 0,
            capacity INTEGER,
            sort_order INTEGER DEFAULT 0,
            checkin_enabled INTEGER DEFAULT 1,
            cert_scans_required INTEGER DEFAULT 1,
            is_active INTEGER DEFAULT 1,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`,
        alters: [
            'ALTER TABLE tickets ADD COLUMN IF NOT EXISTS event_id INTEGER',
            'ALTER TABLE user_certificates ADD COLUMN IF NOT EXISTS event_id INTEGER DEFAULT 0',
            'ALTER TABLE ticket_scan_events ADD COLUMN IF NOT EXISTS event_id INTEGER'
        ]
    };
}

function mapEventRow(row) {
    if (!row) return null;
    const capacity = row.capacity != null && row.capacity !== '' ? parseInt(row.capacity, 10) : null;
    const base = {
        id: row.id,
        seminarId: row.seminar_id,
        title: row.title,
        description: row.description || '',
        locationText: row.location_text || '',
        locationUrl: row.location_url || '',
        eventDate: row.event_date,
        checkinDate: row.checkin_date,
        price: Number(row.price) || 0,
        capacity: Number.isInteger(capacity) && capacity > 0 ? capacity : null,
        sortOrder: Number(row.sort_order) || 0,
        checkinEnabled: Number(row.checkin_enabled) !== 0,
        certScansRequired: Number(row.cert_scans_required) === 2 ? 2 : 1,
        isActive: Number(row.is_active) !== 0
    };
    return googleMaps.enrichEventRow(base);
}

function listForSeminar(db, seminarId, activeOnly, cb) {
    const sid = parseInt(seminarId, 10);
    if (!Number.isInteger(sid) || sid < 1) return cb(null, []);
    let sql = `SELECT * FROM seminar_events WHERE seminar_id = ?`;
    const params = [sid];
    if (activeOnly) {
        sql += ` AND IFNULL(is_active, 1) = 1`;
    }
    sql += ` ORDER BY sort_order ASC, id ASC`;
    db.all(sql, params, (err, rows) => {
        if (err) return cb(err);
        cb(null, (rows || []).map(mapEventRow));
    });
}

function replaceForSeminar(db, seminarId, events, cb) {
    const sid = parseInt(seminarId, 10);
    if (!Number.isInteger(sid) || sid < 1) return cb(new Error('Invalid seminar id'));
    const list = Array.isArray(events) ? events : [];
    db.run(`DELETE FROM seminar_events WHERE seminar_id = ?`, [sid], (delErr) => {
        if (delErr) return cb(delErr);
        if (!list.length) return cb(null, []);
        let left = list.length;
        const saved = [];
        list.forEach((ev, idx) => {
            const title = String(ev.title || ev.name || '').trim();
            if (!title) {
                if (--left === 0) cb(null, saved);
                return;
            }
            const description = String(ev.description || '').trim() || null;
            const locNorm = googleMaps.normalizeLocationOnSave({
                location_text: ev.location_text || ev.locationText,
                location_url: ev.location_url || ev.locationUrl
            });
            const locationText = locNorm.location_text;
            const locationUrl = locNorm.location_url;
            const eventDate = seminarDt.normalizeSeminarDateTimeForStorage(ev.event_date || ev.eventDate);
            const checkinDate = ev.checkin_date || ev.checkinDate || null;
            const price = Number(ev.price) || 0;
            const capRaw = ev.capacity != null ? parseInt(ev.capacity, 10) : null;
            const capacity = Number.isInteger(capRaw) && capRaw > 0 ? capRaw : null;
            const sortOrder = ev.sort_order != null ? Number(ev.sort_order) : idx;
            const checkinEnabled =
                ev.checkin_enabled === false || ev.checkinEnabled === false || ev.checkin_enabled === 0 ? 0 : 1;
            const certScans =
                Number(ev.cert_scans_required || ev.certScansRequired) === 2 ? 2 : 1;
            const isActive = ev.is_active === false || ev.isActive === false || ev.is_active === 0 ? 0 : 1;
            db.run(
                `INSERT INTO seminar_events (seminar_id, title, description, location_text, location_url, event_date, checkin_date, price, capacity, sort_order, checkin_enabled, cert_scans_required, is_active)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    sid,
                    title,
                    description,
                    locationText,
                    locationUrl,
                    eventDate,
                    checkinDate,
                    price,
                    capacity,
                    sortOrder,
                    checkinEnabled,
                    certScans,
                    isActive
                ],
                function (insErr) {
                    if (insErr) return cb(insErr);
                    saved.push({
                        id: this.lastID,
                        seminarId: sid,
                        title,
                        description,
                        locationText,
                        locationUrl,
                        eventDate,
                        checkinDate,
                        price,
                        capacity,
                        sortOrder,
                        checkinEnabled: !!checkinEnabled,
                        certScansRequired: certScans,
                        isActive: !!isActive
                    });
                    if (--left === 0) cb(null, saved);
                }
            );
        });
    });
}

function attachEventsToSeminarRows(db, rows, cb) {
    const list = rows || [];
    if (!list.length) return cb(null, list);
    const ids = [...new Set(list.map((r) => r.id).filter(Boolean))];
    if (!ids.length) return cb(null, list);
    const ph = ids.map(() => '?').join(',');
    db.all(
        `SELECT * FROM seminar_events WHERE seminar_id IN (${ph}) AND IFNULL(is_active, 1) = 1 ORDER BY sort_order ASC, id ASC`,
        ids,
        (err, evRows) => {
            if (err) return cb(err);
            const bySem = {};
            (evRows || []).forEach((r) => {
                const sid = r.seminar_id;
                if (!bySem[sid]) bySem[sid] = [];
                bySem[sid].push(mapEventRow(r));
            });
            cb(
                null,
                list.map((r) => ({
                    ...r,
                    sub_events: bySem[r.id] || [],
                    has_sub_events: (bySem[r.id] || []).length > 0
                }))
            );
        }
    );
}

function parseSelectedEventIds(formData) {
    let fd = formData;
    if (typeof fd === 'string') {
        try {
            fd = JSON.parse(fd);
        } catch (_) {
            fd = {};
        }
    }
    if (!fd || typeof fd !== 'object') return [];
    const raw = fd.selected_event_ids || fd.selectedEventIds || [];
    if (!Array.isArray(raw)) return [];
    return raw.map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n) && n > 0);
}

function computePaymentFromSelection(seminarPrice, events, selectedIds) {
    const basePrice = Number(seminarPrice) || 0;
    const eventsList = Array.isArray(events) ? events : [];
    const selected = (Array.isArray(selectedIds) ? selectedIds : [])
        .map((x) => parseInt(x, 10))
        .filter((n) => Number.isInteger(n) && n > 0);

    if (!eventsList.length) {
        const amt = basePrice;
        return {
            amount: amt,
            breakdown: [{ label: 'Seminar fee', amount: amt }],
            usesSubEvents: false,
            selectedEventIds: []
        };
    }

    const picked = eventsList.filter((ev) => selected.includes(Number(ev.id)));
    if (!picked.length) {
        return {
            amount: 0,
            error: 'Select at least one event to attend.',
            breakdown: [],
            usesSubEvents: true,
            events: eventsList,
            selectedEventIds: []
        };
    }

    const breakdown = [];
    if (basePrice > 0) {
        breakdown.push({ label: 'Seminar base fee', amount: basePrice });
    }
    picked.forEach((ev) => {
        breakdown.push({
            eventId: ev.id,
            label: ev.title,
            amount: Number(ev.price) || 0
        });
    });
    const amount = Math.round(breakdown.reduce((s, b) => s + (Number(b.amount) || 0), 0) * 100) / 100;
    return {
        amount,
        breakdown,
        usesSubEvents: true,
        events: eventsList,
        selectedEventIds: picked.map((p) => p.id)
    };
}

function computeRegistrationPaymentAmount(db, registrationId, cb) {
    db.get(
        `SELECT r.id, r.seminar_id, r.form_data, s.price AS seminar_price
         FROM registrations r JOIN seminars s ON s.id = r.seminar_id WHERE r.id = ?`,
        [registrationId],
        (err, reg) => {
            if (err) return cb(err);
            if (!reg) return cb(null, { amount: 0, breakdown: [], usesSubEvents: false });
            listForSeminar(db, reg.seminar_id, true, (e2, events) => {
                if (e2) return cb(e2);
                const selected = parseSelectedEventIds(reg.form_data);
                cb(null, computePaymentFromSelection(reg.seminar_price, events, selected));
            });
        }
    );
}

function attachPaymentAmountsToRegistrations(db, rows, cb) {
    const list = rows || [];
    if (!list.length) return cb(null, list);
    let left = list.length;
    const out = list.map((r) => ({ ...r }));
    list.forEach((row, i) => {
        computeRegistrationPaymentAmount(db, row.id, (err, pay) => {
            if (!err && pay) {
                out[i].payment_amount = pay.amount;
                out[i].payment_breakdown = pay.breakdown || [];
            }
            if (--left === 0) cb(null, out);
        });
    });
}

function getEventIdsForTicketIssue(db, registrationId, cb) {
    computeRegistrationPaymentAmount(db, registrationId, (err, pay) => {
        if (err) return cb(err);
        if (pay.usesSubEvents) {
            return cb(null, pay.selectedEventIds || []);
        }
        cb(null, []);
    });
}

function getEventById(db, eventId, cb) {
    const id = parseInt(eventId, 10);
    if (!Number.isInteger(id) || id < 1) return cb(null, null);
    db.get(`SELECT * FROM seminar_events WHERE id = ?`, [id], (err, row) => {
        if (err) return cb(err);
        cb(null, mapEventRow(row));
    });
}

function formatEventsPriceLabel(events, basePrice) {
    if (!events || !events.length) return '';
    const base = Number(basePrice) || 0;
    const prices = events.map((e) => Number(e.price) || 0);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    let sessionPart;
    if (events.length === 1) sessionPart = '₹' + prices[0] + ' per session';
    else if (min === max) sessionPart = '₹' + min + ' per session';
    else sessionPart = '₹' + min + ' – ₹' + max + ' per session';
    if (base > 0) return '₹' + base + ' base + ' + sessionPart;
    return sessionPart + ' (choose sessions)';
}

module.exports = {
    ensureSchema,
    pgDdl,
    listForSeminar,
    replaceForSeminar,
    attachEventsToSeminarRows,
    parseSelectedEventIds,
    computePaymentFromSelection,
    computeRegistrationPaymentAmount,
    attachPaymentAmountsToRegistrations,
    getEventIdsForTicketIssue,
    getEventById,
    mapEventRow,
    formatEventsPriceLabel
};
