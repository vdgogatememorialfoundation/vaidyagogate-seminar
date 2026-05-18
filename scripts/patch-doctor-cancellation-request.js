/**
 * Doctor portal: cancellation request form instead of direct cancel.
 */
const fs = require('fs');
const path = require('path');

const doctorHtml = path.join(__dirname, '..', 'public', 'doctor.html');
let html = fs.readFileSync(doctorHtml, 'utf8');
if (!html.includes('cancel-request-modal')) {
    const modal = `
    <div id="cancel-request-modal" class="hidden" style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:2100;display:flex;justify-content:center;align-items:center;padding:20px;">
        <div class="card" style="max-width:520px;width:100%;max-height:90vh;overflow:auto;">
            <h3 style="margin-top:0;">Request cancellation</h3>
            <p id="cancel-request-app-label" style="font-size:0.9rem;color:#64748b;"></p>
            <p id="cancel-request-policy" style="font-size:0.85rem;color:#78350f;background:#fffbeb;border:1px solid #fde68a;padding:10px;border-radius:8px;line-height:1.5;"></p>
            <label style="display:block;margin:12px 0 6px;font-weight:600;">Reason (required)</label>
            <textarea id="cancel-request-reason" rows="4" style="width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:8px;" placeholder="Please explain why you need to cancel (min. 10 characters)"></textarea>
            <p style="font-size:0.8rem;color:#64748b;margin-top:8px;">Our team will review your request and process any eligible refund per the seminar policy (Indian Standard Time). Direct cancellation is not available.</p>
            <div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap;">
                <button type="button" class="btn-primary" style="background:#b91c1c;border:none;" onclick="submitCancellationRequest()">Submit request</button>
                <button type="button" class="btn-primary" style="background:#64748b;" onclick="closeCancelRequestModal()">Close</button>
            </div>
        </div>
    </div>
`;
    const modalClean = modal;
    const anchor = '<div id="view-app-modal"';
    if (!html.includes(anchor)) {
        console.error('view-app-modal anchor missing');
        process.exit(1);
    }
    html = html.replace(anchor, modalClean + '\n    ' + anchor);
    fs.writeFileSync(doctorHtml, html);
    console.log('Added cancel-request-modal to doctor.html');
}

const doctorJs = path.join(__dirname, '..', 'public', 'js', 'doctor.js');
let js = fs.readFileSync(doctorJs, 'utf8');
if (js.includes('submitCancellationRequest')) {
    console.log('doctor.js already patched');
    process.exit(0);
}

js = js.replace(
    'async function doctorCancelApplication(applicationId) {',
    `let __cancelRequestAppId = null;
let __doctorCancelRequestsByReg = {};

async function loadDoctorCancellationRequests() {
    if (!currentUser || !currentUser.id) return;
    try {
        const res = await fetch('/api/doctor/cancellation-requests?userId=' + encodeURIComponent(currentUser.id));
        const rows = await res.json();
        __doctorCancelRequestsByReg = {};
        (Array.isArray(rows) ? rows : []).forEach((r) => {
            __doctorCancelRequestsByReg[r.registration_id] = r;
        });
    } catch (e) {
        console.warn('[cancel-req]', e);
    }
}

function doctorCancelRequestStatus(registrationId) {
    const r = __doctorCancelRequestsByReg[registrationId];
    if (!r) return '';
    const st = String(r.status || '').toLowerCase();
    if (st === 'pending') return 'Cancellation pending review';
    if (st === 'approved') return 'Cancellation approved';
    if (st === 'rejected') return 'Cancellation request rejected';
    return '';
}

function openCancelRequestModal(applicationId) {
    if (!currentUser || !currentUser.id) return;
    const app = (userApplications || []).find((a) => Number(a.id) === Number(applicationId));
    if (!app) return;
    if (!doctorCanCancelApplication(app)) {
        const gate = evaluateDoctorCancellationClient(app.cancellation_policy_json, app.seminar_event_date);
        alert(gate.reason || 'Cancellation request is not available.');
        return;
    }
    const pending = __doctorCancelRequestsByReg[applicationId];
    if (pending && pending.status === 'pending') {
        alert('You already have a pending cancellation request for this application.');
        return;
    }
    __cancelRequestAppId = applicationId;
    const label = document.getElementById('cancel-request-app-label');
    const pol = document.getElementById('cancel-request-policy');
    const reason = document.getElementById('cancel-request-reason');
    if (label) label.textContent = 'Application ' + (app.application_no || '') + ' — ' + (app.seminar_title || app.title || '');
    if (pol) pol.textContent = summaryCancellationPolicy(app.cancellation_policy_json) || 'Refund eligibility is calculated in IST when admin reviews your request.';
    if (reason) reason.value = '';
    const m = document.getElementById('cancel-request-modal');
    if (m) {
        m.classList.remove('hidden');
        m.style.display = 'flex';
    }
}

function closeCancelRequestModal() {
    __cancelRequestAppId = null;
    const m = document.getElementById('cancel-request-modal');
    if (m) {
        m.classList.add('hidden');
        m.style.display = '';
    }
}

async function submitCancellationRequest() {
    if (!currentUser || !currentUser.id || !__cancelRequestAppId) return;
    const reason = String(document.getElementById('cancel-request-reason')?.value || '').trim();
    if (reason.length < 10) {
        alert('Please enter at least 10 characters describing your reason.');
        return;
    }
    try {
        const res = await fetch('/api/doctor/cancellation-requests', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: currentUser.id,
                registrationId: __cancelRequestAppId,
                reason
            })
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Could not submit request.');
        const prev = data.refundPreview;
        let msg = data.message || 'Request submitted.';
        if (prev && prev.amount != null) {
            msg += '\\n\\nPolicy preview (IST): ' + (prev.percent || 0) + '% — ₹' + prev.amount + '. ' + (prev.reason || '');
        }
        alert(msg);
        closeCancelRequestModal();
        await loadDoctorCancellationRequests();
        loadApplications();
    } catch (e) {
        console.error(e);
        alert('Network error.');
    }
}

async function doctorCancelApplication(applicationId) {`
);

js = js.replace(
    `    if (!confirm(confirmMsg)) {
        return;
    }
    try {
        const res = await fetch(\`/api/applications/\${applicationId}/cancel\`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.id })
        });
        const data = await res.json();
        if (data.success) {
            alert(data.detail || 'Application cancelled. Your ticket is no longer valid for entry.');
            loadApplications();
            loadDoctorEventTickets();
        } else {
            alert(data.error || 'Could not cancel.');
        }
    } catch (e) {
        console.error(e);
        alert('Network error.');
    }
}`,
    `    openCancelRequestModal(applicationId);
    return;`
);

js = js.replace(
    `            const canDoctorCancel = doctorCanCancelApplication(a);
            const cancelBtn = canDoctorCancel
                ? \`<button type="button" class="btn-primary" style="padding: 5px 10px; margin-right: 5px; background: #b91c1c; border: none;" onclick="doctorCancelApplication(\${a.id})">Cancel</button>\`
                : '';`,
    `            const cancelStatus = doctorCancelRequestStatus(a.id);
            const canRequestCancel = doctorCanCancelApplication(a) && cancelStatus !== 'Cancellation pending review';
            let cancelBtn = '';
            if (cancelStatus) {
                cancelBtn = '<span style="font-size:0.78rem;color:#92400e;margin-right:6px;">' + escapeHtml(cancelStatus) + '</span>';
            } else if (canRequestCancel) {
                cancelBtn = '<button type="button" class="btn-primary" style="padding: 5px 10px; margin-right: 5px; background: #b91c1c; border: none;" onclick="openCancelRequestModal(' + a.id + ')">Request cancellation</button>';
            }`
);

js = js.replace(
    '        userApplications = Array.isArray(payload) ? payload : payload.applications || [];',
    `        userApplications = Array.isArray(payload) ? payload : payload.applications || [];
        await loadDoctorCancellationRequests();`
);

fs.writeFileSync(doctorJs, js);
console.log('Patched doctor.js cancellation requests');
