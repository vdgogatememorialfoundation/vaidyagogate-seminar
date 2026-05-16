/** Default notification templates (admin-editable after seed). */
const EVENT_KEYS = [
    'ACCOUNT_CREATED',
    'FORGOT_PASSWORD',
    'OTP_VERIFICATION',
    'EMAIL_VERIFICATION',
    'SEMINAR_REGISTRATION_SUCCESS',
    'PAYMENT_SUCCESS',
    'PAYMENT_FAILED',
    'PAYMENT_PENDING',
    'APPLICATION_UNDER_REVIEW',
    'APPLICATION_APPROVED',
    'APPLICATION_REJECTED',
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
    'ADMIN_ANNOUNCEMENT',
    'WHATSAPP_GROUP_INVITE',
    'INVOICE_GENERATED',
    'REFUND_INITIATED',
    'REFUND_COMPLETED',
    'REGISTRATION_CANCELLED',
    'WAITLIST_CONFIRMED'
];

function wrapHtml(title, body) {
    return (
        '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1a1f36;">' +
        '<div style="background:#f8fafc;padding:20px;border-radius:12px 12px 0 0;border:1px solid #e2e8f0;">' +
        '<strong style="color:#1e3a8a;">' +
        title +
        '</strong></div>' +
        '<div style="padding:20px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;line-height:1.6;">' +
        body +
        '<p style="margin-top:20px;font-size:12px;color:#64748b;">{{admin_contact}}</p></div></div>'
    ).replace(/<\/?motion/g, (m) => m.replace('motion', 'div'));
}

const DEFAULT_TEMPLATES = [
    {
        event_key: 'ACCOUNT_CREATED',
        channel: 'both',
        email_subject: 'Welcome to {{seminar_name}} Portal – Your Account Details',
        email_html: wrapHtml(
            'Welcome',
            '<p>Dear Dr. {{full_name}},</p><p>Your account has been created successfully.</p>' +
                '<p><strong>Login:</strong> {{email}}<br>{{temporary_password}}</p>' +
                '<p><a href="{{portal_login_url}}">Open doctor portal</a></p>' +
                '<p>Please change your password after login.</p><p>Regards,<br>{{seminar_name}} Team</p>'
        ),
        whatsapp_template_name: '',
        whatsapp_body:
            'Hello Dr. {{first_name}}, your account is ready.\nLogin: {{email}}\n{{temporary_password}}\n{{portal_login_url}}'
    },
    {
        event_key: 'FORGOT_PASSWORD',
        channel: 'both',
        email_subject: 'Password Reset Request',
        email_html: wrapHtml(
            'Password reset',
            '<p>Dear {{full_name}},</p><p>Reset your password:</p><p><a href="{{forgot_password_link}}">{{forgot_password_link}}</a></p>' +
                '<p>If you did not request this, ignore this message.</p>'
        ),
        whatsapp_body: 'Hello {{first_name}}, reset your password: {{forgot_password_link}}'
    },
    {
        event_key: 'OTP_VERIFICATION',
        channel: 'both',
        email_subject: 'Your verification code',
        email_html: wrapHtml('Verification code', '<p>Hello {{first_name}},</p><p>Your code is: <strong>{{otp_code}}</strong></p><p>Valid for a short time.</p>'),
        whatsapp_body: 'Hello {{first_name}}, your verification code is {{otp_code}}.'
    },
    {
        event_key: 'SEMINAR_REGISTRATION_SUCCESS',
        channel: 'both',
        email_subject: 'Seminar Registration Successful',
        email_html: wrapHtml(
            'Registration received',
            '<p>Dear {{full_name}},</p><p>You registered for <strong>{{seminar_name}}</strong>.</p>' +
                '<p>Venue: {{seminar_venue}}<br>Date: {{seminar_date}}<br>Status: {{approval_status}}</p>'
        ),
        whatsapp_body: 'Hello {{first_name}}, registration received for {{seminar_name}}. Status: {{approval_status}}'
    },
    {
        event_key: 'PAYMENT_SUCCESS',
        channel: 'both',
        email_subject: 'Payment Successful',
        email_html: wrapHtml(
            'Payment received',
            '<p>Dear {{full_name}},</p><p>Payment received for {{seminar_name}}.</p>' +
                '<p>Amount: ₹{{payment_amount}}<br>Status: {{payment_status}}</p>' +
                '<p><a href="{{invoice_url}}">Invoice</a></p>'
        ),
        whatsapp_body: 'Payment successful for {{seminar_name}}. Amount: ₹{{payment_amount}}'
    },
    {
        event_key: 'PAYMENT_FAILED',
        channel: 'both',
        email_subject: 'Payment Failed',
        email_html: wrapHtml('Payment failed', '<p>Dear {{full_name}},</p><p>Your payment for {{seminar_name}} could not be completed. Please try again from {{portal_login_url}}</p>'),
        whatsapp_body: 'Payment failed for {{seminar_name}}. Please retry via {{portal_login_url}}'
    },
    {
        event_key: 'APPLICATION_APPROVED',
        channel: 'both',
        email_subject: 'Application Approved',
        email_html: wrapHtml('Approved', '<p>Dear {{full_name}},</p><p>Your application for {{seminar_name}} has been approved. Status: {{approval_status}}</p>'),
        whatsapp_body: 'Hello {{first_name}}, your application for {{seminar_name}} is approved.'
    },
    {
        event_key: 'APPLICATION_REJECTED',
        channel: 'both',
        email_subject: 'Application Update',
        email_html: wrapHtml(
            'Application not approved',
            '<p>Dear {{full_name}},</p><p>Your application for {{seminar_name}} was not approved.</p><p>Reason: {{rejection_reason}}</p>'
        ),
        whatsapp_body: 'Hello {{first_name}}, application for {{seminar_name}} was not approved. {{rejection_reason}}'
    },
    {
        event_key: 'TICKET_ISSUED',
        channel: 'both',
        email_subject: 'Your Seminar Ticket is Ready',
        email_html: wrapHtml(
            'E-ticket ready',
            '<p>Dear {{full_name}},</p><p>Ticket ID: {{ticket_id}}</p><p><a href="{{qr_code_url}}">View QR ticket</a></p>' +
                '<p>Payment: {{payment_status}}</p><p><a href="{{portal_login_url}}">Doctor portal</a></p>'
        ),
        whatsapp_body: 'Your ticket for {{seminar_name}} is ready. ID: {{ticket_id}} {{portal_login_url}}'
    },
    {
        event_key: 'CHECK_IN_SUCCESS',
        channel: 'both',
        email_subject: 'Check-in Confirmed',
        email_html: wrapHtml('Checked in', '<p>Dear {{full_name}},</p><p>You are checked in for {{seminar_name}}.</p>'),
        whatsapp_body: 'Check-in confirmed for {{seminar_name}}.'
    },
    {
        event_key: 'CERTIFICATE_AVAILABLE',
        channel: 'both',
        email_subject: 'Certificate Available',
        email_html: wrapHtml(
            'Certificate ready',
            '<p>Dear {{full_name}},</p><p>Your certificate for {{seminar_name}} is ready.</p><p><a href="{{certificate_url}}">Download certificate</a></p>'
        ),
        whatsapp_body: 'Certificate ready for {{seminar_name}}: {{certificate_url}}'
    },
    {
        event_key: 'SEMINAR_REMINDER',
        channel: 'both',
        email_subject: 'Seminar Reminder – {{seminar_name}}',
        email_html: wrapHtml('Reminder', '<p>Dear {{full_name}},</p><p>Reminder: {{seminar_name}} on {{seminar_date}} at {{seminar_venue}}.</p>'),
        whatsapp_body: 'Reminder: {{seminar_name}} on {{seminar_date}}.'
    },
    {
        event_key: 'ADMIN_ANNOUNCEMENT',
        channel: 'both',
        email_subject: '{{seminar_name}} – Announcement',
        email_html: wrapHtml('Announcement', '<p>{{full_name}},</p><p>{{announcement_body}}</p>'),
        whatsapp_body: '{{announcement_body}}'
    },
    {
        event_key: 'WHATSAPP_GROUP_INVITE',
        channel: 'both',
        email_subject: 'Join the seminar WhatsApp group',
        email_html: wrapHtml('WhatsApp group', '<p>Join: <a href="{{whatsapp_group_link}}">{{whatsapp_group_link}}</a></p>'),
        whatsapp_body: 'Join the {{seminar_name}} group: {{whatsapp_group_link}}'
    }
];

// Fill missing events with minimal defaults
EVENT_KEYS.forEach((key) => {
    if (!DEFAULT_TEMPLATES.find((t) => t.event_key === key)) {
        DEFAULT_TEMPLATES.push({
            event_key: key,
            channel: 'both',
            enabled: 1,
            email_subject: key.replace(/_/g, ' '),
            email_html: wrapHtml(key.replace(/_/g, ' '), '<p>Dear {{full_name}},</p><p>Notification: {{seminar_name}}</p>'),
            whatsapp_body: 'Hello {{first_name}}, update for {{seminar_name}}.'
        });
    }
});

DEFAULT_TEMPLATES.forEach((t) => {
    if (t.enabled == null) t.enabled = 1;
});

module.exports = { EVENT_KEYS, DEFAULT_TEMPLATES, wrapHtml };
