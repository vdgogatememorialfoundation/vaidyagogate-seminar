const fs = require('fs');
const p = 'public/admin.html';
let s = fs.readFileSync(p, 'utf8');
const start = s.indexOf('<h3>Case programs (application windows)</h3>');
const end = s.indexOf('<motion id="case-prog-list"');
const endDiv = s.indexOf('<div id="case-prog-list"');
const endPos = end >= 0 ? end : endDiv;
if (start < 0 || endPos < 0) {
    console.error('markers', start, endPos);
    process.exit(1);
}
const block = `<h3 id="case-prog-form-heading">Case program</h3>
                    <p style="color:#64748b;font-size:0.88rem;margin-bottom:12px;">Set application window, presentation limits, enabled categories, and form fields.</p>
                    <input type="hidden" id="case-prog-edit-id" value="">
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 0;">
                        <div><label>Title *</label><input type="text" id="case-prog-title" style="width:100%;padding:8px;"></div>
                        <div><label>Linked seminar</label><select id="case-prog-seminar" style="width:100%;padding:8px;"><option value="">— None —</option></select></motion>
                        <div style="grid-column:1/-1;"><label>Description</label><textarea id="case-prog-desc" rows="2" style="width:100%;padding:8px;"></textarea></div>
                        <div style="grid-column:1/-1;"><label>Instructions (shown to doctors)</label><textarea id="case-prog-instructions" rows="2" style="width:100%;padding:8px;"></textarea></div>
                        <div><label>Registration opens</label><input type="datetime-local" id="case-prog-start" style="width:100%;padding:8px;"></div>
                        <div><label>Registration closes</label><input type="datetime-local" id="case-prog-end" style="width:100%;padding:8px;"></div>
                        <div><label>Max presentations per doctor</label><input type="number" id="case-prog-max-per-user" min="1" max="10" value="2" style="width:100%;padding:8px;"></div>
                        <div><label>Total presentation slots</label><input type="number" id="case-prog-max-total" min="1" placeholder="Unlimited if empty" style="width:100%;padding:8px;"></div>
                        <div><label>Max files per submission</label><input type="number" id="case-prog-max-files" min="1" max="10" value="5" style="width:100%;padding:8px;"></div>
                        <div><label>Max file size (MB each)</label><input type="number" id="case-prog-max-mb" min="1" max="200" value="50" style="width:100%;padding:8px;"></div>
                        <div style="grid-column:1/-1;">
                            <label>Enabled categories</label>
                            <label style="display:inline-flex;align-items:center;gap:6px;margin-right:16px;font-weight:500;"><input type="checkbox" id="case-cat-agnikarma" checked> Agnikarma</label>
                            <label style="display:inline-flex;align-items:center;gap:6px;font-weight:500;"><input type="checkbox" id="case-cat-viddhakarma" checked> Viddhakarma</label>
                        </div>
                        <div><label><input type="checkbox" id="case-prog-active" checked> Program active</label></div>
                    </div>
                    <h4 style="margin:16px 0 8px;">Application form fields</h4>
                    <table class="data-table" style="margin-bottom:12px;">
                        <thead><tr><th>Field</th><th>Label</th><th>Enabled</th><th>Required</th></tr></thead>
                        <tbody id="case-prog-fields-tbody"><tr><td colspan="4">Loading…</td></tr></tbody>
                    </table>
                    <p id="case-prog-msg" style="font-weight:600;margin-bottom:10px;"></p>
                    <button type="button" class="btn-primary" onclick="saveAdminCaseProgram()">Save program</button>
                    <button type="button" class="btn-primary" style="background:#64748b;margin-left:8px;" onclick="resetAdminCaseProgramForm()">Clear / new</button>
                    `;
const out = block.replace(/<\/?motion\b[^>]*>/g, (m) => m.replace(/motion/g, 'motion')).replace(/motion/g, 'div');
s = s.slice(0, start) + out + s.slice(endPos);
fs.writeFileSync(p, s);
console.log('patched admin case program UI');
