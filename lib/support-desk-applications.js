/**
 * Support agent — read-only application detail for doctors.
 */
const portalTracking = require('./portal-tracking');

function parseJson(raw) {
    if (!raw) return null;
    try {
        return typeof raw === 'object' ? raw : JSON.parse(String(raw));
    } catch (_) {
        return null;
    }
}

function formatFormEntries(formData) {
    const data = formData && typeof formData === 'object' ? formData : {};
    return Object.keys(data)
        .filter((k) => data[k] != null && String(data[k]).trim() !== '')
        .map((k) => ({ key: k, value: data[k] }));
}

function loadRegistrationDetail(db, regId, cb) {
    const id = parseInt(regId, 10);
    if (!Number.isInteger(id)) return cb(new Error('Invalid registration id'));
    db.get(
        `SELECT r.id, r.user_id, r.seminar_id, r.application_no, r.status, r.form_data, r.doc_review_json,
                r.created_at, r.updated_at,
                s.title AS seminar_title, s.event_date, s.price, s.portal_year, s.registration_start, s.registration_end,
                u.first_name, u.last_name, u.email, u.phone, u.user_id_string
         FROM registrations r
         JOIN users u ON u.id = r.user_id
         LEFT JOIN seminars s ON s.id = r.seminar_id
         WHERE r.id = ?`,
        [id],
        (err, row) => {
            if (err) return cb(err);
            if (!row) return cb(null, null);
            const formData = parseJson(row.form_data);
            const docReview = parseJson(row.doc_review_json);
            db.all(
                `SELECT order_id_string, amount, status, payment_date, payment_method, transaction_id
                 FROM orders WHERE registration_id = ? ORDER BY id DESC`,
                [id],
                (eO, orders) => {
                    if (eO) return cb(eO);
                    portalTracking.attachRegistrationTimelines(db, [row], (eT, enriched) => {
                        const base = (enriched && enriched[0]) || row;
                        cb(null, {
                            type: 'seminar',
                            id: row.id,
                            userId: row.user_id,
                            applicationNo: row.application_no,
                            status: row.status,
                            seminarId: row.seminar_id,
                            seminarTitle: row.seminar_title,
                            eventDate: row.event_date,
                            seminarPrice: row.price,
                            portalYear: row.portal_year,
                            createdAt: row.created_at,
                            updatedAt: row.updated_at,
                            formData,
                            formFields: formatFormEntries(formData),
                            docReview,
                            timeline: base.timeline || null,
                            orders: orders || [],
                            participant: {
                                name: [row.first_name, row.last_name].filter(Boolean).join(' '),
                                email: row.email,
                                phone: row.phone,
                                portalId: row.user_id_string
                            }
                        });
                    });
                }
            );
        }
    );
}

function loadCaseSubmissionDetail(db, caseId, cb) {
    const id = parseInt(caseId, 10);
    if (!Number.isInteger(id)) return cb(new Error('Invalid case submission id'));
    db.get(
        `SELECT cs.id, cs.user_id, cs.application_no, cs.status, cs.category, cs.title, cs.form_data,
                cs.doc_review_json, cs.created_at, cs.updated_at, cs.marking_deadline, cs.plagiarism_zero,
                cp.title AS program_title, cp.id AS program_id,
                u.first_name, u.last_name, u.email, u.phone, u.user_id_string
         FROM case_submissions cs
         JOIN users u ON u.id = cs.user_id
         LEFT JOIN case_programs cp ON cp.id = cs.case_program_id
         WHERE cs.id = ?`,
        [id],
        (err, row) => {
            if (err) return cb(err);
            if (!row) return cb(null, null);
            const formData = parseJson(row.form_data);
            const docReview = parseJson(row.doc_review_json);
            db.all(
                `SELECT id, original_name, file_path, mime_type, size_bytes, sort_order, status, created_at
                 FROM case_files WHERE submission_id = ? ORDER BY sort_order, id ASC`,
                [id],
                (eF, files) => {
                    if (eF) return cb(eF);
                    cb(null, {
                        type: 'case',
                        id: row.id,
                        userId: row.user_id,
                        applicationNo: row.application_no,
                        status: row.status,
                        category: row.category,
                        title: row.title,
                        programTitle: row.program_title,
                        programId: row.program_id,
                        markingDeadline: row.marking_deadline,
                        plagiarismZero: !!row.plagiarism_zero,
                        createdAt: row.created_at,
                        updatedAt: row.updated_at,
                        formData,
                        formFields: formatFormEntries(formData),
                        docReview,
                        files: (files || []).map((f) => ({
                            id: f.id,
                            name: f.original_name,
                            path: f.file_path,
                            size: f.size_bytes,
                            uploadedAt: f.created_at,
                            mimeType: f.mime_type,
                            status: f.status
                        })),
                        participant: {
                            name: [row.first_name, row.last_name].filter(Boolean).join(' '),
                            email: row.email,
                            phone: row.phone,
                            portalId: row.user_id_string
                        }
                    });
                }
            );
        }
    );
}

module.exports = {
    loadRegistrationDetail,
    loadCaseSubmissionDetail,
    formatFormEntries
};
