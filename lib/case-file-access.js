/**
 * Resolve case file URLs for judges/doctors (signed R2 or local paths).
 */
const r2Storage = require('./r2-storage');
const caseFileTypes = require('./case-file-types');

function storageKeyFromRow(fileRow) {
    if (!fileRow) return null;
    if (fileRow.storage_key) return String(fileRow.storage_key);
    return r2Storage.parseR2FilePath(fileRow.file_path);
}

async function enrichCaseFileRow(fileRow, opts) {
    const options = opts || {};
    const row = { ...fileRow };
    const key = storageKeyFromRow(row);
    row.preview_kind = caseFileTypes.previewKind(row.original_name, row.mime_type);
    if (key && (await r2Storage.isR2Ready())) {
        try {
            const view = await r2Storage.presignGet(key, {
                mimeType: row.mime_type,
                filename: row.original_name,
                download: false,
                expiresSec: options.expiresSec
            });
            const dl = await r2Storage.presignGet(key, {
                mimeType: row.mime_type,
                filename: row.original_name,
                download: true,
                expiresSec: options.expiresSec
            });
            row.view_url = view.url;
            row.download_url = dl.url;
            row.url_expires_at = view.expiresAt;
            row.file_path = row.view_url;
        } catch (e) {
            row.access_error = e.message || 'Could not sign file URL';
        }
    } else if (row.file_path && !String(row.file_path).startsWith('http')) {
        row.view_url = row.file_path;
        row.download_url = row.file_path;
    }
    return row;
}

async function enrichCaseFiles(files, opts) {
    const list = files || [];
    const out = [];
    for (const f of list) {
        out.push(await enrichCaseFileRow(f, opts));
    }
    return out;
}

module.exports = {
    storageKeyFromRow,
    enrichCaseFileRow,
    enrichCaseFiles
};
