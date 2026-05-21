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

function toPdfHtml(payload) {
    const title = 'Case Presentation Marksheet';
    return exportReports.toHtmlTable(payload.rows || [], title);
}

module.exports = {
    eligibilityPercent,
    computeAutoEligibility,
    buildMarksheetRows,
    toXlsxBuffer,
    toPdfHtml
};
