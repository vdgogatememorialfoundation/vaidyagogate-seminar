/**
 * Application reviewer profiles + registration escalation columns.
 */
function isPg() {
    return !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
}

function ignoreSchemaErr(e) {
    if (e && !/duplicate column|already exists/i.test(String(e.message))) {
        console.warn('[application-reviewer-schema]', e.message);
    }
}

function ensureApplicationReviewerSchema(db, ignoreErr, next) {
    const pg = isPg();
    const ts = pg ? 'TIMESTAMPTZ' : 'DATETIME';
    const onErr = ignoreErr || ignoreSchemaErr;

    const steps = [
        pg
            ? `CREATE TABLE IF NOT EXISTS application_reviewer_profiles (
                user_id INTEGER PRIMARY KEY,
                authority_level INTEGER DEFAULT 1,
                notes TEXT,
                updated_at ${ts} DEFAULT CURRENT_TIMESTAMP
            )`
            : `CREATE TABLE IF NOT EXISTS application_reviewer_profiles (
                user_id INTEGER PRIMARY KEY,
                authority_level INTEGER DEFAULT 1,
                notes TEXT,
                updated_at ${ts} DEFAULT CURRENT_TIMESTAMP
            )`,
        pg
            ? 'ALTER TABLE registrations ADD COLUMN IF NOT EXISTS review_required_level INTEGER DEFAULT 1'
            : 'ALTER TABLE registrations ADD COLUMN review_required_level INTEGER DEFAULT 1',
        pg
            ? 'ALTER TABLE registrations ADD COLUMN IF NOT EXISTS review_assigned_to INTEGER'
            : 'ALTER TABLE registrations ADD COLUMN review_assigned_to INTEGER',
        pg
            ? `ALTER TABLE registrations ADD COLUMN IF NOT EXISTS review_escalated_at ${ts}`
            : `ALTER TABLE registrations ADD COLUMN review_escalated_at ${ts}`,
        pg
            ? 'ALTER TABLE registrations ADD COLUMN IF NOT EXISTS review_escalated_by INTEGER'
            : 'ALTER TABLE registrations ADD COLUMN review_escalated_by INTEGER',
        pg
            ? 'ALTER TABLE registrations ADD COLUMN IF NOT EXISTS review_escalation_json TEXT'
            : 'ALTER TABLE registrations ADD COLUMN review_escalation_json TEXT'
    ];

    let i = 0;
    const step = () => {
        if (i >= steps.length) return next && next();
        db.run(steps[i++], (e) => {
            onErr(e);
            step();
        });
    };
    step();
}

module.exports = {
    ensureApplicationReviewerSchema
};
