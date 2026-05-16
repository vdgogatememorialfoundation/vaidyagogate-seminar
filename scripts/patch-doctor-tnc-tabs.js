const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'public', 'doctor.html');
let h = fs.readFileSync(p, 'utf8');

if (!h.includes('ind-step-0')) {
    h = h.replace(
        '<span class="step active" id="ind-step-1">1. Personal</span>',
        '<span class="step active" id="ind-step-0">Terms</span>\n                            <span class="step" id="ind-step-1">1. Personal</span>'
    );
}

if (!h.includes('id="step-0"')) {
    const tncBlock = `
                        <motion id="step-0" class="form-step">
                            <h4 style="color:#1a237e;margin-bottom:10px;">Terms &amp; conditions</h4>
                            <p style="color:#64748b;font-size:0.88rem;margin-bottom:12px;">Read and accept the seminar terms before filling the registration form.</p>
                            <div id="reg-tnc-text" style="max-height:320px;overflow-y:auto;padding:16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:0.9rem;line-height:1.55;white-space:pre-wrap;margin-bottom:16px;">Loading terms…</div>
                            <label style="display:flex;align-items:flex-start;gap:10px;margin-bottom:16px;font-size:0.9rem;">
                                <input type="checkbox" id="reg-tnc-accept" style="margin-top:4px;">
                                <span>I have read and accept the Terms &amp; Conditions for this seminar.</span>
                            </label>
                            <button type="button" class="btn-primary" onclick="proceedFromSeminarTnc()">Continue to application</button>
                            <button type="button" class="btn-primary" style="background:#64748b;margin-left:8px;" onclick="cancelRegistration()">Cancel</button>
                        </div>

`.replace(/motion/g, 'motion').replace(/<motion /g, '<div ').replace(/<\/motion>/g, '</motion>').replace(/<\/motion>/g, '</motion>');
    const fixed = tncBlock.replace(/motion/g, 'div');
    h = h.replace('<div id="reg-seminar-otp-panel"', fixed + '<motion id="reg-seminar-otp-panel"').replace('<motion id="reg-seminar-otp-panel"', '<div id="reg-seminar-otp-panel"');
}

// Split support tab into feedback + support
if (h.includes('id="tab-support"') && h.includes('Seminar feedback') && !h.includes('id="tab-feedback"')) {
    const feedbackBlock = h.match(/<div class="card" style="margin-bottom: 20px;">[\s\S]*?submitDashboardFeedback[\s\S]*?<\/form>\s*<\/div>/);
    if (feedbackBlock) {
        const fb = feedbackBlock[0];
        h = h.replace(fb, '');
        const supportPane = h.match(/<div id="tab-support" class="tab-pane hidden">[\s\S]*?<\/motion>\s*<div id="tab-volunteer"/);
        if (supportPane) {
            let supportOnly = supportPane[0]
                .replace(/<h2 class="section-title">Feedback &amp; support<\/h2>[\s\S]*?<p style="color: #64748b; margin: -10px 0 20px;">[\s\S]*?<\/p>/, '')
                .replace('</motion>\n                <motion id="tab-volunteer"', '</motion>\n                <div id="tab-volunteer"');
            supportOnly = supportOnly.replace(/motion/g, 'div');
            const newTabs =
                `                <div id="tab-feedback" class="tab-pane hidden">
                    <h2 class="section-title">Seminar feedback</h2>
                    <p style="color: #64748b; margin: -10px 0 20px;">Share your experience after attending a seminar.</p>
                    ${fb}
                </div>

                <div id="tab-support" class="tab-pane hidden">
                    <h2 class="section-title">Support tickets</h2>
                    <p style="color: #64748b; margin: -10px 0 20px;">Raise a ticket and continue the conversation in the same thread when an admin replies.</p>
` +
                supportOnly.replace(/<div id="tab-support" class="tab-pane hidden">[\s\S]*?<p style="color: #64748b; margin: -10px 0 20px;">[\s\S]*?<\/p>/, '');
            h = h.replace(supportPane[0], newTabs);
        }
    }
}

// Hide step-1 by default when step-0 exists - step-1 should have hidden if step-0 is first
if (h.includes('id="step-0"') && h.includes('id="step-1" class="form-step">')) {
    h = h.replace('id="step-1" class="form-step">', 'id="step-1" class="form-step hidden">');
}

// Preview TNC display
if (!h.includes('id="prev-tnc-block"')) {
    h = h.replace(
        '<iframe id="pdf-viewer"',
        `<div id="prev-tnc-block" style="margin-bottom:16px;padding:14px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;max-height:180px;overflow-y:auto;font-size:0.88rem;line-height:1.5;display:none;">
                                <h4 style="color:#1a237e;margin-bottom:8px;">Seminar terms &amp; conditions</h4>
                                <div id="prev-tnc-text" style="white-space:pre-wrap;"></div>
                            </div>
                            <iframe id="pdf-viewer"`
    );
}

fs.writeFileSync(p, h);
console.log('doctor.html patched');
