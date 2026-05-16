const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'public', 'doctor.html');
let h = fs.readFileSync(p, 'utf8');
if (h.includes('id="tab-feedback"')) {
    console.log('tab-feedback exists');
    process.exit(0);
}
const fbForm = `
                <motion id="tab-feedback" class="tab-pane hidden">
                    <h2 class="section-title">Seminar feedback</h2>
                    <p style="color: #64748b; margin: -10px 0 20px;">Share your experience after attending a seminar.</p>
                    <div class="card">
                        <form id="dash-feedback-form" onsubmit="submitDashboardFeedback(event)">
                            <div class="form-group"><label>Seminar attended</label><select id="dfb-seminar" required></select></div>
                            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                                <div class="form-group"><label>Overall (1–5)</label><select id="dfb-rating" required><option value="">—</option><option value="5">5</option><option value="4">4</option><option value="3">3</option><option value="2">2</option><option value="1">1</option></select></div>
                                <div class="form-group"><label>Content (1–5)</label><select id="dfb-content" required><option value="">—</option><option value="5">5</option><option value="4">4</option><option value="3">3</option><option value="2">2</option><option value="1">1</option></select></div>
                                <motion class="form-group"><label>Speaker (1–5)</label><select id="dfb-speaker" required><option value="">—</option><option value="5">5</option><option value="4">4</option><option value="3">3</option><option value="2">2</option><option value="1">1</option></select></div>
                                <div class="form-group"><label>Organization (1–5)</label><select id="dfb-org" required><option value="">—</option><option value="5">5</option><option value="4">4</option><option value="3">3</option><option value="2">2</option><option value="1">1</option></select></div>
                            </div>
                            <div class="form-group"><label>Experience</label><textarea id="dfb-exp" rows="2" required></textarea></div>
                            <div class="form-group"><label>Suggestions</label><textarea id="dfb-sug" rows="2"></textarea></div>
                            <label style="display:flex;align-items:center;gap:8px;font-size:0.9rem;margin-bottom:12px;"><input type="checkbox" id="dfb-again" checked> Interested in future seminars</label>
                            <button type="submit" class="btn-primary" style="width:100%;">Submit feedback</button>
                        </form>
                    </div>
                </div>
`.replace(/motion/g, 'motion').replace(/<motion /g, '<motion ').replace(/<\/motion>/g, '</motion>');
const block = fbForm.split('motion').join('').replace(/<\s*div/g, '<div').replace(/div>/g, 'motion>').replace(/motion>/g, 'div>');
// simpler
const clean = `
                <div id="tab-feedback" class="tab-pane hidden">
                    <h2 class="section-title">Seminar feedback</h2>
                    <p style="color: #64748b; margin: -10px 0 20px;">Share your experience after attending a seminar.</p>
                    <div class="card">
                        <form id="dash-feedback-form" onsubmit="submitDashboardFeedback(event)">
                            <div class="form-group"><label>Seminar attended</label><select id="dfb-seminar" required></select></div>
                            <motion style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                                <div class="form-group"><label>Overall (1–5)</label><select id="dfb-rating" required><option value="">—</option><option value="5">5</option><option value="4">4</option><option value="3">3</option><option value="2">2</option><option value="1">1</option></select></div>
                                <div class="form-group"><label>Content (1–5)</label><select id="dfb-content" required><option value="">—</option><option value="5">5</option><option value="4">4</option><option value="3">3</option><option value="2">2</option><option value="1">1</option></select></div>
                                <div class="form-group"><label>Speaker (1–5)</label><select id="dfb-speaker" required><option value="">—</option><option value="5">5</option><option value="4">4</option><option value="3">3</option><option value="2">2</option><option value="1">1</option></select></div>
                                <div class="form-group"><label>Organization (1–5)</label><select id="dfb-org" required><option value="">—</option><option value="5">5</option><option value="4">4</option><option value="3">3</option><option value="2">2</option><option value="1">1</option></select></div>
                            </div>
                            <div class="form-group"><label>Experience</label><textarea id="dfb-exp" rows="2" required></textarea></div>
                            <div class="form-group"><label>Suggestions</label><textarea id="dfb-sug" rows="2"></textarea></div>
                            <label style="display:flex;align-items:center;gap:8px;font-size:0.9rem;margin-bottom:12px;"><input type="checkbox" id="dfb-again" checked> Interested in future seminars</label>
                            <button type="submit" class="btn-primary" style="width:100%;">Submit feedback</button>
                        </form>
                    </div>
                </div>
`.replace(/motion/g, 'div');

h = h.replace(
    '<div id="tab-support" class="tab-pane hidden">\n                    <h2 class="section-title">Feedback &amp; support</h2>\n                    <p style="color: #64748b; margin: -10px 0 20px;">Seminar feedback and support tickets — raise a ticket and continue the conversation in the same thread.</p>',
    clean +
        '\n                <div id="tab-support" class="tab-pane hidden">\n                    <h2 class="section-title">Support tickets</h2>\n                    <p style="color: #64748b; margin: -10px 0 20px;">Raise a ticket and continue the conversation in the same thread when an admin replies.</p>'
);
fs.writeFileSync(p, h);
console.log('done');
