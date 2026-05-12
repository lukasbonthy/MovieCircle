const express = require('express');
const { chromium } = require('playwright');
const {
  extractUrlsFromText,
  parseFoundUrl,
  looksUseful,
  repairBrokenProtocol,
  addHttpsToBareUrl
} = require('./src/extractor');

const app = express();
const PORT = process.env.PORT || 3000;

const FRESH_CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const STALE_CACHE_TTL_MS = Number(process.env.STALE_CACHE_TTL_MS || 24 * 60 * 60 * 1000);

const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 2200);
const SCRIPT_TIMEOUT_MS = Number(process.env.SCRIPT_TIMEOUT_MS || 1800);
const MAX_ASSETS_TO_SCAN = Number(process.env.MAX_ASSETS_TO_SCAN || 30);

const ENABLE_BROWSER_FALLBACK = process.env.ENABLE_BROWSER_FALLBACK !== '0';
const BROWSER_FAST_WAIT_MS = Number(process.env.BROWSER_FAST_WAIT_MS || 1800);
const BROWSER_TOTAL_WAIT_MS = Number(process.env.BROWSER_TOTAL_WAIT_MS || 7500);
const CLICK_AFTER_MS = Number(process.env.CLICK_AFTER_MS || 1200);

const RESPONSE_BODY_LIMIT_BYTES = Number(process.env.RESPONSE_BODY_LIMIT_BYTES || 2 * 1024 * 1024);
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

function firstProxyVideoOnly(items) {
  const seen = new Set();

  for (const item of items.filter(Boolean)) {
    if (item.type !== 'proxy-video') continue;

    const working = item.workingUrl || item.encodedProxyUrl || item.url || '';
    const useful = looksUseful(working) || looksUseful(item.decodedVideoUrl || '');

    if (!useful) continue;

    const key = [item.type, working, item.decodedVideoUrl || ''].join('|');
    if (seen.has(key)) continue;

    seen.add(key);
    return item;
  }

  return null;
}

function createLimiter(max) {
  let active = 0;
  const queue = [];

  async function run(fn, resolve, reject) {
    active++;

    try {
      const value = await fn();
      resolve(value);
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

function createFoundSignal() {
  let resolved = false;
  let resolveNow;

  const promise = new Promise((resolve) => {
    resolveNow = resolve;
  });

  return {
    promise,
    resolve(item) {
      if (!resolved && item) {
        resolved = true;
        resolveNow(item);
      }
    }
  };
}

function createDebug(enabled) {
  const checked = [];
  const usefulUrlsSeen = [];
  const assetUrls = [];
  const seenUrls = new Set();
  const seenAssets = new Set();

  return {
    enabled,

    check(name) {
      if (!enabled) return;
      if (checked.length < 150) checked.push(name);
    },

    url(source, url, note = '') {
      if (!enabled || !url || !looksUseful(url)) return;

      const key = `${source}|${url}`;
      if (seenUrls.has(key)) return;

      seenUrls.add(key);

      if (usefulUrlsSeen.length < 120) {
        usefulUrlsSeen.push({ source, url, note });
      }
    },

    asset(url) {
      if (!enabled || !url) return;
      if (seenAssets.has(url)) return;

      seenAssets.add(url);

      if (assetUrls.length < 80) {
        assetUrls.push(url);
      }
    },

    data() {
      return {
        checked,
        usefulUrlsSeen,
        assetUrls
      };
    }
  };
}

function addParsedItems(found, items, debug, signal) {
  for (const item of items || []) {
    found.push(item);
    debug.url(item.source || 'parsed', item.url || item.workingUrl, 'parsed-proxy');

    const first = firstProxyVideoOnly(found);

    if (first && signal) {
      signal.resolve(first);
    }
  }

  return firstProxyVideoOnly(found);
}

function addFoundFromText(found, text, source, baseUrl, debug, signal) {
  debug.check(source);

  if (!text) return firstProxyVideoOnly(found);

  const items = extractUrlsFromText(text, source, baseUrl);
  return addParsedItems(found, items, debug, signal);
}

function getHeaders(baseUrl) {
  const origin = new URL(baseUrl).origin;

  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,text/javascript,application/javascript,application/json,*/*;q=0.8',
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
      headers: getHeaders(baseUrl)
    });

    const contentType = response.headers.get('content-type') || '';
    const lowerType = contentType.toLowerCase();
    const lowerUrl = url.toLowerCase();

    const blockedType =
      lowerType.includes('image') ||
      lowerType.includes('font') ||
      lowerType.includes('video');

    const usefulFile =
      lowerUrl.includes('.js') ||
      lowerUrl.includes('.json') ||
      lowerUrl.includes('.m3u8') ||
      lowerUrl.includes('proxy') ||
      lowerUrl.includes('player') ||
      lowerUrl.includes('embed') ||
      lowerUrl.includes('api');

    if (blockedType && !usefulFile) {
      return '';
    }

    return await response.text().catch(() => '');
  } catch {
    return '';
  } finally {
    clearTimeout(timeout);
  }
}

function addAsset(set, raw, baseUrl, debug) {
  if (!raw) return;

  try {
    const fixed = addHttpsToBareUrl(repairBrokenProtocol(String(raw).trim()));
    const absolute = new URL(fixed, baseUrl).toString();
    const lower = absolute.toLowerCase();

    const useful =
      lower.includes('proxy') ||
      lower.includes('player') ||
      lower.includes('embed') ||
      lower.includes('/api') ||
      lower.includes('/movie') ||
      lower.includes('filmu') ||
      lower.includes('.js') ||
      lower.includes('.json') ||
      lower.includes('.m3u8');

    if (!useful) return;

    set.add(absolute);
    debug.asset(absolute);
  } catch {}
}

function extractAssetUrls(html, baseUrl, debug) {
  const urls = new Set();
  const text = String(html || '');

  const patterns = [
    /<script[^>]+src=["']([^"']+)["']/gi,
    /<iframe[^>]+src=["']([^"']+)["']/gi,
    /<source[^>]+src=["']([^"']+)["']/gi,
    /<(?:link|a)[^>]+href=["']([^"']+)["']/gi,
    /["']([^"']+\.(?:js|json|m3u8)(?:\?[^"']*)?)["']/gi,
    /["'](\/[^"']*(?:proxy|video|embed|player|movie|api)[^"']*)["']/gi,
    /(?:fetch|open)\(\s*["']([^"']+)["']/gi
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      addAsset(urls, match[1], baseUrl, debug);
    }
  }

  return [...urls].slice(0, MAX_ASSETS_TO_SCAN);
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
  const found = [];

  debug.check('static-html-fetch');

  const html = await fetchText(targetUrl, targetUrl, HTTP_TIMEOUT_MS);
  let first = addFoundFromText(found, html, 'static-html', targetUrl, debug);

  if (first) {
    return {
      ok: true,
      movieId,
      sourceUrl: targetUrl,
      result: first,
      mode: 'static-html'
    };
  }

  const assets = extractAssetUrls(html, targetUrl, debug);

  await mapLimit(assets, 8, async (assetUrl) => {
    if (firstProxyVideoOnly(found)) return;

    debug.check(`static-asset-url:${assetUrl}`);

    const direct = parseFoundUrl(assetUrl, 'static-asset-url', targetUrl);

    if (direct) {
      addParsedItems(found, [direct], debug);
    }

    if (firstProxyVideoOnly(found)) return;

    const text = await fetchText(assetUrl, targetUrl, SCRIPT_TIMEOUT_MS);
    first = addFoundFromText(found, text, 'static-asset-body', assetUrl, debug);

    if (first) return;

    const nestedAssets = extractAssetUrls(text, assetUrl, debug).slice(0, 8);

    for (const nestedUrl of nestedAssets) {
      if (firstProxyVideoOnly(found)) break;

      const nestedText = await fetchText(nestedUrl, targetUrl, SCRIPT_TIMEOUT_MS);
      addFoundFromText(found, nestedText, 'static-nested-asset', nestedUrl, debug);
    }
  });

  first = firstProxyVideoOnly(found);

  return {
    ok: Boolean(first),
    movieId,
    sourceUrl: targetUrl,
    result: first,
    mode: first ? 'static-assets' : 'static-none'
  };
}

function shouldReadResponseBody(url, contentType, headers = {}) {
  const lowerUrl = String(url || '').toLowerCase();
  const lowerType = String(contentType || '').toLowerCase();
  const contentLength = Number(headers['content-length'] || 0);

  if (contentLength && contentLength > RESPONSE_BODY_LIMIT_BYTES) return false;

  return (
    lowerType.includes('text/') ||
    lowerType.includes('json') ||
    lowerType.includes('javascript') ||
    lowerType.includes('xml') ||
    lowerType.includes('mpegurl') ||
    lowerUrl.endsWith('.js') ||
    lowerUrl.includes('.js?') ||
    lowerUrl.endsWith('.json') ||
    lowerUrl.includes('.json?') ||
    lowerUrl.endsWith('.m3u8') ||
    lowerUrl.includes('.m3u8?')
  );
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

async function dumpFrames(page, found, targetUrl, debug, signal) {
  for (const frame of page.frames()) {
    if (firstProxyVideoOnly(found)) return;

    const frameUrl = frame.url();
    const base = frameUrl && frameUrl !== 'about:blank' ? frameUrl : targetUrl;

    debug.check(`browser-frame:${base}`);

    const html = await frame.content().catch(() => '');
    addFoundFromText(found, html, 'browser-frame-html', base, debug, signal);

    if (firstProxyVideoOnly(found)) return;

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

    addFoundFromText(found, storageText, 'browser-storage', base, debug, signal);
  }
}

async function clickPossiblePlayers(page, found, targetUrl, debug, signal) {
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

  debug.check('browser-click-center');

  await page.mouse.click(640, 360).catch(() => {});
  await page.keyboard.press('Space').catch(() => {});
  await page.waitForTimeout(150).catch(() => {});

  if (firstProxyVideoOnly(found)) return;

  for (const frame of page.frames()) {
    for (const selector of selectors) {
      if (firstProxyVideoOnly(found)) return;

      const loc = frame.locator(selector).first();
      const count = await loc.count().catch(() => 0);

      if (!count) continue;

      debug.check(`browser-click:${selector}`);

      await loc
        .click({
          timeout: 350,
          force: true
        })
        .catch(() => {});

      await page.waitForTimeout(100).catch(() => {});
    }
  }

  await dumpFrames(page, found, targetUrl, debug, signal).catch(() => {});
}

async function browserFallback(movieId, targetUrl, debug) {
  const found = [];
  const responseTasks = new Set();
  const signal = createFoundSignal();

  let page;

  function addUrl(url, source, extra = {}) {
    if (!url || !looksUseful(url)) return null;

    debug.url(source, url, 'raw-useful-url');

    const item = parseFoundUrl(url, source, targetUrl);

    if (!item) return null;

    const first = addParsedItems(found, [{ ...item, ...extra }], debug, signal);
    return first;
  }

  try {
    const context = await getSharedContext();
    page = await context.newPage();

    page.setDefaultNavigationTimeout(14000);
    page.setDefaultTimeout(5000);

    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = request.url();
      const type = request.resourceType();

      const first = addUrl(url, 'browser-route', {
        method: request.method(),
        resourceType: type
      });

      // Key speed trick:
      // If the proxy URL appears, capture it, then abort so it does not download.
      if (first) {
        return route.abort().catch(() => {});
      }

      // Safe blocks only. Do not block scripts/xhr/fetch/media before checking URL.
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
      addFoundFromText(found, msg.text(), 'browser-console', targetUrl, debug, signal);
    });

    page.on('request', (request) => {
      addUrl(request.url(), 'browser-request', {
        method: request.method(),
        resourceType: request.resourceType()
      });

      const postData = request.postData();

      if (postData && looksUseful(postData)) {
        addFoundFromText(found, postData, 'browser-post-data', targetUrl, debug, signal);
      }
    });

    page.on('response', (response) => {
      const task = (async () => {
        const url = response.url();
        const headers = response.headers();
        const contentType = headers['content-type'] || '';

        addUrl(url, 'browser-response', {
          status: response.status(),
          contentType
        });

        if (firstProxyVideoOnly(found)) return;

        if (shouldReadResponseBody(url, contentType, headers)) {
          const text = await response.text().catch(() => '');
          addFoundFromText(found, text, 'browser-response-body', url, debug, signal);
        }
      })()
        .catch(() => {})
        .finally(() => responseTasks.delete(task));

      responseTasks.add(task);
    });

    const safeTargetUrl = addHttpsToBareUrl(repairBrokenProtocol(targetUrl));

    debug.check('browser-goto');

    const navPromise = page
      .goto(safeTargetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 14000
      })
      .catch(() => null);

    let first = await Promise.race([
      signal.promise,
      navPromise.then(() => null),
      sleep(BROWSER_FAST_WAIT_MS).then(() => null)
    ]);

    first = first || firstProxyVideoOnly(found);

    if (first) {
      return {
        ok: true,
        movieId,
        sourceUrl: targetUrl,
        result: first,
        mode: 'browser-instant'
      };
    }

    await dumpFrames(page, found, targetUrl, debug, signal).catch(() => {});

    first = firstProxyVideoOnly(found);

    if (first) {
      return {
        ok: true,
        movieId,
        sourceUrl: targetUrl,
        result: first,
        mode: 'browser-frame'
      };
    }

    let clicked = false;
    let lastFrameDump = 0;
    const start = Date.now();
    const end = start + BROWSER_TOTAL_WAIT_MS;

    while (Date.now() < end) {
      first = firstProxyVideoOnly(found);

      if (first) {
        return {
          ok: true,
          movieId,
          sourceUrl: targetUrl,
          result: first,
          mode: 'browser-network'
        };
      }

      if (!clicked && Date.now() - start > CLICK_AFTER_MS) {
        clicked = true;
        await clickPossiblePlayers(page, found, targetUrl, debug, signal);
      }

      if (Date.now() - lastFrameDump > 900) {
        lastFrameDump = Date.now();
        await dumpFrames(page, found, targetUrl, debug, signal).catch(() => {});
      }

      first = await Promise.race([
        signal.promise,
        sleep(250).then(() => null)
      ]);

      if (first) {
        return {
          ok: true,
          movieId,
          sourceUrl: targetUrl,
          result: first,
          mode: 'browser-signal'
        };
      }
    }

    await Promise.race([
      Promise.allSettled([...responseTasks]),
      sleep(700)
    ]).catch(() => {});

    first = firstProxyVideoOnly(found);

    return {
      ok: Boolean(first),
      movieId,
      sourceUrl: targetUrl,
      result: first,
      mode: first ? 'browser-final' : 'browser-none'
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

function withoutDebug(data) {
  if (!data) return data;

  const copy = { ...data };
  delete copy.debug;
  return copy;
}

function attachDebug(data, debug) {
  if (!debug.enabled) return data;

  return {
    ...data,
    debug: debug.data()
  };
}

async function resolveMovie(movieId, debugEnabled = false) {
  const targetUrl = `https://embed.filmu.in/movie/${encodeURIComponent(movieId)}`;
  const debug = createDebug(debugEnabled);

  const staticResult = await staticResolve(movieId, targetUrl, debug);

  if (staticResult.ok && staticResult.result) {
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

    if (scanned.ok && scanned.result) {
      const cleanData = withoutDebug(scanned);

      cache.set(movieId, {
        savedAt: Date.now(),
        data: cleanData
      });

      return {
        ...scanned,
        cached: false,
        stale: false
      };
    }

    // If fresh scan fails but stale cache exists, return stale instead of failing.
    if (!debug && existing?.data) {
      return {
        ...existing.data,
        cached: true,
        stale: true,
        cacheAgeMs: existing.ageMs,
        cacheFallbackReason: 'Fresh scan failed, returned stale cached proxy.'
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

    if (!scan.ok || !scan.result) {
      return jsonError(res, 404, 'No proxy-video URL found.', {
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
      proxyVideo: scan.result.workingUrl || scan.result.encodedProxyUrl || scan.result.url,
      encodedProxyUrl: scan.result.encodedProxyUrl || scan.result.workingUrl || scan.result.url,
      decodedVideoUrl: scan.result.decodedVideoUrl || null,
      referer: scan.result.referer || null,
      origin: scan.result.origin || null,
      foundIn: scan.result.source || null,
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
