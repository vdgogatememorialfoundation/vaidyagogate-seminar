const fs = require('fs');
const path = 'public/doctor.html';
let h = fs.readFileSync(path, 'utf8');
h = h.replace(
    /(\s*<\/motion>\s*<\/div>\s*<\/div>\s*<\/div>\s*)\s*<!-- Ticket thread view -->/,
    '$1                    </motion>\n                    <!-- Ticket thread view -->'
);
// Close support-main-view before ticket thread if missing
if (!h.includes('id="support-main-view"')) {
    console.log('no support-main-view');
}
const fix = `                    </motion>
                </div>

                <motion id="tab-volunteer"`;
const bad = `                    <div id="tab-volunteer"`;
if (h.includes(bad) && !h.includes('</div>\n\n                <div id="tab-volunteer"')) {
    h = h.replace(
        /(\s*<\/div>\s*)\s*<div id="tab-volunteer" class="tab-pane hidden">/,
        '$1                </div>\n\n                <div id="tab-volunteer" class="tab-pane hidden">'
    );
}
h = h.replace(/\s*<div id="tab-abstract"/, '\n                <div id="tab-abstract"');
h = h.replace(/<\/motion>/g, '</div>').replace(/<motion /g, '<div ');
fs.writeFileSync(path, h);
console.log('fixed structure');
