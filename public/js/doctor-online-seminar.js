/**
 * Shows an online seminar on the doctor card and opens the checked join link.
 */
(function () {
    function escapeText(value) {
        if (typeof escapeHtml === 'function') return escapeHtml(value);
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function noteHtml(seminar) {
        const online = seminar && seminar.online_seminar;
        if (!online || online.delivery_mode !== 'online') return '';
        const label = escapeText(online.provider_label || 'Online');
        return (
            '<div style="margin:8px 0 12px;padding:10px 12px;background:#f0fdfa;border:1px solid #99f6e4;border-radius:8px;">' +
            '<strong style="color:#0f766e;">Online seminar</strong> · ' +
            label +
            '<p style="margin:6px 0 0;font-size:0.82rem;color:#115e59;">Registered doctors join from this portal. The hall checks the ticket before it opens.</p>' +
            '<button type="button" class="btn-primary" style="margin-top:8px;background:#0f766e;" onclick="openOnlineSeminar(' +
            Number(seminar.id) +
            ')">Join online seminar</button></div>'
        );
    }

    if (typeof window.renderSeminarGridCard === 'function') {
        const orig = window.renderSeminarGridCard;
        window.renderSeminarGridCard = function (seminar) {
            const html = orig.apply(this, arguments);
            const note = noteHtml(seminar);
            if (!note || html.indexOf('</h3>') < 0) return html;
            return html.replace('</h3>', '</h3>' + note);
        };
    }

    window.openOnlineSeminar = async function (seminarId) {
        const user = (window.PortalAuth && PortalAuth.getUser && PortalAuth.getUser('doctor')) || window.currentUser || null;
        let stored = null;
        try {
            stored = JSON.parse(localStorage.getItem('seminar_doctor_user') || 'null');
        } catch (_) {
            stored = null;
        }
        const person = user || stored;
        if (!person || person.id == null) {
            alert('Sign in to the doctor portal, then join the online seminar.');
            return;
        }
        let passcode = '';
        const res1 = await fetch('/api/online-seminar/join', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                seminarId: Number(seminarId),
                userId: person.id,
                userIdString: person.user_id_string || ''
            })
        });
        let data = await res1.json().catch(() => ({}));
        if (res1.status === 401 && data.needsPasscode) {
            passcode = window.prompt('Enter the seminar passcode') || '';
            if (!passcode) return;
            const res2 = await fetch('/api/online-seminar/join', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    seminarId: Number(seminarId),
                    userId: person.id,
                    userIdString: person.user_id_string || '',
                    passcode: passcode
                })
            });
            data = await res2.json().catch(() => ({}));
            if (!res2.ok || !data.ok) {
                alert(data.error || 'The online seminar could not be opened.');
                return;
            }
        } else if (!res1.ok || !data.ok) {
            alert(data.error || 'The online seminar could not be opened.');
            return;
        }
        if (data.mode === 'hall') {
            if (data.token) sessionStorage.setItem('vgmf_hall_token_' + seminarId, data.token);
            window.location.href = data.url;
            return;
        }
        window.open(data.url, '_blank', 'noopener');
    };
})();
