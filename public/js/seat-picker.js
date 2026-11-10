/* Theatre-style seat picker for seminar registration (doctor portal) */
(function () {
    'use strict';
    const CSS = `
.sp-wrap{margin:18px 0;padding:18px;border:1px solid #e2e8f0;border-radius:14px;background:#fff}
.sp-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px}
.sp-head h4{margin:0;color:#0f766e;font-size:1rem}
.sp-timer{font-size:.8rem;color:#b45309;font-weight:700}
.sp-stage{margin:6px auto 18px;max-width:520px;height:30px;border-radius:0 0 60px 60px;background:linear-gradient(#cbd5e1,#e2e8f0);box-shadow:0 10px 18px -8px rgba(15,23,42,.35);display:flex;align-items:center;justify-content:center;font-size:.7rem;letter-spacing:.3em;color:#475569;font-weight:800}
.sp-scroll{overflow-x:auto;padding:8px 4px 12px}
.sp-rows{display:flex;flex-direction:column;gap:6px;align-items:center;min-width:max-content;margin:0 auto}
.sp-row{display:flex;align-items:center;gap:5px}
.sp-row.sp-space{margin-bottom:10px}
.sp-rlabel{width:26px;text-align:center;font-size:.72rem;font-weight:800;color:#64748b}
.sp-seat{width:26px;height:26px;border-radius:7px 7px 4px 4px;border:1.5px solid var(--c,#0f766e);background:#fff;color:#334155;font-size:.6rem;font-weight:700;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:transform .12s,background .12s}
.sp-seat:hover{transform:translateY(-2px);background:#f0fdfa}
.sp-seat.taken{background:#e2e8f0;border-color:#cbd5e1;color:#94a3b8;cursor:not-allowed}
.sp-seat.blocked{visibility:hidden}
.sp-seat.mine{background:var(--c,#0f766e);color:#fff;box-shadow:0 4px 10px -4px var(--c,#0f766e)}
.sp-gap{width:18px}
.sp-legend{display:flex;flex-wrap:wrap;gap:14px;font-size:.78rem;color:#475569;margin-top:10px;align-items:center}
.sp-legend span{display:inline-flex;align-items:center;gap:6px}
.sp-legend i{width:14px;height:14px;border-radius:4px;border:1.5px solid #0f766e;display:inline-block}
.sp-sel{margin-top:10px;font-weight:700;color:#0f172a}
.sp-sections{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 10px;font-size:.78rem}
.sp-sections span{display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:999px;background:#f8fafc;border:1px solid #e2e8f0}
.sp-sections i{width:10px;height:10px;border-radius:50%;display:inline-block}
.sp-curve .sp-row{transform:perspective(600px) rotateX(var(--rx,0deg))}
.sp-err{color:#b91c1c;font-size:.82rem;margin-top:8px}
`;
    let state = { sid: null, data: null, selected: [], timer: null, readOnly: false, loaded: false };

    function el(id) { return document.getElementById(id); }
    function uid() {
        const u = window.currentUser || {};
        return u.id || u.user_id || (window.getCurrentUserId ? window.getCurrentUserId() : null);
    }
    function ensureCss() {
        if (el('sp-css')) return;
        const st = document.createElement('style');
        st.id = 'sp-css';
        st.textContent = CSS;
        document.head.appendChild(st);
    }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

    async function load(sid, opts) {
        opts = opts || {};
        const box = el('reg-seat-picker');
        if (!box) return;
        state = { sid: Number(sid), data: null, selected: [], timer: null, readOnly: !!opts.readOnly, loaded: false };
        box.classList.add('hidden');
        box.innerHTML = '';
        try {
            const u = uid();
            const r = await fetch('/api/seminars/' + sid + '/seats' + (u ? '?userId=' + encodeURIComponent(u) : ''), { cache: 'no-store' });
            const d = await r.json();
            if (!d || !d.enabled) return;
            ensureCss();
            state.data = d;
            state.selected = d.mine || [];
            state.loaded = true;
            render();
            box.classList.remove('hidden');
        } catch (e) { console.error('seat map', e); }
    }

    function sectionOf(row) {
        const secs = state.data.map.sections || [];
        return secs[row.section] || secs[0] || { name: 'General', color: '#0f766e' };
    }

    function render() {
        const box = el('reg-seat-picker');
        const map = state.data.map;
        const taken = new Set(state.data.taken || []);
        const sel = new Set(state.selected);
        const secs = map.sections || [];
        const n = map.rows.length;
        const rowsHtml = map.rows.map((row, ri) => {
            const sec = sectionOf(row);
            const seats = [];
            for (let i = 1; i <= row.seats; i++) {
                const code = row.label + i;
                const blocked = row.blocked || (row.blockedSeats || []).includes(i);
                const cls = blocked ? 'blocked' : taken.has(code) ? 'taken' : sel.has(code) ? 'mine' : '';
                seats.push(`<button type="button" class="sp-seat ${cls}" data-code="${esc(code)}" style="--c:${esc(sec.color)}" title="${esc(code + (sec.price != null ? ' · ₹' + sec.price : ''))}" ${blocked || taken.has(code) || state.readOnly ? 'disabled' : ''}>${i}</button>`);
                if ((row.gapAfter || []).includes(i)) seats.push('<span class="sp-gap"></span>');
            }
            const rx = map.curve ? (((ri / Math.max(1, n - 1)) - 0.5) * -14).toFixed(1) + 'deg' : '0deg';
            return `<div class="sp-row ${row.spaceAfter ? 'sp-space' : ''}" style="--rx:${rx}"><span class="sp-rlabel">${esc(row.label)}</span>${seats.join('')}<span class="sp-rlabel">${esc(row.label)}</span></div>`;
        }).join('');
        const secHtml = secs.length > 1 || (secs[0] && secs[0].price != null)
            ? `<div class="sp-sections">${secs.map((s) => `<span><i style="background:${esc(s.color)}"></i>${esc(s.name)}${s.price != null ? ' · ₹' + esc(s.price) : ''}</span>`).join('')}</div>` : '';
        box.innerHTML = `
<div class="sp-wrap ${map.curve ? 'sp-curve' : ''}">
  <div class="sp-head"><h4>Choose your seat${map.maxPerBooking > 1 ? 's (up to ' + map.maxPerBooking + ')' : ''}</h4><span class="sp-timer" id="sp-timer"></span></div>
  ${secHtml}
  <div class="sp-stage">${esc(map.stageLabel || 'STAGE')}</div>
  <div class="sp-scroll"><div class="sp-rows">${rowsHtml}</div></div>
  <div class="sp-legend"><span><i></i>Available</span><span><i style="background:#0f766e"></i>Your seat</span><span><i style="background:#e2e8f0;border-color:#cbd5e1"></i>Taken</span></div>
  <div class="sp-sel" id="sp-sel"></div>
  <div class="sp-err" id="sp-err"></div>
</div>`;
        box.querySelectorAll('.sp-seat:not([disabled])').forEach((b) => b.addEventListener('click', () => toggle(b.dataset.code)));
        updateSel();
        startTimer();
    }

    function updateSel() {
        const s = el('sp-sel');
        if (s) s.textContent = state.selected.length ? 'Selected: ' + state.selected.join(', ') : 'No seat selected yet — tap a seat on the map.';
    }

    async function toggle(code) {
        const max = state.data.map.maxPerBooking || 1;
        let next = state.selected.slice();
        if (next.includes(code)) next = next.filter((c) => c !== code);
        else if (max === 1) next = [code];
        else if (next.length >= max) return showErr('You can select at most ' + max + ' seat(s).');
        else next.push(code);
        showErr('');
        try {
            const r = await fetch('/api/seminars/' + state.sid + '/seats/hold', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: uid(), seats: next })
            });
            const d = await r.json();
            if (!r.ok) {
                showErr(d.error || 'Could not hold that seat.');
                return refresh();
            }
            state.selected = d.held || [];
            state.data.holdUntil = d.holdUntil;
            render();
        } catch (e) { showErr('Network error — try again.'); }
    }

    async function refresh() {
        try {
            const u = uid();
            const r = await fetch('/api/seminars/' + state.sid + '/seats' + (u ? '?userId=' + encodeURIComponent(u) : ''), { cache: 'no-store' });
            const d = await r.json();
            if (d && d.enabled) { state.data = d; state.selected = d.mine || []; render(); }
        } catch (_) {}
    }

    function showErr(m) { const e = el('sp-err'); if (e) e.textContent = m || ''; }

    function startTimer() {
        if (state.timer) clearInterval(state.timer);
        const t = el('sp-timer');
        const tick = () => {
            if (!t) return;
            if (!state.selected.length || !state.data.holdUntil) { t.textContent = ''; return; }
            const ms = Date.parse(state.data.holdUntil) - Date.now();
            if (ms <= 0) { t.textContent = 'Hold expired — pick again'; state.selected = []; refresh(); return; }
            const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
            t.textContent = 'Seat held for ' + m + ':' + String(s).padStart(2, '0');
        };
        tick();
        state.timer = setInterval(tick, 1000);
    }

    function isActive(sid) { return state.loaded && Number(sid) === state.sid && !state.readOnly; }
    function validateForSubmit() {
        if (!state.loaded) return { ok: true, seats: [] };
        if (!state.selected.length) return { ok: false, error: 'Please choose your seat on the seat map before submitting.' };
        return { ok: true, seats: state.selected.slice() };
    }

    window.SeatPicker = { load, isActive, validateForSubmit, refresh };
})();
