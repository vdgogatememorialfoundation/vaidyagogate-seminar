const fs = require('fs');
const p = 'public/js/vgmf-home.js';
let s = fs.readFileSync(p, 'utf8');
s = s.replace(/<motion class="card-icon"/g, '<div class="card-icon"');
s = s.replace(/<\/motion>/g, '</motion>');
s = s.replace(/<\/motion>/g, '</div>');
fs.writeFileSync(p, s);
console.log('fixed vgmf-home.js');
