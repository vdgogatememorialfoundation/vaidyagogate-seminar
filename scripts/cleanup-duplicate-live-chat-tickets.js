/**
 * One-off: delete duplicate live-chat auto-escalation tickets (keeps earliest per subject).
 * Usage: node scripts/cleanup-duplicate-live-chat-tickets.js
 */
const path = require('path');

async function main() {
    const { resolveDatabaseUrl } = require('../lib/env-db');
    const url = resolveDatabaseUrl();
    let db;
    if (url) {
        process.env.DATABASE_URL = url;
        db = require('../lib/db-pg').createPgDb();
        await new Promise((r, j) => db.connect((e) => (e ? j(e) : r())));
        console.log('[db] PostgreSQL');
    } else {
        const sqlite3 = require('sqlite3').verbose();
        const dbFile = process.env.SQLITE_PATH || path.join(__dirname, '..', 'database.sqlite');
        db = new sqlite3.Database(dbFile);
        console.log('[db] SQLite', dbFile);
    }

    const {
        cleanupDuplicateLiveChatTickets,
        KNOWN_LCHAT_10_DUPLICATES
    } = require('../lib/cleanup-duplicate-live-chat-tickets');
    const deleteAll = process.argv.includes('--all');
    const useKnown = process.argv.includes('--lchat-10');
    const result = useKnown
        ? await cleanupDuplicateLiveChatTickets(db, { ticketIds: KNOWN_LCHAT_10_DUPLICATES })
        : await cleanupDuplicateLiveChatTickets(db, { deleteAll });
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
