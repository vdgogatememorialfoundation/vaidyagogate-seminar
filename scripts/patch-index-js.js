const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'public', 'index.html');
let h = fs.readFileSync(p, 'utf8');

if (!h.includes('function runParticipantVerify')) {
    const fn = `
        function socialIcon(platform) {
            const p = String(platform || '').toLowerCase();
            if (p === 'youtube') return 'fab fa-youtube';
            if (p === 'facebook') return 'fab fa-facebook';
            if (p === 'instagram') return 'fab fa-instagram';
            return 'fas fa-link';
        }

        function renderAboutGallerySocial(cms) {
            const aboutEl = document.getElementById('about-content');
            if (aboutEl) {
                const secs = Array.isArray(cms.aboutSections) ? cms.aboutSections : [];
                aboutEl.innerHTML = secs.length
                    ? secs.map((s) => '<h3 style="font-family:Fraunces,Georgia,serif;color:#78350f;margin:16px 0 8px;">' + escHtml(s.heading || '') + '</h3><p>' + escHtml(s.body || '') + '</p>').join('')
                    : '<p>The Vaidya Gogate Memorial Foundation advances Ayurveda through national seminars and continuing education.</p>';
            }
            const soc = document.getElementById('social-follow');
            if (soc) {
                const links = Array.isArray(cms.socialLinks) ? cms.socialLinks : [];
                soc.innerHTML = links.length
                    ? '<p style="font-weight:700;color:#78350f;margin-bottom:12px;">Follow us</p><motion style="display:flex;flex-wrap:wrap;gap:14px;justify-content:center;">' +
                      links.map((l) => '<a href="' + escHtml(l.url || '#') + '" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:8px;padding:10px 16px;background:#fffdf8;border:1px solid #e7d4b5;border-radius:999px;color:#b45309;font-weight:700;text-decoration:none;"><i class="' + socialIcon(l.platform) + '"></i> ' + escHtml(l.label || l.platform || '') + '</a>').join('') +
                      '</div>'
                    : '';
            }
            const grid = document.getElementById('gallery-grid');
            if (grid) {
                const gal = Array.isArray(cms.pastSeminarGallery) ? cms.pastSeminarGallery : [];
                grid.innerHTML = gal.length
                    ? gal.map((g) => '<div class="card"><img src="' + escHtml(g.src || '') + '" alt="" style="width:100%;height:160px;object-fit:cover;"><div class="card-content"><h3>' + escHtml(g.caption || '') + '</h3><p style="color:#78716c;">' + escHtml(g.year || '') + '</p></div></div>').join('')
                    : '<p style="color:#78716c;">Gallery images will appear here when added in admin.</p>';
            }
        }

        async function loadVerifySeminars() {
            const sel = document.getElementById('verify-seminar');
            if (!sel) return;
            try {
                const res = await fetch('/api/public/participant-directories');
                const list = await res.json();
                sel.innerHTML = '<option value="">— Select seminar —</option>';
                (list || []).forEach((s) => {
                    sel.innerHTML += '<option value="' + s.id + '">' + escHtml(s.title || '') + '</option>';
                });
            } catch (e) {
                console.error(e);
            }
        }

        async function runParticipantVerify() {
            const sid = document.getElementById('verify-seminar')?.value;
            const q = document.getElementById('verify-query')?.value || '';
            const box = document.getElementById('verify-results');
            if (!box) return;
            if (!sid) {
                box.innerHTML = '<p style="color:#b91c1c;">Select a seminar.</p>';
                return;
            }
            box.innerHTML = '<p>Searching…</p>';
            try {
                const res = await fetch('/api/public/participants/' + sid + '?q=' + encodeURIComponent(q));
                const data = await res.json();
                if (!res.ok) {
                    box.innerHTML = '<p style="color:#b91c1c;">' + escHtml(data.error || 'Not available') + '</p>';
                    return;
                }
                const rows = data.participants || [];
                if (!rows.length) {
                    box.innerHTML = '<p>No matching participants found.</p>';
                    return;
                }
                box.innerHTML = '<table class="schedule-table"><thead><tr><th>Application</th><th>Name</th><th>City</th><th>Status</th><th>Paid</th></tr></thead><tbody>' +
                    rows.map((r) => '<tr><td>' + escHtml(r.applicationNo) + '</td><td>' + escHtml(r.name) + '</td><td>' + escHtml(r.city) + '</td><td>' + escHtml(r.status) + '</td><td>' + (r.paid ? 'Yes' : 'No') + '</td></tr>').join('') +
                    '</tbody></table>';
            } catch (e) {
                box.innerHTML = '<p style="color:#b91c1c;">Network error.</p>';
            }
        }

`;
    const fixedFn = fn.replace(/motion/g, 'motion').replace(/<motion /g, '<div ').replace(/<\/motion>/g, '</div>');
    h = h.replace('        function showSection(section) {', fixedFn + '        function showSection(section) {');
}

if (!h.includes("document.getElementById('aboutSection')")) {
    h = h.replace(
        `        function showSection(section) {
            document.getElementById('homeSection').style.display = 'none';
            document.getElementById('scheduleSection').style.display = 'none';
            document.getElementById('contactSection').style.display = 'none';
            if (section === 'home') document.getElementById('homeSection').style.display = 'block';
            else if (section === 'schedule') {
                document.getElementById('scheduleSection').style.display = 'block';
                loadEventSchedules();
            }
            else if (section === 'contact') document.getElementById('contactSection').style.display = 'block';
        }`,
        `        function showSection(section) {
            ['homeSection','scheduleSection','contactSection','aboutSection','gallerySection','verifySection'].forEach((id) => {
                const el = document.getElementById(id);
                if (el) el.style.display = 'none';
            });
            if (section === 'home') document.getElementById('homeSection').style.display = 'block';
            else if (section === 'about') document.getElementById('aboutSection').style.display = 'block';
            else if (section === 'gallery') document.getElementById('gallerySection').style.display = 'block';
            else if (section === 'verify') {
                document.getElementById('verifySection').style.display = 'block';
                loadVerifySeminars();
            }
            else if (section === 'schedule') {
                document.getElementById('scheduleSection').style.display = 'block';
                loadEventSchedules();
            }
            else if (section === 'contact') document.getElementById('contactSection').style.display = 'block';
        }`
    );
}

if (!h.includes('renderAboutGallerySocial(cms)')) {
    h = h.replace(
        '                renderReviewsMarquee(cms.reviews || []);',
        `                renderReviewsMarquee(cms.reviews || []);
                renderAboutGallerySocial(cms);`
    );
}

fs.writeFileSync(p, h);
console.log('js patched');
