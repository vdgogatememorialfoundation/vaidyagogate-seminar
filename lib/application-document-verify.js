/**
 * Admin document / information verification for seminar registrations and case submissions.
 */
function ignoreErr(e) {
    if (e && !/duplicate column|already exists/i.test(String(e.message))) {
        console.warn('[doc-verify]', e.message);
    }
}

function ensureDocumentVerifySchema(db, ignoreSchemaMigrationErr, next) {
    const alters = [
        `ALTER TABLE registrations ADD COLUMN doc_review_json TEXT`,
        `ALTER TABLE case_submissions ADD COLUMN doc_review_json TEXT`
    ];
    let i = 0;
    const step = () => {
        if (i >= alters.length) return next && next();
        db.run(alters[i++], (e) => {
            if (ignoreSchemaMigrationErr) ignoreSchemaMigrationErr(e);
            else ignoreErr(e);
            step();
        });
    };
    step();
}

function parseDocReview(raw) {
    if (!raw) return null;
    try {
        const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return o && typeof o === 'object' ? o : null;
    } catch (_) {
        return null;
    }
}

function stringifyDocReview(obj) {
    return JSON.stringify(obj || {});
}

function needsAdvancedQualDocs(formData) {
    const q = String((formData && formData.qual) || '').trim();
    return q === 'PG' || q === 'Practicing Vaidya' || q === 'Practitioner';
}

/**
 * Seminar registration — admin verify
 * decision: approve | reject_documents | reject_application
 */
function verifySeminarApplication(db, registrationId, body, deps, cb) {
    const rid = parseInt(registrationId, 10);
    const decision = String((body && body.decision) || '').toLowerCase();
    const reason = String((body && body.reason) || '').trim();
    const infoOk = !!(body && body.infoOk);
    const ncismOk = !!(body && body.ncismOk);
    const certificateOk = !!(body && body.certificateOk);
    const { portalTracking, notifEngine, getOrCreatePendingOrder } = deps;

    if (!Number.isInteger(rid) || rid < 1) {
        return cb(null, { ok: false, error: 'Invalid application id' });
    }
    if (!['approve', 'reject_documents', 'reject_application', 'request_documents'].includes(decision)) {
        return cb(null, {
            ok: false,
            error: 'decision must be approve, reject_documents, reject_application, or request_documents'
        });
    }

    db.get(
        `SELECT r.*, u.first_name, u.last_name, u.email, s.title AS seminar_title
         FROM registrations r
         JOIN users u ON u.id = r.user_id
         LEFT JOIN seminars s ON s.id = r.seminar_id
         WHERE r.id = ?`,
        [rid],
        (e, row) => {
            if (e) return cb(e);
            if (!row) return cb(null, { ok: false, error: 'Application not found' });

            let formData = {};
            try {
                formData = JSON.parse(row.form_data || '{}');
            } catch (_) {
                formData = {};
            }
            const needsDocs = needsAdvancedQualDocs(formData);
            const hasCert = !!(formData.certificate_path && String(formData.certificate_path).trim());
            const hasNcism = !!(formData.ncism && String(formData.ncism).trim());

            if (decision === 'approve') {
                if (!infoOk) {
                    return cb(null, { ok: false, error: 'Confirm that application details are correct before approving.' });
                }
                if (needsDocs) {
                    if (!hasNcism) {
                        return cb(null, { ok: false, error: 'NCISM / registration number is missing on the application.' });
                    }
                    if (!hasCert) {
                        return cb(null, { ok: false, error: 'Certificate document is missing on the application.' });
                    }
                    if (!ncismOk) {
                        return cb(null, {
                            ok: false,
                            error: 'NCISM / registration number must be marked correct, or use Reject documents.'
                        });
                    }
                    if (!certificateOk) {
                        return cb(null, {
                            ok: false,
                            error: 'Certificate document must be marked correct, or use Reject documents.'
                        });
                    }
                }
            }

            if (decision === 'reject_documents' && !reason) {
                return cb(null, { ok: false, error: 'Rejection reason is required so the doctor knows what to fix.' });
            }
            if (decision === 'reject_application' && !reason) {
                return cb(null, { ok: false, error: 'Rejection reason is required.' });
            }
            if (decision === 'request_documents' && !reason) {
                return cb(null, { ok: false, error: 'Describe which documents you need from the doctor.' });
            }

            const requestedDocs = Array.isArray(body && body.requestedDocs)
                ? body.requestedDocs.map((x) => String(x || '').trim()).filter(Boolean)
                : String((body && body.requestedDocs) || '')
                      .split(',')
                      .map((x) => x.trim())
                      .filter(Boolean);

            const review = {
                info_ok: infoOk,
                ncism_ok: ncismOk,
                certificate_ok: certificateOk,
                reviewed_at: new Date().toISOString(),
                rejection_reason: reason || null,
                requested_docs: decision === 'request_documents' ? requestedDocs : null,
                decision
            };

            let newStatus;
            let notifyEvent;
            if (decision === 'approve') {
                newStatus = 'approved_pending_payment';
                notifyEvent = 'APPLICATION_APPROVED';
            } else if (decision === 'reject_documents') {
                newStatus = 'revision_required';
                notifyEvent = 'APPLICATION_REVISION_REQUIRED';
            } else if (decision === 'request_documents') {
                newStatus = 'documents_requested';
                notifyEvent = 'APPLICATION_REVISION_REQUIRED';
            } else {
                newStatus = 'rejected';
                notifyEvent = 'APPLICATION_REJECTED';
            }

            const st = String(row.status || '').toLowerCase();
            if (!['submitted', 'pending_approval', 'revision_required', 'documents_requested'].includes(st)) {
                return cb(null, {
                    ok: false,
                    error:
                        st === 'revision_required'
                            ? 'Waiting for the doctor to re-upload documents on this application.'
                            : 'This application cannot be verified in its current status.'
                });
            }
            if (['cancelled', 'checked_in', 'completed', 'e_ticket_issued', 'certificate_issued'].includes(st)) {
                return cb(null, {
                    ok: false,
                    error: 'This application has already progressed and cannot be changed this way.'
                });
            }

            db.run(
                `UPDATE registrations SET status = ?, doc_review_json = ? WHERE id = ?`,
                [newStatus, stringifyDocReview(review), rid],
                (e2) => {
                    if (e2) return cb(e2);
                    const prevStatus = st;
                    const logEntries = portalTracking.registrationStatusToLog(newStatus, prevStatus);
                    logEntries.forEach((entry) => {
                        portalTracking.logRegistrationEvent(db, rid, entry.key, entry.label, entry.message, () => {});
                    });
                    if (decision === 'reject_documents' || decision === 'request_documents') {
                        portalTracking.logRegistrationEvent(
                            db,
                            rid,
                            decision === 'request_documents' ? 'documents_requested' : 'revision_required',
                            decision === 'request_documents' ? 'Additional documents requested' : 'Documents need correction',
                            reason,
                            () => {}
                        );
                    }
                    notifEngine.notify(db, notifyEvent, {
                        userId: row.user_id,
                        seminarId: row.seminar_id,
                        registrationId: rid,
                        vars: {
                            application_no: row.application_no,
                            rejection_reason: reason,
                            seminar_title: row.seminar_title || ''
                        }
                    });
                    if (newStatus === 'approved_pending_payment' && getOrCreatePendingOrder) {
                        getOrCreatePendingOrder(rid, row.price || 1500, () => {});
                    }
                    cb(null, {
                        ok: true,
                        status: newStatus,
                        message:
                            decision === 'approve'
                                ? 'Application approved. Doctor can proceed to payment.'
                                : decision === 'reject_documents'
                                  ? 'Doctor notified to re-upload documents on the same application number.'
                                  : decision === 'request_documents'
                                    ? 'Doctor notified to upload additional verification documents.'
                                    : 'Application rejected.'
                    });
                }
            );
        }
    );
}

/**
 * Case submission — admin verify (after per-file review)
 */
function verifyCaseSubmission(db, submissionId, body, deps, cb) {
    const sid = parseInt(submissionId, 10);
    const decision = String((body && body.decision) || '').toLowerCase();
    const reason = String((body && body.reason) || '').trim();
    const infoOk = !!(body && body.infoOk);
    const filesOk = !!(body && body.filesOk);
    const { portalTracking, notifEngine } = deps;

    if (!Number.isInteger(sid) || sid < 1) {
        return cb(null, { ok: false, error: 'Invalid submission id' });
    }
    if (!['approve_for_judging', 'reject_documents', 'reject_application'].includes(decision)) {
        return cb(null, {
            ok: false,
            error: 'decision must be approve_for_judging, reject_documents, or reject_application'
        });
    }

    db.get(
        `SELECT cs.*, u.first_name, u.last_name, cp.title AS program_title
         FROM case_submissions cs
         JOIN users u ON u.id = cs.user_id
         LEFT JOIN case_programs cp ON cp.id = cs.case_program_id
         WHERE cs.id = ?`,
        [sid],
        (e, sub) => {
            if (e) return cb(e);
            if (!sub) return cb(null, { ok: false, error: 'Submission not found' });

            const subSt = String(sub.status || '').toLowerCase();
            if (!['submitted', 'under_review', 'resubmitted'].includes(subSt)) {
                return cb(null, {
                    ok: false,
                    error:
                        subSt === 'revision_required'
                            ? 'Waiting for the doctor to re-upload rejected files.'
                            : 'This case application cannot be verified in its current status.'
                });
            }

            db.all(`SELECT id, status FROM case_files WHERE submission_id = ?`, [sid], (eF, files) => {
                if (eF) return cb(eF);
                const list = files || [];
                const hasRejected = list.some((f) => String(f.status).toLowerCase() === 'rejected');
                const allApproved = list.length > 0 && list.every((f) => String(f.status).toLowerCase() === 'approved');

                if (decision === 'approve_for_judging') {
                    if (!infoOk) {
                        return cb(null, { ok: false, error: 'Confirm applicant details are correct.' });
                    }
                    if (!filesOk && !allApproved) {
                        return cb(null, {
                            ok: false,
                            error: 'Approve each file or mark all files as correct before approving for judging.'
                        });
                    }
                    if (hasRejected) {
                        return cb(null, {
                            ok: false,
                            error: 'Some files are rejected. Use Request document revision instead.'
                        });
                    }
                }
                if (decision === 'reject_documents' && !reason) {
                    return cb(null, { ok: false, error: 'Reason required for document revision request.' });
                }
                if (decision === 'reject_application' && !reason) {
                    return cb(null, { ok: false, error: 'Reason required.' });
                }

                const review = {
                    info_ok: infoOk,
                    files_ok: filesOk,
                    reviewed_at: new Date().toISOString(),
                    rejection_reason: reason || null,
                    decision
                };

                let newStatus;
                let notifyEvent;
                if (decision === 'approve_for_judging') {
                    newStatus = 'approved_for_judging';
                    notifyEvent = 'CASE_PRESENTATION_APPROVED';
                } else if (decision === 'reject_documents') {
                    newStatus = 'revision_required';
                    notifyEvent = 'CASE_PRESENTATION_NEEDS_CHANGES';
                } else {
                    newStatus = 'disqualified';
                    notifyEvent = 'CASE_PRESENTATION_REJECTED';
                }

                db.run(
                    `UPDATE case_submissions SET status = ?, doc_review_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                    [newStatus, stringifyDocReview(review), sid],
                    (e2) => {
                        if (e2) return cb(e2);
                        if (decision === 'reject_documents') {
                            portalTracking.logCaseEvent(
                                db,
                                sid,
                                'revision_required',
                                'Documents need correction',
                                reason,
                                () => {}
                            );
                        } else if (decision === 'approve_for_judging') {
                            portalTracking.logCaseEvent(
                                db,
                                sid,
                                'approved_for_judging',
                                'Approved for judging',
                                'Application details and documents verified.',
                                () => {}
                            );
                        }
                        notifEngine.notify(db, notifyEvent, {
                            userId: sub.user_id,
                            seminarId: null,
                            vars: {
                                application_no: sub.application_no || String(sub.id),
                                rejection_reason: reason,
                                program_title: sub.program_title || sub.title || ''
                            }
                        });
                        cb(null, {
                            ok: true,
                            status: newStatus,
                            message:
                                decision === 'approve_for_judging'
                                    ? 'Approved for judge assignment.'
                                    : decision === 'reject_documents'
                                      ? 'Doctor notified to re-upload on the same application ID.'
                                      : 'Case application rejected.'
                        });
                    }
                );
            });
        }
    );
}

function markCaseRevisionFromFileReject(db, submissionId, fileReason, deps, cb) {
    const sid = parseInt(submissionId, 10);
    const reason = String(fileReason || '').trim() || 'One or more files need to be re-uploaded.';
    const { portalTracking, notifEngine } = deps;
    db.get(`SELECT id, user_id, application_no, status, title FROM case_submissions WHERE id = ?`, [sid], (e, sub) => {
        if (e) return cb(e);
        if (!sub) return cb(null, { changed: false });
        const st = String(sub.status || '').toLowerCase();
        if (['selected', 'disqualified', 'cancelled'].includes(st)) {
            return cb(null, { changed: false });
        }
        const review = {
            files_ok: false,
            reviewed_at: new Date().toISOString(),
            rejection_reason: reason,
            decision: 'reject_documents'
        };
        db.run(
            `UPDATE case_submissions SET status = 'revision_required', doc_review_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [stringifyDocReview(review), sid],
            (e2) => {
                if (e2) return cb(e2);
                portalTracking.logCaseEvent(
                    db,
                    sid,
                    'revision_required',
                    'File rejected — re-upload required',
                    reason,
                    () => {}
                );
                notifEngine.notify(db, 'CASE_PRESENTATION_NEEDS_CHANGES', {
                    userId: sub.user_id,
                    vars: {
                        application_no: sub.application_no || String(sub.id),
                        rejection_reason: reason
                    }
                });
                cb(null, { changed: true, status: 'revision_required' });
            }
        );
    });
}

module.exports = {
    ensureDocumentVerifySchema,
    parseDocReview,
    needsAdvancedQualDocs,
    verifySeminarApplication,
    verifyCaseSubmission,
    markCaseRevisionFromFileReject
};
