/**
 * Case presentation marksheet — per-judge rows with criteria, totals, auto eligibility.
 */
const XLSX = require('xlsx');
const CASE_JUDGE_CRITERIA = [
    { key: 'criteria_a', label: 'Criteria A', maxMarks: 5 },
    { key: 'criteria_b', label: 'Criteria B', maxMarks: 5 },
    { key: 'criteria_c', label: 'Criteria C', maxMarks: 5 },
    { key: 'criteria_d', label: 'Criteria D', maxMarks: 5 },
    { key: 'criteria_e', label: 'Criteria E', maxMarks: 5 }
];

function parseJudgeCriteria(raw) {
    if (raw == null || raw === '') return CASE_JUDGE_CRITERIA.map((c) => ({ ...c }));
    try {
        const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!Array.isArray(arr) || !arr.length) return CASE_JUDGE_CRITERIA.map((c) => ({ ...c }));
        return arr.map((c, i) => ({
            key: String(c.key || `criteria_${i + 1}`).trim(),
            label: String(c.label || `Criterion ${i + 1}`).trim(),
            maxMarks: Math.max(1, Math.min(100, parseInt(c.maxMarks, 10) || 5))
        }));
    } catch (_) {
        return CASE_JUDGE_CRITERIA.map((c) => ({ ...c }));
    }
}

function totalMaxFromCriteria(criteria) {
    return (criteria || []).reduce((s, c) => s + (c.maxMarks || 0), 0);
}
const exportReports = require('./export-reports');
const branding = require('./branding');

const FOUNDATION_NAME = branding.FOUNDATION_NAME;
const FOUNDATION_TAGLINE = 'National Seminar & Case Presentation Portal';

function eligibilityPercent() {
    const p = parseFloat(process.env.CASE_ELIGIBILITY_PCT || '60', 10);
    return Number.isFinite(p) && p > 0 && p <= 100 ? p : 60;
}

function computeAutoEligibility(avgScore, judgesScored, totalMax, plagiarismZero) {
    if (plagiarismZero) return 'Disqualified';
    if (!judgesScored || judgesScored < 1 || avgScore == null) return 'Pending scores';
    const threshold = (totalMax * eligibilityPercent()) / 100;
    return Number(avgScore) >= threshold ? 'Eligible' : 'Not eligible';
}

function parseCriteriaJson(raw) {
    if (!raw) return [];
    try {
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (_) {
        return [];
    }
}

function buildMarksheetRows(db, programId, cb) {
    const loadCriteria = (pid, next) => {
        if (Number.isInteger(pid) && pid > 0) {
            db.get(`SELECT judge_criteria_json FROM case_programs WHERE id = ?`, [pid], (e, row) => {
                if (e) return cb(e);
                const criteria = parseJudgeCriteria(row && row.judge_criteria_json);
                next(criteria);
            });
        } else {
            next(parseJudgeCriteria(null));
        }
    };

    const pid = parseInt(programId, 10);
    loadCriteria(Number.isInteger(pid) && pid > 0 ? pid : null, (criteriaDefs) => {
        const totalMax = totalMaxFromCriteria(criteriaDefs);
        let sql = `
            SELECT cs.id AS submission_id, cs.application_no, cs.title, cs.category, cs.status,
                   COALESCE(cs.plagiarism_zero, 0) AS plagiarism_zero,
                   u.first_name AS doctor_first, u.last_name AS doctor_last, u.user_id_string AS doctor_portal_id,
                   cjs.judge_user_id, cjs.criteria_json, cjs.total_score, cjs.remarks,
                   COALESCE(cjs.is_locked, 0) AS is_locked, cjs.submitted_at,
                   ju.first_name AS judge_first, ju.last_name AS judge_last, ju.user_id_string AS judge_portal_id
            FROM case_submissions cs
            JOIN users u ON u.id = cs.user_id
            LEFT JOIN case_judge_scores cjs ON cjs.submission_id = cs.id
            LEFT JOIN users ju ON ju.id = cjs.judge_user_id
            WHERE 1=1`;
        const params = [];
        if (Number.isInteger(pid) && pid > 0) {
            sql += ` AND cs.case_program_id = ?`;
            params.push(pid);
        }
        sql += ` ORDER BY cs.id ASC, cjs.judge_user_id ASC`;

        db.all(sql, params, (err, rawRows) => {
            if (err) return cb(err);
            const bySub = {};
            (rawRows || []).forEach((r) => {
                const sid = r.submission_id;
                if (!bySub[sid]) {
                    bySub[sid] = {
                        submission_id: sid,
                        application_no: r.application_no,
                        title: r.title,
                        category: r.category,
                        status: r.status,
                        plagiarism_zero: r.plagiarism_zero,
                        doctor_name: [r.doctor_first, r.doctor_last].filter(Boolean).join(' '),
                        doctor_portal_id: r.doctor_portal_id,
                        locked_scores: [],
                        judge_rows: []
                    };
                }
                if (r.judge_user_id && r.is_locked) {
                    bySub[sid].locked_scores.push(Number(r.total_score) || 0);
                }
                if (!r.judge_user_id) return;
                const crit = parseCriteriaJson(r.criteria_json);
                const row = {
                    application_no: r.application_no || String(sid),
                    doctor_name: bySub[sid].doctor_name,
                    doctor_portal_id: r.doctor_portal_id || '',
                    topic: r.title || '',
                    category: r.category || '',
                    submission_status: r.status || '',
                    judge_name: [r.judge_first, r.judge_last].filter(Boolean).join(' '),
                    judge_portal_id: r.judge_portal_id || '',
                    judge_user_id: r.judge_user_id,
                    judge_total: r.total_score,
                    judge_remarks: r.remarks || '',
                    score_locked: r.is_locked ? 'Yes' : 'No',
                    submitted_at: r.submitted_at || ''
                };
                criteriaDefs.forEach((def) => {
                    const cRow = crit.find((c) => c.key === def.key) || {};
                    row[`${def.label} (${def.maxMarks})`] = cRow.score != null ? cRow.score : '';
                });
                const avg =
                    bySub[sid].locked_scores.length
                        ? bySub[sid].locked_scores.reduce((a, b) => a + b, 0) / bySub[sid].locked_scores.length
                        : null;
                row.avg_score_all_judges = avg != null ? Math.round(avg * 100) / 100 : '';
                row.judges_scored_locked = bySub[sid].locked_scores.length;
                row.max_possible = totalMax;
                row.auto_eligibility = computeAutoEligibility(
                    avg,
                    bySub[sid].locked_scores.length,
                    totalMax,
                    !!r.plagiarism_zero
                );
                bySub[sid].judge_rows.push(row);
            });

            const rows = [];
            Object.keys(bySub)
                .sort((a, b) => Number(a) - Number(b))
                .forEach((sid) => {
                    const block = bySub[sid];
                    if (!block.judge_rows.length) {
                        const avg = null;
                        rows.push({
                            application_no: block.application_no || sid,
                            doctor_name: block.doctor_name,
                            doctor_portal_id: block.doctor_portal_id || '',
                            topic: block.title || '',
                            category: block.category || '',
                            submission_status: block.status || '',
                            judge_name: '—',
                            judge_portal_id: '',
                            judge_user_id: '',
                            judge_total: '',
                            judge_remarks: '',
                            score_locked: 'No',
                            submitted_at: '',
                            avg_score_all_judges: '',
                            judges_scored_locked: 0,
                            max_possible: totalMax,
                            auto_eligibility: computeAutoEligibility(null, 0, totalMax, !!block.plagiarism_zero)
                        });
                    } else {
                        block.judge_rows.forEach((jr) => rows.push(jr));
                    }
                });

            cb(null, {
                criteria: criteriaDefs,
                totalMax,
                eligibilityPercent: eligibilityPercent(),
                rows
            });
        });
    });
}

function toXlsxBuffer(payload) {
    const wb = XLSX.utils.book_new();
    const rows = payload.rows || [];
    if (!rows.length) {
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['No data']]), 'Marksheet');
    } else {
        const keys = [];
        rows.forEach((r) => {
            Object.keys(r).forEach((k) => {
                if (!keys.includes(k)) keys.push(k);
            });
        });
        const data = [keys, ...rows.map((r) => keys.map((k) => (r[k] != null ? r[k] : '')))];
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(data), 'Marksheet');
    }
    const meta = [
        ['Generated', new Date().toISOString()],
        ['Max marks', payload.totalMax],
        ['Eligibility threshold', payload.eligibilityPercent + '% of max'],
        ['Criteria', (payload.criteria || []).map((c) => c.label + ' (' + c.maxMarks + ')').join(', ')]
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(meta), 'Info');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function loadMarksheetDocument(db, programId, cb) {
    buildMarksheetRows(db, programId, (err, payload) => {
        if (err) return cb(err);
        const pid = parseInt(programId, 10);
        const finish = (eventName) => {
            branding.loadSiteLogoDataUrl(db, (eLogo, logoDataUrl) => {
                cb(null, {
                    ...payload,
                    document: {
                        foundationName: FOUNDATION_NAME,
                        tagline: FOUNDATION_TAGLINE,
                        eventName: eventName || 'Case presentation program',
                        logoDataUrl: logoDataUrl || '',
                        generatedAt: new Date().toLocaleString('en-IN', {
                            dateStyle: 'medium',
                            timeStyle: 'short'
                        }),
                        eligibilityNote:
                            'Auto eligibility: average locked score ≥ ' +
                            (payload.eligibilityPercent || 60) +
                            '% of ' +
                            (payload.totalMax || 25) +
                            ' marks.'
                    }
                });
            });
        };
        if (Number.isInteger(pid) && pid > 0) {
            db.get(`SELECT title FROM case_programs WHERE id = ?`, [pid], (eP, row) => {
                finish((row && row.title) || 'Case program #' + pid);
            });
        } else {
            finish('All case presentation programs');
        }
    });
}

function toBrandedPdfHtml(doc) {
    const payload = doc || {};
    const meta = payload.document || {};
    const rows = payload.rows || [];
    const keys = [];
    rows.forEach((r) => {
        Object.keys(r).forEach((k) => {
            if (!keys.includes(k)) keys.push(k);
        });
    });

    const logoBlock = meta.logoDataUrl
        ? '<img src="' + meta.logoDataUrl + '" alt="Foundation logo" class="ms-logo">'
        : '<div class="ms-logo-placeholder"><i>VGMF</i></div>';

    let tableHead = '';
    keys.forEach((k) => {
        tableHead += '<th>' + escapeHtml(k) + '</th>';
    });
    let tableBody = '';
    rows.forEach((r) => {
        tableBody += '<tr>';
        keys.forEach((k) => {
            tableBody += '<td>' + escapeHtml(r[k] != null ? String(r[k]) : '') + '</td>';
        });
        tableBody += '</tr>';
    });
    if (!tableBody) {
        tableBody = '<tr><td colspan="' + Math.max(1, keys.length) + '">No data</td></tr>';
    }

    return (
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
        '<title>' +
        escapeHtml(meta.eventName) +
        ' — Marksheet</title>' +
        '<style>' +
        '@page { margin: 14mm; }' +
        'body{font-family:"Segoe UI",system-ui,sans-serif;color:#0f172a;margin:0;padding:0;background:#fff;}' +
        '.ms-header{border-bottom:3px solid #0f766e;padding:0 0 16px;margin-bottom:18px;display:flex;align-items:center;gap:20px;}' +
        '.ms-logo{max-height:72px;max-width:200px;object-fit:contain;}' +
        '.ms-logo-placeholder{width:72px;height:72px;border-radius:12px;background:linear-gradient(135deg,#0f766e,#047857);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:0.75rem;}' +
        '.ms-title h1{margin:0;font-size:1.35rem;color:#064e3b;font-weight:800;}' +
        '.ms-title .foundation{margin:4px 0 0;font-size:0.95rem;color:#0f766e;font-weight:700;}' +
        '.ms-title .event{margin:6px 0 0;font-size:1.05rem;color:#334155;}' +
        '.ms-meta{font-size:0.82rem;color:#64748b;margin-bottom:16px;line-height:1.5;}' +
        'table{border-collapse:collapse;width:100%;font-size:9.5pt;}' +
        'th,td{border:1px solid #cbd5e1;padding:6px 8px;text-align:left;vertical-align:top;}' +
        'th{background:#0f766e;color:#fff;font-weight:700;}' +
        'tr:nth-child(even) td{background:#f0fdfa;}' +
        '.ms-footer{margin-top:20px;padding-top:10px;border-top:1px solid #e2e8f0;font-size:8pt;color:#64748b;text-align:center;}' +
        '@media print { .no-print { display:none; } body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }' +
        '</style></head><body>' +
        '<div class="ms-header">' +
        logoBlock +
        '<div class="ms-title">' +
        '<p class="foundation">' +
        escapeHtml(meta.foundationName || FOUNDATION_NAME) +
        '</p>' +
        '<h1>Case Presentation Marksheet</h1>' +
        '<p class="event">' +
        escapeHtml(meta.eventName || '') +
        '</p>' +
        '</div></div>' +
        '<div class="ms-meta">' +
        '<div>Generated: ' +
        escapeHtml(meta.generatedAt || '') +
        '</div>' +
        '<div>' +
        escapeHtml(meta.eligibilityNote || '') +
        '</div>' +
        '<div>Total rows: ' +
        rows.length +
        '</div></div>' +
        '<table><thead><tr>' +
        tableHead +
        '</tr></thead><tbody>' +
        tableBody +
        '</tbody></table>' +
        '<div class="ms-footer">' +
        escapeHtml(FOUNDATION_NAME) +
        ' · ' +
        escapeHtml(branding.getComputerGeneratedNotice()) +
        '</div>' +
        '</body></html>'
    );
}

function toPdfHtml(payload) {
    return toBrandedPdfHtml({ rows: payload.rows || [], document: payload.document, criteria: payload.criteria });
}

const MS_BASE_CSS =
    '@page { margin: 14mm; }' +
    'body{font-family:"Segoe UI",system-ui,sans-serif;color:#0f172a;margin:0;padding:0;background:#fff;}' +
    '.ms-header{border-bottom:3px solid #0f766e;padding:0 0 16px;margin-bottom:18px;display:flex;align-items:center;gap:20px;}' +
    '.ms-logo{max-height:72px;max-width:200px;object-fit:contain;}' +
    '.ms-logo-placeholder{width:72px;height:72px;border-radius:12px;background:linear-gradient(135deg,#0f766e,#047857);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:0.75rem;}' +
    '.ms-title h1{margin:0;font-size:1.35rem;color:#064e3b;font-weight:800;}' +
    '.ms-title .foundation{margin:4px 0 0;font-size:0.95rem;color:#0f766e;font-weight:700;}' +
    '.ms-title .event{margin:6px 0 0;font-size:1.05rem;color:#334155;}' +
    '.ms-meta{font-size:0.82rem;color:#64748b;margin-bottom:16px;line-height:1.5;}' +
    'table{border-collapse:collapse;width:100%;font-size:9.5pt;}' +
    'th,td{border:1px solid #cbd5e1;padding:6px 8px;text-align:left;vertical-align:top;}' +
    'th{background:#0f766e;color:#fff;font-weight:700;}' +
    'tr:nth-child(even) td{background:#f0fdfa;}' +
    '.ms-footer{margin-top:20px;padding-top:10px;border-top:1px solid #e2e8f0;font-size:8pt;color:#64748b;text-align:center;}' +
    '.cand{display:grid;grid-template-columns:1fr 1fr;gap:6px 18px;font-size:10pt;margin-bottom:16px;}' +
    '.cand div span{color:#64748b;font-size:8.5pt;display:block;}' +
    '.judge{border:1px solid #cbd5e1;border-radius:8px;padding:10px 12px;margin-bottom:12px;page-break-inside:avoid;}' +
    '.judge h3{margin:0 0 8px;font-size:10.5pt;color:#064e3b;}' +
    '.judge .total{font-weight:800;color:#0f766e;}' +
    '.remarks{margin-top:8px;font-size:9.5pt;background:#f8fafc;border-left:3px solid #0f766e;padding:6px 10px;white-space:pre-wrap;}' +
    '.summary{display:flex;gap:18px;flex-wrap:wrap;margin:14px 0;}' +
    '.summary .box{border:1px solid #cbd5e1;border-radius:8px;padding:10px 14px;min-width:120px;}' +
    '.summary .box b{display:block;font-size:14pt;color:#064e3b;}' +
    '.summary .box span{font-size:8.5pt;color:#64748b;}' +
    '.badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:9pt;font-weight:700;}' +
    '.badge.ok{background:#dcfce7;color:#166534;}.badge.no{background:#fee2e2;color:#991b1b;}.badge.pend{background:#e2e8f0;color:#334155;}' +
    '@media print { .no-print { display:none; } body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }';

function headerHtml(meta, heading) {
    const logoBlock = meta.logoDataUrl
        ? '<img src="' + meta.logoDataUrl + '" alt="Foundation logo" class="ms-logo">'
        : '<div class="ms-logo-placeholder"><i>VGMF</i></div>';
    return (
        '<div class="ms-header">' +
        logoBlock +
        '<div class="ms-title"><p class="foundation">' +
        escapeHtml(meta.foundationName || FOUNDATION_NAME) +
        '</p><h1>' +
        escapeHtml(heading) +
        '</h1><p class="event">' +
        escapeHtml(meta.eventName || '') +
        '</p></div></div>'
    );
}

function footerHtml() {
    return (
        '<div class="ms-footer">' +
        escapeHtml(FOUNDATION_NAME) +
        ' · ' +
        escapeHtml(branding.getComputerGeneratedNotice()) +
        '</div>'
    );
}

/** Per-candidate e-marksheet: every judge's criteria marks, total and remarks, plus the averaged result. */
function loadCandidateMarksheet(db, submissionId, cb) {
    const sid = parseInt(submissionId, 10);
    if (!Number.isInteger(sid) || sid < 1) return cb(new Error('Invalid submission id'));
    db.get(
        `SELECT cs.id, cs.case_program_id, cs.application_no, cs.title, cs.category, cs.status,
                COALESCE(cs.plagiarism_zero, 0) AS plagiarism_zero,
                u.first_name, u.middle_name, u.last_name, u.user_id_string, u.email, u.phone,
                cp.title AS program_title, cp.judge_criteria_json
         FROM case_submissions cs
         JOIN users u ON u.id = cs.user_id
         LEFT JOIN case_programs cp ON cp.id = cs.case_program_id
         WHERE cs.id = ?`,
        [sid],
        (err, sub) => {
            if (err) return cb(err);
            if (!sub) return cb(null, null);
            const criteria = parseJudgeCriteria(sub.judge_criteria_json);
            const totalMax = totalMaxFromCriteria(criteria);
            db.all(
                `SELECT cjs.judge_user_id, cjs.criteria_json, cjs.total_score, cjs.remarks,
                        COALESCE(cjs.is_locked, 0) AS is_locked, cjs.submitted_at,
                        ju.first_name AS judge_first, ju.last_name AS judge_last, ju.user_id_string AS judge_portal_id
                 FROM case_judge_scores cjs
                 LEFT JOIN users ju ON ju.id = cjs.judge_user_id
                 WHERE cjs.submission_id = ?
                 ORDER BY cjs.judge_user_id ASC`,
                [sid],
                (e2, scoreRows) => {
                    if (e2) return cb(e2);
                    const judges = (scoreRows || []).map((r) => {
                        const crit = parseCriteriaJson(r.criteria_json);
                        return {
                            judgeUserId: r.judge_user_id,
                            judgeName: [r.judge_first, r.judge_last].filter(Boolean).join(' ') || 'Judge #' + r.judge_user_id,
                            judgePortalId: r.judge_portal_id || '',
                            locked: !!r.is_locked,
                            submittedAt: r.submitted_at || '',
                            total: r.total_score != null ? Number(r.total_score) : null,
                            remarks: r.remarks || '',
                            marks: criteria.map((def) => {
                                const c = crit.find((x) => x.key === def.key) || {};
                                return { key: def.key, label: def.label, maxMarks: def.maxMarks, score: c.score != null ? Number(c.score) : null };
                            })
                        };
                    });
                    const locked = judges.filter((j) => j.locked && j.total != null).map((j) => j.total);
                    const avg = locked.length ? Math.round((locked.reduce((a, b) => a + b, 0) / locked.length) * 100) / 100 : null;
                    branding.loadSiteLogoDataUrl(db, (eLogo, logoDataUrl) => {
                        cb(null, {
                            candidate: {
                                submissionId: sub.id,
                                applicationNo: sub.application_no || String(sub.id),
                                name: [sub.first_name, sub.middle_name, sub.last_name].filter(Boolean).join(' '),
                                portalId: sub.user_id_string || '',
                                email: sub.email || '',
                                phone: sub.phone || '',
                                topic: sub.title || '',
                                category: sub.category || '',
                                status: sub.status || '',
                                plagiarismZero: !!sub.plagiarism_zero
                            },
                            criteria,
                            totalMax,
                            judges,
                            judgesScoredLocked: locked.length,
                            avgScore: avg,
                            eligibilityPercent: eligibilityPercent(),
                            autoEligibility: computeAutoEligibility(avg, locked.length, totalMax, !!sub.plagiarism_zero),
                            document: {
                                foundationName: FOUNDATION_NAME,
                                tagline: FOUNDATION_TAGLINE,
                                eventName: sub.program_title || 'Case presentation program',
                                logoDataUrl: logoDataUrl || '',
                                generatedAt: new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
                            }
                        });
                    });
                }
            );
        }
    );
}

function toCandidateMarksheetHtml(doc) {
    const meta = doc.document || {};
    const c = doc.candidate || {};
    const badgeCls = /^Eligible/.test(doc.autoEligibility) ? 'ok' : /Pending/.test(doc.autoEligibility) ? 'pend' : 'no';
    let judgesHtml = '';
    if (!doc.judges.length) {
        judgesHtml = '<p style="color:#64748b;">No judge has scored this presentation yet.</p>';
    }
    doc.judges.forEach((j, i) => {
        judgesHtml +=
            '<div class="judge"><h3>Judge ' +
            (i + 1) +
            ': ' +
            escapeHtml(j.judgeName) +
            (j.judgePortalId ? ' <span style="color:#64748b;font-weight:400;">(' + escapeHtml(j.judgePortalId) + ')</span>' : '') +
            ' · ' +
            (j.locked ? 'Final' : 'Draft') +
            (j.submittedAt ? ' · ' + escapeHtml(j.submittedAt) : '') +
            '</h3><table><thead><tr>' +
            j.marks.map((m) => '<th>' + escapeHtml(m.label) + ' (' + m.maxMarks + ')</th>').join('') +
            '<th>Total (' +
            doc.totalMax +
            ')</th></tr></thead><tbody><tr>' +
            j.marks.map((m) => '<td>' + (m.score != null ? escapeHtml(String(m.score)) : '—') + '</td>').join('') +
            '<td class="total">' +
            (j.total != null ? escapeHtml(String(j.total)) : '—') +
            '</td></tr></tbody></table>' +
            '<div class="remarks"><b>Remarks:</b> ' +
            (j.remarks ? escapeHtml(j.remarks) : '<i style="color:#64748b;">No remarks</i>') +
            '</div></div>';
    });
    return (
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>' +
        escapeHtml(c.name) +
        ' — e-Marksheet</title><style>' +
        MS_BASE_CSS +
        '</style></head><body>' +
        headerHtml(meta, 'Case Presentation e-Marksheet') +
        '<div class="cand">' +
        '<div><span>Candidate</span><b>' + escapeHtml(c.name) + '</b></div>' +
        '<div><span>Application no.</span><b>' + escapeHtml(c.applicationNo) + '</b></div>' +
        '<div><span>Portal ID</span>' + escapeHtml(c.portalId || '—') + '</div>' +
        '<div><span>Category</span>' + escapeHtml(c.category || '—') + '</div>' +
        '<div style="grid-column:1/-1;"><span>Case title</span>' + escapeHtml(c.topic || '—') + '</div>' +
        '<div><span>Submission status</span>' + escapeHtml(c.status || '—') + '</div>' +
        '<div><span>Generated</span>' + escapeHtml(meta.generatedAt || '') + '</div>' +
        '</div>' +
        '<div class="summary">' +
        '<div class="box"><b>' + (doc.avgScore != null ? doc.avgScore : '—') + ' / ' + doc.totalMax + '</b><span>Average of final scores</span></div>' +
        '<div class="box"><b>' + doc.judgesScoredLocked + ' / ' + doc.judges.length + '</b><span>Judges finalised</span></div>' +
        '<div class="box"><span class="badge ' + badgeCls + '">' + escapeHtml(doc.autoEligibility) + '</span><span>Result (≥ ' + doc.eligibilityPercent + '% of max)</span></div>' +
        (c.plagiarismZero ? '<div class="box"><span class="badge no">Plagiarism: zero marks</span></div>' : '') +
        '</div>' +
        '<h2 style="font-size:12pt;color:#064e3b;margin:18px 0 8px;">Judge-wise marks &amp; remarks</h2>' +
        judgesHtml +
        footerHtml() +
        '</body></html>'
    );
}

module.exports = {
    loadCandidateMarksheet,
    toCandidateMarksheetHtml,
    eligibilityPercent,
    computeAutoEligibility,
    buildMarksheetRows,
    loadMarksheetDocument,
    toXlsxBuffer,
    toBrandedPdfHtml,
    toPdfHtml
};
