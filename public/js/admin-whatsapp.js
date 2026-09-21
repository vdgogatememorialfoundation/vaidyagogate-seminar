/* Admin → WhatsApp section: Dashboard, Send Message, Campaigns, Templates, Flows, Message Logs, Settings. */
(function () {
    'use strict';

    const state = { meta: null, section: 'dashboard', templates: [], campaigns: [], upload: null, customRegs: [], inited: false, logsTimer: null };

    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const aid = () => (typeof adminActorId === 'function' ? adminActorId() : null);
    const fmtDt = (v) => {
        if (!v) return '—';
        const d = new Date(String(v).replace(' ', 'T').replace(/(\+00)?$/, (m) => (m ? 'Z' : '')));
        return isNaN(d) ? String(v) : d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    };

    async function api(path, opts) {
        opts = opts || {};
        const url = new URL(path, location.origin);
        if (!opts.body || !(opts.body instanceof FormData)) url.searchParams.set('actingAdminId', aid() || '');
        const init = { method: opts.method || 'GET', headers: {} };
        if (opts.body instanceof FormData) {
            opts.body.append('actingAdminId', aid() || '');
            init.body = opts.body;
        } else if (opts.body) {
            init.headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify({ ...opts.body, actingAdminId: aid() });
        }
        const res = await fetch(url.toString(), init);
        let data = {};
        try {
            data = await res.json();
        } catch (_) {}
        if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
        return data;
    }

    function toast(msg, isErr) {
        const el = $('wa-toast') || (() => {
            const d = document.createElement('div');
            d.id = 'wa-toast';
            d.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:9999;padding:10px 14px;border-radius:10px;color:#fff;font-weight:600;box-shadow:0 6px 20px rgba(0,0,0,.2);display:none;max-width:360px;';
            document.body.appendChild(d);
            return d;
        })();
        el.textContent = msg;
        el.style.background = isErr ? '#b91c1c' : '#15803d';
        el.style.display = 'block';
        clearTimeout(el._t);
        el._t = setTimeout(() => (el.style.display = 'none'), 4000);
    }

    function statusBadge(s) {
        const colors = { sent: '#0369a1', delivered: '#15803d', read: '#166534', failed: '#b91c1c', skipped: '#6b7280', pending: '#a16207', queued: '#a16207', sending: '#0369a1', completed: '#15803d', cancelled: '#6b7280', paused: '#a16207', ready: '#7c3aed', draft: '#6b7280', received: '#0f766e', accepted: '#0369a1' };
        return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:.75rem;font-weight:700;color:#fff;background:${colors[s] || '#475569'}">${esc(s || '—')}</span>`;
    }

    /* ------------------------------------------------------------- init */
    async function init() {
        if (!state.inited) {
            state.inited = true;
            injectStyles();
            $('wa-subnav').addEventListener('click', (e) => {
                const b = e.target.closest('[data-wa-section]');
                if (b) showSection(b.getAttribute('data-wa-section'));
            });
        }
        try {
            state.meta = await api('/api/admin/whatsapp/meta');
        } catch (e) {
            toast('WhatsApp: ' + e.message, true);
            return;
        }
        const badge = $('wa-config-badge');
        if (badge) {
            badge.textContent = state.meta.configured ? 'Meta API connected' : 'Not configured — set token in Integrations';
            badge.style.cssText = 'font-size:.8rem;padding:4px 10px;border-radius:999px;font-weight:700;color:#fff;background:' + (state.meta.configured ? '#15803d' : '#b91c1c');
        }
        showSection(state.section);
    }

    function showSection(name) {
        state.section = name;
        document.querySelectorAll('#wa-subnav .wa-subnav-btn').forEach((b) => b.classList.toggle('active', b.getAttribute('data-wa-section') === name));
        document.querySelectorAll('#tab-whatsapp .wa-section').forEach((s) => s.classList.toggle('hidden', s.id !== 'wa-section-' + name));
        if (state.logsTimer) {
            clearInterval(state.logsTimer);
            state.logsTimer = null;
        }
        const r = { dashboard: renderDashboard, send: renderSend, campaigns: renderCampaigns, templates: renderTemplates, flows: renderFlows, logs: renderLogs, settings: renderSettings }[name];
        if (r) r();
    }

    function injectStyles() {
        const css = `
        .wa-subnav{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px;border-bottom:1px solid #e2e8f0;padding-bottom:10px}
        .wa-subnav-btn{border:1px solid #d1d5db;background:#fff;color:#334155;border-radius:999px;padding:7px 14px;font-weight:600;cursor:pointer;font-size:.86rem}
        .wa-subnav-btn.active{background:#16a34a;border-color:#16a34a;color:#fff}
        .wa-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:16px}
        .wa-stat{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px}
        .wa-stat .n{font-size:1.6rem;font-weight:800;color:#0f172a}
        .wa-stat .l{font-size:.78rem;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.03em}
        .wa-card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px;margin-bottom:16px}
        .wa-card h3{margin:0 0 12px;font-size:1rem}
        .wa-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
        .wa-form label{display:block;font-size:.8rem;font-weight:700;color:#475569;margin-bottom:4px}
        .wa-form input,.wa-form select,.wa-form textarea,.wa-inline input,.wa-inline select{width:100%;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;font:inherit;background:#fff}
        .wa-form .full{grid-column:1/-1}
        .wa-table-wrap{overflow-x:auto}
        .wa-table{width:100%;border-collapse:collapse;font-size:.85rem}
        .wa-table th,.wa-table td{padding:8px 10px;border-bottom:1px solid #f1f5f9;text-align:left;vertical-align:top;white-space:nowrap}
        .wa-table th{background:#f8fafc;font-size:.75rem;text-transform:uppercase;letter-spacing:.03em;color:#64748b}
        .wa-btn{border:none;border-radius:8px;padding:8px 14px;font-weight:700;cursor:pointer;font-size:.85rem;background:#16a34a;color:#fff}
        .wa-btn.sec{background:#fff;color:#334155;border:1px solid #cbd5e1}
        .wa-btn.danger{background:#b91c1c}
        .wa-btn.sm{padding:5px 10px;font-size:.78rem}
        .wa-btn:disabled{opacity:.5;cursor:not-allowed}
        .wa-inline{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}
        .wa-inline input,.wa-inline select{width:auto;min-width:160px}
        .wa-preview{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:14px;margin-top:12px}
        .wa-bubble{background:#dcfce7;border-radius:12px;padding:10px 12px;white-space:pre-wrap;font-size:.9rem;max-width:420px}
        .wa-map-row{display:grid;grid-template-columns:90px 1fr;gap:8px;align-items:center;margin-bottom:6px}
        .wa-muted{color:#64748b;font-size:.82rem}
        .wa-modal-bg{position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:9000;display:flex;align-items:center;justify-content:center;padding:16px}
        .wa-modal{background:#fff;border-radius:14px;max-width:760px;width:100%;max-height:90vh;overflow:auto;padding:20px}
        .wa-chip{display:inline-block;background:#f1f5f9;border-radius:999px;padding:2px 8px;font-size:.75rem;margin:2px}
        @media (max-width:640px){.wa-table th,.wa-table td{white-space:normal}}`;
        const st = document.createElement('style');
        st.textContent = css;
        document.head.appendChild(st);
    }

    function modal(html) {
        const bg = document.createElement('div');
        bg.className = 'wa-modal-bg';
        bg.innerHTML = `<div class="wa-modal">${html}</div>`;
        bg.addEventListener('click', (e) => {
            if (e.target === bg) bg.remove();
        });
        document.body.appendChild(bg);
        return bg;
    }

    /* -------------------------------------------------------- dashboard */
    async function renderDashboard() {
        const el = $('wa-section-dashboard');
        el.innerHTML = '<p class="wa-muted">Loading…</p>';
        let d;
        try {
            d = await api('/api/admin/whatsapp/dashboard');
        } catch (e) {
            el.innerHTML = `<p style="color:#b91c1c">${esc(e.message)}</p>`;
            return;
        }
        const sum = (o, keys) => keys.reduce((a, k) => a + (Number(o[k]) || 0), 0);
        const l7 = d.last7d || {};
        const l1 = d.last24h || {};
        el.innerHTML = `
        <div class="wa-grid">
            <div class="wa-stat"><div class="n">${sum(l1, ['sent', 'delivered', 'read', 'accepted'])}</div><div class="l">Sent · 24h</div></div>
            <div class="wa-stat"><div class="n">${sum(l7, ['sent', 'delivered', 'read', 'accepted'])}</div><div class="l">Sent · 7 days</div></div>
            <div class="wa-stat"><div class="n">${sum(l7, ['delivered', 'read'])}</div><div class="l">Delivered · 7 days</div></div>
            <div class="wa-stat"><div class="n">${sum(l7, ['read'])}</div><div class="l">Read · 7 days</div></div>
            <div class="wa-stat"><div class="n" style="color:#b91c1c">${sum(l7, ['failed'])}</div><div class="l">Failed · 7 days</div></div>
            <div class="wa-stat"><div class="n">${(d.campaigns || {}).sending || 0}</div><div class="l">Campaigns sending</div></div>
            <div class="wa-stat"><div class="n">${d.activeTemplates || 0}</div><div class="l">Active templates</div></div>
            <div class="wa-stat"><div class="n">${d.optedOut || 0}</div><div class="l">Opted out</div></div>
        </div>
        <div class="wa-card"><h3>Active campaigns</h3>${
            (d.activeCampaigns || []).length
                ? `<div class="wa-table-wrap"><table class="wa-table"><thead><tr><th>Campaign</th><th>Status</th><th>Progress</th><th></th></tr></thead><tbody>${d.activeCampaigns
                      .map((c) => `<tr><td>${esc(c.name)}</td><td>${statusBadge(c.status)}</td><td>${c.sent_count}/${c.total_recipients} sent · ${c.failed_count} failed</td><td><button class="wa-btn sm sec" onclick="AdminWhatsApp.openCampaign(${c.id})">Open</button></td></tr>`)
                      .join('')}</tbody></table></div>`
                : '<p class="wa-muted">No campaign is sending right now.</p>'
        }</div>
        <div class="wa-card"><h3>Recent messages</h3>${renderLogTable(d.recent || [])}</div>
        <div class="wa-card"><h3>Quick actions</h3><div class="wa-inline">
            <button class="wa-btn" onclick="AdminWhatsApp.show('send')">Send a message</button>
            <button class="wa-btn sec" onclick="AdminWhatsApp.show('campaigns');setTimeout(()=>AdminWhatsApp.newCampaign(),50)">New campaign</button>
            <button class="wa-btn sec" onclick="AdminWhatsApp.show('templates')">Sync templates from Meta</button>
        </div></div>`;
    }

    /* ------------------------------------------------------------- send */
    function templateOptions(selected) {
        const active = state.templates.filter((t) => t.is_active);
        return '<option value="">— choose template —</option>' + active.map((t) => `<option value="${t.id}" ${Number(selected) === t.id ? 'selected' : ''}>${esc(t.name)} (${esc(t.meta_name)} · ${esc(t.language)}${t.status ? ' · ' + esc(t.status) : ''})</option>`).join('');
    }
    function variableOptions(sel) {
        return '<option value="">(empty)</option>' + state.meta.variables.map((v) => `<option value="{{${v.key}}}" ${sel === '{{' + v.key + '}}' ? 'selected' : ''}>${esc(v.label)} — {{${v.key}}}</option>`).join('');
    }
    function seminarOptions(sel) {
        return '<option value="">— select seminar —</option>' + state.meta.seminars.map((s) => `<option value="${s.id}" ${Number(sel) === s.id ? 'selected' : ''}>${esc(s.title)}${s.event_date ? ' · ' + esc(String(s.event_date).slice(0, 10)) : ''}</option>`).join('');
    }
    async function ensureTemplates() {
        if (!state.templates.length) {
            try {
                state.templates = (await api('/api/admin/whatsapp/templates')).templates || [];
            } catch (_) {}
        }
    }

    function mappingEditor(prefix, count, current) {
        let html = '';
        for (let i = 0; i < count; i++) {
            const cur = Array.isArray(current) ? current[i] : '';
            html += `<div class="wa-map-row"><span class="wa-muted">{{${i + 1}}}</span><div style="display:flex;gap:6px"><select data-map-idx="${i}" class="${prefix}-map-sel" onchange="this.nextElementSibling.value=this.value">${variableOptions(cur)}</select><input data-map-idx="${i}" class="${prefix}-map-in" value="${esc(cur || '')}" placeholder="or type text / mix {{var}}" style="flex:1"></div></div>`;
        }
        return html || '<p class="wa-muted">This template has no body variables.</p>';
    }
    function readMapping(prefix) {
        return Array.from(document.querySelectorAll('.' + prefix + '-map-in')).map((i) => i.value);
    }

    async function renderSend() {
        const el = $('wa-section-send');
        await ensureTemplates();
        el.innerHTML = `
        <div class="wa-card"><h3>Send a single message</h3>
        <div class="wa-form">
            <div><label>Recipient</label>
                <select id="wa-send-mode" onchange="AdminWhatsApp.sendModeChanged()"><option value="phone">Phone number</option><option value="registration">Registered participant (auto variables)</option></select></div>
            <div id="wa-send-phone-wrap"><label>Phone (10-digit or +91…)</label><input id="wa-send-phone" placeholder="98xxxxxxxx"></div>
            <div id="wa-send-reg-wrap" class="hidden"><label>Find participant</label><input id="wa-send-reg-q" placeholder="name / phone / email / application no" oninput="AdminWhatsApp.searchReg(this.value,'wa-send-reg-results')"><div id="wa-send-reg-results" class="wa-muted" style="margin-top:4px"></div><input type="hidden" id="wa-send-reg-id"></div>
            <div><label>Message kind</label>
                <select id="wa-send-kind" onchange="AdminWhatsApp.sendKindChanged()"><option value="template">Template (approved Meta template)</option><option value="text">Free text (24h session only)</option><option value="media">Image / video</option><option value="document">Document (PDF)</option></select></div>
            <div id="wa-send-tpl-wrap"><label>Template</label><select id="wa-send-template" onchange="AdminWhatsApp.sendTemplateChanged()">${templateOptions()}</select></div>
            <div id="wa-send-map" class="full"></div>
            <div id="wa-send-text-wrap" class="full hidden"><label>Text (supports {{variables}} for participants)</label><textarea id="wa-send-text" rows="4"></textarea></div>
            <div id="wa-send-media-wrap" class="full hidden"><div class="wa-form"><div><label>Public https URL</label><input id="wa-send-media-url" placeholder="https://…/file.pdf"></div><div><label>File name (documents)</label><input id="wa-send-media-name" placeholder="ticket.pdf"></div><div class="full"><label>Caption</label><input id="wa-send-caption"></div></div></div>
            <div class="full wa-inline"><button class="wa-btn" id="wa-send-btn" onclick="AdminWhatsApp.doSend()">Send now</button><label style="margin:0;display:flex;gap:6px;align-items:center;font-weight:600"><input type="checkbox" id="wa-send-bypass" style="width:auto"> Ignore opt-out (transactional)</label><span id="wa-send-status" class="wa-muted"></span></div>
        </div></div>
        <div class="wa-card"><h3>Variables you can use</h3><div>${state.meta.variables.map((v) => `<span class="wa-chip" title="${esc(v.label)}">{{${v.key}}}</span>`).join('')}</div><p class="wa-muted" style="margin-top:8px">Variables are filled from the participant's registration, payment, ticket and seminar records.</p></div>`;
        sendTemplateChanged();
    }
    function sendModeChanged() {
        const m = $('wa-send-mode').value;
        $('wa-send-phone-wrap').classList.toggle('hidden', m !== 'phone');
        $('wa-send-reg-wrap').classList.toggle('hidden', m !== 'registration');
    }
    function sendKindChanged() {
        const k = $('wa-send-kind').value;
        $('wa-send-tpl-wrap').classList.toggle('hidden', k !== 'template');
        $('wa-send-map').classList.toggle('hidden', k !== 'template');
        $('wa-send-text-wrap').classList.toggle('hidden', k !== 'text');
        $('wa-send-media-wrap').classList.toggle('hidden', !(k === 'media' || k === 'document'));
    }
    function sendTemplateChanged() {
        const t = state.templates.find((x) => x.id === Number($('wa-send-template').value));
        $('wa-send-map').innerHTML = t ? `<label>Template variables</label>${t.body_text ? `<div class="wa-bubble" style="margin-bottom:8px">${esc(t.body_text)}</div>` : ''}${mappingEditor('wa-send', Number(t.variable_count) || 0, t.variables)}` : '';
    }
    let regSearchT = null;
    function searchReg(q, targetId, seminarId) {
        clearTimeout(regSearchT);
        if (!q || q.length < 2) return;
        regSearchT = setTimeout(async () => {
            try {
                const r = await api('/api/admin/whatsapp/audience/search?q=' + encodeURIComponent(q) + (seminarId ? '&seminarId=' + seminarId : ''));
                const box = $(targetId);
                box.innerHTML = (r.results || []).length
                    ? r.results.map((x) => `<div style="padding:4px 0;border-bottom:1px solid #f1f5f9;cursor:pointer" onclick="AdminWhatsApp.pickReg(${x.id}, '${targetId}', ${JSON.stringify(esc(x.first_name + ' ' + (x.last_name || '')))}, ${JSON.stringify(esc(x.phone || ''))}, ${JSON.stringify(esc(x.application_no || ''))})"><strong>${esc(x.first_name)} ${esc(x.last_name || '')}</strong> · ${esc(x.phone || '')} · #${esc(x.application_no || '')} · ${esc(x.seminar_title)} · ${esc(String(x.status).replace(/_/g, ' '))}</div>`).join('')
                    : 'No matches';
            } catch (e) {
                toast(e.message, true);
            }
        }, 300);
    }
    function pickReg(id, targetId, name, phone, appNo) {
        if (targetId === 'wa-send-reg-results') {
            $('wa-send-reg-id').value = id;
            $(targetId).innerHTML = `Selected: <strong>${name}</strong> · ${phone} · #${appNo}`;
        } else {
            if (!state.customRegs.some((r) => r.id === id)) state.customRegs.push({ id, name, phone, appNo });
            renderCustomRegs();
            $(targetId).innerHTML = '';
        }
    }
    async function doSend() {
        const kind = $('wa-send-kind').value;
        const body = { kind, bypass_opt_out: $('wa-send-bypass').checked, message_type: 'manual' };
        if ($('wa-send-mode').value === 'registration') {
            body.registration_id = $('wa-send-reg-id').value;
            if (!body.registration_id) return toast('Pick a participant first', true);
        } else {
            body.phone = $('wa-send-phone').value.trim();
            if (!body.phone) return toast('Enter a phone number', true);
        }
        if (kind === 'template') {
            const t = state.templates.find((x) => x.id === Number($('wa-send-template').value));
            if (!t) return toast('Choose a template', true);
            body.template_name = t.meta_name;
            body.template_lang = t.language;
            body.variable_map = readMapping('wa-send');
            body.variable_count = t.variable_count;
        } else if (kind === 'text') {
            body.body = $('wa-send-text').value;
        } else {
            body.media_url = $('wa-send-media-url').value.trim();
            body.media_type = kind === 'document' ? 'document' : 'image';
            body.media_filename = $('wa-send-media-name').value.trim();
            body.caption = $('wa-send-caption').value;
        }
        $('wa-send-btn').disabled = true;
        $('wa-send-status').textContent = 'Sending…';
        try {
            const r = await api('/api/admin/whatsapp/send', { method: 'POST', body });
            $('wa-send-status').textContent = 'Sent · id ' + (r.messageId || r.logId);
            toast('Message sent');
        } catch (e) {
            $('wa-send-status').textContent = e.message;
            toast(e.message, true);
        }
        $('wa-send-btn').disabled = false;
    }

    /* -------------------------------------------------------- campaigns */
    async function renderCampaigns() {
        const el = $('wa-section-campaigns');
        el.innerHTML = '<p class="wa-muted">Loading…</p>';
        try {
            state.campaigns = (await api('/api/admin/whatsapp/campaigns')).campaigns || [];
        } catch (e) {
            el.innerHTML = `<p style="color:#b91c1c">${esc(e.message)}</p>`;
            return;
        }
        el.innerHTML = `
        <div class="wa-inline"><button class="wa-btn" onclick="AdminWhatsApp.newCampaign()">+ New campaign</button><button class="wa-btn sec" onclick="AdminWhatsApp.show('campaigns')">Refresh</button></div>
        <div id="wa-campaign-form"></div>
        <div class="wa-card"><h3>All campaigns</h3><div class="wa-table-wrap"><table class="wa-table"><thead><tr><th>#</th><th>Name</th><th>Type</th><th>Seminar / audience</th><th>Message</th><th>Status</th><th>Recipients</th><th>Sent</th><th>Delivered</th><th>Read</th><th>Failed</th><th>Created</th><th></th></tr></thead><tbody>${
            state.campaigns.length
                ? state.campaigns
                      .map(
                          (c) => `<tr><td>${c.id}</td><td><strong>${esc(c.name)}</strong></td><td>${esc(c.campaign_type)}</td><td>${esc(c.seminar_title || (c.source === 'upload' ? 'Uploaded list' : '—'))}<br><span class="wa-muted">${esc(c.audience_filter)}${c.per_ticket ? ' · per ticket' : ''}</span></td><td>${esc(c.message_kind)}${c.template_name ? '<br><span class="wa-muted">' + esc(c.template_name) + '</span>' : ''}</td><td>${statusBadge(c.status)}</td><td>${c.total_recipients}</td><td>${c.sent_count}</td><td>${c.delivered_count}</td><td>${c.read_count}</td><td>${c.failed_count}</td><td>${fmtDt(c.created_at)}</td><td><button class="wa-btn sm sec" onclick="AdminWhatsApp.openCampaign(${c.id})">Open</button></td></tr>`
                      )
                      .join('')
                : '<tr><td colspan="13" class="wa-muted">No campaigns yet.</td></tr>'
        }</tbody></table></div></div>`;
    }

    async function newCampaign() {
        await ensureTemplates();
        state.customRegs = [];
        state.upload = null;
        const box = $('wa-campaign-form');
        if (!box) return;
        box.innerHTML = `
        <div class="wa-card"><h3>New campaign</h3>
        <div class="wa-form">
            <div><label>Campaign name</label><input id="wa-c-name" placeholder="e.g. Payment reminder – Day before"></div>
            <div><label>Campaign type</label><select id="wa-c-type" onchange="AdminWhatsApp.campaignTypeChanged()">${state.meta.campaignTypes.filter((t) => t.key !== 'otp').map((t) => `<option value="${t.key}">${esc(t.label)}</option>`).join('')}</select></div>
            <div><label>Audience source</label><select id="wa-c-source" onchange="AdminWhatsApp.campaignSourceChanged()"><option value="event">Seminar / event audience (from database)</option><option value="upload">Upload Excel / CSV</option></select></div>
            <div id="wa-c-event-wrap" class="full"><div class="wa-form">
                <div><label>Seminar</label><select id="wa-c-seminar" onchange="AdminWhatsApp.campaignSeminarChanged()">${seminarOptions()}</select></div>
                <div><label>Audience filter</label><select id="wa-c-filter" onchange="AdminWhatsApp.campaignFilterChanged()">${state.meta.filters.map((f) => `<option value="${f.key}">${esc(f.label)}</option>`).join('')}</select></div>
                <div><label>Day / ticket (optional)</label><select id="wa-c-day"><option value="">All days</option></select></div>
                <div><label style="display:flex;gap:6px;align-items:center;margin-top:22px"><input type="checkbox" id="wa-c-perticket" style="width:auto"> One message per ticket (multi-day e-tickets)</label></div>
                <div id="wa-c-custom-wrap" class="full hidden"><label>Pick registrations</label><input id="wa-c-custom-q" placeholder="search name / phone / application no" oninput="AdminWhatsApp.searchReg(this.value,'wa-c-custom-results', document.getElementById('wa-c-seminar').value)"><div id="wa-c-custom-results" class="wa-muted" style="margin-top:4px"></div><div id="wa-c-custom-list" style="margin-top:6px"></div></div>
                <div class="full wa-inline"><button class="wa-btn sec" onclick="AdminWhatsApp.previewAudience()">Preview audience</button><span id="wa-c-audience-preview" class="wa-muted"></span></div>
            </div></div>
            <div id="wa-c-upload-wrap" class="full hidden"><div class="wa-form">
                <div><label>Excel / CSV file</label><input type="file" id="wa-c-file" accept=".xlsx,.xls,.csv" onchange="AdminWhatsApp.uploadFile(this.files[0])"></div>
                <div><label>Phone column</label><select id="wa-c-phone-col"></select></div>
                <div><label>Name column</label><select id="wa-c-name-col"><option value="">(none)</option></select></div>
                <div class="full" id="wa-c-upload-summary" class="wa-muted"></div>
            </div></div>
            <div><label>Message kind</label><select id="wa-c-kind" onchange="AdminWhatsApp.campaignKindChanged()"><option value="template">Template</option><option value="text">Free text (24h session only)</option><option value="media">Image / video</option><option value="document">Document (PDF)</option></select></div>
            <div id="wa-c-tpl-wrap"><label>Template</label><select id="wa-c-template" onchange="AdminWhatsApp.campaignTemplateChanged()">${templateOptions()}</select></div>
            <div id="wa-c-map" class="full"></div>
            <div id="wa-c-text-wrap" class="full hidden"><label>Text</label><textarea id="wa-c-text" rows="4" placeholder="Hi {{participant_name}}, …"></textarea></div>
            <div id="wa-c-media-wrap" class="full hidden"><div class="wa-form"><div><label>Public https URL</label><input id="wa-c-media-url"></div><div><label>File name</label><input id="wa-c-media-name"></div><div class="full"><label>Caption</label><input id="wa-c-caption"></div></div></div>
            <div><label>Schedule (optional, IST)</label><input type="datetime-local" id="wa-c-sched"></div>
            <div class="full wa-inline"><button class="wa-btn" onclick="AdminWhatsApp.createCampaign()">Create campaign (no sending yet)</button><button class="wa-btn sec" onclick="document.getElementById('wa-campaign-form').innerHTML=''">Cancel</button><span id="wa-c-status" class="wa-muted"></span></div>
        </div></div>`;
        campaignTemplateChanged();
        box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    function campaignTypeChanged() {
        const t = $('wa-c-type').value;
        const f = $('wa-c-filter');
        const map = { payment_reminder: 'payment_pending', eticket: 'eticket_issued', event_reminder: 'eticket_issued', attendance_thanks: 'attended', certificate: 'certificate_issued', registration_confirmation: 'all' };
        if (map[t] && f) f.value = map[t];
        if (t === 'eticket') $('wa-c-perticket').checked = true;
        campaignFilterChanged();
    }
    function campaignSourceChanged() {
        const s = $('wa-c-source').value;
        $('wa-c-event-wrap').classList.toggle('hidden', s !== 'event');
        $('wa-c-upload-wrap').classList.toggle('hidden', s !== 'upload');
    }
    function campaignSeminarChanged() {
        const s = state.meta.seminars.find((x) => x.id === Number($('wa-c-seminar').value));
        $('wa-c-day').innerHTML = '<option value="">All days</option>' + ((s && s.days) || []).map((d) => `<option value="${d.id}">${esc(d.title || 'Day')} · ${esc(String(d.day_date || '').slice(0, 10))}</option>`).join('');
        state.customRegs = [];
        renderCustomRegs();
    }
    function campaignFilterChanged() {
        $('wa-c-custom-wrap').classList.toggle('hidden', $('wa-c-filter').value !== 'custom');
    }
    function renderCustomRegs() {
        const el = $('wa-c-custom-list');
        if (!el) return;
        el.innerHTML = state.customRegs.map((r) => `<span class="wa-chip">${r.name} · ${r.phone} <a href="#" onclick="AdminWhatsApp.removeReg(${r.id});return false" style="color:#b91c1c;margin-left:4px">×</a></span>`).join('') || '<span class="wa-muted">None selected</span>';
    }
    function removeReg(id) {
        state.customRegs = state.customRegs.filter((r) => r.id !== id);
        renderCustomRegs();
    }
    function campaignKindChanged() {
        const k = $('wa-c-kind').value;
        $('wa-c-tpl-wrap').classList.toggle('hidden', k !== 'template');
        $('wa-c-map').classList.toggle('hidden', k !== 'template');
        $('wa-c-text-wrap').classList.toggle('hidden', k !== 'text');
        $('wa-c-media-wrap').classList.toggle('hidden', !(k === 'media' || k === 'document'));
    }
    function campaignTemplateChanged() {
        const t = state.templates.find((x) => x.id === Number($('wa-c-template').value));
        $('wa-c-map').innerHTML = t ? `<label>Map template variables</label>${t.body_text ? `<div class="wa-bubble" style="margin-bottom:8px">${esc(t.body_text)}</div>` : ''}${mappingEditor('wa-c', Number(t.variable_count) || 0, t.variables)}${t.header_type && t.header_type !== 'text' ? `<div style="margin-top:8px"><label>Header ${esc(t.header_type)} URL (https)</label><input id="wa-c-header-url" placeholder="https://…"></div>` : ''}` : '';
    }
    async function previewAudience() {
        const body = { seminarId: $('wa-c-seminar').value, filter: $('wa-c-filter').value, dayId: $('wa-c-day').value || null, perTicket: $('wa-c-perticket').checked, registrationIds: state.customRegs.map((r) => r.id) };
        if (!body.seminarId) return toast('Select a seminar', true);
        $('wa-c-audience-preview').textContent = 'Counting…';
        try {
            const r = await api('/api/admin/whatsapp/audience/preview', { method: 'POST', body });
            $('wa-c-audience-preview').innerHTML = `<strong>${r.registrations}</strong> registrations match · <strong>${r.uniquePhones}</strong> phones · <strong>${r.estimatedMessages}</strong> messages${r.noPhone ? ` · ${r.noPhone} without phone` : ''}`;
        } catch (e) {
            $('wa-c-audience-preview').textContent = e.message;
        }
    }
    async function uploadFile(file) {
        if (!file) return;
        const fd = new FormData();
        fd.append('file', file);
        $('wa-c-upload-summary').textContent = 'Parsing…';
        try {
            const r = await api('/api/admin/whatsapp/upload/parse', { method: 'POST', body: fd });
            state.upload = r;
            $('wa-c-phone-col').innerHTML = r.columns.map((c) => `<option ${c === r.guessPhone ? 'selected' : ''}>${esc(c)}</option>`).join('');
            $('wa-c-name-col').innerHTML = '<option value="">(none)</option>' + r.columns.map((c) => `<option ${c === r.guessName ? 'selected' : ''}>${esc(c)}</option>`).join('');
            $('wa-c-upload-summary').innerHTML = `<strong>${r.total}</strong> rows${r.capped ? ' (first 5000 used)' : ''} · valid <strong>${r.summary.valid}</strong> · invalid <strong style="color:#b91c1c">${r.summary.invalid}</strong> · duplicates <strong>${r.summary.duplicates}</strong>. Columns are available as variables: ${r.columns.map((c) => `<span class="wa-chip">{{${esc(c)}}}</span>`).join('')}`;
        } catch (e) {
            $('wa-c-upload-summary').textContent = e.message;
        }
    }
    async function createCampaign() {
        const kind = $('wa-c-kind').value;
        const source = $('wa-c-source').value;
        const body = {
            name: $('wa-c-name').value.trim(),
            campaign_type: $('wa-c-type').value,
            source,
            message_kind: kind,
            scheduled_at: $('wa-c-sched').value ? new Date($('wa-c-sched').value).toISOString() : null
        };
        if (source === 'event') {
            body.seminar_id = $('wa-c-seminar').value;
            body.audience_filter = $('wa-c-filter').value;
            body.day_id = $('wa-c-day').value || null;
            body.per_ticket = $('wa-c-perticket').checked;
            body.registration_ids = state.customRegs.map((r) => r.id);
            if (!body.seminar_id) return toast('Select a seminar', true);
        } else {
            if (!state.upload) return toast('Upload a file first', true);
            const pc = $('wa-c-phone-col').value;
            const nc = $('wa-c-name-col').value;
            body.audience_filter = 'upload';
            body.upload_name = 'upload';
            body.recipients = state.upload.rows.map((row) => ({ phone: row[pc], name: nc ? row[nc] : '', vars: row }));
        }
        if (kind === 'template') {
            const t = state.templates.find((x) => x.id === Number($('wa-c-template').value));
            if (!t) return toast('Choose a template', true);
            body.template_id = t.id;
            body.template_name = t.meta_name;
            body.template_lang = t.language;
            body.variable_map = readMapping('wa-c');
            const hu = $('wa-c-header-url');
            if (hu && hu.value.trim()) body.media_url = hu.value.trim();
        } else if (kind === 'text') {
            body.body_text = $('wa-c-text').value;
        } else {
            body.media_url = $('wa-c-media-url').value.trim();
            body.media_type = kind === 'document' ? 'document' : 'image';
            body.media_filename = $('wa-c-media-name').value.trim();
            body.media_caption = $('wa-c-caption').value;
        }
        $('wa-c-status').textContent = 'Creating…';
        try {
            const r = await api('/api/admin/whatsapp/campaigns', { method: 'POST', body });
            toast(`Campaign created: ${r.stats.inserted} recipients (${r.stats.duplicates} duplicates, ${r.stats.invalid} invalid skipped)`);
            $('wa-campaign-form').innerHTML = '';
            await renderCampaigns();
            openCampaign(r.campaign.id);
        } catch (e) {
            $('wa-c-status').textContent = e.message;
            toast(e.message, true);
        }
    }

    async function openCampaign(id, statusFilter) {
        let d;
        try {
            d = await api('/api/admin/whatsapp/campaigns/' + id + (statusFilter ? '?status=' + statusFilter : ''));
        } catch (e) {
            return toast(e.message, true);
        }
        const c = d.campaign;
        const cnt = d.counts || {};
        const canSend = ['ready', 'draft', 'paused'].includes(c.status) && Number(c.total_recipients) > 0;
        const html = `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px"><div><h3 style="margin:0">${esc(c.name)} ${statusBadge(c.status)}</h3><p class="wa-muted" style="margin:4px 0 0">${esc(c.campaign_type)} · ${esc(c.seminar_title || 'uploaded list')} · ${esc(c.audience_filter)}${c.per_ticket ? ' · per ticket' : ''} · ${esc(c.message_kind)} ${c.template_name ? '· ' + esc(c.template_name) : ''}${c.scheduled_at ? ' · scheduled ' + fmtDt(c.scheduled_at) : ''}</p></div><button class="wa-btn sm sec" onclick="this.closest('.wa-modal-bg').remove()">Close</button></div>
        <div class="wa-grid" style="margin-top:12px">
            <div class="wa-stat"><div class="n">${c.total_recipients}</div><div class="l">Recipients</div></div>
            <div class="wa-stat"><div class="n">${cnt.pending || 0}</div><div class="l">Pending</div></div>
            <div class="wa-stat"><div class="n">${c.sent_count}</div><div class="l">Sent</div></div>
            <div class="wa-stat"><div class="n">${c.delivered_count}</div><div class="l">Delivered</div></div>
            <div class="wa-stat"><div class="n">${c.read_count}</div><div class="l">Read</div></div>
            <div class="wa-stat"><div class="n" style="color:#b91c1c">${c.failed_count}</div><div class="l">Failed</div></div>
            <div class="wa-stat"><div class="n">${c.skipped_count}</div><div class="l">Skipped (opt-out/invalid)</div></div>
        </div>
        <div class="wa-inline">
            ${canSend ? `<button class="wa-btn" onclick="AdminWhatsApp.confirmSend(${c.id})">Preview &amp; send</button>` : ''}
            ${c.status === 'sending' ? `<button class="wa-btn sec" onclick="AdminWhatsApp.campaignAction(${c.id},'pause')">Pause</button>` : ''}
            ${['sending', 'paused', 'ready'].includes(c.status) ? `<button class="wa-btn danger" onclick="AdminWhatsApp.campaignAction(${c.id},'cancel')">Cancel campaign</button>` : ''}
            ${Number(c.failed_count) > 0 && ['completed', 'paused', 'sending'].includes(c.status) ? `<button class="wa-btn sec" onclick="AdminWhatsApp.campaignAction(${c.id},'retry-failed')">Retry failed</button>` : ''}
            ${['draft', 'ready'].includes(c.status) && c.source === 'event' ? `<button class="wa-btn sec" onclick="AdminWhatsApp.campaignAction(${c.id},'refresh-audience')">Refresh audience</button>` : ''}
            ${['draft', 'ready', 'cancelled'].includes(c.status) ? `<button class="wa-btn sec" onclick="AdminWhatsApp.deleteCampaign(${c.id})">Delete</button>` : ''}
            <button class="wa-btn sec sm" onclick="AdminWhatsApp.openCampaign(${c.id})">Refresh</button>
            <select onchange="AdminWhatsApp.openCampaign(${c.id}, this.value)" style="padding:6px;border-radius:8px;border:1px solid #cbd5e1"><option value="">All recipients</option>${['pending', 'sent', 'delivered', 'read', 'failed', 'skipped'].map((s) => `<option value="${s}" ${statusFilter === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
        </div>
        <div class="wa-table-wrap"><table class="wa-table"><thead><tr><th>Name</th><th>Phone</th><th>Status</th><th>Attempts</th><th>Sent</th><th>Delivered</th><th>Read</th><th>Error</th></tr></thead><tbody>${(d.recipients || []).map((r) => `<tr><td>${esc(r.name || '')}${r.vars && r.vars.application_no ? '<br><span class="wa-muted">#' + esc(r.vars.application_no) + (r.vars.day_title ? ' · ' + esc(r.vars.day_title) : '') + '</span>' : ''}</td><td>${esc(r.phone)}</td><td>${statusBadge(r.status)}</td><td>${r.attempts}</td><td>${fmtDt(r.sent_at)}</td><td>${fmtDt(r.delivered_at)}</td><td>${fmtDt(r.read_at)}</td><td style="white-space:normal;max-width:260px;color:#b91c1c">${esc(r.error || '')}</td></tr>`).join('') || '<tr><td colspan="8" class="wa-muted">No recipients</td></tr>'}</tbody></table></div>`;
        document.querySelectorAll('.wa-modal-bg').forEach((m) => m.remove());
        modal(html);
    }
    async function confirmSend(id) {
        let p;
        try {
            p = await api('/api/admin/whatsapp/campaigns/' + id + '/preview');
        } catch (e) {
            return toast(e.message, true);
        }
        const c = p.campaign;
        const s = p.sample;
        const bg = modal(`
        <h3 style="margin:0 0 10px">Confirm send — ${esc(c.name)}</h3>
        <div class="wa-preview">
            <div><strong>Event:</strong> ${esc(c.seminar || 'Uploaded list')}</div>
            <div><strong>Template / kind:</strong> ${esc(c.template || c.kind)} ${c.lang ? '(' + esc(c.lang) + ')' : ''}</div>
            <div><strong>Audience:</strong> ${esc(c.filter)}${c.perTicket ? ' · one message per ticket' : ''}</div>
            <div><strong>Recipients:</strong> ${p.recipients} unique phones</div>
            <div><strong>Estimated messages:</strong> ${p.estimatedMessages}</div>
            ${c.scheduledAt ? `<div><strong>Scheduled:</strong> ${fmtDt(c.scheduledAt)} (worker sends when due)</div>` : ''}
            ${s ? `<div style="margin-top:10px"><strong>Sample to ${esc(s.name || '')} ${esc(s.to)}:</strong><div class="wa-bubble" style="margin-top:6px">${esc(s.bodyPreview || s.body || (s.params ? 'Template ' + s.templateName + ' with: ' + s.params.join(' | ') : 'Template ' + s.templateName))}</div></div>` : ''}
        </div>
        <p class="wa-muted" style="margin-top:10px">Messages are sent gradually at the configured rate. Opted-out numbers are skipped. Each recipient receives this campaign only once.</p>
        <div class="wa-inline" style="margin-top:8px"><button class="wa-btn" id="wa-confirm-go">Yes, send to ${p.recipients} recipients</button><button class="wa-btn sec" onclick="this.closest('.wa-modal-bg').remove()">Back</button></div>`);
        bg.querySelector('#wa-confirm-go').onclick = async function () {
            this.disabled = true;
            try {
                await api('/api/admin/whatsapp/campaigns/' + id + '/send', { method: 'POST', body: { confirm: true } });
                toast('Campaign started');
                bg.remove();
                openCampaign(id);
                renderCampaigns();
            } catch (e) {
                toast(e.message, true);
                this.disabled = false;
            }
        };
    }
    async function campaignAction(id, action) {
        if (action === 'cancel' && !confirm('Cancel this campaign? Pending messages will not be sent.')) return;
        try {
            await api(`/api/admin/whatsapp/campaigns/${id}/${action}`, { method: 'POST', body: {} });
            toast('Done');
            openCampaign(id);
            renderCampaigns();
        } catch (e) {
            toast(e.message, true);
        }
    }
    async function deleteCampaign(id) {
        if (!confirm('Delete this campaign?')) return;
        try {
            await api('/api/admin/whatsapp/campaigns/' + id, { method: 'DELETE' });
            document.querySelectorAll('.wa-modal-bg').forEach((m) => m.remove());
            renderCampaigns();
        } catch (e) {
            toast(e.message, true);
        }
    }

    /* -------------------------------------------------------- templates */
    async function renderTemplates() {
        const el = $('wa-section-templates');
        el.innerHTML = '<p class="wa-muted">Loading…</p>';
        try {
            state.templates = (await api('/api/admin/whatsapp/templates')).templates || [];
        } catch (e) {
            el.innerHTML = `<p style="color:#b91c1c">${esc(e.message)}</p>`;
            return;
        }
        el.innerHTML = `
        <div class="wa-inline"><button class="wa-btn" onclick="AdminWhatsApp.syncTemplates()">Sync from Meta</button><button class="wa-btn sec" onclick="AdminWhatsApp.editTemplate()">+ Add manually</button><span class="wa-muted">Templates must be approved in Meta Business Manager. Sync pulls names, languages, status and variable counts.</span></div>
        <div class="wa-card"><div class="wa-table-wrap"><table class="wa-table"><thead><tr><th>Name</th><th>Meta name</th><th>Lang</th><th>Category</th><th>Status</th><th>Vars</th><th>Default mapping</th><th>Active</th><th></th></tr></thead><tbody>${
            state.templates.length
                ? state.templates.map((t) => `<tr><td><strong>${esc(t.name)}</strong></td><td>${esc(t.meta_name)}</td><td>${esc(t.language)}</td><td>${esc(t.category || '')}</td><td>${esc(t.status || '')}</td><td>${t.variable_count}</td><td style="white-space:normal;max-width:240px">${(t.variables || []).map((v) => `<span class="wa-chip">${esc(v)}</span>`).join('') || '<span class="wa-muted">—</span>'}</td><td>${t.is_active ? 'Yes' : 'No'}</td><td><button class="wa-btn sm sec" onclick="AdminWhatsApp.editTemplate(${t.id})">Edit</button> <button class="wa-btn sm danger" onclick="AdminWhatsApp.deleteTemplate(${t.id})">×</button></td></tr>`).join('')
                : '<tr><td colspan="9" class="wa-muted">No templates yet — click “Sync from Meta”.</td></tr>'
        }</tbody></table></div></div>`;
    }
    async function syncTemplates() {
        toast('Syncing…');
        try {
            const r = await api('/api/admin/whatsapp/templates/sync', { method: 'POST', body: {} });
            toast(`Synced: ${r.inserted} new, ${r.updated} updated (${r.total} on Meta)`);
            renderTemplates();
        } catch (e) {
            toast(e.message, true);
        }
    }
    function editTemplate(id) {
        const t = state.templates.find((x) => x.id === id) || { name: '', meta_name: '', language: 'en', category: '', status: '', variable_count: 0, variables: [], is_active: 1, body_text: '' };
        const bg = modal(`
        <h3 style="margin:0 0 10px">${id ? 'Edit' : 'Add'} template</h3>
        <div class="wa-form">
            <div><label>Display name</label><input id="wa-t-name" value="${esc(t.name)}"></div>
            <div><label>Meta template name</label><input id="wa-t-meta" value="${esc(t.meta_name)}" ${t.meta_id ? 'readonly' : ''}></div>
            <div><label>Language</label><input id="wa-t-lang" value="${esc(t.language)}"></div>
            <div><label>Category</label><input id="wa-t-cat" value="${esc(t.category || '')}" placeholder="UTILITY / MARKETING / AUTHENTICATION"></div>
            <div><label>Variable count</label><input id="wa-t-count" type="number" min="0" value="${t.variable_count}" onchange="AdminWhatsApp.templateCountChanged()"></div>
            <div><label>Active</label><select id="wa-t-active"><option value="1" ${t.is_active ? 'selected' : ''}>Yes</option><option value="0" ${!t.is_active ? 'selected' : ''}>No</option></select></div>
            <div class="full"><label>Body text (from Meta)</label><textarea id="wa-t-body" rows="3">${esc(t.body_text || '')}</textarea></div>
            <div class="full"><label>Default variable mapping (used by campaigns unless overridden)</label><div id="wa-t-map">${mappingEditor('wa-t', Number(t.variable_count) || 0, t.variables)}</div></div>
            <div class="full wa-inline"><button class="wa-btn" id="wa-t-save">Save</button><button class="wa-btn sec" onclick="this.closest('.wa-modal-bg').remove()">Cancel</button>${id ? `<button class="wa-btn sec" onclick="AdminWhatsApp.checkTemplate(${id})">Check on Meta</button>` : ''}<span id="wa-t-check" class="wa-muted"></span></div>
        </div>`);
        bg.querySelector('#wa-t-save').onclick = async () => {
            try {
                await api('/api/admin/whatsapp/templates', {
                    method: 'POST',
                    body: { id: id || 0, name: $('wa-t-name').value, meta_name: $('wa-t-meta').value, language: $('wa-t-lang').value, category: $('wa-t-cat').value, status: t.status, header_type: t.header_type, body_text: $('wa-t-body').value, variable_count: Number($('wa-t-count').value) || 0, variables: readMapping('wa-t'), is_active: $('wa-t-active').value === '1', meta_id: t.meta_id }
                });
                bg.remove();
                toast('Template saved');
                renderTemplates();
            } catch (e) {
                toast(e.message, true);
            }
        };
    }
    function templateCountChanged() {
        $('wa-t-map').innerHTML = mappingEditor('wa-t', Number($('wa-t-count').value) || 0, readMapping('wa-t'));
    }
    async function checkTemplate(id) {
        $('wa-t-check').textContent = 'Checking…';
        try {
            const r = await api('/api/admin/whatsapp/templates/' + id + '/check');
            const m = r.meta || {};
            $('wa-t-check').textContent = m.error ? m.error : m.languages && m.languages.length ? 'Found on Meta · languages: ' + m.languages.join(', ') : m.hint || 'Not found on Meta';
        } catch (e) {
            $('wa-t-check').textContent = e.message;
        }
    }
    async function deleteTemplate(id) {
        if (!confirm('Remove this template from the local list? (Meta is unaffected)')) return;
        try {
            await api('/api/admin/whatsapp/templates/' + id, { method: 'DELETE' });
            renderTemplates();
        } catch (e) {
            toast(e.message, true);
        }
    }

    /* ------------------------------------------------------------ flows */
    async function renderFlows() {
        const el = $('wa-section-flows');
        el.innerHTML = '<p class="wa-muted">Loading…</p>';
        let d;
        try {
            d = await api('/api/admin/whatsapp/flows');
        } catch (e) {
            el.innerHTML = `<p style="color:#b91c1c">${esc(e.message)}</p>`;
            return;
        }
        el.innerHTML = `
        <div class="wa-card"><h3>How Flows work here</h3><p class="wa-muted">Build the Flow screens in Meta Flow Builder, point its endpoint to <code id="wa-flow-endpoint">/api/whatsapp/flow/data-exchange</code> and use <code>data.action</code> on each screen to call one of the built-in actions: ${d.actions.map((a) => `<span class="wa-chip">${esc(a)}</span>`).join('')}. New behaviour = a new action in code, not a new endpoint. Upload the endpoint's public key in Meta and paste the private key under Settings.</p></div>
        <div class="wa-inline"><button class="wa-btn" onclick="AdminWhatsApp.editFlow()">+ Register Flow</button></div>
        <div class="wa-card"><h3>Registered Flows</h3><div class="wa-table-wrap"><table class="wa-table"><thead><tr><th>Name</th><th>Meta Flow ID</th><th>Purpose</th><th>Seminar</th><th>First screen</th><th>Active</th><th></th></tr></thead><tbody>${
            (d.flows || []).length
                ? d.flows.map((f) => `<tr><td><strong>${esc(f.name)}</strong></td><td>${esc(f.meta_flow_id || '—')}</td><td>${esc(f.purpose)}</td><td>${esc(f.seminar_title || 'any')}</td><td>${esc(f.first_screen || '—')}</td><td>${f.is_active ? 'Yes' : 'No'}</td><td><button class="wa-btn sm" onclick="AdminWhatsApp.sendFlow(${f.id})">Send to phone</button> <button class="wa-btn sm sec" onclick="AdminWhatsApp.editFlow(${f.id})">Edit</button> <button class="wa-btn sm danger" onclick="AdminWhatsApp.deleteFlow(${f.id})">×</button></td></tr>`).join('')
                : '<tr><td colspan="7" class="wa-muted">No Flows registered.</td></tr>'
        }</tbody></table></div></div>
        <div class="wa-card"><h3>Test an action (dry run, no WhatsApp message)</h3><div class="wa-inline"><select id="wa-fa-action">${d.actions.map((a) => `<option>${esc(a)}</option>`).join('')}</select><input id="wa-fa-data" placeholder='JSON data e.g. {"seminar_id":"3"}' style="min-width:280px"><button class="wa-btn sec" onclick="AdminWhatsApp.testAction()">Run</button></div><pre id="wa-fa-out" style="background:#f8fafc;padding:10px;border-radius:8px;max-height:280px;overflow:auto;font-size:.8rem"></pre></div>
        <div class="wa-card"><h3>Recent Flow sessions</h3><div class="wa-table-wrap"><table class="wa-table"><thead><tr><th>Token</th><th>Phone</th><th>Last action</th><th>Status</th><th>Registration</th><th>Updated</th></tr></thead><tbody>${(d.sessions || []).map((s) => `<tr><td>${esc(String(s.flow_token || '').slice(0, 10))}…</td><td>${esc(s.phone || '')}</td><td>${esc(s.last_action || '')}</td><td>${statusBadge(s.status)}</td><td>${s.registration_id || '—'}</td><td>${fmtDt(s.updated_at)}</td></tr>`).join('') || '<tr><td colspan="6" class="wa-muted">None</td></tr>'}</tbody></table></div></div>`;
        state.flows = d.flows || [];
        const ep = $('wa-flow-endpoint');
        if (ep) ep.textContent = location.origin + '/api/whatsapp/flow/data-exchange';
    }
    function editFlow(id) {
        const f = (state.flows || []).find((x) => x.id === id) || { name: '', meta_flow_id: '', purpose: 'registration', seminar_id: '', first_screen: '', cta_text: 'Register', body_text: '', header_text: '', is_active: 1 };
        const bg = modal(`
        <h3 style="margin:0 0 10px">${id ? 'Edit' : 'Register'} Flow</h3>
        <div class="wa-form">
            <div><label>Name</label><input id="wa-f-name" value="${esc(f.name)}"></div>
            <div><label>Meta Flow ID</label><input id="wa-f-meta" value="${esc(f.meta_flow_id || '')}"></div>
            <div><label>Purpose</label><select id="wa-f-purpose">${['registration', 'payment', 'status', 'feedback', 'other'].map((p) => `<option ${f.purpose === p ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
            <div><label>Seminar (optional)</label><select id="wa-f-sem">${seminarOptions(f.seminar_id)}</select></div>
            <div><label>First screen ID (optional)</label><input id="wa-f-screen" value="${esc(f.first_screen || '')}" placeholder="WELCOME"></div>
            <div><label>Button text (≤20 chars)</label><input id="wa-f-cta" value="${esc(f.cta_text || '')}" maxlength="20"></div>
            <div class="full"><label>Header text</label><input id="wa-f-header" value="${esc(f.header_text || '')}" maxlength="60"></div>
            <div class="full"><label>Body text</label><textarea id="wa-f-body" rows="3">${esc(f.body_text || '')}</textarea></div>
            <div><label>Active</label><select id="wa-f-active"><option value="1" ${f.is_active ? 'selected' : ''}>Yes</option><option value="0" ${!f.is_active ? 'selected' : ''}>No</option></select></div>
            <div class="full wa-inline"><button class="wa-btn" id="wa-f-save">Save</button><button class="wa-btn sec" onclick="this.closest('.wa-modal-bg').remove()">Cancel</button></div>
        </div>`);
        bg.querySelector('#wa-f-save').onclick = async () => {
            try {
                await api('/api/admin/whatsapp/flows', { method: 'POST', body: { id: id || 0, name: $('wa-f-name').value, meta_flow_id: $('wa-f-meta').value, purpose: $('wa-f-purpose').value, seminar_id: $('wa-f-sem').value || null, first_screen: $('wa-f-screen').value, cta_text: $('wa-f-cta').value, header_text: $('wa-f-header').value, body_text: $('wa-f-body').value, is_active: $('wa-f-active').value === '1' } });
                bg.remove();
                renderFlows();
            } catch (e) {
                toast(e.message, true);
            }
        };
    }
    async function deleteFlow(id) {
        if (!confirm('Remove this Flow registration?')) return;
        try {
            await api('/api/admin/whatsapp/flows/' + id, { method: 'DELETE' });
            renderFlows();
        } catch (e) {
            toast(e.message, true);
        }
    }
    async function sendFlow(id) {
        const phone = prompt('Send this Flow to which phone number?');
        if (!phone) return;
        try {
            const r = await api('/api/admin/whatsapp/flows/' + id + '/send', { method: 'POST', body: { phone } });
            toast('Flow sent · ' + (r.messageId || ''));
        } catch (e) {
            toast(e.message, true);
        }
    }
    async function testAction() {
        let data = {};
        try {
            data = $('wa-fa-data').value ? JSON.parse($('wa-fa-data').value) : {};
        } catch (_) {
            return toast('Data must be valid JSON', true);
        }
        try {
            const r = await api('/api/admin/whatsapp/flows/test-action', { method: 'POST', body: { action: $('wa-fa-action').value, data } });
            $('wa-fa-out').textContent = JSON.stringify(r, null, 2);
        } catch (e) {
            $('wa-fa-out').textContent = e.message;
        }
    }

    /* ------------------------------------------------------------- logs */
    function renderLogTable(rows) {
        return `<div class="wa-table-wrap"><table class="wa-table"><thead><tr><th>Time</th><th>Dir</th><th>Recipient</th><th>Phone</th><th>Type</th><th>Template / preview</th><th>Event</th><th>Campaign</th><th>Status</th><th>Sent</th><th>Delivered</th><th>Read</th><th>Error</th></tr></thead><tbody>${
            rows.length
                ? rows
                      .map(
                          (m) => `<tr><td>${fmtDt(m.created_at)}</td><td>${m.direction === 'in' ? '⬅ in' : '➡ out'}</td><td>${esc([m.first_name, m.last_name].filter(Boolean).join(' ') || '')}${m.application_no ? '<br><span class="wa-muted">#' + esc(m.application_no) + '</span>' : ''}</td><td>${esc(m.phone)}</td><td>${esc(m.message_type || m.kind)}</td><td style="white-space:normal;max-width:260px">${m.template_name ? '<strong>' + esc(m.template_name) + '</strong><br>' : ''}<span class="wa-muted">${esc((m.preview || '').slice(0, 120))}</span></td><td>${esc(m.seminar_title || '')}</td><td>${esc(m.campaign_name || '')}</td><td>${statusBadge(m.status)}</td><td>${fmtDt(m.sent_at)}</td><td>${fmtDt(m.delivered_at)}</td><td>${fmtDt(m.read_at)}</td><td style="white-space:normal;max-width:220px;color:#b91c1c">${esc(m.error || '')}</td></tr>`
                      )
                      .join('')
                : '<tr><td colspan="13" class="wa-muted">No messages</td></tr>'
        }</tbody></table></div>`;
    }
    async function renderLogs() {
        const el = $('wa-section-logs');
        if (!el.querySelector('#wa-logs-table')) {
            el.innerHTML = `<div class="wa-inline"><input id="wa-log-q" placeholder="phone / template / message id"><select id="wa-log-status"><option value="">All statuses</option>${['queued', 'sent', 'delivered', 'read', 'failed', 'skipped', 'received'].map((s) => `<option value="${s}">${s}</option>`).join('')}</select><select id="wa-log-dir"><option value="">In + out</option><option value="out">Outgoing</option><option value="in">Incoming</option></select><button class="wa-btn sec" onclick="AdminWhatsApp.loadLogs()">Search</button><label style="display:flex;gap:6px;align-items:center;font-weight:600;margin:0"><input type="checkbox" id="wa-log-live" checked style="width:auto"> Live refresh</label></div><div id="wa-logs-table" class="wa-card"></div>`;
        }
        await loadLogs();
        state.logsTimer = setInterval(() => {
            if ($('wa-log-live') && $('wa-log-live').checked && state.section === 'logs') loadLogs();
        }, 8000);
    }
    async function loadLogs() {
        const qs = new URLSearchParams({ q: $('wa-log-q').value, status: $('wa-log-status').value, direction: $('wa-log-dir').value, limit: 200 });
        try {
            const r = await api('/api/admin/whatsapp/logs?' + qs.toString());
            $('wa-logs-table').innerHTML = renderLogTable(r.logs || []);
        } catch (e) {
            $('wa-logs-table').innerHTML = `<p style="color:#b91c1c">${esc(e.message)}</p>`;
        }
    }

    /* --------------------------------------------------------- settings */
    async function renderSettings() {
        const el = $('wa-section-settings');
        el.innerHTML = '<p class="wa-muted">Loading…</p>';
        let d;
        try {
            d = await api('/api/admin/whatsapp/settings');
        } catch (e) {
            el.innerHTML = `<p style="color:#b91c1c">${esc(e.message)}</p>`;
            return;
        }
        const s = d.settings || {};
        const yn = (k) => `<select id="wa-s-${k}"><option value="1" ${String(s[k]) === '1' ? 'selected' : ''}>Yes</option><option value="0" ${String(s[k]) !== '1' ? 'selected' : ''}>No</option></select>`;
        el.innerHTML = `
        <div class="wa-card"><h3>Meta connection</h3>
            <p>Status: ${d.integration.configured ? '<strong style="color:#15803d">Connected</strong>' : '<strong style="color:#b91c1c">Not configured</strong>'} · token ${d.integration.tokenSet ? 'set' : 'missing'} · phone number ID ${d.integration.phoneNumberIdSet ? 'set' : 'missing'} · WABA ID ${d.integration.wabaIdSet ? 'set' : 'missing'} · default template language <code>${esc(d.integration.templateLang)}</code></p>
            <p class="wa-muted">Credentials are managed under <a href="#" onclick="switchTab('tab-integrations');return false">Integrations → WhatsApp</a> and never leave the server. Webhook URL: <code>${esc(d.webhookUrl)}</code> · Flow endpoint: <code>${esc(d.flowEndpoint)}</code></p>
        </div>
        <div class="wa-card"><h3>Sending &amp; retries</h3><div class="wa-form">
            <div><label>Messages per second (campaigns)</label><input id="wa-s-rate_per_second" type="number" min="1" max="80" value="${esc(s.rate_per_second)}"></div>
            <div><label>Max retries per recipient</label><input id="wa-s-max_retries" type="number" min="0" max="10" value="${esc(s.max_retries)}"></div>
            <div><label>Retry delay (seconds)</label><input id="wa-s-retry_delay_seconds" type="number" min="10" value="${esc(s.retry_delay_seconds)}"></div>
            <div><label>Recipients per worker batch</label><input id="wa-s-campaign_batch_size" type="number" min="1" max="200" value="${esc(s.campaign_batch_size)}"></div>
            <div><label>Quiet hours start (IST, blank = off)</label><input id="wa-s-quiet_start" value="${esc(s.quiet_start || '')}" placeholder="22:00"></div>
            <div><label>Quiet hours end</label><input id="wa-s-quiet_end" value="${esc(s.quiet_end || '')}" placeholder="08:00"></div>
            <div><label>Enable campaign sending</label>${yn('campaigns_enabled')}</div>
        </div></div>
        <div class="wa-card"><h3>Opt-in / opt-out</h3><div class="wa-form">
            <div><label>Process STOP / START keywords &amp; skip opted-out contacts</label>${yn('opt_out_enabled')}</div>
            <div class="full"><label>Reply after opt-out</label><input id="wa-s-opt_out_reply" value="${esc(s.opt_out_reply || '')}"></div>
            <div class="full"><label>Reply after opt-in</label><input id="wa-s-opt_in_reply" value="${esc(s.opt_in_reply || '')}"></div>
        </div><div class="wa-inline" style="margin-top:10px"><input id="wa-s-opt-phone" placeholder="phone"><button class="wa-btn sec sm" onclick="AdminWhatsApp.setOpt(true)">Mark opted-out</button><button class="wa-btn sec sm" onclick="AdminWhatsApp.setOpt(false)">Mark opted-in</button><button class="wa-btn sec sm" onclick="AdminWhatsApp.showOptOuts()">View opted-out list</button></div><div id="wa-optouts"></div></div>
        <div class="wa-card"><h3>Flows encryption</h3><div class="wa-form">
            <div class="full"><label>Endpoint private key (PEM) — ${s.flow_private_key_set ? '<span style="color:#15803d">set</span>' : '<span style="color:#b91c1c">not set</span>'}</label><textarea id="wa-s-flow_private_key" rows="4" placeholder="-----BEGIN PRIVATE KEY----- … (leave blank to keep current)"></textarea></div>
            <div><label>Key passphrase (optional)</label><input id="wa-s-flow_private_key_passphrase" type="password" placeholder="leave blank to keep"></div>
            <div><label style="display:flex;gap:6px;align-items:center;margin-top:22px"><input type="checkbox" id="wa-s-clear-key" style="width:auto"> Remove stored key</label></div>
        </div></div>
        <div class="wa-inline"><button class="wa-btn" onclick="AdminWhatsApp.saveSettings()">Save settings</button><span id="wa-s-status" class="wa-muted"></span></div>`;
    }
    async function saveSettings() {
        const keys = ['rate_per_second', 'max_retries', 'retry_delay_seconds', 'campaign_batch_size', 'quiet_start', 'quiet_end', 'campaigns_enabled', 'opt_out_enabled', 'opt_out_reply', 'opt_in_reply', 'flow_private_key', 'flow_private_key_passphrase'];
        const body = {};
        keys.forEach((k) => {
            const el = $('wa-s-' + k);
            if (el) body[k] = el.value;
        });
        if ($('wa-s-clear-key').checked) body.clear_flow_private_key = true;
        try {
            await api('/api/admin/whatsapp/settings', { method: 'POST', body });
            toast('Settings saved');
            renderSettings();
        } catch (e) {
            toast(e.message, true);
        }
    }
    async function setOpt(out) {
        const phone = $('wa-s-opt-phone').value.trim();
        if (!phone) return toast('Enter a phone', true);
        try {
            await api('/api/admin/whatsapp/contacts/opt', { method: 'POST', body: { phone, optedOut: out } });
            toast(out ? 'Marked opted-out' : 'Marked opted-in');
            showOptOuts();
        } catch (e) {
            toast(e.message, true);
        }
    }
    async function showOptOuts() {
        try {
            const r = await api('/api/admin/whatsapp/contacts?optedOut=1');
            $('wa-optouts').innerHTML = `<div class="wa-table-wrap" style="margin-top:8px"><table class="wa-table"><thead><tr><th>Phone</th><th>Name</th><th>Source</th><th>Opted out at</th><th>Last inbound</th></tr></thead><tbody>${(r.contacts || []).map((c) => `<tr><td>${esc(c.phone)}</td><td>${esc(c.name || '')}</td><td>${esc(c.opt_source || '')}</td><td>${fmtDt(c.opted_out_at)}</td><td>${esc(c.last_inbound_text || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="wa-muted">Nobody has opted out.</td></tr>'}</tbody></table></div>`;
        } catch (e) {
            toast(e.message, true);
        }
    }

    window.AdminWhatsApp = {
        init,
        show: showSection,
        sendModeChanged,
        sendKindChanged,
        sendTemplateChanged,
        searchReg,
        pickReg,
        removeReg,
        doSend,
        newCampaign,
        campaignTypeChanged,
        campaignSourceChanged,
        campaignSeminarChanged,
        campaignFilterChanged,
        campaignKindChanged,
        campaignTemplateChanged,
        previewAudience,
        uploadFile,
        createCampaign,
        openCampaign,
        confirmSend,
        campaignAction,
        deleteCampaign,
        syncTemplates,
        editTemplate,
        templateCountChanged,
        checkTemplate,
        deleteTemplate,
        editFlow,
        deleteFlow,
        sendFlow,
        testAction,
        loadLogs,
        saveSettings,
        setOpt,
        showOptOuts
    };
})();
