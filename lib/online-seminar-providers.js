/**
 * Create or update an online seminar on Zoom, Google Meet, Zoho Webinar, or Zoho Backstage.
 * Callers pass an HTTP function so tests never touch the real services.
 */
const seminarDt = require('./seminar-datetime');

const PROVIDERS = ['vgmf', 'zoom', 'google_meet', 'zoho_webinar', 'zoho_backstage'];

const PROVIDER_LABELS = {
    vgmf: 'VGMF Hall',
    zoom: 'Zoom',
    google_meet: 'Google Meet',
    zoho_webinar: 'Zoho Webinar',
    zoho_backstage: 'Zoho Backstage'
};

const ZOHO_DC = {
    in: {
        accounts: 'https://accounts.zoho.in',
        webinar: 'https://webinar.zoho.in',
        apis: 'https://www.zohoapis.in'
    },
    com: {
        accounts: 'https://accounts.zoho.com',
        webinar: 'https://webinar.zoho.com',
        apis: 'https://www.zohoapis.com'
    },
    eu: {
        accounts: 'https://accounts.zoho.eu',
        webinar: 'https://webinar.zoho.eu',
        apis: 'https://www.zohoapis.eu'
    },
    au: {
        accounts: 'https://accounts.zoho.com.au',
        webinar: 'https://webinar.zoho.com.au',
        apis: 'https://www.zohoapis.com.au'
    }
};

const SECRET_KEYS = {
    zoom: ['clientSecret'],
    google: ['clientSecret', 'refreshToken'],
    zohoWebinar: ['clientSecret', 'refreshToken'],
    zohoBackstage: ['clientSecret', 'refreshToken']
};

function providerLabel(provider) {
    return PROVIDER_LABELS[provider] || 'Online';
}

function dcOf(block) {
    const dc = String((block && block.dc) || 'in').toLowerCase();
    return ZOHO_DC[dc] ? dc : 'in';
}

function zohoHosts(block) {
    return ZOHO_DC[dcOf(block)];
}

function emptySettings() {
    return {
        zoom: { accountId: '', clientId: '', clientSecret: '' },
        google: { clientId: '', clientSecret: '', refreshToken: '', email: '' },
        zohoWebinar: { dc: 'in', clientId: '', clientSecret: '', refreshToken: '', zsoid: '' },
        zohoBackstage: { dc: 'in', clientId: '', clientSecret: '', refreshToken: '', portalId: '' },
        hall: { joinEarlyMinutes: 30, maxDirectViewers: 12 }
    };
}

function trim(v) {
    return String(v == null ? '' : v).trim();
}

function isMasked(v) {
    const s = trim(v);
    return !s || s === '********' || /^[\*•·]+$/.test(s);
}

function normalizeSettings(raw) {
    const base = emptySettings();
    const src = raw && typeof raw === 'object' ? raw : {};
    base.zoom.accountId = trim(src.zoom && src.zoom.accountId);
    base.zoom.clientId = trim(src.zoom && src.zoom.clientId);
    base.zoom.clientSecret = trim(src.zoom && src.zoom.clientSecret);
    base.google.clientId = trim(src.google && src.google.clientId);
    base.google.clientSecret = trim(src.google && src.google.clientSecret);
    base.google.refreshToken = trim(src.google && src.google.refreshToken);
    base.google.email = trim(src.google && src.google.email);
    base.zohoWebinar.dc = dcOf(src.zohoWebinar);
    base.zohoWebinar.clientId = trim(src.zohoWebinar && src.zohoWebinar.clientId);
    base.zohoWebinar.clientSecret = trim(src.zohoWebinar && src.zohoWebinar.clientSecret);
    base.zohoWebinar.refreshToken = trim(src.zohoWebinar && src.zohoWebinar.refreshToken);
    base.zohoWebinar.zsoid = trim(src.zohoWebinar && src.zohoWebinar.zsoid);
    base.zohoBackstage.dc = dcOf(src.zohoBackstage);
    base.zohoBackstage.clientId = trim(src.zohoBackstage && src.zohoBackstage.clientId);
    base.zohoBackstage.clientSecret = trim(src.zohoBackstage && src.zohoBackstage.clientSecret);
    base.zohoBackstage.refreshToken = trim(src.zohoBackstage && src.zohoBackstage.refreshToken);
    base.zohoBackstage.portalId = trim(src.zohoBackstage && src.zohoBackstage.portalId);
    const early = parseInt(src.hall && src.hall.joinEarlyMinutes, 10);
    const direct = parseInt(src.hall && src.hall.maxDirectViewers, 10);
    base.hall.joinEarlyMinutes = Number.isInteger(early) ? Math.min(240, Math.max(0, early)) : 30;
    base.hall.maxDirectViewers = Number.isInteger(direct) ? Math.min(50, Math.max(1, direct)) : 12;
    return base;
}

function mergeSettings(existing, incoming) {
    const prev = normalizeSettings(existing);
    const next = normalizeSettings(incoming);
    Object.keys(SECRET_KEYS).forEach((block) => {
        SECRET_KEYS[block].forEach((key) => {
            if (isMasked(next[block][key])) next[block][key] = prev[block][key];
        });
    });
    return next;
}

function maskSettings(raw) {
    const out = normalizeSettings(raw);
    Object.keys(SECRET_KEYS).forEach((block) => {
        SECRET_KEYS[block].forEach((key) => {
            if (out[block][key]) out[block][key] = '********';
        });
    });
    out.connected = {
        zoom: !!(out.zoom.accountId && normalizeSettings(raw).zoom.clientId && normalizeSettings(raw).zoom.clientSecret),
        google: !!normalizeSettings(raw).google.refreshToken,
        zohoWebinar: !!(normalizeSettings(raw).zohoWebinar.refreshToken && normalizeSettings(raw).zohoWebinar.zsoid),
        zohoBackstage: !!(normalizeSettings(raw).zohoBackstage.refreshToken && normalizeSettings(raw).zohoBackstage.portalId)
    };
    return out;
}

function connectionFlags(raw) {
    const s = normalizeSettings(raw);
    return {
        zoom: !!(s.zoom.accountId && s.zoom.clientId && s.zoom.clientSecret),
        google: !!s.google.refreshToken,
        zohoWebinar: !!(s.zohoWebinar.refreshToken && s.zohoWebinar.zsoid),
        zohoBackstage: !!(s.zohoBackstage.refreshToken && s.zohoBackstage.portalId)
    };
}

function istParts(date) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).formatToParts(date);
    const get = (type) => (parts.find((p) => p.type === type) || {}).value || '00';
    let hour = get('hour');
    if (hour === '24') hour = '00';
    return {
        year: get('year'),
        month: get('month'),
        day: get('day'),
        hour,
        minute: get('minute'),
        second: get('second')
    };
}

function eventRange(seminar) {
    const start = seminarDt.parseSeminarDateTime(seminar && seminar.event_date) || new Date(Date.now() + 3600000);
    let end = seminarDt.parseSeminarDateTime(seminar && seminar.event_end_date);
    if (!end || end.getTime() <= start.getTime()) end = new Date(start.getTime() + 3 * 3600000);
    const minutes = Math.min(720, Math.max(30, Math.round((end.getTime() - start.getTime()) / 60000)));
    return { start, end, minutes };
}

function zoomLocalStart(date) {
    const p = istParts(date);
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

function zohoStartTime(date) {
    const p = istParts(date);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    let hour = parseInt(p.hour, 10);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    hour = hour % 12;
    if (hour === 0) hour = 12;
    return `${months[parseInt(p.month, 10) - 1]} ${parseInt(p.day, 10)}, ${p.year} ${String(hour).padStart(2, '0')}:${p.minute} ${ampm}`;
}

function safeSnippet(text) {
    return String(text || '')
        .replace(/ya29\.[A-Za-z0-9_\-]+/g, '[token]')
        .replace(/Zoho-oauthtoken\s+\S+/gi, 'Zoho-oauthtoken [token]')
        .slice(0, 240);
}

async function readHttp(http, url, opts) {
    const res = await http(url, opts || {});
    const status = res && res.status ? res.status : 0;
    const json = res && res.json != null ? res.json : null;
    const text = res && res.text != null ? res.text : '';
    if (status < 200 || status >= 300) {
        const msg = (json && (json.message || json.error || (json.error && json.error.message))) || text || 'request failed';
        const err = new Error(safeSnippet(typeof msg === 'string' ? msg : JSON.stringify(msg)));
        err.status = status;
        throw err;
    }
    return json || {};
}

function formBody(obj) {
    return new URLSearchParams(obj).toString();
}

async function zoomAccessToken(settings, http) {
    const z = settings.zoom;
    const basic = Buffer.from(`${z.clientId}:${z.clientSecret}`).toString('base64');
    const json = await readHttp(http, 'https://zoom.us/oauth/token', {
        method: 'POST',
        headers: {
            Authorization: `Basic ${basic}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: formBody({ grant_type: 'account_credentials', account_id: z.accountId })
    });
    if (!json.access_token) throw new Error('Zoom did not return an access token.');
    return json.access_token;
}

async function googleAccessToken(settings, http) {
    const g = settings.google;
    const json = await readHttp(http, 'https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({
            client_id: g.clientId,
            client_secret: g.clientSecret,
            refresh_token: g.refreshToken,
            grant_type: 'refresh_token'
        })
    });
    if (!json.access_token) throw new Error('Google did not return an access token.');
    return json.access_token;
}

async function zohoAccessToken(block, http) {
    const hosts = zohoHosts(block);
    const json = await readHttp(http, `${hosts.accounts}/oauth/v2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({
            refresh_token: block.refreshToken,
            client_id: block.clientId,
            client_secret: block.clientSecret,
            grant_type: 'refresh_token'
        })
    });
    if (!json.access_token) throw new Error('Zoho did not return an access token.');
    return json.access_token;
}

function googleJoinUrl(event) {
    if (!event) return '';
    if (event.hangoutLink) return String(event.hangoutLink);
    const points = (event.conferenceData && event.conferenceData.entryPoints) || [];
    const video = points.find((p) => p && p.entryPointType === 'video' && p.uri);
    return video ? String(video.uri) : '';
}

function absoluteZoho(origin, link) {
    const s = String(link || '').trim();
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;
    return origin.replace(/\/$/, '') + (s.startsWith('/') ? s : '/' + s);
}

function findUrl(obj) {
    if (!obj || typeof obj !== 'object') return '';
    const keys = Object.keys(obj);
    for (const key of keys) {
        if (!/url|link|website/i.test(key)) continue;
        const val = obj[key];
        if (typeof val === 'string' && /^https?:\/\//i.test(val)) return val;
    }
    return '';
}

async function provisionZoom(settings, seminar, existing, http) {
    const token = await zoomAccessToken(settings, http);
    const range = eventRange(seminar);
    const body = {
        topic: String(seminar.title || 'Seminar').slice(0, 200),
        type: 2,
        start_time: zoomLocalStart(range.start),
        timezone: 'Asia/Kolkata',
        duration: range.minutes,
        agenda: String(seminar.description || '').slice(0, 2000),
        settings: {
            waiting_room: true,
            join_before_host: false,
            approval_type: 0,
            meeting_authentication: false,
            registrants_email_notification: false,
            auto_recording: 'cloud'
        }
    };
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const id = existing && existing.external_id;
    const json = id
        ? await readHttp(http, `https://api.zoom.us/v2/meetings/${encodeURIComponent(id)}`, {
              method: 'PATCH',
              headers,
              body: JSON.stringify(body)
          })
        : await readHttp(http, 'https://api.zoom.us/v2/users/me/meetings', {
              method: 'POST',
              headers,
              body: JSON.stringify(body)
          });
    return {
        externalId: String((json && json.id) || id || ''),
        joinUrl: (json && json.join_url) || (existing && existing.join_url) || '',
        hostUrl: (json && json.start_url) || (existing && existing.host_url) || '',
        passcode: (json && (json.password || json.pstn_password)) || '',
        payload: { provider: 'zoom', id: (json && json.id) || id || null }
    };
}

async function provisionGoogle(settings, seminar, existing, http) {
    const token = await googleAccessToken(settings, http);
    const range = eventRange(seminar);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const eventId = existing && existing.external_id;
    if (eventId) {
        const json = await readHttp(
            http,
            `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
            {
                method: 'PATCH',
                headers,
                body: JSON.stringify({
                    summary: String(seminar.title || 'Seminar').slice(0, 200),
                    description: String(seminar.description || '').slice(0, 2000),
                    start: { dateTime: range.start.toISOString(), timeZone: 'Asia/Kolkata' },
                    end: { dateTime: range.end.toISOString(), timeZone: 'Asia/Kolkata' }
                })
            }
        );
        const join = googleJoinUrl(json) || (existing && existing.join_url) || '';
        return {
            externalId: String(json.id || eventId),
            joinUrl: join,
            hostUrl: join || (existing && existing.host_url) || '',
            payload: { provider: 'google_meet', id: json.id || eventId }
        };
    }
    const requestId = `vgmf-${seminar.id}-${Date.now()}`;
    const json = await readHttp(
        http,
        'https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1',
        {
            method: 'POST',
            headers,
            body: JSON.stringify({
                summary: String(seminar.title || 'Seminar').slice(0, 200),
                description: String(seminar.description || '').slice(0, 2000),
                start: { dateTime: range.start.toISOString(), timeZone: 'Asia/Kolkata' },
                end: { dateTime: range.end.toISOString(), timeZone: 'Asia/Kolkata' },
                conferenceData: {
                    createRequest: {
                        requestId,
                        conferenceSolutionKey: { type: 'hangoutsMeet' }
                    }
                }
            })
        }
    );
    const join = googleJoinUrl(json);
    return {
        externalId: String(json.id || ''),
        joinUrl: join,
        hostUrl: join,
        payload: { provider: 'google_meet', id: json.id || null },
        warning: join ? '' : 'Google Calendar event was created, but no Meet link came back. Check that Meet is enabled on this Google account.'
    };
}

async function provisionZohoWebinar(settings, seminar, existing, http) {
    const block = settings.zohoWebinar;
    if (!block.zsoid) throw new Error('Add the Zoho Webinar organization id (zsoid) in Online seminar connections.');
    const token = await zohoAccessToken(block, http);
    const hosts = zohoHosts(block);
    const range = eventRange(seminar);
    const session = {
        topic: String(seminar.title || 'Seminar').slice(0, 200),
        agenda: String(seminar.description || '').slice(0, 1000),
        startTime: zohoStartTime(range.start),
        duration: range.minutes * 60000,
        timezone: 'Asia/Calcutta'
    };
    const headers = { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' };
    const key = existing && existing.external_id;
    const url = key
        ? `${hosts.webinar}/api/v2/${encodeURIComponent(block.zsoid)}/webinar/${encodeURIComponent(key)}.json`
        : `${hosts.webinar}/api/v2/${encodeURIComponent(block.zsoid)}/webinar.json`;
    const json = await readHttp(http, url, {
        method: key ? 'PUT' : 'POST',
        headers,
        body: JSON.stringify({ session })
    });
    const row = json.session || json;
    const externalId = String(row.webinarKey || row.meetingKey || key || '');
    const joinUrl = row.registrationLink || (existing && existing.join_url) || '';
    const hostUrl = absoluteZoho(hosts.webinar, row.startLink) || (existing && existing.host_url) || '';
    return {
        externalId,
        joinUrl,
        hostUrl,
        payload: { provider: 'zoho_webinar', id: externalId || null },
        warning: joinUrl ? '' : 'Zoho Webinar was saved, but no attendee link was returned. Paste it once on the seminar form. It is not shown again.'
    };
}

async function provisionBackstage(settings, seminar, existing, http) {
    const block = settings.zohoBackstage;
    if (!block.portalId) throw new Error('Add the Zoho Backstage portal id in Online seminar connections.');
    const token = await zohoAccessToken(block, http);
    const hosts = zohoHosts(block);
    const range = eventRange(seminar);
    const body = {
        name: String(seminar.title || 'Seminar').slice(0, 200),
        timezone: 'Asia/Kolkata',
        start_time: range.start.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        end_time: range.end.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        language: 'en',
        event_type: 3,
        summary: String(seminar.description || '').slice(0, 500)
    };
    const headers = { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' };
    const id = existing && existing.external_id;
    const url = id
        ? `${hosts.apis}/backstage/v3/portals/${encodeURIComponent(block.portalId)}/events/${encodeURIComponent(id)}`
        : `${hosts.apis}/backstage/v3/portals/${encodeURIComponent(block.portalId)}/events`;
    const json = await readHttp(http, url, {
        method: id ? 'PUT' : 'POST',
        headers,
        body: JSON.stringify(body)
    });
    const event = json.event || json;
    const externalId = String(event.id || id || '');
    const joinUrl = findUrl(event) || (existing && existing.join_url) || '';
    return {
        externalId,
        joinUrl,
        hostUrl: joinUrl || (existing && existing.host_url) || '',
        payload: { provider: 'zoho_backstage', id: externalId || null, status: event.status_string || null },
        warning: joinUrl
            ? ''
            : 'Zoho Backstage event was created. Paste the public event link on the seminar if it is still empty.'
    };
}

async function provisionMeeting({ provider, settings, seminar, existing, manual, http }) {
    const mode = provider === 'vgmf' || PROVIDERS.includes(provider) ? provider : 'vgmf';
    if (mode === 'vgmf') {
        return {
            externalId: '',
            joinUrl: `/hall/${encodeURIComponent(seminar.id)}`,
            hostUrl: `/hall/${encodeURIComponent(seminar.id)}`,
            passcode: trim(manual && manual.passcode),
            payload: { provider: 'vgmf' },
            warning: ''
        };
    }
    if (manual && manual.use) {
        const keptJoin = trim(manual.joinUrl) || (existing && existing.join_url) || '';
        const keptHost = trim(manual.hostUrl) || (existing && existing.host_url) || keptJoin;
        return {
            externalId: (existing && existing.external_id) || '',
            joinUrl: keptJoin,
            hostUrl: keptHost,
            passcode: trim(manual.passcode),
            payload: { provider: mode, manual: true },
            warning: trim(manual.joinUrl) || (existing && existing.join_url)
                ? ''
                : 'Paste the attendee link once on the seminar form. It is stored on this server and is not shown again.'
        };
    }
    const flags = connectionFlags(settings);
    const flagKey = mode === 'google_meet' ? 'google' : mode === 'zoho_webinar' ? 'zohoWebinar' : mode === 'zoho_backstage' ? 'zohoBackstage' : 'zoom';
    if (!flags[flagKey]) {
        const pasted = trim(manual && manual.joinUrl);
        return {
            externalId: (existing && existing.external_id) || '',
            joinUrl: pasted || (existing && existing.join_url) || '',
            hostUrl: trim(manual && manual.hostUrl) || (existing && existing.host_url) || pasted,
            passcode: trim(manual && manual.passcode),
            payload: { provider: mode, pending: true },
            warning: `${providerLabel(mode)} is not connected yet. Add the keys under Online seminars, or paste the attendee link once on the seminar form. It is not shown again.`
        };
    }
    const fn =
        mode === 'zoom' ? provisionZoom : mode === 'google_meet' ? provisionGoogle : mode === 'zoho_webinar' ? provisionZohoWebinar : provisionBackstage;
    try {
        const out = await fn(normalizeSettings(settings), seminar, existing, http);
        if (trim(manual && manual.passcode)) out.passcode = trim(manual.passcode);
        return out;
    } catch (err) {
        const pasted = trim(manual && manual.joinUrl);
        return {
            externalId: (existing && existing.external_id) || '',
            joinUrl: pasted || (existing && existing.join_url) || '',
            hostUrl: trim(manual && manual.hostUrl) || (existing && existing.host_url) || '',
            passcode: trim(manual && manual.passcode),
            payload: { provider: mode, error: true },
            warning: `${providerLabel(mode)} could not be updated (${err.message}). The seminar was still saved.`
        };
    }
}

function oauthStartUrl(provider, settings, redirectUri, state) {
    const s = normalizeSettings(settings);
    if (provider === 'google') {
        const q = new URLSearchParams({
            client_id: s.google.clientId,
            redirect_uri: redirectUri,
            response_type: 'code',
            access_type: 'offline',
            prompt: 'consent',
            include_granted_scopes: 'true',
            scope: 'https://www.googleapis.com/auth/calendar.events',
            state
        });
        return `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`;
    }
    const block = provider === 'zoho_backstage' ? s.zohoBackstage : s.zohoWebinar;
    const hosts = zohoHosts(block);
    const scope =
        provider === 'zoho_backstage'
            ? 'ZohoBackstage.event.CREATE,ZohoBackstage.event.UPDATE,ZohoBackstage.portal.READ'
            : 'ZohoWebinar.webinar.CREATE,ZohoWebinar.webinar.UPDATE,ZohoWebinar.webinar.READ';
    const q = new URLSearchParams({
        client_id: block.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        access_type: 'offline',
        prompt: 'consent',
        scope,
        state
    });
    return `${hosts.accounts}/oauth/v2/auth?${q.toString()}`;
}

async function exchangeOAuthCode(provider, settings, code, redirectUri, http) {
    const s = normalizeSettings(settings);
    if (provider === 'google') {
        const json = await readHttp(http, 'https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: formBody({
                code,
                client_id: s.google.clientId,
                client_secret: s.google.clientSecret,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code'
            })
        });
        return { refreshToken: json.refresh_token || '', email: '' };
    }
    const block = provider === 'zoho_backstage' ? s.zohoBackstage : s.zohoWebinar;
    const hosts = zohoHosts(block);
    const json = await readHttp(http, `${hosts.accounts}/oauth/v2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({
            code,
            client_id: block.clientId,
            client_secret: block.clientSecret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code'
        })
    });
    return { refreshToken: json.refresh_token || '' };
}

function findDownloadUrl(obj, depth) {
    if (!obj || depth > 6) return '';
    if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i += 1) {
            const found = findDownloadUrl(obj[i], depth + 1);
            if (found) return found;
        }
        return '';
    }
    if (typeof obj !== 'object') return '';
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        const val = obj[key];
        if (/download/i.test(key) && typeof val === 'string' && /^https?:\/\//i.test(val)) return val;
    }
    for (let i = 0; i < keys.length; i += 1) {
        const found = findDownloadUrl(obj[keys[i]], depth + 1);
        if (found) return found;
    }
    return '';
}

async function zoomRegistrantJoin(settings, meetingId, person, http) {
    const token = await zoomAccessToken(normalizeSettings(settings), http);
    const email = trim(person && person.email).toLowerCase();
    if (!email || email.indexOf('@') < 1) throw new Error('This account needs an email address.');
    const json = await readHttp(http, `https://api.zoom.us/v2/meetings/${encodeURIComponent(meetingId)}/registrants`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            email,
            first_name: trim(person.first_name).slice(0, 60) || 'Doctor',
            last_name: trim(person.last_name).slice(0, 60) || 'VGMF'
        })
    });
    const url = trim(json && json.join_url);
    if (!url) throw new Error('Zoom did not open this meeting for that email.');
    return url;
}

async function recordingLocator(provider, settings, externalId, http) {
    const id = trim(externalId);
    if (!id) throw new Error('This meeting has no recording yet.');
    const s = normalizeSettings(settings);
    if (provider === 'zoom') {
        const token = await zoomAccessToken(s, http);
        const json = await readHttp(http, `https://api.zoom.us/v2/meetings/${encodeURIComponent(id)}/recordings`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const files = (json && json.recording_files) || [];
        const file = files.find((row) => String(row.file_type || '').toUpperCase() === 'MP4') || files[0];
        const downloadUrl = file && trim(file.download_url);
        if (!downloadUrl) throw new Error('Zoom has no recording for this meeting yet.');
        return { downloadUrl, headers: { Authorization: `Bearer ${token}` }, ext: 'mp4' };
    }
    if (provider === 'zoho_webinar') {
        const block = s.zohoWebinar;
        if (!block.zsoid) throw new Error('Add the Zoho Webinar organization id under Online seminars.');
        const token = await zohoAccessToken(block, http);
        const hosts = zohoHosts(block);
        const json = await readHttp(
            http,
            `${hosts.webinar}/api/v2/${encodeURIComponent(block.zsoid)}/recordings/${encodeURIComponent(id)}.json`,
            { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
        );
        const downloadUrl = findDownloadUrl(json, 0);
        if (!downloadUrl) throw new Error('Zoho Webinar has no recording for this meeting yet.');
        return { downloadUrl, headers: { Authorization: `Zoho-oauthtoken ${token}` }, ext: 'mp4' };
    }
    if (provider === 'google_meet' || provider === 'zoho_backstage') {
        throw new Error('That account keeps its own recording. VGMF Hall recordings are saved on this server and can be downloaded here.');
    }
    throw new Error('VGMF Hall saves the recording when the host goes live.');
}

async function testConnection(provider, settings, http) {
    const s = normalizeSettings(settings);
    if (provider === 'zoom') {
        await zoomAccessToken(s, http);
        return { ok: true, message: 'Zoom accepted the server-to-server keys.' };
    }
    if (provider === 'google') {
        await googleAccessToken(s, http);
        return { ok: true, message: 'Google accepted the connected account.' };
    }
    if (provider === 'zoho_webinar') {
        await zohoAccessToken(s.zohoWebinar, http);
        return { ok: true, message: 'Zoho Webinar accepted the connected account.' };
    }
    if (provider === 'zoho_backstage') {
        await zohoAccessToken(s.zohoBackstage, http);
        return { ok: true, message: 'Zoho Backstage accepted the connected account.' };
    }
    return { ok: true, message: 'VGMF Hall does not need an outside account.' };
}

module.exports = {
    PROVIDERS,
    PROVIDER_LABELS,
    providerLabel,
    emptySettings,
    normalizeSettings,
    mergeSettings,
    maskSettings,
    connectionFlags,
    zohoStartTime,
    zoomLocalStart,
    eventRange,
    provisionMeeting,
    oauthStartUrl,
    exchangeOAuthCode,
    testConnection,
    googleJoinUrl,
    zoomRegistrantJoin,
    recordingLocator
};
