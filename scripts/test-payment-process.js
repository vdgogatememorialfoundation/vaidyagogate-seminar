const http = require('http');
const body = JSON.stringify({ registrationId: 14, amount: 1500, userId: 2 });
const req = http.request(
    {
        hostname: '127.0.0.1',
        port: 3000,
        path: '/api/payments/process',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    },
    (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => console.log(res.statusCode, d.slice(0, 500)));
    }
);
req.on('error', (e) => console.error(e.message));
req.write(body);
req.end();
