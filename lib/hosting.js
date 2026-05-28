/**
 * Production host detection (Render). Vercel paths removed — use long-running Node on Render.
 */
function isRender() {
    return process.env.RENDER === 'true' || !!process.env.RENDER_EXTERNAL_URL;
}

function isProduction() {
    return process.env.NODE_ENV === 'production' || isRender();
}

function platformLabel() {
    if (isRender()) return 'Render';
    return 'Node';
}

function envDashboardHint() {
    return 'Render → your Web Service → Environment → add variables, then redeploy.';
}

module.exports = {
    isRender,
    isProduction,
    platformLabel,
    envDashboardHint
};
