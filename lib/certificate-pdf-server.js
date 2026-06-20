'use strict';

const fs = require('fs');
const path = require('path');

let sharedBrowser = null;
let sharedBrowserUseCount = 0;
const MAX_BROWSER_USES = 12;

function chromeCandidates() {
    const list = [];
    const envPath = String(process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH || '').trim();
    if (envPath) list.push(envPath);
    if (process.platform === 'win32') {
        const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files';
        const pfx = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
        list.push(
            path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(pfx, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
        );
    } else if (process.platform === 'darwin') {
        list.push(
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium'
        );
    } else {
        list.push('/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium');
    }
    return list.filter((p) => p && fs.existsSync(p));
}

async function launchBrowser() {
    const puppeteer = require('puppeteer-core');
    let executablePath = '';
    let args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'];

    try {
        const chromium = require('@sparticuz/chromium');
        executablePath = await chromium.executablePath();
        args = chromium.args;
    } catch (_) {}

    if (!executablePath) {
        const found = chromeCandidates()[0];
        if (found) executablePath = found;
    }

    if (!executablePath) {
        throw new Error('PDF engine unavailable (no Chromium). Set CHROME_PATH on the server.');
    }

    return puppeteer.launch({
        executablePath,
        args,
        headless: true,
        defaultViewport: { width: 1123, height: 794, deviceScaleFactor: 1 }
    });
}

async function getBrowser() {
    if (sharedBrowser && sharedBrowser.isConnected() && sharedBrowserUseCount < MAX_BROWSER_USES) {
        sharedBrowserUseCount += 1;
        return sharedBrowser;
    }
    if (sharedBrowser) {
        try {
            await sharedBrowser.close();
        } catch (_) {}
        sharedBrowser = null;
        sharedBrowserUseCount = 0;
    }
    sharedBrowser = await launchBrowser();
    sharedBrowserUseCount = 1;
    return sharedBrowser;
}

async function releaseBrowser(browser) {
    if (browser !== sharedBrowser) {
        try {
            await browser.close();
        } catch (_) {}
        return;
    }
    if (sharedBrowserUseCount >= MAX_BROWSER_USES) {
        try {
            await sharedBrowser.close();
        } catch (_) {}
        sharedBrowser = null;
        sharedBrowserUseCount = 0;
    }
}

async function htmlToPdfBuffer(html) {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
        await page.setContent(String(html || ''), {
            waitUntil: 'networkidle0',
            timeout: 60000
        });
        try {
            await page.evaluate(() => (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()));
        } catch (_) {}
        await page.emulateMediaType('print');
        const pdf = await page.pdf({
            format: 'A4',
            landscape: true,
            printBackground: true,
            preferCSSPageSize: true,
            margin: { top: 0, right: 0, bottom: 0, left: 0 }
        });
        return Buffer.from(pdf);
    } finally {
        try {
            await page.close();
        } catch (_) {}
        await releaseBrowser(browser);
    }
}

process.on('exit', () => {
    if (sharedBrowser) {
        try {
            sharedBrowser.close();
        } catch (_) {}
    }
});

module.exports = {
    htmlToPdfBuffer
};
