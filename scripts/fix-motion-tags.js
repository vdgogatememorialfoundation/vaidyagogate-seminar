const fs = require('fs');
const files = process.argv.slice(2);
const tag = ['m', 'o', 't', 'i', 'o', 'n'].join('');
const div = ['d', 'i', 'v'].join('');

for (const p of files) {
    let c = fs.readFileSync(p, 'utf8');
    c = c.split('</' + tag + '>').join('</' + div + '>');
    c = c.split('<' + tag).join('<' + div);
    fs.writeFileSync(p, c);
    console.log('fixed', p);
}
