const express = require('express');
const { chromium } = require('playwright');
const {
  isMediaUrl,
  isApiProxy,
  isCrawlCandidate,
  extractSourcesFromText,
  extractUrlsFromText,
  dedupeSources,
  mediaType
} = require('./src/extractor');

const app = express();
const PORT = process.env.PORT || 3000;

const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 5000);
const BROWSER_WAIT_MS = Number(process.env.BROWSER_WAIT_MS || 9000);
const MAX_DEPTH = Number(process.env.MAX_DEPTH || 3);
const MAX_URLS = Number(process.env.MAX_URLS || 120);
const MAX_SOURCES = Number(process.env.MAX_SOURCES || 100);
const CRAWL_CONCURRENCY = Number(process.env.CRAWL_CONCURRENCY || 8);
const MAX_RESPONSE_BYTES = Number(process.env.MAX_RESPONSE_BYTES || 3 * 1024 * 1024);

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

function createDebug(enabled) {
  return {
    enabled,
    crawled: [],
    foundUrls: [],
    network: [],

    addCrawled(url, depth) {
      if (!enabled) return;
      if (this.crawled.length < 200) this.crawled.push({ depth, url });
    },

    addFound(url, source) {
      if (!enabled) return;
      if (this.foundUrls.length < 300) this.foundUrls.push({ source, url });
    },

    addNetwork(url, type) {
      if (!enabled) return;
      if (this.network.length < 300) this.network.push({ type, url });
    },

    data() {
      return {
        crawled: this.crawled,
        foundUrls: this.foundUrls,
        network: this.network
      };
    }
  };
}

function addSources(bucket, sourceList, debug, foundIn = '') {
  for (const source of sourceList || []) {
    if (!source || !source.url) continue;
    if (!isSafeUrl(source.url)) continue;

    bucket.push({
      ...source,
      foundIn: source.foundIn || foundIn || 'unknown'
    });

    debug.addFound(source.url, source.foundIn || foundIn);
  }

  const clean = dedupeSources(bucket);
  bucket.length = 0;
  bucket.push(...clean.slice(0, MAX_SOURCES));

  return bucket;
}

function makeDirectSource(url, foundIn = 'url') {
  if (!isMediaUrl(url)) return null;

  return {
    name: null,
    url,
    type: mediaType(url),
    quality: null,
    headers: {},
    foundIn
  };
}

async function fetchText(url, referer = 'https://embed.filmu.in/') {
  if (!isSafeUrl(url)) return '';

  const direct = makeDirectSource(url);
  if (direct && direct.type !== 'm3u8') {
    return '';
  }

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
        Origin: new URL(referer).origin
      }
    });

    const contentLength = Number(response.headers.get('content-length') || 0);
    const contentType = response.headers.get('content-type') || '';

    if (contentLength && contentLength > MAX_RESPONSE_BYTES) {
      return '';
    }

    if (
      contentType.includes('video') ||
      contentType.includes('image') ||
      contentType.includes('font')
    ) {
      return '';
    }

    return await response.text().catch(() => '');
  } catch {
    return '';
  } finally {
    clearTimeout(timeout);
  }
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

async function staticDigger(startUrl, debug) {
  const sources = [];
  const seen = new Set();
  let currentLevel = [startUrl];

  for (let depth = 0; depth <= MAX_DEPTH; depth++) {
    const nextLevel = [];

    const level = currentLevel
      .filter(Boolean)
      .filter((url) => isSafeUrl(url))
      .filter((url) => {
        if (seen.has(url)) return false;
        seen.add(url);
        return true;
      })
      .slice(0, MAX_URLS);

    await mapLimit(level, CRAWL_CONCURRENCY, async (url) => {
      if (seen.size > MAX_URLS) return;

      debug.addCrawled(url, depth);

      const direct = makeDirectSource(url, `static-url-depth-${depth}`);
      if (direct) {
        addSources(sources, [direct], debug, direct.foundIn);

        if (direct.type !== 'm3u8') return;
      }

      const text = await fetchText(url, startUrl);
      if (!text) return;

      addSources(
        sources,
        extractSourcesFromText(text, url, `static-body-depth-${depth}`),
        debug,
        `static-body-depth-${depth}`
      );

      const foundUrls = extractUrlsFromText(text, url);

      for (const foundUrl of foundUrls) {
        if (!isSafeUrl(foundUrl)) continue;
        if (!isCrawlCandidate(foundUrl)) continue;
        if (seen.has(foundUrl)) continue;

        nextLevel.push(foundUrl);
      }
    });

    currentLevel = [...new Set(nextLevel)].slice(0, MAX_URLS);

    if (!currentLevel.length) break;
  }

  return dedupeSources(sources);
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

async function browserDigger(startUrl, debug) {
  const sources = [];
  const discovered = new Set();

  const context = await getContext();
  const page = await context.newPage();

  function addUrlForLater(url, source) {
    if (!url || !isSafeUrl(url)) return;
    if (!isCrawlCandidate(url)) return;
    if (discovered.has(url)) return;

    discovered.add(url);
    debug.addFound(url, source);
  }

  async function processText(text, baseUrl, foundIn) {
    addSources(
      sources,
      extractSourcesFromText(text, baseUrl, foundIn),
      debug,
      foundIn
    );

    const urls = extractUrlsFromText(text, baseUrl);

    for (const url of urls) {
      addUrlForLater(url, foundIn);
    }
  }

  try {
    page.setDefaultNavigationTimeout(16000);
    page.setDefaultTimeout(6000);

    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = request.url();
      const type = request.resourceType();

      debug.addNetwork(url, `route:${type}`);

      if (isMediaUrl(url)) {
        const direct = makeDirectSource(url, `browser-route-${type}`);
        if (direct) addSources(sources, [direct], debug, direct.foundIn);

        return route.abort().catch(() => {});
      }

      if (isCrawlCandidate(url)) {
        addUrlForLater(url, `browser-route-${type}`);
      }

      if (type === 'image' || type === 'font' || type === 'stylesheet') {
        return route.abort().catch(() => {});
      }

      return route.continue().catch(() => {});
    });

    page.on('request', (request) => {
      const url = request.url();
      debug.addNetwork(url, `request:${request.resourceType()}`);

      if (isMediaUrl(url)) {
        const direct = makeDirectSource(url, `browser-request-${request.resourceType()}`);
        if (direct) addSources(sources, [direct], debug, direct.foundIn);
      }

      const postData = request.postData();

      if (postData) {
        processText(postData, startUrl, 'browser-post-data').catch(() => {});
      }
    });

    page.on('response', (response) => {
      (async () => {
        const url = response.url();
        const headers = response.headers();
        const contentType = headers['content-type'] || '';
        const length = Number(headers['content-length'] || 0);

        debug.addNetwork(url, `response:${contentType}`);

        if (isMediaUrl(url)) {
          const direct = makeDirectSource(url, 'browser-response-media');
          if (direct) addSources(sources, [direct], debug, direct.foundIn);
          return;
        }

        if (length && length > MAX_RESPONSE_BYTES) return;

        if (
          isCrawlCandidate(url) ||
          contentType.includes('json') ||
          contentType.includes('javascript') ||
          contentType.includes('text') ||
          contentType.includes('mpegurl')
        ) {
          const text = await response.text().catch(() => '');
          await processText(text, url, 'browser-response-body');
        }
      })().catch(() => {});
    });

    page.on('console', (msg) => {
      processText(msg.text(), startUrl, 'browser-console').catch(() => {});
    });

    await page
      .goto(startUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 16000
      })
      .catch(() => null);

    for (const frame of page.frames()) {
      const html = await frame.content().catch(() => '');
      await processText(html, frame.url() || startUrl, 'browser-frame-html');
    }

    await page.mouse.click(640, 360).catch(() => {});
    await page.keyboard.press('Space').catch(() => {});

    await sleep(BROWSER_WAIT_MS);

    for (const frame of page.frames()) {
      const html = await frame.content().catch(() => '');
      await processText(html, frame.url() || startUrl, 'browser-final-frame-html');
    }
  } finally {
    await page.close().catch(() => {});
  }

  const discoveredUrls = [...discovered].slice(0, 50);

  await mapLimit(discoveredUrls, 6, async (url) => {
    const direct = makeDirectSource(url, 'browser-discovered-url');

    if (direct) {
      addSources(sources, [direct], debug, direct.foundIn);
      if (direct.type !== 'm3u8') return;
    }

    const text = await fetchText(url, startUrl);
    if (!text) return;

    addSources(
      sources,
      extractSourcesFromText(text, url, 'browser-discovered-body'),
      debug,
      'browser-discovered-body'
    );
  });

  return dedupeSources(sources);
}

function cacheKey(movieId, deep) {
  return `${movieId}:deep=${deep ? '1' : '0'}`;
}

async function resolveMovie(movieId, options = {}) {
  const deep = options.deep !== false;
  const sourceUrl = `https://embed.filmu.in/movie/${encodeURIComponent(movieId)}`;
  const debug = createDebug(Boolean(options.debug));

  let sources = await staticDigger(sourceUrl, debug);

  if (deep) {
    const browserSources = await browserDigger(sourceUrl, debug);
    sources = dedupeSources([...sources, ...browserSources]);
  }

  const m3u8Sources = sources.filter((source) => source.type === 'm3u8');
  const mp4Sources = sources.filter((source) => source.type === 'mp4');

  return {
    ok: sources.length > 0,
    movieId,
    sourceUrl,
    count: sources.length,
    best: sources[0] || null,
    m3u8: m3u8Sources[0]?.url || null,
    mp4: mp4Sources[0]?.url || null,
    sources,
    debug: options.debug ? debug.data() : undefined
  };
}

async function resolveMovieCached(movieId, options = {}) {
  const key = cacheKey(movieId, options.deep !== false);

  if (!options.debug && !options.refresh) {
    const cached = cache.get(key);

    if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) {
      return {
        ...cached.data,
        cached: true
      };
    }
  }

  if (!options.debug && pending.has(key)) {
    return pending.get(key);
  }

  const job = resolveMovie(movieId, options)
    .then((result) => {
      if (result.ok && !options.debug) {
        cache.set(key, {
          savedAt: Date.now(),
          data: result
        });
      }

      return {
        ...result,
        cached: false
      };
    })
    .finally(() => pending.delete(key));

  if (!options.debug) pending.set(key, job);

  return job;
}

app.get('/', (_req, res) => {
  res.type('text/plain').send(
    'Use /movie/{id}\nExample: /movie/1726?refresh=1&debug=1\nFast static only: /movie/1726?fast=1'
  );
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
    const result = await resolveMovieCached(movieId, {
      refresh: req.query.refresh === '1',
      debug: req.query.debug === '1',
      deep: req.query.fast !== '1'
    });

    if (!result.ok) {
      return jsonError(res, 404, 'No media sources found.', {
        movieId,
        ms: Date.now() - started,
        sourceUrl: result.sourceUrl,
        count: 0,
        debug: result.debug
      });
    }

    return res.json({
      ok: true,
      movieId,
      cached: Boolean(result.cached),
      ms: Date.now() - started,
      sourceUrl: result.sourceUrl,
      count: result.count,
      best: result.best,
      m3u8: result.m3u8,
      mp4: result.mp4,
      sources: result.sources,
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
  console.log(`MovieResolver digger running on ${PORT}`);

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
