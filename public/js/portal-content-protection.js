/**
 * Deter casual right-click, view-source shortcuts, and save on public portals.
 * Not a security boundary — determined users can still access assets.
 */
(function () {
    function block(e) {
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
