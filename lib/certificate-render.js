/**
 * VGMF built-in certificate templates (participant & volunteer) with editable config_json.
 */
const fs = require('fs');
const path = require('path');
const branding = require('./branding');
const certCfg = require('./certificate-template-config');
const certVerify = require('./certificate-verify');
const googleMaps = require('./google-maps');
const notifEngine = require('./notification-engine');

const BUILTIN_PARTICIPANT = '__builtin_vgmf_participant__';
const BUILTIN_VOLUNTEER = '__builtin_vgmf_volunteer__';

function isBuiltinPath(filePath) {
    const p = String(filePath || '');
    return p === BUILTIN_PARTICIPANT || p === BUILTIN_VOLUNTEER;
}

function builtinCertType(filePath) {
    if (filePath === BUILTIN_VOLUNTEER) return 'volunteer';
    return 'participant';
}

function escHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatCertDate(eventDate) {
    if (!eventDate) return '';
    const d = new Date(eventDate);
    if (Number.isNaN(d.getTime())) return String(eventDate);
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

function displayNameWithHonorific(displayName, formData, autoHonorific) {
    const name = String(displayName || '').trim();
    if (!name) return 'Participant';
    if (!autoHonorific || /^(mr|mrs|ms|dr|prof)\.?\s/i.test(name)) return name;
    let fd = {};
    try {
        fd = typeof formData === 'string' ? JSON.parse(formData) : formData || {};
    } catch (_) {
        fd = {};
    }
    const g = String(fd.gender || fd.title || '').toLowerCase();
    let prefix = 'Dr.';
    if (g.includes('female') || g === 'f' || g === 'ms' || g === 'mrs') prefix = 'Ms.';
    else if (g.includes('male') || g === 'm') prefix = 'Mr.';
    return prefix + ' ' + name;
}

function venueFromSeminar(row, cmsVenue, override) {
    const o = String(override || '').trim();
    if (o) return o;
    const text = String((row && row.location_text) || '').trim();
    if (text && !googleMaps.isVenueTbd(text)) return text;
    if (cmsVenue) return cmsVenue;
    const loc = String((row && row.location_url) || '').trim();
    if (loc && !/^https?:\/\//i.test(loc)) return loc;
    return 'Venue as announced by the Foundation';
}

function loadCmsVenue(db, cb) {
    db.get(`SELECT value FROM global_settings WHERE key = 'public_site_cms'`, [], (e, row) => {
        if (e || !row || !row.value) return cb(null, '');
        try {
            const cms = JSON.parse(row.value);
            cb(null, (cms.hero && cms.hero.venue) || (cms.contact && cms.contact.address) || '');
        } catch (_) {
            cb(null, '');
        }
    });
}

function fetchParticipantCert(db, certId, userId, cb) {
    db.get(
        `SELECT uc.*, s.title AS seminar_title, s.description AS seminar_description, s.event_date, s.location_text, s.location_url,
                COALESCE(s.cert_scans_required, 1) AS cert_scans_required,
                COALESCE(s.certificate_verify_enabled, 0) AS certificate_verify_enabled,
                COALESCE(s.certificate_verify_manual, 0) AS certificate_verify_manual,
                s.certificate_verify_go_live_at,
                ct.file_path AS template_path, ct.cert_type, ct.config_json,
                r.form_data, r.application_no, u.user_id_string, u.email, u.phone,
                o.status AS order_status, COALESCE(t.scan_count, 0) AS scan_count,
                COALESCE(uc.enabled, 0) AS cert_enabled
         FROM user_certificates uc
         JOIN seminars s ON s.id = uc.seminar_id
         JOIN users u ON u.id = uc.user_id
         LEFT JOIN certificate_templates ct ON ct.id = uc.template_id
         LEFT JOIN registrations r ON r.id = uc.registration_id
         LEFT JOIN orders o ON o.registration_id = r.id AND lower(trim(o.status)) = 'success'
         LEFT JOIN tickets t ON t.order_id = o.id
         WHERE uc.id = ? AND uc.user_id = ? AND uc.enabled = 1`,
        [certId, userId],
        (err, row) => {
            if (err) return cb(err);
            if (!row) return cb(null, null);
            const view = certVerify.doctorCertificateViewState({
                cert_scans_required: row.cert_scans_required,
                scan_count: row.scan_count,
                order_status: row.order_status,
                cert_enabled: row.cert_enabled,
                template_path: row.template_path,
                certificate_verify_enabled: row.certificate_verify_enabled,
                certificate_verify_manual: row.certificate_verify_manual,
                certificate_verify_go_live_at: row.certificate_verify_go_live_at,
                event_date: row.event_date
            });
            if (!view.canViewCertificate) return cb(null, null);
            readyCertRowForRender(db, certId, 'participant', row, cb);
        }
    );
}

function readyCertRowForRender(db, certId, certKind, row, cb) {
    const ensureToken =
        certKind === 'volunteer' ? certVerify.ensureVolunteerCertVerifyToken : certVerify.ensureUserCertVerifyToken;
    ensureToken(db, certId, (e1, tok) => {
        if (e1) return cb(e1);
        row.verify_token = tok;
        const appNo = String((row && row.application_no) || '').trim();
        certVerify.ensureCertificateIdString(db, certKind, certId, appNo, (e2, idStr) => {
            if (e2) return cb(e2);
            row.certificate_id_string = idStr;
            cb(null, row);
        });
    });
}

function fetchVolunteerCert(db, certId, userId, cb) {
    db.get(
        `SELECT vc.id, vc.user_id, vc.seminar_id, vc.display_name, vc.enabled, vc.verify_token, vc.certificate_id_string,
                s.title AS seminar_title, s.description AS seminar_description, s.event_date, s.location_text, s.location_url,
                COALESCE(s.cert_scans_required, 1) AS cert_scans_required,
                COALESCE(s.certificate_verify_enabled, 0) AS certificate_verify_enabled,
                COALESCE(s.certificate_verify_manual, 0) AS certificate_verify_manual,
                s.certificate_verify_go_live_at,
                ct.file_path AS template_path, ct.cert_type, ct.config_json, 'volunteer' AS kind,
                u.user_id_string, u.email, u.phone,
                COALESCE(NULLIF(trim(sv.volunteer_ticket_id_string), ''), NULLIF(trim(r.application_no), '')) AS application_no,
                o.status AS order_status, COALESCE(t.scan_count, 0) AS scan_count,
                COALESCE(vc.enabled, 0) AS cert_enabled
         FROM volunteer_certificates vc
         JOIN seminars s ON s.id = vc.seminar_id
         JOIN users u ON u.id = vc.user_id
         LEFT JOIN certificate_templates ct ON ct.id = vc.template_id
         LEFT JOIN registrations r ON r.id = vc.registration_id
         LEFT JOIN seminar_volunteers sv ON sv.seminar_id = vc.seminar_id AND sv.user_id = vc.user_id
         LEFT JOIN orders o ON o.registration_id = r.id AND lower(trim(o.status)) = 'success'
         LEFT JOIN tickets t ON t.order_id = o.id
         WHERE vc.id = ? AND vc.user_id = ? AND vc.enabled = 1`,
        [certId, userId],
        (err, row) => {
            if (err) return cb(err);
            if (!row) return cb(null, null);
            const view = certVerify.doctorCertificateViewState({
                cert_scans_required: row.cert_scans_required,
                scan_count: row.scan_count,
                order_status: row.order_status,
                cert_enabled: row.cert_enabled,
                template_path: row.template_path,
                certificate_verify_enabled: row.certificate_verify_enabled,
                certificate_verify_manual: row.certificate_verify_manual,
                certificate_verify_go_live_at: row.certificate_verify_go_live_at,
                event_date: row.event_date
            });
            if (!view.canViewCertificate) return cb(null, null);
            readyCertRowForRender(db, certId, 'volunteer', row, cb);
        }
    );
}

function buildRenderContext(row, certType, cmsVenue, logoUrl, configOverride, renderOpts) {
    const plain = !!(renderOpts && renderOpts.plain);
    const esc = plain ? (s) => String(s == null ? '' : s) : escHtml;
    const cfg = certCfg.parseConfig(configOverride != null ? configOverride : row && row.config_json);
    if (row && row.signature_left_path && !cfg.sigLeftImagePath) {
        cfg.sigLeftImagePath = row.signature_left_path;
    }
    if (row && row.signature_right_path && !cfg.sigRightImagePath) {
        cfg.sigRightImagePath = row.signature_right_path;
    }
    const seminarTitle = row.seminar_title || 'National Seminar';
    const topic = row.seminar_description ? String(row.seminar_description).trim() : seminarTitle;
    const kind = certType === 'volunteer' ? 'volunteer' : 'participant';
    const recipientRaw = displayNameWithHonorific(row.display_name, row.form_data, cfg.autoHonorific !== false);
    const prn = String((row && row.user_id_string) || '').trim();
    const applicationNo = String((row && row.application_no) || '').trim();
    const certificateId = certVerify.normalizeCertId12(row && row.certificate_id_string) || '';
    const verifyToken = row && row.verify_token ? String(row.verify_token) : '';
    const qrSrc =
        renderOpts && renderOpts.qrDataUrl
            ? renderOpts.qrDataUrl
            : verifyToken
              ? certVerify.qrImageUrl(verifyToken)
              : '';
    const vars = {
        recipient_name: esc(recipientRaw),
        seminar_title: esc(seminarTitle),
        topic: esc(topic),
        venue: esc(venueFromSeminar(row, cmsVenue, cfg.venueOverride)),
        date: esc(cfg.dateOverride ? String(cfg.dateOverride).trim() : formatCertDate(row.event_date)),
        prn_no: esc(prn || '—'),
        application_no: esc(applicationNo || '—')
    };
    const bodyTpl = kind === 'volunteer' ? cfg.bodyVolunteer : cfg.bodyParticipant;
    const bodyLine = certCfg.applyPlaceholders(bodyTpl, vars);
    return {
        kind,
        config: cfg,
        recipientName: vars.recipient_name,
        bodyLine,
        venue: vars.venue,
        eventDate: vars.date,
        logoUrl: logoUrl ? esc(logoUrl) : '',
        orgName: esc(cfg.orgName),
        title: esc(cfg.title),
        subtitle: esc(cfg.subtitle),
        leadText: esc(cfg.leadText),
        venueLabel: esc(cfg.venueLabel || 'Venue'),
        dateLabel: esc(cfg.dateLabel || 'Date'),
        sigLeftTitle: esc(cfg.sigLeftTitle),
        sigRightName: esc(cfg.sigRightName),
        sigRightTitle: esc(cfg.sigRightTitle),
        sigLeftImagePath: cfg.sigLeftImagePath ? esc(String(cfg.sigLeftImagePath).trim()) : '',
        sigRightImagePath: cfg.sigRightImagePath ? esc(String(cfg.sigRightImagePath).trim()) : '',
        goldColor: esc(cfg.goldColor || '#c9a227'),
        nameColor: esc(cfg.nameColor || '#c45c26'),
        charcoalColor: esc(cfg.charcoalColor || '#4a4a4a'),
        bgColor: esc(cfg.bgColor || '#f3f3f3'),
        showFlame: cfg.showFlame !== false,
        showSwooshes: cfg.showSwooshes !== false,
        prnNo: vars.prn_no,
        applicationNo: vars.application_no,
        certificateId: esc(certificateId || '—'),
        qrImgUrl: verifyToken && qrSrc ? esc(qrSrc) : '',
        verifyPageUrl: verifyToken ? esc(certVerify.publicVerifyUrl(verifyToken)) : ''
    };
}

function safeCertFilename(row) {
    const certId = certVerify.normalizeCertId12(row && row.certificate_id_string);
    const app = String((row && row.application_no) || 'certificate').replace(/[^\w.-]+/g, '_');
    return 'VGMF_Certificate_' + (certId || app);
}

let _certCssCache = null;
function getCertificateCssText() {
    if (_certCssCache) return _certCssCache;
    try {
        _certCssCache = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'certificate-vgmf.css'), 'utf8');
    } catch (_) {
        _certCssCache = '';
    }
    return _certCssCache;
}

function absolutePublicUrl(assetPath) {
    const p = String(assetPath || '').trim();
    if (!p) return '';
    if (/^https?:\/\//i.test(p) || p.startsWith('data:')) return p;
    const base = notifEngine.publicBaseUrl().replace(/\/$/, '');
    return p.startsWith('/') ? base + p : base + '/' + p;
}

function localAssetToDataUrl(assetPath, cb) {
    const p = String(assetPath || '').trim();
    if (!p) return cb(null, '');
    if (p.startsWith('data:')) return cb(null, p);
    if (/^https?:\/\//i.test(p)) return cb(null, p);
    const rel = p.replace(/^\//, '');
    const full = path.join(__dirname, '..', 'public', rel);
    fs.readFile(full, (err, buf) => {
        if (err || !buf) return cb(null, absolutePublicUrl(p));
        const ext = path.extname(p).toLowerCase();
        const mime =
            ext === '.png'
                ? 'image/png'
                : ext === '.jpg' || ext === '.jpeg'
                  ? 'image/jpeg'
                  : ext === '.webp'
                    ? 'image/webp'
                    : ext === '.gif'
                      ? 'image/gif'
                      : 'image/png';
        cb(null, `data:${mime};base64,${buf.toString('base64')}`);
    });
}

function loadCertificateAssets(db, row, certType, opts, cb) {
    const type = certType || builtinCertType(row.template_path);
    const wantEmbed = !!(opts && opts.embed);
    loadCmsVenue(db, (eVenue, cmsVenue) => {
        loadLogoUrl(db, (eLogo, logoUrl) => {
            const afterQr = (qrDataUrl) => {
                const sigLeft = row && row.signature_left_path ? String(row.signature_left_path).trim() : '';
                const sigRight = row && row.signature_right_path ? String(row.signature_right_path).trim() : '';
                const ctxBase = buildRenderContext(row, type, cmsVenue, logoUrl, null, {
                    qrDataUrl: qrDataUrl || '',
                    plain: false
                });
                if (!wantEmbed) {
                    return cb(null, { ctx: ctxBase, logoUrl, qrDataUrl: qrDataUrl || '' });
                }
                localAssetToDataUrl(logoUrl, (e1, logoDataUrl) => {
                    const cfg = certCfg.parseConfig(row && row.config_json);
                    const sigLeftRaw = String(
                        (cfg.sigLeftImagePath || row.signature_left_path || '').trim()
                    );
                    const sigRightRaw = String(
                        (cfg.sigRightImagePath || row.signature_right_path || '').trim()
                    );
                    localAssetToDataUrl(sigLeftRaw, (e2, sigLeftDataUrl) => {
                        localAssetToDataUrl(sigRightRaw, (e3, sigRightDataUrl) => {
                            const ctx = buildRenderContext(row, type, cmsVenue, logoDataUrl || logoUrl, null, {
                                qrDataUrl: qrDataUrl || '',
                                plain: false
                            });
                            if (sigLeftDataUrl) ctx.sigLeftImagePath = sigLeftDataUrl;
                            if (sigRightDataUrl) ctx.sigRightImagePath = sigRightDataUrl;
                            cb(null, { ctx, logoUrl: logoDataUrl || logoUrl, qrDataUrl: qrDataUrl || '' });
                        });
                    });
                });
            };
            if (row && row.verify_token) {
                return certVerify.qrDataUrlForToken(row.verify_token, (eQr, dataUrl) => {
                    afterQr(eQr ? '' : dataUrl);
                });
            }
            afterQr('');
        });
    });
}

function renderCertificateHtml(ctx, opts) {
    opts = opts || {};
    const inlineCss = opts.inlineCss ? String(opts.inlineCss) : '';
    const cssBlock = inlineCss
        ? `<style>${inlineCss}</style>`
        : '<link rel="stylesheet" href="/css/certificate-vgmf.css">';
    const logoImg = ctx.logoUrl
        ? `<img class="cert-logo-tr" src="${ctx.logoUrl}" alt="VGMF">`
        : '<div class="cert-logo-tr cert-logo-fallback" aria-hidden="true">VGMF</div>';
    const swoosh =
        ctx.showSwooshes !== false
            ? '<div class="cert-swoosh cert-swoosh-tl" aria-hidden="true"></div><div class="cert-swoosh cert-swoosh-br" aria-hidden="true"></div>'
            : '';
    const flame = ctx.showFlame !== false ? '<div class="cert-flame" aria-hidden="true"></div>' : '';
    const styleVars = `--cert-gold:${ctx.goldColor};--cert-name:${ctx.nameColor};--cert-charcoal:${ctx.charcoalColor};--cert-bg:${ctx.bgColor};`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Certificate — VGMF</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;600;700&family=Great+Vibes&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
${cssBlock}
<style>.cert-page{${styleVars}}</style>
</head>
<body class="cert-print-body">
<div class="cert-page">
  ${swoosh}
  ${flame}
  <div class="cert-inner">
    ${logoImg}
    <p class="cert-org">${ctx.orgName}</p>
    <h1 class="cert-title">${ctx.title}</h1>
    <p class="cert-of">${ctx.subtitle}</p>
    <p class="cert-lead">${ctx.leadText}</p>
    <p class="cert-name">${ctx.recipientName}</p>
    <p class="cert-body">${ctx.bodyLine}</p>
    <p class="cert-meta"><strong>${ctx.venueLabel}</strong> ${ctx.venue}</p>
    <p class="cert-meta"><strong>${ctx.dateLabel}</strong> ${ctx.eventDate}</p>
    <div class="cert-ids-row">
      <div class="cert-ids-text">
        <p class="cert-meta cert-id-line"><strong>PRN No.</strong> ${ctx.prnNo}</p>
        <p class="cert-meta cert-id-line"><strong>Application No.</strong> ${ctx.applicationNo}</p>
        <p class="cert-meta cert-id-line"><strong>Certificate ID</strong> ${ctx.certificateId}</p>
      </div>
      ${ctx.qrImgUrl ? `<div class="cert-qr-wrap"><img class="cert-qr" src="${ctx.qrImgUrl}" alt="Certificate verification QR"><p class="cert-qr-caption">Scan to verify</p></div>` : '<p class="cert-meta cert-id-missing">QR unavailable — contact the foundation office.</p>'}
    </div>
    <div class="cert-sigs">
      <div class="cert-sig">
        ${ctx.sigLeftImagePath ? `<img class="cert-sig-img" src="${ctx.sigLeftImagePath}" alt="Signature">` : '<div class="cert-sig-line"></div>'}
        <p class="cert-sig-title">${ctx.sigLeftTitle}</p>
      </div>
      <div class="cert-sig">
        ${ctx.sigRightImagePath ? `<img class="cert-sig-img" src="${ctx.sigRightImagePath}" alt="Signature">` : '<div class="cert-sig-line"></div>'}
        <p class="cert-sig-name">${ctx.sigRightName}</p>
        <p class="cert-sig-title">${ctx.sigRightTitle}</p>
      </div>
    </div>
  </div>
</div>
<p class="cert-print-hint no-print">${opts.download ? 'Certificate saved. Open the PDF on your device or print from your browser.' : 'Use your browser Print → Save as PDF for a downloadable copy.'}</p>
<script>document.addEventListener('contextmenu',function(e){e.preventDefault();});window.addEventListener('load',function(){document.querySelector('.cert-page')?.classList.add('ready');${opts.autoPrint ? "setTimeout(function(){try{window.print();}catch(_){}},600);" : ''}});</script>
</body>
</html>`;
}

function loadLogoUrl(db, cb) {
    branding.loadSiteLogoDataUrl(db, (e, dataUrl) => {
        if (e || !dataUrl) {
            db.get(`SELECT value FROM global_settings WHERE key = 'site_logo_path'`, [], (e2, row) => {
                if (!e2 && row && row.value) return cb(null, row.value);
                cb(null, '');
            });
            return;
        }
        cb(null, dataUrl);
    });
}

function sampleRowForPreview(seminarRow) {
    return {
        display_name: 'Shriram Gogate',
        form_data: JSON.stringify({ gender: 'male' }),
        seminar_title: (seminarRow && seminarRow.title) || 'National Seminar',
        seminar_description: (seminarRow && seminarRow.description) || 'Emergency Management In Ayurveda',
        event_date: (seminarRow && seminarRow.event_date) || '2025-09-28',
        location_url: (seminarRow && seminarRow.location_url) || 'Smt Shakuntala Shetty Auditorium, Pune',
        application_no: '123456789012',
        user_id_string: '155760896418',
        certificate_id_string: '433495146392',
        verify_token: 'previewsampletoken0001'
    };
}

function resolveCertificateView(db, req, cb) {
    const userId = parseInt(req.query.uid, 10);
    const ucId = parseInt(req.query.uc, 10);
    const vcId = parseInt(req.query.vc, 10);
    if (!Number.isInteger(userId) || userId < 1) {
        return cb({ status: 400, message: 'Missing or invalid user.' });
    }
    const finish = (err, row, certType) => {
        if (err) return cb({ status: 500, message: err.message });
        if (!row) {
            return cb({
                status: 404,
                message: 'Certificate not found, not yet approved, or venue scan requirements are not complete.'
            });
        }
        cb(null, { row, certType: certType || builtinCertType(row.template_path) });
    };
    if (Number.isInteger(vcId) && vcId > 0) {
        return fetchVolunteerCert(db, vcId, userId, (err, row) => finish(err, row, 'volunteer'));
    }
    if (Number.isInteger(ucId) && ucId > 0) {
        return fetchParticipantCert(db, ucId, userId, (err, row) =>
            finish(err, row, builtinCertType(row && row.template_path))
        );
    }
    return cb({ status: 400, message: 'Specify uc or vc certificate id.' });
}

function sendCertificateHtml(db, res, row, certType, opts) {
    const pathVal = row.template_path;
    if (!isBuiltinPath(pathVal)) {
        if (opts && opts.download) {
            const fname = safeCertFilename(row);
            res.setHeader('Content-Disposition', `attachment; filename="${fname}${pathVal.match(/\.pdf$/i) ? '.pdf' : ''}"`);
        }
        return res.redirect(pathVal || '/');
    }
    loadCertificateAssets(db, row, certType, { embed: !!(opts && opts.download) }, (err, assets) => {
        if (err) {
            return res.status(500).send(err.message || 'Could not render certificate');
        }
        const html = renderCertificateHtml(assets.ctx, {
            ...(opts || {}),
            inlineCss: opts && opts.download ? getCertificateCssText() : ''
        });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        if (opts && opts.download) {
            res.setHeader('Content-Disposition', `inline; filename="${safeCertFilename(row)}.html"`);
            res.setHeader('Cache-Control', 'private, no-store');
        }
        res.send(html);
    });
}

function buildPdfPayload(db, req, cb) {
    resolveCertificateView(db, req, (err, data) => {
        if (err) return cb(err);
        const row = data.row;
        const certType = data.certType;
        if (!isBuiltinPath(row.template_path)) {
            return cb({ status: 400, message: 'PDF download is available for standard VGMF certificates only.' });
        }
        loadCertificateAssets(db, row, certType, { embed: true }, (eAssets, assets) => {
            if (eAssets) return cb({ status: 500, message: eAssets.message });
            loadCmsVenue(db, (eVenue, cmsVenue) => {
                const withVenue = buildRenderContext(row, certType || builtinCertType(row.template_path), cmsVenue, assets.logoUrl, null, {
                    qrDataUrl: assets.qrDataUrl || '',
                    plain: true
                });
                cb(null, {
                    filename: safeCertFilename(row) + '.pdf',
                    orgName: withVenue.orgName,
                    title: withVenue.title,
                    subtitle: withVenue.subtitle,
                    leadText: withVenue.leadText,
                    recipientName: withVenue.recipientName,
                    bodyLine: certCfg.htmlToPlainText(withVenue.bodyLine),
                    venue: withVenue.venue,
                    venueLabel: withVenue.venueLabel,
                    eventDate: withVenue.eventDate,
                    dateLabel: withVenue.dateLabel,
                    prnNo: withVenue.prnNo,
                    applicationNo: withVenue.applicationNo,
                    certificateId: withVenue.certificateId,
                    sigLeftTitle: withVenue.sigLeftTitle,
                    sigRightName: withVenue.sigRightName,
                    sigRightTitle: withVenue.sigRightTitle,
                    goldColor: withVenue.goldColor,
                    nameColor: withVenue.nameColor,
                    charcoalColor: withVenue.charcoalColor,
                    bgColor: withVenue.bgColor,
                    showFlame: withVenue.showFlame !== false,
                    showSwooshes: withVenue.showSwooshes !== false,
                    logoDataUrl: assets.logoUrl || '',
                    qrDataUrl: assets.qrDataUrl || '',
                    sigLeftDataUrl: assets.ctx.sigLeftImagePath || '',
                    sigRightDataUrl: assets.ctx.sigRightImagePath || '',
                    verifyPageUrl: withVenue.verifyPageUrl || ''
                });
            });
        });
    });
}

function handleViewRequest(db, req, res) {
    resolveCertificateView(db, req, (err, data) => {
        if (err) return res.status(err.status || 500).send(err.message);
        sendCertificateHtml(db, res, data.row, data.certType, { download: false });
    });
}

function handleDownloadRequest(db, req, res) {
    resolveCertificateView(db, req, (err, data) => {
        if (err) return res.status(err.status || 500).send(err.message);
        const autoPrint = String(req.query.print || req.query.pdf || '') === '1';
        sendCertificateHtml(db, res, data.row, data.certType, { download: true, autoPrint });
    });
}

function renderPreviewHtml(db, { seminarId, certType, config }, cb) {
    const sid = parseInt(seminarId, 10);
    const type = String(certType || 'participant').toLowerCase() === 'volunteer' ? 'volunteer' : 'participant';
    const run = (seminarRow) => {
        loadCmsVenue(db, (eVenue, cmsVenue) => {
            loadLogoUrl(db, (eLogo, logoUrl) => {
                const row = sampleRowForPreview(seminarRow);
                row.config_json = config != null ? certCfg.stringifyConfig(config) : null;
                const ctx = buildRenderContext(row, type, cmsVenue, logoUrl, config);
                cb(null, renderCertificateHtml(ctx));
            });
        });
    };
    if (Number.isInteger(sid) && sid > 0) {
        db.get(`SELECT title, description, event_date, location_url FROM seminars WHERE id = ?`, [sid], (e, s) => {
            if (e) return cb(e);
            run(s || null);
        });
    } else {
        run(null);
    }
}

function applyBuiltinTemplate(db, { seminarId, certType, adminUserId }, cb) {
    const sid = parseInt(seminarId, 10);
    const type = String(certType || 'participant').toLowerCase() === 'volunteer' ? 'volunteer' : 'participant';
    const filePath = type === 'volunteer' ? BUILTIN_VOLUNTEER : BUILTIN_PARTICIPANT;
    const configJson = certCfg.stringifyConfig(certCfg.DEFAULT_CONFIG);
    if (!Number.isInteger(sid) || sid < 1) return cb(new Error('seminarId is required'));

    db.run(
        `UPDATE certificate_templates SET is_active = 0 WHERE seminar_id = ? AND IFNULL(cert_type,'participant') = ?`,
        [sid, type],
        () => {
            db.run(
                `INSERT INTO certificate_templates (seminar_id, file_path, original_name, mime_type, uploaded_by, is_active, cert_type, config_json)
                 VALUES (?, ?, ?, 'text/html', ?, 1, ?, ?)`,
                [sid, filePath, 'VGMF Standard — ' + type, Number.isInteger(adminUserId) ? adminUserId : null, type, configJson],
                function (err) {
                    if (err) return cb(err);
                    const templateId = this.lastID;
                    if (type === 'participant') {
                        db.run(
                            `UPDATE user_certificates SET template_id = ?, updated_at = CURRENT_TIMESTAMP WHERE seminar_id = ? AND enabled = 1`,
                            [templateId, sid],
                            () => cb(null, { templateId, filePath, certType: type })
                        );
                    } else {
                        db.run(
                            `UPDATE volunteer_certificates SET template_id = ?, updated_at = CURRENT_TIMESTAMP WHERE seminar_id = ? AND enabled = 1`,
                            [templateId, sid],
                            () => cb(null, { templateId, filePath, certType: type })
                        );
                    }
                }
            );
        }
    );
}

function getActiveTemplate(db, seminarId, certType, cb) {
    const sid = parseInt(seminarId, 10);
    const type = String(certType || 'participant').toLowerCase() === 'volunteer' ? 'volunteer' : 'participant';
    db.get(
        `SELECT * FROM certificate_templates WHERE seminar_id = ? AND is_active = 1 AND IFNULL(cert_type,'participant') = ? ORDER BY id DESC LIMIT 1`,
        [sid, type],
        cb
    );
}

function saveTemplateConfig(db, { seminarId, certType, config, adminUserId }, cb) {
    const sid = parseInt(seminarId, 10);
    const type = String(certType || 'participant').toLowerCase() === 'volunteer' ? 'volunteer' : 'participant';
    const configJson = certCfg.stringifyConfig(config);
    if (!Number.isInteger(sid) || sid < 1) return cb(new Error('seminarId is required'));

    getActiveTemplate(db, sid, type, (e, tpl) => {
        if (e) return cb(e);
        if (tpl && tpl.id) {
            const leftPath =
                config && config.sigLeftImagePath != null ? String(config.sigLeftImagePath).trim() || null : null;
            const rightPath =
                config && config.sigRightImagePath != null ? String(config.sigRightImagePath).trim() || null : null;
            return db.run(
                `UPDATE certificate_templates SET config_json = ?, signature_left_path = COALESCE(?, signature_left_path), signature_right_path = COALESCE(?, signature_right_path) WHERE id = ?`,
                [configJson, leftPath, rightPath, tpl.id],
                (e2) => {
                    if (e2) return cb(e2);
                    cb(null, { templateId: tpl.id, saved: true });
                }
            );
        }
        const filePath = type === 'volunteer' ? BUILTIN_VOLUNTEER : BUILTIN_PARTICIPANT;
        db.run(
            `INSERT INTO certificate_templates (seminar_id, file_path, original_name, mime_type, uploaded_by, is_active, cert_type, config_json)
             VALUES (?, ?, ?, 'text/html', ?, 1, ?, ?)`,
            [sid, filePath, 'VGMF Custom — ' + type, Number.isInteger(adminUserId) ? adminUserId : null, type, configJson],
            function (err) {
                if (err) return cb(err);
                cb(null, { templateId: this.lastID, saved: true, created: true });
            }
        );
    });
}

module.exports = {
    BUILTIN_PARTICIPANT,
    BUILTIN_VOLUNTEER,
    isBuiltinPath,
    builtinCertType,
    applyBuiltinTemplate,
    handleViewRequest,
    handleDownloadRequest,
    buildPdfPayload,
    safeCertFilename,
    renderCertificateHtml,
    buildRenderContext,
    renderPreviewHtml,
    getActiveTemplate,
    saveTemplateConfig,
    sampleRowForPreview
};
