/**
 * Staff portal section definitions (no imports — safe for sync/modules).
 */
const STAFF_PORTAL_SECTION_DEFS = [
    { id: 'inventory', label: 'Stock inventory', staffKey: 'book-inventory', adminKey: 'tab-book-sales' },
    { id: 'book-orders', label: 'Book orders', staffKey: 'book-orders', adminKey: 'tab-book-sales' },
    { id: 'applications', label: 'Applications', staffKey: 'applications', adminKey: 'tab-applications' },
    { id: 'support-tickets', label: 'Support tickets', staffKey: 'support-tickets', adminKey: 'tab-support-tickets' },
    { id: 'etickets', label: 'E-tickets', staffKey: 'etickets', adminKey: 'tab-etickets' },
    { id: 'payments', label: 'Payments & orders', staffKey: 'payments', adminKey: 'tab-admin-payments' }
];

module.exports = { STAFF_PORTAL_SECTION_DEFS };
