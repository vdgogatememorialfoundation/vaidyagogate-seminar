const fs = require('fs');
const p = 'public/admin.html';
let s = fs.readFileSync(p, 'utf8');

const blockRe =
    /<div style="margin-top:10px;"><label class="hidden">Cancellation policy \(JSON\)<\/label><textarea id="seminar-cancellation-json"[\s\S]*?<\/textarea><\/div>\s*<div style="margin-top:10px;"><label>Registration form override \(JSON\)<\/label><textarea id="seminar-reg-form-json"[\s\S]*?<\/textarea><\/div>/;

const replacement = [
    '<div style="margin-top:14px;padding:12px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;">',
    '    <label style="font-weight:600;">Cancellation &amp; refund policy</label>',
    '    <p style="font-size:0.82rem;color:#64748b;margin:6px 0 10px;">Shown to doctors when they track or cancel an application.</p>',
    '    <div style="margin-bottom:10px;">',
    '        <label style="font-size:0.8rem;">No refund within (days of event)</label>',
    '        <input type="number" id="seminar-cancel-norefund-days" min="0" placeholder="e.g. 3" style="max-width:120px;" oninput="updateSeminarPolicyPreviews()">',
    '    </div>',
    '    <label style="font-size:0.8rem;">Refund tiers (optional)</label>',
    '    <div id="seminar-cancel-tiers"></div>',
    '    <button type="button" class="btn-primary" style="margin-top:8px;padding:4px 12px;font-size:0.82rem;background:#475569;" onclick="addSeminarCancelTierRow()">+ Add tier</button>',
    '    <p id="seminar-cancel-preview" style="margin-top:10px;font-size:0.88rem;color:#334155;background:#f8fafc;padding:10px;border-radius:6px;"></p>',
    '</div>',
    '<textarea id="seminar-cancellation-json" class="hidden" aria-hidden="true"></textarea>',
    '<div style="margin-top:14px;padding:12px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;">',
    '    <label style="font-weight:600;">Registration form override (this seminar)</label>',
    '    <p style="font-size:0.82rem;color:#64748b;margin:6px 0 10px;">Toggle fields for this seminar.</p>',
    '    <table class="data-table" style="font-size:0.88rem;">',
    '        <thead><tr><th>Field</th><th>Label</th><th>On</th><th>Required</th></tr></thead>',
    '        <tbody id="seminar-reg-override-tbody"></tbody>',
    '    </table>',
    '    <p id="seminar-form-preview" style="margin-top:10px;font-size:0.88rem;color:#334155;background:#f8fafc;padding:10px;border-radius:6px;"></p>',
    '</div>',
    '<textarea id="seminar-reg-form-json" class="hidden" aria-hidden="true"></textarea>'
].join('\n                    ');

if (!blockRe.test(s)) {
    console.error('block not found');
    process.exit(1);
}
s = s.replace(blockRe, replacement);

s = s.replace(
    'Cancellation policy JSON drives refund messaging (automated gateway refunds are not wired yet). Registration override uses the same <code>{"fields":[...]}</code> shape as the global form; leave empty to inherit.',
    'Cancellation policy is shown to doctors in plain language. Form override adjusts labels and which fields appear for this seminar only.'
);

fs.writeFileSync(p, s);
console.log('patched admin.html seminar UI');
