/** Local calendar date YYYY-MM-DD (not UTC). */
function localDateYmd(d) {
    const x = d instanceof Date ? d : new Date();
    const y = x.getFullYear();
    const m = String(x.getMonth() + 1).padStart(2, '0');
    const day = String(x.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/** Compare seminar check-in date string to today in local timezone. */
function isCheckinDateToday(checkinDateStr) {
    if (!checkinDateStr || String(checkinDateStr).trim() === '') return true;
    const expected = String(checkinDateStr).trim().slice(0, 10);
    return expected === localDateYmd();
}

module.exports = { localDateYmd, isCheckinDateToday };
