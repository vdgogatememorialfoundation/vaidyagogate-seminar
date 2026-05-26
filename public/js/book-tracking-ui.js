/**
 * VGMF Book Tracking UI — Amazon-style vertical timeline.
 * Used by both doctor portal and admin tracking modal.
 */
(function (global) {
    'use strict';

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
                day: '2-digit', month: 'short', year: 'numeric',
                hour: '2-digit', minute: '2-digit'
            });
        } catch (_) { return String(iso); }
    }

    function fmtDate(iso) {
        if (!iso) return '';
        try {
            return new Date(iso).toLocaleDateString('en-IN', {
                timeZone: 'Asia/Kolkata',
                day: '2-digit', month: 'short', year: 'numeric'
            });
        } catch (_) { return String(iso); }
    }

    /* ------------------------------------------------------------------ */
    /*  VERTICAL timeline (doctor portal — primary view)                   */
    /* ------------------------------------------------------------------ */
    function renderVerticalJourney(journey, events, opts) {
        if (!journey || !journey.steps || !journey.steps.length) return '';
        opts = opts || {};
        const isCourier = journey.integration !== 'pickup';
        const evList = Array.isArray(events) ? events : [];

        // Header card
        const liveHtml = journey.isLive
            ? '<span class="vtrk-live"><span class="vtrk-dot"></span>Live tracking</span>'
            : '';

        const progressPct = Math.min(100, Math.max(0, journey.progressPercent || 0));
        const statusClass = journey.headline === 'Delivered' ? 'vtrk-header delivered'
            : journey.headline === 'Cancelled' ? 'vtrk-header cancelled'
            : journey.isLive ? 'vtrk-header live'
            : 'vtrk-header';

        let headerHtml =
            '<div class="' + statusClass + '">' +
            liveHtml +
            '<div class="vtrk-headline">' + esc(journey.headline) + '</div>' +
            '<div class="vtrk-subheadline">' + esc(journey.subheadline) + '</div>';

        // AWB + provider row
        if (journey.awb || journey.providerLabel) {
            headerHtml += '<div class="vtrk-awb-row">';
            if (journey.awb) {
                headerHtml += '<span class="vtrk-awb-badge"><i class="fas fa-barcode"></i> AWB: <strong>' + esc(journey.awb) + '</strong></span>';
            }
            if (journey.providerLabel) {
                headerHtml += '<span class="vtrk-provider-badge"><i class="fas fa-truck"></i> ' + esc(journey.providerLabel) + '</span>';
            }
            if (isCourier && (journey.integration === 'shiprocket' || journey.integration === 'nimbuspost')) {
                headerHtml += '<span class="vtrk-agg-badge"><i class="fas fa-bolt"></i> ' +
                    (journey.integration === 'shiprocket' ? 'Shiprocket' : 'Nimbuspost') + '</span>';
            }
            headerHtml += '</div>';
        }

        // Progress bar
        headerHtml +=
            '<div class="vtrk-progress-wrap"><div class="vtrk-progress-bar" style="width:' + progressPct + '%"></div></div>' +
            '</div>'; // close header

        // Vertical steps
        let stepsHtml = '<div class="vtrk-steps">';
        journey.steps.forEach(function (step, idx) {
            const isLast = idx === journey.steps.length - 1;
            const cls =
                step.state === 'completed' ? 'vtrk-step done' :
                step.state === 'active' ? 'vtrk-step active' :
                'vtrk-step upcoming';

            const whenHtml = step.at && step.state !== 'upcoming'
                ? '<span class="vtrk-step-when"><i class="fas fa-clock"></i> ' + esc(fmtWhen(step.at)) + '</span>'
                : '';

            const subtitleHtml = step.subtitle
                ? '<div class="vtrk-step-sub">' + esc(step.subtitle) + '</div>'
                : '';

            const iconHtml =
                step.state === 'completed'
                    ? '<i class="fas fa-check"></i>'
                    : step.state === 'active'
                    ? '<i class="fas ' + esc(step.icon || 'fa-circle') + '"></i>'
                    : '<i class="fas ' + esc(step.icon || 'fa-circle') + '"></i>';

            stepsHtml +=
                '<div class="' + cls + '">' +
                '<div class="vtrk-step-left">' +
                '<div class="vtrk-step-circle">' + iconHtml + '</div>' +
                (isLast ? '' : '<div class="vtrk-step-line"></div>') +
                '</div>' +
                '<div class="vtrk-step-body">' +
                '<div class="vtrk-step-title">' + esc(step.title) + '</div>' +
                subtitleHtml +
                whenHtml +
                '</div>' +
                '</div>';
        });
        stepsHtml += '</div>';

        // Courier scan events
        let eventsHtml = '';
        if (isCourier && evList.length) {
            eventsHtml = '<div class="vtrk-events"><div class="vtrk-events-title"><i class="fas fa-map-marker-alt"></i> Courier scan history (' + evList.length + ')</div><ul>';
            evList.slice(0, 15).forEach(function (ev) {
                eventsHtml +=
                    '<li>' +
                    '<span class="vtrk-ev-desc">' + esc(ev.description) + '</span>' +
                    (ev.location ? '<span class="vtrk-ev-loc"><i class="fas fa-map-pin"></i> ' + esc(ev.location) + '</span>' : '') +
                    (ev.at ? '<span class="vtrk-ev-when">' + esc(fmtWhen(ev.at)) + '</span>' : '') +
                    '</li>';
            });
            eventsHtml += '</ul></div>';
        }

        return headerHtml + stepsHtml + eventsHtml;
    }

    /* ------------------------------------------------------------------ */
    /*  COMPACT horizontal stepper (order list cards)                      */
    /* ------------------------------------------------------------------ */
    function renderHorizontalStepper(journey) {
        if (!journey || !journey.steps || !journey.steps.length) return '';
        const progressPct = Math.min(100, Math.max(0, journey.progressPercent || 0));
        let html = '<div class="htrk">';
        // progress bar above steps
        html += '<div class="htrk-progress"><div class="htrk-progress-fill" style="width:' + progressPct + '%"></div></div>';
        html += '<div class="htrk-steps">';
        journey.steps.forEach(function (step) {
            const cls =
                step.state === 'completed' ? 'htrk-step done' :
                step.state === 'active' ? 'htrk-step active' :
                'htrk-step';
            html +=
                '<div class="' + cls + '">' +
                '<div class="htrk-icon"><i class="fas ' + esc(step.icon || 'fa-circle') + '"></i></div>' +
                '<div class="htrk-label">' + esc(step.title) + '</div>' +
                '</div>';
        });
        html += '</div></div>';
        return html;
    }

    /* ------------------------------------------------------------------ */
    /*  Full render: header + vertical timeline + events                   */
    /* ------------------------------------------------------------------ */
    function renderAmazonPackageTracker(journey, events, opts) {
        return renderVerticalJourney(journey, events, opts);
    }

    global.BookTrackingUI = {
        esc,
        fmtWhen,
        fmtDate,
        renderAmazonPackageTracker,
        renderVerticalJourney,
        renderHorizontalStepper
    };
})(typeof window !== 'undefined' ? window : global);
