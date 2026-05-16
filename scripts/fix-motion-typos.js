const fs = require('fs');
const files = ['public/js/admin.js', 'public/admin.html'];
files.forEach((p) => {
    let s = fs.readFileSync(p, 'utf8');
    const before = s;
    s = s.replace(/document\.createElement\('motion'\)/g, "document.createElement('motion')");
    s = s.replace(/<motion /g, '<div ');
    s = s.replace(/<\/motion>/g, '</div>');
    s = s.replace(/document\.createElement\('motion'\)/g, "document.createElement('div')");
    if (s !== before) {
        fs.writeFileSync(p, s);
        console.log('fixed', p);
    } else {
        console.log('no change', p);
    }
});
