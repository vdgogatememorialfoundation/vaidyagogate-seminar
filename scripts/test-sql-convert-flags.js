const convert = require('../lib/sql-convert').convertSqliteToPostgres;

const cases = [
    ['otp_codes consumed', 'UPDATE otp_codes SET consumed = 1 WHERE id = ?'],
    ['otp_verification_tokens consumed', 'UPDATE otp_verification_tokens SET consumed = 1 WHERE id = ?'],
    ['email_verify_tokens consumed', 'UPDATE email_verify_tokens SET consumed = 1 WHERE id = ?'],
    ['tickets is_scanned', 'UPDATE tickets SET is_scanned = 1, scan_time = CURRENT_TIMESTAMP WHERE id = ?'],
    ['certificate_templates is_active', 'UPDATE certificate_templates SET is_active = 0 WHERE seminar_id = ?'],
    ['seminars is_active', 'UPDATE seminars SET is_active = 0 WHERE id = ?'],
    ['users email_verified', 'UPDATE users SET email_verified = 1 WHERE id = ?'],
    ['user_certificates enabled', 'UPDATE user_certificates SET enabled = 1 WHERE id = ?'],
    ['where consumed', 'SELECT id FROM otp_codes WHERE consumed = 0 AND expires_at > ?']
];

let failed = 0;
for (const [name, sql] of cases) {
    const out = convert(sql);
    console.log(name + ':');
    console.log('  ' + out);
    if (/consumed\s*=\s*TRUE/i.test(out) || /email_verified\s*=\s*TRUE/i.test(out) || /enabled\s*=\s*TRUE/i.test(out)) {
        console.log('  FAIL: integer flag became boolean');
        failed++;
    }
    if (name === 'tickets is_scanned' && !/is_scanned\s*=\s*TRUE/i.test(out)) {
        console.log('  FAIL: is_scanned should be TRUE');
        failed++;
    }
    if (name === 'seminars is_active' && !/is_active\s*=\s*FALSE/i.test(out)) {
        console.log('  FAIL: seminars.is_active should be FALSE');
        failed++;
    }
    if (name === 'certificate_templates is_active' && /is_active\s*=\s*FALSE/i.test(out)) {
        console.log('  FAIL: certificate_templates.is_active must stay 0');
        failed++;
    }
}
process.exit(failed ? 1 : 0);
