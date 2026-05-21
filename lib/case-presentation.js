/**
 * Case presentation programs — scheduling, applications, judging (seminar-like flow).
 */
const { validatePersonName, validateRegistrationPersonNames } = require('./name-validation');
const contactValidation = require('./contact-validation');
const portalTracking = require('./portal-tracking');
const seminarDt = require('./seminar-datetime');
const judgeContact = require('./judge-participant-contact');
const caseJudgeTransfer = require('./case-judge-transfer');
const caseJudgingStatus = require('./case-judging-status');
const casePriorityInvite = require('./case-priority-invite');

const CASE_CATEGORIES = ['agnikarma', 'viddhakarma', 'both'];
const CASE_CATEGORY_LABELS = {
    agnikarma: 'Agnikarma',
    viddhakarma: 'Viddhakarma',
    both: 'Both (Agnikarma & Viddhakarma)'
};

const DEFAULT_CASE_FORM_CONFIG = {
    version: 1,
    fields: [
        { key: 'fname', label: 'First name', type: 'text', enabled: true, required: true },
        { key: 'mname', label: 'Middle name', type: 'text', enabled: true, required: false },
        { key: 'lname', label: 'Last name', type: 'text', enabled: true, required: true },
        { key: 'email', label: 'Email', type: 'email', enabled: true, required: true },
        { key: 'phone', label: 'Phone', type: 'text', enabled: true, required: true },
        { key: 'whatsapp', label: 'WhatsApp no.', type: 'text', enabled: true, required: true },
        { key: 'category', label: 'Category', type: 'select', enabled: true, required: true },
        { key: 'topic', label: 'Case topic', type: 'text', enabled: true, required: true },
        { key: 'files', label: 'Upload (PPT / PDF / video)', type: 'file', enabled: true, required: true }
    ]
};

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

function normalizeSubmittedCriteria(criteriaDefs, submitted) {
    const crit = Array.isArray(submitted) ? submitted : [];
    const out = [];
    let total = 0;
    (criteriaDefs || CASE_JUDGE_CRITERIA).forEach((def) => {
        const row = crit.find((c) => c.key === def.key) || {};
        const sc = Math.min(def.maxMarks, Math.max(0, Number(row.score) || 0));
        total += sc;
        out.push({ key: def.key, label: def.label, score: sc, max: def.maxMarks });
    });
    return { criteria: out, total };
}

function loadJudgeCriteriaForProgram(db, programId, cb) {
    if (!programId) return cb(null, parseJudgeCriteria(null));
    db.get(`SELECT judge_criteria_json FROM case_programs WHERE id = ?`, [programId], (e, row) => {
        if (e) return cb(e);
        cb(null, parseJudgeCriteria(row && row.judge_criteria_json));
    });
}

function loadJudgeCriteriaForSubmission(db, submissionId, cb) {
    db.get(
        `SELECT cs.case_program_id, cp.judge_criteria_json
         FROM case_submissions cs
         LEFT JOIN case_programs cp ON cp.id = cs.case_program_id
         WHERE cs.id = ?`,
        [submissionId],
        (e, row) => {
            if (e) return cb(e);
            cb(null, parseJudgeCriteria(row && row.judge_criteria_json));
        }
    );
}

function generateCaseApplicationNo() {
    let id = '';
    for (let i = 0; i < 12; i++) id += Math.floor(Math.random() * 10).toString();
    return id;
}

function parseEnabledCategories(raw) {
    if (!raw) return [...CASE_CATEGORIES];
    try {
        const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!Array.isArray(arr)) return [...CASE_CATEGORIES];
        const mapped = arr.map((c) => String(c).toLowerCase());
        const out = mapped.filter((c) => CASE_CATEGORIES.includes(c));
        if (mapped.includes('agnikarma') && mapped.includes('viddhakarma') && !out.includes('both')) {
            out.push('both');
        }
        return out.length ? out : [...CASE_CATEGORIES];
    } catch (_) {
        return [...CASE_CATEGORIES];
    }
}

function parseCaseFormConfig(raw) {
    if (!raw) return { ...DEFAULT_CASE_FORM_CONFIG, fields: [...DEFAULT_CASE_FORM_CONFIG.fields] };
    try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (parsed && Array.isArray(parsed.fields) && parsed.fields.length) {
            return { version: parsed.version || 1, fields: parsed.fields };
        }
    } catch (_) {}
    return { ...DEFAULT_CASE_FORM_CONFIG, fields: [...DEFAULT_CASE_FORM_CONFIG.fields] };
}

function enrichCaseProgram(row, extra) {
    if (!row) return null;
    const enabledCategories = parseEnabledCategories(row.enabled_categories);
    const formConfig = parseCaseFormConfig(row.form_config_json);
    const catField = formConfig.fields.find((f) => f.key === 'category');
    if (catField) {
        const hasAgni = enabledCategories.includes('agnikarma');
        const hasViddhi = enabledCategories.includes('viddhakarma');
        const opts = [];
        if (hasAgni) opts.push({ value: 'agnikarma', label: CASE_CATEGORY_LABELS.agnikarma });
        if (hasViddhi) opts.push({ value: 'viddhakarma', label: CASE_CATEGORY_LABELS.viddhakarma });
        if (hasAgni && hasViddhi) opts.push({ value: 'both', label: CASE_CATEGORY_LABELS.both });
        catField.options = opts.length ? opts : enabledCategories.map((c) => ({ value: c, label: CASE_CATEGORY_LABELS[c] || c }));
    }
    const judgeCriteria = parseJudgeCriteria(row.judge_criteria_json);
    return {
        ...row,
        enabledCategories,
        formConfig,
        judgeCriteria,
        criteriaTotalMax: totalMaxFromCriteria(judgeCriteria),
        maxPresentationsPerUser:
            row.max_presentations_per_user != null ? row.max_presentations_per_user : 2,
        maxTotalSubmissions: row.max_total_submissions != null ? row.max_total_submissions : null,
        maxFilesPerSubmission: row.max_files_per_submission != null ? row.max_files_per_submission : 5,
        maxFileSizeMb: row.max_file_size_mb != null ? row.max_file_size_mb : 100,
        showSeatsPublic: row.show_seats_public == null || Number(row.show_seats_public) !== 0,
        ...(extra || {})
    };
}

function programBodyToRow(b) {
    const title = (b.title || '').trim();
    const enabledCategories = Array.isArray(b.enabledCategories)
        ? b.enabledCategories.filter((c) => CASE_CATEGORIES.includes(String(c).toLowerCase()))
        : parseEnabledCategories(b.enabledCategories);
    const formConfig =
        b.formConfig && Array.isArray(b.formConfig.fields) ? b.formConfig : parseCaseFormConfig(b.formConfig);
    const judgeCriteria = parseJudgeCriteria(
        b.judgeCriteria != null ? b.judgeCriteria : b.judgeCriteriaJson != null ? b.judgeCriteriaJson : null
    );
    return {
        title,
        description: (b.description || '').trim() || null,
        instructions: (b.instructions || '').trim() || null,
        seminarId:
            b.seminarId != null && String(b.seminarId).trim() !== ''
                ? parseInt(b.seminarId, 10)
                : null,
        registrationStart: seminarDt.normalizeSeminarDateTimeForStorage(b.registrationStart),
        registrationEnd: seminarDt.normalizeSeminarDateTimeForStorage(b.registrationEnd),
        isActive: b.isActive === false ? 0 : 1,
        maxPresentationsPerUser: Math.max(1, parseInt(b.maxPresentationsPerUser, 10) || 2),
        maxTotalSubmissions:
            b.maxTotalSubmissions != null && String(b.maxTotalSubmissions).trim() !== ''
                ? Math.max(1, parseInt(b.maxTotalSubmissions, 10))
                : null,
        maxFilesPerSubmission: Math.max(1, Math.min(10, parseInt(b.maxFilesPerSubmission, 10) || 5)),
        maxFileSizeMb: Math.max(1, Math.min(250, parseInt(b.maxFileSizeMb, 10) || 100)),
        enabledCategoriesJson: JSON.stringify(
            enabledCategories.length ? enabledCategories : [...CASE_CATEGORIES]
        ),
        formConfigJson: JSON.stringify(formConfig),
        judgeCriteriaJson: JSON.stringify(judgeCriteria),
        showSeatsPublic: b.showSeatsPublic === false ? 0 : 1
    };
}

function validateCaseFormAgainstConfig(form, formConfig, enabledCategories) {
    const fields = (formConfig && formConfig.fields) || DEFAULT_CASE_FORM_CONFIG.fields;
    for (const f of fields) {
        if (!f.enabled) continue;
        if (f.key === 'files') continue;
        const val = form[f.key];
        if (f.required && (val === undefined || val === null || String(val).trim() === '')) {
            return `Please complete: ${f.label || f.key}`;
        }
    }
    const nameErr = validateRegistrationPersonNames({
        fname: form.fname,
        mname: form.mname,
        lname: form.lname
    });
    if (nameErr) return nameErr;
    if (form.email != null && String(form.email).trim() !== '') {
        const ev = contactValidation.validateEmail(form.email, 'Email');
        if (!ev.valid) return ev.message;
    }
    if (form.phone != null && String(form.phone).trim() !== '') {
        const pv = contactValidation.validatePhone(form.phone, 'Phone');
        if (!pv.valid) return pv.message;
    }
    if (form.whatsapp != null && String(form.whatsapp).trim() !== '') {
        const wv = contactValidation.validatePhone(form.whatsapp, 'WhatsApp');
        if (!wv.valid) return wv.message;
    }
    const cats = enabledCategories && enabledCategories.length ? enabledCategories : CASE_CATEGORIES;
    if (!cats.includes(form.category)) {
        return 'Select a valid category for this program';
    }
    const topicField = fields.find((f) => f.key === 'topic');
    if ((topicField == null || topicField.enabled !== false) && topicField?.required !== false && !form.topic) {
        return 'Case topic is required';
    }
    return null;
}

function caseWindowState(program) {
    const now = Date.now();
    const rs = seminarDt.parseSeminarMs(program.registration_start);
    const re = seminarDt.parseSeminarMs(program.registration_end);
    if (rs != null && !Number.isNaN(rs) && now < rs) return 'upcoming';
    if (re != null && !Number.isNaN(re) && now > re) return 'closed';
    return 'open';
}

function ensureCasePresentationSchema(db, ignoreErr, next) {
    db.serialize(() => {
        db.run(
            `CREATE TABLE IF NOT EXISTS case_programs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                description TEXT,
                seminar_id INTEGER,
                registration_start DATETIME,
                registration_end DATETIME,
                is_active INTEGER DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,
            (e0) => {
                ignoreErr(e0);
                const programAlters = [
                    `ALTER TABLE case_programs ADD COLUMN form_config_json TEXT`,
                    `ALTER TABLE case_programs ADD COLUMN max_presentations_per_user INTEGER DEFAULT 2`,
                    `ALTER TABLE case_programs ADD COLUMN max_total_submissions INTEGER`,
                    `ALTER TABLE case_programs ADD COLUMN max_files_per_submission INTEGER DEFAULT 5`,
                    `ALTER TABLE case_programs ADD COLUMN max_file_size_mb INTEGER DEFAULT 50`,
                    `ALTER TABLE case_programs ADD COLUMN enabled_categories TEXT`,
                    `ALTER TABLE case_programs ADD COLUMN instructions TEXT`,
                    `ALTER TABLE case_programs ADD COLUMN judge_criteria_json TEXT`,
                    `ALTER TABLE case_programs ADD COLUMN show_seats_public INTEGER DEFAULT 1`
                ];
                let pi = 0;
                const runProgramAlter = () => {
                    if (pi >= programAlters.length) {
                        runSubmissionAlters();
                        return;
                    }
                    db.run(programAlters[pi], (e) => {
                        ignoreErr(e);
                        pi++;
                        runProgramAlter();
                    });
                };
                const alters = [
                    `ALTER TABLE case_submissions ADD COLUMN application_no TEXT`,
                    `ALTER TABLE case_submissions ADD COLUMN case_program_id INTEGER`,
                    `ALTER TABLE case_submissions ADD COLUMN category TEXT`,
                    `ALTER TABLE case_submissions ADD COLUMN form_data TEXT`,
                    `ALTER TABLE case_submissions ADD COLUMN registration_id INTEGER`,
                    `ALTER TABLE case_submissions ADD COLUMN seminar_forward_skipped INTEGER DEFAULT 0`,
                    `ALTER TABLE case_submissions ADD COLUMN plagiarism_zero INTEGER DEFAULT 0`,
                    `ALTER TABLE case_judge_scores ADD COLUMN is_locked INTEGER DEFAULT 0`
                ];
                let i = 0;
                const runAlter = () => {
                    if (i >= alters.length) {
                        db.run(
                            `CREATE UNIQUE INDEX IF NOT EXISTS idx_case_user_program_cat
                             ON case_submissions(user_id, case_program_id, category)
                             WHERE case_program_id IS NOT NULL AND category IS NOT NULL`,
                            (eIdx) => {
                                ignoreErr(eIdx);
                                if (next) next();
                            }
                        );
                        return;
                    }
                    db.run(alters[i], (e) => {
                        ignoreErr(e);
                        i++;
                        runAlter();
                    });
                };
                const runSubmissionAlters = () => runAlter();
                runProgramAlter();
            }
        );
    });
}

function parseCaseFormBody(body) {
    let form = {};
    if (body.formData) {
        try {
            form = typeof body.formData === 'string' ? JSON.parse(body.formData) : body.formData;
        } catch (_) {
            form = {};
        }
    }
    return {
        fname: (form.fname || body.fname || '').trim(),
        mname: (form.mname || body.mname || '').trim(),
        lname: (form.lname || body.lname || '').trim(),
        email: (form.email || body.email || '').trim(),
        phone: (form.phone || body.phone || '').trim(),
        whatsapp: (form.whatsapp || body.whatsapp || '').trim(),
        topic: (form.topic || body.topic || body.title || '').trim(),
        category: String(form.category || body.category || '')
            .trim()
            .toLowerCase()
    };
}

function validateCaseForm(form, program) {
    if (program) {
        const cfg = parseCaseFormConfig(program.form_config_json);
        const cats = parseEnabledCategories(program.enabled_categories);
        return validateCaseFormAgainstConfig(form, cfg, cats);
    }
    return validateCaseFormAgainstConfig(form, DEFAULT_CASE_FORM_CONFIG, CASE_CATEGORIES);
}

const _caseRoutesApps = new WeakSet();

function resolveJudgeUserId(db, judgeUserId, judgeUserIdString, cb) {
    const n = parseInt(judgeUserId, 10);
    if (Number.isInteger(n) && n > 0) return cb(null, n);
    const s = String(judgeUserIdString || judgeUserId || '').trim();
    if (!s) return cb(new Error('judgeUserId required'));
    const asNum = parseInt(s, 10);
    db.get(
        `SELECT id FROM users WHERE user_id_string = ? OR id = ?`,
        [s, Number.isInteger(asNum) ? asNum : -1],
        (e, row) => {
            if (e) return cb(e);
            if (!row) return cb(new Error('Judge account not found'));
            cb(null, row.id);
        }
    );
}

function ensureCaseJudgeScoresLockedColumn(db, ignoreErr, next) {
    db.run(`ALTER TABLE case_judge_scores ADD COLUMN is_locked INTEGER DEFAULT 0`, (e) => {
        if (ignoreErr) ignoreErr(e);
        if (next) next();
    });
}

function registerCasePresentationRoutes(app, deps) {
    if (_caseRoutesApps.has(app)) return;
    _caseRoutesApps.add(app);
    const { db, upload, generateId, fileStore, uploadsDir } = deps;
    try {
        require('./case-upload-routes').registerCaseUploadRoutes(app, { db });
    } catch (uploadRouteErr) {
        console.warn('[case] upload routes:', uploadRouteErr.message);
    }
    const ignoreErr = (e) => {
        if (e && !/duplicate column/i.test(String(e.message))) console.warn('[case]', e.message);
    };
    ensureCaseJudgeScoresLockedColumn(db, ignoreErr);

    if (process.env.DATABASE_URL || process.env.POSTGRES_URL) {
        try {
            const extPg = require('./extended-schema-pg');
            const pgDb = require('./db-pg');
            extPg
                .ensureCaseProgramsColumns(pgDb.queryWithRetry, (err) => {
                    const msg = String(err && err.message ? err.message : err);
                    return msg.includes('duplicate column') || msg.includes('already exists');
                })
                .catch((e) => console.warn('[case] PostgreSQL column migration:', e.message));
        } catch (_) {}
    }

    app.get('/api/case/programs', (req, res) => {
        db.all(
            `SELECT cp.*, s.title AS seminar_title,
                    (SELECT COUNT(*) FROM case_submissions cs WHERE cs.case_program_id = cp.id AND cs.status NOT IN ('cancelled')) AS submission_count
             FROM case_programs cp
             LEFT JOIN seminars s ON s.id = cp.seminar_id
             WHERE IFNULL(cp.is_active, 1) = 1
             ORDER BY COALESCE(cp.registration_start, cp.created_at) DESC`,
            [],
            (e, rows) => {
                if (e) return res.status(500).json({ error: e.message });
                const out = (rows || []).map((p) => {
                    const enriched = enrichCaseProgram(p);
                    const win = caseWindowState(p);
                    return {
                        ...enriched,
                        windowState: win,
                        registration_start: p.registration_start,
                        registration_end: p.registration_end,
                        slotsRemaining:
                            enriched.showSeatsPublic && enriched.maxTotalSubmissions != null
                                ? Math.max(0, enriched.maxTotalSubmissions - (p.submission_count || 0))
                                : null
                    };
                });
                res.json(out);
            }
        );
    });

    app.get('/api/case/programs/:id', (req, res) => {
        const id = parseInt(req.params.id, 10);
        db.get(
            `SELECT cp.*, s.title AS seminar_title,
                    (SELECT COUNT(*) FROM case_submissions cs WHERE cs.case_program_id = cp.id AND cs.status NOT IN ('cancelled')) AS submission_count
             FROM case_programs cp
             LEFT JOIN seminars s ON s.id = cp.seminar_id
             WHERE cp.id = ? AND IFNULL(cp.is_active, 1) = 1`,
            [id],
            (e, row) => {
                if (e) return res.status(500).json({ error: e.message });
                if (!row) return res.status(404).json({ error: 'Program not found' });
                const enriched = enrichCaseProgram(row, {
                    submissionCount: row.submission_count || 0
                });
                res.json({
                    ...enriched,
                    windowState: caseWindowState(row),
                    slotsRemaining:
                        enriched.showSeatsPublic && enriched.maxTotalSubmissions != null
                            ? Math.max(0, enriched.maxTotalSubmissions - (row.submission_count || 0))
                            : null
                });
            }
        );
    });

    app.get('/api/case/prefill/:userId', (req, res) => {
        const uid = parseInt(req.params.userId, 10);
        const seminarId = req.query.seminarId ? parseInt(req.query.seminarId, 10) : null;
        let sql = `SELECT r.form_data, r.seminar_id, u.first_name, u.middle_name, u.last_name, u.email, u.phone
                   FROM registrations r
                   JOIN users u ON u.id = r.user_id
                   WHERE r.user_id = ? AND r.status NOT IN ('cancelled','rejected')`;
        const params = [uid];
        if (seminarId) {
            sql += ` AND r.seminar_id = ?`;
            params.push(seminarId);
        }
        sql += ` ORDER BY r.id DESC LIMIT 1`;
        db.get(sql, params, (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!row) {
                db.get(`SELECT first_name, middle_name, last_name, email, phone FROM users WHERE id = ?`, [uid], (e2, u) => {
                    if (e2) return res.status(500).json({ error: e2.message });
                    res.json({
                        fname: u?.first_name || '',
                        mname: u?.middle_name || '',
                        lname: u?.last_name || '',
                        email: u?.email || '',
                        phone: u?.phone || '',
                        whatsapp: u?.phone || '',
                        fromRegistration: false
                    });
                });
                return;
            }
            let fd = {};
            try {
                fd = row.form_data ? JSON.parse(row.form_data) : {};
            } catch (_) {}
            res.json({
                fname: fd.fname || row.first_name || '',
                mname: fd.mname || row.middle_name || '',
                lname: fd.lname || row.last_name || '',
                email: fd.email || row.email || '',
                phone: fd.phone || row.phone || '',
                whatsapp: fd.whatsapp || fd.phone || row.phone || '',
                fromRegistration: true,
                seminarId: row.seminar_id
            });
        });
    });

    app.post('/api/case/submit', (req, res) => {
        const handleSubmit = (req, res, files, r2UploadIds) => {
            const body = req.body || {};
            const userId = parseInt(body.userId, 10);
            const programId = parseInt(body.caseProgramId, 10);
            if (!Number.isInteger(userId)) {
                return res.status(400).json({ error: 'userId required — please sign in again to the doctor portal' });
            }
            if (!Number.isInteger(programId)) {
                return res.status(400).json({ error: 'caseProgramId required' });
            }

            db.get(`SELECT * FROM case_programs WHERE id = ? AND IFNULL(is_active, 1) = 1`, [programId], (e0, program) => {
                if (e0) return res.status(500).json({ error: e0.message });
                if (!program) return res.status(404).json({ error: 'Case program not found' });
                const maxFiles = Math.max(1, Math.min(10, program.max_files_per_submission || 5));
                const form = parseCaseFormBody(body);
                const vErr = validateCaseForm(form, program);
                if (vErr) return res.status(400).json({ error: vErr });

                const multerFiles = files || [];
                const pendingIds = r2UploadIds || [];
                const useR2 = pendingIds.length > 0;
                const fileFieldRequired = (parseCaseFormConfig(program.form_config_json).fields || []).find(
                    (f) => f.key === 'files' && f.enabled !== false
                );
                if (fileFieldRequired && fileFieldRequired.required !== false && !multerFiles.length && !pendingIds.length) {
                    return res.status(400).json({ error: 'Upload at least one file (PPT, PDF, or video)' });
                }
                if (multerFiles.length + pendingIds.length > maxFiles) {
                    return res.status(400).json({ error: `Maximum ${maxFiles} files allowed` });
                }
                const uploadLimits = require('./upload-limits');
                const caseFileTypes = require('./case-file-types');
                const maxMb = uploadLimits.getEffectiveMaxFileMb(program.max_file_size_mb || 100);
                for (const f of multerFiles) {
                    const tc = caseFileTypes.isAllowedCaseFile(f.originalname, f.mimetype);
                    if (!tc.ok) return res.status(400).json({ error: tc.error });
                    const sc = uploadLimits.validateFileSizeBytes(f.size, program.max_file_size_mb);
                    if (!sc.ok) return res.status(400).json({ error: sc.error });
                }
                if (useR2 && !uploadLimits.isR2Mode()) {
                    return res.status(400).json({
                        error: 'Large file storage (R2) is not configured on the server. Contact the administrator.'
                    });
                }

                const proceedAfterCapacity = () => {
                db.get(
                    `SELECT id FROM case_submissions WHERE user_id = ? AND case_program_id = ? AND category = ? AND status != 'priority_invited'`,
                    [userId, programId, form.category],
                    (eDup, dup) => {
                        if (eDup) return res.status(500).json({ error: eDup.message });
                        if (dup) {
                            return res.status(400).json({
                                error: `You already submitted for ${form.category} in this program. Each category allows one submission.`
                            });
                        }

                        const maxPerUser = program.max_presentations_per_user || 2;
                        db.get(
                            `SELECT COUNT(*) AS c FROM case_submissions WHERE user_id = ? AND case_program_id = ? AND status NOT IN ('cancelled')`,
                            [userId, programId],
                            (eCnt, cntRow) => {
                                if (eCnt) return res.status(500).json({ error: eCnt.message });
                                if ((cntRow?.c || 0) >= maxPerUser) {
                                    return res.status(400).json({
                                        error: `You reached the limit of ${maxPerUser} presentation(s) for this program.`
                                    });
                                }

                        const seminarId = program.seminar_id || null;
                        const linkReg = (regId, cb) => {
                            const appNo = generateCaseApplicationNo();
                            const formJson = JSON.stringify(form);
                            db.run(
                                `INSERT INTO case_submissions (
                                    user_id, seminar_id, case_program_id, application_no, category, title,
                                    form_data, registration_id, status, updated_at
                                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'submitted', CURRENT_TIMESTAMP)`,
                                [
                                    userId,
                                    seminarId,
                                    programId,
                                    appNo,
                                    form.category,
                                    form.topic,
                                    formJson,
                                    regId
                                ],
                                function (insErr) {
                                    if (insErr) return res.status(500).json({ error: insErr.message });
                                    const subId = this.lastID;
                                    const finishSubmission = (paths, r2Uploads) => {
                                        const r2List = r2Uploads || [];
                                        const totalFiles = multerFiles.length + r2List.length;
                                        if (!totalFiles) {
                                            portalTracking.logCaseEvent(
                                                db,
                                                subId,
                                                'submitted',
                                                'Application submitted',
                                                'Case application submitted.',
                                                () => {}
                                            );
                                            return res.json({
                                                success: true,
                                                submissionId: subId,
                                                applicationNo: appNo
                                            });
                                        }
                                        const afterAllFiles = (fErr) => {
                                            if (fErr) return res.status(500).json({ error: fErr.message || fErr });
                                            portalTracking.logCaseEvent(
                                                db,
                                                subId,
                                                'submitted',
                                                'Application submitted',
                                                'Case files uploaded.',
                                                () => {}
                                            );
                                            res.json({
                                                success: true,
                                                submissionId: subId,
                                                applicationNo: appNo
                                            });
                                        };
                                        const insertMulter = (done) => {
                                            if (!multerFiles.length) return done(null);
                                            let fi = 0;
                                            let fErr = null;
                                            multerFiles.forEach((f, idx) => {
                                                const filePath = (paths && paths[idx]) || '/uploads/' + f.filename;
                                                db.run(
                                                    `INSERT INTO case_files (submission_id, file_path, original_name, mime_type, size_bytes, sort_order) VALUES (?, ?, ?, ?, ?, ?)`,
                                                    [subId, filePath, f.originalname, f.mimetype, f.size, idx],
                                                    (fe) => {
                                                        if (fe && !fErr) fErr = fe;
                                                        fi++;
                                                        if (fi === multerFiles.length) done(fErr);
                                                    }
                                                );
                                            });
                                        };
                                        const insertR2 = (done) => {
                                            if (!r2List.length) return done(null);
                                            const caseUploadRoutes = require('./case-upload-routes');
                                            caseUploadRoutes.insertCaseFilesFromR2(db, subId, r2List, multerFiles.length, done);
                                        };
                                        insertMulter((err1) => {
                                            if (err1) return afterAllFiles(err1);
                                            insertR2(afterAllFiles);
                                        });
                                    };
                                    const finishWithR2 = (r2Uploads) => {
                                        if (!multerFiles.length) return finishSubmission([], r2Uploads);
                                        if (!fileStore || !uploadsDir) return finishSubmission([], r2Uploads);
                                        fileStore.persistMulterFiles(db, multerFiles, uploadsDir, (pErr, paths) => {
                                            if (pErr) return res.status(500).json({ error: pErr.message });
                                            finishSubmission(paths || [], r2Uploads);
                                        });
                                    };
                                    if (!pendingIds.length) {
                                        return finishWithR2([]);
                                    }
                                    const caseUploadRoutes = require('./case-upload-routes');
                                    caseUploadRoutes.attachPendingUploads(db, userId, programId, pendingIds, (attErr, r2Uploads) => {
                                        if (attErr) return res.status(400).json({ error: attErr.message });
                                        finishWithR2(r2Uploads);
                                    });
                                }
                            );
                        };

                        if (!seminarId) return linkReg(null);
                        db.get(
                            `SELECT id FROM registrations WHERE user_id = ? AND seminar_id = ? AND status NOT IN ('cancelled','rejected') ORDER BY id DESC LIMIT 1`,
                            [userId, seminarId],
                            (eR, reg) => linkReg(reg ? reg.id : null)
                        );
                            }
                        );
                    }
                );
                };

                const runCapacityOrPriority = () => {
                    db.get(
                        `SELECT id, application_no FROM case_submissions
                         WHERE user_id = ? AND case_program_id = ? AND status = 'priority_invited' LIMIT 1`,
                        [userId, programId],
                        (ePri, priRow) => {
                            if (ePri) return res.status(500).json({ error: ePri.message });
                            if (priRow) {
                                const subId = priRow.id;
                                const appNo = priRow.application_no;
                                db.get(
                                    `SELECT COUNT(*) AS c FROM case_files WHERE submission_id = ?`,
                                    [subId],
                                    (eFc, fcRow) => {
                                        if (eFc) return res.status(500).json({ error: eFc.message });
                                        const existingFiles = fcRow?.c || 0;
                                        if (
                                            fileFieldRequired &&
                                            fileFieldRequired.required !== false &&
                                            !multerFiles.length &&
                                            !pendingIds.length &&
                                            existingFiles < 1
                                        ) {
                                            return res.status(400).json({
                                                error: 'Upload at least one file (PPT, PDF, or video)'
                                            });
                                        }
                                        const formJson = JSON.stringify(form);
                                        db.run(
                                            `UPDATE case_submissions SET category = ?, title = ?, form_data = ?, status = 'under_review', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                                            [form.category, form.topic, formJson, subId],
                                            (uErr) => {
                                                if (uErr) return res.status(500).json({ error: uErr.message });
                                                const respondPriority = () => {
                                                    portalTracking.logCaseEvent(
                                                        db,
                                                        subId,
                                                        'submitted',
                                                        'Priority application completed',
                                                        'Application submitted for priority review.',
                                                        () =>
                                                            res.json({
                                                                success: true,
                                                                submissionId: subId,
                                                                applicationNo: appNo,
                                                                priorityReview: true
                                                            })
                                                    );
                                                };
                                                const attachPriorityFiles = (paths, r2List) => {
                                                    const r2Arr = r2List || [];
                                                    if (!multerFiles.length && !r2Arr.length) {
                                                        return respondPriority();
                                                    }
                                                    const fileStore = require('./file-store');
                                                    const uploadsDir = require('path').join(
                                                        __dirname,
                                                        '..',
                                                        'uploads'
                                                    );
                                                    const afterFiles = (fErr) => {
                                                        if (fErr) {
                                                            return res.status(500).json({
                                                                error: fErr.message || fErr
                                                            });
                                                        }
                                                        respondPriority();
                                                    };
                                                    const insertMulter = (done) => {
                                                        if (!multerFiles.length) return done(null);
                                                        let fi = 0;
                                                        let fErr = null;
                                                        multerFiles.forEach((f, idx) => {
                                                            const filePath =
                                                                (paths && paths[idx]) || '/uploads/' + f.filename;
                                                            db.run(
                                                                `INSERT INTO case_files (submission_id, file_path, original_name, mime_type, size_bytes, sort_order) VALUES (?, ?, ?, ?, ?, ?)`,
                                                                [
                                                                    subId,
                                                                    filePath,
                                                                    f.originalname,
                                                                    f.mimetype,
                                                                    f.size,
                                                                    existingFiles + idx
                                                                ],
                                                                (fe) => {
                                                                    if (fe && !fErr) fErr = fe;
                                                                    fi++;
                                                                    if (fi === multerFiles.length) done(fErr);
                                                                }
                                                            );
                                                        });
                                                    };
                                                    const insertR2 = (done) => {
                                                        if (!r2Arr.length) return done(null);
                                                        const caseUploadRoutes = require('./case-upload-routes');
                                                        caseUploadRoutes.insertCaseFilesFromR2(
                                                            db,
                                                            subId,
                                                            r2Arr,
                                                            multerFiles.length + existingFiles,
                                                            done
                                                        );
                                                    };
                                                    insertMulter((err1) => {
                                                        if (err1) return afterFiles(err1);
                                                        insertR2(afterFiles);
                                                    });
                                                };
                                                if (!pendingIds.length) {
                                                    if (!multerFiles.length) return attachPriorityFiles([], []);
                                                    const fileStore = require('./file-store');
                                                    const uploadsDir = require('path').join(
                                                        __dirname,
                                                        '..',
                                                        'uploads'
                                                    );
                                                    fileStore.persistMulterFiles(
                                                        db,
                                                        multerFiles,
                                                        uploadsDir,
                                                        (pErr, paths) => {
                                                            if (pErr) {
                                                                return res.status(500).json({ error: pErr.message });
                                                            }
                                                            attachPriorityFiles(paths || [], []);
                                                        }
                                                    );
                                                    return;
                                                }
                                                const caseUploadRoutes = require('./case-upload-routes');
                                                caseUploadRoutes.attachPendingUploads(
                                                    db,
                                                    userId,
                                                    programId,
                                                    pendingIds,
                                                    (attErr, r2Uploads) => {
                                                        if (attErr) {
                                                            return res.status(400).json({ error: attErr.message });
                                                        }
                                                        if (!multerFiles.length) {
                                                            return attachPriorityFiles([], r2Uploads);
                                                        }
                                                        const fileStore = require('./file-store');
                                                        const uploadsDir = require('path').join(
                                                            __dirname,
                                                            '..',
                                                            'uploads'
                                                        );
                                                        fileStore.persistMulterFiles(
                                                            db,
                                                            multerFiles,
                                                            uploadsDir,
                                                            (pErr, paths) => {
                                                                if (pErr) {
                                                                    return res.status(500).json({
                                                                        error: pErr.message
                                                                    });
                                                                }
                                                                attachPriorityFiles(paths || [], r2Uploads);
                                                            }
                                                        );
                                                    }
                                                );
                                            }
                                        );
                                    }
                                );
                                return;
                            }
                            const win = caseWindowState(program);
                            if (win === 'upcoming') {
                                return res.status(400).json({ error: 'Applications are not open yet' });
                            }
                            if (win === 'closed') {
                                return res.status(400).json({ error: 'Application window has closed' });
                            }
                            if (program.max_total_submissions != null) {
                                db.get(
                                    `SELECT COUNT(*) AS c FROM case_submissions WHERE case_program_id = ? AND status NOT IN ('cancelled')`,
                                    [programId],
                                    (eCap, capRow) => {
                                        if (eCap) return res.status(500).json({ error: eCap.message });
                                        if ((capRow?.c || 0) >= program.max_total_submissions) {
                                            return res.status(400).json({
                                                error: 'This program has reached its maximum number of presentations.'
                                            });
                                        }
                                        proceedAfterCapacity();
                                    }
                                );
                            } else {
                                proceedAfterCapacity();
                            }
                        }
                    );
                };
                runCapacityOrPriority();
            });
        };
        let uploadIds = [];
        try {
            const rawIds = (req.body || {}).uploadedFileIds;
            if (rawIds) {
                uploadIds = typeof rawIds === 'string' ? JSON.parse(rawIds) : rawIds;
            }
        } catch (_) {
            uploadIds = [];
        }
        if (!Array.isArray(uploadIds)) uploadIds = [];
        const uploadLimitsMod = require('./upload-limits');
        if (uploadIds.length && uploadLimitsMod.isR2Mode()) {
            return handleSubmit(req, res, [], uploadIds);
        }
        upload.array('files', 10)(req, res, (uploadErr) => {
            if (uploadErr) {
                return res.status(400).json({ error: uploadErr.message || 'File upload failed' });
            }
            handleSubmit(req, res, req.files || [], []);
        });
    });

    app.get('/api/doctor/case/applications/:userId', (req, res) => {
        const uid = parseInt(req.params.userId, 10);
        db.all(
            `SELECT cs.*, cp.title AS program_title, cp.registration_start, cp.registration_end,
                    cp.portal_year AS program_portal_year,
                    s.title AS seminar_title, s.portal_year AS seminar_portal_year,
                    (SELECT COUNT(*) FROM case_files cf WHERE cf.submission_id = cs.id) AS file_count,
                    (SELECT COUNT(*) FROM case_judge_assignments cja WHERE cja.submission_id = cs.id) AS judge_count,
                    (SELECT COUNT(*) FROM case_judge_scores cjs WHERE cjs.submission_id = cs.id AND IFNULL(cjs.is_locked, 0) = 1) AS locked_score_count,
                    (SELECT AVG(total_score) FROM case_judge_scores WHERE submission_id = cs.id) AS avg_score
             FROM case_submissions cs
             LEFT JOIN case_programs cp ON cp.id = cs.case_program_id
             LEFT JOIN seminars s ON s.id = cs.seminar_id
             WHERE cs.user_id = ?
             ORDER BY cs.id DESC`,
            [uid],
            (e, rows) => {
                if (e) return res.status(500).json({ error: e.message });
                const mapped = (rows || []).map((r) => ({
                    ...r,
                    portal_year: r.program_portal_year || r.seminar_portal_year || null
                }));
                portalTracking.attachCaseTimelines(db, mapped, (e2, enriched) => {
                    const apps = e2 ? mapped : enriched || mapped;
                    portalTracking.getPortalYear(db, (e3, portalYear) => {
                        if (e3) return res.status(500).json({ error: e3.message });
                        res.json({ portalYear, applications: apps });
                    });
                });
            }
        );
    });

    app.get('/api/admin/case/default-form-config', (req, res) => {
        res.json(DEFAULT_CASE_FORM_CONFIG);
    });

    app.get('/api/admin/case/programs', (req, res) => {
        db.all(
            `SELECT cp.*, s.title AS seminar_title,
                    (SELECT COUNT(*) FROM case_submissions cs WHERE cs.case_program_id = cp.id AND cs.status NOT IN ('cancelled')) AS submission_count
             FROM case_programs cp
             LEFT JOIN seminars s ON s.id = cp.seminar_id ORDER BY cp.id DESC`,
            [],
            (e, rows) => {
                if (e) return res.status(500).json({ error: e.message });
                res.json((rows || []).map((r) => enrichCaseProgram(r, { submissionCount: r.submission_count || 0 })));
            }
        );
    });

    app.get('/api/admin/case/programs/:id', (req, res) => {
        const id = parseInt(req.params.id, 10);
        db.get(
            `SELECT cp.*, s.title AS seminar_title,
                    (SELECT COUNT(*) FROM case_submissions cs WHERE cs.case_program_id = cp.id AND cs.status NOT IN ('cancelled')) AS submission_count
             FROM case_programs cp
             LEFT JOIN seminars s ON s.id = cp.seminar_id WHERE cp.id = ?`,
            [id],
            (e, row) => {
                if (e) return res.status(500).json({ error: e.message });
                if (!row) return res.status(404).json({ error: 'Not found' });
                res.json(enrichCaseProgram(row, { submissionCount: row.submission_count || 0 }));
            }
        );
    });

    app.post('/api/admin/case/programs', (req, res) => {
        const row = programBodyToRow(req.body || {});
        if (!row.title) return res.status(400).json({ error: 'Title is required' });
        db.run(
            `INSERT INTO case_programs (
                title, description, instructions, seminar_id, registration_start, registration_end, is_active,
                max_presentations_per_user, max_total_submissions, max_files_per_submission, max_file_size_mb,
                enabled_categories, form_config_json, judge_criteria_json, show_seats_public
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                row.title,
                row.description,
                row.instructions,
                row.seminarId,
                row.registrationStart,
                row.registrationEnd,
                row.isActive,
                row.maxPresentationsPerUser,
                row.maxTotalSubmissions,
                row.maxFilesPerSubmission,
                row.maxFileSizeMb,
                row.enabledCategoriesJson,
                row.formConfigJson,
                row.judgeCriteriaJson,
                row.showSeatsPublic
            ],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true, id: this.lastID });
            }
        );
    });

    app.put('/api/admin/case/programs/:id', (req, res) => {
        const id = parseInt(req.params.id, 10);
        const row = programBodyToRow(req.body || {});
        if (!row.title) return res.status(400).json({ error: 'Title is required' });
        db.run(
            `UPDATE case_programs SET
                title=?, description=?, instructions=?, seminar_id=?, registration_start=?, registration_end=?, is_active=?,
                max_presentations_per_user=?, max_total_submissions=?, max_files_per_submission=?, max_file_size_mb=?,
                enabled_categories=?, form_config_json=?, judge_criteria_json=?, show_seats_public=?
             WHERE id=?`,
            [
                row.title,
                row.description,
                row.instructions,
                row.seminarId,
                row.registrationStart,
                row.registrationEnd,
                row.isActive,
                row.maxPresentationsPerUser,
                row.maxTotalSubmissions,
                row.maxFilesPerSubmission,
                row.maxFileSizeMb,
                row.enabledCategoriesJson,
                row.formConfigJson,
                row.judgeCriteriaJson,
                row.showSeatsPublic,
                id
            ],
            (err) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true });
            }
        );
    });

    app.delete('/api/admin/case/programs/:id', (req, res) => {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid program id' });
        const permanent = String((req.query && req.query.permanent) || '') === '1';
        db.get(`SELECT COUNT(*) AS c FROM case_submissions WHERE case_program_id = ?`, [id], (e0, row) => {
            if (e0) return res.status(500).json({ error: e0.message });
            const subCount = row && row.c != null ? Number(row.c) : 0;
            if (subCount > 0 && !permanent) {
                db.run(`UPDATE case_programs SET is_active = 0 WHERE id = ?`, [id], function (e1) {
                    if (e1) return res.status(500).json({ error: e1.message });
                    if (!this.changes) return res.status(404).json({ error: 'Program not found' });
                    res.json({
                        success: true,
                        deactivated: true,
                        message: 'Program has submissions — marked inactive. Use ?permanent=1 to delete all data.'
                    });
                });
                return;
            }
            const removeProgram = () => {
                db.run(`DELETE FROM case_programs WHERE id = ?`, [id], function (eDel) {
                    if (eDel) return res.status(500).json({ error: eDel.message });
                    if (!this.changes) return res.status(404).json({ error: 'Program not found' });
                    res.json({ success: true, deleted: true });
                });
            };
            if (subCount === 0) return removeProgram();
            db.all(`SELECT id FROM case_submissions WHERE case_program_id = ?`, [id], (e2, subs) => {
                if (e2) return res.status(500).json({ error: e2.message });
                let i = 0;
                const nextSub = () => {
                    if (i >= (subs || []).length) return removeProgram();
                    const subId = subs[i].id;
                    db.run(`DELETE FROM case_judge_scores WHERE submission_id = ?`, [subId], () => {
                        db.run(`DELETE FROM case_judge_assignments WHERE submission_id = ?`, [subId], () => {
                            db.run(`DELETE FROM case_status_log WHERE submission_id = ?`, [subId], () => {
                                db.run(`DELETE FROM case_files WHERE submission_id = ?`, [subId], () => {
                                    db.run(`DELETE FROM case_submissions WHERE id = ?`, [subId], () => {
                                        i++;
                                        nextSub();
                                    });
                                });
                            });
                        });
                    });
                };
                nextSub();
            });
        });
    });

    app.delete('/api/admin/case/submissions/:id', (req, res) => {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid submission id' });
        db.run(`DELETE FROM case_judge_scores WHERE submission_id = ?`, [id], () => {
            db.run(`DELETE FROM case_judge_assignments WHERE submission_id = ?`, [id], () => {
                db.run(`DELETE FROM case_status_log WHERE submission_id = ?`, [id], () => {
                    db.run(`DELETE FROM case_files WHERE submission_id = ?`, [id], () => {
                        db.run(`DELETE FROM case_submissions WHERE id = ?`, [id], function (e) {
                            if (e) return res.status(500).json({ error: e.message });
                            if (!this.changes) return res.status(404).json({ error: 'Submission not found' });
                            res.json({ success: true });
                        });
                    });
                });
            });
        });
    });

    app.get('/api/admin/case/reviewers', (req, res) => {
        db.all(
            `SELECT id, user_id_string, first_name, last_name, email, role, user_role
             FROM users
             WHERE LOWER(COALESCE(user_role,'')) IN ('judge','reviewer','judge_user')
                OR LOWER(COALESCE(role,'')) IN ('judge','reviewer')
             ORDER BY last_name, first_name`,
            [],
            (e, rows) => {
                if (e) return res.status(500).json({ error: e.message });
                res.json(rows || []);
            }
        );
    });

    app.post('/api/admin/case/submissions/:id/mark-plagiarism', (req, res) => {
        const id = parseInt(req.params.id, 10);
        const { reason } = req.body || {};
        db.run(
            `UPDATE case_submissions SET plagiarism_zero = 1, status = 'disqualified', admin_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [reason || 'Duplicate / copied submission — zero marks', id],
            (e) => {
                if (e) return res.status(500).json({ error: e.message });
                portalTracking.logCaseEvent(
                    db,
                    id,
                    'disqualified',
                    'Disqualified',
                    reason || 'Duplicate / copied submission.',
                    () => {}
                );
                db.run(
                    `UPDATE case_judge_scores SET total_score = 0, criteria_json = ?, is_locked = 1 WHERE submission_id = ?`,
                    [
                        JSON.stringify(
                            CASE_JUDGE_CRITERIA.map((c) => ({ key: c.key, label: c.label, score: 0, max: c.maxMarks }))
                        ),
                        id
                    ],
                    () => res.json({ success: true })
                );
            }
        );
    });

    app.post('/api/admin/case/programs/:programId/priority-invite', (req, res) => {
        const programId = parseInt(req.params.programId, 10);
        const body = req.body || {};
        const userRef = body.userRef != null ? String(body.userRef).trim() : String(body.userIdString || body.userId || '').trim();
        const category = body.category || 'agnikarma';
        const adminUserId = parseInt(body.actingAdminId || body.adminUserId, 10) || null;
        if (!Number.isInteger(programId)) return res.status(400).json({ error: 'Invalid program id' });
        if (!userRef) return res.status(400).json({ error: 'Doctor portal ID or email required' });

        const resolveUser = (cb) => {
            if (userRef.includes('@')) {
                return db.get(
                    `SELECT id FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM(?)) LIMIT 1`,
                    [userRef],
                    (e, row) => cb(e, row && row.id)
                );
            }
            const num = parseInt(userRef, 10);
            if (Number.isInteger(num) && num > 0) {
                return db.get(`SELECT id FROM users WHERE id = ?`, [num], (e, row) => cb(e, row && row.id));
            }
            return db.get(
                `SELECT id FROM users WHERE TRIM(user_id_string) = TRIM(?) LIMIT 1`,
                [userRef],
                (e, row) => cb(e, row && row.id)
            );
        };

        resolveUser((eU, uid) => {
            if (eU) return res.status(500).json({ error: eU.message });
            if (!uid) return res.status(404).json({ error: 'Doctor not found' });
            casePriorityInvite.createPriorityInvitation(
                db,
                { programId, userId: uid, category, adminUserId },
                (err, out) => {
                    if (err) return res.status(400).json({ error: err.message });
                    res.json({
                        success: true,
                        message:
                            'Priority application created. Doctor will complete missing details in the portal (fast-track review).',
                        submissionId: out.submissionId,
                        applicationNo: out.applicationNo
                    });
                }
            );
        });
    });

    app.post('/api/admin/case/submissions/:id/select-winner', (req, res) => {
        const id = parseInt(req.params.id, 10);
        db.get(`SELECT * FROM case_submissions WHERE id = ?`, [id], (e, sub) => {
            if (e) return res.status(500).json({ error: e.message });
            if (!sub) return res.status(404).json({ error: 'Not found' });
            const seminarId = sub.seminar_id;
            if (!seminarId) {
                return db.run(
                    `UPDATE case_submissions SET status = 'selected', winner_flag = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                    [id],
                    () => {
                        portalTracking.logCaseEvent(db, id, 'selected', 'Selected', 'Marked as winner.', () => {});
                        res.json({ success: true, message: 'Case marked as winner (no linked seminar).' });
                    }
                );
            }
            db.get(
                `SELECT id, status FROM registrations WHERE user_id = ? AND seminar_id = ? AND status NOT IN ('cancelled','rejected') ORDER BY id DESC LIMIT 1`,
                [sub.user_id, seminarId],
                (e2, reg) => {
                    if (reg) {
                        db.run(
                            `UPDATE case_submissions SET status = 'selected', winner_flag = 1, seminar_forward_skipped = 1, registration_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                            [reg.id, id],
                            () => {
                                portalTracking.logCaseEvent(db, id, 'selected', 'Selected', 'Marked as winner.', () => {});
                                res.json({
                                    success: true,
                                    message:
                                        'Winner selected. Doctor already registered for seminar — only case track updated (seminar registration unchanged).'
                                });
                            }
                        );
                    } else {
                        db.run(
                            `UPDATE case_submissions SET status = 'selected', winner_flag = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                            [id],
                            () => {
                                portalTracking.logCaseEvent(db, id, 'selected', 'Selected', 'Marked as winner.', () => {});
                                res.json({
                                    success: true,
                                    message:
                                        'Winner selected. Doctor may register for the linked seminar with priority (registration window override can be applied).'
                                });
                            }
                        );
                    }
                }
            );
        });
    });

    app.get('/api/judge/case/reviewers', (req, res) => {
        resolveJudgeUserId(db, req.query.judgeUserId, req.query.judgeUserIdString, (eJ, jid) => {
            if (eJ) return res.status(400).json({ error: eJ.message });
            db.all(
                `SELECT id, user_id_string, first_name, last_name, email, role, user_role
                 FROM users
                 WHERE LOWER(COALESCE(user_role,'')) IN ('judge','reviewer','judge_user')
                    OR LOWER(COALESCE(role,'')) IN ('judge','reviewer')
                 ORDER BY last_name, first_name`,
                [],
                (e, rows) => {
                    if (e) return res.status(500).json({ error: e.message });
                    const judges = (rows || [])
                        .filter((r) => r.id !== jid)
                        .map((r) => ({
                            id: r.id,
                            user_id_string: r.user_id_string,
                            name: [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || 'Judge'
                        }));
                    res.json({ judges });
                }
            );
        });
    });

    app.get('/api/judge/case/criteria', (req, res) => {
        const programId = req.query && req.query.programId ? parseInt(req.query.programId, 10) : null;
        if (Number.isInteger(programId) && programId > 0) {
            return loadJudgeCriteriaForProgram(db, programId, (err, criteria) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ criteria, totalMax: totalMaxFromCriteria(criteria) });
            });
        }
        const criteria = parseJudgeCriteria(null);
        res.json({ criteria, totalMax: totalMaxFromCriteria(criteria) });
    });

    app.get('/api/judge/case-assignments', (req, res) => {
        resolveJudgeUserId(db, req.query.judgeUserId, req.query.judgeUserIdString, (eJ, jid) => {
            if (eJ) return res.status(400).json({ error: eJ.message });
        db.all(
            `SELECT cs.*, u.user_id_string, u.first_name, u.last_name, cja.assigned_at,
                    cp.title AS program_title,
                    (SELECT IFNULL(is_locked, 0) FROM case_judge_scores WHERE submission_id = cs.id AND judge_user_id = ?) AS my_score_locked,
                    (SELECT total_score FROM case_judge_scores WHERE submission_id = cs.id AND judge_user_id = ?) AS my_total_score
             FROM case_judge_assignments cja
             JOIN case_submissions cs ON cs.id = cja.submission_id
             JOIN users u ON u.id = cs.user_id
             LEFT JOIN case_programs cp ON cp.id = cs.case_program_id
             WHERE cja.judge_user_id = ? AND cs.status IN ('judging','judged','selected','approved_for_judging','submitted','under_review','priority_invited')`,
            [jid, jid, jid],
            (e, rows) => {
                if (e) return res.status(500).json({ error: e.message });
                res.json(rows || []);
            }
        );
        });
    });

    app.get('/api/judge/case/submissions/:id/detail', (req, res) => {
        const sid = parseInt(req.params.id, 10);
        if (!Number.isInteger(sid)) return res.status(400).json({ error: 'Invalid submission id' });
        resolveJudgeUserId(db, req.query.judgeUserId, req.query.judgeUserIdString, (eJ, jid) => {
            if (eJ) return res.status(400).json({ error: eJ.message });
            db.get(
                `SELECT 1 FROM case_judge_assignments WHERE submission_id = ? AND judge_user_id = ?`,
                [sid, jid],
                (eA, assigned) => {
                    if (eA) return res.status(500).json({ error: eA.message });
                    if (!assigned) return res.status(403).json({ error: 'You are not assigned to this submission' });
        db.get(
            `SELECT cs.*, u.user_id_string, u.first_name, u.last_name, u.email AS account_email, u.phone AS account_phone
             FROM case_submissions cs JOIN users u ON u.id = cs.user_id WHERE cs.id = ?`,
            [sid],
            (e, sub) => {
                if (e) return res.status(500).json({ error: e.message });
                if (!sub) return res.status(404).json({ error: 'Not found' });
                db.all(`SELECT * FROM case_files WHERE submission_id = ? ORDER BY sort_order`, [sid], async (e2, files) => {
                    if (e2) return res.status(500).json({ error: e2.message });
                    loadJudgeCriteriaForSubmission(db, sid, async (eCrit, criteriaDefs) => {
                        if (eCrit) return res.status(500).json({ error: eCrit.message });
                        db.get(
                            `SELECT * FROM case_judge_scores WHERE submission_id = ? AND judge_user_id = ?`,
                            [sid, jid],
                            async (e3, score) => {
                                if (e3) return res.status(500).json({ error: e3.message });
                                const caseFileAccess = require('./case-file-access');
                                let enrichedFiles = files || [];
                                try {
                                    enrichedFiles = await caseFileAccess.enrichCaseFiles(files, {
                                        expiresSec: 7200
                                    });
                                } catch (enrichErr) {
                                    console.warn('[judge] file URLs:', enrichErr.message);
                                }
                                const participant = judgeContact.parseParticipantFromSubmission(sub, {
                                    email: sub.account_email,
                                    phone: sub.account_phone
                                });
                                res.json({
                                    submission: sub,
                                    participant,
                                    files: enrichedFiles,
                                    myScore: score || null,
                                    criteria: criteriaDefs,
                                    totalMax: totalMaxFromCriteria(criteriaDefs)
                                });
                            }
                        );
                    });
                });
            }
        );
                }
            );
        });
    });

    app.post('/api/judge/case/score', (req, res) => {
        const { judgeUserId, judgeUserIdString, submissionId, criteria, remarks } = req.body || {};
        const sid = parseInt(submissionId, 10);
        if (!Number.isInteger(sid)) {
            return res.status(400).json({ error: 'submissionId required' });
        }
        resolveJudgeUserId(db, judgeUserId, judgeUserIdString, (eJ, jid) => {
            if (eJ) return res.status(400).json({ error: eJ.message });
        db.get(
            `SELECT 1 FROM case_judge_assignments WHERE submission_id = ? AND judge_user_id = ?`,
            [sid, jid],
            (e0, assigned) => {
                if (e0) return res.status(500).json({ error: e0.message });
                if (!assigned) return res.status(403).json({ error: 'You are not assigned to this submission' });
                db.get(
                    `SELECT plagiarism_zero FROM case_submissions cs WHERE cs.id = ?`,
                    [sid],
                    (e1, sub) => {
                        if (e1) return res.status(500).json({ error: e1.message });
                        if (sub && sub.plagiarism_zero) {
                            return res.status(400).json({ error: 'Submission disqualified (plagiarism/duplicate)' });
                        }
                        db.get(
                            `SELECT id, IFNULL(is_locked, 0) AS is_locked FROM case_judge_scores WHERE submission_id = ? AND judge_user_id = ?`,
                            [sid, jid],
                            (e2, scoreRow) => {
                                if (e2) return res.status(500).json({ error: e2.message });
                                if (scoreRow && scoreRow.is_locked) {
                                    return res.status(400).json({
                                        error: 'Scores are locked and cannot be changed'
                                    });
                                }
                                loadJudgeCriteriaForSubmission(db, sid, (eCrit, criteriaDefs) => {
                                    if (eCrit) return res.status(500).json({ error: eCrit.message });
                                    const norm = normalizeSubmittedCriteria(
                                        criteriaDefs,
                                        Array.isArray(criteria) ? criteria : []
                                    );
                                    const crit = norm.criteria;
                                    const total = norm.total;
                                    const finish = (err) => {
                                        if (err) return res.status(500).json({ error: err.message });
                                        portalTracking.logCaseEvent(
                                            db,
                                            sid,
                                            'scoring',
                                            'Judge scoring',
                                            'Judge submitted marks (total ' + total + ').',
                                            () => {}
                                        );
                                        caseJudgingStatus.maybeAdvanceCaseJudgingStatus(db, sid, () => {
                                            res.json({
                                                success: true,
                                                totalScore: total,
                                                totalMax: totalMaxFromCriteria(criteriaDefs),
                                                locked: true
                                            });
                                        });
                                    };
                                    if (scoreRow && scoreRow.id) {
                                        return db.run(
                                            `UPDATE case_judge_scores SET criteria_json = ?, total_score = ?, remarks = ?, is_locked = 1, submitted_at = CURRENT_TIMESTAMP
                                             WHERE submission_id = ? AND judge_user_id = ? AND IFNULL(is_locked,0) = 0`,
                                            [JSON.stringify(crit), total, remarks || null, sid, jid],
                                            function (uErr) {
                                                if (uErr) return res.status(500).json({ error: uErr.message });
                                                if (this.changes === 0) {
                                                    return res.status(400).json({ error: 'Scores already locked' });
                                                }
                                                finish(null);
                                            }
                                        );
                                    }
                                    db.run(
                                        `INSERT INTO case_judge_scores (submission_id, judge_user_id, criteria_json, total_score, remarks, is_locked, submitted_at)
                                         VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)`,
                                        [sid, jid, JSON.stringify(crit), total, remarks || null],
                                        finish
                                    );
                                });
                            }
                        );
                    }
                );
            }
        );
        });
    });

    app.get('/api/judge/case/submissions/:id/messages', (req, res) => {
        const sid = parseInt(req.params.id, 10);
        if (!Number.isInteger(sid)) return res.status(400).json({ error: 'Invalid submission id' });
        resolveJudgeUserId(db, req.query.judgeUserId, req.query.judgeUserIdString, (eJ, jid) => {
            if (eJ) return res.status(400).json({ error: eJ.message });
            db.get(
                `SELECT 1 FROM case_judge_assignments WHERE submission_id = ? AND judge_user_id = ?`,
                [sid, jid],
                (eA, assigned) => {
                    if (eA) return res.status(500).json({ error: eA.message });
                    if (!assigned) return res.status(403).json({ error: 'You are not assigned to this submission' });
                    judgeContact.listSubmissionMessages(db, sid, (eM, messages) => {
                        if (eM) return res.status(500).json({ error: eM.message });
                        res.json({ messages: messages || [] });
                    });
                }
            );
        });
    });

    app.post('/api/judge/case/submissions/:id/contact', async (req, res) => {
        const sid = parseInt(req.params.id, 10);
        const { judgeUserId, judgeUserIdString, subject, message } = req.body || {};
        if (!Number.isInteger(sid)) return res.status(400).json({ error: 'Invalid submission id' });
        resolveJudgeUserId(db, judgeUserId, judgeUserIdString, async (eJ, jid) => {
            if (eJ) return res.status(400).json({ error: eJ.message });
            db.get(
                `SELECT 1 FROM case_judge_assignments WHERE submission_id = ? AND judge_user_id = ?`,
                [sid, jid],
                (eA, assigned) => {
                    if (eA) return res.status(500).json({ error: eA.message });
                    if (!assigned) return res.status(403).json({ error: 'You are not assigned to this submission' });
                    db.get(
                        `SELECT u.id, u.first_name, u.last_name, u.email, u.phone FROM users u WHERE u.id = ?`,
                        [jid],
                        (eJudge, judge) => {
                            if (eJudge || !judge) {
                                return res.status(500).json({ error: 'Judge account not found' });
                            }
                            db.get(
                                `SELECT cs.*, u.first_name, u.last_name, u.email AS account_email, u.phone AS account_phone
                                 FROM case_submissions cs JOIN users u ON u.id = cs.user_id WHERE cs.id = ?`,
                                [sid],
                                async (eSub, sub) => {
                                    if (eSub || !sub) {
                                        return res.status(404).json({ error: 'Submission not found' });
                                    }
                                    const participant = judgeContact.parseParticipantFromSubmission(sub, {
                                        email: sub.account_email,
                                        phone: sub.account_phone
                                    });
                                    try {
                                        const result = await judgeContact.sendJudgeMessage(db, {
                                            judge,
                                            participant,
                                            subject,
                                            message,
                                            submissionId: sid
                                        });
                                        if (!result.ok) {
                                            return res.status(400).json({
                                                error: result.error || 'Could not send message'
                                            });
                                        }
                                        res.json({
                                            success: true,
                                            message: result.emailSent
                                                ? 'Message sent. Participant was notified by email.'
                                                : 'Message saved. Participant can reply in the Doctor portal.',
                                            fromDisplay: result.fromDisplay,
                                            messageId: result.messageId
                                        });
                                    } catch (sendErr) {
                                        res.status(500).json({ error: sendErr.message || 'Send failed' });
                                    }
                                }
                            );
                        }
                    );
                }
            );
        });
    });

    app.get('/api/doctor/case/submissions/:submissionId/messages', (req, res) => {
        const sid = parseInt(req.params.submissionId, 10);
        const uid = parseInt(req.query.userId, 10);
        if (!Number.isInteger(sid) || !Number.isInteger(uid)) {
            return res.status(400).json({ error: 'Invalid submission or user id' });
        }
        db.get(`SELECT id, user_id FROM case_submissions WHERE id = ?`, [sid], (e, sub) => {
            if (e) return res.status(500).json({ error: e.message });
            if (!sub) return res.status(404).json({ error: 'Submission not found' });
            if (sub.user_id !== uid) return res.status(403).json({ error: 'Not your submission' });
            judgeContact.listSubmissionMessages(db, sid, (eM, messages) => {
                if (eM) return res.status(500).json({ error: eM.message });
                res.json({ messages: messages || [] });
            });
        });
    });

    app.post('/api/doctor/case/submissions/:submissionId/reply', async (req, res) => {
        const sid = parseInt(req.params.submissionId, 10);
        const uid = parseInt(req.body && req.body.userId, 10);
        const { message, judgeUserId } = req.body || {};
        if (!Number.isInteger(sid) || !Number.isInteger(uid)) {
            return res.status(400).json({ error: 'Invalid submission or user id' });
        }
        db.get(
            `SELECT cs.*, u.first_name, u.last_name, u.email AS account_email, u.phone AS account_phone
             FROM case_submissions cs JOIN users u ON u.id = cs.user_id WHERE cs.id = ? AND cs.user_id = ?`,
            [sid, uid],
            async (eSub, sub) => {
                if (eSub) return res.status(500).json({ error: eSub.message });
                if (!sub) return res.status(404).json({ error: 'Submission not found' });
                const pickJudge = (cb) => {
                    const jid = parseInt(judgeUserId, 10);
                    if (Number.isInteger(jid) && jid > 0) return cb(null, jid);
                    db.get(
                        `SELECT judge_user_id FROM ${judgeContact.MSG_TABLE}
                         WHERE submission_id = ? AND direction = 'judge' ORDER BY id DESC LIMIT 1`,
                        [sid],
                        (eJ, row) => {
                            if (eJ) return cb(eJ);
                            if (!row) {
                                return cb(new Error('No judge message to reply to yet'));
                            }
                            cb(null, row.judge_user_id);
                        }
                    );
                };
                pickJudge((ePick, targetJudgeId) => {
                    if (ePick) {
                        return res.status(400).json({ error: ePick.message || 'Cannot determine judge' });
                    }
                    db.get(`SELECT id, first_name, last_name, email FROM users WHERE id = ?`, [uid], async (eU, participantUser) => {
                        if (eU || !participantUser) {
                            return res.status(500).json({ error: 'User not found' });
                        }
                        db.get(
                            `SELECT id, first_name, last_name, email FROM users WHERE id = ?`,
                            [targetJudgeId],
                            async (eJudge, judge) => {
                                if (eJudge || !judge) {
                                    return res.status(400).json({ error: 'Judge not found' });
                                }
                                const participant = judgeContact.parseParticipantFromSubmission(sub, {
                                    email: sub.account_email,
                                    phone: sub.account_phone
                                });
                                try {
                                    const result = await judgeContact.sendParticipantReply(db, {
                                        participantUser,
                                        judge,
                                        participant,
                                        submissionId: sid,
                                        message,
                                        judgeUserId: targetJudgeId
                                    });
                                    if (!result.ok) {
                                        return res.status(400).json({ error: result.error || 'Could not send reply' });
                                    }
                                    res.json({ success: true, messageId: result.messageId });
                                } catch (err) {
                                    res.status(500).json({ error: err.message || 'Reply failed' });
                                }
                            }
                        );
                    });
                });
            }
        );
    });

    app.get('/api/admin/case/results', (req, res) => {
        const programId = parseInt(req.query.programId, 10);
        let sql = `
            SELECT cs.id, cs.application_no, cs.title, cs.category, cs.status, cs.case_program_id,
                   IFNULL(cs.plagiarism_zero, 0) AS plagiarism_zero,
                   u.first_name, u.last_name, u.user_id_string,
                   (SELECT ROUND(AVG(total_score), 2) FROM case_judge_scores
                    WHERE submission_id = cs.id AND IFNULL(is_locked, 0) = 1) AS avg_score,
                   (SELECT COUNT(*) FROM case_judge_scores
                    WHERE submission_id = cs.id AND IFNULL(is_locked, 0) = 1) AS judges_scored
            FROM case_submissions cs
            JOIN users u ON u.id = cs.user_id
            WHERE IFNULL(cs.plagiarism_zero, 0) = 0`;
        const params = [];
        if (Number.isInteger(programId) && programId > 0) {
            sql += ` AND cs.case_program_id = ?`;
            params.push(programId);
        }
        sql += ` ORDER BY (avg_score IS NULL), avg_score DESC, cs.id ASC`;
        const finish = (criteria) => {
            db.all(sql, params, (e, rows) => {
                if (e) return res.status(500).json({ error: e.message });
                res.json({
                    criteria,
                    totalMax: totalMaxFromCriteria(criteria),
                    results: rows || []
                });
            });
        };
        if (Number.isInteger(programId) && programId > 0) {
            loadJudgeCriteriaForProgram(db, programId, (eC, criteria) => {
                if (eC) return res.status(500).json({ error: eC.message });
                finish(criteria);
            });
        } else {
            finish(parseJudgeCriteria(null));
        }
    });

    app.get('/api/admin/case/submissions/:id/scores', (req, res) => {
        const sid = parseInt(req.params.id, 10);
        if (!Number.isInteger(sid)) return res.status(400).json({ error: 'Invalid submission id' });
        loadJudgeCriteriaForSubmission(db, sid, (eC, criteriaDefs) => {
            if (eC) return res.status(500).json({ error: eC.message });
            db.all(
                `SELECT cjs.*, u.first_name, u.last_name, u.user_id_string
                 FROM case_judge_scores cjs
                 JOIN users u ON u.id = cjs.judge_user_id
                 WHERE cjs.submission_id = ?`,
                [sid],
                (e, rows) => {
                    if (e) return res.status(500).json({ error: e.message });
                    res.json({
                        criteria: criteriaDefs,
                        totalMax: totalMaxFromCriteria(criteriaDefs),
                        scores: rows || []
                    });
                }
            );
        });
    });

    app.post('/api/admin/case/submissions/:id/transfer-judge', (req, res) => {
        const sid = parseInt(req.params.id, 10);
        const body = req.body || {};
        const fromJudgeId = parseInt(body.fromJudgeId, 10);
        const toRef = body.toJudgeUserIdString || body.toJudgeUserId || '';
        const toJudgeId = parseInt(body.toJudgeUserId, 10);
        if (!Number.isInteger(sid)) return res.status(400).json({ error: 'Invalid submission id' });
        if (!Number.isInteger(fromJudgeId) || fromJudgeId < 1) {
            return res.status(400).json({ error: 'fromJudgeId is required' });
        }
        const runTransfer = (toJ) => {
            caseJudgeTransfer.transferAssignment(
                db,
                {
                    submissionId: sid,
                    fromJudgeId,
                    toJudgeId: toJ.id,
                    byUserId: parseInt(body.actingAdminId, 10) || null,
                    byLabel: 'Admin'
                },
                (eX, result) => {
                    if (eX) return res.status(400).json({ error: eX.message });
                    res.json(result);
                }
            );
        };
        if (Number.isInteger(toJudgeId) && toJudgeId > 0) {
            return db.get(`SELECT id, user_role, role FROM users WHERE id = ?`, [toJudgeId], (eU, row) => {
                if (eU) return res.status(500).json({ error: eU.message });
                if (!row) return res.status(400).json({ error: 'Target judge not found' });
                const ur = String(row.user_role || row.role || '').toLowerCase();
                if (!['judge', 'reviewer', 'judge_user'].includes(ur)) {
                    return res.status(400).json({ error: 'Selected user is not a judge' });
                }
                runTransfer(row);
            });
        }
        caseJudgeTransfer.resolveJudgeRef(db, toRef, (eTo, toJ) => {
            if (eTo) return res.status(400).json({ error: eTo.message });
            runTransfer(toJ);
        });
    });

    const caseMarksheet = require('./case-marksheet');

    app.get('/api/admin/case/marksheet', (req, res) => {
        const programId = req.query.programId;
        const format = String(req.query.format || 'json').toLowerCase();
        caseMarksheet.loadMarksheetDocument(db, programId, (err, payload) => {
            if (err) return res.status(500).json({ error: err.message });
            if (format === 'xlsx') {
                const buf = caseMarksheet.toXlsxBuffer(payload);
                res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
                res.setHeader(
                    'Content-Disposition',
                    'attachment; filename="case-marksheet-' + (programId || 'all') + '.xlsx"'
                );
                return res.send(buf);
            }
            if (format === 'pdf' || format === 'html') {
                const html = caseMarksheet.toBrandedPdfHtml(payload);
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                res.setHeader(
                    'Content-Disposition',
                    'inline; filename="case-marksheet-' + (programId || 'all') + '.html"'
                );
                return res.send(html);
            }
            res.json(payload);
        });
    });

    app.post('/api/judge/case/submissions/:id/transfer-judge', (req, res) => {
        const sid = parseInt(req.params.id, 10);
        const body = req.body || {};
        const toRef = body.toJudgeUserIdString || body.toJudgeUserId || '';
        if (!Number.isInteger(sid)) return res.status(400).json({ error: 'Invalid submission id' });
        resolveJudgeUserId(db, body.judgeUserId, body.judgeUserIdString, (eJ, fromJudgeId) => {
            if (eJ) return res.status(400).json({ error: eJ.message });
            const toJudgeId = parseInt(body.toJudgeUserId, 10);
            const finishTransfer = (toJ) => {
                if (!toJ || !toJ.id) return res.status(400).json({ error: 'Target judge not found' });
                db.get(`SELECT first_name, last_name FROM users WHERE id = ?`, [fromJudgeId], (eN, ju) => {
                    const byLabel =
                        ju && (ju.first_name || ju.last_name)
                            ? [ju.first_name, ju.last_name].filter(Boolean).join(' ')
                            : 'Judge';
                    caseJudgeTransfer.transferAssignment(
                        db,
                        {
                            submissionId: sid,
                            fromJudgeId,
                            toJudgeId: toJ.id,
                            byUserId: fromJudgeId,
                            byLabel
                        },
                        (eX, result) => {
                            if (eX) return res.status(400).json({ error: eX.message });
                            res.json(result);
                        }
                    );
                });
            };
            if (Number.isInteger(toJudgeId) && toJudgeId > 0) {
                return db.get(
                    `SELECT id, first_name, last_name, email, user_id_string, user_role, role FROM users WHERE id = ?`,
                    [toJudgeId],
                    (eU, row) => {
                        if (eU) return res.status(500).json({ error: eU.message });
                        if (!row) return res.status(400).json({ error: 'Target judge not found' });
                        const ur = String(row.user_role || row.role || '').toLowerCase();
                        if (!['judge', 'reviewer', 'judge_user'].includes(ur)) {
                            return res.status(400).json({ error: 'Selected user is not a judge' });
                        }
                        finishTransfer(row);
                    }
                );
            }
            caseJudgeTransfer.resolveJudgeRef(db, toRef, (eTo, toJ) => {
                if (eTo) return res.status(400).json({ error: eTo.message });
                finishTransfer(toJ);
            });
        });
    });
}

module.exports = {
    ensureCasePresentationSchema,
    registerCasePresentationRoutes,
    CASE_CATEGORIES,
    CASE_JUDGE_CRITERIA,
    DEFAULT_CASE_FORM_CONFIG,
    caseWindowState,
    enrichCaseProgram,
    parseCaseFormConfig,
    validateCaseForm,
    parseCaseFormBody,
    parseJudgeCriteria,
    totalMaxFromCriteria
};
