/**
 * Deter casual right-click, view-source shortcuts, and save on public portals.
 * Not a security boundary — determined users can still access assets.
 */
(function () {
    function isFormField(el) {
        if (!el || !el.closest) return false;
        return !!el.closest('input, textarea, select, [contenteditable="true"], label');
    }

    function block(e) {
        if (isFormField(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        return false;
    }

    document.addEventListener('contextmenu', block, { capture: true });

    document.addEventListener(
        'keydown',
        function (e) {
            const key = (e.key || '').toLowerCase();
            const ctrl = e.ctrlKey || e.metaKey;
            const shift = e.shiftKey;
            if (key === 'f12') return block(e);
            if (ctrl && shift && (key === 'i' || key === 'j' || key === 'c')) return block(e);
            if (ctrl && (key === 'u' || key === 's' || key === 'p')) return block(e);
        },
        { capture: true }
    );

    document.addEventListener('dragstart', block, { capture: true });
})();
