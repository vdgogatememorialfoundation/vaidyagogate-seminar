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
    XLSX.utils.book_append_sheet(wb, rowsToSheet(rows), sheetName || 'Report');
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

const REPORT_QUERIES = {
    pending: {
        sql: `SELECT r.application_no, r.status, r.created_at, r.form_data,
              u.user_id_string, u.first_name, u.middle_name, u.last_name, u.email, u.phone
              FROM registrations r JOIN users u ON u.id = r.user_id
              WHERE r.seminar_id = ? AND r.status NOT IN ('completed','checked_in','cancelled','rejected')`,
        title: 'Pending registrations'
    },
    paid: {
        sql: `SELECT r.application_no, r.status, r.form_data, u.user_id_string, u.first_name, u.middle_name, u.last_name, u.email, u.phone,
              o.order_id_string, o.amount, o.payment_date, o.payment_gateway, o.status AS order_status
              FROM registrations r JOIN users u ON u.id = r.user_id
              JOIN orders o ON o.registration_id = r.id AND o.status = 'success' WHERE r.seminar_id = ?`,
        title: 'Paid registrations'
    },
    unpaid: {
        sql: `SELECT r.application_no, r.status, r.form_data, u.user_id_string, u.first_name, u.middle_name, u.last_name, u.email, u.phone
              FROM registrations r JOIN users u ON u.id = r.user_id
              LEFT JOIN orders o ON o.registration_id = r.id AND o.status = 'success'
              WHERE r.seminar_id = ? AND o.id IS NULL AND r.status NOT IN ('cancelled','rejected')`,
        title: 'Unpaid registrations'
    },
    checked_in: {
        sql: `SELECT u.user_id_string, u.first_name, u.middle_name, u.last_name, u.email, u.phone,
              r.application_no, r.status, r.form_data, t.ticket_id_string, t.scan_time, t.is_scanned
              FROM tickets t JOIN orders o ON o.id = t.order_id
              JOIN registrations r ON r.id = o.registration_id JOIN users u ON u.id = r.user_id
              WHERE r.seminar_id = ? AND t.is_scanned = 1`,
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
        sql: `SELECT r.application_no, r.status, r.created_at, r.form_data,
              u.user_id_string, u.first_name, u.middle_name, u.last_name, u.email, u.phone,
              o.order_id_string, o.amount, o.status AS order_status, o.payment_date,
              t.ticket_id_string, t.is_scanned, t.scan_time
              FROM registrations r
              JOIN users u ON u.id = r.user_id
              LEFT JOIN orders o ON o.registration_id = r.id AND o.status = 'success'
              LEFT JOIN tickets t ON t.order_id = o.id
              WHERE r.seminar_id = ? AND r.status NOT IN ('cancelled','rejected')
              ORDER BY u.last_name, u.first_name`,
        title: 'All participants'
    },
    confirmed: {
        sql: CONFIRMED_EXPORT_SQL,
        title: 'Confirmed participants (approved + paid + verified)',
        postFilter: filterConfirmedRows
    },
    pending_verification: {
        sql: `SELECT r.application_no, r.status, r.created_at, r.form_data, r.doc_review_json,
              u.user_id_string, u.first_name, u.middle_name, u.last_name, u.email, u.phone
              FROM registrations r JOIN users u ON u.id = r.user_id
              WHERE r.seminar_id = ?
                AND r.status IN ('submitted','pending_approval','revision_required')
              ORDER BY r.created_at DESC`,
        title: 'Pending verification'
    },
    attendance: {
        sql: `SELECT u.user_id_string, u.first_name, u.middle_name, u.last_name, u.email, u.phone,
              r.application_no, r.status, r.form_data, t.ticket_id_string, t.is_scanned, t.scan_time,
              o.payment_date, o.status AS order_status
              FROM registrations r
              JOIN users u ON u.id = r.user_id
              INNER JOIN orders o ON o.registration_id = r.id AND o.status = 'success'
              LEFT JOIN tickets t ON t.order_id = o.id
              WHERE r.seminar_id = ?
              ORDER BY t.is_scanned DESC, u.last_name`,
        title: 'Attendance sheet'
    },
    check_in: {
        sql: `SELECT u.user_id_string, u.first_name, u.middle_name, u.last_name, u.email, u.phone,
              r.application_no, r.form_data, t.ticket_id_string, t.scan_time
              FROM tickets t JOIN orders o ON o.id = t.order_id
              JOIN registrations r ON r.id = o.registration_id JOIN users u ON u.id = r.user_id
              WHERE r.seminar_id = ? AND t.is_scanned = 1
              ORDER BY t.scan_time DESC`,
        title: 'Check-in report'
    },
    finance: {
        sql: `SELECT o.order_id_string, o.status, o.amount, o.payment_date, o.payment_gateway, o.created_at,
              r.application_no, r.status AS registration_status, u.user_id_string,
              u.first_name, u.last_name, u.email, u.phone
              FROM orders o
              JOIN registrations r ON r.id = o.registration_id
              JOIN users u ON u.id = r.user_id
              WHERE r.seminar_id = ?
              ORDER BY o.created_at DESC`,
        title: 'Finance report'
    },
    certificate_report: {
        sql: `SELECT u.user_id_string, u.first_name, u.last_name, u.email,
              uc.display_name, uc.enabled, uc.scan_verified, uc.updated_at,
              r.application_no, r.form_data, r.status
              FROM user_certificates uc
              JOIN users u ON u.id = uc.user_id
              LEFT JOIN registrations r ON r.user_id = uc.user_id AND r.seminar_id = uc.seminar_id
              WHERE uc.seminar_id = ?
              ORDER BY u.last_name`,
        title: 'Certificate report'
    }
};

module.exports = {
    REPORT_QUERIES,
    parseFormData,
    flattenRow,
    toCsv,
    toXlsxBuffer,
    toHtmlTable
};
