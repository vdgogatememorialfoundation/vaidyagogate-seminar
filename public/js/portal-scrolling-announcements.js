/**
 * Shared horizontal scrolling announcement strip for public site and doctor portal.
 */
(function () {
    function escHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function cardHtml(it, cardClass) {
        const title = escHtml(it.title || 'Update');
        const body = escHtml(it.body || '');
        const date = it.date ? '<div class="sa-meta">' + escHtml(it.date) + '</div>' : '';
        const link =
            it.link && String(it.link).trim()
                ? '<div style="margin-top:8px;"><a href="' +
                  escHtml(it.link) +
                  '">View details</a></div>'
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
        const list = Array.isArray(items) ? items.filter((x) => x && (x.title || x.body)) : [];
        if (!list.length) {
            wrap.classList.add('hidden');
            track.innerHTML = '';
            return;
        }
        wrap.classList.remove('hidden');
        wrap.setAttribute('aria-hidden', 'false');
        const cls = cardClass || 'sa-card';
        let html = list.map((it) => cardHtml(it, cls)).join('');
        if (list.length === 1) html = html + html + html;
        else html = html + html;
        track.innerHTML = html;
        if (!track.classList.contains('scrolling-announce-track') && !track.classList.contains('portal-scrolling-announce-track')) {
            track.classList.add('scrolling-announce-track');
        }
    };
})();
