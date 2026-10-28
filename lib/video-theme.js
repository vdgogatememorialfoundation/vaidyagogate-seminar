/**
 * Year theme for the seminar video library.
 * When an OpenAI key is configured, the brief is turned into a title, description, and accent colour.
 * Otherwise the same fields are composed from the brief itself and the response says so.
 */
const axios = require('axios');

const ACCENTS = ['#0f766e', '#1d4ed8', '#b45309', '#7c3aed', '#be123c', '#0e7490'];

function hashAccent(text) {
    let h = 0;
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0;
    return ACCENTS[h % ACCENTS.length];
}

function composeTheme(year, brief) {
    const text = String(brief || '').replace(/\s+/g, ' ').trim();
    const sentence = (text.split(/[.\n]/)[0] || '').replace(/^["']|["']$/g, '').trim();
    const titleCore = sentence.slice(0, 90);
    const title = (titleCore ? year + ' — ' + titleCore : 'National Seminar ' + year).slice(0, 200);
    const description = text ? ('This year\u2019s seminar videos follow the theme: ' + text).slice(0, 2000) : '';
    return { title, description, accent: hashAccent(text || String(year)), source: 'composed' };
}

function validAccent(v) {
    return /^#[0-9a-fA-F]{6}$/.test(String(v || '').trim()) ? String(v).trim() : null;
}

async function suggestYearTheme(year, brief) {
    const composed = composeTheme(year, brief);
    const key = String(process.env.OPENAI_API_KEY || process.env.CURSOR_OPENAI_API_KEY || '').trim();
    if (!key || !String(brief || '').trim()) return composed;
    const model = String(process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini').trim();
    try {
        const res = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model,
                temperature: 0.4,
                max_tokens: 400,
                response_format: { type: 'json_object' },
                messages: [
                    {
                        role: 'system',
                        content:
                            'You write a short public theme for a medical seminar video library run by Vaidya Gogate Memorial Foundation. Reply with JSON only: {"title":"","description":"","accent":"#0f766e"}. title under 80 characters, description under 400 characters, accent a hex colour that fits the theme. Do not invent dates, fees, or speakers.'
                    },
                    { role: 'user', content: 'Year: ' + year + '\nTheme brief:\n' + String(brief).slice(0, 2000) }
                ]
            },
            {
                headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
                timeout: 25000
            }
        );
        const raw = res.data && res.data.choices && res.data.choices[0] && res.data.choices[0].message && res.data.choices[0].message.content;
        const parsed = JSON.parse(String(raw || '{}'));
        const title = String(parsed.title || '').trim().slice(0, 200);
        const description = String(parsed.description || '').trim().slice(0, 2000);
        if (!title) return composed;
        return {
            title,
            description: description || composed.description,
            accent: validAccent(parsed.accent) || composed.accent,
            source: 'ai'
        };
    } catch (e) {
        const msg = (e.response && e.response.data && e.response.data.error && e.response.data.error.message) || e.message;
        console.warn('[video-theme]', msg);
        return composed;
    }
}

module.exports = { composeTheme, suggestYearTheme };
