/** DB timestamps from SQLite/Postgres are UTC; display in India (IST). */
(function (global) {
    const PORTAL_DISPLAY_TZ = 'Asia/Kolkata';

    function parsePortalDateTime(iso) {
        if (!iso) return null;
        const s = String(iso).trim();
        if (!s) return null;
        if (/Z$|[+-]\d{2}:?\d{2}$/i.test(s)) return new Date(s);
        const normalized = s.includes('T') ? s : s.replace(' ', 'T');
        return new Date(normalized + 'Z');
    }

    function formatPortalDateTime(iso, opts) {
        const d = parsePortalDateTime(iso);
        if (!d || Number.isNaN(d.getTime())) return iso ? String(iso) : '';
        const base = {
            timeZone: PORTAL_DISPLAY_TZ,
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        };
        return d.toLocaleString('en-IN', Object.assign(base, opts || {}));
    }

    function formatPortalDateTimeLong(iso) {
        const d = parsePortalDateTime(iso);
        if (!d || Number.isNaN(d.getTime())) return iso ? String(iso) : '';
        return d.toLocaleString('en-IN', {
            timeZone: PORTAL_DISPLAY_TZ,
            weekday: 'long',
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        });
    }

    global.PortalDateTime = {
        TZ: PORTAL_DISPLAY_TZ,
        parse: parsePortalDateTime,
        format: formatPortalDateTime,
        formatLong: formatPortalDateTimeLong
    };
})(typeof window !== 'undefined' ? window : global);
