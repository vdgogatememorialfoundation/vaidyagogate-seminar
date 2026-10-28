/**
 * Doctor portal module visibility: a module added after a whitelist was saved stays visible.
 */
const assert = require('assert');
const modules = require('../lib/doctor-portal-modules');
const policy = require('../lib/portal-auth-policy');

const saved = {
    'tab-dashboard': true,
    'tab-profile': true,
    'tab-seminars': true,
    'tab-applications': true,
    'tab-abstract': true,
    'tab-case-track': true,
    'tab-volunteer': true,
    'tab-feedback': true,
    'tab-support': true,
    'tab-live-chat': true,
    'tab-orders': true,
    'tab-refunds': true,
    'tab-receipts': true,
    'tab-payments': true,
    'tab-ticket': true,
    'tab-certificate': true,
    'tab-reset-pwd': true
};
const allowed = modules.resolveDoctorAllowedTabs('regular', saved, saved, null);
assert.ok(allowed.has('tab-books'));
assert.ok(allowed.has('tab-dashboard'));
assert.ok(!allowed.has('tab-unknown'));

const hiddenBooks = Object.assign({}, saved, { 'tab-books': false });
const hidden = modules.resolveDoctorAllowedTabs('regular', hiddenBooks, hiddenBooks, null);
assert.ok(!hidden.has('tab-books'));
assert.ok(hidden.has('tab-payments'));

const custom = modules.resolveDoctorAllowedTabs('regular', saved, saved, JSON.stringify({ 'tab-books': true, 'tab-dashboard': false }));
assert.ok(custom.has('tab-books'));
assert.ok(!custom.has('tab-dashboard'));

const merged = policy.merge({ doctorPortalModulesRegular: saved, doctorPortalModulesVolunteer: saved });
assert.strictEqual(merged.doctorPortalModulesRegular['tab-books'], true);
assert.strictEqual(merged.doctorPortalModulesVolunteer['tab-books'], true);
assert.strictEqual(policy.merge({ doctorPortalModulesRegular: hiddenBooks }).doctorPortalModulesRegular['tab-books'], false);

assert.strictEqual(modules.userHasCustomModules(JSON.stringify(Object.assign({ 'tab-books': true }, saved))), true);

console.log('doctor module tests passed');
