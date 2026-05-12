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
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 5000);
const ASSET_TIMEOUT_MS = Number(process.env.ASSET_TIMEOUT_MS || 3000);
const BROWSER_WAIT_MS = Number(process.env.BROWSER_WAIT_MS || 9000);

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

async function fetchText(url, referer, timeoutMs = FETCH_TIMEOUT_MS) {
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
        Referer: referer || 'https://embed.filmu.in/',
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
  if (!apiUrl || !isApiProxy(apiUrl)) return null;

  if (!debug.apiUrls.includes(apiUrl)) {
    debug.apiUrls.push(apiUrl);
  }

  const text = await fetchText(apiUrl, sourceUrl, FETCH_TIMEOUT_MS);

  if (!text) return null;

  return findFirstM3u8(text, apiUrl);
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

async function checkTextForApi(text, baseUrl, sourceUrl, debug) {
  const apiUrls = extractApiProxyUrls(text, baseUrl);

  for (const apiUrl of apiUrls) {
    const stream = await fetchApiProxy(apiUrl, sourceUrl, debug);
    if (stream) return stream;
  }

  return null;
}

async function staticScan(sourceUrl, debug) {
  debug.steps.push('static-html');

  const html = await fetchText(sourceUrl, sourceUrl);

  let stream = await checkTextForApi(html, sourceUrl, sourceUrl, debug);
  if (stream) return stream;

  const directM3u8 = findFirstM3u8(html, sourceUrl);
  if (directM3u8) return directM3u8;

  debug.steps.push('static-assets');

  const assets = extractAssetUrls(html, sourceUrl);
  debug.assets = assets.slice(0, 60);

  await mapLimit(assets, 8, async (assetUrl) => {
    if (stream) return;

    if (isApiProxy(assetUrl)) {
      stream = await fetchApiProxy(assetUrl, sourceUrl, debug);
      return;
    }

    const assetText = await fetchText(assetUrl, sourceUrl, ASSET_TIMEOUT_MS);

    stream = await checkTextForApi(assetText, assetUrl, sourceUrl, debug);

    if (stream) return;

    const assetM3u8 = findFirstM3u8(assetText, assetUrl);
    if (assetM3u8) stream = assetM3u8;
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

async function browserScan(sourceUrl, debug) {
  debug.steps.push('browser');

  const context = await getContext();
  const page = await context.newPage();
  const signal = createSignal();

  const seenApi = new Set();

  async function queueApi(apiUrl) {
    if (!apiUrl || !isApiProxy(apiUrl)) return;
    if (seenApi.has(apiUrl)) return;

    seenApi.add(apiUrl);

    fetchApiProxy(apiUrl, sourceUrl, debug)
      .then((stream) => signal.resolve(stream))
      .catch(() => {});
  }

  async function checkText(text, baseUrl) {
    const apiUrls = extractApiProxyUrls(text, baseUrl);

    for (const apiUrl of apiUrls) {
      await queueApi(apiUrl);
    }

    const direct = findFirstM3u8(text, baseUrl);
    if (direct) signal.resolve(direct);
  }

  try {
    page.setDefaultNavigationTimeout(16000);
    page.setDefaultTimeout(6000);

    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = request.url();
      const type = request.resourceType();

      if (isApiProxy(url)) {
        await queueApi(url);
      }

      if (type === 'image' || type === 'font' || type === 'stylesheet') {
        return route.abort().catch(() => {});
      }

      return route.continue().catch(() => {});
    });

    page.on('request', (request) => {
      const url = request.url();

      if (isApiProxy(url)) {
        queueApi(url);
      }

      const postData = request.postData();

      if (postData) {
        checkText(postData, sourceUrl).catch(() => {});
      }
    });

    page.on('response', (response) => {
      (async () => {
        const url = response.url();
        const headers = response.headers();
        const contentType = headers['content-type'] || '';
        const length = Number(headers['content-length'] || 0);

        if (isApiProxy(url)) {
          const text = await response.text().catch(() => '');
          const stream = findFirstM3u8(text, url);

          if (!debug.apiUrls.includes(url)) {
            debug.apiUrls.push(url);
          }

          signal.resolve(stream);
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
          await checkText(text, url);
        }
      })().catch(() => {});
    });

    page.on('console', (msg) => {
      checkText(msg.text(), sourceUrl).catch(() => {});
    });

    await page
      .goto(sourceUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 16000
      })
      .catch(() => null);

    for (const frame of page.frames()) {
      const html = await frame.content().catch(() => '');
      await checkText(html, frame.url() || sourceUrl);

      const winner = await Promise.race([
        signal.promise,
        sleep(50).then(() => null)
      ]);

      if (winner) return winner;
    }

    await page.mouse.click(640, 360).catch(() => {});
    await page.keyboard.press('Space').catch(() => {});

    const winner = await Promise.race([
      signal.promise,
      sleep(BROWSER_WAIT_MS).then(() => null)
    ]);

    if (winner) return winner;

    for (const frame of page.frames()) {
      const html = await frame.content().catch(() => '');
      await checkText(html, frame.url() || sourceUrl);

      const finalWinner = await Promise.race([
        signal.promise,
        sleep(50).then(() => null)
      ]);

      if (finalWinner) return finalWinner;
    }

    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

async function resolveMovie(movieId, debugMode = false) {
  const sourceUrl = `https://embed.filmu.in/movie/${encodeURIComponent(movieId)}`;

  const debug = {
    steps: [],
    apiUrls: [],
    assets: []
  };

  let stream = await staticScan(sourceUrl, debug);

  if (!stream) {
    stream = await browserScan(sourceUrl, debug);
  }

  if (!stream) {
    return {
      ok: false,
      movieId,
      sourceUrl,
      debug: debugMode ? debug : undefined
    };
  }

  return {
    ok: true,
    movieId,
    sourceUrl,
    apiProxyUrl: stream.apiProxyUrl || null,
    m3u8: stream.url,
    headers: stream.headers || {},
    stream,
    debug: debugMode ? debug : undefined
  };
}

async function resolveMovieCached(movieId, debugMode, refresh) {
  if (!debugMode && !refresh) {
    const cached = cache.get(movieId);

    if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) {
      return {
        ...cached.data,
        cached: true
      };
    }
  }

  if (!debugMode && pending.has(movieId)) {
    return pending.get(movieId);
  }

  const job = resolveMovie(movieId, debugMode)
    .then((result) => {
      if (result.ok && !debugMode) {
        cache.set(movieId, {
          savedAt: Date.now(),
          data: result
        });
      }

      return {
        ...result,
        cached: false
      };
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
    const result = await resolveMovieCached(
      movieId,
      req.query.debug === '1',
      req.query.refresh === '1'
    );

    if (!result.ok) {
      return jsonError(res, 404, 'No m3u8 source found.', {
        movieId,
        ms: Date.now() - started,
        sourceUrl: result.sourceUrl,
        debug: result.debug
      });
    }

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
  console.log(`MovieResolver running on ${PORT}`);

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
