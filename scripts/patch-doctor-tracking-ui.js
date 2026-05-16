const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'public', 'js', 'doctor.js');
let s = fs.readFileSync(p, 'utf8');

const anchor = "document.addEventListener('visibilitychange', () => syncDoctorTrackingPolls());";
const helpers = `

let doctorPortalYear = new Date().getFullYear();

function formatTrackDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString(undefined, {
        weekday: 'long',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function renderTrackerStepsHtml(timeline) {
    if (!timeline) return '';
    if (timeline.disqualified) {
        return (
            '<p style="color:#b91c1c;">Disqualified' +
            (timeline.disqualifiedAt ? ' · ' + escapeHtml(formatTrackDateTime(timeline.disqualifiedAt)) : '') +
            '</p>'
        );
    }
    if (timeline.rejected) {
        return '<p style="color:#b91c1c;">This application was rejected or cancelled.</p>';
    }
    const steps = timeline.steps || [];
    let html = '<div class="tracker-vertical">';
    steps.forEach((step) => {
        const cls = step.state === 'completed' ? 'completed' : step.state === 'active' ? 'active' : '';
        const when = step.at
            ? '<p class="track-when" style="font-size:0.78rem;color:#0f766e;margin:4px 0 0;font-weight:600;">' +
              escapeHtml(formatTrackDateTime(step.at)) +
              '</p>'
            : '';
        html +=
            '<div class="track-step ' +
            cls +
            '"><motion class="track-icon"><i class="fas ' +
            (step.icon || 'fa-circle') +
            '"></i></div><div class="track-content"><div class="track-title">' +
            escapeHtml(step.title || '') +
            '</div><div class="track-desc">' +
            escapeHtml(step.desc || '') +
            '</div>' +
            when +
            '</div></div>';
    });
    html += '</div>';
    return html.replace(/<\/?motion\b[^>]*>/g, (t) => t.replace(/motion/g, 'div'));
}

function renderSeminarApplicationTrackerCard(a) {
    const tl = a.timeline || {};
    const payAmt = Number(a.seminar_price) > 0 ? Number(a.seminar_price) : 1500;
    const st = String(a.status || '').toLowerCase();
    const isApproved =
        st === 'approved_pending_payment' || st === 'completed' || st === 'checked_in';
    const isPaid = st === 'completed' || st === 'checked_in';
    const payBtn =
        isApproved && !isPaid
            ? '<button class="btn-success" style="margin-top:10px;" onclick="processPayment(' +
              a.id +
              ', ' +
              payAmt +
              ", '" +
              String(a.application_no).replace(/'/g, "\\'") +
              "')\">Make Payment (₹" +
              payAmt +
              ')</button>'
            : '';
    const yearBadge = a.portal_year
        ? '<span style="font-size:0.75rem;background:#e0f2fe;color:#0369a1;padding:2px 8px;border-radius:6px;margin-left:8px;">' +
          escapeHtml(String(a.portal_year)) +
          '</span>'
        : '';
    return (
        '<div class="card" style="margin-bottom:15px;border-top:4px solid #1a237e;">' +
        '<h4 style="color:#1a237e;margin-bottom:16px;"><i class="fas fa-calendar-check"></i> Seminar · ' +
        escapeHtml(a.application_no) +
        (a.seminar_title ? ' · ' + escapeHtml(a.seminar_title) : '') +
        yearBadge +
        '</h4>' +
        renderTrackerStepsHtml(tl) +
        payBtn +
        '</div>'
    );
}

function renderCaseApplicationTrackerCard(c) {
    const tl = c.timeline || {};
    const appId = escapeHtml(c.application_no || String(c.id));
    const prog = c.program_title ? ' · ' + escapeHtml(c.program_title) : '';
    const meta = escapeHtml(c.category || '') + ' · ' + escapeHtml(c.title || '');
    const yearBadge = c.portal_year
        ? '<span style="font-size:0.75rem;background:#ccfbf1;color:#0f766e;padding:2px 8px;border-radius:6px;margin-left:8px;">' +
          escapeHtml(String(c.portal_year)) +
          '</span>'
        : '';
    return (
        '<div class="card" style="margin-bottom:15px;border-top:4px solid #0f766e;">' +
        '<h4 style="color:#0f766e;margin-bottom:16px;"><i class="fas fa-briefcase-medical"></i> Case · ' +
        appId +
        prog +
        yearBadge +
        '</h4><p style="font-size:0.88rem;color:#64748b;margin:-8px 0 12px;">' +
        meta +
        '</p>' +
        renderTrackerStepsHtml(tl) +
        '</div>'
    );
}

async function loadDoctorPortalYear() {
    try {
        const res = await fetch('/api/portal/year', { cache: 'no-store' });
        const data = await res.json();
        if (data && data.portalYear) doctorPortalYear = data.portalYear;
        const lbl = document.getElementById('doctor-portal-year-label');
        if (lbl) lbl.textContent = String(doctorPortalYear);
    } catch (e) {
        console.error(e);
    }
}
`;

if (!s.includes('function formatTrackDateTime')) {
    s = s.replace(anchor, anchor + helpers);
}

s = s.replace(
    '    loadProfile();\n    loadSeminarsGrid();\n    loadApplications();',
    '    loadProfile();\n    loadDoctorPortalYear().then(() => {\n        loadSeminarsGrid();\n        loadApplications();\n    });'
);

fs.writeFileSync(p, s);
console.log('helpers inserted');
