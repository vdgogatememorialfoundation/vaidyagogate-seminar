const fs = require('fs');
const p = 'public/js/admin.js';
let s = fs.readFileSync(p, 'utf8');
const bad =
    "        box.innerHTML = box.innerHTML.replace(/<\\/?motion\\b[^>]*>/g, '').replace(/motion/g, 'motion');\n        box.innerHTML = box.innerHTML.replace(/motion/g, 'motion');";
const bad2 =
    "        box.innerHTML = box.innerHTML.replace(/<\\/?div\\b[^>]*>/g, '').replace(/div/g, 'motion');\n        box.innerHTML = box.innerHTML.replace(/motion/g, 'motion');";
const bad3 =
    "        box.innerHTML = box.innerHTML.replace(/<\\/?div\\b[^>]*>/g, '').replace(/div/g, 'div');\n        box.innerHTML = box.innerHTML.replace(/div/g, 'div');";
if (s.includes(bad3)) {
    s = s.replace(bad3, '');
    fs.writeFileSync(p, s);
    console.log('removed bad3');
} else if (s.includes(bad2)) {
    s = s.replace(bad2, '');
    fs.writeFileSync(p, s);
    console.log('removed bad2');
} else {
    const idx = s.indexOf("box.innerHTML = box.innerHTML.replace");
    console.log('search', idx, s.slice(idx, idx + 120));
}
