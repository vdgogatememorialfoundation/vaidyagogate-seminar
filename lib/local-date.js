const DEFAULT_CHECKIN_TZ = process.env.CHECKIN_TIMEZONE || 'Asia/Kolkata';

/** Calendar date YYYY-MM-DD in the given IANA timezone (scanner check-in on Vercel UTC). */
function localDateYmd(d, timeZone) {
    const x = d instanceof Date ? d : new Date();
    const tz = timeZone || DEFAULT_CHECKIN_TZ;
    try {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: tz,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).format(x);
    } catch (_) {
        const y = x.getFullYear();
        const m = String(x.getMonth() + 1).padStart(2, '0');
        const day = String(x.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }
}

/** Compare seminar check-in date string to today in CHECKIN_TIMEZONE (default Asia/Kolkata). */
function isCheckinDateToday(checkinDateStr) {
    if (!checkinDateStr || String(checkinDateStr).trim() === '') return true;
    const expected = String(checkinDateStr).trim().slice(0, 10);
    return expected === localDateYmd();
}

module.exports = { localDateYmd, isCheckinDateToday, DEFAULT_CHECKIN_TZ };
