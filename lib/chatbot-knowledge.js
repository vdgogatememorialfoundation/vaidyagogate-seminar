/**
 * Builds a text knowledge base for the public/doctor chatbot from live DB + CMS.
 */
function promisify(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
}

async function safeQuery(db, sql, params = []) {
    try {
        return await promisify(db, sql, params);
    } catch (e) {
        console.warn('[chatbot-knowledge]', e.message);
        return [];
    }
}

async function loadNotices(db) {
    let rows = await safeQuery(
        db,
        `SELECT n.message AS body, n.created_at, s.title AS seminar_title
         FROM notices n
         LEFT JOIN seminars s ON s.id = n.seminar_id
         ORDER BY n.id DESC LIMIT 25`
    );
    if (rows.length) return rows;
    rows = await safeQuery(
        db,
        `SELECT COALESCE(n.content, n.title, '') AS body, n.created_at, NULL AS seminar_title
         FROM notices n
         ORDER BY n.id DESC LIMIT 25`
    );
    if (rows.length) return rows;
    return safeQuery(db, `SELECT COALESCE(title, content, '') AS body, created_at, NULL AS seminar_title FROM notices ORDER BY id DESC LIMIT 25`);
}

async function buildChatbotKnowledge(db, loadPublicSiteCms) {
    const parts = [];
    parts.push(
        'Vaidya Gogate Memorial Foundation (VGMF) — seminar registration, payments, e-tickets, certificates, case presentation, volunteers, and support tickets.'
    );

    let cms = {};
    try {
        cms = await new Promise((resolve) => loadPublicSiteCms((e, c) => resolve(e ? {} : c || {})));
    } catch (_) {}

    if (cms.tickerText) parts.push(`Homepage ticker: ${cms.tickerText}`);
    if (Array.isArray(cms.aboutSections)) {
        cms.aboutSections.forEach((s) => {
            if (s && (s.heading || s.body)) parts.push(`About — ${s.heading || 'Section'}: ${s.body || ''}`);
        });
    }
    if (Array.isArray(cms.doctorUpdates)) {
        cms.doctorUpdates.forEach((u) => {
            if (u && u.title) parts.push(`Doctor portal update: ${u.title} — ${u.body || ''}`);
        });
    }
    if (Array.isArray(cms.publicNotices)) {
        cms.publicNotices.slice(0, 15).forEach((n) => {
            if (n && n.title) parts.push(`Notice: ${n.title} — ${n.body || ''}`);
        });
    }
    if (Array.isArray(cms.socialLinks)) {
        cms.socialLinks.forEach((s) => {
            if (s && s.platform) parts.push(`Follow us on ${s.platform}: ${s.label || ''} ${s.url || ''}`);
        });
    }

    const seminars = await safeQuery(
        db,
        `SELECT id, title, description, event_date, registration_start, registration_end, price, capacity,
                location_url, checkin_enabled, checkin_date, is_active, public_list_enabled
         FROM seminars ORDER BY event_date DESC LIMIT 40`
    );
    seminars.forEach((s) => {
        const bits = [
            `Seminar #${s.id}: ${s.title}`,
            s.is_active ? 'active' : 'inactive',
            s.event_date ? `event ${s.event_date}` : '',
            s.registration_start ? `reg opens ${s.registration_start}` : '',
            s.registration_end ? `reg closes ${s.registration_end}` : '',
            s.price != null ? `fee ₹${s.price}` : '',
            s.checkin_enabled ? `check-in enabled (date ${s.checkin_date || 'any'})` : '',
            s.public_list_enabled ? 'public participant list published on website' : ''
        ];
        parts.push(bits.filter(Boolean).join(' | '));
    });

    const notices = await loadNotices(db);
    notices.forEach((n) => {
        if (!n.body) return;
        parts.push(`Seminar notice (${n.seminar_title || 'general'}): ${n.body}`);
    });

    const schedules = await safeQuery(
        db,
        `SELECT es.title AS event_title, es.start_time, es.end_time, es.location, s.title AS seminar_title
         FROM event_schedules es
         LEFT JOIN seminars s ON es.seminar_id = s.id
         ORDER BY es.start_time ASC LIMIT 60`
    );
    schedules.forEach((e) => {
        parts.push(
            `Schedule: ${e.seminar_title || 'Event'} — ${e.event_title || 'Session'} ${e.start_time || ''} to ${e.end_time || ''} at ${e.location || 'TBA'}`
        );
    });

    const tickets = await safeQuery(
        db,
        `SELECT COALESCE(st.ticket_id, st.tracking_id) AS ticket_ref, st.status, st.category
         FROM support_tickets st
         ORDER BY st.id DESC LIMIT 20`
    );
    tickets.forEach((t) => {
        parts.push(
            `Support ticket ${t.ticket_ref || ''} (${t.status || ''}${t.category ? ', ' + t.category : ''}) — use Feedback & Support in the doctor portal.`
        );
    });

    const caseProgs = await safeQuery(
        db,
        `SELECT title, instructions, registration_start, registration_end, enabled_categories
         FROM case_programs WHERE is_active = 1 ORDER BY id DESC LIMIT 10`
    );
    caseProgs.forEach((p) => {
        parts.push(
            `Case presentation program: ${p.title}. Categories: ${p.enabled_categories || 'agnikarma,viddhakarma'}. ${p.instructions || ''}`
        );
    });

    parts.push(
        'Support: raise a ticket in the doctor portal under Feedback & Support, or use the Help button on the main website. Track application numbers in the website chat.'
    );
    parts.push(
        'Registration: each seminar may have its own form fields configured by admin. Pay after approval; e-ticket QR appears under View Tickets.'
    );
    parts.push(
        'Volunteers: eligible doctors can apply under the Volunteers section in the doctor portal when that module is enabled for their account. If registration fails, sign in and use Feedback & Support with your portal ID.'
    );
    parts.push('Social: YouTube, Facebook, Instagram — search "Vaidya Gogate Memorial Foundation".');

    return parts.join('\n');
}

function answerFromKnowledge(message, knowledge, userContext) {
    const m = String(message || '').toLowerCase().trim();
    let reply =
        'I can help with seminars, registration, payments, e-tickets, certificates, case presentation, volunteers, schedules, notices, and support tickets. Ask a specific question or log in to see your application status.';

    if (/^(hi|hello|hey|namaste|good morning|good evening|good afternoon)\b/.test(m)) {
        return 'Hello! Ask about seminar registration, application status, e-tickets, volunteers, or say "talk to agent" during support hours.';
    }

    if (m.includes('volunteer')) {
        return 'Volunteer registration is in the doctor portal under Volunteers (when enabled for your account). Sign in with your portal ID, complete the volunteer form, and submit. If the module is missing or registration fails, open Feedback & Support and mention your portal ID — our team will help.';
    }

    if (m.includes('support') || m.includes('ticket') || m.includes('help')) {
        reply =
            'Open the doctor portal → Feedback & Support → New support ticket. You can continue the conversation in the same thread when an admin replies.';
        return reply;
    }
    if (m.includes('instagram') || m.includes('facebook') || m.includes('youtube') || m.includes('social')) {
        reply =
            'Follow Vaidya Gogate Memorial Foundation on YouTube, Facebook, and Instagram. Links are on the website footer when configured in admin Website settings.';
        return reply;
    }
    if (m.includes('about') || m.includes('foundation') || m.includes('vgmf')) {
        const about = knowledge.split('\n').filter((l) => l.startsWith('About —'));
        reply = about.length
            ? about.slice(0, 3).join('\n')
            : 'Vaidya Gogate Memorial Foundation promotes Ayurveda education through national seminars, case presentations, and continuing medical education.';
        return reply;
    }
    if (m.includes('gallery') || m.includes('past seminar')) {
        reply = 'Past seminar photos are shown in the Gallery section on the homepage when uploaded in Admin → Website & doctor updates.';
        return reply;
    }
    if (m.includes('participant') && (m.includes('list') || m.includes('verify') || m.includes('published'))) {
        reply =
            'When admin enables the public participant list for a seminar (after records and payments are complete), you can verify registration on the website under Participant verification.';
        return reply;
    }
    if (m.includes('check') && m.includes('in')) {
        reply =
            'Event check-in uses your e-ticket QR at the venue. Scanner staff must select the correct seminar before scanning; check-in only works on the configured check-in date (local timezone).';
        return reply;
    }
    if (m.includes('seminar') || m.includes('register') || m.includes('fee') || m.includes('date')) {
        const hits = knowledge
            .split('\n')
            .filter((l) => l.includes('Seminar #') || l.includes('reg opens') || l.includes('fee'));
        reply = hits.length ? hits.slice(0, 6).join('\n') : 'Browse seminars in the doctor portal under Available Seminars.';
        return reply;
    }
    if ((m.includes('status') || m.includes('application')) && userContext && userContext.registrations) {
        if (!userContext.registrations.length) return 'You have no registrations yet.';
        return (
            'Your applications:\n' +
            userContext.registrations.map((r) => `${r.title}: ${r.application_no} — ${r.status}`).join('\n')
        );
    }
    if (m.includes('schedule') || m.includes('timing')) {
        const hits = knowledge.split('\n').filter((l) => l.startsWith('Schedule:'));
        reply = hits.length ? hits.slice(0, 8).join('\n') : 'See the Schedule section on the website or event details in your doctor portal.';
        return reply;
    }
    if (m.includes('notice') || m.includes('announcement')) {
        const hits = knowledge.split('\n').filter((l) => l.startsWith('Notice:') || l.startsWith('Seminar notice'));
        reply = hits.length ? hits.slice(0, 5).join('\n') : 'Check the Official Notices board on the homepage.';
        return reply;
    }
    if (m.includes('case') || m.includes('agnikarma') || m.includes('viddhakarma') || m.includes('abstract')) {
        const hits = knowledge.split('\n').filter((l) => l.includes('Case presentation'));
        reply = hits.length ? hits.join('\n') : 'Case presentation applications are in the doctor portal under Case presentation application.';
        return reply;
    }

    return reply;
}

module.exports = { buildChatbotKnowledge, answerFromKnowledge };
