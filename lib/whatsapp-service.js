/**
 * Meta WhatsApp Cloud API
 * WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN (webhook)
 * Optional: WHATSAPP_BUSINESS_ACCOUNT_ID (WABA) for template lookup
 */
const axios = require('axios');
const integrationSettings = require('./integration-settings');

function waCfg() {
    return integrationSettings.getWhatsAppConfig();
}

function isWhatsAppConfigured() {
    return integrationSettings.isWhatsAppConfiguredFromSettings();
}

function sanitizeWhatsAppTemplateName(name) {
    return String(name || '')
        .trim()
        .replace(/\s+/g, '_')
        .replace(/[^a-zA-Z0-9_]/g, '');
}

function normalizePhoneE164(phone) {
    let digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return '';
    if (digits.startsWith('0')) digits = digits.replace(/^0+/, '');
    if (digits.startsWith('91') && digits.length === 12) return digits;
    if (digits.length === 10) return '91' + digits;
    if (digits.startsWith('91') && digits.length > 12) return digits.slice(0, 12);
    return digits;
}

function templateLanguageCode(t) {
    if (!t) return '';
    if (typeof t.language === 'string') return t.language;
    if (t.language && t.language.code) return t.language.code;
    return '';
}

/** Only APPROVED template language codes — do not guess en_GB/en_US. */
function approvedTemplateLanguages(dbg) {
    const rows = (dbg && dbg.templates) || [];
    const langs = rows
        .filter((t) => !t.status || String(t.status).toUpperCase() === 'APPROVED')
        .map((t) => t.language)
        .filter(Boolean);
    return [...new Set(langs)];
}

async function verifyPhoneOnWaba(wabaId, phoneNumberId) {
    if (!wabaId || !phoneNumberId) return { ok: false, phones: [] };
    const { token } = waCfg();
    if (!token) return { ok: false, phones: [] };
    try {
        const res = await axios.get(`https://graph.facebook.com/v21.0/${wabaId}/phone_numbers`, {
            headers: { Authorization: `Bearer ${token}` },
            params: { fields: 'id,display_phone_number,verified_name,quality_rating', limit: 50 },
            timeout: 15000
        });
        const phones = res.data?.data || [];
        const ok = phones.some((p) => String(p.id) === String(phoneNumberId));
        return { ok, phones };
    } catch (e) {
        console.warn('[whatsapp] verifyPhoneOnWaba', (e.response && e.response.data) || e.message);
        return { ok: false, phones: [] };
    }
}

function buildTemplateLanguageVariants(langCode) {
    const code = String(langCode || 'en').trim();
    return [{ code }, { code, policy: 'deterministic' }];
}

async function resolveWabaId() {
    const { token, phoneNumberId, businessAccountId } = waCfg();
    if (businessAccountId) return String(businessAccountId).trim();
    if (!token) return null;

    if (phoneNumberId) {
        try {
            const pnRes = await axios.get(`https://graph.facebook.com/v21.0/${phoneNumberId}`, {
                headers: { Authorization: `Bearer ${token}` },
                params: {
                    fields: 'id,display_phone_number,verified_name,whatsapp_business_account'
                },
                timeout: 15000
            });
            let waba = pnRes.data && pnRes.data.whatsapp_business_account;
            if (waba && typeof waba === 'object' && waba.id) return String(waba.id);
            if (typeof waba === 'string' && waba) return waba;
        } catch (e) {
            console.warn('[whatsapp] resolveWabaId phone', (e.response && e.response.data) || e.message);
        }
    }

    try {
        const bizRes = await axios.get('https://graph.facebook.com/v21.0/me/businesses', {
            headers: { Authorization: `Bearer ${token}` },
            params: { fields: 'id,name', limit: 25 },
            timeout: 15000
        });
        for (const biz of bizRes.data?.data || []) {
            try {
                const wabaRes = await axios.get(
                    `https://graph.facebook.com/v21.0/${biz.id}/owned_whatsapp_business_accounts`,
                    {
                        headers: { Authorization: `Bearer ${token}` },
                        params: { fields: 'id,name', limit: 10 },
                        timeout: 15000
                    }
                );
                const wabas = wabaRes.data?.data || [];
                if (wabas.length === 1) return String(wabas[0].id);
                if (wabas.length > 1) return String(wabas[0].id);
            } catch (_) {}
        }
    } catch (e) {
        console.warn('[whatsapp] resolveWabaId businesses', (e.response && e.response.data) || e.message);
    }

    return null;
}

function countBodyVariablesInMetaTemplate(metaRow) {
    if (!metaRow || !Array.isArray(metaRow.components)) return 0;
    const body = metaRow.components.find((c) => String(c.type || '').toUpperCase() === 'BODY');
    if (!body || !body.text) return 0;
    const matches = String(body.text).match(/\{\{\d+\}\}/g);
    return matches ? matches.length : 0;
}

const templateMetaCache = new Map();
const TEMPLATE_META_TTL_MS = 3600000;

async function getTemplateMeta(templateName) {
    const tplName = sanitizeWhatsAppTemplateName(templateName);
    if (!tplName) return { bodyVariableCount: 0, languages: [] };
    const cached = templateMetaCache.get(tplName);
    if (cached && Date.now() - cached.at < TEMPLATE_META_TTL_MS) {
        return cached.data;
    }
    const dbg = await debugWhatsAppTemplateLookup(tplName);
    const matches = (dbg.templates || []).map((t) => {
        const full = (dbg._rawMatches || []).find(
            (r) => templateLanguageCode(r) === t.language && r.name === tplName
        );
        return {
            language: t.language,
            status: t.status,
            bodyVariableCount: full ? countBodyVariablesInMetaTemplate(full) : null
        };
    });
    const approved = matches.filter((m) => !m.status || String(m.status).toUpperCase() === 'APPROVED');
    const pick = approved[0] || matches[0];
    const data = {
        bodyVariableCount: pick && pick.bodyVariableCount != null ? pick.bodyVariableCount : 0,
        languages: dbg.languages || [],
        error: dbg.error || null
    };
    templateMetaCache.set(tplName, { at: Date.now(), data });
    return data;
}

async function listMessageTemplatesOnWaba(wabaId) {
    const { token } = waCfg();
    if (!token || !wabaId) return [];
    const all = [];
    let url = `https://graph.facebook.com/v21.0/${wabaId}/message_templates`;
    let params = { limit: 100 };
    for (let page = 0; page < 5; page++) {
        const res = await axios.get(url, {
            headers: { Authorization: `Bearer ${token}` },
            params,
            timeout: 20000
        });
        all.push(...(res.data?.data || []));
        const next = res.data?.paging?.next;
        if (!next) break;
        url = next;
        params = {};
    }
    return all;
}

/** Read approved language codes for a template from Meta (exact name match on WABA). */
async function fetchTemplateLanguageCodes(templateName) {
    const dbg = await debugWhatsAppTemplateLookup(templateName);
    return dbg.languages || [];
}

/** Admin diagnostics: is template on the same WABA as the configured phone number? */
async function debugWhatsAppTemplateLookup(templateName) {
    const tplName = sanitizeWhatsAppTemplateName(templateName);
    const { phoneNumberId } = waCfg();
    const wabaId = await resolveWabaId();
    const out = {
        templateName: tplName,
        phoneNumberId: phoneNumberId || '',
        wabaId: wabaId || '',
        languages: [],
        templates: [],
        otpLikeNames: [],
        error: null,
        hint: null
    };

    if (!wabaId) {
        out.error = 'Could not resolve WhatsApp Business Account ID (WABA).';
        out.hint =
            'In Meta → WhatsApp Manager → Account tools → Account overview, copy WhatsApp Business Account ID and paste it in admin → WhatsApp Business Account ID, then Save.';
        return out;
    }

    try {
        const all = await listMessageTemplatesOnWaba(wabaId);
        const matches = all.filter((t) => t.name === tplName);
        out._rawMatches = matches;
        out.templates = matches.map((t) => ({
            name: t.name,
            language: templateLanguageCode(t),
            status: t.status,
            category: t.category,
            body_variable_count: countBodyVariablesInMetaTemplate(t)
        }));
        out.languages = [...new Set(matches.map((t) => templateLanguageCode(t)).filter(Boolean))];
        out.otpLikeNames = all
            .filter((t) => t.name && /otp|auth|verify/i.test(t.name))
            .map((t) => `${t.name} (${templateLanguageCode(t)}, ${t.status})`)
            .slice(0, 15);

        if (phoneNumberId) {
            try {
                const pnRes = await axios.get(`https://graph.facebook.com/v21.0/${phoneNumberId}`, {
                    headers: { Authorization: `Bearer ${waCfg().token}` },
                    params: { fields: 'whatsapp_business_account,display_phone_number,verified_name' },
                    timeout: 15000
                });
                let phoneWaba = pnRes.data && pnRes.data.whatsapp_business_account;
                if (phoneWaba && typeof phoneWaba === 'object' && phoneWaba.id) phoneWaba = phoneWaba.id;
                out.phoneWabaId = phoneWaba ? String(phoneWaba) : '';
                out.wabaMatch = out.phoneWabaId === String(wabaId);
                if (out.phoneWabaId && !out.wabaMatch) {
                    out.error =
                        'Phone number ID belongs to WABA ' +
                        out.phoneWabaId +
                        ' but admin WABA is ' +
                        wabaId +
                        '. Templates on admin WABA cannot be sent from this phone.';
                    out.hint =
                        'In Meta → Phone numbers, open the number on WABA ' +
                        wabaId +
                        ' and copy THAT Phone number ID into admin (or set WABA to ' +
                        out.phoneWabaId +
                        ').';
                }
            } catch (e) {
                out.phoneWabaId = '';
                out.wabaMatch = null;
            }
            const pv = await verifyPhoneOnWaba(wabaId, phoneNumberId);
            out.phoneOnWaba = pv.ok;
            if (!pv.ok && !out.error) {
                out.error =
                    'Phone number ID ' +
                    phoneNumberId +
                    ' is NOT registered on WABA ' +
                    wabaId +
                    '. Use the Phone number ID from this WABA in admin.';
                out.hint =
                    'WABA phone IDs: ' +
                    (pv.phones.map((p) => p.id + ' (' + (p.display_phone_number || '') + ')').join(', ') ||
                        'none listed');
            }
        }

        if (!matches.length) {
            out.error =
                'Template "' + tplName + '" was NOT found on WABA ' + wabaId + ' linked to your Phone number ID.';
            out.hint =
                'Create the template on this account, or change Phone number ID to the number from the same Meta business where vgmf_otp_auth exists. OTP-like templates on this WABA: ' +
                (out.otpLikeNames.length ? out.otpLikeNames.join('; ') : '(none found)');
        } else if (!out.languages.length) {
            out.error = 'Template found but no language code returned from Meta.';
        } else {
            const bad = matches.filter((t) => t.status && String(t.status).toUpperCase() !== 'APPROVED');
            if (bad.length) {
                out.hint =
                    (out.hint ? out.hint + ' ' : '') +
                    'Template status: ' +
                    matches.map((t) => t.language + '=' + t.status).join(', ') +
                    '. Quality pending may block sends until Meta approves.';
            }
        }
    } catch (e) {
        out.error = JSON.stringify((e.response && e.response.data) || e.message);
        out.hint = 'Check token has whatsapp_business_management permission and WABA ID is correct.';
    }

    return out;
}

function isRetryableTransportError(errMsg) {
    const s = String(errMsg || '').toLowerCase();
    return (
        s.includes('timeout') ||
        s.includes('epipe') ||
        s.includes('econnreset') ||
        s.includes('socket hang up') ||
        s.includes('network error')
    );
}

function isTemplateParamMismatch(errMsg) {
    const s = String(errMsg || '').toLowerCase();
    return s.includes('132000') || (s.includes('parameter') && s.includes('does not match'));
}

async function postWhatsAppMessage(payload, attempt) {
    if (!isWhatsAppConfigured()) {
        return { ok: false, skipped: true, error: 'WhatsApp not configured' };
    }
    const { token, phoneNumberId: phoneId } = waCfg();
    const url = `https://graph.facebook.com/v21.0/${phoneId}/messages`;
    const tryNum = attempt || 0;
    try {
        const res = await axios.post(url, payload, {
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            timeout: 45000
        });
        const messageId =
            res.data && res.data.messages && res.data.messages[0] && res.data.messages[0].id
                ? res.data.messages[0].id
                : null;
        return { ok: true, messageId, raw: res.data };
    } catch (e) {
        const msg = formatWhatsAppError(e);
        if (tryNum < 1 && isRetryableTransportError(msg)) {
            await new Promise((r) => setTimeout(r, 800));
            return postWhatsAppMessage(payload, tryNum + 1);
        }
        console.error('[whatsapp]', msg);
        return { ok: false, error: msg, raw: e.response && e.response.data };
    }
}

function buildTemplateBodyParams(count, renderedBody, vars) {
    const n = Math.max(0, parseInt(count, 10) || 0);
    const body = String(renderedBody || '').replace(/\s+/g, ' ').trim();
    const v = vars && typeof vars === 'object' ? vars : {};
    if (n === 0) return [];
    if (n === 1) {
        const one =
            body ||
            [v.first_name, v.application_no].filter(Boolean).join(' — ').trim() ||
            v.seminar_name ||
            'VGMF Seminar';
        return [String(one).slice(0, 1024)];
    }
    const order = [
        'first_name',
        'application_no',
        'seminar_name',
        'user_id_string',
        'ticket_id',
        'payment_amount',
        'portal_login_url'
    ];
    const out = [];
    for (const key of order) {
        if (out.length >= n) break;
        const val = v[key] != null ? String(v[key]).trim() : '';
        if (val) out.push(val.slice(0, 1024));
    }
    while (out.length < n) out.push('—');
    return out.slice(0, n);
}

async function resolveTemplateBodyParams(templateName, renderedBody, vars, storedParams) {
    try {
        const meta = await getTemplateMeta(templateName);
        return buildTemplateBodyParams(meta.bodyVariableCount, renderedBody, vars);
    } catch (e) {
        console.warn('[whatsapp] resolveTemplateBodyParams', e.message);
        if (Array.isArray(storedParams)) return storedParams;
        const fallback = String(renderedBody || '').replace(/\s+/g, ' ').trim();
        return fallback ? [fallback.slice(0, 1024)] : [];
    }
}

async function sendWhatsAppTemplate(phone, templateName, bodyParams, opts) {
    const to = normalizePhoneE164(phone);
    if (!to) return { ok: false, error: 'Invalid phone' };
    const options = opts || {};
    const tplName = sanitizeWhatsAppTemplateName(templateName);
    const langCandidates = options.lang
        ? whatsappLangCandidates(options.lang)
        : whatsappLangCandidates(waCfg().templateLang);

    const buildPayload = (lang, params) => {
        const components = [];
        if (params && params.length) {
            components.push({
                type: 'body',
                parameters: params.map((t) => ({ type: 'text', text: String(t).slice(0, 1024) }))
            });
        }
        return {
            messaging_product: 'whatsapp',
            to,
            type: 'template',
            template: {
                name: tplName,
                language: { code: lang },
                components: components.length ? components : undefined
            }
        };
    };

    const primary = Array.isArray(bodyParams) ? bodyParams : [];

    let last = { ok: false, error: 'Template send failed' };
    for (const lang of langCandidates) {
        const attempts = [primary];
        if (primary.length) attempts.push([]);
        for (const params of attempts) {
            const r = await postWhatsAppMessage(buildPayload(lang, params));
            last = r;
            if (r.ok) return r;
            if (!isTemplateTranslationError(r.error) && !isTemplateParamMismatch(r.error)) {
                return r;
            }
            if (!isTemplateParamMismatch(r.error)) break;
        }
    }
    return last;
}

function whatsappLangCandidates(primary) {
    const p = String(primary || '').trim() || 'en';
    const out = [];
    const add = (c) => {
        const x = String(c || '').trim();
        if (x && !out.includes(x)) out.push(x);
    };
    add(p);
    add('en');
    add('en_US');
    add('en_IN');
    if (p === 'en_GB') add('en_GB');
    return out;
}

function isTemplateTranslationError(errMsg) {
    const s = String(errMsg || '').toLowerCase();
    return s.includes('132001') || s.includes('does not exist in the translation');
}

async function sendWhatsAppOtpTemplate(phone, templateName, code) {
    const to = normalizePhoneE164(phone);
    if (!to) return { ok: false, error: 'Invalid phone' };
    const tplName = sanitizeWhatsAppTemplateName(templateName);
    if (!tplName) return { ok: false, error: 'WhatsApp template name is empty' };
    const { templateLang, phoneNumberId } = waCfg();
    const otp = String(code || '').slice(0, 32);

    const dbg = await debugWhatsAppTemplateLookup(tplName);
    const metaLangs = approvedTemplateLanguages(dbg);
    const langCandidates = metaLangs.length
        ? metaLangs
        : [String(templateLang || 'en').trim() || 'en'];

    if (dbg.wabaMatch === false) {
        return {
            ok: false,
            error: dbg.error,
            hint: dbg.hint,
            template: tplName,
            metaLangs,
            wabaId: dbg.wabaId,
            phoneWabaId: dbg.phoneWabaId,
            phoneNumberId
        };
    }

    if (dbg.phoneOnWaba === false) {
        return {
            ok: false,
            error: dbg.error || 'Phone number ID is not on this WABA.',
            hint: dbg.hint,
            template: tplName,
            metaLangs,
            wabaId: dbg.wabaId,
            phoneNumberId
        };
    }

    if (!metaLangs.length && dbg.error) {
        return {
            ok: false,
            error: dbg.error + (dbg.hint ? ' ' + dbg.hint : ''),
            template: tplName,
            metaLangs: [],
            triedLangs: [],
            wabaId: dbg.wabaId,
            phoneNumberId
        };
    }

    const isAuthCategory =
        dbg.templates &&
        dbg.templates.some((t) => String(t.category || '').toUpperCase() === 'AUTHENTICATION');

    /** Meta auth OTP: body + button sub_type url with text (same OTP twice). */
    function authOtpComponents() {
        return [
            { type: 'body', parameters: [{ type: 'text', text: otp }] },
            {
                type: 'button',
                sub_type: 'url',
                index: '0',
                parameters: [{ type: 'text', text: otp }]
            }
        ];
    }

    const componentAttempts = isAuthCategory
        ? [
              { label: 'auth_no_components', components: null },
              { label: 'auth_body_url_button', components: authOtpComponents() },
              {
                  label: 'auth_body_only',
                  components: [{ type: 'body', parameters: [{ type: 'text', text: otp }] }]
              }
          ]
        : [
              {
                  label: 'body_only',
                  components: [{ type: 'body', parameters: [{ type: 'text', text: otp }] }]
              },
              {
                  label: 'body_url_button',
                  components: authOtpComponents()
              },
              {
                  label: 'body_copy_code',
                  components: [
                      { type: 'body', parameters: [{ type: 'text', text: otp }] },
                      {
                          type: 'button',
                          sub_type: 'copy_code',
                          index: '0',
                          parameters: [{ type: 'coupon_code', coupon_code: otp }]
                      }
                  ]
              }
          ];

    const triedLangs = [];
    const triedMethods = [];
    let last = { ok: false, error: 'Template send failed', template: tplName, metaLangs, wabaId: dbg.wabaId };
    for (const langCode of langCandidates) {
        triedLangs.push(langCode);
        for (const langVariant of buildTemplateLanguageVariants(langCode)) {
            for (const attempt of componentAttempts) {
                triedMethods.push(langCode + ':' + attempt.label + (langVariant.policy ? ':det' : ''));
                const templatePayload = {
                    name: tplName,
                    language: langVariant
                };
                if (attempt.components && attempt.components.length) {
                    templatePayload.components = attempt.components;
                }
                const r = await postWhatsAppMessage({
                    messaging_product: 'whatsapp',
                    to,
                    type: 'template',
                    template: templatePayload
                });
                if (r.ok) {
                    return Object.assign(
                        {
                            method: attempt.label,
                            lang: langCode,
                            template: tplName,
                            metaLangs,
                            triedLangs,
                            triedMethods,
                            wabaId: dbg.wabaId
                        },
                        r
                    );
                }
                last = Object.assign(
                    {
                        method: attempt.label,
                        lang: langCode,
                        template: tplName,
                        metaLangs,
                        triedLangs,
                        triedMethods,
                        wabaId: dbg.wabaId,
                        metaRaw: r.raw
                    },
                    r
                );
                if (isTemplateTranslationError(r.error)) continue;
                const errLower = String(r.error || '').toLowerCase();
                if (errLower.includes('132000') || errLower.includes('parameter')) continue;
            }
        }
    }

    const rawSnippet = last.metaRaw ? JSON.stringify(last.metaRaw).slice(0, 400) : '';
    if (isTemplateTranslationError(last.error) || last.error) {
        last.error =
            'Send failed for ' +
            tplName +
            ' (WABA ' +
            (dbg.wabaId || '?') +
            ', Phone ID ' +
            (phoneNumberId || '?') +
            '). Languages: ' +
            triedLangs.join(', ') +
            '. Methods: ' +
            triedMethods.join('; ') +
            (rawSnippet ? '. Meta: ' + rawSnippet : '');
        if (dbg.templates && dbg.templates.length) {
            last.error +=
                ' Template status: ' + dbg.templates.map((t) => t.language + '=' + t.status).join(', ');
        }
    }
    return last;
}

async function sendWhatsAppText(phone, body) {
    const to = normalizePhoneE164(phone);
    if (!to) return { ok: false, error: 'Invalid phone' };
    return postWhatsAppMessage({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: String(body).slice(0, 4096) }
    });
}

function formatWhatsAppError(e) {
    const data = e.response && e.response.data;
    const raw = (data && JSON.stringify(data)) || e.message || 'WhatsApp send failed';
    const lower = String(raw).toLowerCase();
    if (lower.includes('invalid oauth') || lower.includes('access token')) {
        return (
            'Invalid access token. Use a permanent System User token from Meta Business Settings — NOT the App Secret. Raw: ' +
            raw
        );
    }
    if (lower.includes('131047') || lower.includes('re-engagement') || lower.includes('24 hour')) {
        return (
            'Outside the 24-hour window. Use an approved OTP template or message your business number first. Raw: ' +
            raw
        );
    }
    if (lower.includes('131030') || lower.includes('not in allowed') || lower.includes('recipient')) {
        return (
            'Recipient not allowed. Add this phone as a Meta test number (development mode). Raw: ' +
            raw
        );
    }
    if (lower.includes('131026') || lower.includes('not a valid whatsapp')) {
        return 'This number is not registered on WhatsApp. Raw: ' + raw;
    }
    if (lower.includes('132001') || lower.includes('does not exist in the translation')) {
        return (
            'Template not on this Phone number / WABA, or wrong language code. Use Check template on Meta in admin. Raw: ' +
            raw
        );
    }
    if (lower.includes('132000') || (lower.includes('parameter') && lower.includes('match'))) {
        return (
            'WhatsApp template body parameters do not match Meta (static templates need 0 variables). Raw: ' +
            raw
        );
    }
    return String(raw);
}

/** Phone number + WABA health for admin diagnostics */
async function getWhatsAppPhoneDiagnostics() {
    const { token, phoneNumberId, businessAccountId } = waCfg();
    const out = {
        phoneNumberId: phoneNumberId || '',
        wabaId: businessAccountId || (await resolveWabaId()) || '',
        display_phone_number: '',
        verified_name: '',
        quality_rating: '',
        platform_type: '',
        error: null,
        hints: []
    };
    if (!token || !phoneNumberId) {
        out.error = 'WhatsApp token or phone number ID not configured';
        return out;
    }
    try {
        const res = await axios.get(`https://graph.facebook.com/v21.0/${phoneNumberId}`, {
            headers: { Authorization: `Bearer ${token}` },
            params: {
                fields:
                    'display_phone_number,verified_name,quality_rating,platform_type,whatsapp_business_account'
            },
            timeout: 15000
        });
        const d = res.data || {};
        out.display_phone_number = d.display_phone_number || '';
        out.verified_name = d.verified_name || '';
        out.quality_rating = d.quality_rating || '';
        out.platform_type = d.platform_type || '';
        if (d.whatsapp_business_account && d.whatsapp_business_account.id) {
            out.wabaId = String(d.whatsapp_business_account.id);
        }
        if (out.quality_rating && out.quality_rating !== 'GREEN') {
            out.hints.push(
                'Phone quality is ' +
                    out.quality_rating +
                    '. Meta may limit delivery until quality improves.'
            );
        }
        out.hints.push(
            'If the Meta app is in Development mode, add each test phone under WhatsApp → API Setup → add phone number.'
        );
        out.hints.push(
            'Subscribe webhook to "messages" and verify token must match Admin → Integrations.'
        );
        out.hints.push('Open WhatsApp chat with the business number once, then check Updates / Archived.');
    } catch (e) {
        out.error = formatWhatsAppError(e);
    }
    return out;
}

module.exports = {
    isWhatsAppConfigured,
    sendWhatsAppTemplate,
    sendWhatsAppOtpTemplate,
    sendWhatsAppText,
    normalizePhoneE164,
    sanitizeWhatsAppTemplateName,
    fetchTemplateLanguageCodes,
    getTemplateMeta,
    resolveTemplateBodyParams,
    buildTemplateBodyParams,
    countBodyVariablesInMetaTemplate,
    debugWhatsAppTemplateLookup,
    resolveWabaId,
    formatWhatsAppError,
    getWhatsAppPhoneDiagnostics
};
