/**
 * Optional OpenAI-backed replies for the public support chatbot.
 * Falls back to rule-based answers when no API key is configured.
 */
const axios = require('axios');

function getApiKey() {
    return (
        String(process.env.OPENAI_API_KEY || process.env.CURSOR_OPENAI_API_KEY || '').trim() ||
        null
    );
}

async function generateAiReply(message, knowledge, userContext) {
    const apiKey = getApiKey();
    if (!apiKey) return null;
    const model = String(process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini').trim();
    const system = [
        'You are the helpful assistant for Vaidya Gogate Memorial Foundation (VGMF) seminar portal.',
        'Answer concisely in plain English. Cover: seminar registration, applications, payments (Razorpay/Cashfree/Juspay),',
        'e-tickets, venue check-in, certificates, case presentation, books, volunteers, support tickets, and live chat.',
        'If unsure, direct users to sign in at the doctor portal or open a support ticket.',
        'Never invent fees, dates, or policies not in the knowledge base.',
        '',
        'Knowledge base:',
        String(knowledge || '').slice(0, 12000)
    ].join('\n');
    let userBlock = String(message || '').trim();
    if (userContext && userContext.track && !userContext.track.error) {
        userBlock += '\n\n[User tracking context: ' + JSON.stringify(userContext.track).slice(0, 800) + ']';
    }
    try {
        const res = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model,
                temperature: 0.35,
                max_tokens: 520,
                messages: [
                    { role: 'system', content: system },
                    { role: 'user', content: userBlock }
                ]
            },
            {
                headers: {
                    Authorization: 'Bearer ' + apiKey,
                    'Content-Type': 'application/json'
                },
                timeout: 25000
            }
        );
        const text = res.data && res.data.choices && res.data.choices[0] && res.data.choices[0].message;
        const reply = text && text.content ? String(text.content).trim() : '';
        return reply || null;
    } catch (e) {
        console.warn('[chatbot-ai]', e.response?.data?.error?.message || e.message);
        return null;
    }
}

module.exports = { generateAiReply, getApiKey };
