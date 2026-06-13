/** Default notification templates (admin-editable; synced on deploy via syncDefaultNotificationTemplates). */
const SEMINAR = 'Vaidya Gogate Memorial Foundation National Seminar 2026';
const TEAM = 'Team Vaidya Gogate Memorial Foundation<br>National Seminar Support Team';

const EVENT_KEYS = [
    'ACCOUNT_CREATED',
    'FORGOT_PASSWORD',
    'OTP_VERIFICATION',
    'OTP_SIGNUP',
    'OTP_LOGIN',
    'OTP_REGISTRATION',
    'OTP_ADMIN',
    'OTP_CERTIFICATE',
    'EMAIL_VERIFICATION',
    'SEMINAR_REGISTRATION_SUCCESS',
    'PAYMENT_SUCCESS',
    'PAYMENT_FAILED',
    'PAYMENT_PENDING',
    'APPLICATION_UNDER_REVIEW',
    'WAITLIST_JOINED',
    'APPLICATION_APPROVED',
    'APPLICATION_REJECTED',
    'APPLICATION_REVISION_REQUIRED',
    'TICKET_ISSUED',
    'QR_TICKET_REISSUED',
    'CHECK_IN_SUCCESS',
    'CHECK_IN_FAILED',
    'SEMINAR_REMINDER',
    'EVENT_STARTING_TODAY',
    'CERTIFICATE_AVAILABLE',
    'CERTIFICATE_REISSUED',
    'CASE_PRESENTATION_SUBMITTED',
    'CASE_PRESENTATION_APPROVED',
    'CASE_PRESENTATION_REJECTED',
    'CASE_PRESENTATION_NEEDS_CHANGES',
    'CASE_PRESENTATION_JUDGING',
    'CASE_PRESENTATION_JUDGED',
    'CASE_PRESENTATION_SELECTED',
    'CASE_PRESENTATION_RESUBMITTED',
    'ADMIN_ANNOUNCEMENT',
    'WHATSAPP_GROUP_INVITE',
    'INVOICE_GENERATED',
    'REFUND_INITIATED',
    'REFUND_COMPLETED',
    'REGISTRATION_CANCELLED',
    'SUPPORT_TICKET_CREATED',
    'SUPPORT_TICKET_REPLY_TO_DOCTOR',
    'SUPPORT_TICKET_REPLY_TO_ADMIN',
    'SUPPORT_AGENT_ALERT',
    'CASE_MESSAGE_FROM_JUDGE',
    'CASE_MESSAGE_FROM_PARTICIPANT',
    'THREAD_REPLY_NEW_RESPONSE',
    'CASE_PRIORITY_INVITED',
    'WAITLIST_CONFIRMED',
    'REGISTRATION_PENDING_REMINDER',
    'CASE_JUDGE_ASSIGNED',
    'CASE_JUDGE_MARKING_REMINDER',
    'BOOK_ORDER_PLACED',
    'BOOK_ORDER_CONFIRMED',
    'BOOK_LINE_CANCELLED',
    'BOOK_ORDER_SHIPPING_READY',
    'BOOK_SHIPMENT_CREATED',
    'BOOK_ORDER_SHIPPED',
    'BOOK_ORDER_OUT_FOR_DELIVERY',
    'BOOK_ORDER_DELIVERED',
    'BOOK_ORDER_CANCELLED'
];

/** Email-safe CTA (use &lt;a&gt; styled as button — HTML &lt;button&gt; does not work in email). */
function emailCtaButton(href, label) {
    const url = href || '#';
    const text = label || 'Open portal';
    return (
        '<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:18px 0;">' +
        '<tr><td align="left" style="border-radius:10px;background:#0f766e;">' +
        '<a href="' +
        url +
        '" target="_blank" rel="noopener" style="display:inline-block;padding:14px 28px;color:#ffffff;font-size:15px;font-weight:bold;text-decoration:none;font-family:Arial,Helvetica,sans-serif;">' +
        text +
        '</a></td></tr></table>'
    );
}

function wrapHtml(title, body) {
    return (
        '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1a1f36;">' +
        '<div style="background:#f8fafc;padding:20px;border-radius:12px 12px 0 0;border:1px solid #e2e8f0;">' +
        '<strong style="color:#1e3a8a;">' +
        title +
        '</strong></div>' +
        '<div style="padding:20px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;line-height:1.6;">' +
        body +
        '<p style="margin-top:20px;font-size:12px;color:#64748b;">Regards,<br>' +
        TEAM +
        '</p></div></div>'
    );
}

function otpEmailIntro(introLine) {
    return (
        '<p>Dear Participant,</p><p>' +
        introLine +
        '</p><p>To continue, please use the OTP below:</p>' +
        '<p style="font-size:22px;font-weight:bold;letter-spacing:4px;">Your 4-Digit OTP: {{otp_code}}</p>' +
        '<p>This OTP is valid for 10 minutes only. Please do not share it with anyone for security reasons.</p>' +
        '<p>If you did not request this verification, please ignore this email.</p>'
    );
}

function otpWhatsAppIntro(introLine) {
    return (
        '🔐 OTP Verification\nHello,\n' +
        introLine +
        '\nYour OTP is:\n{{otp_code}}\nThis OTP is valid for 10 minutes.\nDo not share it with anyone.'
    );
}

const DEFAULT_TEMPLATES = [
    {
        event_key: 'OTP_VERIFICATION',
        channel: 'both',
        email_subject: 'Verify Your Email – ' + SEMINAR,
        email_html: wrapHtml(
            'Email verification',
            otpEmailIntro('Thank you for using the ' + SEMINAR + ' portal.')
        ),
        whatsapp_body: otpWhatsAppIntro('Your OTP for ' + SEMINAR + ' portal verification is:')
    },
    {
        event_key: 'OTP_SIGNUP',
        channel: 'both',
        email_subject: 'Signup verification code – ' + SEMINAR,
        email_html: wrapHtml(
            'Verify before signup',
            otpEmailIntro('Use this code to verify your email or phone before creating your doctor portal account.')
        ),
        whatsapp_body: otpWhatsAppIntro('Use this code to verify your details before signup on the seminar portal.')
    },
    {
        event_key: 'OTP_LOGIN',
        channel: 'both',
        email_subject: 'Login verification code – ' + SEMINAR,
        email_html: wrapHtml(
            'Login verification',
            otpEmailIntro('Use this code to sign in securely to your doctor portal account.')
        ),
        whatsapp_body: otpWhatsAppIntro('Use this code to sign in to your doctor portal account.')
    },
    {
        event_key: 'OTP_REGISTRATION',
        channel: 'both',
        email_subject: 'Seminar registration verification code',
        email_html: wrapHtml(
            'Registration verification',
            otpEmailIntro('Use this code to verify your contact details for seminar registration.')
        ),
        whatsapp_body: otpWhatsAppIntro('Use this code to verify your contact details for seminar registration.')
    },
    {
        event_key: 'OTP_ADMIN',
        channel: 'both',
        email_subject: 'Admin action verification code',
        email_html: wrapHtml(
            'Admin verification',
            otpEmailIntro('Use this code to confirm a sensitive admin action on the seminar portal.')
        ),
        whatsapp_body: otpWhatsAppIntro('Use this code to confirm a sensitive admin action.')
    },
    {
        event_key: 'OTP_CERTIFICATE',
        channel: 'both',
        email_subject: 'Certificate verification code',
        email_html: wrapHtml(
            'Certificate verification',
            otpEmailIntro('Use this code to verify your certificate on the seminar portal.')
        ),
        whatsapp_body: otpWhatsAppIntro('Use this code to verify your certificate on the seminar portal.')
    },
    {
        event_key: 'EMAIL_VERIFICATION',
        channel: 'email',
        email_subject: 'Confirm your email – ' + SEMINAR + ' portal',
        email_html: wrapHtml(
            'Confirm your email',
            '<p>Dear {{full_name}},</p><p>Please confirm that <strong>{{email}}</strong> belongs to you so you can sign in to the doctor portal.</p>' +
                emailCtaButton('{{verify_link}}', 'Verify email address') +
                '<p style="font-size:12px;color:#64748b;">If the button does not work, copy this link into your browser:<br>{{verify_link}}</p>' +
                '<p>This link expires in 48 hours. If you did not create an account, you can ignore this message.</p>'
        ),
        whatsapp_body: 'Hello {{first_name}}, confirm your email for the seminar portal: {{verify_link}}'
    },
    {
        event_key: 'ACCOUNT_CREATED',
        channel: 'both',
        email_subject: 'Welcome — your ' + SEMINAR + ' portal account is ready',
        email_html: wrapHtml(
            'Welcome to the portal',
            '<p style="font-size:18px;font-weight:700;color:#0f766e;margin:0 0 12px;">Welcome, {{full_name}}!</p>' +
                '<p>Your doctor portal account has been created for the ' +
                SEMINAR +
                '.</p>' +
                '<p><strong>Your login details</strong></p>' +
                '<ul style="padding-left:18px;line-height:1.8;">' +
                '<li><strong>Portal User ID:</strong> {{user_id_string}}</li>' +
                '<li><strong>Registered email:</strong> {{email}}</li>' +
                '<li><strong>Temporary password:</strong> {{temporary_password}}</li>' +
                '</ul>' +
                '<p>Sign in with your email and this password, then change your password after your first login.</p>' +
                '<p>You can complete seminar registrations, case presentations, and payments from the doctor portal.</p>' +
                emailCtaButton('{{portal_login_url}}', 'Open doctor portal')
        ),
        whatsapp_body:
            '🎉 Account created\nHello {{first_name}},\n' +
            SEMINAR +
            ' portal.\n🆔 User ID: {{user_id_string}}\n📧 Email: {{email}}\n🔑 Password: {{temporary_password}}\nSign in with your email and this password (change after login).'
    },
    {
        event_key: 'SEMINAR_REGISTRATION_SUCCESS',
        channel: 'both',
        email_subject: 'Seminar Registration Submitted Successfully',
        email_html: wrapHtml(
            'Application submitted',
            '<p>Dear {{full_name}},</p><p>Your application for the ' +
                SEMINAR +
                ' has been successfully submitted.</p><p><strong>Application Details:</strong><br>Application ID: SEM-{{application_no}}<br>Status: Submitted</p>' +
                '<p>Our team will review your application shortly.</p>'
        ),
        whatsapp_body:
            '✅ Application Submitted\nHello {{first_name}},\nYour seminar registration has been submitted successfully.\n📄 Application ID: SEM-{{application_no}}\n📌 Status: Submitted'
    },
    {
        event_key: 'CASE_PRESENTATION_SUBMITTED',
        channel: 'both',
        email_subject: 'Case presentation submitted — CASE-{{application_no}}',
        email_html: wrapHtml(
            'Case presentation submitted',
            '<p>Dear {{full_name}},</p><p>Your case presentation application for <strong>{{program_title}}</strong> has been submitted successfully.</p>' +
                '<p><strong>Application ID:</strong> CASE-{{application_no}}<br><strong>Case title:</strong> {{case_presentation_title}}<br><strong>Status:</strong> Under review</p>' +
                '<p>Our team will review your submission and email you when there is an update.</p>' +
                emailCtaButton('{{portal_login_url}}', 'Track case application')
        ),
        whatsapp_body:
            '📚 Case submitted\nHello {{first_name}},\nApplication CASE-{{application_no}} for {{program_title}} is under review.\nTitle: {{case_presentation_title}}\nTrack: {{portal_login_url}}'
    },
    {
        event_key: 'CASE_PRESENTATION_APPROVED',
        channel: 'both',
        email_subject: 'Case approved for judging — CASE-{{application_no}}',
        email_html: wrapHtml(
            'Approved for judging',
            '<p>Dear {{full_name}},</p><p>Your case presentation <strong>CASE-{{application_no}}</strong> ({{case_presentation_title}}) has been <strong>approved for judging</strong>.</p>' +
                '<p>Judges will be assigned shortly. You will receive another update when judging begins.</p>' +
                emailCtaButton('{{portal_login_url}}', 'Track case application')
        ),
        whatsapp_body:
            '✅ Case CASE-{{application_no}} approved for judging.\nTitle: {{case_presentation_title}}\nTrack: {{portal_login_url}}'
    },
    {
        event_key: 'CASE_PRESENTATION_NEEDS_CHANGES',
        channel: 'both',
        email_subject: 'Action required — re-upload case files (CASE-{{application_no}})',
        email_html: wrapHtml(
            'Documents need correction',
            '<p>Dear {{full_name}},</p><p>Your case application <strong>CASE-{{application_no}}</strong> ({{case_presentation_title}}) was reviewed.</p>' +
                '<p><strong>Review note:</strong> {{rejection_reason}}</p>' +
                '<p>Sign in to the doctor portal, open <strong>Track case applications</strong>, and re-upload the corrected files on the <em>same application number</em>.</p>' +
                emailCtaButton('{{portal_login_url}}', 'Re-upload in doctor portal')
        ),
        whatsapp_body:
            'Hello {{first_name}},\nCase CASE-{{application_no}} needs corrected files.\nReason: {{rejection_reason}}\nRe-upload: {{portal_login_url}}'
    },
    {
        event_key: 'CASE_PRESENTATION_REJECTED',
        channel: 'both',
        email_subject: 'Case application update — CASE-{{application_no}}',
        email_html: wrapHtml(
            'Case application not approved',
            '<p>Dear {{full_name}},</p><p>Thank you for submitting case <strong>CASE-{{application_no}}</strong> ({{case_presentation_title}}).</p>' +
                '<p>After review, we regret to inform you that this application has not been approved.</p>' +
                '<p><strong>Reason:</strong> {{rejection_reason}}</p>' +
                '<p>For clarification, contact {{admin_contact}}.</p>'
        ),
        whatsapp_body:
            'Hello {{first_name}},\nCase CASE-{{application_no}} was not approved.\nReason: {{rejection_reason}}\nContact: {{admin_contact}}'
    },
    {
        event_key: 'CASE_PRESENTATION_RESUBMITTED',
        channel: 'both',
        email_subject: 'Case files received — CASE-{{application_no}} under review again',
        email_html: wrapHtml(
            'Files resubmitted',
            '<p>Dear {{full_name}},</p><p>We received your updated files for case <strong>CASE-{{application_no}}</strong> ({{case_presentation_title}}).</p>' +
                '<p>Status is now <strong>under review</strong> again. We will email you once verification is complete.</p>' +
                emailCtaButton('{{portal_login_url}}', 'Track case application')
        ),
        whatsapp_body:
            'Case CASE-{{application_no}} files received — under review again.\nTrack: {{portal_login_url}}'
    },
    {
        event_key: 'CASE_PRESENTATION_JUDGING',
        channel: 'both',
        email_subject: 'Case judging started — CASE-{{application_no}}',
        email_html: wrapHtml(
            'Judging in progress',
            '<p>Dear {{full_name}},</p><p>Judges have been assigned to your case <strong>CASE-{{application_no}}</strong> ({{case_presentation_title}}).</p>' +
                '<p><strong>Marking deadline (IST):</strong> {{marking_deadline}}</p>' +
                '<p>You may receive messages from judges in the doctor portal. Results will be shared after judging is complete.</p>' +
                emailCtaButton('{{portal_login_url}}', 'Open doctor portal')
        ),
        whatsapp_body:
            'Case CASE-{{application_no}} is with judges. Deadline {{marking_deadline}} IST.\nPortal: {{portal_login_url}}'
    },
    {
        event_key: 'CASE_PRESENTATION_JUDGED',
        channel: 'both',
        email_subject: 'Case judging complete — CASE-{{application_no}}',
        email_html: wrapHtml(
            'Judging complete',
            '<p>Dear {{full_name}},</p><p>Judging for your case <strong>CASE-{{application_no}}</strong> ({{case_presentation_title}}) has been completed.</p>' +
                '<p>Your application is now under final review. You will be notified if you are selected.</p>' +
                emailCtaButton('{{portal_login_url}}', 'Track case application')
        ),
        whatsapp_body:
            'Judging complete for CASE-{{application_no}}.\nFinal review in progress.\nTrack: {{portal_login_url}}'
    },
    {
        event_key: 'CASE_PRESENTATION_SELECTED',
        channel: 'both',
        email_subject: 'Congratulations — case selected (CASE-{{application_no}})',
        email_html: wrapHtml(
            'Case selected',
            '<p>Dear {{full_name}},</p><p>Congratulations! Your case presentation <strong>CASE-{{application_no}}</strong> ({{case_presentation_title}}) has been <strong>selected</strong>.</p>' +
                '<p>You will receive a <strong>selection letter</strong> regarding the cash prize. Final winners and prize amounts will be declared on <strong>seminar day</strong>.</p>' +
                '<p><strong>Seminar registration is mandatory</strong> — please complete paid registration for the linked seminar in the doctor portal without delay.</p>' +
                emailCtaButton('{{portal_login_url}}', 'Open doctor portal')
        ),
        whatsapp_body:
            '🎉 Congratulations {{first_name}}! Case CASE-{{application_no}} selected.\nYou will receive a cash-prize selection letter. Winners declared on seminar day.\nSeminar registration is mandatory: {{portal_login_url}}'
    },
    {
        event_key: 'PAYMENT_SUCCESS',
        channel: 'both',
        email_subject: 'Payment Successful – Seminar Registration Confirmed',
        email_html: wrapHtml(
            'Payment successful',
            '<p>Dear {{full_name}},</p><p>We have successfully received your payment for the ' +
                SEMINAR +
                '.</p><p><strong>Payment Details:</strong><br>Payment ID: PAY-{{payment_id}}<br>Amount Paid: ₹{{payment_amount}}<br>Status: Paid</p>' +
                '<p>Your registration is now confirmed.</p>'
        ),
        whatsapp_body:
            '💳 Payment Successful\nHello {{first_name}},\nYour payment for National Seminar 2026 has been received successfully.\n💰 Amount: ₹{{payment_amount}}\n🧾 Payment ID: PAY-{{payment_id}}\n📌 Status: Paid{{whatsapp_group_line}}'
    },
    {
        event_key: 'TICKET_ISSUED',
        channel: 'both',
        email_subject: 'Your E-Ticket is Ready – National Seminar 2026',
        email_html: wrapHtml(
            'E-ticket ready',
            '<p>Dear {{full_name}},</p><p>Your e-ticket for the ' +
                SEMINAR +
                ' has been generated successfully.</p><p><strong>Ticket Details:</strong><br>Ticket ID: ET-{{ticket_id}}<br>Participant ID: {{user_id_string}}</p>' +
                '<p>Please carry your e-ticket during event entry.</p>' +
                emailCtaButton('{{ticket_pdf_url}}', 'Open printable ticket (PDF)') +
                emailCtaButton('{{qr_code_url}}', 'View in doctor portal')
        ),
        whatsapp_body:
            '🎟️ E-Ticket Generated\nHello {{first_name}},\nYour e-ticket for National Seminar 2026 is ready.\n🎫 Ticket ID: ET-{{ticket_id}}\n🆔 Participant ID: {{user_id_string}}\nPrintable ticket: {{ticket_pdf_url}}\nPlease carry it for entry.'
    },
    {
        event_key: 'APPLICATION_APPROVED',
        channel: 'both',
        email_subject: 'Application Approved – National Seminar 2026',
        email_html: wrapHtml(
            'Application approved',
            '<p>Dear {{full_name}},</p><p>Congratulations! Your application for the ' +
                SEMINAR +
                ' has been approved.</p><p>Application ID: {{application_no}}<br>Status: Approved</p><p>We look forward to welcoming you.</p>'
        ),
        whatsapp_body:
            '🎉 Application Approved!\nHello {{first_name}},\nYour application for National Seminar 2026 has been approved successfully.\n📄 Application ID: {{application_no}}\n📌 Status: Approved'
    },
    {
        event_key: 'APPLICATION_REJECTED',
        channel: 'both',
        email_subject: 'Application Status Update – National Seminar 2026',
        email_html: wrapHtml(
            'Application not approved',
            '<p>Dear {{full_name}},</p><p>Thank you for your interest in the ' +
                SEMINAR +
                '.</p><p>After review, we regret to inform you that your application has not been approved.</p>' +
                '<p>Application ID: {{application_no}}<br>Status: Rejected</p><p>For any clarification, please contact support.</p>'
        ),
        whatsapp_body:
            'Hello {{first_name}},\nYour application for National Seminar 2026 was reviewed.\n📄 Application ID: {{application_no}}\n📌 Status: Rejected\nFor assistance, contact support.'
    },
    {
        event_key: 'APPLICATION_REVISION_REQUIRED',
        channel: 'both',
        email_subject: 'Action required — re-upload documents (same application no.)',
        email_html: wrapHtml(
            'Documents need correction',
            '<p>Dear {{full_name}},</p><p>Your seminar application <strong>{{application_no}}</strong> was reviewed.</p>' +
                '<p>Your details look acceptable, but the <strong>certificate document and/or NCISM registration number</strong> need correction.</p>' +
                '<p><strong>Review note:</strong> {{rejection_reason}}</p>' +
                '<p>Sign in to the doctor portal, open <strong>Track seminar applications</strong>, and re-upload on the <em>same application number</em>. No new application is needed.</p>' +
                emailCtaButton('{{portal_login_url}}', 'Open doctor portal')
        ),
        whatsapp_body:
            'Hello {{first_name}},\nYour seminar application {{application_no}} needs corrected documents.\nReason: {{rejection_reason}}\nRe-upload in the doctor portal using the SAME application number.'
    },
    {
        event_key: 'PAYMENT_PENDING',
        channel: 'both',
        email_subject: 'Complete Your Payment – National Seminar 2026',
        email_html: wrapHtml(
            'Payment pending',
            '<p>Dear {{full_name}},</p><p>Your seminar application has been received, but payment is still pending.</p>' +
                '<p>Please complete your payment to confirm your registration.</p><p>Application ID: {{application_no}}<br>Status: Payment Pending</p>' +
                emailCtaButton('{{portal_login_url}}', 'Complete payment in portal')
        ),
        whatsapp_body:
            '⏳ Payment Pending\nHello {{first_name}},\nYour seminar registration is incomplete as payment is pending.\n📄 Application ID: {{application_no}}\nComplete payment to confirm your seat.'
    },
    {
        event_key: 'WAITLIST_JOINED',
        channel: 'both',
        email_subject: 'Waitlist — {{seminar_name}}',
        email_html: wrapHtml(
            'Added to waiting list',
            '<p>Dear {{full_name}},</p><p>Registration for {{seminar_name}} has closed, but you have been added to the <strong>waiting list</strong> with application <strong>{{application_no}}</strong>.</p>' +
                '<p>No payment is required at this stage. If a seat becomes available, our team will email you a payment link. You can track status anytime in the doctor portal.</p>' +
                emailCtaButton('{{portal_login_url}}', 'View application status')
        ),
        whatsapp_body:
            'Hello {{first_name}},\nYou are on the waitlist for {{seminar_name}}.\nApplication: {{application_no}}\nNo payment needed now — we will contact you if a seat opens.'
    },
    {
        event_key: 'APPLICATION_UNDER_REVIEW',
        channel: 'both',
        email_subject: 'Application received — {{seminar_name}}',
        email_html: wrapHtml(
            'Under review',
            '<p>Dear {{full_name}},</p><p>We received your application <strong>{{application_no}}</strong> for {{seminar_name}}.</p>' +
                '<p>Our team is reviewing your documents. You will be notified when there is an update.</p>' +
                emailCtaButton('{{portal_login_url}}', 'Open doctor portal')
        ),
        whatsapp_body:
            'Hello {{first_name}}, your application {{application_no}} for {{seminar_name}} is under review. Check the doctor portal for updates.'
    },
    {
        event_key: 'REGISTRATION_PENDING_REMINDER',
        channel: 'both',
        email_subject: 'Reminder — complete your seminar registration ({{application_no}})',
        email_html: wrapHtml(
            'Registration pending',
            '<p>Dear {{full_name}},</p><p>Your application <strong>{{application_no}}</strong> for {{seminar_name}} is still pending.</p>' +
                '<p>Please sign in and upload any missing documents (NCISM registration and certificate) or corrections requested by the office.</p>' +
                emailCtaButton('{{portal_login_url}}', 'Complete registration')
        ),
        whatsapp_body:
            'Reminder: {{first_name}}, application {{application_no}} for {{seminar_name}} needs your attention. Please complete documents in the doctor portal.'
    },
    {
        event_key: 'SEMINAR_REMINDER',
        channel: 'both',
        email_subject: 'Reminder – National Seminar Starts Soon',
        email_html: wrapHtml(
            'Event reminder',
            '<p>Dear {{full_name}},</p><p>This is a reminder that the ' +
                SEMINAR +
                ' is approaching.</p><p>Event Date: {{seminar_date}}<br>Venue: {{seminar_venue}}<br>Participant ID: {{user_id_string}}</p>' +
                '<p>Please carry your e-ticket for entry.</p>'
        ),
        whatsapp_body:
            'Reminder: {{seminar_name}} on {{seminar_date}} at {{seminar_venue}}. Participant ID: {{user_id_string}}'
    },
    {
        event_key: 'CHECK_IN_SUCCESS',
        channel: 'both',
        email_subject: 'Check-In Confirmed – National Seminar 2026',
        email_html: wrapHtml(
            'Check-in confirmed',
            '<p>Dear {{full_name}},</p><p>Your check-in for the ' +
                SEMINAR +
                ' has been successfully completed.</p><p><strong>Details:</strong><br>Participant ID: {{user_id_string}}<br>Check-In Time: {{check_in_time}}<br>Status: Checked-In</p>' +
                '<p>Thank you for joining us. We hope you have a valuable learning experience.</p>'
        ),
        whatsapp_body:
            '✅ Check-In Confirmed!\nHello {{first_name}},\nYour check-in for ' +
            SEMINAR +
            ' has been successfully completed.\n🆔 Participant ID: {{user_id_string}}\n🕒 Time: {{check_in_time}}\n📌 Status: Checked-In\nThank you for attending!'
    },
    {
        event_key: 'CERTIFICATE_AVAILABLE',
        channel: 'both',
        email_subject: 'Your E-Certificate is Ready – National Seminar 2026',
        email_html: wrapHtml(
            'Certificate ready',
            '<p>Dear {{full_name}},</p><p>Congratulations! Your E-Certificate for participating in the ' +
                SEMINAR +
                ' has been generated successfully.</p><p><strong>Certificate Details:</strong><br>Certificate ID: CERT-{{certificate_id}}<br>Participant ID: {{user_id_string}}</p>' +
                '<p>You can now log in to the portal and download your certificate.</p>' +
                emailCtaButton('{{certificate_url}}', 'Download certificate')
        ),
        whatsapp_body:
            '🎓 E-Certificate Generated!\nHello {{first_name}},\nYour participation certificate for ' +
            SEMINAR +
            ' is ready.\n📄 Certificate ID: CERT-{{certificate_id}}\n🆔 Participant ID: {{user_id_string}}\nPlease log in to the portal to download your certificate.\nCongratulations! 🎉'
    },
    {
        event_key: 'FORGOT_PASSWORD',
        channel: 'both',
        email_subject: 'Password Reset Request – ' + SEMINAR,
        email_html: wrapHtml(
            'Password reset',
            '<p>Dear {{full_name}},</p><p>Reset your password using the button below (link valid for 1 hour):</p>' +
                emailCtaButton('{{forgot_password_link}}', 'Reset password') +
                '<p style="font-size:12px;color:#64748b;">Or copy this link: {{forgot_password_link}}</p>' +
                '<p>If you did not request this, ignore this message.</p>'
        ),
        whatsapp_body: 'Hello {{first_name}}, reset your password: {{forgot_password_link}}'
    },
    {
        event_key: 'SUPPORT_TICKET_CREATED',
        channel: 'both',
        email_subject: 'Support ticket received – ' + SEMINAR,
        email_html: wrapHtml(
            'Support ticket received',
            '<p>Dear {{full_name}},</p><p>We received your support ticket <strong>{{ticket_id}}</strong> regarding <strong>{{ticket_subject}}</strong>.</p>' +
                '<p>{{ticket_message}}</p>' +
                '<p>You can reply in the doctor portal or by email (keep the reference line in the email). Sign in here:</p>' +
                emailCtaButton('{{portal_login_url}}', 'Open support tickets')
        ),
        whatsapp_body:
            'Hello {{first_name}}, we received your support ticket {{ticket_id}} ({{ticket_subject}}). Track replies in the doctor portal: {{portal_login_url}}'
    },
    {
        event_key: 'SUPPORT_TICKET_REPLY_TO_DOCTOR',
        channel: 'both',
        email_subject: 'New reply on your support ticket – ' + SEMINAR,
        email_html: wrapHtml(
            'Support ticket reply',
            '<p>Dear {{full_name}},</p><p><strong>{{staff_name}}</strong> replied on ticket <strong>{{ticket_id}}</strong> ({{ticket_subject}}):</p><blockquote style="border-left:4px solid #0d9488;padding:8px 14px;background:#f0fdfa;">{{ticket_message}}</blockquote>' +
                emailCtaButton('{{portal_login_url}}', 'View conversation')
        ),
        whatsapp_body:
            'Reply from {{staff_name}} on ticket {{ticket_id}}: {{ticket_message}} — Open: {{portal_login_url}}'
    },
    {
        event_key: 'SUPPORT_TICKET_REPLY_TO_ADMIN',
        channel: 'email',
        enabled: 1,
        email_subject: 'Doctor replied on support ticket',
        email_html: wrapHtml(
            'Doctor support reply',
            '<p>A doctor replied on ticket <strong>{{ticket_id}}</strong> ({{ticket_subject}}).</p><blockquote style="border-left:4px solid #f97316;padding:8px 14px;background:#fff7ed;">{{ticket_message}}</blockquote>'
        ),
        whatsapp_body: ''
    },
    {
        event_key: 'SUPPORT_TICKET_STATUS_CHANGED',
        channel: 'both',
        email_subject: 'Support ticket status updated – ' + SEMINAR,
        email_html: wrapHtml(
            'Ticket status updated',
            '<p>Dear {{full_name}},</p><p>Your support ticket <strong>{{ticket_id}}</strong> ({{ticket_subject}}) status is now <strong>{{ticket_status}}</strong>.</p><p>{{ticket_message}}</p>' +
                emailCtaButton('{{portal_login_url}}', 'View ticket')
        ),
        whatsapp_body:
            'Ticket {{ticket_id}} status: {{ticket_status}}. {{ticket_message}} — {{portal_login_url}}'
    },
    {
        event_key: 'SUPPORT_TICKET_PRIORITY_CHANGED',
        channel: 'both',
        email_subject: 'Support ticket priority updated – ' + SEMINAR,
        email_html: wrapHtml(
            'Ticket priority updated',
            '<p>Dear {{full_name}},</p><p>Ticket <strong>{{ticket_id}}</strong> priority is now <strong>{{ticket_priority}}</strong>.</p><p>{{ticket_message}}</p>' +
                emailCtaButton('{{portal_login_url}}', 'View ticket')
        ),
        whatsapp_body: 'Ticket {{ticket_id}} priority: {{ticket_priority}}. {{portal_login_url}}'
    },
    {
        event_key: 'SUPPORT_TICKET_TRANSFERRED',
        channel: 'both',
        email_subject: 'Support ticket assigned to you – ' + SEMINAR,
        email_html: wrapHtml(
            'Support ticket transferred',
            '<p>Dear {{full_name}},</p><p>Support ticket <strong>{{ticket_id}}</strong> ({{ticket_subject}}) has been assigned to your account.</p><p>{{ticket_message}}</p>' +
                emailCtaButton('{{portal_login_url}}', 'Open support tickets')
        ),
        whatsapp_body: 'Ticket {{ticket_id}} transferred to you. {{portal_login_url}}'
    },
    {
        event_key: 'SUPPORT_TICKET_TRANSFERRED_AWAY',
        channel: 'both',
        email_subject: 'Support ticket moved – ' + SEMINAR,
        email_html: wrapHtml(
            'Support ticket moved',
            '<p>Dear {{full_name}},</p><p>Ticket <strong>{{ticket_id}}</strong> ({{ticket_subject}}) was moved to another account.</p><p>{{ticket_message}}</p>'
        ),
        whatsapp_body: 'Ticket {{ticket_id}} was moved to another account.'
    },
    {
        event_key: 'SUPPORT_AGENT_ALERT',
        channel: 'email',
        enabled: 1,
        email_subject: 'Support desk alert – ' + SEMINAR,
        email_html: wrapHtml(
            'Support desk alert',
            '<p>{{alert_title}}</p><p>{{alert_body}}</p>' +
                emailCtaButton('{{support_desk_url}}', 'Open support desk')
        ),
        whatsapp_body: ''
    },
    {
        event_key: 'CASE_JUDGE_ASSIGNED',
        channel: 'both',
        email_subject: 'Case assigned for judging — deadline {{marking_deadline}}',
        email_html: wrapHtml(
            'Case assigned',
            '<p>Dear {{judge_name}},</p><p>Case application <strong>{{application_no}}</strong> ({{case_topic}}) has been assigned to you for judging.</p>' +
                '<p><strong>Marking deadline (IST):</strong> {{marking_deadline}}</p>' +
                '<p>Submit your marks in the judge portal before this date. After the deadline, marking is locked.</p>' +
                emailCtaButton('{{portal_login_url}}', 'Open judge portal')
        ),
        whatsapp_body:
            'Case {{application_no}} assigned. Mark by {{marking_deadline}} IST. Judge portal: {{portal_login_url}}'
    },
    {
        event_key: 'CASE_JUDGE_MARKING_REMINDER',
        channel: 'email',
        email_subject: 'Reminder — pending case marks for {{application_no}}',
        email_html: wrapHtml(
            'Marking reminder',
            '<p>Dear {{judge_name}},</p><p>Your marks for case <strong>{{application_no}}</strong> ({{case_topic}}) are still pending.</p>' +
                '<p><strong>Deadline (IST):</strong> {{marking_deadline}}</p><p>Please sign in and submit scores before the deadline.</p>' +
                emailCtaButton('{{portal_login_url}}', 'Score in judge portal')
        ),
        whatsapp_body:
            'Reminder: case {{application_no}} marks pending. Deadline {{marking_deadline}} IST. {{portal_login_url}}'
    },
    {
        event_key: 'CASE_JUDGE_TRANSFER_ASSIGNED',
        channel: 'both',
        email_subject: 'Case assigned to you for judging – ' + SEMINAR,
        email_html: wrapHtml(
            'Case assignment',
            '<p>Dear {{judge_name}},</p><p>Case application <strong>{{application_no}}</strong> ({{case_topic}}) has been assigned to you for judging by {{transferred_by}}.</p>' +
                emailCtaButton('{{portal_login_url}}', 'Open judge portal')
        ),
        whatsapp_body: 'Case {{application_no}} assigned to you. Judge portal: {{portal_login_url}}'
    },
    {
        event_key: 'CASE_MESSAGE_FROM_JUDGE',
        channel: 'both',
        email_subject: 'Message from judge on your case – ' + SEMINAR,
        email_html: wrapHtml(
            'Judge message',
            '<p>Dear {{full_name}},</p><p><strong>{{judge_name}}</strong> sent a message about case <strong>{{application_no}}</strong> ({{case_topic}}):</p>' +
                '<blockquote style="border-left:4px solid #7c3aed;padding:8px 14px;background:#f5f3ff;">{{case_message}}</blockquote>' +
                emailCtaButton('{{portal_login_url}}', 'Reply in doctor portal')
        ),
        whatsapp_body:
            'Judge {{judge_name}} — case {{application_no}}: {{case_message}} — Reply: {{portal_login_url}}'
    },
    {
        event_key: 'CASE_MESSAGE_FROM_PARTICIPANT',
        channel: 'both',
        email_subject: 'Participant replied on case {{application_no}} – ' + SEMINAR,
        email_html: wrapHtml(
            'Participant reply',
            '<p>Dear {{judge_name}},</p><p><strong>{{participant_name}}</strong> replied on case <strong>{{application_no}}</strong>:</p>' +
                '<blockquote style="border-left:4px solid #059669;padding:8px 14px;background:#ecfdf5;">{{case_message}}</blockquote>' +
                emailCtaButton('{{portal_login_url}}', 'Open judge portal')
        ),
        whatsapp_body: '{{participant_name}} replied on {{application_no}}: {{case_message}} — {{portal_login_url}}'
    },
    {
        event_key: 'THREAD_REPLY_NEW_RESPONSE',
        channel: 'both',
        email_subject: 'You have a new response – ' + SEMINAR,
        email_html: wrapHtml(
            'New response',
            '<p>Dear {{full_name}},</p><p>Someone replied on <strong>{{thread_label}}</strong>:</p>' +
                '<blockquote style="border-left:4px solid #0d9488;padding:8px 14px;background:#f0fdfa;">{{message_preview}}</blockquote>' +
                '<p>Open your {{portal_name}} dashboard to read and reply:</p>' +
                emailCtaButton('{{dashboard_url}}', 'Open dashboard')
        ),
        whatsapp_body: 'New reply on {{thread_label}}. Open: {{dashboard_url}}'
    },
    {
        event_key: 'CASE_PRIORITY_INVITED',
        channel: 'both',
        email_subject: 'Complete your case application (priority) – ' + SEMINAR,
        email_html: wrapHtml(
            'Priority case selection',
            '<p>Dear {{full_name}},</p><p>You have been selected for <strong>{{program_title}}</strong>. Application <strong>{{application_no}}</strong> was started from your profile — sign in to complete any missing details and upload your presentation files. Your application will receive <strong>priority review</strong>.</p>' +
                emailCtaButton('{{portal_login_url}}', 'Complete application')
        ),
        whatsapp_body:
            'Priority case invite {{application_no}} for {{program_title}}. Complete in doctor portal: {{portal_login_url}}'
    },
    {
        event_key: 'CASE_JUDGE_TRANSFER_REMOVED',
        channel: 'both',
        email_subject: 'Case assignment transferred – ' + SEMINAR,
        email_html: wrapHtml(
            'Case reassigned',
            '<p>Dear {{judge_name}},</p><p>Case <strong>{{application_no}}</strong> has been reassigned from you to {{to_judge_name}} by {{transferred_by}}.</p>'
        ),
        whatsapp_body: 'Case {{application_no}} reassigned to {{to_judge_name}}.'
    },
    {
        event_key: 'WHATSAPP_GROUP_INVITE',
        channel: 'whatsapp',
        email_subject: 'Join the seminar WhatsApp group',
        email_html: wrapHtml(
            'WhatsApp group',
            '<p>Dear {{full_name}},</p><p>Payment is confirmed. Join the official seminar WhatsApp group for updates:</p>' +
                '<p><a href="{{whatsapp_group_link}}">{{whatsapp_group_link}}</a></p>'
        ),
        whatsapp_body: 'Hello {{first_name}}, join the seminar WhatsApp group: {{whatsapp_group_link}}'
    },
    {
        event_key: 'PAYMENT_FAILED',
        channel: 'both',
        email_subject: 'Payment Failed – ' + SEMINAR,
        email_html: wrapHtml(
            'Payment failed',
            '<p>Dear {{full_name}},</p><p>Your payment for ' +
                SEMINAR +
                ' could not be completed. Please try again from <a href="{{portal_login_url}}">the doctor portal</a>.</p>'
        ),
        whatsapp_body: 'Payment failed for {{seminar_name}}. Please retry via {{portal_login_url}}'
    },
    {
        event_key: 'WAITLIST_CONFIRMED',
        channel: 'both',
        email_subject: 'Seat available — complete payment ({{application_no}})',
        email_html: wrapHtml(
            'Waitlist — seat offered',
            '<p>Dear {{full_name}},</p><p>Good news: a seat has opened for <strong>{{seminar_name}}</strong>. Your waitlisted application <strong>{{application_no}}</strong> can now proceed to payment.</p>' +
                '<p>Please complete payment soon to confirm your registration.</p>' +
                emailCtaButton('{{portal_login_url}}', 'Pay now in doctor portal')
        ),
        whatsapp_body:
            'Hello {{first_name}}, a seat opened for {{seminar_name}}. Application {{application_no}} — complete payment: {{portal_login_url}}'
    },
    {
        event_key: 'BOOK_ORDER_PLACED',
        channel: 'both',
        email_subject: 'Book order received — {{order_code}}',
        email_html: wrapHtml(
            'Book order placed',
            '<p>Dear {{full_name}},</p><p>We received your book order <strong>{{order_code}}</strong>.</p>' +
                '<p><strong>Items:</strong><br>{{order_items_html}}</p>' +
                '<p>Total: ₹{{order_total}} · {{fulfillment_type}}</p>' +
                '<p>Status: {{order_status}}</p>' +
                emailCtaButton('{{doctor_portal_url}}', 'View order in portal')
        ),
        whatsapp_body:
            'Book order {{order_code}} placed. Total ₹{{order_total}}. Track in doctor portal: {{doctor_portal_url}}'
    },
    {
        event_key: 'BOOK_ORDER_CONFIRMED',
        channel: 'both',
        email_subject: 'Book order confirmed — {{order_code}}',
        email_html: wrapHtml(
            'Book order confirmed',
            '<p>Dear {{full_name}},</p><p>Your book order <strong>{{order_code}}</strong> is confirmed.</p>' +
                '<p>{{fulfillment_type}}</p>' +
                '<p><strong>Items:</strong><br>{{order_items_html}}</p>' +
                emailCtaButton('{{doctor_portal_url}}', 'Open doctor portal')
        ),
        whatsapp_body: 'Book order {{order_code}} confirmed. {{fulfillment_type}} — {{doctor_portal_url}}'
    },
    {
        event_key: 'BOOK_ORDER_SHIPPING_READY',
        channel: 'both',
        email_subject: 'Shipping details saved — {{order_code}}',
        email_html: wrapHtml(
            'Preparing shipment',
            '<p>Dear {{full_name}},</p><p>Shipping details for book order <strong>{{order_code}}</strong> are saved.</p>' +
                '<p><strong>Ship to:</strong> {{shipping_recipient}} · {{shipping_phone}}<br>{{shipping_address}}</p>' +
                '<p>{{parcel_summary}}</p><p>Courier charge: {{courier_charge}}</p>' +
                '<p>We will notify you when your parcel is dispatched with tracking.</p>' +
                emailCtaButton('{{doctor_portal_url}}', 'Track order')
        ),
        whatsapp_body:
            'Shipping saved for book order {{order_code}} to {{shipping_pincode}}. We will send AWB when dispatched.'
    },
    {
        event_key: 'BOOK_SHIPMENT_CREATED',
        channel: 'both',
        email_subject: 'Shipment booked — {{order_code}} · AWB {{tracking_no}}',
        email_html: wrapHtml(
            'Shipment created',
            '<p>Dear {{full_name}},</p><p>Your book order <strong>{{order_code}}</strong> has been handed to the courier.</p>' +
                '<p><strong>AWB / tracking:</strong> {{tracking_no}}<br><strong>Courier:</strong> {{courier_provider}}</p>' +
                '<p>Live tracking is available in your doctor portal.</p>' +
                emailCtaButton('{{doctor_portal_url}}', 'Track shipment')
        ),
        whatsapp_body:
            'Book order {{order_code}} shipped. AWB {{tracking_no}} ({{courier_provider}}). Track: {{doctor_portal_url}}'
    },
    {
        event_key: 'BOOK_ORDER_SHIPPED',
        channel: 'both',
        email_subject: 'Book order dispatched — {{order_code}}',
        email_html: wrapHtml(
            'Order dispatched',
            '<p>Dear {{full_name}},</p><p>Book order <strong>{{order_code}}</strong> is on the way.</p>' +
                '<p><strong>Tracking:</strong> {{tracking_no}} ({{courier_provider}})</p>' +
                emailCtaButton('{{doctor_portal_url}}', 'Track package')
        ),
        whatsapp_body: 'Book {{order_code}} dispatched. AWB {{tracking_no}}. Track: {{doctor_portal_url}}'
    },
    {
        event_key: 'BOOK_ORDER_OUT_FOR_DELIVERY',
        channel: 'both',
        email_subject: 'Out for delivery — {{order_code}}',
        email_html: wrapHtml(
            'Out for delivery',
            '<p>Dear {{full_name}},</p><p>Your book parcel for order <strong>{{order_code}}</strong> is <strong>out for delivery</strong> today.</p>' +
                '<p>AWB: {{tracking_no}} · {{track_status_label}}</p>' +
                emailCtaButton('{{doctor_portal_url}}', 'View tracking')
        ),
        whatsapp_body: 'Book order {{order_code}} is out for delivery. AWB {{tracking_no}}.'
    },
    {
        event_key: 'BOOK_ORDER_DELIVERED',
        channel: 'both',
        email_subject: 'Delivered — book order {{order_code}}',
        email_html: wrapHtml(
            'Delivered',
            '<p>Dear {{full_name}},</p><p>Book order <strong>{{order_code}}</strong> has been <strong>delivered</strong>.</p>' +
                '<p>Thank you for ordering from the seminar book desk.</p>' +
                emailCtaButton('{{doctor_portal_url}}', 'View order')
        ),
        whatsapp_body: 'Book order {{order_code}} delivered. Thank you!'
    },
    {
        event_key: 'BOOK_ORDER_CANCELLED',
        channel: 'both',
        email_subject: 'Book order cancelled — {{order_code}}',
        email_html: wrapHtml(
            'Order cancelled',
            '<p>Dear {{full_name}},</p><p>Book order <strong>{{order_code}}</strong> has been cancelled.</p>' +
                '<p>If you have questions, contact {{admin_contact}}.</p>'
        ),
        whatsapp_body: 'Book order {{order_code}} was cancelled. Contact support if this is unexpected.'
    },
    {
        event_key: 'BOOK_LINE_CANCELLED',
        channel: 'both',
        email_subject: 'Item removed from order {{order_code}}',
        email_html: wrapHtml(
            'Order updated',
            '<p>Dear {{full_name}},</p><p>An item was removed from book order <strong>{{order_code}}</strong>.</p>' +
                '<p>Updated total: ₹{{order_total}}</p>' +
                emailCtaButton('{{doctor_portal_url}}', 'View order')
        ),
        whatsapp_body: 'Item removed from book order {{order_code}}. New total ₹{{order_total}}.'
    }
];

EVENT_KEYS.forEach((key) => {
    if (!DEFAULT_TEMPLATES.find((t) => t.event_key === key)) {
        DEFAULT_TEMPLATES.push({
            event_key: key,
            channel: 'both',
            enabled: 1,
            email_subject: key.replace(/_/g, ' ') + ' – ' + SEMINAR,
            email_html: wrapHtml(key.replace(/_/g, ' '), '<p>Dear {{full_name}},</p><p>Update for ' + SEMINAR + '.</p>'),
            whatsapp_body: 'Hello {{first_name}}, update for ' + SEMINAR + '.'
        });
    }
});

DEFAULT_TEMPLATES.forEach((t) => {
    if (t.enabled == null) t.enabled = 1;
});

module.exports = { EVENT_KEYS, DEFAULT_TEMPLATES, wrapHtml, emailCtaButton, SEMINAR };
