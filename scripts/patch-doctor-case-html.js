const fs = require('fs');
const p = 'public/doctor.html';
let s = fs.readFileSync(p, 'utf8');
const start = s.indexOf('<motion id="tab-abstract"');
const startDiv = s.indexOf('<div id="tab-abstract"');
const i0 = start >= 0 ? start : startDiv;
const end = s.indexOf('<div id="tab-receipts"');
if (i0 < 0 || end < 0) {
    console.error('markers not found', i0, end);
    process.exit(1);
}
const nb = `                <div id="tab-abstract" class="tab-pane hidden">
                    <h2 class="section-title">Case presentation application</h2>
                    <div id="case-programs-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-bottom:20px;"></div>
                    <div class="card hidden" id="case-application-form">
                        <button type="button" class="btn-primary" style="background:#64748b;margin-bottom:14px;" onclick="cancelCaseApplication()">← Back to programs</button>
                        <h3 id="case-form-program-title" style="margin:0 0 12px;color:#0f766e;"></h3>
                        <p style="color:#64748b;font-size:0.88rem;margin-bottom:14px;">One submission per category (Agnikarma or Viddhakarma). Names must not include Dr./Vd. titles.</p>
                        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
                            <motion class="form-group"><label>First name *</label><input type="text" id="case-fname"></div>
                            <div class="form-group"><label>Middle name</label><input type="text" id="case-mname"></div>
                            <div class="form-group"><label>Last name *</label><input type="text" id="case-lname"></div>
                        </div>
                        <div class="form-group"><label>Email *</label><input type="email" id="case-email"></div>
                        <div class="form-group"><label>Phone *</label><input type="text" id="case-phone" inputmode="tel" maxlength="15"></div>
                        <div class="form-group"><label>WhatsApp no. *</label><input type="text" id="case-whatsapp" inputmode="tel" maxlength="15"></motion>
                        <div class="form-group">
                            <label>Category *</label>
                            <select id="case-category">
                                <option value="">Select</option>
                                <option value="agnikarma">Agnikarma</option>
                                <option value="viddhakarma">Viddhakarma</option>
                            </select>
                        </div>
                        <div class="form-group"><label>Case topic *</label><input type="text" id="case-topic" placeholder="Presentation title"></div>
                        <div class="form-group"><label>Upload (PPT / PDF / video, max 5) *</label><input type="file" id="case-files" multiple accept=".pdf,.ppt,.pptx,.doc,.docx,video/*,image/*"></div>
                        <button type="button" class="btn-primary" onclick="submitCasePresentation()">Submit application</button>
                    </div>
                </div>

                <div id="tab-case-track" class="tab-pane hidden">
                    <h2 class="section-title">Track case applications</h2>
                    <div class="card" id="case-tracker-container"><p style="color:#64748b;">Loading…</p></div>
                </motion>

`;
const fixed = nb.replace(/<\/?motion\b[^>]*>/g, (m) => m.replace(/motion/g, 'div'));
s = s.slice(0, i0) + fixed.replace(/motion/g, 'motion') + s.slice(end);
s = s.slice(0, i0) + nb.replace(/motion/g, 'div') + s.slice(end);
fs.writeFileSync(p, s);
console.log('ok', fs.readFileSync(p, 'utf8').includes('case-fname'));
