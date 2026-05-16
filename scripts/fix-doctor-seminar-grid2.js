const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'public', 'js', 'doctor.js');
let s = fs.readFileSync(p, 'utf8');
const lines = s.split(/\n/);
for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('return html.replace')) {
        lines[i] = '    return html;';
    }
}
s = lines.join('\n');
const marker = '            activeSeminars.forEach((s) => {';
const endMarker = 'let activeSeminarIdForReg';
const a = s.indexOf(marker);
const b = s.indexOf(endMarker);
if (a < 0 || b < 0) {
    console.error('markers missing', a, b);
    process.exit(1);
}
const rep = `            let hasUpcoming = false;
            activeSeminars.forEach((s) => {
                const win = registrationWindowState(s);
                if (win.state === 'upcoming') hasUpcoming = true;
                html += renderSeminarGridCard(s, false);
            });
            html += '</motion>';
        }
        html += '<h3 style="color:#64748b;margin:28px 0 12px;">Past seminars (earlier years)</h3>';
        if (!pastSeminars.length) {
            html += '<p style="color:#64748b;">No archived seminars from earlier years.</p>';
        } else {
            html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:20px;">';
            pastSeminars.forEach((s) => {
                html += renderSeminarGridCard(s, true);
            });
            html += '</motion>';
        }
        container.innerHTML = html.split('motion').join('div');
        if (hasUpcoming) {
            startSeminarGridCountdownTimer();
        }
    } catch (err) {
        console.error(err);
    }
}

`;
s = s.slice(0, a) + rep + s.slice(b);
s = s.split('<motion ').join('<div ').split('</motion>').join('</motion>');
s = s.split('</motion>').join('</div>');
fs.writeFileSync(p, s);
console.log('fixed');
