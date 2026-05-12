const express = require('express');
const { chromium } = require('playwright');
const {
  repairBrokenProtocol,
  addHttpsToBareUrl,
  cleanText,
  isApiProxyUrl,
  extractApiProxyUrlsFromText,
  extractAssetUrls,
  parseM3u8FromApiResponse
} = require('./src/extractor');

const app = express();
const PORT = process.env.PORT || 3000;

const FRESH_CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const STALE_CACHE_TTL_MS = Number(process.env.STALE_CACHE_TTL_MS || 24 * 60 * 60 * 1000);

const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 2200);
const API_TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 4500);
const ASSET_TIMEOUT_MS = Number(process.env.ASSET_TIMEOUT_MS || 1800);
const MAX_ASSETS_TO_SCAN = Number(process.env.MAX_ASSETS_TO_SCAN || 40);

const ENABLE_BROWSER_FALLBACK = process.env.ENABLE_BROWSER_FALLBACK !== '0';
const BROWSER_TOTAL_WAIT_MS = Number(process.env.BROWSER_TOTAL_WAIT_MS || 7000);
const CLICK_AFTER_MS = Number(process.env.CLICK_AFTER_MS || 1200);

const MAX_PARALLEL_SCANS = Number(process.env.MAX_PARALLEL_SCANS || 2);

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

function jsonError(res, status, message, extra = {}) {
  return res.status(status).json({
    ok: false,
    error: message,
    ...extra
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createLimiter(max) {
  let active = 0;
  const queue = [];

  async function run(fn, resolve, reject) {
    active++;

    try {
      resolve(await fn());
    } catch (error) {
      reject(error);
    } finally {
      active--;

      const next = queue.shift();
      if (next) next();
    }
  }

  return function limit(fn) {
    return new Promise((resolve, reject) => {
      const job = () => run(fn, resolve, reject);

      if (active < max) {
        job();
      } else {
        queue.push(job);
      }
    });
  };
}

const scanLimit = createLimiter(MAX_PARALLEL_SCANS);

function createDebug(enabled) {
  const checked = [];
  const apiUrlsSeen = [];
  const assetUrls = [];

  return {
    enabled,

    check(value) {
      if (!enabled) return;
      if (checked.length < 200) checked.push(value);
    },

    api(url, source) {
      if (!enabled || !url) return;
      if (apiUrlsSeen.length < 100) apiUrlsSeen.push({ source, url });
    },

    asset(url) {
      if (!enabled || !url) return;
      if (assetUrls.length < 100) assetUrls.push(url);
    },

    data() {
      return {
        checked,
        apiUrlsSeen,
        assetUrls
      };
    }
  };
}

function createFoundSignal() {
  let resolved = false;
  let resolveNow;

  const promise = new Promise((resolve) => {
    resolveNow = resolve;
  });

  return {
    promise,

    resolve(value) {
      if (!resolved && value) {
        resolved = true;
        resolveNow(value);
      }
    }
  };
}

function requestHeaders(baseUrl) {
  const origin = new URL(baseUrl).origin;

  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    Accept: 'application/json,text/plain,text/html,application/javascript,*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: baseUrl,
    Origin: origin
  };
}

async function fetchText(url, baseUrl, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: requestHeaders(baseUrl)
    });

    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
      contentType: response.headers.get('content-type') || '',
      text: await response.text().catch(() => '')
    };
  } catch {
    return {
      ok: false,
      status: 0,
      url,
      contentType: '',
      text: ''
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchApiProxy(apiProxyUrl, sourceUrl, debug, foundIn = 'api-proxy-fetch') {
  if (!apiProxyUrl || !isApiProxyUrl(apiProxyUrl)) return null;

  debug.api(apiProxyUrl, foundIn);
  debug.check(`fetch-api:${apiProxyUrl}`);

  const response = await fetchText(apiProxyUrl, sourceUrl, API_TIMEOUT_MS);

  if (!response.text) return null;

  return parseM3u8FromApiResponse(response.text, apiProxyUrl, foundIn);
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

async function staticResolve(movieId, targetUrl, debug) {
  debug.check('static-html');

  const htmlResponse = await fetchText(targetUrl, targetUrl, HTTP_TIMEOUT_MS);
  const html = htmlResponse.text || '';

  const apiUrls = extractApiProxyUrlsFromText(html, targetUrl);

  for (const apiUrl of apiUrls) {
    const stream = await fetchApiProxy(apiUrl, targetUrl, debug, 'static-html-api');

    if (stream) {
      return {
        ok: true,
        movieId,
        sourceUrl: targetUrl,
        apiProxyUrl: apiUrl,
        stream,
        mode: 'static-html-api'
      };
    }
  }

  const assets = extractAssetUrls(html, targetUrl, MAX_ASSETS_TO_SCAN);

  for (const asset of assets) {
    debug.asset(asset);
  }

  let foundStream = null;

  await mapLimit(assets, 8, async (assetUrl) => {
    if (foundStream) return;

    debug.check(`asset:${assetUrl}`);

    if (isApiProxyUrl(assetUrl)) {
      foundStream = await fetchApiProxy(assetUrl, targetUrl, debug, 'static-asset-url');
      return;
    }

    const assetResponse = await fetchText(assetUrl, targetUrl, ASSET_TIMEOUT_MS);
    const assetText = assetResponse.text || '';

    const directStream = parseM3u8FromApiResponse(assetText, assetUrl, 'static-asset-body');

    if (directStream) {
      foundStream = directStream;
      return;
    }

    const nestedApiUrls = extractApiProxyUrlsFromText(assetText, assetUrl);

    for (const apiUrl of nestedApiUrls) {
      if (foundStream) break;

      foundStream = await fetchApiProxy(apiUrl, targetUrl, debug, 'static-asset-api');
    }

    if (foundStream) return;

    const nestedAssets = extractAssetUrls(assetText, assetUrl, 10);

    for (const nestedAsset of nestedAssets) {
      if (foundStream) break;

      debug.asset(nestedAsset);

      if (isApiProxyUrl(nestedAsset)) {
        foundStream = await fetchApiProxy(nestedAsset, targetUrl, debug, 'static-nested-api');
      }
    }
  });

  if (foundStream) {
    return {
      ok: true,
      movieId,
      sourceUrl: targetUrl,
      apiProxyUrl: foundStream.apiProxyUrl || null,
      stream: foundStream,
      mode: foundStream.foundIn || 'static-assets'
    };
  }

  return {
    ok: false,
    movieId,
    sourceUrl: targetUrl,
    apiProxyUrl: null,
    stream: null,
    mode: 'static-none'
  };
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
          '--disable-sync',
          '--disable-default-apps',
          '--disable-popup-blocking',
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
      })
      .catch((error) => {
        browserPromise = null;
        contextPromise = null;
        throw error;
      });
  }

  const browser = await browserPromise;

  if (!browser.isConnected()) {
    browserPromise = null;
    contextPromise = null;
    return getBrowser();
  }

  return browser;
}

async function getSharedContext() {
  if (!contextPromise) {
    contextPromise = getBrowser()
      .then((browser) =>
        browser.newContext({
          viewport: { width: 1280, height: 720 },
          javaScriptEnabled: true,
          bypassCSP: true,
          ignoreHTTPSErrors: true,
          serviceWorkers: 'block',
          userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          extraHTTPHeaders: {
            'Accept-Language': 'en-US,en;q=0.9'
          }
        })
      )
      .catch((error) => {
        contextPromise = null;
        throw error;
      });
  }

  return contextPromise;
}

async function scanFrameContent(page, targetUrl, debug, signal, apiFetches, apiSeen) {
  for (const frame of page.frames()) {
    const frameUrl = frame.url();
    const base = frameUrl && frameUrl !== 'about:blank' ? frameUrl : targetUrl;

    debug.check(`frame:${base}`);

    const html = await frame.content().catch(() => '');

    const apiUrls = extractApiProxyUrlsFromText(html, base);

    for (const apiUrl of apiUrls) {
      queueApiFetch(apiUrl, targetUrl, debug, signal, apiFetches, apiSeen, 'browser-frame-html');
    }

    const storageText = await frame
      .evaluate(() => {
        const rows = [];

        try {
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            rows.push(`localStorage:${key}=${localStorage.getItem(key)}`);
          }
        } catch {}

        try {
          for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            rows.push(`sessionStorage:${key}=${sessionStorage.getItem(key)}`);
          }
        } catch {}

        return rows.join('\n');
      })
      .catch(() => '');

    const storageApiUrls = extractApiProxyUrlsFromText(storageText, base);

    for (const apiUrl of storageApiUrls) {
      queueApiFetch(apiUrl, targetUrl, debug, signal, apiFetches, apiSeen, 'browser-storage');
    }
  }
}

function queueApiFetch(apiUrl, targetUrl, debug, signal, apiFetches, apiSeen, foundIn) {
  if (!apiUrl || !isApiProxyUrl(apiUrl)) return;
  if (apiSeen.has(apiUrl)) return;

  apiSeen.add(apiUrl);
  debug.api(apiUrl, foundIn);

  const task = fetchApiProxy(apiUrl, targetUrl, debug, foundIn)
    .then((stream) => {
      if (stream) signal.resolve(stream);
      return stream;
    })
    .catch(() => null)
    .finally(() => apiFetches.delete(task));

  apiFetches.add(task);
}

async function clickPlayer(page, debug) {
  debug.check('click-player');

  await page.mouse.click(640, 360).catch(() => {});
  await page.keyboard.press('Space').catch(() => {});
  await page.waitForTimeout(150).catch(() => {});

  const selectors = [
    'video',
    '.jw-icon-playback',
    '.vjs-big-play-button',
    '.plyr__control',
    "[aria-label*='play' i]",
    "[class*='play' i]",
    "[id*='play' i]",
    "[role='button']",
    'button',
    'svg'
  ];

  for (const frame of page.frames()) {
    for (const selector of selectors) {
      const loc = frame.locator(selector).first();
      const count = await loc.count().catch(() => 0);

      if (!count) continue;

      await loc.click({ timeout: 300, force: true }).catch(() => {});
      await page.waitForTimeout(80).catch(() => {});
    }
  }
}

async function browserFallback(movieId, targetUrl, debug) {
  const signal = createFoundSignal();
  const apiFetches = new Set();
  const apiSeen = new Set();

  let page;

  try {
    const context = await getSharedContext();
    page = await context.newPage();

    page.setDefaultNavigationTimeout(14000);
    page.setDefaultTimeout(5000);

    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = request.url();
      const type = request.resourceType();

      if (isApiProxyUrl(url)) {
        queueApiFetch(url, targetUrl, debug, signal, apiFetches, apiSeen, 'browser-route-api');
      }

      // Safe blocking only. Do NOT block scripts/xhr/fetch.
      if (type === 'image' || type === 'font' || type === 'stylesheet') {
        return route.abort().catch(() => {});
      }

      return route.continue().catch(() => {});
    });

    await page.addInitScript(() => {
      try {
        const oldFetch = window.fetch;

        window.fetch = function (...args) {
          try {
            console.info('[resolver-fetch]', String(args[0] && (args[0].url || args[0])));
          } catch {}

          return oldFetch.apply(this, args);
        };
      } catch {}

      try {
        const oldOpen = XMLHttpRequest.prototype.open;

        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
          try {
            console.info('[resolver-xhr]', String(url));
          } catch {}

          return oldOpen.call(this, method, url, ...rest);
        };
      } catch {}
    });

    page.on('console', (msg) => {
      const apiUrls = extractApiProxyUrlsFromText(msg.text(), targetUrl);

      for (const apiUrl of apiUrls) {
        queueApiFetch(apiUrl, targetUrl, debug, signal, apiFetches, apiSeen, 'browser-console');
      }
    });

    page.on('request', (request) => {
      const url = request.url();

      if (isApiProxyUrl(url)) {
        queueApiFetch(url, targetUrl, debug, signal, apiFetches, apiSeen, 'browser-request-api');
      }

      const postData = request.postData();

      if (postData) {
        const apiUrls = extractApiProxyUrlsFromText(postData, targetUrl);

        for (const apiUrl of apiUrls) {
          queueApiFetch(apiUrl, targetUrl, debug, signal, apiFetches, apiSeen, 'browser-post-data');
        }
      }
    });

    page.on('response', (response) => {
      const task = (async () => {
        const url = response.url();

        if (isApiProxyUrl(url)) {
          debug.api(url, 'browser-response-api');

          const text = await response.text().catch(() => '');
          const stream = parseM3u8FromApiResponse(text, url, 'browser-response-api');

          if (stream) signal.resolve(stream);
        }
      })()
        .catch(() => {})
        .finally(() => apiFetches.delete(task));

      apiFetches.add(task);
    });

    const safeTargetUrl = addHttpsToBareUrl(repairBrokenProtocol(targetUrl));

    debug.check('browser-goto');

    await page
      .goto(safeTargetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 14000
      })
      .catch(() => null);

    await scanFrameContent(page, targetUrl, debug, signal, apiFetches, apiSeen);

    let clicked = false;
    let lastFrameScan = 0;
    const start = Date.now();
    const end = start + BROWSER_TOTAL_WAIT_MS;

    while (Date.now() < end) {
      const winner = await Promise.race([
        signal.promise,
        sleep(250).then(() => null)
      ]);

      if (winner) {
        return {
          ok: true,
          movieId,
          sourceUrl: targetUrl,
          apiProxyUrl: winner.apiProxyUrl || null,
          stream: winner,
          mode: winner.foundIn || 'browser-api'
        };
      }

      if (!clicked && Date.now() - start > CLICK_AFTER_MS) {
        clicked = true;
        await clickPlayer(page, debug);
      }

      if (Date.now() - lastFrameScan > 900) {
        lastFrameScan = Date.now();
        await scanFrameContent(page, targetUrl, debug, signal, apiFetches, apiSeen);
      }
    }

    const apiResults = await Promise.race([
      Promise.allSettled([...apiFetches]),
      sleep(1000).then(() => [])
    ]).catch(() => []);

    for (const result of apiResults || []) {
      if (result?.status === 'fulfilled' && result.value) {
        return {
          ok: true,
          movieId,
          sourceUrl: targetUrl,
          apiProxyUrl: result.value.apiProxyUrl || null,
          stream: result.value,
          mode: result.value.foundIn || 'browser-api-final'
        };
      }
    }

    return {
      ok: false,
      movieId,
      sourceUrl: targetUrl,
      apiProxyUrl: null,
      stream: null,
      mode: 'browser-none'
    };
  } finally {
    await page?.close().catch(() => {});
  }
}

function getCacheState(movieId) {
  const item = cache.get(movieId);

  if (!item) return null;

  const ageMs = Date.now() - item.savedAt;

  if (ageMs > STALE_CACHE_TTL_MS) {
    cache.delete(movieId);
    return null;
  }

  return {
    data: item.data,
    ageMs,
    fresh: ageMs <= FRESH_CACHE_TTL_MS
  };
}

function attachDebug(data, debug) {
  if (!debug.enabled) return data;

  return {
    ...data,
    debug: debug.data()
  };
}

function removeDebug(data) {
  const copy = { ...data };
  delete copy.debug;
  return copy;
}

async function resolveMovie(movieId, debugEnabled = false) {
  const targetUrl = `https://embed.filmu.in/movie/${encodeURIComponent(movieId)}`;
  const debug = createDebug(debugEnabled);

  const staticResult = await staticResolve(movieId, targetUrl, debug);

  if (staticResult.ok && staticResult.stream) {
    return attachDebug(staticResult, debug);
  }

  if (!ENABLE_BROWSER_FALLBACK) {
    return attachDebug(staticResult, debug);
  }

  const browserResult = await browserFallback(movieId, targetUrl, debug);
  return attachDebug(browserResult, debug);
}

async function resolveMovieCached(movieId, options = {}) {
  const refresh = Boolean(options.refresh);
  const debug = Boolean(options.debug);

  const existing = getCacheState(movieId);

  if (!debug && !refresh && existing?.fresh) {
    return {
      ...existing.data,
      cached: true,
      stale: false,
      cacheAgeMs: existing.ageMs
    };
  }

  if (!debug && pending.has(movieId)) {
    return pending.get(movieId);
  }

  const job = scanLimit(async () => {
    const scanned = await resolveMovie(movieId, debug);

    if (scanned.ok && scanned.stream) {
      const clean = removeDebug(scanned);

      cache.set(movieId, {
        savedAt: Date.now(),
        data: clean
      });

      return {
        ...scanned,
        cached: false,
        stale: false
      };
    }

    if (!debug && existing?.data) {
      return {
        ...existing.data,
        cached: true,
        stale: true,
        cacheAgeMs: existing.ageMs,
        cacheFallbackReason: 'Fresh scan failed, returned stale cached m3u8.'
      };
    }

    return {
      ...scanned,
      cached: false,
      stale: false
    };
  });

  if (!debug) {
    pending.set(movieId, job);
    job.finally(() => pending.delete(movieId));
  }

  return job;
}

app.get('/', (_req, res) => {
  res
    .type('text/plain')
    .send(
      'MovieResolver API\n\nUse: GET /movie/{number}\nExample: /movie/1726\nRefresh: /movie/1726?refresh=1\nDebug: /movie/1726?debug=1\n'
    );
});

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.get('/movie/:id', async (req, res) => {
  const movieId = String(req.params.id || '').trim();

  if (!/^\d+$/.test(movieId)) {
    return jsonError(res, 400, 'Movie id must be a number. Example: /movie/1726');
  }

  const startedAt = Date.now();

  try {
    const scan = await resolveMovieCached(movieId, {
      refresh: req.query.refresh === '1',
      debug: req.query.debug === '1'
    });

    if (!scan.ok || !scan.stream) {
      return jsonError(res, 404, 'No m3u8 source found.', {
        movieId,
        sourceUrl: scan.sourceUrl,
        cached: Boolean(scan.cached),
        stale: Boolean(scan.stale),
        ms: Date.now() - startedAt,
        mode: scan.mode || null,
        debug: scan.debug || undefined
      });
    }

    return res.json({
      ok: true,
      movieId,
      cached: Boolean(scan.cached),
      stale: Boolean(scan.stale),
      cacheAgeMs: scan.cacheAgeMs || 0,
      cacheFallbackReason: scan.cacheFallbackReason || undefined,
      ms: Date.now() - startedAt,
      mode: scan.mode || null,
      sourceUrl: scan.sourceUrl,
      apiProxyUrl: scan.apiProxyUrl || scan.stream.apiProxyUrl || null,

      // main thing you need
      m3u8: scan.stream.url,

      stream: {
        name: scan.stream.name,
        url: scan.stream.url,
        quality: scan.stream.quality,
        type: scan.stream.type,
        headers: scan.stream.headers || {}
      },

      headers: scan.stream.headers || {},
      foundIn: scan.stream.foundIn || scan.mode || null,
      debug: scan.debug || undefined
    });
  } catch (error) {
    return jsonError(res, 500, error.message || 'Scan failed.', {
      ms: Date.now() - startedAt
    });
  }
});

app.use((req, res) => {
  jsonError(res, 404, 'Route not found. Use /movie/{number}.');
});

const server = app.listen(PORT, () => {
  console.log(`MovieResolver API running on port ${PORT}`);

  getSharedContext()
    .then(() => console.log('Chromium warmed up'))
    .catch((error) => console.error('Chromium warmup failed:', error.message));
});

async function shutdown() {
  server.close(() => {});

  try {
    const browser = browserPromise ? await browserPromise.catch(() => null) : null;
    await browser?.close().catch(() => {});
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
