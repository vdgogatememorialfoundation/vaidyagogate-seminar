/**
 * Admin WhatsApp section routes (/api/admin/whatsapp/*) + public Flow data-exchange endpoint.
 * All sending goes through whatsapp-central.send(); audiences via whatsapp-audience.
 */
const multer = require('multer');
const XLSX = require('xlsx');
const crypto = require('crypto');
const central = require('./whatsapp-central');
const audience = require('./whatsapp-audience');
const flows = require('./whatsapp-flows');
const waSvc = require('./whatsapp-service');
const activityLog = require('./activity-log');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const CAMPAIGN_TYPES = [
    ['custom', 'Custom / promotional'],
    ['registration_confirmation', 'Registration confirmation'],
    ['payment_reminder', 'Payment reminder'],
    ['eticket', 'E-ticket delivery'],
    ['event_reminder', 'Event reminder'],
    ['attendance_thanks', 'Post-event / attendee message'],
    ['certificate', 'Certificate notification'],
    ['otp', 'OTP (system)'],
    ['utility', 'Utility'],
    ['marketing', 'Marketing']
];

function parseJson(s, fallback) {
    try {
        return s ? JSON.parse(s) : fallback;
    } catch (_) {
        return fallback;
    }
}

function bad(res, msg, code) {
    res.status(code || 400).json({ error: msg });
}

function registerWhatsAppRoutes(app, deps) {
    const { db, requireAdminActor, generateId, getOrCreatePendingOrder } = deps;
    central.ensureSchema(db, () => central.startWorker(db, 5000));

    const admin = (handler) => (req, res) => requireAdminActor(req, res, (adm) => central.ensureSchema(db, () => handler(req, res, adm)));

    /* -------------------------------------------------------------- meta */
    app.get(
        '/api/admin/whatsapp/meta',
        admin((req, res) => {
            db.all(`SELECT id, title, event_date, event_end_date, IFNULL(is_active, 1) AS is_active FROM seminars ORDER BY event_date DESC LIMIT 200`, [], (e, sems) => {
                if (e) return bad(res, e.message, 500);
                const ids = (sems || []).map((s) => s.id);
                const done = (daysBySem) =>
                    res.json({
                        configured: waSvc.isWhatsAppConfigured(),
                        filters: Object.entries(audience.FILTERS).map(([key, label]) => ({ key, label })),
                        variables: audience.VARIABLES.map(([key, label]) => ({ key, label })),
                        campaignTypes: CAMPAIGN_TYPES.map(([key, label]) => ({ key, label })),
                        flowActions: flows.actionNames(),
                        seminars: (sems || []).map((s) => ({ ...s, days: daysBySem[s.id] || [] }))
                    });
                if (!ids.length) return done({});
                db.all(`SELECT id, seminar_id, title, day_date FROM seminar_days WHERE seminar_id IN (${ids.map(() => '?').join(',')}) AND IFNULL(is_active,1) = 1 ORDER BY sort_order, day_date`, ids, (e2, days) => {
                    const map = {};
                    (days || []).forEach((d) => (map[d.seminar_id] = map[d.seminar_id] || []).push(d));
                    done(map);
                });
            });
        })
    );

    /* --------------------------------------------------------- dashboard */
    app.get(
        '/api/admin/whatsapp/dashboard',
        admin((req, res) => {
            const since7 = new Date(Date.now() - 7 * 86400000).toISOString().replace('T', ' ');
            const since1 = new Date(Date.now() - 86400000).toISOString().replace('T', ' ');
            const out = { configured: waSvc.isWhatsAppConfigured() };
            db.all(`SELECT status, COUNT(*) AS n FROM wa_messages WHERE direction = 'out' AND created_at >= ? GROUP BY status`, [since7], (e1, r7) => {
                out.last7d = {};
                (r7 || []).forEach((r) => (out.last7d[r.status || 'unknown'] = Number(r.n)));
                db.all(`SELECT status, COUNT(*) AS n FROM wa_messages WHERE direction = 'out' AND created_at >= ? GROUP BY status`, [since1], (e2, r1) => {
                    out.last24h = {};
                    (r1 || []).forEach((r) => (out.last24h[r.status || 'unknown'] = Number(r.n)));
                    db.all(`SELECT status, COUNT(*) AS n FROM wa_campaigns GROUP BY status`, [], (e3, cs) => {
                        out.campaigns = {};
                        (cs || []).forEach((r) => (out.campaigns[r.status] = Number(r.n)));
                        db.get(`SELECT COUNT(*) AS n FROM wa_contacts WHERE opted_out = 1`, [], (e4, oo) => {
                            out.optedOut = oo ? Number(oo.n) : 0;
                            db.all(`SELECT * FROM wa_campaigns WHERE status IN ('sending','paused') ORDER BY id DESC LIMIT 5`, [], (e5, active) => {
                                out.activeCampaigns = active || [];
                                db.all(`SELECT * FROM wa_messages WHERE direction = 'out' ORDER BY id DESC LIMIT 10`, [], (e6, recent) => {
                                    out.recent = recent || [];
                                    db.get(`SELECT COUNT(*) AS n FROM wa_templates WHERE is_active = 1`, [], (e7, tc) => {
                                        out.activeTemplates = tc ? Number(tc.n) : 0;
                                        res.json(out);
                                    });
                                });
                            });
                        });
                    });
                });
            });
        })
    );

    /* ---------------------------------------------------------- settings */
    app.get(
        '/api/admin/whatsapp/settings',
        admin((req, res) => {
            central.loadSettings(db, (e, s) => {
                if (e) return bad(res, e.message, 500);
                const cfg = require('./integration-settings').getWhatsAppConfig();
                res.json({
                    settings: central.publicSettings(s),
                    integration: {
                        configured: waSvc.isWhatsAppConfigured(),
                        phoneNumberIdSet: !!cfg.phoneNumberId,
                        wabaIdSet: !!cfg.businessAccountId,
                        tokenSet: !!cfg.token,
                        templateLang: cfg.templateLang
                    },
                    flowEndpoint: (require('./integration-settings').getPublicBaseUrl() || '') + '/api/whatsapp/flow/data-exchange',
                    webhookUrl: (require('./integration-settings').getPublicBaseUrl() || '') + '/api/webhooks/whatsapp'
                });
            });
        })
    );
    app.post(
        '/api/admin/whatsapp/settings',
        admin((req, res, adm) => {
            const patch = { ...(req.body || {}) };
            delete patch.actingAdminId;
            if (patch.flow_private_key === '') delete patch.flow_private_key;
            if (patch.flow_private_key_passphrase === '') delete patch.flow_private_key_passphrase;
            if (patch.clear_flow_private_key) {
                patch.flow_private_key = '';
                patch.flow_private_key_passphrase = '';
                delete patch.clear_flow_private_key;
            }
            central.saveSettings(db, patch, (e) => {
                if (e) return bad(res, e.message, 500);
                activityLog.logFromRequest(db, req, { user_id: adm.id, user_role: 'admin', action: 'whatsapp_settings_update', resource_type: 'whatsapp' });
                central.loadSettings(db, (e2, s) => res.json({ ok: true, settings: central.publicSettings(s || {}) }));
            });
        })
    );

    /* ---------------------------------------------------------- templates */
    app.get(
        '/api/admin/whatsapp/templates',
        admin((req, res) => {
            db.all(`SELECT * FROM wa_templates ORDER BY is_active DESC, name ASC, language ASC`, [], (e, rows) => {
                if (e) return bad(res, e.message, 500);
                res.json({ templates: (rows || []).map((t) => ({ ...t, variables: parseJson(t.variables_json, []) })) });
            });
        })
    );
    app.post(
        '/api/admin/whatsapp/templates/sync',
        admin((req, res) => {
            central.syncTemplatesFromMeta(db, (e, out) => {
                if (e) return bad(res, e.message, 502);
                res.json({ ok: true, ...out });
            });
        })
    );
    app.post(
        '/api/admin/whatsapp/templates',
        admin((req, res, adm) => {
            const b = req.body || {};
            const id = parseInt(b.id, 10) || 0;
            const metaName = waSvc.sanitizeWhatsAppTemplateName(b.meta_name || b.name);
            if (!metaName) return bad(res, 'Meta template name is required');
            const lang = String(b.language || 'en').trim() || 'en';
            const vars = Array.isArray(b.variables) ? b.variables.map((v) => (typeof v === 'string' ? v : (v && v.key) || '')) : parseJson(b.variables_json, []);
            const count = b.variable_count != null ? parseInt(b.variable_count, 10) || 0 : vars.length;
            const params = [String(b.name || metaName).trim(), metaName, b.meta_id || null, lang, b.category || null, b.status || null, b.header_type || null, b.body_text || null, count, JSON.stringify(vars.slice(0, count)), b.is_active === false || Number(b.is_active) === 0 ? 0 : 1];
            const done = (e, newId) => {
                if (e) return bad(res, /unique/i.test(e.message) ? 'A template with this Meta name + language already exists' : e.message, 400);
                activityLog.logFromRequest(db, req, { user_id: adm.id, user_role: 'admin', action: id ? 'whatsapp_template_update' : 'whatsapp_template_create', resource_type: 'whatsapp_template', resource_id: id || newId });
                res.json({ ok: true, id: id || newId });
            };
            if (id) {
                db.run(
                    `UPDATE wa_templates SET name = ?, meta_name = ?, meta_id = ?, language = ?, category = ?, status = ?, header_type = ?, body_text = ?, variable_count = ?, variables_json = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                    [...params, id],
                    (e) => done(e)
                );
            } else {
                db.run(
                    `INSERT INTO wa_templates (name, meta_name, meta_id, language, category, status, header_type, body_text, variable_count, variables_json, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    params,
                    function (e) {
                        done(e, this && this.lastID);
                    }
                );
            }
        })
    );
    app.delete(
        '/api/admin/whatsapp/templates/:id',
        admin((req, res) => {
            db.run(`DELETE FROM wa_templates WHERE id = ?`, [parseInt(req.params.id, 10) || 0], (e) => (e ? bad(res, e.message, 500) : res.json({ ok: true })));
        })
    );
    app.get(
        '/api/admin/whatsapp/templates/:id/check',
        admin((req, res) => {
            db.get(`SELECT * FROM wa_templates WHERE id = ?`, [parseInt(req.params.id, 10) || 0], (e, t) => {
                if (e || !t) return bad(res, 'Template not found', 404);
                waSvc.debugWhatsAppTemplateLookup(t.meta_name).then((dbg) => res.json({ ok: true, meta: { languages: dbg.languages, templates: dbg.templates, error: dbg.error, hint: dbg.hint } }));
            });
        })
    );

    /* ------------------------------------------------------ audience tools */
    app.get(
        '/api/admin/whatsapp/audience/search',
        admin((req, res) => {
            audience.searchRegistrations(db, parseInt(req.query.seminarId, 10) || 0, req.query.q || '', (e, rows) => (e ? bad(res, e.message, 500) : res.json({ results: rows })));
        })
    );
    app.post(
        '/api/admin/whatsapp/audience/preview',
        admin((req, res) => {
            const b = req.body || {};
            audience.buildEventAudience(db, { seminarId: b.seminarId, filter: b.filter, dayId: b.dayId, registrationIds: b.registrationIds, perTicket: !!b.perTicket }, (e, out) => {
                if (e) return bad(res, e.message);
                const phones = new Set(out.recipients.map((r) => waSvc.normalizePhoneE164(r.phone)));
                res.json({
                    seminar: out.seminar,
                    registrations: out.total,
                    noPhone: out.noPhone,
                    uniquePhones: phones.size,
                    estimatedMessages: out.recipients.length,
                    sample: out.recipients.slice(0, 5).map((r) => ({ name: r.name, phone: r.phone, vars: r.vars }))
                });
            });
        })
    );

    /* ------------------------------------------------- upload (xlsx / csv) */
    app.post('/api/admin/whatsapp/upload/parse', (req, res) => {
        upload.single('file')(req, res, (uErr) => {
            if (uErr) return bad(res, uErr.message);
            requireAdminActor(req, res, () => {
                if (!req.file) return bad(res, 'file is required');
                let wb;
                try {
                    wb = XLSX.read(req.file.buffer, { type: 'buffer', raw: false });
                } catch (e) {
                    return bad(res, 'Could not read file: ' + e.message);
                }
                const ws = wb.Sheets[wb.SheetNames[0]];
                const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
                if (!rows.length) return bad(res, 'Sheet is empty');
                const columns = Object.keys(rows[0]);
                const guessPhone = columns.find((c) => /phone|mobile|whatsapp|contact|number/i.test(c)) || columns[0];
                const guessName = columns.find((c) => /name/i.test(c)) || '';
                const seen = new Set();
                let valid = 0;
                let invalid = 0;
                let duplicates = 0;
                const capped = rows.slice(0, 5000);
                capped.forEach((r) => {
                    const p = waSvc.normalizePhoneE164(r[guessPhone]);
                    if (!p || p.length < 10) invalid++;
                    else if (seen.has(p)) duplicates++;
                    else {
                        seen.add(p);
                        valid++;
                    }
                });
                res.json({ columns, guessPhone, guessName, total: rows.length, capped: rows.length > 5000, rows: capped, summary: { valid, invalid, duplicates } });
            });
        });
    });

    /* ---------------------------------------------------------- campaigns */
    function campaignFromBody(b, adm) {
        const kind = ['template', 'text', 'media', 'document'].includes(String(b.message_kind)) ? String(b.message_kind) : 'template';
        return {
            name: String(b.name || '').trim(),
            campaign_type: String(b.campaign_type || 'custom'),
            source: String(b.source || 'event'),
            seminar_id: parseInt(b.seminar_id, 10) || null,
            day_id: parseInt(b.day_id, 10) || null,
            audience_filter: String(b.audience_filter || 'all'),
            audience_json: JSON.stringify({ registrationIds: Array.isArray(b.registration_ids) ? b.registration_ids : [], uploadName: b.upload_name || '' }),
            per_ticket: b.per_ticket ? 1 : 0,
            message_kind: kind,
            template_id: parseInt(b.template_id, 10) || null,
            template_name: b.template_name ? waSvc.sanitizeWhatsAppTemplateName(b.template_name) : null,
            template_lang: b.template_lang || null,
            body_text: b.body_text || null,
            media_url: b.media_url || null,
            media_type: b.media_type || null,
            media_filename: b.media_filename || null,
            media_caption: b.media_caption || null,
            variable_map_json: b.variable_map != null ? JSON.stringify(b.variable_map) : null,
            scheduled_at: b.scheduled_at ? new Date(b.scheduled_at).toISOString() : null,
            created_by: adm.id
        };
    }

    function loadRecipientsForCampaign(c, b, cb) {
        if (c.source === 'upload' || c.source === 'manual') {
            const list = Array.isArray(b.recipients) ? b.recipients : [];
            return cb(
                null,
                list.map((r) => ({ phone: r.phone, name: r.name || '', vars: { ...(r.vars || {}), participant_name: r.name || (r.vars && r.vars.participant_name) || '', phone: r.phone } }))
            );
        }
        if (!c.seminar_id) return cb(new Error('Select a seminar for an event-based audience'));
        const aud = parseJson(c.audience_json, {});
        audience.buildEventAudience(db, { seminarId: c.seminar_id, filter: c.audience_filter, dayId: c.day_id, registrationIds: aud.registrationIds, perTicket: !!c.per_ticket }, (e, out) => cb(e, out && out.recipients));
    }

    app.get(
        '/api/admin/whatsapp/campaigns',
        admin((req, res) => {
            db.all(`SELECT c.*, s.title AS seminar_title FROM wa_campaigns c LEFT JOIN seminars s ON s.id = c.seminar_id ORDER BY c.id DESC LIMIT 200`, [], (e, rows) => (e ? bad(res, e.message, 500) : res.json({ campaigns: rows || [] })));
        })
    );

    app.post(
        '/api/admin/whatsapp/campaigns',
        admin((req, res, adm) => {
            const b = req.body || {};
            const c = campaignFromBody(b, adm);
            if (!c.name) return bad(res, 'Campaign name is required');
            if (c.message_kind === 'template' && !c.template_name && !c.template_id) return bad(res, 'Choose a template');
            if (c.message_kind === 'text' && !c.body_text) return bad(res, 'Message text is required');
            if ((c.message_kind === 'media' || c.message_kind === 'document') && !/^https:\/\//i.test(c.media_url || '')) return bad(res, 'Media URL must be a public https link');
            const resolveTemplate = (cbT) => {
                if (c.message_kind !== 'template' || !c.template_id) return cbT();
                db.get(`SELECT meta_name, language FROM wa_templates WHERE id = ?`, [c.template_id], (e, t) => {
                    if (t) {
                        c.template_name = c.template_name || t.meta_name;
                        c.template_lang = c.template_lang || t.language;
                    }
                    cbT();
                });
            };
            resolveTemplate(() => {
                const cols = Object.keys(c);
                db.run(`INSERT INTO wa_campaigns (${cols.join(', ')}, status) VALUES (${cols.map(() => '?').join(', ')}, 'draft')`, cols.map((k) => c[k]), function (e) {
                    if (e) return bad(res, e.message, 500);
                    const id = this && this.lastID;
                    const finishWith = (cid) => {
                        loadRecipientsForCampaign({ ...c, id: cid }, b, (e2, recipients) => {
                            if (e2) return bad(res, e2.message);
                            central.replaceRecipients(db, cid, recipients, !!c.per_ticket, (e3, stats) => {
                                if (e3) return bad(res, e3.message, 500);
                                db.run(`UPDATE wa_campaigns SET status = 'ready', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'draft'`, [cid], () => {
                                    activityLog.logFromRequest(db, req, { user_id: adm.id, user_role: 'admin', action: 'whatsapp_campaign_create', resource_type: 'whatsapp_campaign', resource_id: cid, seminar_id: c.seminar_id, meta: stats });
                                    central.getCampaign(db, cid, (e4, row) => res.json({ ok: true, campaign: row, stats }));
                                });
                            });
                        });
                    };
                    if (id) return finishWith(id);
                    db.get(`SELECT id FROM wa_campaigns WHERE created_by = ? ORDER BY id DESC LIMIT 1`, [adm.id], (e5, row) => finishWith(row && row.id));
                });
            });
        })
    );

    app.get(
        '/api/admin/whatsapp/campaigns/:id',
        admin((req, res) => {
            const id = parseInt(req.params.id, 10) || 0;
            db.get(`SELECT c.*, s.title AS seminar_title, t.name AS template_label FROM wa_campaigns c LEFT JOIN seminars s ON s.id = c.seminar_id LEFT JOIN wa_templates t ON t.id = c.template_id WHERE c.id = ?`, [id], (e, c) => {
                if (e) return bad(res, e.message, 500);
                if (!c) return bad(res, 'Campaign not found', 404);
                central.refreshCampaignCounters(db, id, (e2, counts) => {
                    const status = String(req.query.status || '');
                    const params = [id];
                    let where = 'campaign_id = ?';
                    if (status) {
                        where += ' AND status = ?';
                        params.push(status);
                    }
                    const limit = Math.min(500, parseInt(req.query.limit, 10) || 100);
                    db.all(`SELECT * FROM wa_campaign_recipients WHERE ${where} ORDER BY id ASC LIMIT ${limit}`, params, (e3, recips) => {
                        res.json({
                            campaign: { ...c, audience: parseJson(c.audience_json, {}), variable_map: parseJson(c.variable_map_json, null) },
                            counts,
                            recipients: (recips || []).map((r) => ({ ...r, vars: parseJson(r.vars_json, {}) }))
                        });
                    });
                });
            });
        })
    );

    /** Preview before sending: campaign + audience + recipient count + message estimate + sample rendered message. */
    app.get(
        '/api/admin/whatsapp/campaigns/:id/preview',
        admin((req, res) => {
            const id = parseInt(req.params.id, 10) || 0;
            db.get(`SELECT c.*, s.title AS seminar_title FROM wa_campaigns c LEFT JOIN seminars s ON s.id = c.seminar_id WHERE c.id = ?`, [id], (e, c) => {
                if (e || !c) return bad(res, 'Campaign not found', 404);
                const tplLoad = (cbT) => (c.template_id ? db.get(`SELECT * FROM wa_templates WHERE id = ?`, [c.template_id], (e1, t) => cbT(t || null)) : cbT(null));
                tplLoad((template) => {
                    db.get(`SELECT COUNT(*) AS n, COUNT(DISTINCT phone) AS phones FROM wa_campaign_recipients WHERE campaign_id = ? AND status = 'pending'`, [id], (e2, cnt) => {
                        db.get(`SELECT * FROM wa_campaign_recipients WHERE campaign_id = ? ORDER BY id ASC LIMIT 1`, [id], (e3, first) => {
                            let sample = null;
                            if (first) {
                                const msg = central.buildMessageForRecipient(c, first, template);
                                sample = {
                                    to: first.phone,
                                    name: first.name,
                                    kind: msg.kind,
                                    templateName: msg.templateName || null,
                                    params: msg.kind === 'template' ? central.buildParamsFromMapping(msg.mapping, msg.vars, msg.variableCount) : null,
                                    body: msg.kind === 'text' ? central.renderTemplateString(msg.body, msg.vars) : msg.caption ? central.renderTemplateString(msg.caption, msg.vars) : null,
                                    bodyPreview: template && template.body_text ? template.body_text.replace(/\{\{(\d+)\}\}/g, (m, n) => {
                                        const p = central.buildParamsFromMapping(msg.mapping, msg.vars, msg.variableCount);
                                        return p[Number(n) - 1] != null ? p[Number(n) - 1] : m;
                                    }) : null
                                };
                            }
                            res.json({
                                campaign: { id: c.id, name: c.name, type: c.campaign_type, status: c.status, seminar: c.seminar_title, filter: c.audience_filter, perTicket: !!c.per_ticket, kind: c.message_kind, template: c.template_name, lang: c.template_lang, scheduledAt: c.scheduled_at },
                                recipients: cnt ? Number(cnt.phones) : 0,
                                estimatedMessages: cnt ? Number(cnt.n) : 0,
                                sample
                            });
                        });
                    });
                });
            });
        })
    );

    app.post(
        '/api/admin/whatsapp/campaigns/:id/send',
        admin((req, res, adm) => {
            const id = parseInt(req.params.id, 10) || 0;
            if (req.body.confirm !== true && String(req.body.confirm) !== 'true') return bad(res, 'Confirmation required (confirm: true)');
            if (!waSvc.isWhatsAppConfigured()) return bad(res, 'WhatsApp is not configured in Integrations');
            central.startCampaign(db, id, adm.id, (e, out) => {
                if (e) return bad(res, e.message, 409);
                activityLog.logFromRequest(db, req, { user_id: adm.id, user_role: 'admin', action: 'whatsapp_campaign_send', resource_type: 'whatsapp_campaign', resource_id: id });
                res.json(out);
            });
        })
    );
    app.post(
        '/api/admin/whatsapp/campaigns/:id/pause',
        admin((req, res) => central.pauseCampaign(db, parseInt(req.params.id, 10) || 0, (e, out) => (e ? bad(res, e.message, 500) : res.json(out))))
    );
    app.post(
        '/api/admin/whatsapp/campaigns/:id/cancel',
        admin((req, res, adm) => {
            const id = parseInt(req.params.id, 10) || 0;
            central.cancelCampaign(db, id, (e, out) => {
                if (e) return bad(res, e.message, 500);
                activityLog.logFromRequest(db, req, { user_id: adm.id, user_role: 'admin', action: 'whatsapp_campaign_cancel', resource_type: 'whatsapp_campaign', resource_id: id });
                res.json(out);
            });
        })
    );
    app.post(
        '/api/admin/whatsapp/campaigns/:id/retry-failed',
        admin((req, res) => central.retryFailed(db, parseInt(req.params.id, 10) || 0, (e, out) => (e ? bad(res, e.message, 500) : res.json(out))))
    );
    app.post(
        '/api/admin/whatsapp/campaigns/:id/refresh-audience',
        admin((req, res) => {
            const id = parseInt(req.params.id, 10) || 0;
            central.getCampaign(db, id, (e, c) => {
                if (e || !c) return bad(res, 'Campaign not found', 404);
                if (!['draft', 'ready'].includes(c.status)) return bad(res, 'Only draft/ready campaigns can refresh their audience', 409);
                if (c.source !== 'event') return bad(res, 'Only event audiences can be refreshed', 409);
                loadRecipientsForCampaign(c, {}, (e2, recipients) => {
                    if (e2) return bad(res, e2.message);
                    central.replaceRecipients(db, id, recipients, !!c.per_ticket, (e3, stats) => (e3 ? bad(res, e3.message, 500) : res.json({ ok: true, stats })));
                });
            });
        })
    );
    app.delete(
        '/api/admin/whatsapp/campaigns/:id',
        admin((req, res) => {
            const id = parseInt(req.params.id, 10) || 0;
            db.get(`SELECT status FROM wa_campaigns WHERE id = ?`, [id], (e, c) => {
                if (!c) return bad(res, 'Campaign not found', 404);
                if (!['draft', 'ready', 'cancelled'].includes(c.status)) return bad(res, 'Only draft/ready/cancelled campaigns can be deleted', 409);
                db.run(`DELETE FROM wa_campaign_recipients WHERE campaign_id = ?`, [id], () => db.run(`DELETE FROM wa_campaigns WHERE id = ?`, [id], (e2) => (e2 ? bad(res, e2.message, 500) : res.json({ ok: true }))));
            });
        })
    );

    /* ------------------------------------------------------- send message */
    app.post(
        '/api/admin/whatsapp/send',
        admin((req, res, adm) => {
            const b = req.body || {};
            const kind = ['template', 'text', 'media', 'document'].includes(String(b.kind)) ? String(b.kind) : 'template';
            const finishSend = (phone, vars, meta) => {
                const msg = {
                    kind,
                    phone,
                    vars,
                    templateName: b.template_name ? waSvc.sanitizeWhatsAppTemplateName(b.template_name) : undefined,
                    lang: b.template_lang || undefined,
                    params: Array.isArray(b.params) ? b.params.map((p) => central.renderTemplateString(p, vars)) : undefined,
                    mapping: !Array.isArray(b.params) && b.variable_map ? b.variable_map : undefined,
                    variableCount: b.variable_count != null ? parseInt(b.variable_count, 10) : undefined,
                    body: b.body,
                    mediaUrl: b.media_url,
                    mediaType: b.media_type,
                    filename: b.media_filename,
                    caption: b.caption,
                    headerMediaUrl: b.header_media_url || undefined,
                    headerMediaType: b.header_media_type || undefined,
                    meta: { ...meta, messageType: b.message_type || 'manual', bypassOptOut: !!b.bypass_opt_out }
                };
                central.send(db, msg, (e, r) => {
                    activityLog.logFromRequest(db, req, { user_id: adm.id, user_role: 'admin', action: 'whatsapp_send', resource_type: 'whatsapp_message', resource_id: r && r.logId, meta: { phone, kind, ok: r && r.ok } });
                    if (!r || !r.ok) return res.status(r && r.skipped ? 409 : 502).json({ ok: false, error: (r && r.error) || 'Send failed', status: r && r.status });
                    res.json({ ok: true, messageId: r.messageId, logId: r.logId });
                });
            };
            const regId = parseInt(b.registration_id, 10) || 0;
            if (regId) {
                db.get(`SELECT seminar_id FROM registrations WHERE id = ?`, [regId], (e, reg) => {
                    if (!reg) return bad(res, 'Registration not found', 404);
                    audience.buildEventAudience(db, { seminarId: reg.seminar_id, filter: 'custom', registrationIds: [regId], perTicket: false }, (e2, out) => {
                        if (e2) return bad(res, e2.message);
                        const r = out.recipients[0];
                        if (!r) return bad(res, 'Participant has no phone number');
                        finishSend(b.phone || r.phone, { ...r.vars, ...(b.vars || {}) }, { userId: r.userId, registrationId: regId, seminarId: reg.seminar_id });
                    });
                });
                return;
            }
            if (!b.phone) return bad(res, 'phone or registration_id is required');
            finishSend(b.phone, b.vars || {}, {});
        })
    );

    /* -------------------------------------------------------------- logs */
    app.get(
        '/api/admin/whatsapp/logs',
        admin((req, res) => {
            const params = [];
            const where = ['1 = 1'];
            if (req.query.status) {
                where.push('m.status = ?');
                params.push(String(req.query.status));
            }
            if (req.query.campaignId) {
                where.push('m.campaign_id = ?');
                params.push(parseInt(req.query.campaignId, 10) || 0);
            }
            if (req.query.direction) {
                where.push('m.direction = ?');
                params.push(String(req.query.direction));
            }
            if (req.query.q) {
                const t = '%' + String(req.query.q).trim() + '%';
                where.push('(m.phone LIKE ? OR m.template_name LIKE ? OR m.preview LIKE ? OR m.provider_message_id LIKE ?)');
                params.push(t, t, t, t);
            }
            const limit = Math.min(500, parseInt(req.query.limit, 10) || 100);
            db.all(
                `SELECT m.*, c.name AS campaign_name, u.first_name, u.last_name, r.application_no, s.title AS seminar_title
                 FROM wa_messages m
                 LEFT JOIN wa_campaigns c ON c.id = m.campaign_id
                 LEFT JOIN users u ON u.id = m.user_id
                 LEFT JOIN registrations r ON r.id = m.registration_id
                 LEFT JOIN seminars s ON s.id = m.seminar_id
                 WHERE ${where.join(' AND ')} ORDER BY m.id DESC LIMIT ${limit}`,
                params,
                (e, rows) => (e ? bad(res, e.message, 500) : res.json({ logs: rows || [] }))
            );
        })
    );

    /* ----------------------------------------------------------- contacts */
    app.get(
        '/api/admin/whatsapp/contacts',
        admin((req, res) => {
            const optedOut = String(req.query.optedOut || '') === '1';
            db.all(`SELECT * FROM wa_contacts ${optedOut ? 'WHERE opted_out = 1' : ''} ORDER BY updated_at DESC LIMIT 500`, [], (e, rows) => (e ? bad(res, e.message, 500) : res.json({ contacts: rows || [] })));
        })
    );
    app.post(
        '/api/admin/whatsapp/contacts/opt',
        admin((req, res, adm) => {
            const b = req.body || {};
            central.setOptStatus(db, b.phone, !!b.optedOut, 'admin:' + adm.id, (e) => (e ? bad(res, e.message) : res.json({ ok: true })));
        })
    );

    /* -------------------------------------------------------------- flows */
    app.get(
        '/api/admin/whatsapp/flows',
        admin((req, res) => {
            db.all(`SELECT f.*, s.title AS seminar_title FROM wa_flows f LEFT JOIN seminars s ON s.id = f.seminar_id ORDER BY f.id DESC`, [], (e, rows) => {
                if (e) return bad(res, e.message, 500);
                db.all(`SELECT * FROM wa_flow_sessions ORDER BY id DESC LIMIT 50`, [], (e2, sessions) => res.json({ flows: rows || [], sessions: sessions || [], actions: flows.actionNames() }));
            });
        })
    );
    app.post(
        '/api/admin/whatsapp/flows',
        admin((req, res) => {
            const b = req.body || {};
            const id = parseInt(b.id, 10) || 0;
            if (!String(b.name || '').trim()) return bad(res, 'Flow name is required');
            const params = [String(b.name).trim(), b.meta_flow_id || null, b.purpose || 'registration', parseInt(b.seminar_id, 10) || null, b.first_screen || null, b.cta_text || null, b.body_text || null, b.header_text || null, b.config ? JSON.stringify(b.config) : null, b.is_active === false || Number(b.is_active) === 0 ? 0 : 1];
            if (id) {
                db.run(`UPDATE wa_flows SET name = ?, meta_flow_id = ?, purpose = ?, seminar_id = ?, first_screen = ?, cta_text = ?, body_text = ?, header_text = ?, config_json = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [...params, id], (e) => (e ? bad(res, e.message, 500) : res.json({ ok: true, id })));
            } else {
                db.run(`INSERT INTO wa_flows (name, meta_flow_id, purpose, seminar_id, first_screen, cta_text, body_text, header_text, config_json, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, params, function (e) {
                    e ? bad(res, e.message, 500) : res.json({ ok: true, id: this && this.lastID });
                });
            }
        })
    );
    app.delete(
        '/api/admin/whatsapp/flows/:id',
        admin((req, res) => db.run(`DELETE FROM wa_flows WHERE id = ?`, [parseInt(req.params.id, 10) || 0], (e) => (e ? bad(res, e.message, 500) : res.json({ ok: true }))))
    );
    /** Send a Flow message to one phone (starts a session). */
    app.post(
        '/api/admin/whatsapp/flows/:id/send',
        admin((req, res, adm) => {
            const id = parseInt(req.params.id, 10) || 0;
            db.get(`SELECT * FROM wa_flows WHERE id = ?`, [id], (e, f) => {
                if (!f) return bad(res, 'Flow not found', 404);
                if (!f.meta_flow_id) return bad(res, 'Set the Meta Flow ID first');
                const phone = waSvc.normalizePhoneE164(req.body.phone);
                if (!phone) return bad(res, 'Valid phone required');
                const token = crypto.randomBytes(16).toString('hex');
                db.run(`INSERT INTO wa_flow_sessions (flow_token, flow_id, meta_flow_id, phone, seminar_id, data_json) VALUES (?, ?, ?, ?, ?, ?)`, [token, f.id, f.meta_flow_id, phone, f.seminar_id || null, JSON.stringify({ seminar_id: f.seminar_id || undefined })], () => {
                    central.send(
                        db,
                        {
                            kind: 'flow',
                            phone,
                            flow: { flowId: f.meta_flow_id, flowToken: token, cta: f.cta_text || 'Open', body: f.body_text || 'Tap to continue', header: f.header_text || undefined, firstScreen: f.first_screen || undefined, data: f.seminar_id ? { seminar_id: String(f.seminar_id) } : undefined },
                            meta: { messageType: 'flow', seminarId: f.seminar_id || null }
                        },
                        (e2, r) => {
                            activityLog.logFromRequest(db, req, { user_id: adm.id, user_role: 'admin', action: 'whatsapp_flow_send', resource_type: 'whatsapp_flow', resource_id: id, meta: { phone, ok: r && r.ok } });
                            if (!r || !r.ok) return res.status(502).json({ ok: false, error: (r && r.error) || 'Send failed' });
                            res.json({ ok: true, messageId: r.messageId, flowToken: token });
                        }
                    );
                });
            });
        })
    );
    /** Dry-run a Flow action with sample data (no Meta call). */
    app.post(
        '/api/admin/whatsapp/flows/test-action',
        admin((req, res) => {
            const b = req.body || {};
            flows
                .dispatch(db, { version: '3.0', action: 'data_exchange', screen: b.screen || 'TEST', flow_token: b.flow_token || '', data: { ...(b.data || {}), action: b.action } }, { generateId, getOrCreatePendingOrder })
                .then((out) => res.json(out))
                .catch((e) => bad(res, e.message, 500));
        })
    );

    /* ------------------------------------------ public Flow data exchange */
    app.post('/api/whatsapp/flow/data-exchange', flows.makeEndpoint(db, { generateId, getOrCreatePendingOrder }, central.loadSettings));
}

module.exports = { registerWhatsAppRoutes, CAMPAIGN_TYPES };
