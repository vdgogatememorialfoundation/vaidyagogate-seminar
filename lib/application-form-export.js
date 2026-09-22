'use strict';

/**
 * Download a seminar registration form as PDF or PNG:
 *   - filled: a submitted application (registrations.form_data) laid out on the seminar's form
 *   - blank: the seminar's configured form with empty answer boxes
 */

const { htmlToPdfBuffer, htmlToPngBuffer } = require('./certificate-pdf-server');
const { isOtpPlaceholderField } = require('./dynamic-fields');

function esc(v) {
    return String(v == null ? '' : v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function safeFilePart(v) {
    return String(v || '')
        .replace(/[^A-Za-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60) || 'form';
}

function parseFormData(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try {
        const o = JSON.parse(raw);
        return o && typeof o === 'object' ? o : {};
    } catch (_) {
        return {};
    }
}

function fieldLabel(f) {
    return f.label || String(f.key || '').replace(/_/g, ' ');
}

function formatValue(f, raw) {
    const t = String(f.type || 'text').toLowerCase();
    if (raw === undefined || raw === null || raw === '') return '';
    if (t === 'checkbox' || t === 'boolean') {
        return raw === true || raw === 1 || raw === '1' || raw === 'on' || raw === 'true' ? 'Yes' : 'No';
    }
    if (t === 'select' && Array.isArray(f.options)) {
        const hit = f.options.find((o) => String(o.value != null ? o.value : o.label) === String(raw));
        if (hit && hit.label) return String(hit.label);
    }
    if (t === 'date') {
        const s = String(raw).slice(0, 10);
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
        if (m) return m[3] + '-' + m[2] + '-' + m[1];
    }
    return String(raw);
}

function printableFields(fields) {
    return (fields || []).filter(
        (f) => f && f.key && f.enabled !== false && !isOtpPlaceholderField(f) && String(f.type || '').toLowerCase() !== 'terms'
    );
}

function buildFormHtml(opts) {
    const { seminar, fields, formData, application, blank, branding } = opts;
    const org = (branding && branding.name) || 'Vaidya Gogate Memorial Foundation';
    const logo = branding && branding.logoUrl ? '<img src="' + esc(branding.logoUrl) + '" alt="" style="height:52px;">' : '';
    const title = (seminar && seminar.title) || 'Seminar';
    const rows = printableFields(fields)
        .map((f) => {
            const t = String(f.type || 'text').toLowerCase();
            let val = '';
            if (!blank) {
                if (f.key === 'certificate') {
                    val = formData.certificate_path || formData.certificate ? 'Uploaded' : '';
                } else {
                    val = formatValue(f, formData[f.key]);
                }
            }
            const tall = t === 'textarea' || f.key === 'address';
            const box =
                '<div class="ans' +
                (tall ? ' tall' : '') +
                '">' +
                (val ? esc(val) : blank ? '' : '<span class="muted">—</span>') +
                '</div>';
            return (
                '<div class="row">' +
                '<div class="lab">' +
                esc(fieldLabel(f)) +
                (f.required ? ' <span class="req">*</span>' : '') +
                '</div>' +
                box +
                '</div>'
            );
        })
        .join('');
    const meta = blank
        ? '<div class="meta"><span>Application No.: <span class="line"></span></span><span>Date: <span class="line short"></span></span></div>'
        : '<div class="meta">' +
          '<span><b>Application No.:</b> ' +
          esc(application.application_no || application.id) +
          '</span>' +
          '<span><b>Status:</b> ' +
          esc(String(application.status || '').replace(/_/g, ' ')) +
          '</span>' +
          (application.created_at ? '<span><b>Submitted:</b> ' + esc(String(application.created_at).slice(0, 19).replace('T', ' ')) + '</span>' : '') +
          '</div>';
    const sign = blank
        ? '<div class="sign"><div>Signature of applicant: <span class="line"></span></div><div>Date: <span class="line short"></span></div></div>'
        : '';
    return (
        '<!doctype html><html><head><meta charset="utf-8"><title>' +
        esc(title) +
        ' — Registration form</title><style>' +
        '@page{size:A4 portrait;margin:14mm 12mm;}' +
        'body{font-family:Arial,Helvetica,sans-serif;color:#0f172a;margin:0;padding:24px;background:#fff;}' +
        '.head{display:flex;align-items:center;gap:14px;border-bottom:2px solid #0f766e;padding-bottom:10px;margin-bottom:12px;}' +
        '.head h1{font-size:18px;margin:0;color:#0f766e;}.head h2{font-size:14px;margin:2px 0 0;font-weight:600;color:#334155;}' +
        '.org{font-size:12px;color:#64748b;}' +
        '.meta{display:flex;flex-wrap:wrap;gap:18px;font-size:12px;color:#334155;margin-bottom:14px;}' +
        '.row{display:grid;grid-template-columns:34% 66%;border:1px solid #cbd5e1;border-top:none;font-size:12.5px;page-break-inside:avoid;}' +
        '.row:first-of-type{border-top:1px solid #cbd5e1;}' +
        '.lab{padding:8px 10px;background:#f1f5f9;font-weight:600;border-right:1px solid #cbd5e1;}' +
        '.ans{padding:8px 10px;min-height:16px;white-space:pre-wrap;word-break:break-word;}.ans.tall{min-height:44px;}' +
        '.req{color:#dc2626;}.muted{color:#94a3b8;}' +
        '.line{display:inline-block;border-bottom:1px solid #334155;width:180px;height:12px;vertical-align:bottom;}.line.short{width:100px;}' +
        '.sign{display:flex;justify-content:space-between;gap:20px;margin-top:34px;font-size:12px;}' +
        '.foot{margin-top:18px;font-size:10.5px;color:#64748b;text-align:center;}' +
        '</style></head><body>' +
        '<div class="head">' +
        logo +
        '<div><div class="org">' +
        esc(org) +
        '</div><h1>' +
        esc(title) +
        '</h1><h2>' +
        (blank ? 'Registration form' : 'Submitted application') +
        '</h2></div></div>' +
        meta +
        '<div class="grid">' +
        rows +
        '</div>' +
        sign +
        '<div class="foot">' +
        esc(org) +
        (blank ? ' · Fill in block letters. Fields marked * are mandatory.' : ' · Generated ' + new Date().toISOString().slice(0, 10)) +
        '</div>' +
        '</body></html>'
    );
}

function sendRendered(res, html, format, baseName) {
    const asImage = String(format || '').toLowerCase() === 'png' || String(format || '').toLowerCase() === 'image';
    const render = asImage ? htmlToPngBuffer(html, { width: 900 }) : htmlToPdfBuffer(html, { landscape: false });
    render
        .then((buf) => {
            res.setHeader('Content-Type', asImage ? 'image/png' : 'application/pdf');
            res.setHeader('Content-Disposition', 'attachment; filename="' + baseName + (asImage ? '.png' : '.pdf') + '"');
            res.setHeader('Cache-Control', 'no-store');
            res.end(buf);
        })
        .catch((err) => {
            res.status(500).json({ error: 'Could not render form: ' + (err && err.message ? err.message : err) });
        });
}

/**
 * deps: { db, requireAdminActor, loadRegistrationFormConfig, loadSiteBranding? }
 * loadRegistrationFormConfig(seminarId, cb(err, { fields }))
 */
function registerApplicationFormExportRoutes(app, deps) {
    const { db, requireAdminActor, loadRegistrationFormConfig } = deps;
    const branding = () =>
        new Promise((resolve) => {
            if (typeof deps.loadSiteBranding !== 'function') return resolve(null);
            try {
                deps.loadSiteBranding((err, b) => resolve(err ? null : b));
            } catch (_) {
                resolve(null);
            }
        });

    // Blank form for a seminar: /api/admin/seminars/:id/form-export?format=pdf|png
    app.get('/api/admin/seminars/:id/form-export', (req, res) => {
        requireAdminActor(req, res, () => {
            const sid = parseInt(req.params.id, 10);
            if (!Number.isInteger(sid)) return res.status(400).json({ error: 'Invalid seminar id' });
            db.get(`SELECT id, title FROM seminars WHERE id = ?`, [sid], (err, seminar) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!seminar) return res.status(404).json({ error: 'Seminar not found' });
                loadRegistrationFormConfig(sid, (eCfg, cfg) => {
                    if (eCfg) return res.status(500).json({ error: eCfg.message });
                    branding().then((b) => {
                        const html = buildFormHtml({ seminar, fields: (cfg && cfg.fields) || [], formData: {}, blank: true, branding: b });
                        sendRendered(res, html, req.query.format, 'Registration_form_' + safeFilePart(seminar.title));
                    });
                });
            });
        });
    });

    // Filled application: /api/admin/applications/:id/form-export?format=pdf|png
    app.get('/api/admin/applications/:id/form-export', (req, res) => {
        requireAdminActor(req, res, () => {
            const rid = parseInt(req.params.id, 10);
            if (!Number.isInteger(rid)) return res.status(400).json({ error: 'Invalid application id' });
            db.get(
                `SELECT r.id, r.application_no, r.status, r.form_data, r.created_at, r.seminar_id,
                        u.first_name, u.middle_name, u.last_name, u.email, u.phone,
                        s.title AS seminar_title
                 FROM registrations r
                 LEFT JOIN users u ON u.id = r.user_id
                 LEFT JOIN seminars s ON s.id = r.seminar_id
                 WHERE r.id = ?`,
                [rid],
                (err, row) => {
                    if (err) return res.status(500).json({ error: err.message });
                    if (!row) return res.status(404).json({ error: 'Application not found' });
                    const fd = parseFormData(row.form_data);
                    const merged = {
                        fname: row.first_name,
                        mname: row.middle_name,
                        lname: row.last_name,
                        email: row.email,
                        phone: row.phone,
                        ...fd
                    };
                    loadRegistrationFormConfig(row.seminar_id, (eCfg, cfg) => {
                        if (eCfg) return res.status(500).json({ error: eCfg.message });
                        branding().then((b) => {
                            const html = buildFormHtml({
                                seminar: { id: row.seminar_id, title: row.seminar_title },
                                fields: (cfg && cfg.fields) || [],
                                formData: merged,
                                application: row,
                                blank: false,
                                branding: b
                            });
                            sendRendered(res, html, req.query.format, 'Application_' + safeFilePart(row.application_no || row.id));
                        });
                    });
                }
            );
        });
    });
}

module.exports = { registerApplicationFormExportRoutes, buildFormHtml };
