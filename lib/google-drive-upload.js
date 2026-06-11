/**
 * Google Drive file upload via service account (JWT → access token → multipart upload).
 */
const axios = require('axios');
const crypto = require('crypto');

function base64url(input) {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
    return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function parseServiceAccount(raw) {
    if (!raw) return null;
    try {
        const o = typeof raw === 'object' ? raw : JSON.parse(String(raw));
        if (!o || !o.client_email || !o.private_key) return null;
        return o;
    } catch (_) {
        return null;
    }
}

async function getAccessToken(serviceAccount) {
    const sa = parseServiceAccount(serviceAccount);
    if (!sa) throw new Error('Invalid Google service account JSON');

    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const now = Math.floor(Date.now() / 1000);
    const claim = base64url(
        JSON.stringify({
            iss: sa.client_email,
            scope: 'https://www.googleapis.com/auth/drive.file',
            aud: 'https://oauth2.googleapis.com/token',
            iat: now,
            exp: now + 3600
        })
    );
    const unsigned = `${header}.${claim}`;
    const sign = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key);
    const jwt = `${unsigned}.${base64url(sign)}`;

    const res = await axios.post(
        'https://oauth2.googleapis.com/token',
        new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: jwt
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 }
    );
    if (!res.data || !res.data.access_token) throw new Error('Google token exchange failed');
    return res.data.access_token;
}

async function uploadBuffer(serviceAccount, folderId, filename, buffer, mimeType) {
    const token = await getAccessToken(serviceAccount);
    const metadata = {
        name: filename,
        mimeType: mimeType || 'application/octet-stream'
    };
    if (folderId) metadata.parents = [String(folderId).trim()];

    const boundary = '-------vaidya_backup_' + Date.now();
    const metaPart =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify(metadata) +
        '\r\n';
    const filePart =
        `--${boundary}\r\nContent-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`;
    const end = `\r\n--${boundary}--`;
    const body = Buffer.concat([
        Buffer.from(metaPart, 'utf8'),
        Buffer.from(filePart, 'utf8'),
        Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer),
        Buffer.from(end, 'utf8')
    ]);

    const res = await axios.post(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',
        body,
        {
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': `multipart/related; boundary=${boundary}`
            },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 120000
        }
    );
    return res.data || {};
}

module.exports = {
    parseServiceAccount,
    getAccessToken,
    uploadBuffer
};
