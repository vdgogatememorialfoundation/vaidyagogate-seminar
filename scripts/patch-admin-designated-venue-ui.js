const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'public', 'admin.html');
let html = fs.readFileSync(file, 'utf8');

if (html.includes('id="dn-emails"')) {
    console.log('Already patched');
    process.exit(0);
}

const block = `
                <div class="card" style="margin-bottom:18px;border:1px solid #fde68a;background:#fffbeb;">
                    <h3 style="margin:0 0 10px;color:#92400e;font-size:1.05rem;">Account alerts (designated staff)</h3>
                    <p style="color:#64748b;font-size:0.88rem;margin-bottom:10px;">When someone creates a portal account (public signup or admin CRM), full user details are emailed and sent on WhatsApp to these contacts (one per line).</p>
                    <label style="font-size:0.82rem;font-weight:700;">Notification emails</label>
                    <textarea id="dn-emails" rows="2" style="width:100%;max-width:640px;margin:6px 0 12px;font-family:monospace;font-size:0.85rem;" placeholder="coordinator@example.org"></textarea>
                    <label style="font-size:0.82rem;font-weight:700;">WhatsApp numbers (with country code)</label>
                    <textarea id="dn-phones" rows="2" style="width:100%;max-width:640px;margin:6px 0 12px;font-family:monospace;font-size:0.85rem;" placeholder="9198xxxxxxxx"></textarea>
                    <button type="button" class="btn-primary" style="background:#b45309;" onclick="saveDesignatedNotifyConfig()">Save designated contacts</button>
                    <p id="dn-save-msg" style="margin-top:8px;font-weight:600;font-size:0.9rem;"></p>
                </div>
                <div class="card" style="margin-bottom:18px;border:1px solid #bbf7d0;background:#f0fdf4;">
                    <h3 style="margin:0 0 10px;color:#166534;font-size:1.05rem;">Venue change broadcast</h3>
                    <p style="color:#64748b;font-size:0.88rem;margin-bottom:10px;">After updating <em>Venue line</em> below, send email and WhatsApp to all <strong>paid</strong> registrants. Seminar dates in notifications use India Standard Time (IST).</p>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;max-width:720px;">
                        <div><label style="font-size:0.82rem;">Seminar (optional — blank = all)</label><select id="venue-broadcast-seminar" class="form-control"><option value="">All paid seminars</option></select></div>
                        <div><label style="font-size:0.82rem;">New venue / message</label><input type="text" id="venue-broadcast-msg" class="form-control" placeholder="Convention Centre Hall B, Pune"></div>
                    </div>
                    <motion style="margin-top:10px;display:flex;flex-wrap:wrap;gap:14px;font-size:0.9rem;">
                        <label><input type="checkbox" id="venue-broadcast-email" checked> Email</label>
                        <label><input type="checkbox" id="venue-broadcast-wa" checked> WhatsApp</label>
                    </div>
                    <button type="button" class="btn-primary" style="margin-top:12px;background:#15803d;" onclick="sendVenueBroadcast()">Send venue update to paid registrants</button>
                    <p id="venue-broadcast-status" style="margin-top:8px;font-weight:600;font-size:0.9rem;"></p>
                </div>
`.replace(/<motion /g, '<div ');

const re =
    /(<p id="pa-save-msg" style="margin-top:8px;font-weight:600;font-size:0\.9rem;"><\/p>\s*<\/div>\s*)(<motion class="card">|<div class="card">)/;

if (!re.test(html)) {
    console.error('Marker not found');
    process.exit(1);
}

html = html.replace(re, `$1${block}$2`);
fs.writeFileSync(file, html);
console.log('Patched admin.html');
