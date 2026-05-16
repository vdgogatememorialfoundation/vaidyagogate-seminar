const fs = require('fs');
const path = 'public/admin.html';
let h = fs.readFileSync(path, 'utf8');
const marker = `                    <div style="margin-top:14px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;">
                        <input type="file" id="cms-file-picker"`;
const insert = `                    <motion style="margin-top:22px;padding-top:16px;border-top:1px solid #e2e8f0;">
                        <label style="font-weight:700;">Homepage hero &amp; top bar</label>
                        <p style="color:#64748b;font-size:0.88rem;margin:6px 0 10px;">Controls the main headline, stats, and contact strip on the public site.</p>
                        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
                            <div><label style="font-size:0.8rem;">Headline</label><input type="text" id="cms-hero-title" style="width:100%"></div>
                            <div><label style="font-size:0.8rem;">Subtitle</label><input type="text" id="cms-hero-subtitle" style="width:100%"></div>
                            <div><label style="font-size:0.8rem;">Venue line</label><input type="text" id="cms-hero-venue" style="width:100%"></div>
                            <motion><label style="font-size:0.8rem;">Hero image URL</label><input type="text" id="cms-hero-image" style="width:100%" placeholder="/uploads/hero.jpg"></motion>
                            <div><label style="font-size:0.8rem;">Primary button</label><input type="text" id="cms-hero-cta1" style="width:100%"></div>
                            <div><label style="font-size:0.8rem;">Secondary button</label><input type="text" id="cms-hero-cta2" style="width:100%"></motion>
                        </div>
                        <motion style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:12px;">
                            <div><label style="font-size:0.8rem;">Stat 1 value</label><input type="text" id="cms-stat1-val" style="width:100%"></div>
                            <div><label style="font-size:0.8rem;">Stat 1 label</label><input type="text" id="cms-stat1-lbl" style="width:100%"></div>
                            <div></div>
                            <div><label style="font-size:0.8rem;">Stat 2 value</label><input type="text" id="cms-stat2-val" style="width:100%"></div>
                            <div><label style="font-size:0.8rem;">Stat 2 label</label><input type="text" id="cms-stat2-lbl" style="width:100%"></div>
                            <div></div>
                            <div><label style="font-size:0.8rem;">Stat 3 value</label><input type="text" id="cms-stat3-val" style="width:100%"></div>
                            <div><label style="font-size:0.8rem;">Stat 3 label</label><input type="text" id="cms-stat3-lbl" style="width:100%"></div>
                        </div>
                        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:12px;">
                            <div><label style="font-size:0.8rem;">Top bar email</label><input type="text" id="cms-top-email" style="width:100%"></div>
                            <div><label style="font-size:0.8rem;">Top bar phone</label><input type="text" id="cms-top-phone" style="width:100%"></div>
                            <div><label style="font-size:0.8rem;">Top bar date line</label><input type="text" id="cms-top-date" style="width:100%"></div>
                        </div>
                    </div>
                    <div style="margin-top:22px;padding-top:16px;border-top:1px solid #e2e8f0;">
                        <label style="font-weight:700;">Homepage feature cards</label>
                        <div id="cms-feature-rows"></motion>
                        <button type="button" class="btn-primary" style="margin-top:8px;padding:8px 14px;font-size:0.9rem;background:#0d9488;" onclick="cmsAddFeatureRow()">+ Add feature card</button>
                    </div>
                    <div style="margin-top:22px;padding-top:16px;border-top:1px solid #e2e8f0;">
                        <label style="font-weight:700;">FAQ (homepage)</label>
                        <div id="cms-faq-rows"></div>
                        <button type="button" class="btn-primary" style="margin-top:8px;padding:8px 14px;font-size:0.9rem;background:#0d9488;" onclick="cmsAddFaqRow()">+ Add FAQ</button>
                    </div>
                    <div style="margin-top:18px;display:grid;grid-template-columns:1fr 1fr;gap:12px;">
                        <div><label>Schedule page title</label><input type="text" id="cms-schedule-title" style="width:100%"></div>
                        <div><label>Schedule page subtitle</label><input type="text" id="cms-schedule-subtitle" style="width:100%"></div>
                    </div>
                    <div style="margin-top:14px;display:grid;grid-template-columns:1fr 1fr;gap:12px;">
                        <div><label>Contact address</label><input type="text" id="cms-contact-address" style="width:100%"></div>
                        <motion><label>Contact phone</label><input type="text" id="cms-contact-phone" style="width:100%"></motion>
                        <div><label>Contact email</label><input type="text" id="cms-contact-email" style="width:100%"></div>
                        <div><label>Office hours</label><input type="text" id="cms-contact-hours" style="width:100%"></div>
                        <div style="grid-column:1/-1;"><label>Footer tagline</label><input type="text" id="cms-footer-tagline" style="width:100%"></div>
                        <div style="grid-column:1/-1;"><label>Footer copyright</label><input type="text" id="cms-footer-copy" style="width:100%"></div>
                    </div>
                    <div style="margin-top:14px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;">
                        <input type="file" id="cms-file-picker"`;
if (h.includes('cms-hero-title')) {
    console.log('CMS hero block already present');
} else if (!h.includes(marker)) {
    console.error('marker not found');
    process.exit(1);
} else {
    h = h.replace(marker, insert);
    h = h.replace(/<motion /g, '<motion ').replace(/<\/motion>/g, '</motion>');
    h = h.replace(/<motion /g, '<div ').replace(/<\/motion>/g, '</div>');
    fs.writeFileSync(path, h);
    console.log('Inserted CMS hero block');
}
