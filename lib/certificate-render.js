/**
 * VGMF built-in certificate templates (participant & volunteer) with editable config_json.
 */
const branding = require('./branding');
const certCfg = require('./certificate-template-config');
const certVerify = require('./certificate-verify');

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
        `SELECT uc.*, s.title AS seminar_title, s.description AS seminar_description, s.event_date, s.location_url,
                ct.file_path AS template_path, ct.cert_type, ct.config_json,
                r.form_data, r.application_no, u.user_id_string, u.email, u.phone
         FROM user_certificates uc
         JOIN seminars s ON s.id = uc.seminar_id
         JOIN users u ON u.id = uc.user_id
         LEFT JOIN certificate_templates ct ON ct.id = uc.template_id
         LEFT JOIN registrations r ON r.id = uc.registration_id
         WHERE uc.id = ? AND uc.user_id = ? AND uc.enabled = 1`,
        [certId, userId],
        (err, row) => {
            if (err) return cb(err);
            if (!row) return cb(null, null);
            if (!row.verify_token) {
                return certVerify.ensureUserCertVerifyToken(db, certId, (e2, tok) => {
                    if (e2) return cb(e2);
                    row.verify_token = tok;
                    cb(null, row);
                });
            }
            cb(null, row);
        }
    );
}

function fetchVolunteerCert(db, certId, userId, cb) {
    db.get(
        `SELECT vc.id, vc.user_id, vc.seminar_id, vc.display_name, vc.enabled, vc.verify_token,
                s.title AS seminar_title, s.description AS seminar_description, s.event_date, s.location_url,
                ct.file_path AS template_path, ct.cert_type, ct.config_json, 'volunteer' AS kind,
                u.user_id_string, u.email, u.phone,
                COALESCE(NULLIF(trim(sv.volunteer_ticket_id_string), ''), NULLIF(trim(r.application_no), '')) AS application_no
         FROM volunteer_certificates vc
         JOIN seminars s ON s.id = vc.seminar_id
         JOIN users u ON u.id = vc.user_id
         LEFT JOIN certificate_templates ct ON ct.id = vc.template_id
         LEFT JOIN registrations r ON r.id = vc.registration_id
         LEFT JOIN seminar_volunteers sv ON sv.seminar_id = vc.seminar_id AND sv.user_id = vc.user_id
         WHERE vc.id = ? AND vc.user_id = ? AND vc.enabled = 1`,
        [certId, userId],
        (err, row) => {
            if (err) return cb(err);
            if (!row) return cb(null, null);
            if (!row.verify_token) {
                return certVerify.ensureVolunteerCertVerifyToken(db, certId, (e2, tok) => {
                    if (e2) return cb(e2);
                    row.verify_token = tok;
                    cb(null, row);
                });
            }
            cb(null, row);
        }
    );
}

function buildRenderContext(row, certType, cmsVenue, logoUrl, configOverride) {
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
    const verifyToken = row && row.verify_token ? String(row.verify_token) : '';
    const vars = {
        recipient_name: escHtml(recipientRaw),
        seminar_title: escHtml(seminarTitle),
        topic: escHtml(topic),
        venue: escHtml(venueFromSeminar(row, cmsVenue, cfg.venueOverride)),
        date: escHtml(cfg.dateOverride ? String(cfg.dateOverride).trim() : formatCertDate(row.event_date)),
        prn_no: escHtml(prn || '—'),
        application_no: escHtml(applicationNo || '—')
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
        logoUrl: logoUrl ? escHtml(logoUrl) : '',
        orgName: escHtml(cfg.orgName),
        title: escHtml(cfg.title),
        subtitle: escHtml(cfg.subtitle),
        leadText: escHtml(cfg.leadText),
        venueLabel: escHtml(cfg.venueLabel || 'Venue'),
        dateLabel: escHtml(cfg.dateLabel || 'Date'),
        sigLeftTitle: escHtml(cfg.sigLeftTitle),
        sigRightName: escHtml(cfg.sigRightName),
        sigRightTitle: escHtml(cfg.sigRightTitle),
        sigLeftImagePath: cfg.sigLeftImagePath ? escHtml(String(cfg.sigLeftImagePath).trim()) : '',
        sigRightImagePath: cfg.sigRightImagePath ? escHtml(String(cfg.sigRightImagePath).trim()) : '',
        goldColor: escHtml(cfg.goldColor || '#c9a227'),
        nameColor: escHtml(cfg.nameColor || '#c45c26'),
        charcoalColor: escHtml(cfg.charcoalColor || '#4a4a4a'),
        bgColor: escHtml(cfg.bgColor || '#f3f3f3'),
        showFlame: cfg.showFlame !== false,
        showSwooshes: cfg.showSwooshes !== false,
        prnNo: vars.prn_no,
        applicationNo: vars.application_no,
        qrImgUrl: verifyToken ? escHtml(certVerify.qrImageUrl(verifyToken)) : '',
        verifyPageUrl: verifyToken ? escHtml(certVerify.publicVerifyUrl(verifyToken)) : ''
    };
}

function renderCertificateHtml(ctx) {
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
<link rel="stylesheet" href="/css/certificate-vgmf.css">
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
<p class="cert-print-hint no-print">Use your browser Print → Save as PDF for a downloadable copy.</p>
<script>document.addEventListener('contextmenu',function(e){e.preventDefault();});window.addEventListener('load',function(){document.querySelector('.cert-page')?.classList.add('ready');});</script>
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
        user_id_string: 'USR_SAMPLE01',
        verify_token: 'previewsampletoken0001'
    };
}

function handleViewRequest(db, req, res) {
    const userId = parseInt(req.query.uid, 10);
    const ucId = parseInt(req.query.uc, 10);
    const vcId = parseInt(req.query.vc, 10);
    if (!Number.isInteger(userId) || userId < 1) {
        return res.status(400).send('Missing or invalid user.');
    }

    const finish = (err, row, certType) => {
        if (err) return res.status(500).send(err.message);
        if (!row) return res.status(404).send('Certificate not found or not enabled.');
        const path = row.template_path;
        if (!isBuiltinPath(path)) {
            return res.redirect(path || '/');
        }
        const type = certType || builtinCertType(path);
        loadCmsVenue(db, (eVenue, cmsVenue) => {
            loadLogoUrl(db, (eLogo, logoUrl) => {
                const ctx = buildRenderContext(row, type, cmsVenue, logoUrl);
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                res.send(renderCertificateHtml(ctx));
            });
        });
    };

    if (Number.isInteger(vcId) && vcId > 0) {
        return fetchVolunteerCert(db, vcId, userId, (err, row) => finish(err, row, 'volunteer'));
    }
    if (Number.isInteger(ucId) && ucId > 0) {
        return fetchParticipantCert(db, ucId, userId, (err, row) =>
            finish(err, row, builtinCertType(row && row.template_path))
        );
    }
    return res.status(400).send('Specify uc or vc certificate id.');
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
    renderCertificateHtml,
    buildRenderContext,
    renderPreviewHtml,
    getActiveTemplate,
    saveTemplateConfig,
    sampleRowForPreview
};
