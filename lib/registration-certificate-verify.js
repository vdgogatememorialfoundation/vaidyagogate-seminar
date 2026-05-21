/**
 * NCISM / registration certificate check: extract text from PDF, find registration IDs, compare to entered value.
 */
const path = require('path');

const REG_PATTERNS = [
    /\b(MCIM\s*\/\s*[A-Z0-9]{3,12})\b/gi,
    /\b(NCISM\s*\/\s*[A-Z0-9]{3,12})\b/gi,
    /\b([A-Z]{2,8}\s*\/\s*\d{4,10})\b/g,
    /\b([A-Z]{2,8}[-\s]?\d{4,10})\b/g
];

function normalizeRegId(s) {
    return String(s || '')
        .toUpperCase()
        .replace(/[\s\-_./]/g, '');
}

function levenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    if (!m) return n;
    if (!n) return m;
    const dp = Array(n + 1)
        .fill(0)
        .map((_, j) => j);
    for (let i = 1; i <= m; i++) {
        let prev = dp[0];
        dp[0] = i;
        for (let j = 1; j <= n; j++) {
            const tmp = dp[j];
            dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
            prev = tmp;
        }
    }
    return dp[n];
}

function fuzzyRegMatch(entered, candidate) {
    const a = normalizeRegId(entered);
    const b = normalizeRegId(candidate);
    if (!a || !b) return false;
    if (a === b) return true;
    if (b.includes(a) || a.includes(b)) return true;
    const maxLen = Math.max(a.length, b.length);
    if (maxLen < 5) return false;
    const dist = levenshtein(a, b);
    return dist <= Math.max(1, Math.floor(maxLen * 0.08));
}

function extractRegistrationNumbersFromText(text) {
    const found = new Set();
    const src = String(text || '');
    REG_PATTERNS.forEach((re) => {
        const flags = re.flags;
        const r = new RegExp(re.source, flags.includes('g') ? flags : flags + 'g');
        let m;
        while ((m = r.exec(src)) !== null) {
            const v = String(m[1] || m[0] || '').trim();
            if (v.length >= 5) found.add(v.replace(/\s+/g, ' '));
        }
    });
    return [...found];
}

async function extractTextFromBuffer(buffer, mime) {
    const mt = String(mime || '').toLowerCase();
    if (mt.includes('pdf') || buffer.slice(0, 4).toString() === '%PDF') {
        try {
            const pdfParse = require('pdf-parse');
            const data = await pdfParse(buffer);
            return { text: data.text || '', source: 'pdf' };
        } catch (e) {
            return { text: '', source: 'pdf_error', error: e.message };
        }
    }
    if (mt.startsWith('image/')) {
        return { text: '', source: 'image', error: 'Image OCR not enabled on server — admin manual review required.' };
    }
    return { text: '', source: 'unsupported', error: 'Unsupported file type for automatic text extraction.' };
}

function compareNcismToExtracted(entered, extractedList) {
    const enteredTrim = String(entered || '').trim();
    const extracted = extractedList || [];
    if (!enteredTrim) {
        return { status: 'no_entered', match: false, bestMatch: null };
    }
    if (!extracted.length) {
        return { status: 'no_text', match: false, bestMatch: null };
    }
    for (const cand of extracted) {
        if (fuzzyRegMatch(enteredTrim, cand)) {
            return { status: 'match', match: true, bestMatch: cand };
        }
    }
    return { status: 'mismatch', match: false, bestMatch: extracted[0] || null };
}

async function verifyCertificateBuffer(buffer, mime, enteredNcism) {
    const { text, source, error } = await extractTextFromBuffer(buffer, mime);
    const extracted = extractRegistrationNumbersFromText(text);
    const cmp = compareNcismToExtracted(enteredNcism, extracted);
    return {
        entered: String(enteredNcism || '').trim(),
        extracted,
        textSample: text ? text.slice(0, 400) : '',
        source,
        ocrError: error || null,
        status: cmp.status,
        match: cmp.match,
        bestMatch: cmp.bestMatch,
        needs_manual_review: !cmp.match || cmp.status === 'no_text' || cmp.status === 'mismatch',
        checked_at: new Date().toISOString()
    };
}

function readCertificateBuffer(db, fileStore, certificatePath, uploadsDir, cb) {
    let p = String(certificatePath || '').trim();
    if (!p) return cb(null, null, null);
    if (fileStore && typeof fileStore.publicFileUrl === 'function') {
        p = fileStore.publicFileUrl(p);
    } else if (p.startsWith('/uploads/api/assets/')) {
        p = '/api/assets/' + p.slice('/uploads/api/assets/'.length);
    }

    if (p.startsWith('/api/assets/')) {
        const key = decodeURIComponent(p.replace(/^\/api\/assets\//, ''));
        return db.get(
            `SELECT mime_type, data, original_name FROM file_blobs WHERE storage_key = ?`,
            [key],
            (e, row) => {
                if (e) return cb(e);
                if (row && row.data != null) {
                    let buf = row.data;
                    if (typeof buf === 'string') buf = Buffer.from(buf, 'base64');
                    if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
                    return cb(null, buf, row.mime_type || 'application/octet-stream');
                }
                db.get(`SELECT value FROM global_settings WHERE key = ?`, [key], (e2, gs) => {
                    if (e2) return cb(e2);
                    if (!gs || !gs.value) return cb(null, null, null);
                    try {
                        const payload = JSON.parse(gs.value);
                        const buf = Buffer.from(payload.data, 'base64');
                        cb(null, buf, payload.mime || 'application/octet-stream');
                    } catch (err) {
                        cb(err);
                    }
                });
            }
        );
    }

    if (p.startsWith('/uploads/')) {
        const name = path.basename(p);
        const fs = require('fs');
        const diskPath = path.join(uploadsDir, name);
        if (fs.existsSync(diskPath)) {
            return fs.readFile(diskPath, (err, buf) => {
                if (err) return cb(err);
                const ext = path.extname(name).toLowerCase();
                const mime =
                    ext === '.pdf'
                        ? 'application/pdf'
                        : ext === '.png'
                          ? 'image/png'
                          : ext === '.jpg' || ext === '.jpeg'
                            ? 'image/jpeg'
                            : 'application/octet-stream';
                cb(null, buf, mime);
            });
        }
        return db.get(`SELECT mime_type, data FROM file_blobs WHERE storage_key = ?`, [name], (e, row) => {
            if (e) return cb(e);
            if (!row || row.data == null) return cb(null, null, null);
            let buf = row.data;
            if (typeof buf === 'string') buf = Buffer.from(buf, 'base64');
            if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
            cb(null, buf, row.mime_type || 'application/octet-stream');
        });
    }

    cb(null, null, null);
}

function verifyCertificateForRegistration(db, fileStore, uploadsDir, formData, cb) {
    const entered = formData && formData.ncism;
    const certPath = formData && formData.certificate_path;
    if (!certPath || !entered) {
        return cb(null, {
            entered: String(entered || '').trim(),
            extracted: [],
            status: 'skipped',
            match: null,
            needs_manual_review: false,
            checked_at: new Date().toISOString()
        });
    }
    readCertificateBuffer(db, fileStore, certPath, uploadsDir, async (err, buffer, mime) => {
        if (err) return cb(err);
        if (!buffer || !buffer.length) {
            return cb(null, {
                entered: String(entered).trim(),
                extracted: [],
                status: 'no_file',
                match: false,
                needs_manual_review: true,
                checked_at: new Date().toISOString()
            });
        }
        try {
            const result = await verifyCertificateBuffer(buffer, mime, entered);
            cb(null, result);
        } catch (e) {
            cb(e);
        }
    });
}

module.exports = {
    normalizeRegId,
    fuzzyRegMatch,
    extractRegistrationNumbersFromText,
    verifyCertificateBuffer,
    verifyCertificateForRegistration,
    readCertificateBuffer
};
