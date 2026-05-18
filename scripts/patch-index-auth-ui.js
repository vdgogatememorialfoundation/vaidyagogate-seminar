const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'public', 'index.html');
let h = fs.readFileSync(p, 'utf8');
const d = 'motion'; // typo guard — replaced below
const tag = 'div';

const insertAfterPassword =
    '\n                        <p id="login_email_hint" style="font-size:0.82rem;color:var(--muted);margin:-4px 0 8px;display:none;"></p>' +
    '\n                        <p style="margin:0 0 12px;"><button type="button" class="btn-ghost" style="padding:0;font-size:0.85rem;border:none;color:var(--brand);" onclick="openForgotPasswordModal()">Forgot password?</button></p>';

const pwAnchor = 'id="login_password" required autocomplete="current-password"></' + tag + '>';
if (!h.includes('openForgotPasswordModal') && h.includes(pwAnchor)) {
    h = h.replace(pwAnchor, pwAnchor + insertAfterPassword);
}

const modalsHtml = [
    '    <' + tag + ' id="forgotPasswordModal" class="modal" aria-hidden="true" style="display:none;">',
    '        <' + tag + ' class="modal-content" style="max-width:420px;">',
    '            <' + tag + ' style="padding:28px;">',
    '                <h3 style="font-size:1.1rem;margin-bottom:12px;">Reset password</h3>',
    '                <p style="font-size:0.88rem;color:var(--muted);margin-bottom:14px;">Enter your registered email. We will send a reset link to your email and WhatsApp.</p>',
    '                <form onsubmit="handleForgotPassword(event)">',
    '                    <' + tag + ' class="form-group"><label>Email</label><input type="email" id="forgot_email" required></' + tag + '>',
    '                    <p id="forgot_status" style="font-size:0.85rem;margin:8px 0 0;"></p>',
    '                    <button type="submit" class="btn-primary" style="width:100%;margin-top:14px;">Send reset link</button>',
    '                </form>',
    '                <button type="button" onclick="closeForgotPasswordModal()" style="margin-top:12px;background:none;border:none;cursor:pointer;">Cancel</button>',
    '            </' + tag + '>',
    '        </' + tag + '>',
    '    </' + tag + '>',
    '    <' + tag + ' id="resetPasswordModal" class="modal" aria-hidden="true" style="display:none;">',
    '        <' + tag + ' class="modal-content" style="max-width:420px;">',
    '            <' + tag + ' style="padding:28px;">',
    '                <h3 style="font-size:1.1rem;margin-bottom:12px;">Choose a new password</h3>',
    '                <form onsubmit="handleResetPassword(event)">',
    '                    <input type="hidden" id="reset_token" value="">',
    '                    <' + tag + ' class="form-group"><label>New password</label><input type="password" id="reset_password" required minlength="4"></' + tag + '>',
    '                    <' + tag + ' class="form-group"><label>Confirm</label><input type="password" id="reset_password2" required minlength="4"></' + tag + '>',
    '                    <p id="reset_status" style="font-size:0.85rem;"></p>',
    '                    <button type="submit" class="btn-primary" style="width:100%;margin-top:14px;">Update password</button>',
    '                </form>',
    '            </' + tag + '>',
    '        </' + tag + '>',
    '    </' + tag + '>'
].join('\n');

if (!h.includes('forgotPasswordModal')) {
    h = h.replace('    <' + tag + ' id="signupSuccessModal"', modalsHtml + '\n    <' + tag + ' id="signupSuccessModal"');
}

const jsFns = `
        async function onLoginEmailBlur() {
            const hint = document.getElementById('login_email_hint');
            if (!hint) return;
            const email = String((document.getElementById('login_email') || {}).value || '').trim().toLowerCase();
            if (!email) { hint.style.display = 'none'; return; }
            try {
                const pc = await precheckLoginEmail();
                if (pc.exists) {
                    hint.style.color = '#059669';
                    hint.textContent = 'Account found — codes will go to your email and WhatsApp.';
                    hint.style.display = 'block';
                } else if (pc.needsSignup) {
                    hint.style.color = '#b91c1c';
                    hint.textContent = pc.message || 'No account with this email.';
                    hint.style.display = 'block';
                } else hint.style.display = 'none';
            } catch (_) { hint.style.display = 'none'; }
        }
        function openForgotPasswordModal() {
            const m = document.getElementById('forgotPasswordModal');
            const fe = document.getElementById('forgot_email');
            const le = document.getElementById('login_email');
            if (fe && le && le.value) fe.value = le.value.trim();
            const st = document.getElementById('forgot_status');
            if (st) st.textContent = '';
            if (m) { m.style.display = 'flex'; m.setAttribute('aria-hidden', 'false'); }
        }
        function closeForgotPasswordModal() {
            const m = document.getElementById('forgotPasswordModal');
            if (m) { m.style.display = 'none'; m.setAttribute('aria-hidden', 'true'); }
        }
        async function handleForgotPassword(e) {
            e.preventDefault();
            const email = String((document.getElementById('forgot_email') || {}).value || '').trim().toLowerCase();
            const st = document.getElementById('forgot_status');
            if (st) { st.textContent = 'Sending…'; }
            try {
                const res = await fetch('/api/auth/forgot-password', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email })
                });
                const data = await res.json();
                if (st) { st.style.color = '#059669'; st.textContent = data.message || 'Check your email and WhatsApp.'; }
            } catch (_) {
                if (st) { st.style.color = '#b91c1c'; st.textContent = 'Could not send.'; }
            }
        }
        function openResetPasswordModal(token) {
            const m = document.getElementById('resetPasswordModal');
            const t = document.getElementById('reset_token');
            if (t) t.value = token || '';
            if (m) { m.style.display = 'flex'; m.setAttribute('aria-hidden', 'false'); }
        }
        async function handleResetPassword(e) {
            e.preventDefault();
            const token = String((document.getElementById('reset_token') || {}).value || '').trim();
            const p1 = (document.getElementById('reset_password') || {}).value;
            const p2 = (document.getElementById('reset_password2') || {}).value;
            const st = document.getElementById('reset_status');
            if (p1 !== p2) { if (st) { st.style.color = '#b91c1c'; st.textContent = 'Passwords do not match.'; } return; }
            try {
                const res = await fetch('/api/auth/reset-password', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token, newPassword: p1 })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed');
                if (st) { st.style.color = '#059669'; st.textContent = data.message || 'Password updated.'; }
                setTimeout(() => openAuthModal('login'), 1200);
            } catch (err) {
                if (st) { st.style.color = '#b91c1c'; st.textContent = err.message; }
            }
        }
`;

if (!h.includes('function openForgotPasswordModal')) {
    h = h.replace('        async function precheckLoginEmail()', jsFns + '\n        async function precheckLoginEmail()');
}
if (!h.includes('onLoginEmailBlur')) {
    h = h.replace(
        'id="login_email" required autocomplete="email">',
        'id="login_email" required autocomplete="email" onblur="onLoginEmailBlur()">'
    );
}
if (!h.includes("params.get('resetToken')")) {
    h = h.replace(
        "window.addEventListener('load', () => {",
        "window.addEventListener('load', () => {\n            const params = new URLSearchParams(window.location.search);\n            const rt = params.get('resetToken');\n            if (rt) openResetPasswordModal(rt);"
    );
}
h = h.replace(
    /if \(!password\) \{\s*try \{\s*const pc = await precheckLoginEmail\(\);[\s\S]*?return alert\('Enter your password, then request a verification code\.'\);\s*\}/,
    `try {
                const pc = await precheckLoginEmail();
                if (pc.needsSignup) return alert(pc.message || 'No account found.');
            } catch (_) {}`
);
h = h.replace(`if (!password) return alert('Enter your password first.');`, '');
h = h.replace(
    `if (!email || !password || !code) return alert('Enter email, password, and the code.');`,
    `if (!email || !code) return alert('Enter email and the code.');`
);

fs.writeFileSync(p, h);
console.log('patched', { forgot: h.includes('openForgotPasswordModal') });
