/**
 * Google Drive OAuth — for personal Gmail / Google accounts (no Workspace).
 * Service accounts cannot use personal Drive storage; OAuth uses your account quota.
 */
const axios = require('axios');
const crypto = require('crypto');
const { uploadBufferWithAccessToken, formatGoogleApiError } = require('./google-drive-upload');

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

function publicBaseUrl() {
    return String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000').replace(
        /\/$/,
        ''
    );
}

function oauthRedirectUri() {
    const explicit = String(process.env.GOOGLE_DRIVE_OAUTH_REDIRECT_URI || '').trim();
    if (explicit) return explicit;
    return publicBaseUrl() + '/api/admin/platform-backup/google-oauth/callback';
}

function stateSecret() {
    return String(process.env.JWT_SECRET || process.env.INBOUND_MAIL_WEBHOOK_SECRET || 'platform-backup-oauth').trim();
}

function signOAuthState(payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const sig = crypto.createHmac('sha256', stateSecret()).update(body).digest('base64url');
    return body + '.' + sig;
}

function verifyOAuthState(state) {
    const raw = String(state || '').trim();
    const dot = raw.lastIndexOf('.');
    if (dot < 1) return null;
    const body = raw.slice(0, dot);
    const sig = raw.slice(dot + 1);
    const expected = crypto.createHmac('sha256', stateSecret()).update(body).digest('base64url');
    if (sig !== expected) return null;
    try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        const ageMs = Date.now() - parseInt(payload.ts, 10);
        if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 15 * 60 * 1000) return null;
        return payload;
    } catch (_) {
        return null;
    }
}

function resolveCredentials(config) {
    const cfg = config && typeof config === 'object' ? config : {};
    return {
        clientId: String(cfg.googleOAuthClientId || process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID || '').trim(),
        clientSecret: String(cfg.googleOAuthClientSecret || process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET || '').trim(),
        refreshToken: String(cfg.googleOAuthRefreshToken || '').trim()
    };
}

function buildAuthorizationUrl(adminUserId) {
    const creds = resolveCredentials({});
    if (!creds.clientId) {
        throw new Error(
            'Google OAuth client ID is not configured. Set GOOGLE_DRIVE_OAUTH_CLIENT_ID on the server or paste Client ID in backup settings.'
        );
    }
    const state = signOAuthState({ adminId: parseInt(adminUserId, 10), ts: Date.now() });
    const params = new URLSearchParams({
        client_id: creds.clientId,
        redirect_uri: oauthRedirectUri(),
        response_type: 'code',
        scope: DRIVE_SCOPE,
        access_type: 'offline',
        prompt: 'consent',
        state
    });
    return AUTH_URL + '?' + params.toString();
}

async function exchangeAuthorizationCode(code, config) {
    const creds = resolveCredentials(config);
    if (!creds.clientId || !creds.clientSecret) {
        throw new Error('Google OAuth client ID and secret are required.');
    }
    try {
        const res = await axios.post(
            TOKEN_URL,
            new URLSearchParams({
                code: String(code || '').trim(),
                client_id: creds.clientId,
                client_secret: creds.clientSecret,
                redirect_uri: oauthRedirectUri(),
                grant_type: 'authorization_code'
            }).toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 }
        );
        if (!res.data || !res.data.refresh_token) {
            throw new Error(
                'Google did not return a refresh token. Disconnect the app at myaccount.google.com/permissions and connect again.'
            );
        }
        return {
            refreshToken: res.data.refresh_token,
            accessToken: res.data.access_token || '',
            expiresIn: res.data.expires_in
        };
    } catch (err) {
        throw new Error(formatGoogleApiError(err) || 'Google OAuth code exchange failed');
    }
}

async function refreshAccessToken(config) {
    const creds = resolveCredentials(config);
    if (!creds.clientId || !creds.clientSecret) {
        throw new Error('Google OAuth client ID and secret are required.');
    }
    if (!creds.refreshToken) {
        throw new Error(
            'Google Drive is not connected. In Admin → Reports, choose Personal Google account and click Connect Google Drive.'
        );
    }
    try {
        const res = await axios.post(
            TOKEN_URL,
            new URLSearchParams({
                client_id: creds.clientId,
                client_secret: creds.clientSecret,
                refresh_token: creds.refreshToken,
                grant_type: 'refresh_token'
            }).toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 }
        );
        if (!res.data || !res.data.access_token) throw new Error('Google OAuth refresh failed');
        return res.data.access_token;
    } catch (err) {
        throw new Error(formatGoogleApiError(err) || 'Google OAuth refresh failed');
    }
}

async function fetchGoogleAccountEmail(accessToken) {
    try {
        const res = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: 'Bearer ' + accessToken },
            timeout: 15000
        });
        return (res.data && res.data.email) || '';
    } catch (_) {
        return '';
    }
}

async function uploadViaOAuth(config, folderId, filename, buffer, mimeType) {
    const accessToken = await refreshAccessToken(config);
    const result = await uploadBufferWithAccessToken(accessToken, folderId, filename, buffer, mimeType);
    return Object.assign({}, result, {
        auth: 'oauth',
        connectedEmail: config.googleOAuthConnectedEmail || ''
    });
}

module.exports = {
    DRIVE_SCOPE,
    oauthRedirectUri,
    resolveCredentials,
    signOAuthState,
    verifyOAuthState,
    buildAuthorizationUrl,
    exchangeAuthorizationCode,
    refreshAccessToken,
    fetchGoogleAccountEmail,
    uploadViaOAuth
};
