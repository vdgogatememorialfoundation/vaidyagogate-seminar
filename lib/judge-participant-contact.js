/**
 * Judge → participant email (org From: "Judge Name | VGMF") with admin audit log.
 */
const emailSvc = require('./email-service');
const integrationSettings = require('./integration-settings');

const LOG_TABLE = 'judge_communication_log';

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
                `CREATE INDEX IF NOT EXISTS idx_judge_comm_judge ON ${LOG_TABLE} (judge_user_id, created_at DESC)`,
                [],
                () => cb && cb()
            );
        }
    );
}

function formatJudgeFromDisplay(judge) {
    const name = [judge.first_name, judge.last_name].filter(Boolean).join(' ').trim() || 'Judge';
    return `${name} | Vaidya Gogate Memorial Foundation`;
}

function orgFromEmail() {
    const cfg = integrationSettings.getMailConfig();
    return (cfg && cfg.from) || process.env.ZOHO_FROM || process.env.ADMIN_CONTACT_EMAIL || '';
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
        user_id_string: userRow.user_id_string || '',
        topic: sub.title || fd.topic || '',
        application_no: sub.application_no || String(sub.id)
    };
}

function insertLog(db, row, cb) {
    db.run(
        `INSERT INTO ${LOG_TABLE}
         (judge_user_id, submission_id, registration_id, participant_user_id, channel, subject, body_preview, to_address, from_display, status, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            row.judge_user_id,
            row.submission_id || null,
            row.registration_id || null,
            row.participant_user_id || null,
            row.channel || 'email',
            row.subject || '',
            (row.body_preview || '').slice(0, 500),
            row.to_address || '',
            row.from_display || '',
            row.status || 'sent',
            row.error_message || null
        ],
        function (err) {
            cb(err, this.lastID);
        }
    );
}

async function sendJudgeToParticipantEmail(db, opts) {
    const { judge, participant, subject, message, submissionId, registrationId } = opts;
    const to = participant.email;
    if (!to) {
        return { ok: false, error: 'Participant has no email on file.' };
    }
    const fromEmail = orgFromEmail();
    if (!fromEmail) {
        return { ok: false, error: 'Organisation email (SMTP From) is not configured.' };
    }
    const display = formatJudgeFromDisplay(judge);
    const subj = String(subject || '').trim() || `Message from ${display}`;
    const bodyText = String(message || '').trim();
    if (!bodyText) return { ok: false, error: 'Message body is required.' };

    const html =
        '<div style="font-family:Arial,sans-serif;max-width:560px;line-height:1.6;color:#1e293b;">' +
        '<p style="color:#64748b;font-size:13px;">This message is sent via the VGMF judge portal on behalf of <strong>' +
        display.replace(/</g, '&lt;') +
        '</strong>.</p>' +
        '<div style="padding:16px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">' +
        bodyText.replace(/\n/g, '<br>') +
        '</div>' +
        '<p style="font-size:12px;color:#64748b;margin-top:16px;">Application: ' +
        (participant.application_no || '—') +
        (participant.topic ? '<br>Topic: ' + participant.topic : '') +
        '</p></div>';

    const judgeEmail = (judge.email || '').trim();
    const monitor = (
        integrationSettings.getRuntimeIntegrations().admin_contact_email ||
        process.env.ADMIN_CONTACT_EMAIL ||
        ''
    ).trim();

    const result = await emailSvc.sendEmail(to, subj, html, {
        text: bodyText,
        fromDisplay: display,
        fromEmail,
        replyTo: judgeEmail || fromEmail,
        cc: monitor && monitor !== to ? monitor : undefined
    });

    const logRow = {
        judge_user_id: judge.id,
        submission_id: submissionId,
        registration_id: registrationId,
        participant_user_id: participant.userId,
        channel: 'email',
        subject: subj,
        body_preview: bodyText,
        to_address: to,
        from_display: display,
        status: result.ok ? 'sent' : 'failed',
        error_message: result.error || null
    };
    await new Promise((resolve) => insertLog(db, logRow, () => resolve()));

    return result;
}

function listCommunications(db, opts, cb) {
    const limit = Math.min(200, Math.max(1, parseInt(opts.limit, 10) || 50));
    const offset = Math.max(0, parseInt(opts.offset, 10) || 0);
    let sql = `SELECT jcl.*, u.first_name AS judge_first, u.last_name AS judge_last, u.user_id_string AS judge_uid
               FROM ${LOG_TABLE} jcl
               LEFT JOIN users u ON u.id = jcl.judge_user_id
               ORDER BY jcl.created_at DESC LIMIT ? OFFSET ?`;
    db.all(sql, [limit, offset], (err, rows) => {
        if (err) return cb(err);
        cb(null, rows || []);
    });
}

module.exports = {
    LOG_TABLE,
    ensureSchema,
    formatJudgeFromDisplay,
    parseParticipantFromSubmission,
    sendJudgeToParticipantEmail,
    listCommunications
};
