/**
 * Quick checks for inbound email thread reference parsing.
 */
const messageReplyAddress = require('../lib/message-reply-address');
const emailParserNormalize = require('../lib/email-parser-normalize');

process.env.MAILPARSER_INBOUND_EMAIL = 'stccahyu@mailparser.io';

const cases = [
    ['VGMF-CTC-12 in body', messageReplyAddress.parseRefFromText('Please help [VGMF-CTC-12]'), { type: 'contact', inquiryId: 12 }],
    ['VGMF-CASE-3-7', messageReplyAddress.parseRefFromText('[VGMF-CASE-3-7]'), { type: 'case', submissionId: 3, judgeUserId: 7 }],
    ['VGMF-ADM-5', messageReplyAddress.parseRefFromText('[VGMF-ADM-5]'), { type: 'admin', threadId: 5 }],
    ['contact reply address', messageReplyAddress.buildContactReplyAddress(9), 'stccahyu@mailparser.io']
];

let failed = 0;
for (const [label, got, want] of cases) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log((ok ? 'OK' : 'FAIL') + ' ' + label);
    if (!ok) {
        failed++;
        console.log('  got ', got);
        console.log('  want', want);
    }
}

const norm = emailParserNormalize.normalizeInboundPayload({
    from: 'Visitor <visitor@example.com>',
    to: 'stccahyu@mailparser.io',
    subject: 'Question',
    text: 'Hello there'
});
if (norm.from && norm.text && norm.toList.includes('stccahyu@mailparser.io')) {
    console.log('OK mailparser payload normalize');
} else {
    failed++;
    console.log('FAIL mailparser payload normalize', norm);
}

process.exit(failed ? 1 : 0);
