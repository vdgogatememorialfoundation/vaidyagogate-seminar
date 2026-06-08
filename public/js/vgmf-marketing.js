/**
 * DB-driven homepage hero carousel + promotional popup.
 */
(function () {
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/"/g, '&quot;');
    }

    function imgUrl(path) {
        if (!path) return '';
        const p = String(path).trim();
        if (p.startsWith('http') || p.startsWith('/')) return p;
        return '/uploads/' + p;
    }

    let carouselTimer = null;
    let carouselIndex = 0;
    let popupSlideTimer = null;
    let popupSlideIndex = 0;

    function renderCarousel(banners, autoSlideMs) {
        const wrap = document.getElementById('marketing-hero');
        const staticHero = document.querySelector('section.hero');
        if (!wrap) return;

        const list = (banners || []).filter((b) => b && b.imagePath);
        if (!list.length) {
            wrap.classList.add('hidden');
            wrap.innerHTML = '';
            if (staticHero) staticHero.classList.remove('hero--dimmed');
            if (carouselTimer) clearInterval(carouselTimer);
            return;
        }

        wrap.classList.remove('hidden');
        if (staticHero) staticHero.classList.add('hero--dimmed');

        const ms = Math.max(3000, parseInt(autoSlideMs, 10) || 5500);
        carouselIndex = 0;

        const slides = list
            .map((b, i) => {
                const src = esc(imgUrl(b.imagePath));
                const title = b.title ? '<h2 class="mh-title">' + esc(b.title) + '</h2>' : '';
                const sub = b.subtitle ? '<p class="mh-sub">' + esc(b.subtitle) + '</p>' : '';
                const desc = b.description ? '<p class="mh-desc">' + esc(b.description) + '</p>' : '';
                const cta =
                    b.ctaText && b.ctaUrl
                        ? '<a href="' + esc(b.ctaUrl) + '" class="btn-primary mh-cta">' + esc(b.ctaText) + '</a>'
                        : '';
                const actions = cta ? '<div class="mh-actions">' + cta + '</div>' : '';
                return (
                    '<div class="mh-slide' +
                    (i === 0 ? ' is-active' : '') +
                    '" data-idx="' +
                    i +
                    '">' +
                    '<div class="mh-bg" style="background-image:url(\'' +
                    src +
                    '\')"></div>' +
                    '<div class="mh-overlay"></div>' +
                    '<div class="mh-content">' +
                    title +
                    sub +
                    desc +
                    actions +
                    '</div>' +
                    '</div>'
                );
            })
            .join('');

        const dots =
            list.length > 1
                ? '<div class="mh-dots">' +
                  list
                      .map(function (_, i) {
                          return (
                              '<button type="button" class="mh-dot' +
                              (i === 0 ? ' is-active' : '') +
                              '" data-go="' +
                              i +
                              '" aria-label="Slide ' +
                              (i + 1) +
                              '"></button>'
                          );
                      })
                      .join('') +
                  '</div>'
                : '';

        const nav =
            list.length > 1
                ? '<button type="button" class="mh-nav mh-prev" aria-label="Previous"><i class="fas fa-chevron-left"></i></button>' +
                  '<button type="button" class="mh-nav mh-next" aria-label="Next"><i class="fas fa-chevron-right"></i></button>'
                : '';

        wrap.innerHTML =
            '<div class="mh-carousel" role="region" aria-label="Seminar highlights">' +
            '<div class="mh-track">' +
            slides +
            '</div>' +
            nav +
            dots +
            '</div>';

        const slideEls = wrap.querySelectorAll('.mh-slide');
        const dotEls = wrap.querySelectorAll('.mh-dot');

        function goTo(idx) {
            carouselIndex = (idx + list.length) % list.length;
            slideEls.forEach(function (el, i) {
                el.classList.toggle('is-active', i === carouselIndex);
            });
            dotEls.forEach(function (el, i) {
                el.classList.toggle('is-active', i === carouselIndex);
            });
        }

        function next() {
            goTo(carouselIndex + 1);
        }
        function prev() {
            goTo(carouselIndex - 1);
        }

        var nextBtn = wrap.querySelector('.mh-next');
        var prevBtn = wrap.querySelector('.mh-prev');
        if (nextBtn) {
            nextBtn.addEventListener('click', function () {
                next();
                restartTimer();
            });
        }
        if (prevBtn) {
            prevBtn.addEventListener('click', function () {
                prev();
                restartTimer();
            });
        }
        dotEls.forEach(function (d) {
            d.addEventListener('click', function () {
                goTo(parseInt(d.getAttribute('data-go'), 10));
                restartTimer();
            });
        });

        function restartTimer() {
            if (carouselTimer) clearInterval(carouselTimer);
            if (list.length > 1) carouselTimer = setInterval(next, ms);
        }
        restartTimer();
    }

    function popupImagesFromConfig(popup) {
        if (!popup) return [];
        if (Array.isArray(popup.images) && popup.images.length) {
            return popup.images.filter(function (i) {
                return i && i.imagePath;
            });
        }
        if (popup.imagePath) return [{ imagePath: popup.imagePath }];
        return [];
    }

    function showPopup(popup, carouselMs) {
        if (!popup || !popup.enabled) return;
        var modal = document.getElementById('site-announce-popup');
        if (!modal) return;

        var images = popupImagesFromConfig(popup);
        if (!images.length && !popup.heading && !popup.body) return;

        var mode = popup.showMode || 'once_session';
        var key = 'vgmf_popup_seen';
        if (mode === 'once_session' && sessionStorage.getItem(key) === '1') return;

        var body = document.getElementById('sap-body');
        var imgEl = document.getElementById('sap-image');
        var titleEl = document.getElementById('sap-heading');
        var ctaEl = document.getElementById('sap-cta');
        var prevBtn = modal.querySelector('.sap-slide-prev');
        var nextBtn = modal.querySelector('.sap-slide-next');
        var dotsRoot = document.getElementById('sap-slide-dots');
        var imageWrap = document.getElementById('sap-image-wrap');

        if (titleEl) titleEl.textContent = popup.heading || 'Announcement';
        if (body) body.textContent = popup.body || '';
        if (ctaEl) {
            if (popup.ctaText && popup.ctaUrl) {
                ctaEl.href = popup.ctaUrl;
                ctaEl.textContent = popup.ctaText;
                ctaEl.classList.remove('hidden');
            } else {
                ctaEl.classList.add('hidden');
            }
        }

        popupSlideIndex = 0;
        if (popupSlideTimer) clearInterval(popupSlideTimer);

        function renderPopupSlide(idx) {
            if (!images.length || !imgEl) return;
            popupSlideIndex = (idx + images.length) % images.length;
            var slide = images[popupSlideIndex];
            imgEl.src = imgUrl(slide.imagePath);
            imgEl.classList.remove('hidden');
            if (dotsRoot) {
                dotsRoot.querySelectorAll('.sap-dot').forEach(function (d, i) {
                    d.classList.toggle('is-active', i === popupSlideIndex);
                });
            }
        }

        if (imgEl) {
            if (images.length) {
                renderPopupSlide(0);
                if (imageWrap) imageWrap.classList.remove('hidden');
            } else {
                imgEl.removeAttribute('src');
                imgEl.classList.add('hidden');
                if (imageWrap) imageWrap.classList.add('hidden');
            }
        }

        var showNav = images.length > 1;
        if (prevBtn) prevBtn.classList.toggle('hidden', !showNav);
        if (nextBtn) nextBtn.classList.toggle('hidden', !showNav);

        if (dotsRoot) {
            if (showNav) {
                dotsRoot.innerHTML = images
                    .map(function (_, i) {
                        return (
                            '<button type="button" class="sap-dot' +
                            (i === 0 ? ' is-active' : '') +
                            '" data-go="' +
                            i +
                            '" aria-label="Image ' +
                            (i + 1) +
                            '"></button>'
                        );
                    })
                    .join('');
                dotsRoot.classList.remove('hidden');
                dotsRoot.querySelectorAll('.sap-dot').forEach(function (d) {
                    d.addEventListener('click', function () {
                        renderPopupSlide(parseInt(d.getAttribute('data-go'), 10));
                        restartPopupTimer();
                    });
                });
            } else {
                dotsRoot.innerHTML = '';
                dotsRoot.classList.add('hidden');
            }
        }

        function restartPopupTimer() {
            if (popupSlideTimer) clearInterval(popupSlideTimer);
            if (images.length > 1) {
                var ms = Math.max(
                    3000,
                    parseInt(popup.autoSlideMs, 10) || parseInt(carouselMs, 10) || 5500
                );
                popupSlideTimer = setInterval(function () {
                    renderPopupSlide(popupSlideIndex + 1);
                }, ms);
            }
        }

        if (prevBtn) {
            prevBtn.onclick = function () {
                renderPopupSlide(popupSlideIndex - 1);
                restartPopupTimer();
            };
        }
        if (nextBtn) {
            nextBtn.onclick = function () {
                renderPopupSlide(popupSlideIndex + 1);
                restartPopupTimer();
            };
        }
        restartPopupTimer();

        function open() {
            modal.classList.add('is-open');
            modal.setAttribute('aria-hidden', 'false');
            if (mode === 'once_session') sessionStorage.setItem(key, '1');
        }

        function closePopup() {
            modal.classList.remove('is-open');
            modal.setAttribute('aria-hidden', 'true');
            if (popupSlideTimer) clearInterval(popupSlideTimer);
        }

        setTimeout(open, Math.max(0, parseInt(popup.delaySeconds, 10) || 0) * 1000);

        modal.querySelector('.sap-close')?.addEventListener('click', closePopup);
        modal.querySelector('.sap-backdrop')?.addEventListener('click', function (e) {
            if (e.target.classList.contains('sap-backdrop')) closePopup();
        });
    }

    window.loadSiteMarketing = async function loadSiteMarketing() {
        try {
            var res = await fetch('/api/public/marketing');
            var data = await res.json();
            if (!res.ok) return;
            renderCarousel(data.banners || [], (data.carousel || {}).autoSlideMs);
            showPopup(data.popup || {}, (data.carousel || {}).autoSlideMs);
        } catch (e) {
            console.warn('[marketing]', e);
        }
    };

    document.addEventListener('DOMContentLoaded', function () {
        window.loadSiteMarketing();
    });
})();
