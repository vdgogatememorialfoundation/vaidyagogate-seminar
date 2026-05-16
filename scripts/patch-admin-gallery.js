const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'public', 'admin.html');
let h = fs.readFileSync(p, 'utf8');
if (!h.includes('cms-gallery-rows')) {
    h = h.replace(
        '<motion style="margin-top:14px;"><label>Past seminar gallery (JSON: src, caption, year?)</label><textarea id="cms-gallery-json" rows="4"></textarea></motion>',
        `<div style="margin-top:22px;padding-top:16px;border-top:1px solid #e2e8f0;">
                        <label style="font-weight:700;">Past seminar gallery</label>
                        <p style="color:#64748b;font-size:0.88rem;margin:6px 0 10px;">Upload images for the public Gallery page.</p>
                        <div id="cms-gallery-rows"></div>
                        <button type="button" class="btn-primary" style="margin-top:8px;padding:8px 14px;font-size:0.9rem;background:#0d9488;" onclick="cmsAddGalleryRow()">+ Add gallery image</button>
                    </div>`
    );
    h = h.replace(/motion/g, 'div');
}
h = h.replace(
    '<div><label>Publish participant list on website?</label><select id="seminar-public-list-enabled"><option value="0">No — hidden until ready</option><option value="1">Yes — public verification enabled</option></select></motion>',
    '<div><label>Publish participant list on website?</label><select id="seminar-public-list-enabled"><option value="0">No — hidden until ready</option><option value="1">Yes — public verification enabled</option></select><p style="font-size:0.78rem;color:#64748b;margin-top:4px;">Shows on website → Verify after data &amp; payments are complete.</p></div>'
);
fs.writeFileSync(p, h);
console.log('admin gallery patched');
