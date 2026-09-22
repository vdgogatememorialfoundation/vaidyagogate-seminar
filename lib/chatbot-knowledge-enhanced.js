/**
 * Enhanced chatbot knowledge base for VGMF - includes comprehensive seminar, case presentation, payment, and support information.
 * Features: Email OTP verification, transcript emails, payment links, case tracking, and more conversational responses.
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
        console.warn('[chatbot-knowledge-enhanced]', e.message);
        return [];
    }
}

async function buildChatbotKnowledge(db, loadPublicSiteCms) {
    const parts = [];
    parts.push('Vaidya Gogate Memorial Foundation (VGMF) - Your trusted partner for Ayurveda education through national seminars, case presentations, and continuing medical education.');

    let cms = {};
    try {
        cms = await new Promise((resolve) => loadPublicSiteCms((e, c) => resolve(e ? {} : c || {})));
    } catch (_) {}

    if (cms.tickerText) parts.push('Latest Update: ' + cms.tickerText);
    if (Array.isArray(cms.aboutSections)) {
        cms.aboutSections.forEach((s) => {
            if (s && (s.heading || s.body)) parts.push('About - ' + (s.heading || 'Section') + ': ' + (s.body || ''));
        });
    }
    if (Array.isArray(cms.doctorUpdates)) {
        cms.doctorUpdates.forEach((u) => {
            if (u && u.title) parts.push('Doctor Portal Update: ' + u.title + ' - ' + (u.body || ''));
        });
    }
    if (Array.isArray(cms.publicNotices)) {
        cms.publicNotices.slice(0, 20).forEach((n) => {
            if (n && n.title) parts.push('Notice: ' + n.title + ' - ' + (n.body || ''));
        });
    }
    if (Array.isArray(cms.socialLinks)) {
        cms.socialLinks.forEach((s) => {
            if (s && s.platform) parts.push('Follow us on ' + s.platform + ': ' + (s.label || '') + ' ' + (s.url || ''));
        });
    }

    // Enhanced seminar data with more details
    const seminars = await safeQuery(
        db,
        `SELECT id, title, description, event_date, registration_start, registration_end, price, capacity,
                location_url, checkin_enabled, checkin_date, is_active, public_list_enabled, venue_address
         FROM seminars ORDER BY event_date DESC LIMIT 50`
    );
    seminars.forEach((s) => {
        const bits = [
            'Seminar #' + s.id + ': ' + s.title,
            s.is_active ? 'Status: ACTIVE' : 'Status: Inactive',
            s.event_date ? 'Event Date: ' + s.event_date : '',
            s.registration_start ? 'Registration Opens: ' + s.registration_start : '',
            s.registration_end ? 'Registration Closes: ' + s.registration_end : '',
            s.price != null ? 'Registration Fee: Rs. ' + s.price : 'Fee: Contact for details',
            s.capacity ? 'Capacity: ' + s.capacity + ' participants' : '',
            s.venue_address ? 'Venue: ' + s.venue_address : (s.location_url ? 'Location: ' + s.location_url : ''),
            s.checkin_enabled ? 'Check-in Enabled (Date: ' + (s.checkin_date || 'Event day') + ')' : '',
            s.public_list_enabled ? 'Public participant list available' : ''
        ];
        parts.push(bits.filter(Boolean).join(' | '));
    });

    // Notices
    const notices = await safeQuery(
        db,
        `SELECT n.message AS body, n.created_at, s.title AS seminar_title
         FROM notices n LEFT JOIN seminars s ON s.id = n.seminar_id
         ORDER BY n.id DESC LIMIT 50`
    );
    notices.forEach((n) => {
        if (!n.body) return;
        parts.push('Announcement (' + (n.seminar_title || 'General') + '): ' + n.body);
    });

    // Event schedules
    const schedules = await safeQuery(
        db,
        `SELECT es.title AS event_title, es.start_time, es.end_time, es.location, es.description, s.title AS seminar_title
         FROM event_schedules es LEFT JOIN seminars s ON es.seminar_id = s.id
         ORDER BY es.start_time ASC LIMIT 80`
    );
    schedules.forEach((e) => {
        parts.push(
            'Schedule (' + (e.seminar_title || 'Event') + '): ' + (e.event_title || 'Session') + ' | ' +
            (e.start_time || '') + ' to ' + (e.end_time || '') + ' | Location: ' + (e.location || 'TBA') +
            (e.description ? ' | ' + e.description : '')
        );
    });

    // Case presentation programs
    const caseProgs = await safeQuery(
        db,
        `SELECT cp.id, cp.title, cp.instructions, cp.registration_start, cp.registration_end, 
                cp.enabled_categories, cp.max_participants, cp.is_active,
                (SELECT COUNT(*) FROM case_submissions cs WHERE cs.program_id = cp.id) as submission_count
         FROM case_programs cp WHERE cp.is_active = 1 ORDER BY cp.id DESC LIMIT 20`
    );
    caseProgs.forEach((p) => {
        parts.push(
            'Case Presentation Program #' + p.id + ': ' + p.title +
            ' | Categories: ' + (p.enabled_categories || 'Agnikarma, Viddhakarma') +
            ' | Reg: ' + (p.registration_start || 'TBA') + ' to ' + (p.registration_end || 'TBA') +
            ' | Max Participants: ' + (p.max_participants || 'Unlimited') +
            ' | Submissions: ' + p.submission_count +
            (p.instructions ? ' | Instructions: ' + p.instructions.substring(0, 200) : '')
        );
    });

    // Payment information
    parts.push('PAYMENT METHODS: Razorpay (cards, UPI, netbanking, wallets), Cashfree, Juspay, Easebuzz, PayU, Paytm, PhonePe, Zoho Payments - all available in doctor portal after approval.');
    parts.push('PAYMENT FLOW: Application approved -> Go to Payments -> Generate payment link -> Complete payment -> Receipt generated -> E-ticket available');
    
    // E-ticket information
    parts.push('E-TICKETS: After successful payment, e-tickets with QR codes appear in View Tickets section. One QR per registration. Show at venue check-in on configured date.');
    
    // Certificate information
    parts.push('CERTIFICATES: Issued automatically after venue check-in. Download from Certificates section by year. Verify at /verify-certificate using QR or application number + OTP.');
    
    // Support information
    parts.push('SUPPORT: Use Support tickets in doctor portal for formal requests. Live chat available during business hours (typically Mon-Sat, 9 AM - 6 PM IST). Chat references look like LCHAT-XXXXXXXXXXXX.');
    
    // OTP verification
    parts.push('EMAIL VERIFICATION: OTP sent to registered email for account verification, certificate verification, and password reset. Valid for 10 minutes. Check spam folder if not received.');
    
    // Transcript email
    parts.push('CHAT TRANSCRIPT: Users can request chat transcript via email for their records. Provide email address to receive full conversation.');

    return parts.join('\n');
}

const SEMINAR_REGISTRATION_STEPS =
    'SEMINAR REGISTRATION PROCESS:\n' +
    '1. Visit /doctor and click "Create Account" or "Register"\n' +
    '2. Enter your details (name, email, phone with WhatsApp preferred)\n' +
    '3. Verify your email with the OTP sent to your inbox\n' +
    '4. Set your password and complete sign-in\n' +
    '5. Go to "Available Seminars" section\n' +
    '6. Select a seminar with open registration\n' +
    '7. Fill and submit the application form\n' +
    '8. Track status under "Track seminar applications"\n' +
    '9. Once approved, go to "Payments" to pay the fee\n' +
    '10. After payment, download your e-ticket from "Participant Tickets"\n' +
    '11. Show QR code at venue for check-in\n' +
    '12. After event, download your certificate from "Certificates"';

const CASE_PRESENTATION_STEPS =
    'CASE PRESENTATION APPLICATION PROCESS:\n' +
    '1. Sign in to doctor portal (/doctor)\n' +
    '2. Go to "Case presentation" section\n' +
    '3. Choose from available programs (Agnikarma or Viddhakarma)\n' +
    '4. Fill the case details form\n' +
    '5. Upload required documents/images\n' +
    '6. Submit your application\n' +
    '7. Track under "Track case applications" with CASE-XXXXXX number\n' +
    '8. Once reviewed, present your case at the seminar\n' +
    '9. Receive case presentation certificate after completion';

function seminarLinesFromKnowledge(knowledge, limit) {
    return String(knowledge || '')
        .split('\n')
        .filter((l) => /^Seminar #\d+:/.test(l))
        .slice(0, limit || 8);
}

function activeSeminarLinesFromKnowledge(knowledge, limit) {
    return seminarLinesFromKnowledge(knowledge, 40).filter(
        (l) => /\bACTIVE\b/i.test(l) && !/\bInactive\b/i.test(l)
    ).slice(0, limit || 6);
}

function caseProgramLinesFromKnowledge(knowledge, limit) {
    return String(knowledge || '')
        .split('\n')
        .filter((l) => /^Case Presentation Program/.test(l))
        .slice(0, limit || 5);
}

function isSeminarRegistrationQuestion(m) {
    if (/(case presentation|case program|abstract|agnikarma|viddhakarma)/.test(m)) return false;
    if (/(payment|receipt|razorpay|cashfree|juspay|pay fee)/.test(m) && !/(register|registration|apply|sign up|join|how to)/.test(m)) {
        return false;
    }
    return (
        /(how|where|steps?|way|process|guide|can i|do i|want to|need to).*(register|registration|apply|sign up|join|enrol)/.test(m) ||
        /(register|registration|apply|sign up|join|enrol).*(seminar|event|course|program)/.test(m) ||
        /seminar.*(register|registration|apply|sign up|join)/.test(m) ||
        /(new account|create account|doctor account).*(seminar|register)/.test(m) ||
        /^(register|registration|apply)$/.test(m) ||
        /(seminar.*how|how.*seminar)/.test(m)
    );
}

function isPaymentQuestion(m) {
    return /(payment|pay|fee|receipt|razorpay|cashfree|juspay|how to pay|pending payment|pay now)/.test(m);
}

function isCasePresentationQuestion(m) {
    return /(case presentation|case program|abstract|agnikarma|viddhakarma|case submission|case application)/.test(m);
}

function isSupportTicketQuestion(m) {
    return (
        (m.includes('support') || m.includes('ticket') || m.includes('help')) &&
        !/(register|registration|apply|seminar fee|e-ticket|certificate|payment)/.test(m)
    );
}

function isLiveAgentQuestion(m) {
    return (
        m.includes('live chat') ||
        /\btalk to\b/.test(m) ||
        /\bagent\b/.test(m) ||
        m.includes('human') ||
        m.includes('real person') ||
        m.includes('person')
    );
}

function isEmailVerificationQuestion(m) {
    return /email.*(verify|verification|otp|not.*receive|resend)|(verify|verification|otp|resend).*email|email.*problem|email.*issue/.test(m);
}

function isTranscriptRequest(m) {
    return /transcript|email.*transcript|send.*transcript|save.*conversation|download.*chat|save.*chat|chat.*history/.test(m);
}

function isPaymentLinkRequest(m) {
    return /payment.*link|get.*payment|link.*payment|pay.*now|payment.*url|generate.*payment|create.*payment|payment.*help/.test(m);
}

function isCaseTrackQuestion(m) {
    return /case.*(track|status|progress|my|where)|track.*case|case.*application.*status|case.*number/.test(m);
}

function answerFromKnowledge(message, knowledge, userContext) {
    const m = String(message || '').toLowerCase().trim();
    const fallback =
        "I'm here to help with all things VGMF! You can ask me about:\n\n" +
        "- Seminar registration and application status\n" +
        "- Payment links and receipts\n" +
        "- E-tickets and QR codes\n" +
        "- Certificates and verification\n" +
        "- Case presentation applications\n" +
        "- Email OTP verification help\n" +
        "- Live chat with support agent\n\n" +
        "Try: 'How do I register for a seminar?' or 'Track my application' or 'Help'";
    
    // Greeting
    if (/^(hi|hello|hey|namaste|good morning|good evening|good afternoon|hi there|hello there|greetings)\b/.test(m)) {
        return {
            reply: "Hello! 👋 Welcome to VGMF Support!\n\nI'm here to help you with:\n\n📋 Seminar registration & applications\n📊 Application status tracking\n💳 Payment links & receipts\n🎫 E-tickets & QR codes\n📜 Certificates & verification\n📝 Case presentation applications\n🔐 Email OTP verification\n💬 Live chat with support\n\nWhat can I help you with today?",
            suggestLiveChat: false
        };
    }

    // Help command
    if (/^(help|commands|what can you do|options|menu|features|assist)/.test(m)) {
        return {
            reply: "Here's what I can help you with:\n\n" +
                "📋 **Registration**: \"How to register for a seminar?\"\n" +
                "📊 **Tracking**: \"Track my application [APP-123]\"\n" +
                "💳 **Payments**: \"How to pay?\" or \"Generate payment link\"\n" +
                "🎫 **E-tickets**: \"Where is my e-ticket?\"\n" +
                "📜 **Certificates**: \"Download my certificate\"\n" +
                "📝 **Case Presentation**: \"Case presentation status\"\n" +
                "🔐 **Email OTP**: \"Verify my email\" or \"Resend OTP\"\n" +
                "📧 **Transcript**: \"Send chat transcript to email\"\n" +
                "💬 **Live Agent**: \"Talk to human\"\n\n" +
                "Just type your question naturally!",
            suggestLiveChat: false
        };
    }

    // Transcript request
    if (isTranscriptRequest(m)) {
        return {
            reply: "📧 **Chat Transcript Service**\n\n" +
                "I can email you a copy of this conversation!\n\n" +
                "To receive your transcript:\n" +
                "1️⃣ Provide your email address\n" +
                "2️⃣ I'll send you the complete chat history\n" +
                "3️⃣ Save it for your records\n\n" +
                "Please share your email address and I'll send the transcript right away!",
            suggestLiveChat: false,
            action: 'request_email_for_transcript'
        };
    }

    // Email OTP verification help
    if (isEmailVerificationQuestion(m)) {
        return {
            reply: "🔐 **Email OTP Verification Help**\n\n" +
                "Having trouble with email verification?\n\n" +
                "Common solutions:\n" +
                "1️⃣ Check your **spam/junk** folder\n" +
                "2️⃣ OTP is valid for **10 minutes**\n" +
                "3️⃣ Use the **same email** you registered with\n" +
                "4️⃣ Wait **60 seconds** then click \"Resend OTP\"\n" +
                "5️⃣ Try a different email client\n\n" +
                "Still not working? I can connect you with support to verify your account manually!",
            suggestLiveChat: false,
            action: 'email_verification_help'
        };
    }

    // Payment link request
    if (isPaymentLinkRequest(m)) {
        return {
            reply: "💳 **Payment Link Generation**\n\n" +
                "To get your seminar payment link:\n\n" +
                "1️⃣ Sign in to doctor portal (/doctor)\n" +
                "2️⃣ Go to \"My Applications\" or \"Payments\"\n" +
                "3️⃣ Find your **approved** registration\n" +
                "4️⃣ Click \"Pay Now\" or \"Generate Payment Link\"\n" +
                "5️⃣ Complete payment via your preferred method:\n" +
                "   • Razorpay (cards, UPI, netbanking)\n" +
                "   • Cashfree, Juspay, Easebuzz\n" +
                "   • PayU, Paytm, PhonePe\n" +
                "   • Zoho Payments\n\n" +
                "Share your application number and I can help locate it!",
            suggestLiveChat: false,
            action: 'payment_link_help'
        };
    }

    // Case track question
    if (isCaseTrackQuestion(m)) {
        const hits = caseProgramLinesFromKnowledge(knowledge, 3);
        return {
            reply: "📋 **Case Presentation Tracking**\n\n" +
                "To check your case application status:\n\n" +
                "1️⃣ Sign in to doctor portal (/doctor)\n" +
                "2️⃣ Go to \"Track case applications\"\n" +
                "3️⃣ Enter your **CASE-XXXXXX** number\n\n" +
                "Status meanings:\n" +
                "• **Submitted** - Application received\n" +
                "• **Under Review** - Being evaluated by team\n" +
                "• **Approved** - Presentation scheduled\n" +
                "• **Completed** - Certificate issued\n\n" +
                (hits.length ? "📚 **Active Programs:**\n" + hits.join('\n') : ""),
            suggestLiveChat: false
        };
    }

    // Live agent
    if (isLiveAgentQuestion(m)) {
        return {
            reply: "💬 **Connect with Support Agent**\n\n" +
                "I can connect you with our support team!\n\n" +
                "Options:\n" +
                "1️⃣ Tap \"Talk to Support Agent\" in this chat\n" +
                "2️⃣ Sign in to doctor portal → Live chat button (bottom right)\n" +
                "3️⃣ Open a Support Ticket for formal requests\n\n" +
                "Support hours: Mon-Sat, 9 AM - 6 PM IST\n" +
                "You'll receive a chat reference like **LCHAT-XXXXXXXXXXXX**",
            suggestLiveChat: true
        };
    }

    // Seminar registration
    if (isSeminarRegistrationQuestion(m)) {
        const open = activeSeminarLinesFromKnowledge(knowledge, 5);
        let reply = "📝 **Seminar Registration Guide**\n\n" + SEMINAR_REGISTRATION_STEPS;
        if (open.length) {
            reply += "\n\n📅 **Currently Open for Registration:**\n" + open.join('\n');
        }
        reply += "\n\nNeed more help? Ask about payment links or say 'track my application'!";
        return { reply, suggestLiveChat: false };
    }

    // Create account
    if (/(create account|new account|sign up|doctor portal login|how to login|log in|register.*account|signup)/.test(m)) {
        return {
            reply: "🔐 **Creating Your Doctor Portal Account**\n\n" +
                "1️⃣ Visit **/doctor** in your browser\n" +
                "2️⃣ Click **\"Create Account\"** or **\"Register\"**\n" +
                "3️⃣ Enter your details:\n" +
                "   • Full name\n" +
                "   • Email address\n" +
                "   • Phone number (WhatsApp preferred)\n" +
                "4️⃣ Check email for **OTP verification**\n" +
                "5️⃣ Enter the 6-digit OTP\n" +
                "6️⃣ Set your secure password\n" +
                "7️⃣ Sign in and complete your profile\n\n" +
                "💡 Your account works on web and mobile app!\n" +
                "🎯 Once signed in, browse \"Available Seminars\" to apply",
            suggestLiveChat: false
        };
    }

    // Application status tracking
    if ((m.includes('status') || m.includes('application') || m.includes('where is my') || m.includes('track')) && userContext) {
        if (userContext.track && !userContext.track.error) {
            const tr = userContext.track;
            if (tr.type === 'seminar') {
                return {
                    reply: "📊 **Application Status: " + tr.status + "**\n\n" +
                        "Application No: " + tr.applicationNo + "\n" +
                        (tr.seminarTitle ? "Seminar: " + tr.seminarTitle + "\n" : "") +
                        "Status: " + tr.status + "\n\n" +
                        "Sign in to doctor portal → \"My Applications\" for full details and next steps.",
                    suggestLiveChat: false
                };
            }
            if (tr.type === 'case') {
                return {
                    reply: "📋 **Case Presentation Status: " + tr.status + "**\n\n" +
                        "Application No: " + tr.applicationNo + "\n" +
                        "Status: " + tr.status + "\n\n" +
                        "Check \"Track case applications\" in the doctor portal for full details.",
                    suggestLiveChat: false
                };
            }
            if (tr.type === 'support_ticket') {
                return {
                    reply: "🎫 **Support Ticket Status: " + tr.status + "**\n\n" +
                        "Reference: " + tr.ticketRef + "\n" +
                        "Status: " + tr.status + "\n\n" +
                        "Replies appear in the doctor portal under \"Support tickets\".",
                    suggestLiveChat: false
                };
            }
        }
        if (userContext.registrations) {
            if (!userContext.registrations.length) {
                return { reply: "📭 **No Applications Found**\n\nYou haven't registered for any seminars yet.\n\nVisit doctor portal → \"Available Seminars\" to apply for upcoming events!", suggestLiveChat: false };
            }
            return {
                reply: "📋 **Your Applications:**\n\n" +
                    userContext.registrations.map((r) => "• " + r.title + ": " + r.application_no + " — " + r.status).join('\n'),
                suggestLiveChat: false
            };
        }
    }

    // Payment question
    if (isPaymentQuestion(m)) {
        return {
            reply: "💳 **Payment Process**\n\n" +
                "Payment is **Step 5** - after your application is approved:\n\n" +
                "1️⃣ Sign in to doctor portal (/doctor)\n" +
                "2️⃣ Go to \"My Applications\" or \"Payments\"\n" +
                "3️⃣ Select your **approved** registration\n" +
                "4️⃣ Click \"Pay Now\" to generate payment link\n" +
                "5️⃣ Choose payment method:\n" +
                "   • Razorpay (cards, UPI, netbanking, wallets)\n" +
                "   • Cashfree, Juspay, Easebuzz\n" +
                "   • PayU, Paytm, PhonePe\n" +
                "   • Zoho Payments\n" +
                "6️⃣ Complete payment\n" +
                "7️⃣ Receipt appears in \"Payment receipts\"\n" +
                "8️⃣ E-ticket QR in \"View Tickets\"\n\n" +
                "Need a payment link? Just ask!",
            suggestLiveChat: false
        };
    }

    // E-ticket question
    if (m.includes('e-ticket') || m.includes('e ticket') || m.includes('qr code') || m.includes('qr code')) {
        return {
            reply: "🎫 **E-Tickets & QR Codes**\n\n" +
                "Your e-ticket is generated **after successful payment**.\n\n" +
                "To access your e-ticket:\n" +
                "1️⃣ Sign in to doctor portal (/doctor)\n" +
                "2️⃣ Go to \"View Tickets\" or \"Participant Tickets\"\n" +
                "3️⃣ Your QR code will be displayed\n" +
                "4️⃣ Screenshot or download for offline access\n" +
                "5️⃣ Show QR at venue for check-in\n\n" +
                "⚠️ One QR code per registration!\n" +
                "📅 Check-in only works on the configured date",
            suggestLiveChat: false
        };
    }

    // Certificate question
    if (m.includes('certificate') || m.includes('cmc') || m.includes('cme') || m.includes('download certificate')) {
        return {
            reply: "📜 **Certificates**\n\n" +
                "Certificates are issued **automatically after venue check-in**.\n\n" +
                "To download:\n" +
                "1️⃣ Sign in to doctor portal\n" +
                "2️⃣ Go to \"Certificates\" section\n" +
                "3️⃣ Select the year\n" +
                "4️⃣ Download your PDF certificate\n\n" +
                "To verify authenticity:\n" +
                "• Visit **/verify-certificate**\n" +
                "• Scan the QR code on your certificate, OR\n" +
                "• Enter application number + email OTP\n\n" +
                "Your certificate is valid for CME/CMC credit claims!",
            suggestLiveChat: false
        };
    }

    // Certificate verification
    if (m.includes('verify') && (m.includes('certificate') || m.includes('my certificate'))) {
        return {
            reply: "🔐 **Certificate Verification**\n\n" +
                "1️⃣ Visit: **/verify-certificate**\n" +
                "2️⃣ Choose verification method:\n" +
                "   • Scan QR code on certificate, OR\n" +
                "   • Enter registration/application number\n" +
                "3️⃣ Confirm with email OTP\n" +
                "4️⃣ View verification result\n\n" +
                "Certificates include QR codes for easy verification by employers or institutions!",
            suggestLiveChat: false
        };
    }

    // Case presentation
    if (isCasePresentationQuestion(m)) {
        const hits = caseProgramLinesFromKnowledge(knowledge, 3);
        return {
            reply: "📋 **Case Presentation Guide**\n\n" + CASE_PRESENTATION_STEPS + "\n\n" +
                (hits.length ? "📚 **Active Case Programs:**\n" + hits.join('\n') : "No active case programs at the moment."),
            suggestLiveChat: false
        };
    }

    // Volunteer
    if (m.includes('volunteer')) {
        return {
            reply: "🙋 **Volunteer Opportunities**\n\n" +
                "Volunteer registration is available in the doctor portal:\n\n" +
                "1️⃣ Sign in to doctor portal (/doctor)\n" +
                "2️⃣ Go to \"Volunteers\" section\n" +
                "3️⃣ Complete the volunteer registration form\n" +
                "4️⃣ Submit and wait for confirmation\n\n" +
                "🎁 Benefits:\n" +
                "• Priority access to events\n" +
                "• Volunteer certificate\n" +
                "• Networking opportunities\n" +
                "• Exclusive workshops",
            suggestLiveChat: false
        };
    }

    // Support ticket
    if (isSupportTicketQuestion(m)) {
        return {
            reply: "🎫 **Support Tickets**\n\n" +
                "For formal support requests:\n\n" +
                "1️⃣ Sign in to doctor portal\n" +
                "2️⃣ Go to \"Support tickets\"\n" +
                "3️⃣ Click \"New support ticket\"\n" +
                "4️⃣ Describe your issue\n" +
                "5️⃣ Submit and wait for response\n\n" +
                "For urgent issues, use **Live chat** during business hours!",
            suggestLiveChat: true
        };
    }

    // Schedule/timing
    if (m.includes('schedule') || m.includes('timing') || m.includes('programme') || m.includes('program') || m.includes('agenda')) {
        const hits = String(knowledge || '')
            .split('\n')
            .filter((l) => l.startsWith('Schedule'));
        return {
            reply: hits.length 
                ? "📅 **Event Schedules:**\n\n" + hits.slice(0, 8).join('\n')
                : "📅 **Schedule Information**\n\nCheck the Schedule section on the website or in your doctor portal for event timings and agenda.",
            suggestLiveChat: false
        };
    }

    // Notice/announcement
    if (m.includes('notice') || m.includes('announcement') || m.includes('update') || m.includes('news')) {
        const hits = String(knowledge || '')
            .split('\n')
            .filter((l) => l.startsWith('Notice:') || l.startsWith('Announcement') || l.startsWith('Latest Update'));
        return {
            reply: hits.length 
                ? "📢 **Latest Updates:**\n\n" + hits.slice(0, 5).join('\n')
                : "📢 **Notices**\n\nCheck the Official Notices board and homepage ticker for the latest announcements!",
            suggestLiveChat: false
        };
    }

    // Books
    if (m.includes('book') || m.includes('courier') || m.includes('shipment') || m.includes('order')) {
        return {
            reply: "📚 **Book Orders**\n\n" +
                "Order Dr. R.B. Gogate books in the doctor portal:\n\n" +
                "1️⃣ Sign in to doctor portal\n" +
                "2️⃣ Go to \"Books\" section\n" +
                "3️⃣ Choose your books:\n" +
                "   • Agnikarma book\n" +
                "   • Viddhakarma book\n" +
                "4️⃣ Select delivery:\n" +
                "   • Seminar desk pickup (on event day)\n" +
                "   • Courier delivery with tracking\n" +
                "5️⃣ Complete payment\n" +
                "6️⃣ Track shipment in \"Book Orders\"",
            suggestLiveChat: false
        };
    }

    // Check-in
    if (m.includes('check') && m.includes('in')) {
        return {
            reply: "✅ **Event Check-In**\n\n" +
                "1️⃣ Show your **e-ticket QR code** at the venue\n" +
                "2️⃣ Staff will scan your QR with the scanner app\n" +
                "3️⃣ Check-in only works on the configured date (IST)\n" +
                "4️⃣ After check-in, your certificate is generated\n\n" +
                "⚠️ Make sure to have your QR code ready before arriving!",
            suggestLiveChat: false
        };
    }

    // Seminar info
    if (m.includes('seminar') || m.includes('event') || m.includes('upcoming') || m.includes('fee') || m.includes('date')) {
        const hits = activeSeminarLinesFromKnowledge(knowledge, 6);
        return {
            reply: hits.length 
                ? "📅 **Upcoming Seminars:**\n\n" + hits.join('\n') + "\n\nSign in at /doctor → \"Available Seminars\" to apply!"
                : "📅 **Seminars**\n\nBrowse available seminars in the doctor portal under \"Available Seminars\" when registration is open!",
            suggestLiveChat: false
        };
    }

    // About
    if (m.includes('about') || m.includes('foundation') || m.includes('vgmf') || m.includes('who are you')) {
        const about = String(knowledge || '')
            .split('\n')
            .filter((l) => l.startsWith('About -'));
        return {
            reply: about.length
                ? "🏛️ **About VGMF:**\n\n" + about.slice(0, 3).join('\n')
                : "🏛️ **Vaidya Gogate Memorial Foundation**\n\nPromotes Ayurveda education through national seminars, case presentations, and continuing medical education (CME/CMC). Founded to honor Dr. R.B. Gogate's legacy in Ayurveda.",
            suggestLiveChat: false
        };
    }

    // Social links
    if (m.includes('instagram') || m.includes('facebook') || m.includes('youtube') || m.includes('social') || m.includes('follow')) {
        return {
            reply: "📱 **Follow Us:**\n\nSearch for \"Vaidya Gogate Memorial Foundation\" on:\n\n" +
                "• YouTube\n" +
                "• Facebook\n" +
                "• Instagram\n\n" +
                "Links are available in the website footer when configured!",
            suggestLiveChat: false
        };
    }

    // Default fallback
    return { reply: fallback, suggestLiveChat: true };
}

module.exports = { buildChatbotKnowledge, answerFromKnowledge };
