/**
 * Google Drive file upload via service account (JWT → access token → multipart upload).
 * Service accounts have no personal Drive quota — uploads must target a folder shared
 * with the service account email (Editor) or a Shared drive folder.
 */
const axios = require('axios');
const crypto = require('crypto');

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

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

function formatGoogleApiError(err) {
    const data = err && err.response && err.response.data;
    const apiErr = data && data.error;
    if (!apiErr) return err && err.message ? String(err.message) : 'Google Drive request failed';

    const parts = [];
    if (apiErr.message) parts.push(String(apiErr.message));
    const reason = apiErr.errors && apiErr.errors[0] && apiErr.errors[0].reason;
    if (reason) parts.push('reason=' + reason);
    const status = err.response && err.response.status;
    if (status) parts.push('HTTP ' + status);

    const msg = parts.join(' · ');
    if (/storageQuotaExceeded|storage quota|does not have storage quota/i.test(msg)) {
        return (
            msg +
            ' — Service accounts cannot store files in their own Drive. Set a Google Drive folder ID and share that folder with the service account email (Editor).'
        );
    }
    if (/insufficientPermissions|403|forbidden/i.test(msg)) {
        return (
            msg +
            ' — Share the backup folder with the service account client_email as Editor, enable Google Drive API in Google Cloud, and confirm the folder ID.'
        );
    }
    return msg;
}

async function getAccessToken(serviceAccount) {
    const sa = parseServiceAccount(serviceAccount);
    if (!sa) throw new Error('Invalid Google service account JSON');

    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const now = Math.floor(Date.now() / 1000);
    const claim = base64url(
        JSON.stringify({
            iss: sa.client_email,
            scope: DRIVE_SCOPE,
            aud: 'https://oauth2.googleapis.com/token',
            iat: now,
            exp: now + 3600
        })
    );
    const unsigned = `${header}.${claim}`;
    const sign = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key);
    const jwt = `${unsigned}.${base64url(sign)}`;

    try {
        const res = await axios.post(
            'https://oauth2.googleapis.com/token',
            new URLSearchParams({
                grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                assertion: jwt
            }).toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 }
        );
        if (!res.data || !res.data.access_token) throw new Error('Google token exchange failed');
        return { token: res.data.access_token, clientEmail: sa.client_email };
    } catch (err) {
        throw new Error(formatGoogleApiError(err) || 'Google token exchange failed');
    }
}

async function uploadBuffer(serviceAccount, folderId, filename, buffer, mimeType) {
    const folder = String(folderId || '').trim();
    if (!folder) {
        throw new Error(
            'Google Drive folder ID is required. Create a folder in your Google Drive, share it with the service account email as Editor, and paste the folder ID in Admin → Reports → Daily platform backup.'
        );
    }

    const { token, clientEmail } = await getAccessToken(serviceAccount);
    const metadata = {
        name: filename,
        mimeType: mimeType || 'application/octet-stream',
        parents: [folder]
    };

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

    try {
        const res = await axios.post(
            'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink',
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
        return Object.assign({}, res.data || {}, { serviceAccountEmail: clientEmail });
    } catch (err) {
        const detail = formatGoogleApiError(err);
        throw new Error(detail + (clientEmail ? ' (service account: ' + clientEmail + ')' : ''));
    }
}

module.exports = {
    parseServiceAccount,
    getAccessToken,
    uploadBuffer,
    formatGoogleApiError
};
