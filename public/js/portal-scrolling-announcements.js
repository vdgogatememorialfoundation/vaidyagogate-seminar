/**
 * Homepage sliding announcement strip (public site only).
 * Data: Admin → Website CMS → Homepage sliding announcements (+ open seminars from API).
 */
(function () {
    function escHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function isTestOrDuplicateAnnouncement(item) {
        const t = String(item.title || '');
        if (/test seminar/i.test(t) || /introduction to ayurveda/i.test(t)) return true;
        return false;
    }

    function dedupeAnnouncements(items) {
        const seen = new Set();
        const out = [];
        (items || []).forEach((x) => {
            if (!x || (!x.title && !x.body) || isTestOrDuplicateAnnouncement(x)) return;
            const key =
                x.autoFromSeminarId != null
                    ? 'seminar:' + Number(x.autoFromSeminarId)
                    : 'manual:' + String(x.title || '').trim() + '|' + String(x.body || '').trim().slice(0, 80);
            if (seen.has(key)) return;
            seen.add(key);
            out.push(x);
        });
        return out;
    }

    function cardHtml(it, cardClass) {
        const title = escHtml(it.title || 'Update');
        const body = escHtml(it.body || '');
        const date = it.date ? '<div class="sa-meta">' + escHtml(it.date) + '</div>' : '';
        const linkUrl = it.link && String(it.link).trim() ? String(it.link).trim() : '';
        const linkLabel = linkUrl.indexOf('doctor') !== -1 ? 'Register' : 'View details';
        const link = linkUrl
            ? '<div class="sa-card-link"><a href="' + escHtml(linkUrl) + '">' + linkLabel + '</a></div>'
            : '';
        return (
            '<article class="' +
            cardClass +
            '"><h5>' +
            title +
            '</h5><p>' +
            body +
            '</p>' +
            date +
            link +
            '</article>'
        );
    }

    window.renderPortalScrollingAnnouncements = function renderPortalScrollingAnnouncements(
        items,
        wrapId,
        trackId,
        cardClass
    ) {
        const wrap = document.getElementById(wrapId || 'scrolling-announce-wrap');
        const track = document.getElementById(trackId || 'scrolling-announce-track');
        if (!wrap || !track) return;
        const list = dedupeAnnouncements(items);
        if (!list.length) {
            wrap.classList.add('hidden');
            wrap.setAttribute('aria-hidden', 'true');
            track.innerHTML = '';
            track.classList.remove('sa-loop-set');
            return;
        }
        wrap.classList.remove('hidden');
        wrap.setAttribute('aria-hidden', 'false');
        const cls = cardClass || 'sa-card';
        const html = list.map((it) => cardHtml(it, cls)).join('');
        track.innerHTML = html + html;
        track.classList.add('sa-loop-set');
    };
})();
