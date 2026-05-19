/**
 * Admin — platform & user health monitors (realtime polling).
 */
(function () {
    let platformTimer = null;
    let usersTimer = null;
    let lastPlatformReport = null;
    let lastUsersReport = null;

    function getActorId() {
        try {
            const u = JSON.parse(localStorage.getItem('admin_user') || '{}');
            return u && u.id ? Number(u.id) : null;
        } catch (_) {
            return null;
        }
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;');
    }

    function renderReport(containerId, report) {
        const el = document.getElementById(containerId);
        if (!el || !report) return;
        const ok = report.overall === 'ok';
        const badge = ok
            ? '<span style="background:#dcfce7;color:#166534;padding:6px 14px;border-radius:999px;font-weight:800;">Running Success</span>'
            : '<span style="background:#fee2e2;color:#991b1b;padding:6px 14px;border-radius:999px;font-weight:800;">Issues detected</span>';
        const rows = (report.components || [])
            .map((c) => {
                const icon = c.status === 'ok' ? '✓' : '✗';
                const color = c.status === 'ok' ? '#166534' : '#b91c1c';
                return `<div style="display:flex;gap:12px;align-items:flex-start;padding:10px 12px;border-bottom:1px solid #e2e8f0;">
                    <span style="color:${color};font-weight:800;min-width:18px;">${icon}</span>
                    <div style="flex:1;">
                        <strong>${esc(c.label)}</strong>
                        <div style="font-size:0.88rem;color:#475569;margin-top:2px;">${esc(c.message)}</div>
                        ${c.detail && c.status !== 'ok' ? `<div style="font-size:0.82rem;color:#64748b;margin-top:4px;">${esc(c.detail)}</div>` : ''}
                        ${c.fixHint && c.status !== 'ok' ? `<div style="font-size:0.8rem;color:#0369a1;margin-top:4px;">${esc(c.fixHint)}</div>` : ''}
                    </div>
                </div>`;
            })
            .join('');
        el.innerHTML =
            `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-bottom:14px;">${badge}<span style="color:#64748b;font-size:0.85rem;">Updated ${esc(
                new Date(report.checkedAt || Date.now()).toLocaleTimeString()
            )}</span></div>` + rows;
    }

    function collectErrorIds(report) {
        return (report && report.components ? report.components : [])
            .filter((c) => c.status === 'error')
            .map((c) => c.id);
    }

    async function fetchReport(scope) {
        const aid = getActorId();
        if (!aid) throw new Error('Sign in as admin first.');
        const path =
            scope === 'users' ? '/api/admin/system-health/users' : '/api/admin/system-health/platform';
        const res = await fetch(path + '?actingAdminId=' + encodeURIComponent(aid));
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Health check failed');
        return data.report;
    }

    async function refreshPlatform() {
        const status = document.getElementById('sys-platform-status');
        try {
            lastPlatformReport = await fetchReport('platform');
            renderReport('sys-platform-components', lastPlatformReport);
            if (status) status.textContent = lastPlatformReport.overallLabel || '';
            const errIds = collectErrorIds(lastPlatformReport);
            if (errIds.length) await runAutoFix(errIds, 'sys-platform-ai-out');
        } catch (e) {
            if (status) status.textContent = e.message;
        }
    }

    async function refreshUsers() {
        const status = document.getElementById('sys-users-status');
        try {
            lastUsersReport = await fetchReport('users');
            renderReport('sys-users-components', lastUsersReport);
            if (status) status.textContent = lastUsersReport.overallLabel || '';
            const errIds = collectErrorIds(lastUsersReport);
            if (errIds.length) await runAutoFix(errIds, 'sys-users-ai-out');
        } catch (e) {
            if (status) status.textContent = e.message;
        }
    }

    async function runAutoFix(issueIds, outId) {
        const aid = getActorId();
        if (!aid || !issueIds || !issueIds.length) return;
        const out = document.getElementById(outId);
        try {
            const res = await fetch('/api/admin/system-health/auto-fix', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ actingAdminId: aid, issueIds })
            });
            const data = await res.json();
            if (out) {
                const lines = (data.actions || [])
                    .map((a) => (a.ok ? '✓ ' : '• ') + a.action + (a.detail ? ': ' + a.detail : ''))
                    .join('\n');
                out.textContent = (data.summary || '') + (lines ? '\n' + lines : '');
            }
        } catch (e) {
            if (out) out.textContent = 'Auto-fix: ' + e.message;
        }
    }

    async function runAiAnalyze(scope) {
        const aid = getActorId();
        const report = scope === 'users' ? lastUsersReport : lastPlatformReport;
        const outId = scope === 'users' ? 'sys-users-ai-out' : 'sys-platform-ai-out';
        const out = document.getElementById(outId);
        if (!aid || !report) {
            if (out) out.textContent = 'Run a health check first.';
            return;
        }
        if (out) out.textContent = 'Analyzing…';
        try {
            const res = await fetch('/api/admin/system-health/ai-analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ actingAdminId: aid, report })
            });
            const data = await res.json();
            if (out) out.textContent = (data.analysis && data.analysis.text) || 'No analysis.';
        } catch (e) {
            if (out) out.textContent = e.message;
        }
    }

    function stopTimers() {
        if (platformTimer) clearInterval(platformTimer);
        if (usersTimer) clearInterval(usersTimer);
        platformTimer = null;
        usersTimer = null;
    }

    window.initAdminSystemHealth = function initAdminSystemHealth(scope) {
        stopTimers();
        if (scope === 'users') {
            refreshUsers();
            usersTimer = setInterval(refreshUsers, 12000);
        } else {
            refreshPlatform();
            platformTimer = setInterval(refreshPlatform, 12000);
        }
    };

    window.adminSystemHealthManualFix = function (scope) {
        const report = scope === 'users' ? lastUsersReport : lastPlatformReport;
        const ids = collectErrorIds(report);
        if (!ids.length) {
            alert('All components report Running Success.');
            return;
        }
        runAutoFix(ids, scope === 'users' ? 'sys-users-ai-out' : 'sys-platform-ai-out');
    };

    window.adminSystemHealthAiAnalyze = runAiAnalyze;
})();
