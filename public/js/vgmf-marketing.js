/**
 * DB-driven homepage hero carousel + promotional lightbox popup.
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
        let p = String(path).trim();
        if (!p) return '';
        if (/^https?:\/\//i.test(p)) return p;
        if (p.startsWith('/uploads/api/assets/')) {
            p = '/api/assets/' + p.slice('/uploads/api/assets/'.length);
        } else if (p.startsWith('uploads/api/assets/')) {
            p = '/api/assets/' + p.slice('uploads/api/assets/'.length);
        } else if (/^(upload_asset_|cert_|file_)/i.test(p)) {
            p = '/api/assets/' + encodeURIComponent(p);
        } else if (p.startsWith('api/assets/')) {
            p = '/' + p;
        }
        if (p.startsWith('/')) return p;
        return '/uploads/' + p;
    }

    let carouselTimer = null;
    let carouselIndex = 0;
    let popupSlideTimer = null;
    let popupSlideIndex = 0;
    const POPUP_SEEN_KEY = 'vgmf_popup_seen';

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

    function popupSlidesFromConfig(popup) {
        if (!popup) return [];
        if (Array.isArray(popup.images) && popup.images.length) {
            return popup.images.filter(function (sl) {
                return sl && (sl.imagePath || sl.heading || sl.body);
            });
        }
        if (popup.imagePath || popup.heading || popup.body) {
            return [
                {
                    imagePath: popup.imagePath || '',
                    heading: popup.heading || '',
                    body: popup.body || '',
                    ctaText: popup.ctaText || '',
                    ctaUrl: popup.ctaUrl || '',
                    cta2Text: popup.cta2Text || '',
                    cta2Url: popup.cta2Url || ''
                }
            ];
        }
        return [];
    }

    function popupImagesFromConfig(popup) {
        return popupSlidesFromConfig(popup).filter(function (sl) {
            return sl && sl.imagePath;
        });
    }

    function lightboxToPopupClient(lb) {
        if (!lb || typeof lb !== 'object' || lb.enabled === false) return null;
        const slides = Array.isArray(lb.slides)
            ? lb.slides.filter(function (sl) {
                  return sl && (sl.imagePath || sl.heading || sl.body);
              })
            : [];
        if (!slides.length) return null;
        return {
            enabled: true,
            showMode: lb.showMode || 'once_session',
            delaySeconds: lb.delaySeconds || 0,
            autoSlideMs: lb.autoSlideMs || 5500,
            images: slides
        };
    }

    function popupFromCms(cms) {
        if (!cms || typeof cms !== 'object') return null;
        if (cms.lightbox) return lightboxToPopupClient(cms.lightbox);
        const banner = cms.bannerImage ? String(cms.bannerImage).trim() : '';
        if (!banner) return null;
        return lightboxToPopupClient({
            enabled: true,
            showMode: 'once_session',
            delaySeconds: 0,
            slides: [{ imagePath: banner }]
        });
    }

    function slideCopy(slide, popup) {
        slide = slide || {};
        popup = popup || {};
        return {
            heading: String(slide.heading || popup.heading || '').trim(),
            body: String(slide.body || popup.body || '').trim(),
            ctaText: String(slide.ctaText || popup.ctaText || '').trim(),
            ctaUrl: String(slide.ctaUrl || popup.ctaUrl || '').trim(),
            cta2Text: String(slide.cta2Text || popup.cta2Text || '').trim(),
            cta2Url: String(slide.cta2Url || popup.cta2Url || '').trim()
        };
    }

    function bindPopupCta(el, text, url) {
        if (!el) return;
        if (text && url) {
            el.href = url;
            el.textContent = text;
            el.classList.remove('hidden');
            if (url === '#register' || url === '/doctor') {
                el.onclick = function (e) {
                    e.preventDefault();
                    if (typeof openRegisterModal === 'function') openRegisterModal();
                    return false;
                };
            } else {
                el.onclick = null;
            }
        } else {
            el.classList.add('hidden');
            el.onclick = null;
        }
    }

    function resolvePopupConfig(marketingPopup, cms) {
        const mkt = marketingPopup || {};
        const mktSlides = popupSlidesFromConfig(mkt);
        if (mkt.enabled && mktSlides.length) return mkt;
        return popupFromCms(cms);
    }

    function showPopup(popup, carouselMs) {
        if (!popup || !popup.enabled) return false;
        var modal = document.getElementById('site-announce-popup');
        if (!modal) return false;

        var slides = popupSlidesFromConfig(popup);
        if (!slides.length) return false;

        var mode = popup.showMode || 'once_session';
        if (mode === 'once_session' && sessionStorage.getItem(POPUP_SEEN_KEY) === '1') return false;

        var body = document.getElementById('sap-body');
        var imgEl = document.getElementById('sap-image');
        var titleEl = document.getElementById('sap-heading');
        var ctaEl = document.getElementById('sap-cta');
        var cta2El = document.getElementById('sap-cta-secondary');
        var prevBtn = modal.querySelector('.sap-slide-prev');
        var nextBtn = modal.querySelector('.sap-slide-next');
        var dotsRoot = document.getElementById('sap-slide-dots');
        var imageWrap = document.getElementById('sap-image-wrap');
        var bodyWrap = modal.querySelector('.sap-body-wrap');
        var panel = modal.querySelector('.sap-panel');

        popupSlideIndex = 0;
        if (popupSlideTimer) clearInterval(popupSlideTimer);

        function applySlideVisual(slide) {
            var copy = slideCopy(slide, popup);
            var hasImage = !!(slide && slide.imagePath);
            var imageOnly =
                hasImage && !copy.heading && !copy.body && !copy.ctaText && !copy.cta2Text;

            if (panel) panel.classList.toggle('sap-panel--image-only', imageOnly);
            if (bodyWrap) bodyWrap.classList.toggle('hidden', imageOnly);

            if (titleEl) {
                if (imageOnly || !copy.heading) {
                    titleEl.textContent = '';
                    titleEl.classList.add('hidden');
                } else {
                    titleEl.textContent = copy.heading;
                    titleEl.classList.remove('hidden');
                }
            }
            if (body) {
                body.textContent = copy.body || '';
                body.classList.toggle('hidden', imageOnly || !copy.body);
            }
            bindPopupCta(ctaEl, copy.ctaText, copy.ctaUrl || (copy.ctaText ? '#' : ''));
            bindPopupCta(cta2El, copy.cta2Text, copy.cta2Url || (copy.cta2Text ? '#' : ''));

            if (imgEl && imageWrap) {
                if (hasImage) {
                    imgEl.src = imgUrl(slide.imagePath);
                    imgEl.alt = copy.heading || 'Seminar announcement';
                    imgEl.classList.remove('hidden');
                    imageWrap.classList.remove('hidden');
                } else {
                    imgEl.removeAttribute('src');
                    imgEl.classList.add('hidden');
                    imageWrap.classList.add('hidden');
                }
            }
        }

        function renderPopupSlide(idx) {
            popupSlideIndex = (idx + slides.length) % slides.length;
            applySlideVisual(slides[popupSlideIndex]);
            if (dotsRoot) {
                dotsRoot.querySelectorAll('.sap-dot').forEach(function (d, i) {
                    d.classList.toggle('is-active', i === popupSlideIndex);
                });
            }
        }

        renderPopupSlide(0);

        var showNav = slides.length > 1;
        if (prevBtn) prevBtn.classList.toggle('hidden', !showNav);
        if (nextBtn) nextBtn.classList.toggle('hidden', !showNav);

        if (dotsRoot) {
            if (showNav) {
                dotsRoot.innerHTML = slides
                    .map(function (_, i) {
                        return (
                            '<button type="button" class="sap-dot' +
                            (i === 0 ? ' is-active' : '') +
                            '" data-go="' +
                            i +
                            '" aria-label="Slide ' +
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
            if (slides.length > 1) {
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

        function closePopup() {
            modal.classList.remove('is-open');
            modal.setAttribute('aria-hidden', 'true');
            if (popupSlideTimer) clearInterval(popupSlideTimer);
        }

        function open() {
            modal.classList.add('is-open');
            modal.setAttribute('aria-hidden', 'false');
            if (mode === 'once_session') sessionStorage.setItem(POPUP_SEEN_KEY, '1');
        }

        setTimeout(open, Math.max(0, parseInt(popup.delaySeconds, 10) || 0) * 1000);

        if (modal.dataset.popupBound !== '1') {
            modal.dataset.popupBound = '1';
            modal.querySelector('.sap-close')?.addEventListener('click', closePopup);
            modal.querySelector('.sap-backdrop')?.addEventListener('click', function (e) {
                if (e.target.classList.contains('sap-backdrop')) closePopup();
            });
            document.addEventListener('keydown', function (e) {
                if (e.key === 'Escape' && modal.classList.contains('is-open')) closePopup();
            });
        }

        return true;
    }

    function tryShowSitePopup(cms, marketingMeta) {
        const meta = marketingMeta || window.__siteMarketing || {};
        const resolved = resolvePopupConfig(meta.popup, cms);
        if (!resolved) return false;
        return showPopup(resolved, (meta.carousel || {}).autoSlideMs);
    }

    window.loadSiteMarketing = async function loadSiteMarketing() {
        try {
            var res = await fetch('/api/public/marketing', { cache: 'no-store' });
            var data = await res.json();
            if (!res.ok) return;
            window.__siteMarketing = data;
            renderCarousel(data.banners || [], (data.carousel || {}).autoSlideMs);
            tryShowSitePopup(window.__siteCms || null, data);
        } catch (e) {
            console.warn('[marketing]', e);
        }
    };

    window.VgmfMarketing = {
        imgUrl,
        showPopup,
        tryShowSitePopup,
        popupFromCms,
        resolvePopupConfig
    };

    document.addEventListener('DOMContentLoaded', function () {
        window.loadSiteMarketing();
    });
})();
