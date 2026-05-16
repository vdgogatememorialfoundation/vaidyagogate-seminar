const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function patch(file, pairs) {
    let s = fs.readFileSync(file, 'utf8');
    let n = 0;
    pairs.forEach(([from, to]) => {
        if (s.includes(from)) {
            s = s.split(from).join(to);
            n++;
        }
    });
    fs.writeFileSync(file, s);
    console.log(file, n, 'replacements');
}

// Admin: remove live chat tab and modal
const adminHtml = path.join(root, 'public', 'admin.html');
let ah = fs.readFileSync(adminHtml, 'utf8');
ah = ah.replace(/\s*<!-- 6\. Live Chat Support -->[\s\S]*?<!-- 7\. Transfer Applications -->/, '\n            <!-- 7. Transfer Applications -->');
ah = ah.replace(/\s*<!-- Live Chat Ticket Detail Modal -->[\s\S]*?<!-- User detail \(profile, activity, password\) -->/, '\n    <!-- User detail (profile, activity, password) -->');
fs.writeFileSync(adminHtml, ah);
console.log('admin.html cleaned');

// Doctor: remove chatbot block
const docHtml = path.join(root, 'public', 'doctor.html');
let dh = fs.readFileSync(docHtml, 'utf8');
dh = dh.replace(/\s*<!-- AI Chatbot UI -->[\s\S]*?<\/div>\s*\n\s*<script src="\/js\/doctor\.js"/, '\n    <script src="/js/doctor.js"');
fs.writeFileSync(docHtml, dh);
console.log('doctor.html chatbot removed');
