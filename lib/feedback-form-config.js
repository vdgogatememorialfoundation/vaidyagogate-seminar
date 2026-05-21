/**
 * Configurable seminar feedback form (admin-editable fields).
 */
const DEFAULT_FEEDBACK_FORM = {
    version: 1,
    title: 'Seminar feedback',
    intro: 'Share your experience after attending a seminar.',
    fields: [
        { id: 'rating', type: 'rating', label: 'Overall (1–5)', required: true, min: 1, max: 5 },
        { id: 'contentQuality', type: 'rating', label: 'Content (1–5)', required: true, min: 1, max: 5 },
        { id: 'speakerQuality', type: 'rating', label: 'Speaker (1–5)', required: true, min: 1, max: 5 },
        { id: 'organizationQuality', type: 'rating', label: 'Organization (1–5)', required: true, min: 1, max: 5 },
        { id: 'overallExperience', type: 'textarea', label: 'Experience', required: true, rows: 2 },
        { id: 'suggestions', type: 'textarea', label: 'Suggestions', required: false, rows: 2 },
        {
            id: 'wouldAttendAgain',
            type: 'checkbox',
            label: 'Interested in future seminars',
            required: false,
            defaultChecked: true
        }
    ]
};

const KEY = 'feedback_form_config';

function normalizeFeedbackForm(raw) {
    const base = JSON.parse(JSON.stringify(DEFAULT_FEEDBACK_FORM));
    if (!raw || typeof raw !== 'object') return base;
    if (raw.title) base.title = String(raw.title).slice(0, 200);
    if (raw.intro) base.intro = String(raw.intro).slice(0, 2000);
    if (Array.isArray(raw.fields) && raw.fields.length) {
        base.fields = raw.fields
            .map((f, i) => {
                if (!f || typeof f !== 'object') return null;
                const id = String(f.id || f.key || 'field_' + i)
                    .replace(/\W+/g, '_')
                    .slice(0, 48);
                const type = ['rating', 'textarea', 'text', 'checkbox', 'select'].includes(f.type)
                    ? f.type
                    : 'text';
                return {
                    id,
                    type,
                    label: String(f.label || id).slice(0, 120),
                    required: !!f.required,
                    min: f.min != null ? Number(f.min) : type === 'rating' ? 1 : undefined,
                    max: f.max != null ? Number(f.max) : type === 'rating' ? 5 : undefined,
                    rows: f.rows != null ? Number(f.rows) : 2,
                    defaultChecked: !!f.defaultChecked,
                    options: Array.isArray(f.options) ? f.options.map((o) => String(o).slice(0, 80)) : []
                };
            })
            .filter(Boolean);
    }
    return base;
}

function loadFeedbackFormConfig(db, cb) {
    db.get(`SELECT value FROM global_settings WHERE key = ?`, [KEY], (err, row) => {
        if (err) return cb(err);
        if (!row || !row.value) return cb(null, DEFAULT_FEEDBACK_FORM);
        try {
            cb(null, normalizeFeedbackForm(JSON.parse(row.value)));
        } catch (_) {
            cb(null, DEFAULT_FEEDBACK_FORM);
        }
    });
}

function saveFeedbackFormConfig(db, config, cb) {
    const normalized = normalizeFeedbackForm(config);
    const json = JSON.stringify(normalized);
    db.run(`UPDATE global_settings SET value = ? WHERE key = ?`, [json, KEY], function (uerr) {
        if (uerr) return cb(uerr);
        if (this.changes > 0) return cb(null, normalized);
        db.run(`INSERT INTO global_settings (key, value) VALUES (?, ?)`, [KEY, json], (ierr) => cb(ierr, normalized));
    });
}

function mapFeedbackAnswers(fields, body) {
    const answers = body && body.answers && typeof body.answers === 'object' ? body.answers : body || {};
    const legacy = {
        rating: answers.rating,
        contentQuality: answers.contentQuality,
        speakerQuality: answers.speakerQuality,
        organizationQuality: answers.organizationQuality,
        overallExperience: answers.overallExperience,
        suggestions: answers.suggestions,
        wouldAttendAgain: answers.wouldAttendAgain
    };
    const out = {
        rating: 5,
        contentQuality: 5,
        speakerQuality: 5,
        organizationQuality: 5,
        overallExperience: '',
        suggestions: '',
        wouldAttendAgain: 1,
        answersJson: {}
    };
    for (const field of fields) {
        let val = answers[field.id];
        if (val === undefined && legacy[field.id] !== undefined) val = legacy[field.id];
        if (field.type === 'checkbox') {
            val = val === true || val === 1 || val === '1' || val === 'true' || val === 'on';
            out.answersJson[field.id] = val;
            if (field.id === 'wouldAttendAgain') out.wouldAttendAgain = val ? 1 : 0;
            continue;
        }
        if (field.type === 'rating') {
            const n = parseInt(val, 10);
            const clamped = Number.isFinite(n) ? Math.min(field.max || 5, Math.max(field.min || 1, n)) : 5;
            out.answersJson[field.id] = clamped;
            if (field.id === 'rating') out.rating = clamped;
            if (field.id === 'contentQuality') out.contentQuality = clamped;
            if (field.id === 'speakerQuality') out.speakerQuality = clamped;
            if (field.id === 'organizationQuality') out.organizationQuality = clamped;
            continue;
        }
        const text = val != null ? String(val).trim() : '';
        out.answersJson[field.id] = text;
        if (field.id === 'overallExperience') out.overallExperience = text;
        if (field.id === 'suggestions') out.suggestions = text;
        if (field.required && !text && field.type !== 'checkbox') {
            return { error: field.label + ' is required.' };
        }
    }
    return out;
}

module.exports = {
    KEY,
    DEFAULT_FEEDBACK_FORM,
    normalizeFeedbackForm,
    loadFeedbackFormConfig,
    saveFeedbackFormConfig,
    mapFeedbackAnswers
};
