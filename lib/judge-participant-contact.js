/**
 * Judge ↔ participant messaging (in-portal thread + email notify).
 */
const emailSvc = require('./email-service');
const integrationSettings = require('./integration-settings');

const LOG_TABLE = 'judge_communication_log';
const MSG_TABLE = 'case_participant_messages';

function ensureSchema(db, cb) {
    db.run(
        `CREATE TABLE IF NOT EXISTS ${LOG_TABLE} (
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
        )`,
        [],
        () => {
            db.run(
                `CREATE TABLE IF NOT EXISTS ${MSG_TABLE} (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    submission_id INTEGER NOT NULL,
                    judge_user_id INTEGER NOT NULL,
                    direction TEXT NOT NULL,
                    author_user_id INTEGER NOT NULL,
                    subject TEXT,
                    body TEXT NOT NULL,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP
                )`,
                [],
                () => {
                    db.run(
                        `CREATE INDEX IF NOT EXISTS idx_case_msg_sub ON ${MSG_TABLE} (submission_id, created_at ASC)`,
                        [],
                        () => cb && cb()
                    );
                }
            );
        }
    );
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
                createdAt: r.created_at,
                judgeName: [r.judge_first, r.judge_last].filter(Boolean).join(' ').trim() || 'Judge',
                authorName: [r.author_first, r.author_last].filter(Boolean).join(' ').trim() || ''
            }));
            cb(null, mapped);
        }
    );
}

function firstThreadSubject(db, submissionId, cb) {
    db.get(
        `SELECT subject FROM ${MSG_TABLE} WHERE submission_id = ? AND subject IS NOT NULL AND TRIM(subject) != '' ORDER BY id ASC LIMIT 1`,
        [submissionId],
        (err, row) => {
            if (err) return cb(err);
            cb(null, (row && row.subject) || null);
        }
    );
}

function insertMessage(db, row, cb) {
    db.run(
        `INSERT INTO ${MSG_TABLE} (submission_id, judge_user_id, direction, author_user_id, subject, body)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
            row.submission_id,
            row.judge_user_id,
            row.direction,
            row.author_user_id,
            row.subject || null,
            row.body
        ],
        function (err) {
            cb(err, this.lastID);
        }
    );
}

function notifyParticipantByEmail(judge, participant, subject, bodyText, submissionId) {
    const to = participant.email;
    if (!to) return Promise.resolve({ ok: false, skipped: true });
    const fromEmail = orgFromEmail();
    if (!fromEmail) return Promise.resolve({ ok: false, error: 'Email not configured' });
    const display = formatJudgeFromDisplay(judge);
    const portal = publicDoctorPortalUrl();
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
    return emailSvc.sendEmail(to, subject, html, {
        text: bodyText + '\n\nReply in the Doctor portal: ' + portal,
        fromDisplay: display,
        fromEmail
    });
}

function notifyJudgeByEmail(judge, participant, subject, bodyText, applicationNo) {
    const to = (judge.email || '').trim();
    if (!to) return Promise.resolve({ ok: false, skipped: true });
    const fromEmail = orgFromEmail();
    if (!fromEmail) return Promise.resolve({ ok: false, error: 'Email not configured' });
    const display = 'Vaidya Gogate Memorial Foundation';
    const portal =
        (integrationSettings.getRuntimeIntegrations().judge_host || process.env.JUDGE_HOST || '').trim() ||
        publicDoctorPortalUrl().replace('doctor.html', 'judge.html');
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
    return emailSvc.sendEmail(to, subject, html, {
        text: bodyText,
        fromDisplay: display,
        fromEmail
    });
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
                body: bodyText
            },
            (e, id) => (e ? reject(e) : resolve(id))
        );
    });

    const emailResult = await notifyParticipantByEmail(judge, participant, subj, bodyText, submissionId);

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
                body: bodyText
            },
            (e, id) => (e ? reject(e) : resolve(id))
        );
    });

    await notifyJudgeByEmail(judge, participant, subj, bodyText, participant.application_no);

    return { ok: true, messageId: msgId };
}

/** @deprecated use sendJudgeMessage */
async function sendJudgeToParticipantEmail(db, opts) {
    return sendJudgeMessage(db, opts);
}

function listCommunications(db, opts, cb) {
    const limit = Math.min(200, Math.max(1, parseInt(opts.limit, 10) || 50));
    const offset = Math.max(0, parseInt(opts.offset, 10) || 0);
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
}

module.exports = {
    LOG_TABLE,
    MSG_TABLE,
    ensureSchema,
    formatJudgeFromDisplay,
    formatJudgeShortName,
    parseParticipantFromSubmission,
    listSubmissionMessages,
    sendJudgeMessage,
    sendParticipantReply,
    sendJudgeToParticipantEmail,
    listCommunications
};
