/**
 * Remove auto-escalation live-chat support tickets (duplicate cleanup or full purge).
 */
const LIVE_CHAT_SUBJECT_SQL = `(
    subject LIKE 'Live chat follow-up – no agent reply (LCHAT-%'
    OR subject LIKE 'Live chat follow-up - no agent reply (LCHAT-%'
)`;

const KNOWN_LCHAT_10_DUPLICATES = [
    'TKT_827704921237',
    'TKT_178867575698',
    'TKT_727234639681',
    'TKT_796085835564',
    'TKT_548358708561',
    'TKT_471776156559',
    'TKT_873576744580',
    'TKT_233047098075',
    'TKT_119689979204',
    'TKT_309216957787',
    'TKT_885597355142',
    'TKT_526589007911',
    'TKT_756937146017',
    'TKT_980846078804',
    'TKT_745249044633',
    'TKT_679245958080',
    'TKT_367602530489',
    'TKT_764008798076'
];

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

async function deleteSupportTicketsByPublicIds(db, ticketIds, opts = {}) {
    const q = promisifyDb(db);
    const ids = (ticketIds || []).map((id) => String(id || '').trim()).filter(Boolean);
    if (!ids.length) {
        return { scanned: 0, deleted: 0, deletedIds: [], keptIds: [] };
    }

    const ph = ids.map(() => '?').join(',');
    const rows = await q.all(
        `SELECT id, ticket_id, subject, created_at FROM support_tickets WHERE ticket_id IN (${ph})`,
        ids
    );
    const foundIds = rows.map((r) => r.ticket_id).filter(Boolean);
    if (!foundIds.length) {
        return { scanned: ids.length, deleted: 0, deletedIds: [], keptIds: [], notFound: ids };
    }

    for (const tid of foundIds) {
        await q.run(`UPDATE support_live_sessions SET linked_ticket_id = NULL WHERE linked_ticket_id = ?`, [tid]);
    }

    const ph2 = foundIds.map(() => '?').join(',');
    await q.run(`DELETE FROM ticket_messages WHERE ticket_id IN (${ph2})`, foundIds);
    await q.run(`DELETE FROM support_tickets WHERE ticket_id IN (${ph2})`, foundIds);

    return {
        scanned: ids.length,
        deleted: foundIds.length,
        deletedIds: foundIds,
        keptIds: [],
        mode: opts.mode || 'by_ids'
    };
}

async function cleanupDuplicateLiveChatTickets(db, opts = {}) {
    const q = promisifyDb(db);
    const deleteAll = !!(opts && opts.deleteAll);

    if (opts && Array.isArray(opts.ticketIds) && opts.ticketIds.length) {
        return deleteSupportTicketsByPublicIds(db, opts.ticketIds, { mode: 'by_ids' });
    }

    const rows = await q.all(
        `SELECT id, ticket_id, subject, created_at
         FROM support_tickets
         WHERE ${LIVE_CHAT_SUBJECT_SQL}
         ORDER BY subject ASC, created_at ASC, id ASC`,
        []
    );

    if (!rows.length) {
        return { scanned: 0, groups: 0, kept: 0, deleted: 0, deletedIds: [], keptIds: [], mode: deleteAll ? 'delete_all' : 'dedupe' };
    }

    let toDelete;
    let kept;

    if (deleteAll) {
        toDelete = rows;
        kept = [];
    } else {
        const bySubject = new Map();
        for (const row of rows) {
            const key = String(row.subject || '').trim();
            if (!bySubject.has(key)) bySubject.set(key, []);
            bySubject.get(key).push(row);
        }
        kept = [];
        toDelete = [];
        for (const list of bySubject.values()) {
            if (!list.length) continue;
            kept.push(list[0]);
            if (list.length > 1) toDelete.push(...list.slice(1));
        }
        if (!toDelete.length) {
            return {
                scanned: rows.length,
                groups: bySubject.size,
                kept: kept.length,
                deleted: 0,
                deletedIds: [],
                keptIds: kept.map((r) => r.ticket_id),
                mode: 'dedupe'
            };
        }
    }

    const deleteIds = toDelete.map((r) => r.ticket_id).filter(Boolean);

    if (!deleteAll) {
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
    } else {
        for (const tid of deleteIds) {
            await q.run(`UPDATE support_live_sessions SET linked_ticket_id = NULL WHERE linked_ticket_id = ?`, [tid]);
        }
    }

    const ph = deleteIds.map(() => '?').join(',');
    await q.run(`DELETE FROM ticket_messages WHERE ticket_id IN (${ph})`, deleteIds);
    await q.run(`DELETE FROM support_tickets WHERE ticket_id IN (${ph})`, deleteIds);

    return {
        scanned: rows.length,
        groups: deleteAll ? 1 : undefined,
        kept: kept.length,
        deleted: deleteIds.length,
        deletedIds: deleteIds,
        keptIds: kept.map((r) => r.ticket_id),
        mode: deleteAll ? 'delete_all' : 'dedupe'
    };
}

function cleanupDuplicateLiveChatTicketsCb(db, opts, cb) {
    if (typeof opts === 'function') {
        cb = opts;
        opts = {};
    }
    cleanupDuplicateLiveChatTickets(db, opts || {})
        .then((result) => cb(null, result))
        .catch((err) => cb(err));
}

module.exports = {
    LIVE_CHAT_SUBJECT_SQL,
    KNOWN_LCHAT_10_DUPLICATES,
    deleteSupportTicketsByPublicIds,
    cleanupDuplicateLiveChatTickets,
    cleanupDuplicateLiveChatTicketsCb
};
