/**
 * Move certificate tracking from dashboard to Certificates tab only (fix duplicate IDs).
 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'public', 'doctor.html');
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

const out = [];
let i = 0;
while (i < lines.length) {
    const line = lines[i];
    if (
        line.includes('Certificate tracking</h3>') &&
        i > 0 &&
        lines[i - 1].includes('margin-bottom:10px')
    ) {
        while (i < lines.length && !lines[i].includes('Quick links')) {
            i++;
        }
        continue;
    }
    if (line.includes('<motion id="tab-certificate"') || line.includes('<div id="tab-certificate"')) {
        out.push('                <div id="tab-certificate" class="tab-pane hidden">');
        out.push('                    <h2 class="section-title" style="color:#92400e;">Certificates</h2>');
        out.push(
            '                    <p style="color:#78716c;margin:-10px 0 16px;">Track check-in and approval status, then download your certificate when issued.</p>'
        );
        out.push(
            '                    <div class="card" style="margin-bottom:20px;border:1px solid #fde68a;background:#fffbeb;">'
        );
        out.push(
            '                        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:10px;">'
        );
        out.push(
            '                            <h3 style="color:#92400e;margin:0;font-size:1rem;"><i class="fas fa-route"></i> Certificate status</h3>'
        );
        out.push(
            '                            <span id="cert-track-live" style="font-size:0.8rem;color:#64748b;">Live status</span>'
        );
        out.push('                        </div>');
        out.push(
            '                        <p style="font-size:0.88rem;color:#64748b;margin:0 0 12px;">Venue check-in (ticket scan) is required before the foundation can approve your certificate. Status refreshes while you are on this page.</p>'
        );
        out.push(
            '                        <div id="doctor-cert-tracking-wrap"><p style="color:#94a3b8;text-align:center;">Loading status…</p></div>'
        );
        out.push('                    </div>');
        out.push(
            '                    <h3 style="color:#92400e;margin:0 0 10px;font-size:1rem;"><i class="fas fa-award"></i> Your certificates</h3>'
        );
        out.push(
            '                    <div id="doctor-certificates-wrap" class="card" style="border:1px solid #e8d48a;background:linear-gradient(180deg,#fffbeb 0%,#fff 50%);"><p style="color:#78716c;">Loading…</p></div>'
        );
        out.push('                </div>');
        i++;
        while (i < lines.length && !lines[i].includes('tab-reset-pwd')) {
            i++;
        }
        continue;
    }
    out.push(line);
    i++;
}

fs.writeFileSync(file, out.join('\n'), 'utf8');
console.log('Patched', file, 'lines:', out.length);
