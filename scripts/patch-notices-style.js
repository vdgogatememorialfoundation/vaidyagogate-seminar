const fs = require('fs');
const p = 'public/index.html';
let s = fs.readFileSync(p, 'utf8');
const re =
    /container\.innerHTML \+= `\s*<motion style="background: #fffdf8[\s\S]*?<\/motion>\s*`;/;
const re2 =
    /container\.innerHTML \+= `\s*<div style="background: #fffdf8[\s\S]*?<\/div>\s*`;/;
const replacement = `container.innerHTML += \`
                        <article class="notice-card">
                            <h4>\${escHtml(n.title)}</h4>
                            <p class="notice-date">\${escHtml(n.date)}</p>
                            <p>\${escHtml(n.body)}</p>
                            \${pdfLink}
                        </article>
                    \`;`;
if (re2.test(s)) {
    s = s.replace(re2, replacement);
    fs.writeFileSync(p, s);
    console.log('notices patched');
} else {
    console.log('already patched or pattern missing');
}
