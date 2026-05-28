/**
 * VGMF Book Tracking UI — 4-stage shipment rail + staged updates + doctor/public views.
 */
(function (global) {
    'use strict';

    const STAGE_ORDER = ['ordered', 'shipped', 'out_for_delivery', 'delivered'];
    const STAGE_LABEL = {
        ordered: 'Ordered',
        shipped: 'Shipped',
        out_for_delivery: 'Out for Delivery',
        delivered: 'Delivered',
        cancelled: 'Cancelled'
    };

    function esc(s) {
        return String(s || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function fmtWhen(iso) {
        if (!iso) return '';
        if (global.PortalDateTime && global.PortalDateTime.format) return global.PortalDateTime.format(iso);
        try {
            return new Date(iso).toLocaleString('en-IN', {
                timeZone: 'Asia/Kolkata',
                day: '2-digit',
                month: 'short',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });
        } catch (_) {
            return String(iso);
        }
    }

    function formatPlace(ev) {
        const city = String(ev.city || '').trim();
        const state = String(ev.state || '').trim();
        const country = String(ev.country || '').trim() || 'India';
        const parts = [];
        if (city) parts.push(city);
        if (state) parts.push(state);
        if (country && country !== 'India') parts.push(country);
        else if (!city && !state) parts.push(country);
        return parts.join(', ');
    }

    function sortEventsChrono(events) {
        return (events || []).slice().sort(function (a, b) {
            const ta = a.at ? new Date(a.at).getTime() : 0;
            const tb = b.at ? new Date(b.at).getTime() : 0;
            if (!ta && !tb) return 0;
            if (!ta) return -1;
            if (!tb) return 1;
            return ta - tb;
        });
    }

    function hasFourStageMilestones(journey) {
        return !!(journey && journey.milestones && journey.milestones.length === 4);
    }

    function renderStageRail(journey) {
        if (!hasFourStageMilestones(journey)) return '';
        const pct = Math.min(100, Math.max(0, journey.progressPercent || 0));
        const live = journey.isLive && !journey.shipmentCancelled;
        const cancelled = journey.shipmentCancelled || journey.headline === 'Shipment cancelled';

        let html =
            '<div class="pkg-stage-rail' +
            (cancelled ? ' cancelled' : '') +
            (live ? ' live' : '') +
            '">' +
            '<div class="pkg-stage-track"><div class="pkg-stage-fill" style="width:' +
            pct +
            '%" data-pkg-progress="' +
            pct +
            '"></div></div><div class="pkg-milestones">';

        journey.milestones.forEach(function (ms) {
            const cls =
                ms.state === 'completed'
                    ? 'pkg-ms done'
                    : ms.state === 'active'
                      ? 'pkg-ms active'
                      : ms.state === 'cancelled'
                        ? 'pkg-ms cancelled'
                        : 'pkg-ms';
            const icon =
                ms.state === 'completed'
                    ? '<i class="fas fa-check"></i>'
                    : ms.state === 'cancelled'
                      ? '<i class="fas fa-ban"></i>'
                      : '<i class="fas ' + esc(ms.icon || 'fa-circle') + '"></i>';
            html +=
                '<div class="' +
                cls +
                '" data-stage="' +
                esc(ms.key) +
                '"><div class="pkg-ms-icon">' +
                icon +
                '</div><div class="pkg-ms-label">' +
                esc(ms.title) +
                '</div></div>';
        });
        html += '</div>';

        if (journey.scheduleHint) {
            html += '<p class="pkg-stage-schedule"><i class="fas fa-calendar-check"></i> ' + esc(journey.scheduleHint) + '</p>';
        }
        html += '</div>';
        return html;
    }

    function timelineFromJourney(journey, events) {
        if (journey && journey.updateTimeline && journey.updateTimeline.length) {
            return journey.updateTimeline.slice();
        }
        const rows = [];
        sortEventsChrono(events).forEach(function (ev) {
            rows.push({
                at: ev.at,
                title: ev.description || 'Update',
                subtitle: formatPlace(ev) || ev.location || '',
                stage: 'shipped',
                source: 'courier'
            });
        });
        return rows;
    }

    function renderStagedUpdates(journey, events, opts) {
        opts = opts || {};
        const timeline = sortEventsChrono(timelineFromJourney(journey, events));
        if (!timeline.length) {
            return (
                '<div class="pkg-scan-empty">' +
                (opts.emptyMessage || 'Updates will appear here as your parcel moves.') +
                '</div>'
            );
        }

        const groups = { ordered: [], shipped: [], out_for_delivery: [], delivered: [], cancelled: [] };
        timeline.forEach(function (row) {
            const key = groups[row.stage] ? row.stage : 'shipped';
            groups[key].push(row);
        });

        let html = '<div class="pkg-staged-updates">';
        const stages = journey && journey.shipmentCancelled ? STAGE_ORDER.concat(['cancelled']) : STAGE_ORDER;

        stages.forEach(function (stageKey) {
            const items = stageKey === 'cancelled' ? groups.cancelled : groups[stageKey];
            if (!items || !items.length) return;
            const stageTitle = STAGE_LABEL[stageKey] || stageKey;
            html += '<section class="pkg-stage-block" data-stage-block="' + esc(stageKey) + '">';
            html += '<h3 class="pkg-stage-block-title">' + esc(stageTitle) + '</h3>';
            html += '<ol class="pkg-scan-timeline">';
            items.forEach(function (row, idx) {
                const isLatest = idx === items.length - 1 && journey && journey.isLive && !journey.shipmentCancelled;
                const cls = isLatest ? 'pkg-scan-item current' : 'pkg-scan-item done';
                html +=
                    '<li class="' +
                    cls +
                    '"><span class="pkg-scan-dot" aria-hidden="true"></span><div class="pkg-scan-card">' +
                    '<p class="pkg-scan-status">' +
                    esc(row.title) +
                    '</p>';
                if (row.at) {
                    html += '<p class="pkg-scan-datetime"><i class="fas fa-clock"></i> ' + esc(fmtWhen(row.at)) + '</p>';
                }
                if (row.subtitle) {
                    html += '<p class="pkg-scan-place"><i class="fas fa-map-marker-alt"></i> ' + esc(row.subtitle) + '</p>';
                }
                if (row.facility) {
                    html +=
                        '<span class="pkg-scan-facility"><i class="fas fa-warehouse"></i> ' + esc(row.facility) + '</span>';
                }
                html += '</div></li>';
            });
            html += '</ol></section>';
        });
        html += '</div>';
        return html;
    }

    /* ----- Vertical journey (pickup / legacy) ----- */
    function renderVerticalJourney(journey, events, opts) {
        if (!journey || !journey.steps || !journey.steps.length) return '';
        if (hasFourStageMilestones(journey)) {
            return renderShipmentStageTracker(journey, events, opts);
        }
        opts = opts || {};
        const isCourier = journey.integration !== 'pickup';
        const evList = Array.isArray(events) ? events : [];
        const embedEvents = opts.embedCourierEvents === true && isCourier && evList.length;

        const liveHtml = journey.isLive
            ? '<span class="vtrk-live"><span class="vtrk-dot"></span>Live tracking</span>'
            : '';

        const progressPct = Math.min(100, Math.max(0, journey.progressPercent || 0));
        const statusClass =
            journey.headline === 'Delivered'
                ? 'vtrk-header delivered'
                : journey.headline === 'Shipment cancelled' || journey.shipmentCancelled
                  ? 'vtrk-header cancelled'
                  : journey.isLive
                    ? 'vtrk-header live'
                    : 'vtrk-header';

        let headerHtml =
            '<div class="' +
            statusClass +
            '">' +
            liveHtml +
            '<div class="vtrk-headline">' +
            esc(journey.headline) +
            '</div>' +
            '<div class="vtrk-subheadline">' +
            esc(journey.subheadline) +
            '</div>';

        if (journey.awb || journey.providerLabel) {
            headerHtml += '<div class="vtrk-awb-row">';
            if (journey.awb) {
                headerHtml +=
                    '<span class="vtrk-awb-badge"><i class="fas fa-barcode"></i> AWB: <strong>' + esc(journey.awb) + '</strong></span>';
            }
            if (journey.providerLabel) {
                headerHtml += '<span class="vtrk-provider-badge"><i class="fas fa-truck"></i> ' + esc(journey.providerLabel) + '</span>';
            }
            headerHtml += '</div>';
        }

        headerHtml +=
            '<div class="vtrk-progress-wrap"><div class="vtrk-progress-bar" style="width:' + progressPct + '%"></div></div></div>';

        let stepsHtml = '<div class="vtrk-steps">';
        journey.steps.forEach(function (step, idx) {
            const isLast = idx === journey.steps.length - 1;
            const cls =
                step.state === 'completed' ? 'vtrk-step done' : step.state === 'active' ? 'vtrk-step active' : 'vtrk-step upcoming';
            const whenHtml =
                step.at && step.state !== 'upcoming'
                    ? '<span class="vtrk-step-when"><i class="fas fa-clock"></i> ' + esc(fmtWhen(step.at)) + '</span>'
                    : '';
            const subtitleHtml = step.subtitle ? '<div class="vtrk-step-sub">' + esc(step.subtitle) + '</div>' : '';
            const iconHtml =
                step.state === 'completed'
                    ? '<i class="fas fa-check"></i>'
                    : '<i class="fas ' + esc(step.icon || 'fa-circle') + '"></i>';

            stepsHtml +=
                '<div class="' +
                cls +
                '"><div class="vtrk-step-left"><div class="vtrk-step-circle">' +
                iconHtml +
                '</div>' +
                (isLast ? '' : '<div class="vtrk-step-line"></div>') +
                '</div><div class="vtrk-step-body"><div class="vtrk-step-title">' +
                esc(step.title) +
                '</div>' +
                subtitleHtml +
                whenHtml +
                '</div></div>';
        });
        stepsHtml += '</div>';

        let eventsHtml = '';
        if (embedEvents) {
            const chrono = sortEventsChrono(evList);
            eventsHtml =
                '<div class="vtrk-events"><div class="vtrk-events-title"><i class="fas fa-map-marker-alt"></i> Courier scan history (' +
                chrono.length +
                ')</div><ul class="vtrk-events-scroll" data-vtrk-scroll="1">';
            chrono.slice(-15).forEach(function (ev, idx) {
                const isLatest = idx === chrono.slice(-15).length - 1 && journey.isLive;
                eventsHtml +=
                    '<li class="' +
                    (isLatest ? 'vtrk-ev-latest' : '') +
                    '"><span class="vtrk-ev-desc">' +
                    esc(ev.description) +
                    '</span>' +
                    (ev.location ? '<span class="vtrk-ev-loc"><i class="fas fa-map-pin"></i> ' + esc(ev.location) + '</span>' : '') +
                    (ev.at ? '<span class="vtrk-ev-when">' + esc(fmtWhen(ev.at)) + '</span>' : '') +
                    '</li>';
            });
            eventsHtml += '</ul></div>';
        }

        return headerHtml + stepsHtml + eventsHtml;
    }

    function renderScanTimeline(events, opts) {
        opts = opts || {};
        const chrono = sortEventsChrono(events);
        if (!chrono.length) {
            return '<div class="pkg-scan-empty">' + (opts.emptyMessage || 'Courier scans will appear after pickup.') + '</div>';
        }
        let html = '<ol class="pkg-scan-timeline">';
        chrono.forEach(function (ev, idx) {
            const isLatest = idx === chrono.length - 1;
            const cls = isLatest && opts.highlightLatest !== false ? 'pkg-scan-item current' : 'pkg-scan-item done';
            const place = formatPlace(ev);
            html +=
                '<li class="' +
                cls +
                '"><span class="pkg-scan-dot"></span><div class="pkg-scan-card"><p class="pkg-scan-status">' +
                esc(String(ev.description || 'Update').trim()) +
                '</p>' +
                (ev.at ? '<p class="pkg-scan-datetime"><i class="fas fa-clock"></i> ' + esc(fmtWhen(ev.at)) + '</p>' : '') +
                (place ? '<p class="pkg-scan-place"><i class="fas fa-map-marker-alt"></i> ' + esc(place) + '</p>' : '') +
                '</div></li>';
        });
        html += '</ol>';
        return html;
    }

    function renderShipmentUpdates(events, opts) {
        opts = opts || {};
        const evList = Array.isArray(events) ? events : [];
        if (!evList.length && !opts.showWhenEmpty) return '';
        return (
            '<div class="pkg-shipment-block" style="margin-top:12px;border-top:1px solid #e2e8f0;padding-top:12px;">' +
            '<p class="pkg-shipment-title"><i class="fas fa-route"></i> All updates</p>' +
            renderScanTimeline(evList, opts) +
            '</div>'
        );
    }

    function orderHasBookedShipment(order) {
        if (!order) return false;
        return !!(
            order.courierTrackingNo ||
            order.status === 'shipped' ||
            order.status === 'delivered' ||
            order.courierShipmentStatus === 'shipped' ||
            order.courierDispatchedAt
        );
    }

    function renderShipmentStageTracker(journey, events, opts) {
        if (!journey) return '';
        opts = opts || {};
        const cancelled = journey.shipmentCancelled || journey.headline === 'Shipment cancelled';
        const heroCls =
            journey.headline === 'Delivered'
                ? 'pkg-track-hero delivered'
                : cancelled
                  ? 'pkg-track-hero cancelled'
                  : 'pkg-track-hero';

        let html = '<div class="pkg-track"><div class="' + heroCls + '">';
        if (journey.isLive && !cancelled) {
            html += '<div class="pkg-track-live"><span class="pkg-track-live-dot"></span>Live tracking</div>';
        } else if (cancelled) {
            html += '<div class="pkg-track-live" style="background:rgba(0,0,0,0.15);"><i class="fas fa-ban"></i> Shipment cancelled</div>';
        }
        html +=
            '<div class="pkg-track-headline">' +
            esc(journey.headline) +
            '</div><div class="pkg-track-sub">' +
            esc(journey.subheadline) +
            '</div><div class="pkg-track-meta">';
        if (journey.awb) html += '<span class="pkg-track-badge"><i class="fas fa-barcode"></i> AWB ' + esc(journey.awb) + '</span>';
        if (journey.providerLabel) {
            html += '<span class="pkg-track-badge"><i class="fas fa-truck"></i> ' + esc(journey.providerLabel) + '</span>';
        }
        if (opts.destination) {
            html += '<span class="pkg-track-badge"><i class="fas fa-location-dot"></i> To ' + esc(opts.destination) + '</span>';
        }
        html += '</div></div><div class="pkg-track-body">';
        html += renderStageRail(journey);
        html +=
            '<div class="pkg-shipment-block"><p class="pkg-shipment-title"><i class="fas fa-list-check"></i> All updates</p>';
        html += renderStagedUpdates(journey, events, {
            highlightLatest: journey.isLive && !cancelled,
            emptyMessage: cancelled
                ? 'No courier movement after cancellation.'
                : 'Waiting for courier scans…'
        });
        html += '</div></div></div>';
        return html;
    }

    function renderDoctorFullTracking(journey, order, events) {
        const o = order || {};
        const evList = Array.isArray(events) ? events : o.courierTrackEvents || [];
        if (hasFourStageMilestones(journey)) {
            return renderShipmentStageTracker(journey, evList, {});
        }
        let html = renderVerticalJourney(journey, [], { embedCourierEvents: false });
        if (orderHasBookedShipment(o)) {
            html += renderShipmentUpdates(evList, {
                highlightLatest: journey && journey.isLive,
                showWhenEmpty: true,
                emptyMessage: 'Waiting for first courier scan…'
            });
        }
        return html;
    }

    function renderPackageTracker(journey, events, opts) {
        return renderShipmentStageTracker(journey, events, opts || {});
    }

    function renderAmazonPackageTracker(journey, events, opts) {
        return renderPackageTracker(journey, events, opts);
    }

    function renderHorizontalStepper(journey) {
        if (hasFourStageMilestones(journey)) return renderStageRail(journey);
        if (!journey || !journey.steps || !journey.steps.length) return '';
        const progressPct = Math.min(100, Math.max(0, journey.progressPercent || 0));
        let html = '<div class="htrk"><div class="htrk-progress"><div class="htrk-progress-fill" style="width:' + progressPct + '%"></div></div><div class="htrk-steps">';
        journey.steps.forEach(function (step) {
            const cls =
                step.state === 'completed' ? 'htrk-step done' : step.state === 'active' ? 'htrk-step active' : 'htrk-step';
            html +=
                '<div class="' +
                cls +
                '"><div class="htrk-icon"><i class="fas ' +
                esc(step.icon || 'fa-circle') +
                '"></i></div><div class="htrk-label">' +
                esc(step.title) +
                '</div></div>';
        });
        return html + '</div></div>';
    }

    function animateProgressFill(root) {
        if (!root) return;
        const fill = root.querySelector('.pkg-stage-fill');
        if (!fill) return;
        const target = parseInt(fill.getAttribute('data-pkg-progress') || '0', 10) || 0;
        fill.style.width = '0%';
        requestAnimationFrame(function () {
            fill.style.width = Math.min(100, target) + '%';
        });
    }

    global.BookTrackingUI = {
        esc,
        fmtWhen,
        renderVerticalJourney,
        renderStageRail,
        renderStagedUpdates,
        renderShipmentStageTracker,
        renderShipmentUpdates,
        renderDoctorFullTracking,
        renderScanTimeline,
        renderPackageTracker,
        renderAmazonPackageTracker,
        renderHorizontalStepper,
        orderHasBookedShipment,
        animateProgressFill
    };
})(typeof window !== 'undefined' ? window : global);
