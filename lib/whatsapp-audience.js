/**
 * Event-based WhatsApp audiences + per-recipient variables.
 * Everything is driven by seminars / registrations / orders / tickets / user_certificates —
 * no event names, ticket names or amounts are hard-coded.
 */
const integrationSettings = require('./integration-settings');
const seminarDt = require('./seminar-datetime');
const seminarDays = require('./seminar-days');
const ticketAccess = require('./ticket-access');

const FILTERS = {
    all: 'All registrants',
    paid: 'Payment done',
    unpaid: 'Payment not done',
    payment_pending: 'Payment pending (approved, awaiting payment)',
    payment_failed: 'Payment failed',
    eticket_issued: 'E-ticket issued',
    eticket_not_issued: 'E-ticket not issued',
    attended: 'Attended (checked in)',
    not_attended: 'Not attended (ticket holder, not scanned)',
    cancelled: 'Cancelled / refunded',
    certificate_issued: 'Certificate issued',
    certificate_not_issued: 'Certificate not issued (attended)',
    custom: 'Custom selection (chosen registrations)'
};

const VARIABLES = [
    ['participant_name', 'Full name'],
    ['first_name', 'First name'],
    ['application_no', 'Application number'],
    ['phone', 'Phone'],
    ['email', 'Email'],
    ['seminar_title', 'Seminar title'],
    ['event_dates', 'Event date(s) / schedule'],
    ['event_start_date', 'Event start date'],
    ['event_end_date', 'Event end date'],
    ['venue', 'Venue'],
    ['day_title', 'Ticket day / session title'],
    ['day_date', 'Ticket day date'],
    ['ticket_id', 'Ticket ID'],
    ['ticket_link', 'Ticket PDF link'],
    ['amount_due', 'Amount due (₹)'],
    ['amount_paid', 'Amount paid (₹)'],
    ['payment_link', 'Payment link'],
    ['payment_status', 'Payment status'],
    ['registration_status', 'Registration status'],
    ['certificate_link', 'Certificate / portal link'],
    ['portal_link', 'Doctor portal link'],
    ['whatsapp_group', 'WhatsApp group link'],
    ['org_name', 'Organisation name']
];

function paidExpr() {
    return `EXISTS (SELECT 1 FROM orders o WHERE o.registration_id = r.id AND o.status = 'success')`;
}
function ticketExpr() {
    return `EXISTS (SELECT 1 FROM tickets t JOIN orders o ON o.id = t.order_id WHERE o.registration_id = r.id AND IFNULL(t.is_valid, 1) = 1)`;
}
function scannedExpr() {
    return `EXISTS (SELECT 1 FROM tickets t JOIN orders o ON o.id = t.order_id WHERE o.registration_id = r.id AND IFNULL(t.is_scanned, 0) = 1)`;
}
function certExpr() {
    return `EXISTS (SELECT 1 FROM user_certificates uc WHERE uc.registration_id = r.id AND IFNULL(uc.enabled, 0) = 1)`;
}

function whereForFilter(filter) {
    switch (String(filter || 'all')) {
        case 'paid':
            return `${paidExpr()} AND r.status NOT IN ('cancelled','refunded')`;
        case 'unpaid':
            return `NOT ${paidExpr()} AND r.status NOT IN ('cancelled','refunded','rejected')`;
        case 'payment_pending':
            return `r.status = 'approved_pending_payment' AND NOT ${paidExpr()}`;
        case 'payment_failed':
            return `NOT ${paidExpr()} AND EXISTS (SELECT 1 FROM orders o WHERE o.registration_id = r.id AND o.status = 'failed')`;
        case 'eticket_issued':
            return `${ticketExpr()} AND r.status IN ('e_ticket_issued','completed','checked_in','certificate_issued')`;
        case 'eticket_not_issued':
            return `NOT ${ticketExpr()} AND r.status NOT IN ('cancelled','refunded','rejected')`;
        case 'attended':
            return `(r.status IN ('checked_in','completed','certificate_issued') OR ${scannedExpr()})`;
        case 'not_attended':
            return `${ticketExpr()} AND NOT ${scannedExpr()} AND r.status IN ('e_ticket_issued','expired')`;
        case 'cancelled':
            return `r.status IN ('cancelled','refunded')`;
        case 'certificate_issued':
            return `(r.status = 'certificate_issued' OR ${certExpr()})`;
        case 'certificate_not_issued':
            return `(r.status IN ('checked_in','completed') OR ${scannedExpr()}) AND NOT ${certExpr()} AND r.status <> 'certificate_issued'`;
        case 'custom':
        case 'all':
        default:
            return '1 = 1';
    }
}

function fmtDate(v) {
    if (!v) return '';
    try {
        const p = seminarDt.formatSeminarDateForTicket(v);
        return p && p.date ? p.date : String(v).slice(0, 10);
    } catch (_) {
        return String(v).slice(0, 10);
    }
}

function fmtYmd(ymd) {
    const s = String(ymd || '').slice(0, 10);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return s;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function baseUrl() {
    return (integrationSettings.getPublicBaseUrl() || '').replace(/\/$/, '');
}

function paymentLink(reg) {
    const qs = new URLSearchParams();
    qs.set('pay_registration', String(reg.id));
    if (reg.application_no) qs.set('pay_app', String(reg.application_no));
    if (reg.user_id_string) qs.set('pay_user', String(reg.user_id_string));
    return baseUrl() + '/doctor?' + qs.toString();
}

function ticketLink(ticketIdString, userId) {
    const token = ticketAccess.createTicketAccessToken(ticketIdString, userId, 30 * 24 * 60 * 60 * 1000);
    const b = baseUrl();
    if (!token) return b + '/api/doctor/ticket-document/' + encodeURIComponent(ticketIdString) + '?userId=' + encodeURIComponent(userId);
    return b + '/api/doctor/ticket-document/' + encodeURIComponent(ticketIdString) + '?token=' + encodeURIComponent(token);
}

/**
 * Build recipients for a seminar audience.
 * opts = { seminarId, filter, dayId, registrationIds (custom), perTicket }
 * → cb(null, { recipients: [{userId, registrationId, ticketId, phone, name, vars}], total, noPhone })
 */
function buildEventAudience(db, opts, cb) {
    const seminarId = parseInt(opts.seminarId, 10);
    if (!seminarId) return cb(new Error('seminarId is required'));
    const filter = String(opts.filter || 'all');
    const params = [seminarId];
    let where = `r.seminar_id = ? AND (${whereForFilter(filter)})`;
    const ids = Array.isArray(opts.registrationIds) ? opts.registrationIds.map((x) => parseInt(x, 10)).filter((x) => x > 0) : [];
    if (filter === 'custom') {
        if (!ids.length) return cb(null, { recipients: [], total: 0, noPhone: 0 });
        where += ` AND r.id IN (${ids.map(() => '?').join(',')})`;
        params.push(...ids);
    }
    db.get(`SELECT * FROM seminars WHERE id = ?`, [seminarId], (eS, seminar) => {
        if (eS) return cb(eS);
        if (!seminar) return cb(new Error('Seminar not found'));
        seminarDays.attachDaysToSeminarRows(db, [seminar], (eD, withDays) => {
            const sem = (withDays && withDays[0]) || seminar;
            const dayRows = Array.isArray(sem.days) ? sem.days : Array.isArray(sem.seminar_days) ? sem.seminar_days : [];
            const schedule = seminarDt.formatSeminarSchedule(sem, dayRows);
            const dateList = seminarDt.seminarDateList(sem, dayRows);
            db.all(
                `SELECT r.id, r.user_id, r.application_no, r.status, r.created_at,
                        u.first_name, u.middle_name, u.last_name, u.email, u.phone, u.whatsapp, u.user_id_string,
                        (SELECT o.amount FROM orders o WHERE o.registration_id = r.id AND o.status = 'success' ORDER BY o.id DESC LIMIT 1) AS paid_amount,
                        (SELECT o.amount FROM orders o WHERE o.registration_id = r.id AND o.status <> 'success' ORDER BY o.id DESC LIMIT 1) AS pending_amount
                 FROM registrations r
                 JOIN users u ON u.id = r.user_id
                 WHERE ${where}
                 ORDER BY r.id ASC`,
                params,
                (e, regs) => {
                    if (e) return cb(e);
                    const list = regs || [];
                    const regIds = list.map((r) => r.id);
                    const loadTickets = (cbT) => {
                        if (!regIds.length) return cbT({});
                        db.all(
                            `SELECT o.registration_id, t.id AS ticket_pk, t.ticket_id_string, t.day_id, t.is_scanned, t.user_id,
                                    sd.title AS day_title, sd.day_date, sd.sort_order
                             FROM tickets t
                             JOIN orders o ON o.id = t.order_id
                             LEFT JOIN seminar_days sd ON sd.id = t.day_id
                             WHERE IFNULL(t.is_valid, 1) = 1 AND o.status = 'success'
                               AND o.registration_id IN (${regIds.map(() => '?').join(',')})
                             ORDER BY sd.sort_order ASC, sd.day_date ASC, t.id ASC`,
                            regIds,
                            (eT, trows) => {
                                const byReg = {};
                                (trows || []).forEach((t) => {
                                    (byReg[t.registration_id] = byReg[t.registration_id] || []).push(t);
                                });
                                cbT(byReg);
                            }
                        );
                    };
                    loadTickets((ticketsByReg) => {
                        const recipients = [];
                        let noPhone = 0;
                        const dayFilter = opts.dayId ? parseInt(opts.dayId, 10) : 0;
                        list.forEach((r) => {
                            const phone = String(r.whatsapp || r.phone || '').trim();
                            if (!phone) {
                                noPhone++;
                                return;
                            }
                            const fullName = [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' ').trim();
                            const priceDue = r.pending_amount != null ? Number(r.pending_amount) : Number(sem.price) || 0;
                            const baseVars = {
                                participant_name: fullName,
                                first_name: r.first_name || '',
                                application_no: r.application_no || '',
                                phone,
                                email: r.email || '',
                                seminar_title: sem.title || '',
                                event_dates: schedule || dateList.map(fmtYmd).join(', '),
                                event_start_date: fmtDate(sem.event_date),
                                event_end_date: fmtDate(sem.event_end_date || sem.event_date),
                                venue: sem.location_text || sem.location_url || '',
                                amount_due: r.paid_amount != null ? '0' : String(priceDue || ''),
                                amount_paid: r.paid_amount != null ? String(r.paid_amount) : '0',
                                payment_link: paymentLink(r),
                                payment_status: r.paid_amount != null ? 'PAID' : 'PENDING',
                                registration_status: String(r.status || '').replace(/_/g, ' '),
                                certificate_link: baseUrl() + '/doctor#tab-certificates',
                                portal_link: baseUrl() + '/doctor',
                                whatsapp_group: sem.whatsapp_group_url || '',
                                org_name: 'Vaidya Gogate Memorial Foundation',
                                day_title: '',
                                day_date: '',
                                ticket_id: '',
                                ticket_link: ''
                            };
                            let tickets = ticketsByReg[r.id] || [];
                            if (dayFilter) tickets = tickets.filter((t) => Number(t.day_id) === dayFilter);
                            if (opts.perTicket) {
                                if (dayFilter && !tickets.length) return;
                                if (!tickets.length) {
                                    recipients.push({ userId: r.user_id, registrationId: r.id, ticketId: null, phone, name: fullName, vars: baseVars });
                                    return;
                                }
                                tickets.forEach((t) => {
                                    recipients.push({
                                        userId: r.user_id,
                                        registrationId: r.id,
                                        ticketId: t.ticket_pk,
                                        phone,
                                        name: fullName,
                                        vars: {
                                            ...baseVars,
                                            day_title: t.day_title || sem.title || '',
                                            day_date: t.day_date ? fmtYmd(t.day_date) : baseVars.event_start_date,
                                            ticket_id: t.ticket_id_string || '',
                                            ticket_link: t.ticket_id_string ? ticketLink(t.ticket_id_string, t.user_id || r.user_id) : ''
                                        }
                                    });
                                });
                                return;
                            }
                            if (dayFilter && !tickets.length) return;
                            const first = tickets[0];
                            recipients.push({
                                userId: r.user_id,
                                registrationId: r.id,
                                ticketId: first ? first.ticket_pk : null,
                                phone,
                                name: fullName,
                                vars: first
                                    ? {
                                          ...baseVars,
                                          day_title: tickets.map((t) => t.day_title).filter(Boolean).join(', '),
                                          day_date: tickets.map((t) => (t.day_date ? fmtYmd(t.day_date) : '')).filter(Boolean).join(', '),
                                          ticket_id: first.ticket_id_string || '',
                                          ticket_link: first.ticket_id_string ? ticketLink(first.ticket_id_string, first.user_id || r.user_id) : ''
                                      }
                                    : baseVars
                            });
                        });
                        cb(null, { recipients, total: list.length, noPhone, seminar: { id: sem.id, title: sem.title, schedule } });
                    });
                }
            );
        });
    });
}

/** Search registrations for the custom-selection picker. */
function searchRegistrations(db, seminarId, q, cb) {
    const term = '%' + String(q || '').trim().toLowerCase() + '%';
    const params = [];
    let where = '1 = 1';
    if (seminarId) {
        where += ' AND r.seminar_id = ?';
        params.push(seminarId);
    }
    where += ` AND (LOWER(u.first_name) LIKE ? OR LOWER(u.last_name) LIKE ? OR LOWER(u.email) LIKE ? OR u.phone LIKE ? OR r.application_no LIKE ?)`;
    params.push(term, term, term, term, term);
    db.all(
        `SELECT r.id, r.application_no, r.status, r.seminar_id, u.first_name, u.last_name, u.phone, u.email, s.title AS seminar_title
         FROM registrations r JOIN users u ON u.id = r.user_id JOIN seminars s ON s.id = r.seminar_id
         WHERE ${where} ORDER BY r.id DESC LIMIT 40`,
        params,
        (e, rows) => cb(e, rows || [])
    );
}

module.exports = { FILTERS, VARIABLES, buildEventAudience, searchRegistrations, paymentLink, ticketLink, whereForFilter };
