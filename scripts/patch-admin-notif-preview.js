const fs = require('fs');
const p = require('path').join(__dirname, '..', 'public', 'js', 'admin-notifications.js');
let s = fs.readFileSync(p, 'utf8');
const oldBlock = `        box.innerHTML =
            '<p><strong>Subject:</strong> ' +
            escNotif(data.emailSubject) +
            '</p><hr><div>' +
            (data.emailHtml || '') +
            '</motion><p><strong>WhatsApp:</strong></p><pre style="white-space:pre-wrap;">' +
            escNotif(data.whatsappBody) +
            '</pre>';`;
const oldBlockFixed = oldBlock.replace(/<\/motion>/g, '</div>');
if (!s.includes("'</p><hr><div>' +")) {
    console.log('pattern not found');
    process.exit(1);
}
const newBlock = `        const html = data.emailHtml || '';
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
        box.appendChild(waPre);`;
if (s.includes(oldBlock)) {
    s = s.replace(oldBlock, newBlock);
} else {
    s = s.replace(oldBlockFixed, newBlock);
}
if (!s.includes('function notifInsertEmailButton')) {
    s = s.replace(
        'async function notifSendTest() {',
        `function notifInsertEmailButton() {
    const ta = document.getElementById('notif-edit-email-body');
    if (!ta) return;
    const snippet =
        '<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:18px 0;"><tr><td style="border-radius:10px;background:#0f766e;"><a href="{{portal_login_url}}" target="_blank" style="display:inline-block;padding:14px 28px;color:#ffffff;font-size:15px;font-weight:bold;text-decoration:none;">Open portal</a></td></tr></table>';
    const start = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
    const end = ta.selectionEnd != null ? ta.selectionEnd : start;
    ta.value = ta.value.slice(0, start) + snippet + ta.value.slice(end);
    ta.focus();
}

async function notifSendTest() {`
    );
}
fs.writeFileSync(p, s);
console.log('patched admin-notifications.js');
