/**
 * Case presentation programs — scheduling, applications, judging (seminar-like flow).
 */
const { validatePersonName, validateRegistrationPersonNames } = require('./name-validation');
const portalTracking = require('./portal-tracking');
const seminarDt = require('./seminar-datetime');

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
        maxFileSizeMb: row.max_file_size_mb != null ? row.max_file_size_mb : 50,
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
        maxFileSizeMb: Math.max(1, Math.min(200, parseInt(b.maxFileSizeMb, 10) || 50)),
        enabledCategoriesJson: JSON.stringify(
            enabledCategories.length ? enabledCategories : [...CASE_CATEGORIES]
        ),
        formConfigJson: JSON.stringify(formConfig),
        judgeCriteriaJson: JSON.stringify(judgeCriteria)
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
    if (form.phone) {
        const digits = form.phone.replace(/\D/g, '');
        if (digits.length < 10) return 'Enter a valid phone number (at least 10 digits)';
    }
    if (form.whatsapp) {
        const wad = form.whatsapp.replace(/\D/g, '');
        if (wad.length < 10) return 'Enter a valid WhatsApp number (at least 10 digits)';
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
                    `ALTER TABLE case_programs ADD COLUMN judge_criteria_json TEXT`
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
    const { db, upload, generateId } = deps;
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
                            enriched.maxTotalSubmissions != null
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
                        enriched.maxTotalSubmissions != null
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
        upload.array('files', 10)(req, res, (uploadErr) => {
            if (uploadErr) {
                return res.status(400).json({ error: uploadErr.message || 'File upload failed' });
            }
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

                const files = req.files || [];
                const fileFieldRequired = (parseCaseFormConfig(program.form_config_json).fields || []).find(
                    (f) => f.key === 'files' && f.enabled !== false
                );
                if (fileFieldRequired && fileFieldRequired.required !== false && files.length < 1) {
                    return res.status(400).json({ error: 'Upload at least one file (PPT, PDF, or video)' });
                }
                if (files.length > maxFiles) {
                    return res.status(400).json({ error: `Maximum ${maxFiles} files allowed` });
                }
                const maxMb = program.max_file_size_mb || 50;
                for (const f of files) {
                    if (f.size > maxMb * 1024 * 1024) {
                        return res.status(400).json({ error: `Each file must be under ${maxMb} MB` });
                    }
                }

                const win = caseWindowState(program);
                if (win === 'upcoming') return res.status(400).json({ error: 'Applications are not open yet' });
                if (win === 'closed') return res.status(400).json({ error: 'Application window has closed' });

                const proceedAfterCapacity = () => {
                db.get(
                    `SELECT id FROM case_submissions WHERE user_id = ? AND case_program_id = ? AND category = ?`,
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
                                    let fi = 0;
                                    let fErr = null;
                                    files.forEach((f, idx) => {
                                        db.run(
                                            `INSERT INTO case_files (submission_id, file_path, original_name, sort_order) VALUES (?, ?, ?, ?)`,
                                            [subId, '/uploads/' + f.filename, f.originalname, idx],
                                            (fe) => {
                                                if (fe && !fErr) fErr = fe.message;
                                                fi++;
                                                if (fi === files.length) {
                                                    if (fErr) return res.status(500).json({ error: fErr });
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
                                                }
                                            }
                                        );
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
            });
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
                    if (e2) return res.status(500).json({ error: e2.message });
                    portalTracking.getPortalYear(db, (e3, portalYear) => {
                        if (e3) return res.status(500).json({ error: e3.message });
                        res.json({ portalYear, applications: enriched || [] });
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
                enabled_categories, form_config_json, judge_criteria_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
                row.judgeCriteriaJson
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
                enabled_categories=?, form_config_json=?, judge_criteria_json=?
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
             WHERE cja.judge_user_id = ? AND cs.status IN ('judging','approved_for_judging','submitted','under_review')`,
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
            `SELECT cs.*, u.user_id_string, u.first_name, u.last_name
             FROM case_submissions cs JOIN users u ON u.id = cs.user_id WHERE cs.id = ?`,
            [sid],
            (e, sub) => {
                if (e) return res.status(500).json({ error: e.message });
                if (!sub) return res.status(404).json({ error: 'Not found' });
                db.all(`SELECT * FROM case_files WHERE submission_id = ? ORDER BY sort_order`, [sid], (e2, files) => {
                    if (e2) return res.status(500).json({ error: e2.message });
                    loadJudgeCriteriaForSubmission(db, sid, (eCrit, criteriaDefs) => {
                        if (eCrit) return res.status(500).json({ error: eCrit.message });
                        db.get(
                            `SELECT * FROM case_judge_scores WHERE submission_id = ? AND judge_user_id = ?`,
                            [sid, jid],
                            (e3, score) => {
                                if (e3) return res.status(500).json({ error: e3.message });
                                res.json({
                                    submission: sub,
                                    files: files || [],
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
                                        res.json({
                                            success: true,
                                            totalScore: total,
                                            totalMax: totalMaxFromCriteria(criteriaDefs),
                                            locked: true
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

    app.get('/api/admin/case/results', (req, res) => {
        const programId = parseInt(req.query.programId, 10);
        let sql = `
            SELECT cs.id, cs.application_no, cs.title, cs.category, cs.status, cs.case_program_id,
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
}

module.exports = {
    ensureCasePresentationSchema,
    registerCasePresentationRoutes,
    CASE_CATEGORIES,
    CASE_JUDGE_CRITERIA,
    DEFAULT_CASE_FORM_CONFIG,
    caseWindowState,
    enrichCaseProgram,
    parseCaseFormConfig
};
