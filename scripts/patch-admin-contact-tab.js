const fs = require('fs');
const p = require('path').join(__dirname, '..', 'public', 'admin.html');
let s = fs.readFileSync(p, 'utf8');
if (s.includes('id="tab-contact-inquiries"')) {
    console.log('already has contact tab');
    process.exit(0);
}
const block = `
            <div id="tab-contact-inquiries" class="tab-pane hidden">
                <h2 style="margin-bottom: 20px;">Website contact requests</h2>
                <p style="color:#64748b;margin:-8px 0 16px;">Messages from the public site contact form.</p>
                <div class="card">
                    <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;">
                        <select id="contact-inquiry-filter" onchange="loadContactInquiries()" style="min-width:160px;">
                            <option value="">All statuses</option>
                            <option value="new">New</option>
                            <option value="in_progress">In progress</option>
                            <option value="replied">Replied</option>
                            <option value="closed">Closed</option>
                        </select>
                        <button type="button" class="btn-primary" onclick="loadContactInquiries()"><i class="fas fa-sync"></i> Refresh</button>
                    </div>
                    <table class="data-table">
                        <thead><tr><th>Date</th><th>Name</th><th>Email</th><th>Phone</th><th>Subject</th><th>Status</th><th>Action</th></tr></thead>
                        <tbody id="contact-inquiries-list"><tr><td colspan="7" style="text-align:center;">Loading…</td></tr></tbody>
                    </table>
                </div>
                <div id="contact-inquiry-detail" class="card hidden" style="margin-top:16px;">
                    <h3 style="margin-bottom:12px;color:#0f766e;">Inquiry detail</h3>
                    <div id="contact-inquiry-detail-body"></motion>
                    <div style="margin-top:14px;display:grid;gap:10px;max-width:480px;">
                        <label>Status</label>
                        <select id="contact-inquiry-status">
                            <option value="new">New</option>
                            <option value="in_progress">In progress</option>
                            <option value="replied">Replied</option>
                            <option value="closed">Closed</option>
                        </select>
                        <label>Admin notes (internal)</label>
                        <textarea id="contact-inquiry-notes" rows="3" placeholder="Call back, sent email, etc."></textarea>
                        <button type="button" class="btn-primary" onclick="saveContactInquiryUpdate()">Save update</button>
                    </div>
                </div>
            </div>

`;
s = s.replace('            <!-- 5. Support Tickets -->', block + '            <!-- 5. Support Tickets -->');
s = s.replace(/<\/motion>/g, '</div>').replace(/<motion\b/g, '<div');
fs.writeFileSync(p, s);
console.log('patched admin contact tab');
