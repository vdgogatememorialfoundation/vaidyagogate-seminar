const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'public', 'doctor.html');
let html = fs.readFileSync(file, 'utf8');
if (html.includes('class="preview-shell"') && html.includes('preview-row')) {
    console.log('Already patched');
    process.exit(0);
}
const start = html.indexOf('<div id="step-5" class="form-step hidden">');
const end = html.indexOf('<div id="reg-submit-otp-panel"', start);
if (start < 0 || end < 0) {
    console.error('Markers not found', start, end);
    process.exit(1);
}
const lines = [
    '                        <div id="step-5" class="form-step hidden">',
    '                            <h4 style="color:#0f766e;margin-bottom:12px;">Preview &amp; submit</h4>',
    '                            <div class="preview-shell">',
    '                                <div class="preview-box">',
    '                                    <h5>Application summary</h5>',
    '                                    <div class="preview-row"><span class="lbl">Name</span><span class="val" id="prev-name"></span></div>',
    '                                    <div class="preview-row"><span class="lbl">Contact</span><span class="val" id="prev-contact"></span></div>',
    '                                    <motion class="preview-row"><span class="lbl">Address</span><span class="val" id="prev-addr"></span></div>',
    '                                    <div class="preview-row"><span class="lbl">Location</span><span class="val" id="prev-loc"></span></div>',
    '                                    <motion class="preview-row"><span class="lbl">Qualification</span><span class="val" id="prev-qual"></span></div>',
    '                                    <div id="prev-ncism-box" class="preview-row hidden"><span class="lbl">Reg. ID</span><span class="val" id="prev-ncism"></span></div>',
    '                                    <div id="prev-cert-box" class="preview-row hidden"><span class="lbl">Certificate</span><span class="val">Uploaded</span></div>',
    '                                    <div class="preview-row"><span class="lbl">College</span><span class="val" id="prev-college"></span></div>',
    '                                    <div class="preview-row"><span class="lbl">College loc.</span><span class="val" id="prev-cloc"></span></div>',
    '                                    <div id="prev-tnc-block" style="margin-top:14px;display:none;">',
    '                                        <h5 style="margin-bottom:8px;">Seminar terms</h5>',
    '                                        <div id="prev-tnc-text" style="white-space:pre-wrap;font-size:0.86rem;color:#475569;max-height:140px;overflow:auto;"></div>',
    '                                    </div>',
    '                                </div>',
    '                                <div>',
    '                                    <h5 style="margin:0 0 10px;color:#0f766e;font-size:0.78rem;text-transform:uppercase;letter-spacing:0.06em;font-weight:800;">PDF preview</h5>',
    '                                    <div class="preview-pdf-wrap">',
    '                                        <img id="prev-qrcode" alt="QR preview" style="display:none;">',
    '                                        <iframe id="pdf-viewer" title="Application preview PDF"></iframe>',
    '                                    </div>',
    '                                </div>',
    '                            </div>',
    '                            '
];
const newBlock = lines
    .join('\n')
    .replace(/<\/motion>/g, '</div>')
    .replace(/<motion class/g, '<div class');
html = html.slice(0, start) + newBlock + html.slice(end);
fs.writeFileSync(file, html);
console.log('Done');
