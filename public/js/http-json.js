/**
 * Safe JSON parsing for fetch() responses (avoids uncaught SyntaxError on HTML/error pages).
 */
(function (global) {
    async function readJsonResponse(res) {
        const text = await res.text();
        if (!text || !String(text).trim()) {
            return { data: {}, parseFailed: !res.ok };
        }
        try {
            return { data: JSON.parse(text), parseFailed: false };
        } catch (_) {
            return { data: {}, parseFailed: true };
        }
    }

    function apiErrorMessage(res, data, parseFailed) {
        if (data && data.error) return String(data.error);
        if (parseFailed) {
            return res.status >= 500
                ? 'Server error (unexpected response). Please try again in a moment.'
                : 'Unexpected server response. Please refresh the page and try again.';
        }
        if (res.status === 429) return 'Too many attempts. Please wait and try again.';
        if (res.status >= 500) return 'Server error. Please try again in a moment.';
        if (!res.ok) return 'Request failed. Please check your details and try again.';
        return 'Something went wrong.';
    }

    global.HttpJson = { readJsonResponse, apiErrorMessage };
})(typeof window !== 'undefined' ? window : global);
