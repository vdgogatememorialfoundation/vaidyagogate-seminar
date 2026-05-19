/**
 * Editable VGMF certificate template fields (stored as JSON on certificate_templates).
 * Placeholders: {{recipient_name}}, {{seminar_title}}, {{topic}}, {{venue}}, {{date}}, {{prn_no}}, {{application_no}}
 */
const DEFAULT_CONFIG = {
    orgName: 'Vaidya Gogate Memorial Foundation',
    title: 'CERTIFICATE',
    subtitle: 'OF PARTICIPATION',
    leadText: 'This certificate is given to',
    bodyParticipant:
        'For participation in <strong>{{seminar_title}}</strong> on &ldquo;<em>{{topic}}</em>&rdquo; hosted by the Vaidya Gogate Memorial Foundation',
    bodyVolunteer:
        'For Volunteering at <strong>{{seminar_title}}</strong> on &ldquo;<em>{{topic}}</em>&rdquo; hosted by the Vaidya Gogate Memorial Foundation',
    venueLabel: 'Venue',
    dateLabel: 'Date',
    venueOverride: '',
    dateOverride: '',
    sigLeftTitle: 'VD. Gogate Memorial Foundation',
    sigRightName: 'Dr. Chandrakumar Deshmukh',
    sigRightTitle: 'Organising Secretary',
    sigLeftImagePath: '',
    sigRightImagePath: '',
    goldColor: '#c9a227',
    nameColor: '#c45c26',
    charcoalColor: '#4a4a4a',
    bgColor: '#f3f3f3',
    showFlame: true,
    showSwooshes: true,
    autoHonorific: true
};

function parseConfig(json) {
    if (!json) return { ...DEFAULT_CONFIG };
    try {
        const o = typeof json === 'string' ? JSON.parse(json) : json;
        return { ...DEFAULT_CONFIG, ...(o && typeof o === 'object' ? o : {}) };
    } catch (_) {
        return { ...DEFAULT_CONFIG };
    }
}

function stringifyConfig(cfg) {
    return JSON.stringify({ ...DEFAULT_CONFIG, ...(cfg && typeof cfg === 'object' ? cfg : {}) });
}

function applyPlaceholders(template, vars) {
    return String(template || '').replace(/\{\{(\w+)\}\}/g, (_, key) =>
        vars[key] != null ? String(vars[key]) : ''
    );
}

function ensureConfigJsonColumn(db, ignoreErr, next) {
    const pg = !!process.env.DATABASE_URL;
    const cols = pg
        ? [
              'ALTER TABLE certificate_templates ADD COLUMN IF NOT EXISTS config_json TEXT',
              'ALTER TABLE certificate_templates ADD COLUMN IF NOT EXISTS signature_left_path TEXT',
              'ALTER TABLE certificate_templates ADD COLUMN IF NOT EXISTS signature_right_path TEXT'
          ]
        : [
              'ALTER TABLE certificate_templates ADD COLUMN config_json TEXT',
              'ALTER TABLE certificate_templates ADD COLUMN signature_left_path TEXT',
              'ALTER TABLE certificate_templates ADD COLUMN signature_right_path TEXT'
          ];
    let i = 0;
    const step = () => {
        if (i >= cols.length) return next && next();
        db.run(cols[i++], (e) => {
            if (ignoreErr) ignoreErr(e);
            step();
        });
    };
    step();
}

module.exports = {
    DEFAULT_CONFIG,
    parseConfig,
    stringifyConfig,
    applyPlaceholders,
    ensureConfigJsonColumn
};
