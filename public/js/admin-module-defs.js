/* Admin module (tab) list shared by server (lib) and admin UI. */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.ADMIN_MODULE_DEFS = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    return [
        { id: 'tab-doctors', label: 'Doctors' },
        { id: 'tab-seminars', label: 'Seminar Management' },
        { id: 'tab-event-schedules', label: 'Event Schedules' },
        { id: 'tab-applications', label: 'Review Applications' },
        { id: 'tab-payment-followup', label: 'Payment Follow-up' },
        { id: 'tab-case-applications', label: 'Review case applications' },
        { id: 'tab-feedback', label: 'Seminar Feedback' },
        { id: 'tab-support-tickets', label: 'Support Tickets' },
        { id: 'tab-support-desk', label: 'Support desk' },
        { id: 'tab-contact-inquiries', label: 'Website contact' },
        { id: 'tab-email-compose', label: 'Send email' },
        { id: 'tab-transfer', label: 'Transfer Applications' },
        { id: 'tab-behalf-reg', label: 'Doctor applications (admin)' },
        { id: 'tab-volunteer-app', label: 'Volunteer applications (admin)' },
        { id: 'tab-reg-form', label: 'Registration Form Fields' },
        { id: 'tab-site-cms', label: 'Website & doctor updates' },
        { id: 'tab-admin-payments', label: 'Payments' },
        { id: 'tab-cancellation-review', label: 'Cancellation review' },
        { id: 'tab-refund-tracking', label: 'Refund tracking' },
        { id: 'tab-book-sales', label: 'Book sales' },
        { id: 'tab-certificates', label: 'Certificate Management' },
        { id: 'tab-volunteers', label: 'Volunteers' },
        { id: 'tab-volunteer-assignments', label: 'Volunteer assignments' },
        { id: 'tab-case-mgmt', label: 'Case Management' },
        { id: 'tab-analytics', label: 'Analytics' },
        { id: 'tab-reports', label: 'Reports & Exports' },
        { id: 'tab-etickets', label: 'E-tickets' },
        { id: 'tab-scanner-logs', label: 'Scanner Activity' },
        { id: 'tab-live-scanner', label: 'Live check-in board' },
        { id: 'tab-pos', label: 'On-spot POS' },
        { id: 'tab-feedback-form', label: 'Feedback form editor' },
        { id: 'tab-activity-logs', label: 'User & doctor activity' },
        { id: 'tab-notifications', label: 'Notifications' },
        { id: 'tab-whatsapp', label: 'WhatsApp' },
        { id: 'tab-live-radar', label: 'Application Radar' },
        { id: 'tab-system-platform', label: 'System health' },
        { id: 'tab-system-users', label: 'User health' },
        { id: 'tab-settings', label: 'Global Settings' }
    ];
});
