const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'public', 'js', 'doctor.js');
let s = fs.readFileSync(p, 'utf8');

s = s.replace(
    /return html\.replace\([^)]+\);/,
    'return html;'
);

s = s.replace(
    /<motion style="background:#eef2ff/g,
    '<div style="background:#eef2ff'
);
s = s.replace(/<\/p><\/motion>\s*'\s*\+/g, "</p></motion>' +".replace(/motion/g, 'motion'));
s = s.replace(/<\/p><\/motion>/g, '</p></div>');
s = s.replace(/'\s*\+\s*'<div>'\s*\+\s*actionBlock\.replace\(\/motion\/g, "' + '<div>' + actionBlock");

const start = s.indexOf('            let hasUpcoming = false;\n            activeSeminars.forEach((s) => {');
const end = s.indexOf('        if (hasUpcoming) {\n            startSeminarGridCountdownTimer();\n        }\n    } catch (err) {\n        console.error(err);\n    }\n}\n\nlet activeSeminarIdForReg');
if (start > 0 && end > start) {
    const replacement = `            let hasUpcoming = false;
            activeSeminars.forEach((s) => {
                const win = registrationWindowState(s);
                if (win.state === 'upcoming') hasUpcoming = true;
                html += renderSeminarGridCard(s, false);
            });
            html += '</div>';
        }
        html +=
            '<h3 style="color:#64748b;margin:28px 0 12px;">Past seminars (earlier years)</h3>';
        if (!pastSeminars.length) {
            html += '<p style="color:#64748b;">No archived seminars from earlier years.</p>';
        } else {
            html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:20px;">';
            pastSeminars.forEach((s) => {
                html += renderSeminarGridCard(s, true);
            });
            html += '</div>';
        }
        container.innerHTML = html;
        if (hasUpcoming) {
            startSeminarGridCountdownTimer();
        }
    } catch (err) {
        console.error(err);
    }
}

let activeSeminarIdForReg`;
    s = s.slice(0, start) + replacement;
}

fs.writeFileSync(p, s);
console.log('fixed seminar grid');
