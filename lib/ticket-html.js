/**
 * Printable e-ticket HTML (email attachment + browser download).
 */
const QRCode = require('qrcode');
const { formatSeminarDateTime } = require('./seminar-datetime');

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/"/g, '&quot;');
}

function buildTicketHtml(row, qrDataUrl) {
    const name = escapeHtml(row.display_name || row.doctor_name || 'Participant');
    const title = escapeHtml(row.seminar_title || 'National Seminar');
    const etk = escapeHtml(row.ticket_id_string || '—');
    const appNo = escapeHtml(row.application_no || '—');
    const venue = escapeHtml(row.seminar_venue || row.location_url || '');
    const when = escapeHtml(row.event_date_fmt || '');
    const qr = qrDataUrl
        ? '<img src="' +
          qrDataUrl +
          '" alt="QR" style="width:160px;height:160px;border:1px solid #cbd5e1;border-radius:8px;">'
        : '';

    let html = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>E-Ticket ' + etk + '</title>';
    html += '<style>body{font-family:Segoe UI,sans-serif;margin:0;padding:24px;background:#f0fdfa;}';
    html += '.card{max-width:640px;margin:0 auto;background:#fff;border-radius:16px;box-shadow:0 8px 32px rgba(15,118,110,.12);}';
    html += '.head{background:linear-gradient(135deg,#0f766e,#134e4a);color:#fff;padding:22px 26px;}';
    html += '.head h1{margin:0;font-size:1.3rem;}.body{padding:22px 26px;display:grid;grid-template-columns:1fr auto;gap:18px;}';
    html += '.meta p{margin:6px 0;}.foot{padding:14px 26px;background:#f8fafc;font-size:.82rem;color:#64748b;}</style></head><body>';
    html += '<div class="card"><motion class="head"><h1>VGMF National Seminar</h1><p>E-Ticket · ' + title + '</p></div>';
    html += '<div class="body"><div class="meta">';
    html += '<p><strong>Participant</strong><br>' + name + '</p>';
    html += '<p><strong>E-ticket ID</strong><br><code>' + etk + '</code></p>';
    html += '<p><strong>Application ID</strong><br>' + appNo + '</p>';
    if (when) html += '<p><strong>Event</strong><br>' + when + '</p>';
    if (venue) html += '<p><strong>Venue</strong><br>' + venue + '</p>';
    html += '<p style="color:#b45309;font-weight:600;">Show this QR at the desk.</p></div><motion>' + qr + '</div></motion>';
    html += '<div class="foot">Vaidya Gogate Memorial Foundation</div></div></body></html>';
    return html.split('motion').join('div');
}

async function buildTicketHtmlFromRow(row) {
    const r = Object.assign({}, row);
    if (r.event_date && !r.event_date_fmt) {
        r.event_date_fmt = formatSeminarDateTime(r.event_date);
    }
    let qrDataUrl = '';
    if (r.qr_code_data) {
        try {
            qrDataUrl = await QRCode.toDataURL(String(r.qr_code_data), { margin: 1, width: 280 });
        } catch (_) {}
    }
    return buildTicketHtml(r, qrDataUrl);
}

module.exports = {
    buildTicketHtml,
    buildTicketHtmlFromRow
};
