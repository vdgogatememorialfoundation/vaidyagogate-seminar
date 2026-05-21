/**
 * Judge ↔ participant messaging (in-portal thread + email notify).
 */
const emailSvc = require('./email-service');
const integrationSettings = require('./integration-settings');
const messageReplyAddress = require('./message-reply-address');
const notifEngine = require('./notification-engine');
const threadReplyNotify = require('./thread-reply-notify');

const LOG_TABLE = 'judge_communication_log';
const MSG_TABLE = 'case_participant_messages';

function isPostgresEnv() {
    return !!process.env.DATABASE_URL;
}

function ensureSchema(db, cb) {
    const pg = isPostgresEnv();
    const logSql = pg
        ? `CREATE TABLE IF NOT EXISTS ${LOG_TABLE} (
            id SERIAL PRIMARY KEY,
            judge_user_id INTEGER NOT NULL,
            submission_id INTEGER,
            registration_id INTEGER,
            participant_user_id INTEGER,
            channel TEXT NOT NULL DEFAULT 'email',
            subject TEXT,
            body_preview TEXT,
            to_address TEXT,
            from_display TEXT,
            status TEXT,
            error_message TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
        : `CREATE TABLE IF NOT EXISTS ${LOG_TABLE} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            judge_user_id INTEGER NOT NULL,
            submission_id INTEGER,
            registration_id INTEGER,
            participant_user_id INTEGER,
            channel TEXT NOT NULL DEFAULT 'email',
            subject TEXT,
            body_preview TEXT,
            to_address TEXT,
            from_display TEXT,
            status TEXT,
            error_message TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`;

    const msgSql = pg
        ? `CREATE TABLE IF NOT EXISTS ${MSG_TABLE} (
            id SERIAL PRIMARY KEY,
            submission_id INTEGER NOT NULL,
            judge_user_id INTEGER NOT NULL,
            direction TEXT NOT NULL,
            author_user_id INTEGER NOT NULL,
            subject TEXT,
            body TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
        : `CREATE TABLE IF NOT EXISTS ${MSG_TABLE} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            submission_id INTEGER NOT NULL,
            judge_user_id INTEGER NOT NULL,
            direction TEXT NOT NULL,
            author_user_id INTEGER NOT NULL,
            subject TEXT,
            body TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`;

    const idxSql = pg
        ? `CREATE INDEX IF NOT EXISTS idx_case_msg_sub ON ${MSG_TABLE} (submission_id, created_at ASC)`
        : `CREATE INDEX IF NOT EXISTS idx_case_msg_sub ON ${MSG_TABLE} (submission_id, created_at ASC)`;

    const srcCol = pg
        ? `ALTER TABLE ${MSG_TABLE} ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'portal'`
        : `ALTER TABLE ${MSG_TABLE} ADD COLUMN source TEXT DEFAULT 'portal'`;

    db.run(logSql, [], () => {
        db.run(msgSql, [], () => {
            db.run(srcCol, [], () => {
                db.run(idxSql, [], () => cb && cb());
            });
        });
    });
}

/** Ensure message tables exist before read/write (fixes missing PG relation on first use). */
function withMessageSchema(db, fn) {
    ensureSchema(db, (schemaErr) => {
        if (schemaErr) return fn(schemaErr);
        fn();
    });
}

function formatJudgeFromDisplay(judge) {
    const name = [judge.first_name, judge.last_name].filter(Boolean).join(' ').trim() || 'Judge';
    return `${name} | Vaidya Gogate Memorial Foundation`;
}

function formatJudgeShortName(judge) {
    return [judge.first_name, judge.last_name].filter(Boolean).join(' ').trim() || 'Judge';
}

function orgFromEmail() {
    const cfg = integrationSettings.getMailConfig();
    return (cfg && cfg.from) || process.env.ZOHO_FROM || process.env.ADMIN_CONTACT_EMAIL || '';
}

function publicDoctorPortalUrl() {
    const base =
        integrationSettings.getRuntimeIntegrations().public_base_url ||
        process.env.PUBLIC_BASE_URL ||
        'https://seminar.vaidyagogate.org';
    return String(base).replace(/\/$/, '') + '/doctor.html';
}

function parseParticipantFromSubmission(sub, userRow) {
    let fd = {};
    try {
        fd = typeof sub.form_data === 'string' ? JSON.parse(sub.form_data) : sub.form_data || {};
    } catch (_) {
        fd = {};
    }
    const fullName = [fd.fname || sub.first_name, fd.mname, fd.lname || sub.last_name]
        .filter(Boolean)
        .join(' ')
        .trim();
    return {
        fullName: fullName || 'Participant',
        email: (fd.email || userRow.email || '').trim(),
        phone: (fd.phone || userRow.phone || '').trim(),
        whatsapp: (fd.whatsapp || fd.phone || userRow.phone || '').trim(),
        topic: sub.title || fd.topic || '',
        application_no: sub.application_no || String(sub.id)
    };
}

function listSubmissionMessages(db, submissionId, cb) {
    withMessageSchema(db, (schemaErr) => {
        if (schemaErr) return cb(schemaErr);
        db.all(
            `SELECT m.*,
                    ju.first_name AS judge_first, ju.last_name AS judge_last,
                    au.first_name AS author_first, au.last_name AS author_last
             FROM ${MSG_TABLE} m
             LEFT JOIN users ju ON ju.id = m.judge_user_id
             LEFT JOIN users au ON au.id = m.author_user_id
             WHERE m.submission_id = ?
             ORDER BY m.created_at ASC`,
            [submissionId],
            (err, rows) => {
                if (err) return cb(err);
                const mapped = (rows || []).map((r) => ({
                    id: r.id,
                    submissionId: r.submission_id,
                    judgeUserId: r.judge_user_id,
                    direction: r.direction,
                    authorUserId: r.author_user_id,
                    subject: r.subject,
                    body: r.body,
                    source: r.source || 'portal',
                    createdAt: r.created_at,
                    judgeName: [r.judge_first, r.judge_last].filter(Boolean).join(' ').trim() || 'Judge',
                    authorName: [r.author_first, r.author_last].filter(Boolean).join(' ').trim() || ''
                }));
                cb(null, mapped);
            }
        );
    });
}

function firstThreadSubject(db, submissionId, cb) {
    withMessageSchema(db, (schemaErr) => {
        if (schemaErr) return cb(schemaErr);
        db.get(
            `SELECT subject FROM ${MSG_TABLE} WHERE submission_id = ? AND subject IS NOT NULL AND TRIM(subject) != '' ORDER BY id ASC LIMIT 1`,
            [submissionId],
            (err, row) => {
                if (err) return cb(err);
                cb(null, (row && row.subject) || null);
            }
        );
    });
}

function logCommunication(db, row, status, errorMessage) {
    db.run(
        `INSERT INTO ${LOG_TABLE} (judge_user_id, submission_id, participant_user_id, channel, subject, body_preview, to_address, from_display, status, error_message)
         VALUES (?, ?, ?, 'email', ?, ?, ?, ?, ?, ?)`,
        [
            row.judge_user_id,
            row.submission_id,
            row.participant_user_id || null,
            row.subject || null,
            (row.body_preview || '').slice(0, 500),
            row.to_address || null,
            row.from_display || null,
            status || 'sent',
            errorMessage || null
        ],
        () => {}
    );
}

function insertMessage(db, row, cb) {
    withMessageSchema(db, (schemaErr) => {
        if (schemaErr) return cb(schemaErr);
        const source = row.source || 'portal';
        const params = [
            row.submission_id,
            row.judge_user_id,
            row.direction,
            row.author_user_id,
            row.subject || null,
            row.body,
            source
        ];
        db.run(
            `INSERT INTO ${MSG_TABLE} (submission_id, judge_user_id, direction, author_user_id, subject, body, source)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
            params,
            function (err) {
                if (err && /source/i.test(String(err.message))) {
                    return db.run(
                        `INSERT INTO ${MSG_TABLE} (submission_id, judge_user_id, direction, author_user_id, subject, body)
                         VALUES (?, ?, ?, ?, ?, ?)`,
                        params.slice(0, 6),
                        function (err2) {
                            cb(err2, this && this.lastID);
                        }
                    );
                }
                cb(err, this && this.lastID);
            }
        );
    });
}

function notifyParticipantByEmail(judge, participant, subject, bodyText, submissionId) {
    const to = participant.email;
    if (!to) return Promise.resolve({ ok: false, skipped: true });
    const fromEmail = orgFromEmail();
    if (!fromEmail) return Promise.resolve({ ok: false, error: 'Email not configured' });
    const display = formatJudgeFromDisplay(judge);
    const portal = publicDoctorPortalUrl();
    const replyTo = messageReplyAddress.buildCaseReplyAddress(submissionId, judge.id);
    const refToken = messageReplyAddress.caseRefToken(submissionId, judge.id);
    const footer = messageReplyAddress.replyFooterNote(replyTo, refToken);
    const subjWithRef = refToken && subject.indexOf(refToken) < 0 ? `${subject} [${refToken}]` : subject;
    const html =
        '<div style="font-family:Arial,sans-serif;max-width:560px;line-height:1.6;color:#1e293b;">' +
        '<p>You have a new message from <strong>' +
        display.replace(/</g, '&lt;') +
        '</strong> regarding case application <strong>' +
        (participant.application_no || '').replace(/</g, '&lt;') +
        '</strong>.</p>' +
        '<div style="padding:16px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;margin:12px 0;">' +
        bodyText.replace(/\n/g, '<br>') +
        '</div>' +
        '<p>Sign in to the <a href="' +
        portal +
        '">Doctor portal</a>, open <strong>Track case applications</strong>, view your application, and reply under <strong>Messages from judges</strong>.</p></div>';
    return emailSvc.sendEmail(to, subjWithRef, html, {
        text: bodyText + footer + '\n\nReply in the Doctor portal: ' + portal,
        fromDisplay: display,
        fromEmail,
        replyTo: replyTo || undefined
    });
}

function notifyJudgeByEmail(judge, participant, subject, bodyText, applicationNo, submissionId) {
    const to = (judge.email || '').trim();
    if (!to) return Promise.resolve({ ok: false, skipped: true });
    const fromEmail = orgFromEmail();
    if (!fromEmail) return Promise.resolve({ ok: false, error: 'Email not configured' });
    const display = 'Vaidya Gogate Memorial Foundation';
    const portal =
        (integrationSettings.getRuntimeIntegrations().judge_host || process.env.JUDGE_HOST || '').trim() ||
        publicDoctorPortalUrl().replace('doctor.html', 'judge.html');
    const replyTo = messageReplyAddress.buildCaseReplyAddress(submissionId, judge.id);
    const refToken = messageReplyAddress.caseRefToken(submissionId, judge.id);
    const footer = messageReplyAddress.replyFooterNote(replyTo, refToken);
    const subjWithRef = refToken && subject.indexOf(refToken) < 0 ? `${subject} [${refToken}]` : subject;
    const html =
        '<div style="font-family:Arial,sans-serif;max-width:560px;line-height:1.6;">' +
        '<p><strong>' +
        (participant.fullName || 'Participant').replace(/</g, '&lt;') +
        '</strong> replied on application <strong>' +
        (applicationNo || '').replace(/</g, '&lt;') +
        '</strong>.</p>' +
        '<div style="padding:16px;background:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0;">' +
        bodyText.replace(/\n/g, '<br>') +
        '</div>' +
        '<p>Open the <a href="' + portal + '">Judge portal</a> to read and reply.</p></div>';
    return emailSvc.sendEmail(to, subjWithRef, html, {
        text: bodyText + footer,
        fromDisplay: display,
        fromEmail,
        replyTo: replyTo || undefined
    });
}

function notifyCaseMessageViaEngine(db, userId, eventKey, vars, cb) {
    if (!userId) return cb && cb(null, { skipped: true });
    notifEngine.notify(db, eventKey, { userId, vars, immediate: true }, cb);
}

async function sendJudgeMessage(db, opts) {
    const { judge, participant, subject, message, submissionId } = opts;
    const bodyText = String(message || '').trim();
    if (!bodyText) return { ok: false, error: 'Message body is required.' };

    const threadSubject = await new Promise((resolve, reject) => {
        firstThreadSubject(db, submissionId, (e, s) => (e ? reject(e) : resolve(s)));
    });
    const subj =
        String(subject || '').trim() ||
        (threadSubject ? `Re: ${threadSubject}` : `Case application ${participant.application_no || submissionId}`);

    const msgId = await new Promise((resolve, reject) => {
        insertMessage(
            db,
            {
                submission_id: submissionId,
                judge_user_id: judge.id,
                direction: 'judge',
                author_user_id: judge.id,
                subject: threadSubject ? null : subj,
                body: bodyText,
                source: opts.viaEmail ? 'email' : 'portal'
            },
            (e, id) => (e ? reject(e) : resolve(id))
        );
    });

    let emailResult = { ok: false, skipped: true };
    if (!opts.viaEmail) {
        emailResult = await notifyParticipantByEmail(judge, participant, subj, bodyText, submissionId);
        logCommunication(db, {
            judge_user_id: judge.id,
            submission_id: submissionId,
            participant_user_id: null,
            subject: subj,
            body_preview: bodyText,
            to_address: participant.email,
            from_display: formatJudgeFromDisplay(judge)
        }, emailResult.ok ? 'sent' : emailResult.error || 'skipped', emailResult.error);
    }

    if (!opts.viaEmail) {
        db.get(`SELECT user_id FROM case_submissions WHERE id = ?`, [submissionId], (eU, subRow) => {
            if (!eU && subRow && subRow.user_id) {
                notifyCaseMessageViaEngine(db, subRow.user_id, 'CASE_MESSAGE_FROM_JUDGE', {
                    application_no: participant.application_no || String(submissionId),
                    case_topic: participant.topic || '',
                    judge_name: formatJudgeShortName(judge),
                    case_message: bodyText,
                    portal_login_url: publicDoctorPortalUrl()
                }, () => {});
                threadReplyNotify.notifyUserResponse(db, {
                    userId: subRow.user_id,
                    threadLabel: 'Case ' + (participant.application_no || submissionId),
                    messagePreview: bodyText,
                    portalPath: 'doctor_case'
                }, () => {});
            }
        });
    }

    return {
        ok: true,
        messageId: msgId,
        subject: subj,
        emailSent: !!(emailResult && emailResult.ok),
        fromDisplay: formatJudgeFromDisplay(judge)
    };
}

async function sendParticipantReply(db, opts) {
    const { participantUser, judge, participant, submissionId, message, judgeUserId } = opts;
    const bodyText = String(message || '').trim();
    if (!bodyText) return { ok: false, error: 'Message is required.' };

    const threadSubject = await new Promise((resolve, reject) => {
        firstThreadSubject(db, submissionId, (e, s) => (e ? reject(e) : resolve(s)));
    });
    const subj = threadSubject ? `Re: ${threadSubject}` : `Reply: ${participant.application_no}`;

    const msgId = await new Promise((resolve, reject) => {
        insertMessage(
            db,
            {
                submission_id: submissionId,
                judge_user_id: judgeUserId,
                direction: 'participant',
                author_user_id: participantUser.id,
                subject: null,
                body: bodyText,
                source: opts.viaEmail ? 'email' : 'portal'
            },
            (e, id) => (e ? reject(e) : resolve(id))
        );
    });

    if (!opts.viaEmail) {
        const emailResult = await notifyJudgeByEmail(
            judge,
            participant,
            subj,
            bodyText,
            participant.application_no,
            submissionId
        );
        logCommunication(db, {
            judge_user_id: judgeUserId,
            submission_id: submissionId,
            participant_user_id: participantUser.id,
            subject: subj,
            body_preview: bodyText,
            to_address: judge.email,
            from_display: participant.fullName
        }, emailResult.ok ? 'sent' : emailResult.error || 'skipped', emailResult.error);
    }
    notifyCaseMessageViaEngine(db, judge.id, 'CASE_MESSAGE_FROM_PARTICIPANT', {
        application_no: participant.application_no || String(submissionId),
        case_topic: participant.topic || '',
        participant_name: participant.fullName || 'Participant',
        judge_name: formatJudgeShortName(judge),
        case_message: bodyText,
        portal_login_url:
            (integrationSettings.getRuntimeIntegrations().judge_host || '').trim() ||
            publicDoctorPortalUrl().replace('doctor.html', 'judge.html')
    }, () => {});
    threadReplyNotify.notifyUserResponse(db, {
        userId: judge.id,
        threadLabel: 'Case ' + (participant.application_no || submissionId),
        messagePreview: bodyText,
        portalPath: 'judge'
    }, () => {});

    return { ok: true, messageId: msgId };
}

/** @deprecated use sendJudgeMessage */
async function sendJudgeToParticipantEmail(db, opts) {
    return sendJudgeMessage(db, opts);
}

function listCommunications(db, opts, cb) {
    const limit = Math.min(200, Math.max(1, parseInt(opts.limit, 10) || 50));
    const offset = Math.max(0, parseInt(opts.offset, 10) || 0);
    withMessageSchema(db, (schemaErr) => {
        if (schemaErr) return cb(schemaErr);
        db.all(
            `SELECT jcl.*, u.first_name AS judge_first, u.last_name AS judge_last
         FROM ${LOG_TABLE} jcl
         LEFT JOIN users u ON u.id = jcl.judge_user_id
         ORDER BY jcl.created_at DESC LIMIT ? OFFSET ?`,
            [limit, offset],
            (err, rows) => {
                if (err) return cb(err);
                cb(null, rows || []);
            }
        );
    });
}

module.exports = {
    LOG_TABLE,
    MSG_TABLE,
    ensureSchema,
    withMessageSchema,
    formatJudgeFromDisplay,
    formatJudgeShortName,
    parseParticipantFromSubmission,
    listSubmissionMessages,
    sendJudgeMessage,
    sendParticipantReply,
    sendJudgeToParticipantEmail,
    listCommunications
};
