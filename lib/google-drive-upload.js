/**
 * Google Drive upload via service account.
 *
 * Service accounts have no My Drive storage quota. Use either:
 *  A) A folder inside a Google Workspace **Shared drive** where the SA is a member, or
 *  B) **Domain-wide delegation** — JWT impersonates a Workspace user (sub claim) who owns the folder.
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
            ' — Use a folder inside a Google Workspace Shared drive (add the service account as Content manager), ' +
            'OR set “Impersonate Workspace user” with domain-wide delegation enabled for the Drive scope.'
        );
    }
    if (/unauthorized_client|delegation|invalid_grant/i.test(msg)) {
        return (
            msg +
            ' — Enable domain-wide delegation on the service account in Google Cloud, then in Workspace Admin add the client ID with scope https://www.googleapis.com/auth/drive'
        );
    }
    if (/insufficientPermissions|403|forbidden/i.test(msg)) {
        return (
            msg +
            ' — For Shared drives: add the service account as a member (Content manager). For My Drive: use impersonation + share the folder with that user.'
        );
    }
    return msg;
}

async function getAccessToken(serviceAccount, impersonateEmail) {
    const sa = parseServiceAccount(serviceAccount);
    if (!sa) throw new Error('Invalid Google service account JSON');

    const sub = String(impersonateEmail || process.env.GOOGLE_DRIVE_IMPERSONATE_EMAIL || '').trim();

    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const now = Math.floor(Date.now() / 1000);
    const claims = {
        iss: sa.client_email,
        scope: DRIVE_SCOPE,
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600
    };
    if (sub) claims.sub = sub;

    const claim = base64url(JSON.stringify(claims));
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
        return { token: res.data.access_token, clientEmail: sa.client_email, impersonateEmail: sub || null };
    } catch (err) {
        throw new Error(formatGoogleApiError(err) || 'Google token exchange failed');
    }
}

async function uploadBuffer(serviceAccount, folderId, filename, buffer, mimeType, opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const folder = String(folderId || '').trim();
    if (!folder) {
        throw new Error(
            'Google Drive folder ID is required — use a folder inside a Shared drive, or a My Drive folder owned by the impersonated user.'
        );
    }

    const impersonateEmail = String(options.impersonateEmail || '').trim();
    const { token, clientEmail, impersonateEmail: subUsed } = await getAccessToken(serviceAccount, impersonateEmail);
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
        return Object.assign({}, res.data || {}, {
            serviceAccountEmail: clientEmail,
            impersonateEmail: subUsed
        });
    } catch (err) {
        const detail = formatGoogleApiError(err);
        let suffix = ' (service account: ' + clientEmail + ')';
        if (subUsed) suffix += ' impersonating: ' + subUsed;
        throw new Error(detail + suffix);
    }
}

module.exports = {
    parseServiceAccount,
    getAccessToken,
    uploadBuffer,
    formatGoogleApiError
};
