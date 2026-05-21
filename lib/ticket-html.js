/**
 * Printable e-ticket HTML (email attachment + browser download).
 */
const QRCode = require('qrcode');
const branding = require('./branding');
const { formatSeminarDateForTicketLine, formatScanDateTime } = require('./seminar-datetime');

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/"/g, '&quot;');
}

function isTruthyScanned(v) {
    return v === 1 || v === true || v === '1' || String(v).toLowerCase() === 'true';
}

function isPaidStatus(st) {
    return String(st || '').toLowerCase() === 'success';
}

function resolvePortalYear(row) {
    const py = row.portal_year;
    if (py != null && String(py).trim() !== '') return String(py).trim();
    const when = row.event_date;
    if (when) {
        const m = String(when).match(/^(\d{4})/);
        if (m) return m[1];
    }
    return String(new Date().getFullYear());
}

function buildQrBlock(row, qrDataUrl) {
    const scanned = isTruthyScanned(row.is_scanned);
    const paid = isPaidStatus(row.payment_status);
    const invalid = row.is_valid === 0 || row.is_valid === false;

    let stampHtml = '';
    if (scanned) {
        const when = row.scan_time_fmt
            ? `<div class="scan-when">Checked in · ${escapeHtml(row.scan_time_fmt)}</div>`
            : '';
        stampHtml =
            '<div class="stamp stamp-scanned" aria-hidden="true"><span>SCANNED</span></div>' + when;
    }

    const qrImg = qrDataUrl
        ? `<img class="qr-img${scanned ? ' qr-used' : ''}" src="${qrDataUrl}" alt="Entry QR code" draggable="false">`
        : '<div class="qr-missing">QR not available</div>';

    const hint = scanned
        ? '<p class="qr-hint scanned-hint">This QR was used at entry. Keep this copy for your records.</p>'
        : paid && !invalid
          ? '<p class="qr-hint">Show this QR at the registration desk.</p>'
          : !paid
            ? '<p class="qr-hint warn">Payment pending — QR may not be valid for entry.</p>'
            : '<p class="qr-hint">Show this QR at the registration desk.</p>';

    const paidBelow =
        paid && !invalid && !scanned ? '<p class="qr-paid-below" aria-hidden="true">PAID</p>' : '';

    return `<div class="qr-wrap">${qrImg}${stampHtml}${paidBelow}${hint}</div>`;
}

function buildTicketHtml(row, qrDataUrl) {
    const name = escapeHtml(row.display_name || row.doctor_name || 'Participant');
    const title = escapeHtml(row.seminar_title || 'National Seminar');
    const etk = escapeHtml(row.ticket_id_string || '—');
    const appNo = escapeHtml(row.application_no || '—');
    const venue = escapeHtml(row.seminar_venue || row.location_url || '');
    const when = escapeHtml(row.event_date_fmt || '');
    const foundation = escapeHtml(row.foundation_name || branding.FOUNDATION_NAME);
    const portalYear = escapeHtml(resolvePortalYear(row));
    const logoSrc = row.logo_data_url ? String(row.logo_data_url) : '';
    const logoBlock = logoSrc
        ? `<img class="brand-logo" src="${logoSrc.replace(/"/g, '&quot;')}" alt="" draggable="false">`
        : '';
    const qrBlock = buildQrBlock(row, qrDataUrl);

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>E-Ticket ${etk}</title>
<style>
body{font-family:'Segoe UI',system-ui,sans-serif;margin:0;padding:24px;background:#f0fdfa;-webkit-user-select:none;user-select:none;}
.card{max-width:640px;margin:0 auto;background:#fff;border-radius:16px;box-shadow:0 8px 32px rgba(15,118,110,.12);overflow:hidden;}
.head{background:linear-gradient(135deg,#0f766e,#134e4a);color:#fff;padding:20px 26px;}
.brand-row{display:flex;align-items:center;gap:14px;margin-bottom:12px;}
.brand-logo{max-height:52px;max-width:120px;object-fit:contain;background:#fff;border-radius:8px;padding:4px;-webkit-user-drag:none;}
.brand-text{flex:1;min-width:0;}
.foundation{font-size:.95rem;font-weight:700;line-height:1.25;opacity:.98;}
.portal-year{font-size:.82rem;opacity:.88;margin-top:2px;}
.head h1{margin:0;font-size:1.15rem;font-weight:800;}
.head .seminar-line{margin:6px 0 0;opacity:.92;font-size:.9rem;}
.body{padding:22px 26px;display:grid;grid-template-columns:1fr auto;gap:20px;align-items:start;}
.meta p{margin:8px 0;font-size:.92rem;line-height:1.45;}
.meta strong{color:#0f766e;}
.qr-wrap{position:relative;width:168px;text-align:center;}
.qr-img{width:160px;height:160px;border:1px solid #cbd5e1;border-radius:10px;background:#fff;-webkit-user-drag:none;}
.qr-img.qr-used{opacity:.32;filter:grayscale(1);}
.qr-missing{width:160px;height:160px;border:1px dashed #cbd5e1;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:.8rem;color:#94a3b8;padding:8px;}
.stamp{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;}
.stamp span{display:inline-block;transform:rotate(-14deg);font-weight:900;letter-spacing:.14em;padding:10px 18px;border-radius:10px;font-size:1.15rem;box-shadow:0 4px 14px rgba(0,0,0,.12);}
.stamp-paid span{color:#047857;border:4px solid #059669;background:rgba(236,253,245,.94);}
.stamp-scanned span{color:#b45309;border:4px solid #d97706;background:rgba(255,251,235,.94);}
.scan-when{margin-top:8px;font-size:.72rem;color:#047857;font-weight:700;line-height:1.3;}
.qr-paid-below{margin:8px 0 0;font-size:.82rem;font-weight:800;letter-spacing:.12em;color:#047857;text-align:center;}
.qr-hint{margin:10px 0 0;font-size:.78rem;color:#64748b;max-width:168px;line-height:1.35;}
.qr-hint.scanned-hint{color:#b45309;font-weight:600;}
.qr-hint.warn{color:#b91c1c;}
.foot{padding:14px 26px;background:#f8fafc;font-size:.82rem;color:#64748b;border-top:1px solid #e2e8f0;text-align:center;}
@media print{body{padding:0;background:#fff;-webkit-user-select:text;user-select:text}.card{box-shadow:none}}
</style>
</head>
<body oncontextmenu="return false" ondragstart="return false">
<div class="card">
  <div class="head">
    <div class="brand-row">
      ${logoBlock}
      <div class="brand-text">
        <div class="foundation">${foundation}</div>
        <div class="portal-year">National Seminar ${portalYear}</div>
      </div>
    </div>
    <h1>E-Ticket</h1>
    <p class="seminar-line">${title}</p>
  </div>
  <div class="body">
    <div class="meta">
      <p><strong>Participant</strong><br>${name}</p>
      <p><strong>E-ticket ID</strong><br><code>${etk}</code></p>
      <p><strong>Application ID</strong><br>${appNo}</p>
      ${when ? `<p><strong>Event date</strong><br>${when}</p>` : ''}
      ${venue ? `<p><strong>Venue</strong><br>${venue}</p>` : ''}
    </div>
    ${qrBlock}
  </div>
  <div class="foot">${foundation} · ${portalYear} · Computer-generated e-ticket</div>
</div>
<script>
document.addEventListener('contextmenu',function(e){e.preventDefault();});
document.addEventListener('copy',function(e){e.preventDefault();});
document.addEventListener('cut',function(e){e.preventDefault();});
document.addEventListener('dragstart',function(e){if(e.target&&e.target.tagName==='IMG')e.preventDefault();});
</script>
</body>
</html>`;

    return html;
}

async function buildTicketHtmlFromRow(row, db) {
    const r = Object.assign({}, row);
    if (r.event_date && !r.event_date_fmt) {
        r.event_date_fmt = formatSeminarDateForTicketLine(r.event_date);
    }
    if (r.scan_time && !r.scan_time_fmt) {
        r.scan_time_fmt = formatScanDateTime(r.scan_time);
    }
    if (db && !r.logo_data_url) {
        r.logo_data_url = await new Promise((resolve) => {
            branding.loadSiteLogoDataUrl(db, (e, url) => resolve(e ? '' : url || ''));
        });
    }
    if (!r.foundation_name) r.foundation_name = branding.FOUNDATION_NAME;
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
