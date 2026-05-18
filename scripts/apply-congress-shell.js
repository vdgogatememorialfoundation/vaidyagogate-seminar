const fs = require('fs');
const path = require('path');
const indexPath = path.join(__dirname, '..', 'public', 'index.html');
const shellPath = path.join(__dirname, 'congress-shell.html');
let s = fs.readFileSync(indexPath, 'utf8');
const insert = fs.readFileSync(shellPath, 'utf8');

if (s.includes('id="cg-header"')) {
    console.log('Already patched');
    process.exit(0);
}

s = s.replace('    <div class="top-bar">', insert + '\n    <div class="top-bar legacy-header">');

if (!s.includes('vgmf-congress.js')) {
    s = s.replace(
        '<script src="/js/vgmf-home.js"></script>',
        '<script src="/js/vgmf-congress.js"></script>\n    <script src="/js/vgmf-home.js"></script>'
    );
}

if (!s.includes('cg-programme-root')) {
    s = s.replace(
        '<div class="schedule-container">',
        '<motion id="cg-programme-root" class="cg-timeline-wrap"></div>\n            <div class="cg-programme-filters" id="cg-programme-filters"></div>\n            <div class="schedule-container">'
    );
}

if (!s.includes('cg-video-section')) {
    s = s.replace(
        '<div id="homeSection">',
        '<motion id="homeSection">\n            <section id="cg-video-section" class="cg-section hidden">\n                <div class="cg-section-head"><h2>Video learning hub</h2><p>Seminar recordings and featured sessions</p></div>\n                <div id="cg-video-grid" class="cg-video-grid"></div>\n            </section>'
    );
}

if (!s.includes('cg-past-section') && s.includes('id="speakers-section"')) {
    s = s.replace(
        '<section id="speakers-section"',
        '<section id="cg-past-section" class="cg-section"><div class="cg-section-head"><h2>Past seminars</h2><p>Highlights from previous programmes</p></div><div id="cg-past-timeline" class="cg-past-timeline"></div></section>\n            <section id="speakers-section"'
    );
}

if (!s.includes('cg-speaker-modal')) {
    s = s.replace(
        '<footer class="footer">',
        '<div id="cg-speaker-modal" class="cg-modal" aria-hidden="true"><div class="cg-modal-panel"><button type="button" class="cg-modal-close" id="cg-speaker-modal-close">&times;</button><div id="cg-speaker-modal-body"></div></div></div>\n    <footer class="footer">'
    );
}

s = s.replace(/<motion\b/g, '<div').replace(/<\/motion>/g, '</div>');

fs.writeFileSync(indexPath, s);
console.log('Applied congress shell');
