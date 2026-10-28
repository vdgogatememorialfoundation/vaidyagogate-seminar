/**
 * Admin: seminar video library (uploads, packaging status, publishing, prices, access grants).
 */
(function () {
    let state = null;
    let pollTimer = null;
    let uploads = {}; // videoId -> { paused, abort }
    let chosenUser = null;

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function $(id) {
        return document.getElementById(id);
    }

    function adminId() {
        try {
            const u = JSON.parse(localStorage.getItem('admin_user') || '{}');
            return u && u.id ? String(u.id) : '';
        } catch (_) {
            return '';
        }
    }

    function headers(extra) {
        return Object.assign({ 'Content-Type': 'application/json', 'X-Acting-User-Id': adminId() }, extra || {});
    }

    async function api(url, opts) {
        const o = Object.assign({ headers: headers() }, opts || {});
        if (o.body && typeof o.body === 'object' && !(o.body instanceof Blob) && !(o.body instanceof ArrayBuffer)) {
            o.body = JSON.stringify(Object.assign({ actingAdminId: adminId() }, o.body));
        }
        const sep = url.includes('?') ? '&' : '?';
        const res = await fetch(url + sep + 'actingAdminId=' + encodeURIComponent(adminId()), o);
        let body = null;
        try {
            body = await res.json();
        } catch (_) {
            body = null;
        }
        if (!res.ok) throw new Error((body && body.error) || 'Request failed (' + res.status + ')');
        return body;
    }

    function fmtBytes(n) {
        const b = Number(n) || 0;
        if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(2) + ' GB';
        if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(1) + ' MB';
        if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
        return b + ' B';
    }

    function fmtDuration(sec) {
        const s = Math.max(0, Math.round(Number(sec) || 0));
        if (!s) return '—';
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        if (!h && !m) return s + 's';
        return (h ? h + 'h ' : '') + m + 'm';
    }

    function fmtMoney(n) {
        return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
    }

    function fmtWhen(iso) {
        if (!iso) return '—';
        const d = new Date(iso);
        return Number.isFinite(d.getTime()) ? d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '—';
    }

    function setMsg(id, text, bad) {
        const el = $(id);
        if (!el) return;
        el.textContent = text || '';
        el.style.color = bad ? '#b91c1c' : '#0f766e';
    }

    /* ------------------------------------------------------------ load */

    async function load() {
        const host = $('vl-admin-root');
        if (!host) return;
        try {
            state = await api('/api/admin/videos');
        } catch (e) {
            host.innerHTML = '<p style="color:#b91c1c;font-weight:600;">' + esc(e.message) + '</p>';
            return;
        }
        if (!host.__built) build(host);
        renderStatus();
        renderYearForm();
        renderVideos();
        loadAccess();
        schedulePoll();
    }

    function schedulePoll() {
        clearTimeout(pollTimer);
        const busy = (state.videos || []).some((v) => v.status === 'processing' || v.status === 'uploaded') || (state.processing && state.processing.queued.length);
        if (!busy) return;
        pollTimer = setTimeout(async () => {
            try {
                state = await api('/api/admin/videos');
                renderStatus();
                renderVideos();
            } catch (_) {}
            schedulePoll();
        }, 5000);
    }

    function build(host) {
        host.__built = true;
        host.innerHTML =
            '<div class="vl-admin-status" id="vl-admin-status"></div>' +
            '<div class="vl-admin-grid">' +
            '<div class="vl-form" id="vl-create-form"><h3>Add a video</h3>' +
            '<div class="vl-form-row"><div><label>Seminar year</label><input type="number" id="vlc-year" min="2000" max="2100" placeholder="2026"></div>' +
            '<div><label>Seminar (optional, for free access)</label><select id="vlc-seminar"><option value="">Any seminar of that year</option></select></div></div>' +
            '<label>Title</label><input type="text" id="vlc-title" maxlength="200" placeholder="Day 1 — Inaugural session">' +
            '<div class="vl-form-row"><div><label>Type</label><select id="vlc-kind"><option value="episode">Episode / part</option><option value="full">Full video</option></select></div>' +
            '<div><label>Part number</label><input type="number" id="vlc-part" min="1" placeholder="1"></div></div>' +
            '<label>Price for non-registered doctors (₹, 0 = not sold separately)</label><input type="number" id="vlc-price" min="0" step="1" value="0">' +
            '<label>Description</label><textarea id="vlc-desc" maxlength="2000"></textarea>' +
            '<div class="vl-upload-row" style="margin-top:10px;"><button type="button" class="vl-btn" id="vlc-save">Create video</button><span class="vl-note">Then upload the file from the table below.</span></div>' +
            '<p class="vl-form-msg" id="vlc-msg"></p></div>' +
            '<div class="vl-form" id="vl-year-form"><h3>Year settings</h3>' +
            '<label>Year</label><input type="number" id="vly-year" min="2000" max="2100">' +
            '<label>Title shown to doctors</label><input type="text" id="vly-title" maxlength="200" placeholder="National Seminar 2026">' +
            '<label>Description</label><textarea id="vly-desc" maxlength="2000"></textarea>' +
            '<label>Price to unlock all videos of the year (₹, blank = not offered)</label><input type="number" id="vly-price" min="0" step="1">' +
            '<div class="vl-upload-row" style="margin-top:10px;"><button type="button" class="vl-btn" id="vly-save">Save year</button></div>' +
            '<p class="vl-form-msg" id="vly-msg"></p>' +
            '<p class="vl-note" style="margin-top:10px;">Free access: a doctor whose registration for that year is completed, has an e-ticket, is checked in, or has a certificate. Everyone else pays the price or is enabled below.</p></div>' +
            '</div>' +
            '<h3 style="margin:18px 0 8px;font-size:1.05rem;">Videos</h3><div id="vl-admin-videos"></div>' +
            '<div class="vl-admin-grid" style="margin-top:22px;">' +
            '<div class="vl-form"><h3>Enable a doctor</h3>' +
            '<label>Find doctor (name, email, phone, ID)</label><input type="text" id="vla-search" placeholder="Type at least 2 characters"><div class="vl-user-pick" id="vla-picks"></div><div id="vla-chosen"></div>' +
            '<div class="vl-form-row"><div><label>Year</label><input type="number" id="vla-year" min="2000" max="2100"></div>' +
            '<div><label>Video (optional)</label><select id="vla-video"><option value="">All videos of the year</option></select></div></div>' +
            '<div class="vl-form-row"><div><label>Type</label><select id="vla-source"><option value="admin_free">Free (complimentary)</option><option value="admin_paid">Paid at the office (record payment)</option></select></div>' +
            '<div><label>Amount received (₹)</label><input type="number" id="vla-amount" min="0" step="1" placeholder="0"></div></div>' +
            '<label>Note</label><input type="text" id="vla-note" maxlength="300" placeholder="Receipt no., reason…">' +
            '<div class="vl-upload-row" style="margin-top:10px;"><button type="button" class="vl-btn" id="vla-save">Enable access</button></div>' +
            '<p class="vl-form-msg" id="vla-msg"></p></div>' +
            '<div class="vl-form"><h3>Who has access</h3><div class="vl-upload-row"><label style="margin:0;">Year</label><input type="number" id="vlg-year" min="2000" max="2100" style="width:120px;"><button type="button" class="vl-btn is-ghost is-small" id="vlg-reload">Refresh</button></div>' +
            '<div class="vl-table-wrap" id="vl-grants"></div><h4 style="margin:14px 0 6px;font-size:0.95rem;">Online purchases</h4><div class="vl-table-wrap" id="vl-purchases"></div></div>' +
            '</div>';
        $('vlc-save').addEventListener('click', createVideo);
        $('vly-save').addEventListener('click', saveYear);
        $('vly-year').addEventListener('change', renderYearForm);
        $('vla-search').addEventListener('input', debounce(searchUsers, 300));
        $('vla-save').addEventListener('click', grantAccess);
        $('vla-year').addEventListener('change', fillGrantVideos);
        $('vlg-reload').addEventListener('click', loadAccess);
        $('vla-source').addEventListener('change', () => {
            $('vla-amount').disabled = $('vla-source').value !== 'admin_paid';
        });
        $('vla-amount').disabled = true;
    }

    function debounce(fn, ms) {
        let t;
        return function () {
            clearTimeout(t);
            t = setTimeout(fn, ms);
        };
    }

    function renderStatus() {
        const el = $('vl-admin-status');
        if (!el || !state) return;
        const t = state.tools || {};
        const disk = t.disk ? 'Free disk: ' + fmtBytes(t.disk.freeBytes) + ' of ' + fmtBytes(t.disk.totalBytes) : '';
        const proc = state.processing || {};
        el.innerHTML =
            (t.ffmpeg && t.ffprobe
                ? '<span class="good"><i class="fas fa-check-circle"></i> ffmpeg ready</span>'
                : '<span class="bad"><i class="fas fa-exclamation-triangle"></i> ffmpeg is not installed on the server — uploads will wait until it is (apt install ffmpeg)</span>') +
            '<span>Storage: <code>' + esc(t.storageDir || '') + '</code></span>' +
            (disk ? '<span>' + esc(disk) + '</span>' : '') +
            '<span>Upload chunk: ' + fmtBytes(t.chunkBytes) + '</span>' +
            (proc.running ? '<span class="good">Processing video #' + proc.running + (proc.queued && proc.queued.length ? ' (+' + proc.queued.length + ' queued)' : '') + '</span>' : '');
        const sel = $('vlc-seminar');
        if (sel && sel.options.length <= 1) {
            (state.seminars || []).forEach((s) => {
                const o = document.createElement('option');
                o.value = s.id;
                o.textContent = (s.year ? s.year + ' · ' : '') + s.title;
                sel.appendChild(o);
            });
        }
    }

    function renderYearForm() {
        const yearInput = $('vly-year');
        if (!yearInput || !state) return;
        const years = Array.from(new Set([...(state.years || []).map((y) => y.year), ...(state.videos || []).map((v) => v.year)])).sort((a, b) => b - a);
        if (!yearInput.value && years.length) yearInput.value = years[0];
        const y = (state.years || []).find((row) => Number(row.year) === Number(yearInput.value));
        $('vly-title').value = y ? y.title : '';
        $('vly-desc').value = y ? y.description : '';
        $('vly-price').value = y && y.bundlePriceInr != null ? y.bundlePriceInr : '';
        if (!$('vlg-year').value && years.length) $('vlg-year').value = years[0];
        if (!$('vla-year').value && years.length) {
            $('vla-year').value = years[0];
            fillGrantVideos();
        }
    }

    function fillGrantVideos() {
        const sel = $('vla-video');
        const year = Number($('vla-year').value);
        if (!sel) return;
        sel.innerHTML = '<option value="">All videos of the year</option>';
        (state.videos || [])
            .filter((v) => v.year === year)
            .forEach((v) => {
                const o = document.createElement('option');
                o.value = v.id;
                o.textContent = (v.kind === 'full' ? 'Full · ' : 'Part ' + (v.partNo || '') + ' · ') + v.title;
                sel.appendChild(o);
            });
    }

    function statusBadge(v) {
        const map = { ready: 'Ready', processing: 'Processing', uploading: 'Uploading', uploaded: 'Queued', failed: 'Failed', draft: 'No file yet' };
        let text = map[v.status] || v.status;
        if (v.status === 'processing' && v.processProgress != null) text += ' ' + Math.round(v.processProgress * 100) + '%';
        return '<span class="vl-badge is-' + esc(v.status) + '">' + esc(text) + '</span>';
    }

    function renderVideos() {
        const host = $('vl-admin-videos');
        if (!host || !state) return;
        const videos = state.videos || [];
        if (!videos.length) {
            host.innerHTML = '<p class="vl-note">No videos yet. Create one above, then upload its file.</p>';
            return;
        }
        const years = Array.from(new Set(videos.map((v) => v.year))).sort((a, b) => b - a);
        host.innerHTML = years
            .map((year) => {
                const rows = videos
                    .filter((v) => v.year === year)
                    .map((v) => {
                        const up = uploads[v.id];
                        const progress =
                            v.status === 'processing'
                                ? '<div class="vl-progress" style="margin-top:6px;"><span style="width:' + Math.round((v.processProgress || 0) * 100) + '%"></span></div>'
                                : up
                                  ? '<div class="vl-progress" style="margin-top:6px;"><span style="width:' + Math.round((up.fraction || 0) * 100) + '%"></span></div><div class="vl-note">' + esc(up.text || '') + '</div>'
                                  : '';
                        const log = v.processLog ? '<div class="vl-note" title="' + esc(v.processLog) + '">' + esc(v.processLog.length > 110 ? v.processLog.slice(0, 107) + '…' : v.processLog) + '</div>' : '';
                        const uploadControls =
                            v.status === 'processing'
                                ? ''
                                : up
                                  ? '<button type="button" class="vl-btn is-ghost is-small" data-vl-act="pause" data-id="' + v.id + '">' + (up.paused ? 'Resume upload' : 'Pause upload') + '</button>'
                                  : '<label class="vl-btn is-ghost is-small" style="display:inline-block;">' +
                                    (v.status === 'draft' ? 'Upload file' : 'Replace file') +
                                    '<input type="file" accept="video/*,.mp4,.mkv,.mov,.ts,.m4v" style="display:none;" data-vl-file="' +
                                    v.id +
                                    '"></label>' +
                                    '<button type="button" class="vl-btn is-ghost is-small" data-vl-act="import" data-id="' + v.id + '">Import from server inbox</button>';
                        return (
                            '<tr><td><strong>' +
                            esc(v.title) +
                            '</strong><div class="vl-note">' +
                            (v.kind === 'full' ? 'Full video' : 'Part ' + (v.partNo != null ? v.partNo : '—')) +
                            (v.seminarId ? ' · seminar #' + v.seminarId : '') +
                            '</div>' +
                            log +
                            '</td><td>' +
                            statusBadge(v) +
                            progress +
                            '</td><td>' +
                            (v.sizeBytes ? fmtBytes(v.sizeBytes) : '—') +
                            '<div class="vl-note">' +
                            fmtDuration(v.durationSec) +
                            (v.segmentCount ? ' · ' + v.segmentCount + ' seg' : '') +
                            '</div></td><td>' +
                            (v.priceInr > 0 ? fmtMoney(v.priceInr) : '<span class="vl-note">registered only</span>') +
                            '</td><td>' +
                            (v.published ? '<span class="vl-badge is-free">Published</span>' : '<span class="vl-badge">Hidden</span>') +
                            '</td><td><div class="vl-actions">' +
                            uploadControls +
                            (v.status === 'failed' || (v.status === 'uploaded' && v.hasSource) ? '<button type="button" class="vl-btn is-warn is-small" data-vl-act="process" data-id="' + v.id + '">Process</button>' : '') +
                            (v.status === 'ready'
                                ? '<button type="button" class="vl-btn is-small ' + (v.published ? 'is-ghost' : '') + '" data-vl-act="publish" data-id="' + v.id + '">' + (v.published ? 'Unpublish' : 'Publish') + '</button>'
                                : '') +
                            '<button type="button" class="vl-btn is-ghost is-small" data-vl-act="edit" data-id="' + v.id + '">Edit</button>' +
                            '<button type="button" class="vl-btn is-danger is-small" data-vl-act="delete" data-id="' + v.id + '">Delete</button>' +
                            '</div></td></tr>'
                        );
                    })
                    .join('');
                return (
                    '<h4 style="margin:12px 0 6px;">' +
                    year +
                    '</h4><div class="vl-table-wrap"><table class="vl-table"><thead><tr><th>Video</th><th>Status</th><th>File</th><th>Price</th><th>Visible</th><th>Actions</th></tr></thead><tbody>' +
                    rows +
                    '</tbody></table></div>'
                );
            })
            .join('');
        host.querySelectorAll('[data-vl-file]').forEach((inp) =>
            inp.addEventListener('change', () => {
                if (inp.files && inp.files[0]) startUpload(parseInt(inp.getAttribute('data-vl-file'), 10), inp.files[0]);
            })
        );
        host.querySelectorAll('[data-vl-act]').forEach((b) => b.addEventListener('click', () => action(b.getAttribute('data-vl-act'), parseInt(b.getAttribute('data-id'), 10))));
    }

    /* --------------------------------------------------------- actions */

    async function createVideo() {
        const body = {
            year: $('vlc-year').value,
            seminarId: $('vlc-seminar').value,
            title: $('vlc-title').value,
            kind: $('vlc-kind').value,
            partNo: $('vlc-part').value,
            priceInr: $('vlc-price').value,
            description: $('vlc-desc').value,
            published: false
        };
        try {
            await api('/api/admin/videos', { method: 'POST', body });
            setMsg('vlc-msg', 'Video created. Upload its file from the table.');
            $('vlc-title').value = '';
            $('vlc-desc').value = '';
            await load();
        } catch (e) {
            setMsg('vlc-msg', e.message, true);
        }
    }

    async function saveYear() {
        const year = $('vly-year').value;
        try {
            await api('/api/admin/videos/years/' + encodeURIComponent(year), {
                method: 'PUT',
                body: { title: $('vly-title').value, description: $('vly-desc').value, bundlePriceInr: $('vly-price').value }
            });
            setMsg('vly-msg', 'Saved.');
            await load();
        } catch (e) {
            setMsg('vly-msg', e.message, true);
        }
    }

    async function action(kind, id) {
        const v = (state.videos || []).find((x) => x.id === id);
        if (!v) return;
        try {
            if (kind === 'publish') {
                await api('/api/admin/videos/' + id, { method: 'PUT', body: { published: !v.published } });
            } else if (kind === 'process') {
                await api('/api/admin/videos/' + id + '/process', { method: 'POST', body: {} });
            } else if (kind === 'delete') {
                if (!confirm('Delete "' + v.title + '" and its encrypted files? Doctors lose access to this video.')) return;
                await api('/api/admin/videos/' + id, { method: 'DELETE' });
            } else if (kind === 'edit') {
                return editVideo(v);
            } else if (kind === 'import') {
                return importFromInbox(v);
            } else if (kind === 'pause') {
                const up = uploads[id];
                if (up) {
                    if (up.paused) resumeUpload(id);
                    else up.paused = true;
                    renderVideos();
                }
                return;
            }
            await load();
        } catch (e) {
            alert(e.message);
        }
    }

    function editVideo(v) {
        const modal = document.createElement('div');
        modal.className = 'vl-modal';
        modal.innerHTML =
            '<div class="vl-form"><h3>Edit video</h3>' +
            '<div class="vl-form-row"><div><label>Seminar year</label><input type="number" id="vle-year" value="' + v.year + '"></div>' +
            '<div><label>Seminar</label><select id="vle-seminar"><option value="">Any seminar of that year</option>' +
            (state.seminars || []).map((s) => '<option value="' + s.id + '"' + (v.seminarId === s.id ? ' selected' : '') + '>' + esc((s.year ? s.year + ' · ' : '') + s.title) + '</option>').join('') +
            '</select></div></div>' +
            '<label>Title</label><input type="text" id="vle-title" value="' + esc(v.title) + '">' +
            '<div class="vl-form-row"><div><label>Type</label><select id="vle-kind"><option value="episode"' + (v.kind === 'episode' ? ' selected' : '') + '>Episode / part</option><option value="full"' + (v.kind === 'full' ? ' selected' : '') + '>Full video</option></select></div>' +
            '<div><label>Part number</label><input type="number" id="vle-part" min="1" value="' + (v.partNo != null ? v.partNo : '') + '"></div></div>' +
            '<div class="vl-form-row"><div><label>Price (₹)</label><input type="number" id="vle-price" min="0" step="1" value="' + v.priceInr + '"></div>' +
            '<div><label>Sort order</label><input type="number" id="vle-sort" value="' + (v.sortOrder || 0) + '"></div></div>' +
            '<label>Description</label><textarea id="vle-desc">' + esc(v.description) + '</textarea>' +
            '<div class="vl-upload-row" style="margin-top:10px;"><button type="button" class="vl-btn" id="vle-save">Save</button><button type="button" class="vl-btn is-ghost" id="vle-cancel">Cancel</button></div>' +
            '<p class="vl-form-msg" id="vle-msg"></p></div>';
        document.body.appendChild(modal);
        modal.querySelector('#vle-cancel').addEventListener('click', () => modal.remove());
        modal.querySelector('#vle-save').addEventListener('click', async () => {
            try {
                await api('/api/admin/videos/' + v.id, {
                    method: 'PUT',
                    body: {
                        year: modal.querySelector('#vle-year').value,
                        seminarId: modal.querySelector('#vle-seminar').value,
                        title: modal.querySelector('#vle-title').value,
                        kind: modal.querySelector('#vle-kind').value,
                        partNo: modal.querySelector('#vle-part').value,
                        priceInr: modal.querySelector('#vle-price').value,
                        sortOrder: modal.querySelector('#vle-sort').value,
                        description: modal.querySelector('#vle-desc').value
                    }
                });
                modal.remove();
                await load();
            } catch (e) {
                modal.querySelector('#vle-msg').textContent = e.message;
                modal.querySelector('#vle-msg').style.color = '#b91c1c';
            }
        });
    }

    async function importFromInbox(v) {
        let inbox;
        try {
            inbox = await api('/api/admin/videos/inbox');
        } catch (e) {
            return alert(e.message);
        }
        const modal = document.createElement('div');
        modal.className = 'vl-modal';
        const files = inbox.files || [];
        modal.innerHTML =
            '<div class="vl-form"><h3>Import from the server inbox</h3>' +
            '<p class="vl-note">For very large files, copy the file to <code>' + esc(inbox.inboxDir) + '</code> on the server (scp/sftp), then pick it here. The file is moved, not copied.</p>' +
            (files.length
                ? '<div class="vl-user-pick">' + files.map((f) => '<button type="button" data-name="' + esc(f.name) + '"><strong>' + esc(f.name) + '</strong> · ' + fmtBytes(f.bytes) + ' · ' + fmtWhen(f.modifiedAt) + '</button>').join('') + '</div>'
                : '<p class="vl-note">The inbox folder is empty.</p>') +
            '<div class="vl-upload-row" style="margin-top:10px;"><button type="button" class="vl-btn is-ghost" id="vli-cancel">Cancel</button></div><p class="vl-form-msg" id="vli-msg"></p></div>';
        document.body.appendChild(modal);
        modal.querySelector('#vli-cancel').addEventListener('click', () => modal.remove());
        modal.querySelectorAll('[data-name]').forEach((b) =>
            b.addEventListener('click', async () => {
                try {
                    const out = await api('/api/admin/videos/' + v.id + '/import', { method: 'POST', body: { fileName: b.getAttribute('data-name') } });
                    modal.remove();
                    if (out.warning) alert(out.warning);
                    await load();
                } catch (e) {
                    modal.querySelector('#vli-msg').textContent = e.message;
                }
            })
        );
    }

    /* ---------------------------------------------------------- upload */

    function resumeKey(videoId, file) {
        return 'vl-upload-' + videoId + '-' + file.size + '-' + file.name;
    }

    async function startUpload(videoId, file) {
        if (uploads[videoId]) return;
        const up = { file, paused: false, fraction: 0, text: 'Starting…', uploadId: null, chunkBytes: 0, nextIndex: 0 };
        uploads[videoId] = up;
        renderVideos();
        try {
            const resume = localStorage.getItem(resumeKey(videoId, file)) || '';
            const start = await api('/api/admin/videos/' + videoId + '/upload/start', {
                method: 'POST',
                body: { fileName: file.name, totalBytes: file.size, uploadId: resume }
            });
            up.uploadId = start.uploadId;
            up.chunkBytes = start.chunkBytes;
            up.nextIndex = start.chunksDone || 0;
            localStorage.setItem(resumeKey(videoId, file), start.uploadId);
            await pump(videoId);
        } catch (e) {
            delete uploads[videoId];
            alert('Upload failed: ' + e.message);
            await load();
        }
    }

    function resumeUpload(videoId) {
        const up = uploads[videoId];
        if (!up) return;
        up.paused = false;
        pump(videoId).catch((e) => {
            alert('Upload failed: ' + e.message);
        });
    }

    async function pump(videoId) {
        const up = uploads[videoId];
        if (!up) return;
        const total = Math.ceil(up.file.size / up.chunkBytes);
        while (up.nextIndex < total) {
            if (up.paused) {
                up.text = 'Paused at ' + Math.round(up.fraction * 100) + '%';
                renderVideos();
                return;
            }
            const i = up.nextIndex;
            const blob = up.file.slice(i * up.chunkBytes, Math.min(up.file.size, (i + 1) * up.chunkBytes));
            let attempt = 0;
            for (;;) {
                try {
                    const res = await fetch('/api/admin/videos/upload/' + up.uploadId + '/chunk?index=' + i + '&actingAdminId=' + encodeURIComponent(adminId()), {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/octet-stream', 'X-Acting-User-Id': adminId() },
                        body: blob
                    });
                    if (!res.ok) {
                        let err = 'HTTP ' + res.status;
                        try {
                            err = (await res.json()).error || err;
                        } catch (_) {}
                        if (res.status === 404 || res.status === 400) throw new Error(err);
                        throw Object.assign(new Error(err), { retry: true });
                    }
                    break;
                } catch (e) {
                    attempt += 1;
                    if (!e.retry && e.name !== 'TypeError') throw e;
                    if (attempt > 6) throw new Error('Network kept failing while uploading. Press Resume to continue.');
                    up.text = 'Retrying chunk ' + (i + 1) + ' (' + attempt + ')…';
                    renderVideos();
                    await new Promise((r) => setTimeout(r, Math.min(30000, 1000 * 2 ** attempt)));
                }
            }
            up.nextIndex = i + 1;
            up.fraction = up.nextIndex / total;
            up.text = 'Uploading ' + fmtBytes(Math.min(up.file.size, up.nextIndex * up.chunkBytes)) + ' of ' + fmtBytes(up.file.size) + ' (' + Math.round(up.fraction * 100) + '%)';
            if (up.nextIndex % 4 === 0 || up.nextIndex === total) renderVideos();
        }
        up.text = 'Finishing…';
        renderVideos();
        const done = await api('/api/admin/videos/upload/' + up.uploadId + '/complete', { method: 'POST', body: {} });
        localStorage.removeItem(resumeKey(videoId, up.file));
        delete uploads[videoId];
        if (done.warning) alert(done.warning);
        await load();
    }

    /* ---------------------------------------------------------- access */

    async function searchUsers() {
        const q = $('vla-search').value.trim();
        const host = $('vla-picks');
        if (q.length < 2) {
            host.innerHTML = '';
            return;
        }
        try {
            const rows = await api('/api/admin/videos/users?q=' + encodeURIComponent(q));
            host.innerHTML = rows.length
                ? rows.map((u) => '<button type="button" data-uid="' + u.id + '" data-name="' + esc(u.name) + '"><strong>' + esc(u.name) + '</strong> <span class="vl-note">' + esc(u.userIdString || '') + ' ' + esc(u.email || '') + '</span></button>').join('')
                : '<span class="vl-note">No doctor matches.</span>';
            host.querySelectorAll('[data-uid]').forEach((b) =>
                b.addEventListener('click', () => {
                    chosenUser = { id: parseInt(b.getAttribute('data-uid'), 10), name: b.getAttribute('data-name') };
                    $('vla-chosen').innerHTML = '<div class="vl-chosen">Selected: ' + esc(chosenUser.name) + '</div>';
                    host.innerHTML = '';
                })
            );
        } catch (e) {
            host.innerHTML = '<span class="vl-note" style="color:#b91c1c;">' + esc(e.message) + '</span>';
        }
    }

    async function grantAccess() {
        if (!chosenUser) return setMsg('vla-msg', 'Pick a doctor first.', true);
        try {
            await api('/api/admin/videos/access', {
                method: 'POST',
                body: {
                    userId: chosenUser.id,
                    year: $('vla-year').value,
                    videoId: $('vla-video').value,
                    source: $('vla-source').value,
                    amountInr: $('vla-amount').value,
                    note: $('vla-note').value
                }
            });
            setMsg('vla-msg', 'Access enabled for ' + chosenUser.name + '.');
            $('vla-note').value = '';
            $('vlg-year').value = $('vla-year').value;
            loadAccess();
        } catch (e) {
            setMsg('vla-msg', e.message, true);
        }
    }

    async function loadAccess() {
        const year = $('vlg-year') ? $('vlg-year').value : '';
        const gHost = $('vl-grants');
        const pHost = $('vl-purchases');
        if (!gHost) return;
        try {
            const out = await api('/api/admin/videos/access' + (year ? '?year=' + encodeURIComponent(year) : ''));
            const grants = out.grants || [];
            gHost.innerHTML = grants.length
                ? '<table class="vl-table"><thead><tr><th>Doctor</th><th>Scope</th><th>Type</th><th>By</th><th>When</th><th></th></tr></thead><tbody>' +
                  grants
                      .map(
                          (g) =>
                              '<tr' + (g.revokedAt ? ' style="opacity:.55;"' : '') + '><td>' + esc(g.user) + '<div class="vl-note">' + esc(g.userIdString || g.email || '') + '</div></td><td>' +
                              (g.videoId ? esc(g.videoTitle) : 'All ' + g.year + ' videos') +
                              '</td><td>' +
                              (g.source === 'purchase' ? 'Online · ' + fmtMoney(g.amountInr) : g.source === 'admin_paid' ? 'Paid at office · ' + fmtMoney(g.amountInr) : 'Free') +
                              (g.note ? '<div class="vl-note">' + esc(g.note) + '</div>' : '') +
                              '</td><td>' + esc(g.grantedBy || (g.source === 'purchase' ? 'Doctor' : '')) + '</td><td>' + fmtWhen(g.createdAt) + (g.revokedAt ? '<div class="vl-note">Revoked ' + fmtWhen(g.revokedAt) + '</div>' : '') + '</td><td>' +
                              (g.revokedAt ? '' : '<button type="button" class="vl-btn is-danger is-small" data-revoke="' + g.id + '">Revoke</button>') +
                              '</td></tr>'
                      )
                      .join('') +
                  '</tbody></table>'
                : '<p class="vl-note">No grants or purchases for this year yet.</p>';
            gHost.querySelectorAll('[data-revoke]').forEach((b) =>
                b.addEventListener('click', async () => {
                    if (!confirm('Revoke this access?')) return;
                    try {
                        await api('/api/admin/videos/access/' + b.getAttribute('data-revoke') + '/revoke', { method: 'POST', body: {} });
                        loadAccess();
                    } catch (e) {
                        alert(e.message);
                    }
                })
            );
            const purchases = out.purchases || [];
            pHost.innerHTML = purchases.length
                ? '<table class="vl-table"><thead><tr><th>Doctor</th><th>Item</th><th>Amount</th><th>Status</th><th>Order</th><th>When</th></tr></thead><tbody>' +
                  purchases
                      .map(
                          (p) =>
                              '<tr><td>' + esc(p.user) + '</td><td>' + esc(p.videoTitle) + '</td><td>' + fmtMoney(p.amountInr) + '</td><td><span class="vl-badge ' + (p.status === 'paid' ? 'is-free' : 'is-paid') + '">' + esc(p.status) + '</span></td><td>' + esc(p.orderRef) + '</td><td>' + fmtWhen(p.paidAt || p.createdAt) + '</td></tr>'
                      )
                      .join('') +
                  '</tbody></table>'
                : '<p class="vl-note">No online purchases yet.</p>';
        } catch (e) {
            gHost.innerHTML = '<p class="vl-note" style="color:#b91c1c;">' + esc(e.message) + '</p>';
        }
    }

    window.loadVideoLibraryAdmin = load;
})();
