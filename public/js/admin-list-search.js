/**
 * Shared client-side search for admin list tabs.
 */
(function (global) {
    function query(inputId) {
        return String((document.getElementById(inputId) || {}).value || '')
            .trim()
            .toLowerCase();
    }

    function filter(items, q, blobFn) {
        const list = Array.isArray(items) ? items : [];
        if (!q) return list;
        return list.filter((item) => blobFn(item).includes(q));
    }

    function setCount(countId, q, shown, total, noun) {
        const el = document.getElementById(countId);
        if (!el) return;
        const n = noun || 'items';
        const t = total === 1 ? n.replace(/s$/, '') : n;
        if (q && total !== shown) {
            el.textContent = `${shown} of ${total} ${t}`;
        } else {
            el.textContent = `${total} ${t}`;
        }
    }

    function joinParts(parts) {
        return parts
            .filter((p) => p != null && String(p).trim() !== '')
            .join(' ')
            .toLowerCase();
    }

    global.AdminListSearch = {
        query,
        filter,
        setCount,
        joinParts
    };
})(typeof window !== 'undefined' ? window : global);
