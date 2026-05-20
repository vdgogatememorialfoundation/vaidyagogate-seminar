/**
 * Safe uploads for Vercel (~4.5 MB request limit): compress images client-side,
 * one file per request, clear guidance for large PDFs/PPTs.
 */
(function (global) {
    const SERVER_HARD_MAX = 4 * 1024 * 1024;
    const SERVER_SAFE_MAX = Math.floor(3.5 * 1024 * 1024);
    const MAX_RAW_BEFORE_COMPRESS = 25 * 1024 * 1024;

    function formatBytes(n) {
        const b = Number(n) || 0;
        if (b < 1024) return b + ' B';
        if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
        return (b / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function isImageFile(file) {
        if (!file) return false;
        if (String(file.type || '').startsWith('image/')) return true;
        return /\.(jpe?g|png|webp|heif|heic)$/i.test(file.name || '');
    }

    function isPdfFile(file) {
        if (!file) return false;
        return file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
    }

    function compressHelpMessage(file) {
        const name = (file && file.name) || 'file';
        const size = formatBytes(file && file.size);
        return (
            `"${name}" (${size}) is too large for direct upload on this server (max about 4 MB per file).\n\n` +
            'What to do:\n' +
            '• Photos: use a smaller/export version, or take a screenshot saved as JPG.\n' +
            '• PDF: compress at https://www.ilovepdf.com/compress_pdf (free) then upload again.\n' +
            '• PowerPoint: export to PDF, compress PDF, or use “Save a Copy” with smaller images.\n' +
            '• iPhone: Settings → Camera → Formats → Most Compatible (JPEG), or send via WhatsApp to yourself and download the compressed copy.'
        );
    }

    async function compressImageFile(file, opts) {
        const options = opts || {};
        const maxDim = options.maxDim || 1920;
        const quality = options.quality != null ? options.quality : 0.82;
        if (!file || !isImageFile(file)) return file;
        if (file.size < 700 * 1024 && !/heic|heif/i.test(file.name || '')) return file;

        return new Promise((resolve) => {
            const img = new Image();
            const url = URL.createObjectURL(file);
            img.onload = () => {
                URL.revokeObjectURL(url);
                let w = img.width;
                let h = img.height;
                if (w > maxDim || h > maxDim) {
                    if (w >= h) {
                        h = Math.round((h * maxDim) / w);
                        w = maxDim;
                    } else {
                        w = Math.round((w * maxDim) / h);
                        h = maxDim;
                    }
                }
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                if (!ctx) return resolve(file);
                ctx.drawImage(img, 0, 0, w, h);
                canvas.toBlob(
                    (blob) => {
                        if (!blob) return resolve(file);
                        const base = String(file.name || 'image').replace(/\.[^.]+$/i, '') || 'image';
                        resolve(
                            new File([blob], base + '.jpg', {
                                type: 'image/jpeg',
                                lastModified: Date.now()
                            })
                        );
                    },
                    'image/jpeg',
                    quality
                );
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                resolve(file);
            };
            img.src = url;
        });
    }

    async function prepareFileForUpload(file) {
        if (!file) {
            return { ok: false, error: 'No file selected.' };
        }
        if (file.size > MAX_RAW_BEFORE_COMPRESS) {
            return { ok: false, error: compressHelpMessage(file) };
        }
        if (isImageFile(file)) {
            const compressed = await compressImageFile(file);
            if (compressed.size > SERVER_HARD_MAX) {
                return { ok: false, error: compressHelpMessage(file) };
            }
            return {
                ok: true,
                file: compressed,
                compressed: compressed !== file,
                note:
                    compressed !== file
                        ? 'Photo was resized/compressed for upload (' + formatBytes(compressed.size) + ').'
                        : ''
            };
        }
        if (file.size > SERVER_HARD_MAX) {
            return { ok: false, error: compressHelpMessage(file) };
        }
        return { ok: true, file, compressed: false, note: '' };
    }

    function uploadErrorText(status, data, fileName) {
        if (status === 413) {
            return (
                (fileName ? `"${fileName}" ` : 'File ') +
                'was rejected as too large (server limit ~4 MB). Compress the file and try again.'
            );
        }
        return (data && data.error) || 'Upload failed (' + status + ')';
    }

    async function postFormData(url, fd) {
        const res = await fetch(url, { method: 'POST', body: fd });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            return { ok: false, status: res.status, data, error: uploadErrorText(res.status, data) };
        }
        return { ok: true, status: res.status, data };
    }

    async function uploadPreparedToUrl(url, file, fieldName, extraFields) {
        const prep = await prepareFileForUpload(file);
        if (!prep.ok) {
            return { ok: false, error: prep.error, note: prep.note };
        }
        const fd = new FormData();
        fd.append(fieldName || 'file', prep.file);
        if (extraFields && typeof extraFields === 'object') {
            Object.keys(extraFields).forEach((k) => {
                const v = extraFields[k];
                if (v != null) fd.append(k, v);
            });
        }
        const result = await postFormData(url, fd);
        if (!result.ok) {
            return { ok: false, error: result.error + (file.name ? ' (' + file.name + ')' : '') };
        }
        return {
            ok: true,
            path: result.data.path,
            paths: result.data.paths,
            data: result.data,
            note: prep.note,
            compressed: prep.compressed
        };
    }

    async function uploadAdminAsset(file) {
        const r = await uploadPreparedToUrl('/api/admin/upload-asset', file, 'file');
        if (!r.ok) {
            alert(r.error);
            return null;
        }
        if (r.note) console.info('[upload]', r.note);
        return r.path || null;
    }

    async function uploadAdminAssetsSequential(files, opts) {
        const list = Array.from(files || []);
        const paths = [];
        const options = opts || {};
        const btn = options.progressBtn;
        const total = list.length;
        const notes = [];
        for (let i = 0; i < total; i++) {
            if (btn) {
                btn.disabled = true;
                btn.textContent = 'Uploading ' + (i + 1) + '/' + total + '…';
            }
            const r = await uploadPreparedToUrl('/api/admin/upload-asset', list[i], 'file');
            if (r.ok && r.path) {
                paths.push(r.path);
                if (r.note) notes.push(r.note);
            } else if (!r.ok) {
                alert(r.error);
            }
        }
        if (btn) {
            btn.disabled = false;
            btn.textContent = options.progressLabel || 'Upload multiple images';
        }
        if (notes.length) console.info('[upload]', notes.join(' '));
        return paths;
    }

    async function uploadFromInput(fileInput, options) {
        const opts = options || {};
        const files = opts.multiple
            ? Array.from((fileInput && fileInput.files) || [])
            : [(fileInput && fileInput.files && fileInput.files[0]) || null].filter(Boolean);
        if (!files.length) {
            if (!opts.silent) alert('Choose a file first.');
            return opts.multiple ? [] : null;
        }
        if (files.length === 1 && !opts.multiple) {
            return uploadAdminAsset(files[0]);
        }
        return uploadAdminAssetsSequential(files, opts);
    }

    function bindFileHint(inputEl, hintEl) {
        if (!inputEl || !hintEl) return;
        inputEl.addEventListener('change', () => {
            const f = inputEl.files && inputEl.files[0];
            if (!f) {
                hintEl.textContent = '';
                return;
            }
            let msg = 'Selected: ' + f.name + ' (' + formatBytes(f.size) + '). ';
            if (isImageFile(f)) {
                msg += 'Photos are auto-compressed before upload.';
            } else if (f.size > SERVER_HARD_MAX) {
                msg += 'Too large — compress before uploading (max ~4 MB).';
                hintEl.style.color = '#b91c1c';
            } else {
                msg += 'OK for upload.';
                hintEl.style.color = '#15803d';
            }
            hintEl.textContent = msg;
        });
    }

    global.PortalUpload = {
        SERVER_HARD_MAX,
        SERVER_SAFE_MAX,
        formatBytes,
        isImageFile,
        isPdfFile,
        compressHelpMessage,
        compressImageFile,
        prepareFileForUpload,
        uploadAdminAsset,
        uploadAdminAssetsSequential,
        uploadFromInput,
        uploadPreparedToUrl,
        bindFileHint
    };
})(typeof window !== 'undefined' ? window : global);
