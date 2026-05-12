const express = require('express');
const { chromium } = require('playwright');
const {
  isApiProxy,
  extractApiProxyUrls,
  extractAssetUrls,
  findFirstM3u8
} = require('./src/extractor');

const app = express();
const PORT = process.env.PORT || 3000;

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 5000);
const BROWSER_WAIT_MS = Number(process.env.BROWSER_WAIT_MS || 8000);

const cache = new Map();
const pending = new Map();

let browserPromise = null;
let contextPromise = null;

app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.sendStatus(204);

  next();
});

function jsonError(res, status, error, extra = {}) {
  return res.status(status).json({
    ok: false,
    error,
    ...extra
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url, referer = 'https://embed.filmu.in/') {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36',
        Accept: 'application/json,text/plain,text/html,application/javascript,*/*',
        Referer: referer,
        Origin: 'https://embed.filmu.in'
      }
    });

    return await response.text().catch(() => '');
  } catch {
    return '';
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchApiProxy(apiUrl, sourceUrl, debug) {
  if (!isApiProxy(apiUrl)) return null;

  debug.apiUrls.push(apiUrl);

  const text = await fetchText(apiUrl, sourceUrl);
  if (!text) return null;

  const stream = findFirstM3u8(text, apiUrl);
  if (!stream) return null;

  return stream;
}

async function staticScan(sourceUrl, debug) {
  debug.steps.push('static-html');

  const html = await fetchText(sourceUrl, sourceUrl);

  const htmlApiUrls = extractApiProxyUrls(html, sourceUrl);

  for (const apiUrl of htmlApiUrls) {
    const stream = await fetchApiProxy(apiUrl, sourceUrl, debug);
    if (stream) return stream;
  }

  debug.steps.push('static-assets');

  const assets = extractAssetUrls(html, sourceUrl);
  debug.assets = assets;

  for (const asset of assets) {
    const assetText = await fetchText(asset, sourceUrl);

    const assetApiUrls = extractApiProxyUrls(assetText, asset);

    for (const apiUrl of assetApiUrls) {
      const stream = await fetchApiProxy(apiUrl, sourceUrl, debug);
      if (stream) return stream;
    }

    const directM3u8 = findFirstM3u8(assetText, asset);
    if (directM3u8) return directM3u8;
  }

  return null;
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium
      .launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding',
          '--no-first-run',
          '--no-default-browser-check'
        ]
      })
      .then((browser) => {
        browser.on('disconnected', () => {
          browserPromise = null;
          contextPromise = null;
        });

        return browser;
      });

    return browserPromise;
  }

  const browser = await browserPromise;

  if (!browser.isConnected()) {
    browserPromise = null;
    contextPromise = null;
    return getBrowser();
  }

  return browser;
}

async function getContext() {
  if (!contextPromise) {
    contextPromise = getBrowser().then((browser) => {
      return browser.newContext({
        viewport: { width: 1280, height: 720 },
        ignoreHTTPSErrors: true,
        bypassCSP: true,
        serviceWorkers: 'block',
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36'
      });
    });
  }

  return contextPromise;
}

function createSignal() {
  let resolved = false;
  let resolveValue;

  const promise = new Promise((resolve) => {
    resolveValue = resolve;
  });

  return {
    promise,

    resolve(value) {
      if (!resolved && value) {
        resolved = true;
        resolveValue(value);
      }
    }
  };
}

async function browserScan(sourceUrl, debug) {
  debug.steps.push('browser');

  const context = await getContext();
  const page = await context.newPage();
  const signal = createSignal();

  async function checkText(text, baseUrl) {
    const apiUrls = extractApiProxyUrls(text, baseUrl);

    for (const apiUrl of apiUrls) {
      const stream = await fetchApiProxy(apiUrl, sourceUrl, debug);
      if (stream) {
        signal.resolve(stream);
        return stream;
      }
    }

    return null;
  }

  try {
    page.setDefaultNavigationTimeout(15000);
    page.setDefaultTimeout(6000);

    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = request.url();
      const type = request.resourceType();

      if (isApiProxy(url)) {
        fetchApiProxy(url, sourceUrl, debug)
          .then((stream) => signal.resolve(stream))
          .catch(() => {});
      }

      if (type === 'image' || type === 'font' || type === 'stylesheet') {
        return route.abort().catch(() => {});
      }

      return route.continue().catch(() => {});
    });

    page.on('request', (request) => {
      const url = request.url();

      if (isApiProxy(url)) {
        fetchApiProxy(url, sourceUrl, debug)
          .then((stream) => signal.resolve(stream))
          .catch(() => {});
      }

      const postData = request.postData();

      if (postData) {
        checkText(postData, sourceUrl).catch(() => {});
      }
    });

    page.on('response', (response) => {
      (async () => {
        const url = response.url();
        const contentType = response.headers()['content-type'] || '';

        if (isApiProxy(url)) {
          const text = await response.text().catch(() => '');
          const stream = findFirstM3u8(text, url);

          if (stream) {
            debug.apiUrls.push(url);
            signal.resolve(stream);
          }

          return;
        }

        if (
          contentType.includes('json') ||
          contentType.includes('javascript') ||
          contentType.includes('text')
        ) {
          const text = await response.text().catch(() => '');
          await checkText(text, url);
        }
      })().catch(() => {});
    });

    page.on('console', (msg) => {
