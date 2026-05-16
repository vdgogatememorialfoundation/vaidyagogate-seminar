const fs = require('fs');
const http = require('http');
const boundary = '----testboundary';
const file = Buffer.from('case file content');
const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="userId"\r\n\r\n1\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nTest Case\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="t.txt"\r\nContent-Type: text/plain\r\n\r\ncase file content\r\n`,
    `--${boundary}--\r\n`
];
const body = Buffer.from(parts.join(''));
const req = http.request(
    {
        hostname: 'localhost',
        port: 3000,
        path: '/api/case/submit',
        method: 'POST',
        headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length
        }
    },
    (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => console.log(res.statusCode, d));
    }
);
req.on('error', (e) => console.log('ERR', e.message));
req.write(body);
req.end();
