/**
 * Book stock inventory (per book + language).
 */
function ensureInventorySchema(db, isPg, colAlters, ignore, cb) {
    const sql = isPg
        ? `CREATE TABLE IF NOT EXISTS book_inventory (
            id SERIAL PRIMARY KEY,
            book_id TEXT NOT NULL,
            language TEXT NOT NULL,
            qty_on_hand INTEGER NOT NULL DEFAULT 0,
            qty_reserved INTEGER NOT NULL DEFAULT 0,
            low_stock_threshold INTEGER NOT NULL DEFAULT 5,
            updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(book_id, language)
        )`
        : `CREATE TABLE IF NOT EXISTS book_inventory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book_id TEXT NOT NULL,
            language TEXT NOT NULL,
            qty_on_hand INTEGER NOT NULL DEFAULT 0,
            qty_reserved INTEGER NOT NULL DEFAULT 0,
            low_stock_threshold INTEGER NOT NULL DEFAULT 5,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(book_id, language)
        )`;
    db.run(sql, (e) => {
        ignore(e);
        cb();
    });
}

function lineStatusColAlters(isPg) {
    return isPg
        ? [
              'ALTER TABLE book_order_items ADD COLUMN IF NOT EXISTS line_status TEXT DEFAULT \'active\'',
              'ALTER TABLE book_order_items ADD COLUMN IF NOT EXISTS cancel_reason TEXT',
              'ALTER TABLE book_order_items ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ',
              'ALTER TABLE book_order_items ADD COLUMN IF NOT EXISTS cancelled_by INTEGER'
          ]
        : [
              'ALTER TABLE book_order_items ADD COLUMN line_status TEXT DEFAULT \'active\'',
              'ALTER TABLE book_order_items ADD COLUMN cancel_reason TEXT',
              'ALTER TABLE book_order_items ADD COLUMN cancelled_at TEXT',
              'ALTER TABLE book_order_items ADD COLUMN cancelled_by INTEGER'
          ];
}

function staffModulesColAlters(isPg) {
    return isPg
        ? ['ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_modules TEXT']
        : ['ALTER TABLE users ADD COLUMN staff_modules TEXT'];
}

function loadInventory(db, cb) {
    db.all(`SELECT book_id, language, qty_on_hand, qty_reserved, low_stock_threshold, updated_at FROM book_inventory ORDER BY book_id, language`, [], (err, rows) => {
        if (err) return cb(err);
        cb(null, rows || []);
    });
}

function getAvailableQty(row) {
    if (!row) return null;
    return Math.max(0, (Number(row.qty_on_hand) || 0) - (Number(row.qty_reserved) || 0));
}

function checkLinesStock(db, lines, cb) {
    if (!lines || !lines.length) return cb(null, { ok: true });
    let left = lines.length;
    const shortages = [];
    lines.forEach((line) => {
        db.get(
            `SELECT qty_on_hand, qty_reserved FROM book_inventory WHERE book_id = ? AND language = ?`,
            [line.bookId, line.language],
            (err, row) => {
                if (err) shortages.push({ bookId: line.bookId, language: line.language, error: err.message });
                else if (row) {
                    const avail = getAvailableQty(row);
                    if (avail < line.qty) {
                        shortages.push({
                            bookId: line.bookId,
                            language: line.language,
                            requested: line.qty,
                            available: avail
                        });
                    }
                }
                left--;
                if (!left) {
                    if (shortages.length) return cb(null, { ok: false, shortages });
                    cb(null, { ok: true });
                }
            }
        );
    });
}

function upsertInventoryRow(db, bookId, language, patch, cb) {
    const qty = Math.max(0, parseInt(patch.qty_on_hand, 10) || 0);
    const threshold = Math.max(0, parseInt(patch.low_stock_threshold, 10) || 5);
    db.get(`SELECT id FROM book_inventory WHERE book_id = ? AND language = ?`, [bookId, language], (err, row) => {
        if (err) return cb(err);
        if (row) {
            return db.run(
                `UPDATE book_inventory SET qty_on_hand = ?, low_stock_threshold = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [qty, threshold, row.id],
                cb
            );
        }
        db.run(
            `INSERT INTO book_inventory (book_id, language, qty_on_hand, low_stock_threshold, updated_at)
             VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [bookId, language, qty, threshold],
            cb
        );
    });
}

function adjustStock(db, bookId, language, deltaOnHand, cb) {
    db.get(`SELECT id, qty_on_hand FROM book_inventory WHERE book_id = ? AND language = ?`, [bookId, language], (err, row) => {
        if (err) return cb(err);
        if (!row) return cb(null);
        const next = Math.max(0, (Number(row.qty_on_hand) || 0) + deltaOnHand);
        db.run(`UPDATE book_inventory SET qty_on_hand = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [next, row.id], cb);
    });
}

function reserveStockForOrder(db, bookOrderId, cb) {
    db.all(
        `SELECT book_id, language, qty FROM book_order_items WHERE book_order_id = ? AND COALESCE(line_status,'active') = 'active'`,
        [bookOrderId],
        (err, rows) => {
            if (err) return cb(err);
            const lines = rows || [];
            if (!lines.length) return cb(null);
            let left = lines.length;
            lines.forEach((line) => {
                db.get(
                    `SELECT id, qty_on_hand FROM book_inventory WHERE book_id = ? AND language = ?`,
                    [line.book_id, line.language],
                    (e2, inv) => {
                        if (inv) {
                            const next = Math.max(0, (Number(inv.qty_on_hand) || 0) - (Number(line.qty) || 0));
                            db.run(
                                `UPDATE book_inventory SET qty_on_hand = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                                [next, inv.id],
                                () => {}
                            );
                        }
                        left--;
                        if (!left) cb(null);
                    }
                );
            });
        }
    );
}

function releaseStockForLine(db, bookId, language, qty, cb) {
    adjustStock(db, bookId, language, qty, cb);
}

module.exports = {
    ensureInventorySchema,
    lineStatusColAlters,
    staffModulesColAlters,
    loadInventory,
    getAvailableQty,
    checkLinesStock,
    upsertInventoryRow,
    adjustStock,
    reserveStockForOrder,
    releaseStockForLine
};
