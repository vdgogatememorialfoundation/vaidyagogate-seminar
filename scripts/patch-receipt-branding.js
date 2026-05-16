const fs = require('fs');
const tag = 'di' + 'v';
const p = 'public/js/doctor.js';
let s = fs.readFileSync(p, 'utf8');
const oldHead =
    "        '<style>' + receiptPrintCss() + '</style></head><body>',\n" +
    `        '<${tag} class="rh">' + headerInner + '</${tag}>',`;
const newHead =
    "        '<style>' + receiptPrintCss() + '</style></head><body>',\n" +
    '        brandingHeaderHtml(),\n' +
    `        '<${tag} class="rh">' + headerInner + '</${tag}>',`;
if (s.includes(oldHead)) s = s.replace(oldHead, newHead);
const oldFoot = `        '<${tag} class="rf">' + footerInner + '</${tag}>',\n        '</body></html>'`;
const newFoot =
    `        '<${tag} class="rf">' + footerInner + '</${tag}>',\n        brandingFooterHtml(),\n        '</body></html>'`;
if (s.includes(oldFoot) && !s.includes('brandingFooterHtml()')) {
    s = s.replace(oldFoot, newFoot);
}
fs.writeFileSync(p, s);
console.log('done');
