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

const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 3500);
const ASSET_TIMEOUT_MS = Number(process.env.ASSET_TIMEOUT_MS || 2200);
const BROWSER_WAIT_MS = Number(process.env.BROWSER_WAIT_MS || 5500);
const MAX_ASSETS = Number(process.env.MAX_ASSETS || 60);
const ENABLE_BROWSER = process.env.ENABLE_BROWSER !== '0';

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
  return res.status(status).json({ ok: false, error, ...extra });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSafeUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (host === 'localhost' || host === '0.0.0.0' || host === '::1') return false;
    if (/^127\./.test(host)) return false;
    if (/^10\./.test(host)) return false;
    if (/^192\.168\./.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;

    return true;
  } catch {
    return false;
  }
}

function makeDebug(enabled) {
  return {
    enabled,
    steps: [],
    apiUrls: [],
    assets: [],
    networkApiUrls: [],

    step(value) {
      if (enabled && this.steps.length < 100) this.steps.push(value);
    },

    api(url, source) {
      if (!enabled || !url) return;
      if (this.apiUrls.length < 100) this.apiUrls.push({ source, url });
    },

    asset(url) {
      if (!enabled || !url) return;
      if (this.assets.length < 100) this.assets.push(url);
    },

    network(url) {
      if (!enabled || !url) return;
      if (this.networkApiUrls.length < 100) this.networkApiUrls.push(url);
    },

    data() {
      return {
        steps: this.steps,
        apiUrls: this.apiUrls,
        assets: this.assets,
        networkApiUrls: this.networkApiUrls
      };
    }
  };
}

async function fetchText(url, referer = 'https://embed.filmu.in/', timeoutMs = FETCH_TIMEOUT_MS) {
  if (!isSafeUrl(url)) return '';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

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

    const contentType = response.headers.get('content-type') || '';
    const contentLength = Number(response.headers.get('content-length') || 0);

    if (contentLength && contentLength > 3 * 1024 * 1024) return '';
    if (contentType.includes('image') || contentType.includes('font') || contentType.includes('video')) return '';

    return await response.text().catch(() => '');
  } catch {
    return '';
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchApiProxy(apiUrl, sourceUrl, debug, foundIn) {
  if (!apiUrl || !isApiProxy(apiUrl) || !isSafeUrl(apiUrl)) return null;

  debug.api(apiUrl, foundIn);

  const text = await fetchText(apiUrl, sourceUrl, FETCH_TIMEOUT_MS + 1500);
  if (!text) return null;

  return findFirstM3u8(text, apiUrl, foundIn);
}

async function mapLimit(items, limit, mapper) {
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const item = items[index++];
      await mapper(item).catch(() => null);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function scanTextForApiM3u8(text, baseUrl, sourceUrl, debug, foundIn) {
  if (!text) return null;

  // If a response itself has the JSON/source/m3u8, return it first.
  const direct = findFirstM3u8(text, baseUrl, foundIn);
  if (direct) return direct;

  const apiUrls = extractApiProxyUrls(text, baseUrl);

  for (const apiUrl of apiUrls) {
    const stream = await fetchApiProxy(apiUrl, sourceUrl, debug, foundIn);
    if (stream) return stream;
  }

  return null;
}

async function staticScan(sourceUrl, debug) {
  debug.step('static-html');

  const html = await fetchText(sourceUrl, sourceUrl);

  let stream = await scanTextForApiM3u8(html, sourceUrl, sourceUrl, debug, 'static-html');
  if (stream) return stream;

  debug.step('static-assets');

  const assets = extractAssetUrls(html, sourceUrl, MAX_ASSETS);
  for (const asset of assets) debug.asset(asset);

  await mapLimit(assets, 10, async (assetUrl) => {
    if (stream) return;

    if (isApiProxy(assetUrl)) {
      stream = await fetchApiProxy(assetUrl, sourceUrl, debug, 'asset-url');
      return;
    }

    const assetText = await fetchText(assetUrl, sourceUrl, ASSET_TIMEOUT_MS);
    stream = await scanTextForApiM3u8(assetText, assetUrl, sourceUrl, debug, 'asset-body');
  });

  return stream || null;
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
          '--no-default-browser-check',
          '--autoplay-policy=no-user-gesture-required'
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
  let done = false;
  let resolveDone;

  const promise = new Promise((resolve) => {
    resolveDone = resolve;
  });

  return {
    promise,
    resolve(value) {
      if (!done && value) {
        done = true;
        resolveDone(value);
      }
    }
  };
}

async function browserScan(sourceUrl, debug) {
  if (!ENABLE_BROWSER) return null;

  debug.step('browser');

  const context = await getContext();
  const page = await context.newPage();
  const signal = createSignal();
  const seenApi = new Set();

  async function queueApi(apiUrl, foundIn) {
    if (!apiUrl || !isApiProxy(apiUrl) || seenApi.has(apiUrl)) return;

    seenApi.add(apiUrl);
    debug.network(apiUrl);

    fetchApiProxy(apiUrl, sourceUrl, debug, foundIn)
      .then((stream) => signal.resolve(stream))
      .catch(() => {});
  }

  async function checkText(text, baseUrl, foundIn) {
    const stream = await scanTextForApiM3u8(text, baseUrl, sourceUrl, debug, foundIn);
    if (stream) signal.resolve(stream);
  }

  try {
    page.setDefaultNavigationTimeout(14000);
    page.setDefaultTimeout(5000);

    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = request.url();
      const type = request.resourceType();

      if (isApiProxy(url)) {
        await queueApi(url, `browser-route-${type}`);
      }

      if (type === 'image' || type === 'font' || type === 'stylesheet') {
        return route.abort().catch(() => {});
      }

      return route.continue().catch(() => {});
    });

    page.on('request', (request) => {
      const url = request.url();

      if (isApiProxy(url)) {
        queueApi(url, `browser-request-${request.resourceType()}`);
      }

      const postData = request.postData();
      if (postData) checkText(postData, sourceUrl, 'browser-post-data').catch(() => {});
    });

    page.on('response', (response) => {
      (async () => {
        const url = response.url();
        const headers = response.headers();
        const contentType = headers['content-type'] || '';
        const length = Number(headers['content-length'] || 0);

        if (isApiProxy(url)) {
          const text = await response.text().catch(() => '');
          const stream = findFirstM3u8(text, url, 'browser-api-response');
          if (stream) {
            debug.network(url);
            signal.resolve(stream);
          }
          return;
        }

        if (length && length > 2 * 1024 * 1024) return;

        if (
          contentType.includes('json') ||
          contentType.includes('javascript') ||
          contentType.includes('text') ||
          url.includes('.js') ||
          url.includes('.json')
        ) {
          const text = await response.text().catch(() => '');
          await checkText(text, url, 'browser-response-body');
        }
      })().catch(() => {});
    });

    page.on('console', (msg) => {
      checkText(msg.text(), sourceUrl, 'browser-console').catch(() => {});
    });

    await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 14000 }).catch(() => null);

    for (const frame of page.frames()) {
      const html = await frame.content().catch(() => '');
      await checkText(html, frame.url() || sourceUrl, 'browser-frame-html');

      const winner = await Promise.race([signal.promise, sleep(40).then(() => null)]);
      if (winner) return winner;
    }

    await page.mouse.click(640, 360).catch(() => {});
    await page.keyboard.press('Space').catch(() => {});

    const winner = await Promise.race([signal.promise, sleep(BROWSER_WAIT_MS).then(() => null)]);
    if (winner) return winner;

    for (const frame of page.frames()) {
      const html = await frame.content().catch(() => '');
      await checkText(html, frame.url() || sourceUrl, 'browser-final-frame-html');

      const finalWinner = await Promise.race([signal.promise, sleep(40).then(() => null)]);
      if (finalWinner) return finalWinner;
    }

    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

async function resolveMovie(movieId, debugMode = false) {
  const sourceUrl = `https://embed.filmu.in/movie/${encodeURIComponent(movieId)}`;
  const debug = makeDebug(debugMode);

  let stream = await staticScan(sourceUrl, debug);

  if (!stream) {
    stream = await browserScan(sourceUrl, debug);
  }

  if (!stream) {
    return {
      ok: false,
      movieId,
      sourceUrl,
      debug: debugMode ? debug.data() : undefined
    };
  }

  return {
    ok: true,
    movieId,
    sourceUrl,
    apiProxyUrl: stream.apiProxyUrl || null,
    m3u8: stream.url,
    headers: stream.headers || {},
    stream: {
      name: stream.name || null,
      url: stream.url,
      quality: stream.quality || null,
      type: 'm3u8',
      headers: stream.headers || {}
    },
    debug: debugMode ? debug.data() : undefined
  };
}

async function resolveMovieCached(movieId, debugMode, refresh) {
  if (!debugMode && !refresh) {
    const cached = cache.get(movieId);

    if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) {
      return { ...cached.data, cached: true };
    }
  }

  if (!debugMode && pending.has(movieId)) return pending.get(movieId);

  const job = resolveMovie(movieId, debugMode)
    .then((result) => {
      if (result.ok && !debugMode) {
        cache.set(movieId, {
          savedAt: Date.now(),
          data: result
        });
      }

      return { ...result, cached: false };
    })
    .finally(() => pending.delete(movieId));

  if (!debugMode) pending.set(movieId, job);

  return job;
}

app.get('/', (_req, res) => {
  res.type('text/plain').send('Use /movie/{id}. Example: /movie/1726?refresh=1&debug=1');
});

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.get('/movie/:id', async (req, res) => {
  const movieId = String(req.params.id || '').trim();

  if (!/^\d+$/.test(movieId)) {
    return jsonError(res, 400, 'Movie id must be numeric.');
  }

  const started = Date.now();

  try {
    const result = await resolveMovieCached(movieId, req.query.debug === '1', req.query.refresh === '1');

    if (!result.ok) {
      return jsonError(res, 404, 'No m3u8 source found.', {
        movieId,
        ms: Date.now() - started,
        sourceUrl: result.sourceUrl,
        debug: result.debug
      });
    }

    // Default response is now ONLY the exact m3u8 result, not a pile of sources.
    return res.json({
      ok: true,
      movieId,
      cached: Boolean(result.cached),
      ms: Date.now() - started,
      sourceUrl: result.sourceUrl,
      apiProxyUrl: result.apiProxyUrl,
      m3u8: result.m3u8,
      headers: result.headers,
      stream: result.stream,
      debug: result.debug
    });
  } catch (error) {
    return jsonError(res, 500, error.message || 'Resolver failed.', {
      ms: Date.now() - started
    });
  }
});

app.use((req, res) => {
  jsonError(res, 404, 'Route not found. Use /movie/{id}.');
});

const server = app.listen(PORT, () => {
  console.log(`MovieResolver m3u8-only running on ${PORT}`);

  getContext()
    .then(() => console.log('Chromium warmed up'))
    .catch((err) => console.error('Chromium warmup failed:', err.message));
});

async function shutdown() {
  server.close(() => {});

  const browser = browserPromise ? await browserPromise.catch(() => null) : null;
  await browser?.close().catch(() => {});

  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
