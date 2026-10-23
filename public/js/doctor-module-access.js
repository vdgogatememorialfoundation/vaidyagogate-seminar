/**
 * Doctor portal module access from the Doctors list.
 * Each doctor can use the global sidebar, or a custom set of modules.
 */
(function () {
    const FALLBACK_TABS = [
        ['tab-dashboard', 'Dashboard'],
        ['tab-profile', 'My profile'],
        ['tab-seminars', 'Available seminars (registration form)'],
        ['tab-abstract', 'Case presentation'],
        ['tab-case-track', 'Track case applications'],
        ['tab-volunteer', 'Volunteer'],
        ['tab-feedback', 'Seminar feedback'],
        ['tab-support', 'Support tickets'],
        ['tab-live-chat', 'Live chat (floating widget)'],
        ['tab-orders', 'Orders'],
        ['tab-refunds', 'Refund tracking'],
        ['tab-receipts', 'Receipts'],
        ['tab-payments', 'Payments'],
        ['tab-books', 'Book orders (Agnikarma / Viddhakarma)'],
        ['tab-applications', 'Track seminar applications'],
        ['tab-ticket', 'Participant tickets'],
        ['tab-certificate', 'Certificates'],
        ['tab-reset-pwd', 'Change password']
    ];

    let tabDefs = FALLBACK_TABS.slice();
    let globals = { regular: {}, volunteer: {} };

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function parseModules(raw) {
        if (raw == null || raw === '') return null;
        if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
        try {
            const o = JSON.parse(String(raw));
            return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
        } catch (_) {
            return null;
        }
    }

    function hasCustom(raw) {
        const o = parseModules(raw);
        return !!(o && Object.keys(o).length);
    }

    function findDoctor(userId) {
        const list = window.__adminDoctorUsers || [];
        return list.find((u) => Number(u.id) === Number(userId)) || null;
    }

    function globalMap(category) {
        return String(category || '').toLowerCase() === 'volunteer' ? globals.volunteer || {} : globals.regular || {};
    }

    function globalAllows(category, tabId) {
        const map = globalMap(category);
        const keys = Object.keys(map);
        if (!keys.length || !keys.some((k) => map[k] === true)) return true;
        return !!map[tabId];
    }

    function ensureModal() {
        if (document.getElementById('doctor-mod-access-modal')) return;
        const wrap = document.createElement('div');
        wrap.id = 'doctor-mod-access-modal';
        wrap.className = 'hidden';
        wrap.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.5);z-index:10002;display:none;align-items:center;justify-content:center;';
        wrap.innerHTML =
            '<div style="background:#fff;padding:28px;border-radius:16px;width:640px;max-width:94vw;max-height:90vh;overflow-y:auto;position:relative;border:1px solid #99f6e4;">' +
            '<button type="button" id="doctor-mod-access-close" style="position:absolute;top:14px;right:14px;background:none;border:none;font-size:1.5rem;cursor:pointer;" aria-label="Close">&times;</button>' +
            '<h2 style="color:#0f766e;margin:0 0 8px;">Doctor module access</h2>' +
            '<p style="color:#64748b;font-size:0.88rem;margin:0 0 12px;">Choose which doctor portal sidebar modules this doctor can open. Hidden modules stay off their menu.</p>' +
            '<p style="font-size:0.88rem;margin:0 0 12px;">Doctor: <strong id="doctor-mod-access-label"></strong></p>' +
            '<input type="hidden" id="doctor-mod-access-user-id" value="">' +
            '<label style="display:block;font-size:0.85rem;font-weight:700;margin-bottom:6px;">Category</label>' +
            '<select id="doctor-mod-access-category" style="width:100%;max-width:280px;padding:8px;margin-bottom:12px;border:1px solid #cbd5e1;border-radius:8px;">' +
            '<option value="regular">Regular doctor</option><option value="volunteer">Volunteer doctor</option></select>' +
            '<label style="display:flex;align-items:center;gap:8px;font-size:0.9rem;margin-bottom:10px;"><input type="checkbox" id="doctor-mod-access-global"> Use the modules set for all doctors in this category</label>' +
            '<div id="doctor-mod-access-checks" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;"></div>' +
            '<p id="doctor-mod-access-msg" style="margin:10px 0 0;font-weight:600;font-size:0.88rem;"></p>' +
            '<button type="button" class="btn-primary" id="doctor-mod-access-save" style="margin-top:14px;width:100%;background:#0f766e;">Save module access</button>' +
            '</div>';
        document.body.appendChild(wrap);
        document.getElementById('doctor-mod-access-close').onclick = closeModal;
        wrap.addEventListener('click', (e) => {
            if (e.target === wrap) closeModal();
        });
        document.getElementById('doctor-mod-access-global').onchange = paintChecks;
        document.getElementById('doctor-mod-access-category').onchange = paintChecks;
        document.getElementById('doctor-mod-access-save').onclick = saveAccess;
    }

    function closeModal() {
        const el = document.getElementById('doctor-mod-access-modal');
        if (!el) return;
        el.classList.add('hidden');
        el.style.display = 'none';
    }

    function checkedMap() {
        const out = {};
        document.querySelectorAll('#doctor-mod-access-checks input[data-doc-mod]').forEach((inp) => {
            const id = inp.getAttribute('data-doc-mod');
            if (id) out[id] = !!inp.checked;
        });
        return out;
    }

    function paintChecks() {
        const box = document.getElementById('doctor-mod-access-checks');
        const useGlobal = !!(document.getElementById('doctor-mod-access-global') || {}).checked;
        const category = (document.getElementById('doctor-mod-access-category') || {}).value || 'regular';
        const uid = (document.getElementById('doctor-mod-access-user-id') || {}).value;
        const user = findDoctor(uid);
        const custom = parseModules(user && user.doctor_modules) || {};
        if (!box) return;
        box.innerHTML = tabDefs
            .map(([id, title]) => {
                let on = false;
                if (useGlobal) on = globalAllows(category, id);
                else if (Object.prototype.hasOwnProperty.call(custom, id)) on = !!custom[id];
                else on = globalAllows(category, id);
                return (
                    '<label style="display:flex;align-items:center;gap:8px;font-size:0.86rem;"><input type="checkbox" data-doc-mod="' +
                    esc(id) +
                    '"' +
                    (on ? ' checked' : '') +
                    (useGlobal ? ' disabled' : '') +
                    '> ' +
                    esc(title) +
                    '</label>'
                );
            })
            .join('');
        box.style.opacity = useGlobal ? '0.6' : '1';
    }

    async function loadDefs() {
        try {
            const res = await fetch('/api/public/doctor-portal-modules?_=' + Date.now(), { cache: 'no-store' });
            const data = await res.json();
            if (res.ok) {
                globals = { regular: data.regular || {}, volunteer: data.volunteer || {} };
                if (Array.isArray(data.tabDefs) && data.tabDefs.length) tabDefs = data.tabDefs;
            }
        } catch (_) {}
    }

    async function openDoctorModuleAccess(userId) {
        ensureModal();
        await loadDefs();
        const user = findDoctor(userId);
        const label = document.getElementById('doctor-mod-access-label');
        const idEl = document.getElementById('doctor-mod-access-user-id');
        const cat = document.getElementById('doctor-mod-access-category');
        const globalEl = document.getElementById('doctor-mod-access-global');
        const msg = document.getElementById('doctor-mod-access-msg');
        if (!user) {
            alert('Open the Doctors list again, then choose Module access.');
            return;
        }
        idEl.value = String(user.id);
        const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
        label.textContent = (name || 'Doctor') + (user.user_id_string ? ' · ' + user.user_id_string : '');
        cat.value = String(user.doctor_category || '').toLowerCase() === 'volunteer' ? 'volunteer' : 'regular';
        globalEl.checked = !hasCustom(user.doctor_modules);
        if (msg) msg.textContent = '';
        paintChecks();
        const modal = document.getElementById('doctor-mod-access-modal');
        modal.classList.remove('hidden');
        modal.style.display = 'flex';
    }

    async function saveAccess() {
        const msg = document.getElementById('doctor-mod-access-msg');
        const uid = parseInt((document.getElementById('doctor-mod-access-user-id') || {}).value, 10);
        const category = (document.getElementById('doctor-mod-access-category') || {}).value === 'volunteer' ? 'volunteer' : 'regular';
        const useGlobal = !!(document.getElementById('doctor-mod-access-global') || {}).checked;
        const modules = useGlobal ? {} : checkedMap();
        if (msg) {
            msg.style.color = '#0f766e';
            msg.textContent = 'Saving…';
        }
        try {
            const res = await fetch('/api/admin/users/' + uid + '/doctor-access', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    doctor_category: category,
                    doctor_modules: modules,
                    useGlobalModules: useGlobal
                })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) throw new Error(data.error || 'Could not save module access.');
            const user = findDoctor(uid);
            if (user) {
                user.doctor_category = category;
                user.doctor_modules = data.doctor_modules ? JSON.stringify(data.doctor_modules) : null;
            }
            const catSel = document.getElementById('doctor-cat-' + uid);
            if (catSel) catSel.value = category;
            if (msg) msg.textContent = 'Module access saved. The doctor sees this on their next portal refresh.';
        } catch (e) {
            if (msg) {
                msg.style.color = '#b91c1c';
                msg.textContent = e.message;
            }
        }
    }

    function decorateRows() {
        document.querySelectorAll('#doctors-list select[id^="doctor-cat-"]').forEach((sel) => {
            const cell = sel.parentElement;
            if (!cell || cell.querySelector('[data-doctor-mod-access]')) return;
            const id = sel.id.replace('doctor-cat-', '');
            if (!id) return;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.setAttribute('data-doctor-mod-access', '1');
            btn.className = 'btn-primary';
            btn.style.cssText = 'padding:5px 10px;font-size:0.8rem;margin-left:6px;background:#0369a1;';
            btn.textContent = 'Module access';
            btn.addEventListener('click', () => openDoctorModuleAccess(id));
            sel.insertAdjacentElement('afterend', btn);
        });
    }

    function boot() {
        ensureModal();
        decorateRows();
        const body = document.getElementById('doctors-list');
        if (body && !body.__doctorModWatch) {
            body.__doctorModWatch = true;
            new MutationObserver(() => decorateRows()).observe(body, { childList: true });
        }
    }

    window.openDoctorModuleAccess = openDoctorModuleAccess;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
