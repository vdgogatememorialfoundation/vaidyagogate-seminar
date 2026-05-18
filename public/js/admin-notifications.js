/** Admin notification templates (email + WhatsApp). */
let __notifEvents = [];
let __notifSeminars = [];

function escNotif(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatNotifLogTimeIst(raw) {
    if (!raw) return '—';
    const s = String(raw).trim();
    const d = /Z$|[+-]\d{2}/.test(s) ? new Date(s) : new Date(s.replace(' ', 'T') + 'Z');
    if (Number.isNaN(d.getTime())) return s.slice(0, 19);
    return (
        d.toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        }) + ' IST'
    );
}

async function initAdminNotificationsTab() {
    await Promise.all([loadNotifEvents(), loadNotifSeminarsForFilter()]);
    loadNotificationTemplatesList();
    loadNotificationLogs();
}

async function loadNotifEvents() {
    try {
        const res = await fetch('/api/admin/notification-events');
        const data = await res.json();
        __notifEvents = data.events || [];
        const sel = document.getElementById('notif-event-filter');
        const editSel = document.getElementById('notif-edit-event');
        if (sel) {
            sel.innerHTML = '<option value="">All events</option>' + __notifEvents.map((e) => `<option value="${escNotif(e)}">${escNotif(e)}</option>`).join('');
        }
        if (editSel) {
            editSel.innerHTML = __notifEvents.map((e) => `<option value="${escNotif(e)}">${escNotif(e)}</option>`).join('');
        }
    } catch (e) {
        console.error(e);
    }
}

async function loadNotifSeminarsForFilter() {
    try {
        const res = await fetch('/api/admin/seminars');
        const rows = await res.json();
        __notifSeminars = Array.isArray(rows) ? rows : [];
        const sel = document.getElementById('notif-seminar-filter');
        if (!sel) return;
        sel.innerHTML =
            '<option value="">All scopes</option>' +
            __notifSeminars.map((s) => `<option value="${s.id}">${escNotif(s.title || s.id)}</option>`).join('');
    } catch (e) {
        console.error(e);
    }
}

async function loadNotificationTemplatesList() {
    const tbody = document.getElementById('notif-templates-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">Loading…</td></tr>';
    const eventKey = (document.getElementById('notif-event-filter') || {}).value || '';
    const seminarId = (document.getElementById('notif-seminar-filter') || {}).value || '';
    let url = '/api/admin/notification-templates';
    if (seminarId) url += '?seminarId=' + encodeURIComponent(seminarId);
    try {
        const res = await fetch(url);
        let rows = await res.json();
        if (!Array.isArray(rows)) rows = [];
        if (eventKey) rows = rows.filter((r) => r.event_key === eventKey);
        if (!rows.length) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">No templates. Click “Seed missing defaults”.</td></tr>';
            return;
        }
        tbody.innerHTML = rows
            .map((r) => {
                const scope = r.seminar_id ? `Seminar #${r.seminar_id}` : 'Global';
                const ch =
                    r.channel === 'email'
                        ? 'Email'
                        : r.channel === 'whatsapp'
                          ? 'WhatsApp'
                          : 'Both';
                return `<tr>
                    <td><code>${escNotif(r.event_key)}</code></td>
                    <td>${escNotif(ch)}</td>
                    <td>${r.enabled ? 'Yes' : 'No'}</td>
                    <td>${escNotif(scope)}</td>
                    <td>${escNotif((r.updated_at || '').slice(0, 16))}</td>
                    <td><button type="button" class="btn btn-secondary btn-sm" onclick="notifEditTemplate(${r.id})">Edit</button></td>
                </tr>`;
            })
            .join('');
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#b91c1c;">Failed to load</td></tr>';
    }
}

function notifOpenEditor() {
    document.getElementById('notif-edit-id').value = '';
    document.getElementById('notif-editor-title').textContent = 'New seminar override';
    document.getElementById('notif-edit-seminar-id').value =
        (document.getElementById('notif-seminar-filter') || {}).value || '';
    document.getElementById('notif-edit-enabled').checked = true;
    document.getElementById('notif-edit-channel').value = 'both';
    document.getElementById('notif-edit-email-subject').value = '';
    document.getElementById('notif-edit-email-body').value = '';
    document.getElementById('notif-edit-wa-body').value = '';
    document.getElementById('notif-edit-wa-template').value = '';
    document.getElementById('notif-preview-box').classList.add('hidden');
    document.getElementById('notif-editor-panel').classList.remove('hidden');
}

async function notifEditTemplate(id) {
    try {
        const res = await fetch('/api/admin/notification-templates/' + id);
        const r = await res.json();
        if (!res.ok) return alert(r.error || 'Not found');
        document.getElementById('notif-edit-id').value = r.id;
        document.getElementById('notif-editor-title').textContent = 'Edit: ' + r.event_key;
        document.getElementById('notif-edit-event').value = r.event_key;
        document.getElementById('notif-edit-seminar-id').value = r.seminar_id != null ? r.seminar_id : '';
        document.getElementById('notif-edit-enabled').checked = !!r.enabled;
        document.getElementById('notif-edit-channel').value = r.channel || 'both';
        document.getElementById('notif-edit-email-subject').value = r.email_subject || '';
        document.getElementById('notif-edit-email-body').value = r.email_html || '';
        document.getElementById('notif-edit-wa-body').value = r.whatsapp_body || '';
        document.getElementById('notif-edit-wa-template').value = r.whatsapp_template_name || '';
        document.getElementById('notif-preview-box').classList.add('hidden');
        document.getElementById('notif-editor-panel').classList.remove('hidden');
    } catch (e) {
        alert('Could not load template');
    }
}

function notifPayloadFromForm() {
    return {
        event_key: document.getElementById('notif-edit-event').value,
        seminar_id: document.getElementById('notif-edit-seminar-id').value,
        enabled: document.getElementById('notif-edit-enabled').checked,
        channel: document.getElementById('notif-edit-channel').value,
        email_subject: document.getElementById('notif-edit-email-subject').value,
        email_html: document.getElementById('notif-edit-email-body').value,
        whatsapp_body: document.getElementById('notif-edit-wa-body').value,
        whatsapp_template_name: document.getElementById('notif-edit-wa-template').value
    };
}

async function notifSaveTemplate() {
    const id = document.getElementById('notif-edit-id').value;
    const body = notifPayloadFromForm();
    if (!body.event_key) return alert('Select an event');
    try {
        const res = await fetch(
            id ? '/api/admin/notification-templates/' + id : '/api/admin/notification-templates',
            {
                method: id ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            }
        );
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Save failed');
        alert('Saved');
        document.getElementById('notif-editor-panel').classList.add('hidden');
        loadNotificationTemplatesList();
    } catch (e) {
        alert('Save failed');
    }
}

async function notifPreview() {
    const body = notifPayloadFromForm();
    try {
        const res = await fetch('/api/admin/notification-templates/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        const box = document.getElementById('notif-preview-box');
        if (!box) return;
        box.classList.remove('hidden');
        const html = data.emailHtml || '';
        box.innerHTML =
            '<p><strong>Subject:</strong> ' +
            escNotif(data.emailSubject) +
            '</p><p style="font-size:0.78rem;color:#64748b;margin:8px 0;">Email preview (buttons render below):</p>';
        const frame = document.createElement('iframe');
        frame.className = 'notif-preview-frame';
        frame.title = 'Email preview';
        frame.setAttribute('sandbox', '');
        frame.srcdoc =
            '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:12px;font-family:Arial,sans-serif;">' +
            html +
            '</body></html>';
        box.appendChild(frame);
        const waLabel = document.createElement('p');
        waLabel.style.marginTop = '12px';
        waLabel.innerHTML = '<strong>WhatsApp:</strong>';
        box.appendChild(waLabel);
        const waPre = document.createElement('pre');
        waPre.style.cssText = 'white-space:pre-wrap;background:#fff;padding:10px;border-radius:6px;border:1px solid #e2e8f0;';
        waPre.textContent = data.whatsappBody || '';
        box.appendChild(waPre);
    } catch (e) {
        alert('Preview failed');
    }
}

async function notifSendTest() {
    const dest = (document.getElementById('notif-test-dest') || {}).value.trim();
    if (!dest) return alert('Enter test email or phone in the Test field');
    const body = notifPayloadFromForm();
    body.destination = dest;
    body.channel = (document.getElementById('notif-test-channel') || {}).value || 'email';
    try {
        const res = await fetch('/api/admin/notification-templates/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Send failed');
        alert('Test sent (check logs if not received)');
        loadNotificationLogs();
    } catch (e) {
        alert('Send failed');
    }
}

async function notifSeedDefaults() {
    if (!confirm('Insert any missing default templates? Existing rows are not overwritten.')) return;
    try {
        const res = await fetch('/api/admin/notification-templates/seed', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Seed failed');
        alert('Defaults seeded');
        loadNotificationTemplatesList();
    } catch (e) {
        alert('Seed failed');
    }
}

async function loadNotificationLogs() {
    const tbody = document.getElementById('notif-logs-tbody');
    if (!tbody) return;
    const status = (document.getElementById('notif-log-status') || {}).value || '';
    try {
        const res = await fetch('/api/admin/notification-logs?limit=150');
        let rows = await res.json();
        if (!Array.isArray(rows)) rows = [];
        if (status) {
            rows = rows.filter((r) => {
                if (r.status === status) return true;
                if (status === 'sent' && r.status === 'accepted') return true;
                return false;
            });
        }
        if (!rows.length) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">No logs yet</td></tr>';
            return;
        }
        tbody.innerHTML = rows
            .map(
                (r) => `<tr>
            <td>${escNotif(formatNotifLogTimeIst(r.created_at))}</td>
            <td><code>${escNotif(r.event_key)}</code></td>
            <td>${escNotif(r.channel)}</td>
            <td>${escNotif(r.destination)}</td>
            <td>${escNotif(r.status)}</td>
            <td>${escNotif(r.error || '')}</td>
        </tr>`
            )
            .join('');
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="6">Failed to load logs</td></tr>';
    }
}

async function notifRetryFailed() {
    try {
        const res = await fetch('/api/admin/notification-queue/retry-failed', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Retry failed');
        alert('Queued items marked for retry');
        loadNotificationLogs();
    } catch (e) {
        alert('Retry failed');
    }
}
