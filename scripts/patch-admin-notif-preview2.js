const fs = require('fs');
const p = require('path').join(__dirname, '..', 'public', 'js', 'admin-notifications.js');
let s = fs.readFileSync(p, 'utf8');
const start = s.indexOf('async function notifPreview()');
const end = s.indexOf('async function notifSendTest()');
if (start < 0 || end < 0) {
    console.log('markers not found');
    process.exit(1);
}
const fn = `async function notifPreview() {
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

`;
s = s.slice(0, start) + fn + s.slice(end);
fs.writeFileSync(p, s);
console.log('replaced notifPreview');
