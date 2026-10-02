const XLSX = require('xlsx');
const { parseFormData } = require('./parse-form-data');
const { CONFIRMED_EXPORT_SQL, filterConfirmedRows } = require('./confirmed-participants');

function flattenRow(row) {
    const fd = parseFormData(row.form_data);
    const out = { ...row };
    delete out.form_data;
    Object.keys(fd).forEach((k) => {
        const col = `form_${k}`;
        if (out[col] === undefined) out[col] = fd[k];
    });
    return out;
}

function rowsToSheet(rows) {
    const flat = rows.map((r) => flattenRow(r));
    if (!flat.length) return XLSX.utils.aoa_to_sheet([['No data']]);
    const keys = [];
    flat.forEach((r) => {
        Object.keys(r).forEach((k) => {
            if (!keys.includes(k)) keys.push(k);
        });
    });
    const data = [keys, ...flat.map((r) => keys.map((k) => r[k] != null ? r[k] : ''))];
    return XLSX.utils.aoa_to_sheet(data);
}

function toCsv(rows) {
    const flat = rows.map((r) => flattenRow(r));
    if (!flat.length) return '';
    const keys = [];
    flat.forEach((r) => {
        Object.keys(r).forEach((k) => {
            if (!keys.includes(k)) keys.push(k);
        });
    });
    const lines = [keys.join(',')];
    flat.forEach((r) => {
        lines.push(keys.map((k) => `"${String(r[k] != null ? r[k] : '').replace(/"/g, '""')}"`).join(','));
    });
    return lines.join('\n');
}

function toXlsxBuffer(rows, sheetName) {
    const wb = XLSX.utils.book_new();
    const safeName = String(sheetName || 'Report').replace(/[:\\\/?*\[\]]/g, '-').slice(0, 31) || 'Report';
    XLSX.utils.book_append_sheet(wb, rowsToSheet(rows), safeName);
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function toHtmlTable(rows, title) {
    const flat = rows.map((r) => flattenRow(r));
    if (!flat.length) return `<html><body><h1>${title}</h1><p>No data</p></body></html>`;
    const keys = [];
    flat.forEach((r) => {
        Object.keys(r).forEach((k) => {
            if (!keys.includes(k)) keys.push(k);
        });
    });
    let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;padding:20px}table{border-collapse:collapse;width:100%;font-size:12px}
th,td{border:1px solid #ccc;padding:6px 8px;text-align:left}th{background:#1e3a5f;color:#fff}</style></head><body>
<h1>${title}</h1><table><thead><tr>`;
    keys.forEach((k) => {
        html += `<th>${escapeHtml(k)}</th>`;
    });
    html += '</tr></thead><tbody>';
    flat.forEach((r) => {
        html += '<tr>';
        keys.forEach((k) => {
            html += `<td>${escapeHtml(r[k])}</td>`;
        });
        html += '</tr>';
    });
    html += '</tbody></table></body></html>';
    return html;
}

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

const VOLUNTEER_FLAG_SQL = `CASE WHEN EXISTS (
                  SELECT 1 FROM seminar_volunteers sv
                  WHERE sv.seminar_id = r.seminar_id AND sv.user_id = r.user_id
                  AND LOWER(IFNULL(sv.status,'')) <> 'removed'
              ) THEN 'yes' ELSE 'no' END AS is_volunteer`;

const PERSON_COLS = `r.application_no, r.status, r.created_at, r.form_data,
              u.user_id_string, u.first_name, u.middle_name, u.last_name, u.email, u.phone`;

const TICKET_DAY_COLS = `t.ticket_id_string, t.is_scanned, t.scan_time, t.is_valid,
              sd.title AS day_title, sd.day_date`;

const TICKET_JOIN = `LEFT JOIN tickets t ON t.order_id = o.id
              LEFT JOIN seminar_days sd ON sd.id = t.day_id`;

function flag(v) {
    return v === true || Number(v) === 1 || String(v).toLowerCase() === 'true';
}

/**
 * Multi-day seminars produce one ticket row per day. Collapse them so each
 * application appears once, with every day ticket summarised in one cell.
 */
function collapseTicketRows(rows) {
    const byKey = new Map();
    (rows || []).forEach((row) => {
        const key = row.application_no || row.order_id_string || row.user_id_string;
        let agg = byKey.get(key);
        if (!agg) {
            agg = { row: { ...row }, ids: [], summaries: [], scanned: 0, firstScan: null };
            byKey.set(key, agg);
        }
        if (!row.ticket_id_string) return;
        const scanned = flag(row.is_scanned);
        const expired = row.is_valid != null && !flag(row.is_valid);
        const label = [row.day_title, row.day_date ? '(' + row.day_date + ')' : ''].filter(Boolean).join(' ');
        agg.ids.push(row.ticket_id_string);
        agg.summaries.push(`${label ? label + ': ' : ''}${row.ticket_id_string}${scanned ? ' - scanned' : ''}${expired ? ' - expired' : ''}`);
        if (scanned) {
            agg.scanned += 1;
            if (row.scan_time && (!agg.firstScan || row.scan_time < agg.firstScan)) agg.firstScan = row.scan_time;
        }
    });
    return Array.from(byKey.values()).map((agg) => {
        const out = { ...agg.row };
        delete out.day_title;
        delete out.day_date;
        delete out.is_valid;
        out.ticket_id_string = agg.ids.join(' | ');
        out.all_tickets = agg.summaries.join(' | ');
        out.tickets_count = agg.ids.length;
        out.scanned_count = agg.scanned;
        out.is_scanned = agg.scanned > 0 ? 'yes' : 'no';
        out.scan_time = agg.firstScan;
        return out;
    });
}

const REPORT_QUERIES = {
    pending: {
        sql: `SELECT ${PERSON_COLS}
              FROM registrations r JOIN users u ON u.id = r.user_id
              WHERE r.seminar_id = ?
              AND LOWER(IFNULL(r.status,'')) NOT IN ('completed','checked_in','cancelled','rejected','e_ticket_issued','certificate_issued','expired')
              ORDER BY r.created_at DESC`,
        title: 'Pending registrations (no e-ticket yet)'
    },
    paid: {
        sql: `SELECT r.application_no, r.status, r.form_data, u.user_id_string, u.first_name, u.middle_name, u.last_name, u.email, u.phone,
              o.order_id_string, o.amount, o.payment_date, o.payment_gateway, o.status AS order_status, ${VOLUNTEER_FLAG_SQL}
              FROM registrations r JOIN users u ON u.id = r.user_id
              JOIN orders o ON o.registration_id = r.id AND o.status = 'success' WHERE r.seminar_id = ?
              ORDER BY o.payment_date DESC`,
        title: 'Paid registrations'
    },
    unpaid: {
        sql: `SELECT ${PERSON_COLS}
              FROM registrations r JOIN users u ON u.id = r.user_id
              LEFT JOIN orders o ON o.registration_id = r.id AND o.status = 'success'
              WHERE r.seminar_id = ? AND o.id IS NULL AND LOWER(IFNULL(r.status,'')) NOT IN ('cancelled','rejected')`,
        title: 'Unpaid registrations'
    },
    e_tickets: {
        sql: `SELECT r.application_no, r.status, u.user_id_string, u.first_name, u.middle_name, u.last_name, u.email, u.phone,
              t.ticket_id_string, sd.title AS day_title, sd.day_date, t.is_scanned, t.scan_time, t.is_valid,
              CASE WHEN t.ticket_id_string LIKE 'VOL_%' THEN 'yes' ELSE 'no' END AS volunteer_ticket,
              o.order_id_string, o.amount, o.payment_gateway, o.payment_date, r.ticket_expired_at, r.form_data
              FROM tickets t
              JOIN orders o ON o.id = t.order_id
              JOIN registrations r ON r.id = o.registration_id
              JOIN users u ON u.id = r.user_id
              LEFT JOIN seminar_days sd ON sd.id = t.day_id
              WHERE r.seminar_id = ?
              ORDER BY u.last_name, u.first_name, sd.sort_order, t.id`,
        title: 'E-tickets (all issued tickets, one row per day ticket)'
    },
    cancelled: {
        sql: `SELECT r.application_no, r.status, r.created_at, r.updated_at, r.rejection_reason,
              u.user_id_string, u.first_name, u.middle_name, u.last_name, u.email, u.phone,
              o.order_id_string, o.amount, o.payment_date, o.payment_gateway, o.status AS order_status,
              o.refund_status AS order_refund_status, o.refunded_amount,
              cr.action_type, cr.initiated_by, cr.status AS cancellation_status, cr.reason AS cancellation_reason,
              cr.refund_percent, cr.refund_amount, cr.refund_status, cr.provider_refund_id, cr.requested_at, cr.reviewed_at, cr.admin_notes,
              CASE WHEN LOWER(IFNULL(r.status,'')) IN ('cancelled','rejected') THEN COALESCE(cr.reviewed_at, r.updated_at, r.created_at) END AS cancelled_on,
              (SELECT rf.status FROM refunds rf WHERE rf.registration_id = r.id ORDER BY rf.id DESC LIMIT 1) AS last_refund_status,
              (SELECT rf.bank_utr FROM refunds rf WHERE rf.registration_id = r.id ORDER BY rf.id DESC LIMIT 1) AS last_refund_utr,
              (SELECT rf.created_at FROM refunds rf WHERE rf.registration_id = r.id ORDER BY rf.id DESC LIMIT 1) AS last_refund_at,
              r.form_data
              FROM registrations r
              JOIN users u ON u.id = r.user_id
              LEFT JOIN orders o ON o.id = (SELECT o2.id FROM orders o2 WHERE o2.registration_id = r.id ORDER BY CASE WHEN o2.status = 'success' THEN 0 ELSE 1 END, o2.id DESC LIMIT 1)
              LEFT JOIN cancellation_requests cr ON cr.id = (SELECT cr2.id FROM cancellation_requests cr2 WHERE cr2.registration_id = r.id ORDER BY cr2.id DESC LIMIT 1)
              WHERE r.seminar_id = ?
              AND (LOWER(IFNULL(r.status,'')) IN ('cancelled','rejected') OR cr.id IS NOT NULL)
              ORDER BY r.updated_at DESC`,
        title: 'Cancelled / refund tracking'
    },
    checked_in: {
        sql: `SELECT u.user_id_string, u.first_name, u.middle_name, u.last_name, u.email, u.phone,
              r.application_no, r.status, r.form_data, t.ticket_id_string, sd.title AS day_title, sd.day_date, t.scan_time, t.is_scanned
              FROM tickets t JOIN orders o ON o.id = t.order_id
              JOIN registrations r ON r.id = o.registration_id JOIN users u ON u.id = r.user_id
              LEFT JOIN seminar_days sd ON sd.id = t.day_id
              WHERE r.seminar_id = ? AND t.is_scanned = 1
              ORDER BY t.scan_time DESC`,
        title: 'Checked in'
    },
    cert_eligible: {
        sql: `SELECT u.user_id_string, u.first_name, u.last_name, u.email, uc.display_name, uc.enabled, uc.scan_verified,
              r.application_no, r.form_data
              FROM user_certificates uc JOIN users u ON u.id = uc.user_id
              LEFT JOIN registrations r ON r.user_id = uc.user_id AND r.seminar_id = uc.seminar_id
              WHERE uc.seminar_id = ? AND uc.scan_verified = 1`,
        title: 'Certificate eligible'
    },
    all_participants: {
        sql: `SELECT ${PERSON_COLS},
              o.order_id_string, o.amount, o.status AS order_status, o.payment_date,
              ${TICKET_DAY_COLS}, ${VOLUNTEER_FLAG_SQL}
              FROM registrations r
              JOIN users u ON u.id = r.user_id
              LEFT JOIN orders o ON o.registration_id = r.id AND o.status = 'success'
              ${TICKET_JOIN}
              WHERE r.seminar_id = ? AND LOWER(IFNULL(r.status,'')) NOT IN ('cancelled','rejected')
              ORDER BY u.last_name, u.first_name, sd.sort_order`,
        title: 'All participants',
        collapseTickets: true
    },
    confirmed: {
        sql: CONFIRMED_EXPORT_SQL,
        title: 'Confirmed participants (approved + paid + verified)',
        postFilter: filterConfirmedRows,
        collapseTickets: true
    },
    pending_verification: {
        sql: `SELECT r.application_no, r.status, r.created_at, r.form_data, r.doc_review_json,
              u.user_id_string, u.first_name, u.middle_name, u.last_name, u.email, u.phone
              FROM registrations r JOIN users u ON u.id = r.user_id
              WHERE r.seminar_id = ?
                AND r.status IN ('submitted','waitlisted','pending_approval','revision_required')
              ORDER BY r.created_at DESC`,
        title: 'Pending verification'
    },
    attendance: {
        sql: `SELECT u.user_id_string, u.first_name, u.middle_name, u.last_name, u.email, u.phone,
              r.application_no, r.status, r.form_data, ${TICKET_DAY_COLS},
              o.payment_date, o.status AS order_status, ${VOLUNTEER_FLAG_SQL}
              FROM registrations r
              JOIN users u ON u.id = r.user_id
              INNER JOIN orders o ON o.registration_id = r.id AND o.status = 'success'
              ${TICKET_JOIN}
              WHERE r.seminar_id = ? AND LOWER(IFNULL(r.status,'')) NOT IN ('cancelled','rejected')
              ORDER BY u.last_name, u.first_name, sd.sort_order`,
        title: 'Attendance sheet',
        collapseTickets: true
    },
    check_in: {
        sql: `SELECT u.user_id_string, u.first_name, u.middle_name, u.last_name, u.email, u.phone,
              r.application_no, r.form_data, t.ticket_id_string, sd.title AS day_title, sd.day_date, t.scan_time,
              CASE WHEN t.ticket_id_string LIKE 'VOL_%' THEN 'yes' ELSE 'no' END AS volunteer_ticket
              FROM tickets t JOIN orders o ON o.id = t.order_id
              JOIN registrations r ON r.id = o.registration_id JOIN users u ON u.id = r.user_id
              LEFT JOIN seminar_days sd ON sd.id = t.day_id
              WHERE r.seminar_id = ? AND t.is_scanned = 1
              ORDER BY t.scan_time DESC`,
        title: 'Check-in report'
    },
    finance: {
        sql: `SELECT o.order_id_string, o.status, o.amount, o.payment_date, o.payment_gateway,
              o.provider_order_id, o.provider_transaction_id, o.refund_status, o.refunded_amount,
              r.application_no, r.status AS registration_status, u.user_id_string,
              u.first_name, u.last_name, u.email, u.phone
              FROM orders o
              JOIN registrations r ON r.id = o.registration_id
              JOIN users u ON u.id = r.user_id
              WHERE r.seminar_id = ?
              ORDER BY o.payment_date DESC, o.id DESC`,
        title: 'Finance report'
    },
    certificate_report: {
        sql: `SELECT r.application_no, r.status, u.user_id_string, u.first_name, u.middle_name, u.last_name, u.email, u.phone,
              CASE WHEN uc.id IS NULL THEN 'not created' WHEN uc.enabled = 1 THEN 'issued' ELSE 'created - not enabled' END AS certificate_status,
              uc.certificate_id_string, uc.display_name, uc.enabled, uc.scan_verified, uc.dispatched_at, uc.updated_at AS certificate_updated_at,
              ${VOLUNTEER_FLAG_SQL}, r.form_data
              FROM registrations r
              JOIN users u ON u.id = r.user_id
              LEFT JOIN user_certificates uc ON uc.id = (SELECT uc2.id FROM user_certificates uc2 WHERE uc2.user_id = r.user_id AND uc2.seminar_id = r.seminar_id ORDER BY uc2.id DESC LIMIT 1)
              WHERE r.seminar_id = ?
              AND LOWER(IFNULL(r.status,'')) IN ('e_ticket_issued','checked_in','completed','certificate_issued','expired')
              ORDER BY u.last_name, u.first_name`,
        title: 'Certificate report (all ticketed participants with certificate status)'
    }
};

module.exports = {
    REPORT_QUERIES,
    collapseTicketRows,
    parseFormData,
    flattenRow,
    toCsv,
    toXlsxBuffer,
    toHtmlTable
};
