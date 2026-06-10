/**
 * Remove duplicate auto-escalation support tickets (same live-chat subject).
 * Keeps the earliest ticket per subject; deletes the rest and their messages.
 */
const LIVE_CHAT_SUBJECT_SQL = `(
    subject LIKE 'Live chat follow-up – no agent reply (LCHAT-%'
    OR subject LIKE 'Live chat follow-up - no agent reply (LCHAT-%'
)`;

function promisifyDb(db) {
    return {
        all: (sql, params) =>
            new Promise((resolve, reject) => {
                db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
            }),
        run: (sql, params) =>
            new Promise((resolve, reject) => {
                db.run(sql, params, function (err) {
                    if (err) reject(err);
                    else resolve({ changes: this.changes, lastID: this.lastID });
                });
            })
    };
}

async function cleanupDuplicateLiveChatTickets(db) {
    const q = promisifyDb(db);
    const rows = await q.all(
        `SELECT id, ticket_id, subject, created_at
         FROM support_tickets
         WHERE ${LIVE_CHAT_SUBJECT_SQL}
         ORDER BY subject ASC, created_at ASC, id ASC`,
        []
    );

    const bySubject = new Map();
    for (const row of rows) {
        const key = String(row.subject || '').trim();
        if (!bySubject.has(key)) bySubject.set(key, []);
        bySubject.get(key).push(row);
    }

    const kept = [];
    const toDelete = [];
    for (const list of bySubject.values()) {
        if (!list.length) continue;
        kept.push(list[0]);
        if (list.length > 1) toDelete.push(...list.slice(1));
    }

    if (!toDelete.length) {
        return { scanned: rows.length, groups: bySubject.size, kept: kept.length, deleted: 0, deletedIds: [] };
    }

    const deleteIds = toDelete.map((r) => r.ticket_id).filter(Boolean);
    const keptBySubject = new Map(kept.map((r) => [String(r.subject || '').trim(), r.ticket_id]));

    for (const dup of toDelete) {
        const subject = String(dup.subject || '').trim();
        const survivor = keptBySubject.get(subject);
        if (survivor && dup.ticket_id) {
            await q.run(
                `UPDATE support_live_sessions SET linked_ticket_id = ?
                 WHERE linked_ticket_id = ?`,
                [survivor, dup.ticket_id]
            );
        }
    }

    const ph = deleteIds.map(() => '?').join(',');
    await q.run(`DELETE FROM ticket_messages WHERE ticket_id IN (${ph})`, deleteIds);
    await q.run(`DELETE FROM support_tickets WHERE ticket_id IN (${ph})`, deleteIds);

    return {
        scanned: rows.length,
        groups: bySubject.size,
        kept: kept.length,
        deleted: deleteIds.length,
        deletedIds: deleteIds,
        keptIds: kept.map((r) => r.ticket_id)
    };
}

function cleanupDuplicateLiveChatTicketsCb(db, cb) {
    cleanupDuplicateLiveChatTickets(db)
        .then((result) => cb(null, result))
        .catch((err) => cb(err));
}

module.exports = {
    LIVE_CHAT_SUBJECT_SQL,
    cleanupDuplicateLiveChatTickets,
    cleanupDuplicateLiveChatTicketsCb
};
