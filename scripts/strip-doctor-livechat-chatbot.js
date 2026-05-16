const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'public', 'js', 'doctor.js');
let h = fs.readFileSync(p, 'utf8');

const startLc = 'let doctorLiveSessionId = null;';
const endLc = 'async function loadTickets() {';
const i0 = h.indexOf(startLc);
const i1 = h.indexOf(endLc);
if (i0 >= 0 && i1 > i0) {
    h = h.slice(0, i0) + h.slice(i1);
    console.log('removed live chat block');
}

const startCb = '// AI Chatbot Logic';
const endCb = '// Doctor Profile Management';
const j0 = h.indexOf(startCb);
const j1 = h.indexOf(endCb);
if (j0 >= 0 && j1 > j0) {
    h = h.slice(0, j0) + h.slice(j1);
    console.log('removed chatbot block');
}

h = h.replace(
    "    if (tabId === 'tab-support') {\n        loadDashboardFeedbackSeminars();\n        loadTickets();\n    }",
    "    if (tabId === 'tab-feedback') {\n        loadDashboardFeedbackSeminars();\n    }\n    if (tabId === 'tab-support') {\n        loadTickets();\n    }"
);

h = h.replace(
    "    document.getElementById('doctor-lc-panel').classList.add('hidden');\n    document.getElementById('support-chat-view')",
    "    document.getElementById('support-chat-view')"
);

fs.writeFileSync(p, h);
console.log('doctor.js stripped');
