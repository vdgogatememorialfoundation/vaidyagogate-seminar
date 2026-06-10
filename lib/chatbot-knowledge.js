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
            `Support ticket ${t.ticket_ref || ''} (${t.status || ''}${t.category ? ', ' + t.category : ''}) — use Support tickets in the doctor portal.`
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
        'Support: raise a ticket under Support tickets in the doctor portal, use Live chat during business hours, or use the Help button on the main website. Live chat references look like LCHAT-384729105638.'
    );
    parts.push(
        'Registration: each seminar may have its own form fields configured by admin. Pay after approval; e-ticket QR appears under View Tickets in the doctor portal.'
    );
    parts.push(
        'E-tickets: after payment, open View Tickets in the doctor portal and show the QR code at venue check-in. One QR per registration.'
    );
    parts.push(
        'Certificates: after venue check-in, participation certificates are issued automatically. Download them year-by-year from the Certificates tab in the doctor portal. Public authenticity verification is at /verify-certificate.html (email + WhatsApp OTP).'
    );
    parts.push(
        'Payments: pay approved seminar fees via Razorpay, Cashfree, or Juspay Hyper Checkout in the doctor portal. Receipts appear under Payment receipts.'
    );
    parts.push(
        'AI assistant: this chat can answer registration, payment, e-ticket, certificate, volunteer, book orders, and support questions. For application status, sign in or provide your application number.'
    );
    parts.push(
        'Books: order Agnikarma & Viddhakarma books in the doctor portal Books section — collect at seminar desk or courier delivery with tracking.'
    );
    parts.push(
        'Scanner / check-in: venue staff use the scanner portal with the correct seminar selected. Check-in only on the configured check-in date (IST).'
    );
    parts.push(
        'Volunteers: eligible doctors can apply under the Volunteers section in the doctor portal when that module is enabled for their account. If registration fails, sign in and use Support tickets with your portal ID.'
    );
    parts.push('Social: YouTube, Facebook, Instagram — search "Vaidya Gogate Memorial Foundation".');

    return parts.join('\n');
}

const SEMINAR_REGISTRATION_STEPS =
    'To register for a seminar:\n' +
    '1. Open the doctor portal (/doctor.html) and sign in — create an account if you are new.\n' +
    '2. Go to Available Seminars and choose a seminar with registration open.\n' +
    '3. Complete the application form and upload any required documents.\n' +
    '4. Submit and track status under My Applications.\n' +
    '5. After admin approves your application, pay the seminar fee from My Applications or Payments.\n' +
    '6. After payment, your e-ticket QR appears under View Tickets — show it at venue check-in.';

function seminarLinesFromKnowledge(knowledge, limit) {
    return String(knowledge || '')
        .split('\n')
        .filter((l) => /^Seminar #\d+:/.test(l))
        .slice(0, limit || 6);
}

function activeSeminarLinesFromKnowledge(knowledge, limit) {
    return seminarLinesFromKnowledge(knowledge, 40).filter(
        (l) => /\bactive\b/i.test(l) && !/\binactive\b/i.test(l)
    ).slice(0, limit || 5);
}

function isSeminarRegistrationQuestion(m) {
    if (/(case presentation|case program|abstract|agnikarma|viddhakarma)/.test(m)) return false;
    if (/(payment|receipt|razorpay|cashfree|juspay)/.test(m) && !/(register|registration|apply|sign up|join)/.test(m)) {
        return false;
    }
    return (
        /(how|where|steps?|way|process|guide|can i|do i|want to).*(register|registration|apply|sign up|join|enrol)/.test(m) ||
        /(register|registration|apply|sign up|join|enrol).*(seminar|event|course|program)/.test(m) ||
        /seminar.*(register|registration|apply|sign up|join)/.test(m) ||
        /(new account|create account|doctor account).*(seminar|register)/.test(m) ||
        /^(register|registration|apply)$/.test(m)
    );
}

function isPaymentQuestion(m) {
    return /(payment|receipt|razorpay|cashfree|juspay|how to pay|pay fee|pay for|make payment|pending payment)/.test(m);
}

function isCasePresentationQuestion(m) {
    return /(case presentation|case program|abstract|agnikarma|viddhakarma)/.test(m);
}

function isSupportTicketQuestion(m) {
    return (
        (m.includes('support') || m.includes('ticket') || m.includes('help')) &&
        !/(register|registration|apply|seminar fee|e-ticket|certificate)/.test(m)
    );
}

function isLiveAgentQuestion(m) {
    return (
        m.includes('live chat') ||
        /\btalk to\b/.test(m) ||
        /\bagent\b/.test(m) ||
        m.includes('human') ||
        m.includes('real person')
    );
}

function answerFromKnowledge(message, knowledge, userContext) {
    const m = String(message || '').toLowerCase().trim();
    const fallback =
        'I can help with seminar registration steps, application status, payments, e-tickets, certificates, case presentation, volunteers, schedules, and support tickets. Ask a specific question — for example: "How do I register for a seminar?"';

    if (/^(hi|hello|hey|namaste|good morning|good evening|good afternoon)\b/.test(m)) {
        return {
            reply: 'Hello! Ask how to register for a seminar, check application status, get your e-ticket, download certificates, or say "talk to agent" during support hours.',
            suggestLiveChat: false
        };
    }

    if (isLiveAgentQuestion(m)) {
        return {
            reply: 'During support hours, tap "Talk to a support agent" in this chat or sign in to the doctor portal and use the live chat button (bottom right). You will receive a chat reference like LCHAT-384729105638.',
            suggestLiveChat: true
        };
    }

    if (isSeminarRegistrationQuestion(m)) {
        const open = activeSeminarLinesFromKnowledge(knowledge, 4);
        let reply = SEMINAR_REGISTRATION_STEPS;
        if (open.length) {
            reply += '\n\nCurrently listed seminars (sign in to apply):\n' + open.join('\n');
        }
        return { reply, suggestLiveChat: false };
    }

    if (/(create account|new account|sign up|doctor portal login|how to login|log in)/.test(m)) {
        return {
            reply:
                'Create your doctor portal account at /doctor.html → Register. Use your email and mobile for OTP verification. After sign-in, open Available Seminars to apply for open events.',
            suggestLiveChat: false
        };
    }

    if ((m.includes('status') || m.includes('application') || m.includes('where is my')) && userContext) {
        if (userContext.track && !userContext.track.error) {
            const tr = userContext.track;
            if (tr.type === 'seminar') {
                return {
                    reply:
                        `Seminar application ${tr.applicationNo}: ${tr.status}` +
                        (tr.seminarTitle ? ` (${tr.seminarTitle})` : '') +
                        '. Sign in to the doctor portal → My Applications for full details.',
                    suggestLiveChat: false
                };
            }
            if (tr.type === 'case') {
                return {
                    reply: `Case submission ${tr.applicationNo}: ${tr.status}. Check the Case presentation tab in the doctor portal.`,
                    suggestLiveChat: false
                };
            }
            if (tr.type === 'support_ticket') {
                return {
                    reply: `Support ticket ${tr.ticketRef}: ${tr.status}. Replies appear in the doctor portal under Support tickets.`,
                    suggestLiveChat: false
                };
            }
        }
        if (userContext.registrations) {
            if (!userContext.registrations.length) {
                return { reply: 'You have no registrations yet. Open Available Seminars in the doctor portal to apply.', suggestLiveChat: false };
            }
            return {
                reply:
                    'Your applications:\n' +
                    userContext.registrations.map((r) => `${r.title}: ${r.application_no} — ${r.status}`).join('\n'),
                suggestLiveChat: false
            };
        }
    }

    if (isPaymentQuestion(m)) {
        return {
            reply:
                'Payment is step 5 after your seminar application is approved:\n' +
                '1. Sign in to the doctor portal.\n' +
                '2. Open My Applications (or Payments) and select the approved registration.\n' +
                '3. Pay using Razorpay, Cashfree, or Juspay Hyper Checkout (whichever is enabled).\n' +
                '4. Receipts appear under Payment receipts; your e-ticket QR appears under View Tickets after successful payment.',
            suggestLiveChat: false
        };
    }

    if (m.includes('e-ticket') || m.includes('e ticket') || (m.includes('qr') && !m.includes('certificate'))) {
        return {
            reply:
                'After your application is approved and payment is successful, open View Tickets in the doctor portal. Show the QR code at the venue for check-in (one QR per registration).',
            suggestLiveChat: false
        };
    }

    if (m.includes('certificate') || m.includes('cmc') || m.includes('cme')) {
        return {
            reply:
                'After venue check-in, your participation certificate is issued automatically. Open the doctor portal → Certificates to browse by year and download PDFs. Verify authenticity at /verify-certificate.html using the QR code on your certificate.',
            suggestLiveChat: false
        };
    }

    if (m.includes('verify') && m.includes('certificate')) {
        return {
            reply:
                'Certificate verification is at /verify-certificate.html. Scan the QR on the certificate or enter your application / registration number, then confirm with email and WhatsApp OTP.',
            suggestLiveChat: false
        };
    }

    if (isCasePresentationQuestion(m)) {
        const hits = String(knowledge || '')
            .split('\n')
            .filter((l) => l.includes('Case presentation'));
        const extra = hits.length ? '\n\n' + hits.join('\n') : '';
        return {
            reply:
                'Case presentation is separate from seminar registration:\n' +
                '1. Sign in to the doctor portal.\n' +
                '2. Open Case presentation application.\n' +
                '3. Choose the open program and category (Agnikarma / Viddhakarma when enabled).\n' +
                '4. Submit your case details and documents as instructed.' +
                extra,
            suggestLiveChat: false
        };
    }

    if (m.includes('volunteer')) {
        return {
            reply:
                'Volunteer registration is in the doctor portal under Volunteers (when enabled for your account). Sign in, complete the volunteer form, and submit. If the module is missing, open Support tickets with your portal ID.',
            suggestLiveChat: false
        };
    }

    if (isSupportTicketQuestion(m)) {
        return {
            reply:
                'Open the doctor portal → Support tickets → New support ticket. Describe your issue and submit. You can continue the conversation in the same thread when our team replies.',
            suggestLiveChat: true
        };
    }

    if (m.includes('instagram') || m.includes('facebook') || m.includes('youtube') || m.includes('social')) {
        return {
            reply:
                'Follow Vaidya Gogate Memorial Foundation on YouTube, Facebook, and Instagram. Links are on the website footer when configured in admin Website settings.',
            suggestLiveChat: false
        };
    }

    if (m.includes('about') || m.includes('foundation') || m.includes('vgmf')) {
        const about = String(knowledge || '')
            .split('\n')
            .filter((l) => l.startsWith('About —'));
        return {
            reply: about.length
                ? about.slice(0, 3).join('\n')
                : 'Vaidya Gogate Memorial Foundation promotes Ayurveda education through national seminars, case presentations, and continuing medical education.',
            suggestLiveChat: false
        };
    }

    if (m.includes('gallery') || m.includes('past seminar')) {
        return {
            reply: 'Past seminar photos are shown in the Gallery section on the homepage when uploaded in Admin → Website & doctor updates.',
            suggestLiveChat: false
        };
    }

    if (m.includes('participant') && (m.includes('list') || m.includes('verify') || m.includes('published'))) {
        return {
            reply:
                'When admin enables the public participant list for a seminar, you can verify registration on the website under Participant verification.',
            suggestLiveChat: false
        };
    }

    if (m.includes('check') && m.includes('in')) {
        return {
            reply:
                'Event check-in uses your e-ticket QR at the venue. Scanner staff must select the correct seminar; check-in only works on the configured check-in date (IST).',
            suggestLiveChat: false
        };
    }

    if (m.includes('schedule') || m.includes('timing') || m.includes('programme') || m.includes('program')) {
        const hits = String(knowledge || '')
            .split('\n')
            .filter((l) => l.startsWith('Schedule:'));
        return {
            reply: hits.length ? hits.slice(0, 8).join('\n') : 'See the Schedule section on the website or event details in your doctor portal.',
            suggestLiveChat: false
        };
    }

    if (m.includes('notice') || m.includes('announcement')) {
        const hits = String(knowledge || '')
            .split('\n')
            .filter((l) => l.startsWith('Notice:') || l.startsWith('Seminar notice'));
        return {
            reply: hits.length ? hits.slice(0, 5).join('\n') : 'Check the Official Notices board and homepage ticker for updates.',
            suggestLiveChat: false
        };
    }

    if (m.includes('book') || m.includes('courier') || m.includes('shipment')) {
        return {
            reply:
                'Order Dr. R.B. Gogate books (Agnikarma & Viddhakarma) in the doctor portal under Books. Choose seminar desk pickup or courier delivery with tracking.',
            suggestLiveChat: false
        };
    }

    if (m.includes('scanner') || (m.includes('scan') && m.includes('qr'))) {
        return {
            reply:
                'Venue staff scan e-ticket QR codes in the scanner portal. The correct seminar must be selected; check-in works only on the configured check-in date (IST).',
            suggestLiveChat: false
        };
    }

    if (m.includes('seminar') || m.includes('fee') || m.includes('date') || m.includes('upcoming')) {
        const hits = activeSeminarLinesFromKnowledge(knowledge, 6);
        return {
            reply: hits.length
                ? 'Active seminars:\n' + hits.join('\n') + '\n\nTo register, sign in at /doctor.html → Available Seminars.'
                : 'Browse seminars in the doctor portal under Available Seminars when registration is open.',
            suggestLiveChat: false
        };
    }

    return { reply: fallback, suggestLiveChat: true };
}

module.exports = { buildChatbotKnowledge, answerFromKnowledge };
