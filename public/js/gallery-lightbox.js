(function () {
    let zoom = 1;
    let lb = null;
    let imgEl = null;
    let capEl = null;
    let zoomLbl = null;

    function ensureLightbox() {
        if (lb) return lb;
        lb = document.createElement('div');
        lb.id = 'vgmf-gallery-lightbox';
        lb.className = 'vgmf-gallery-lightbox';
        lb.setAttribute('role', 'dialog');
        lb.setAttribute('aria-modal', 'true');
        lb.innerHTML =
            '<div class="vgmf-gallery-lightbox-panel">' +
            '<div class="vgmf-gallery-lightbox-toolbar">' +
            '<p class="vgmf-gallery-lightbox-caption" id="vgmf-gallery-lightbox-caption"></p>' +
            '<div class="vgmf-gallery-lightbox-zoom">' +
            '<button type="button" id="vgmf-gallery-zoom-out" aria-label="Zoom out">−</button>' +
            '<span id="vgmf-gallery-zoom-pct">100%</span>' +
            '<button type="button" id="vgmf-gallery-zoom-in" aria-label="Zoom in">+</button>' +
            '</div>' +
            '<button type="button" class="vgmf-gallery-lightbox-close" id="vgmf-gallery-lightbox-close" aria-label="Close">×</button>' +
            '</div>' +
            '<div class="vgmf-gallery-lightbox-stage" id="vgmf-gallery-lightbox-stage">' +
            '<img id="vgmf-gallery-lightbox-img" alt="">' +
            '</div></div>';
        document.body.appendChild(lb);
        capEl = document.getElementById('vgmf-gallery-lightbox-caption');
        imgEl = document.getElementById('vgmf-gallery-lightbox-img');
        zoomLbl = document.getElementById('vgmf-gallery-zoom-pct');
        document.getElementById('vgmf-gallery-zoom-in').addEventListener('click', () => setZoom(zoom + 0.25));
        document.getElementById('vgmf-gallery-zoom-out').addEventListener('click', () => setZoom(zoom - 0.25));
        document.getElementById('vgmf-gallery-lightbox-close').addEventListener('click', closeLightbox);
        lb.addEventListener('click', (e) => {
            if (e.target === lb) closeLightbox();
        });
        document.addEventListener('keydown', (e) => {
            if (!lb.classList.contains('is-open')) return;
            if (e.key === 'Escape') closeLightbox();
            if (e.key === '+' || e.key === '=') setZoom(zoom + 0.25);
            if (e.key === '-') setZoom(zoom - 0.25);
        });
        const stage = document.getElementById('vgmf-gallery-lightbox-stage');
        if (stage) {
            stage.addEventListener('wheel', (e) => {
                if (!lb.classList.contains('is-open')) return;
                e.preventDefault();
                setZoom(zoom + (e.deltaY < 0 ? 0.15 : -0.15));
            }, { passive: false });
        }
        return lb;
    }

    function setZoom(z) {
        zoom = Math.min(3, Math.max(0.5, Math.round(z * 100) / 100));
        if (imgEl) imgEl.style.transform = 'scale(' + zoom + ')';
        if (zoomLbl) zoomLbl.textContent = Math.round(zoom * 100) + '%';
    }

    function openLightbox(src, caption) {
        ensureLightbox();
        zoom = 1;
        setZoom(1);
        imgEl.src = src;
        imgEl.alt = caption || 'Gallery image';
        if (capEl) capEl.textContent = caption || '';
        lb.classList.add('is-open');
        document.body.style.overflow = 'hidden';
    }

    function closeLightbox() {
        if (!lb) return;
        lb.classList.remove('is-open');
        document.body.style.overflow = '';
        if (imgEl) imgEl.src = '';
    }

    function markGalleryImages(root) {
        const scope = root && root.querySelectorAll ? root : document;
        scope.querySelectorAll('#gallery-grid img, .cg-past-gallery img').forEach((img) => {
            if (img.closest('.vgmf-gallery-lightbox')) return;
            img.classList.add('vgmf-gallery-thumb');
            if (!img.getAttribute('data-gallery-src')) {
                img.setAttribute('data-gallery-src', img.getAttribute('src') || '');
            }
        });
    }

    document.addEventListener('click', (e) => {
        const img = e.target && e.target.closest ? e.target.closest('.vgmf-gallery-thumb') : null;
        if (!img) return;
        const src = img.getAttribute('data-gallery-src') || img.getAttribute('src');
        if (!src) return;
        e.preventDefault();
        const cap =
            img.getAttribute('alt') ||
            (img.closest('figure') && img.closest('figure').querySelector('figcaption')?.textContent) ||
            (img.closest('.card-content') && img.closest('.card-content').querySelector('h3')?.textContent) ||
            '';
        openLightbox(src, cap);
    });

    const obs = new MutationObserver(() => markGalleryImages(document));
    document.addEventListener('DOMContentLoaded', () => {
        markGalleryImages(document);
        const grid = document.getElementById('gallery-grid');
        if (grid) obs.observe(grid, { childList: true, subtree: true });
        const past = document.getElementById('cg-past-timeline');
        if (past) obs.observe(past, { childList: true, subtree: true });
    });

    global.VgmfGalleryLightbox = { open: openLightbox, close: closeLightbox, mark: markGalleryImages };
})();
