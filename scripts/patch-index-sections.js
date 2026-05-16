const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'public', 'index.html');
let h = fs.readFileSync(p, 'utf8');
if (h.includes('id="aboutSection"')) {
    console.log('already patched');
    process.exit(0);
}
const block = `
        <div id="aboutSection" style="display: none;">
            <motion class="section-title"><h2>About us</h2><p>Vaidya Gogate Memorial Foundation</p></div>
            <motion id="about-content" style="max-width:900px;margin:0 auto;background:#fffdf8;padding:28px;border-radius:18px;border:1px solid #e7d4b5;line-height:1.65;color:#57534e;"></div>
            <div id="social-follow" style="margin-top:28px;text-align:center;"></div>
        </div>

        <div id="gallerySection" style="display: none;">
            <div class="section-title"><h2>Gallery</h2><p>Past seminars and events</p></div>
            <div id="gallery-grid" class="cards-grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr));"></div>
        </div>

        <motion id="verifySection" style="display: none;">
            <div class="section-title"><h2>Participant verification</h2><p>Search published lists after admin enables them for a seminar</p></div>
            <div style="max-width:640px;margin:0 auto;background:#fffdf8;padding:24px;border-radius:18px;border:1px solid #e7d4b5;">
                <label style="font-weight:700;color:#78350f;">Seminar</label>
                <select id="verify-seminar" style="width:100%;padding:10px;margin:8px 0 16px;border-radius:10px;border:1px solid #d6d3d1;"></select>
                <label style="font-weight:700;color:#78350f;">Search (application no., name, or portal ID)</label>
                <input type="text" id="verify-query" placeholder="e.g. application number" style="width:100%;padding:10px;border-radius:10px;border:1px solid #d6d3d1;">
                <button type="button" class="btn-primary" style="margin-top:14px;border:none;cursor:pointer;" onclick="runParticipantVerify()">Search</button>
                <div id="verify-results" style="margin-top:20px;"></div>
            </div>
        </div>

`;
const fixed = block.replace(/motion/g, 'div');
const needle = '        <div id="scheduleSection" style="display: none;">';
if (!h.includes(needle)) {
    console.error('needle missing');
    process.exit(1);
}
h = h.replace(needle, fixed + needle);
fs.writeFileSync(p, h);
console.log('patched');
