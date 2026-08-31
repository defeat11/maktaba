const fs = require('fs');
const path = require('path');

let puppeteer;
let isCore = false;
try {
  puppeteer = require('puppeteer');
} catch (err) {
  try {
    puppeteer = require('puppeteer-core');
    isCore = true;
  } catch (e) {
    // Defer error until getBrowser is called
  }
}

function getChromePath() {
  const paths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.USERPROFILE}\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe`
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

let browser = null;

async function getBrowser() {
  if (browser) return browser;
  
  if (!puppeteer) {
    try {
      puppeteer = require('puppeteer');
    } catch (err) {
      try {
        puppeteer = require('puppeteer-core');
        isCore = true;
      } catch (e) {
        throw new Error('Neither puppeteer nor puppeteer-core could be required. Please install puppeteer.');
      }
    }
  }

  const chromePath = getChromePath();
  const launchOptions = {
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  };

  if (isCore && chromePath) {
    launchOptions.executablePath = chromePath;
  }

  try {
    browser = await puppeteer.launch(launchOptions);
  } catch (err) {
    if (!launchOptions.executablePath && chromePath) {
      console.warn('Standard puppeteer launch failed, retrying with local Chrome path:', chromePath);
      launchOptions.executablePath = chromePath;
      browser = await puppeteer.launch(launchOptions);
    } else {
      throw err;
    }
  }
  return browser;
}

/**
 * Captures a screenshot of the specified URL and saves it to outPath.
 * 
 * @param {string} url URL of the page to screenshot
 * @param {string} outPath Output filepath (PNG)
 */
async function capture(url, outPath) {
  const dir = path.dirname(outPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setViewport({ width: 1280, height: 800 });
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
    } catch (gotoErr) {
      console.warn(`Navigation timeout or error for ${url}, capturing whatever is currently loaded:`, gotoErr.message);
    }
    await page.screenshot({ path: outPath, fullPage: true });
  } catch (err) {
    const { logError } = require('./logger');
    logError('screenshot', err);
    throw err;
  } finally {
    await page.close();
  }
}

/**
 * Closes the browser instance if open.
 */
async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

async function inspectPage(url) {
  const b = await getBrowser();
  const page = await b.newPage();
  
  const consoleErrors = [];
  const failedRequests = [];
  let httpStatus = null;
  let finalUrl = null;
  let title = '';
  let bodyTextLength = 0;
  let elementCount = 0;
  let ok = false;

  try {
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    page.on('requestfailed', req => {
      failedRequests.push(`${req.url()} - ${req.failure()?.errorText || 'failed'}`);
    });

    page.on('response', res => {
      if (res.status() >= 400) {
        failedRequests.push(`${res.url()} - Status ${res.status()}`);
      }
    });

    const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
    ok = true;
    if (response) {
      httpStatus = response.status();
    }
    finalUrl = page.url();
    title = await page.title();
    bodyTextLength = await page.evaluate(() => document.body ? document.body.innerText.trim().length : 0);
    elementCount = await page.evaluate(() => document.querySelectorAll('*').length);
  } catch (err) {
    ok = false;
    const { logError } = require('./logger');
    logError('inspectPage-error', err);
  } finally {
    try {
      await page.close();
    } catch (e) {}
  }

  return {
    ok,
    httpStatus,
    title,
    bodyTextLength,
    elementCount,
    consoleErrors,
    failedRequests,
    finalUrl
  };
}

module.exports = {
  capture,
  closeBrowser,
  inspectPage
};

