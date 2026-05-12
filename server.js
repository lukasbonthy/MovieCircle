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

// Faster defaults
const FIRST_PASS_WAIT_MS = Number(process.env.FIRST_PASS_WAIT_MS || 700);
const AFTER_CLICK_WAIT_MS = Number(process.env.AFTER_CLICK_WAIT_MS || 1200);
const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS || 12000);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const RESPONSE_BODY_LIMIT_BYTES = Number(process.env.RESPONSE_BODY_LIMIT_BYTES || 500 * 1024);
const STATIC_FETCH_TIMEOUT_MS = Number(process.env.STATIC_FETCH_TIMEOUT_MS || 700);

const cache = new Map();
const pending = new Map();

let browserPromise = null;
let contextPromise = null;

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

function jsonError(res, status, message, extra = {}) {
  return res.status(status).json({
    ok: false,
    error: message,
    ...extra
  });
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

function createProxyCollector(found) {
  let resolved = false;
  let resolveFirst;

  const promise = new Promise((resolve) => {
    resolveFirst = resolve;
  });

  function check() {
    const first = firstProxyVideoOnly(found);

    if (first && !resolved) {
      resolved = true;
      resolveFirst(first);
    }

    return first;
  }

  function add(item) {
    if (!item) return null;
    found.push(item);
    return check();
  }

  function addMany(items) {
    for (const item of items || []) {
      add(item);
    }

    return check();
  }

  return {
    promise,
    add,
    addMany,
    check
  };
}

function shouldReadResponseBody(url, contentType, headers = {}) {
  const lowerUrl = String(url || '').toLowerCase();
  const lowerType = String(contentType || '').toLowerCase();
  const contentLength = Number(headers['content-length'] || 0);

  if (contentLength && contentLength > RESPONSE_BODY_LIMIT_BYTES) {
    return false;
  }

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
      .then((browser) => {
        return browser.newContext({
          viewport: {
            width: 1280,
            height: 720
          },
          javaScriptEnabled: true,
          bypassCSP: true,
          ignoreHTTPSErrors: true,
          serviceWorkers: 'block',
          userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          extraHTTPHeaders: {
            'Accept-Language': 'en-US,en;q=0.9'
          }
        });
      })
      .catch((error) => {
        contextPromise = null;
        throw error;
      });
  }

  return contextPromise;
}

async function dumpFrameContent(page, baseUrl, found, collector) {
  for (const frame of page.frames()) {
    const frameUrl = frame.url();
    const frameBase = frameUrl && frameUrl !== 'about:blank' ? frameUrl : baseUrl;

    const html = await frame.content().catch(() => '');

    if (html) {
      collector.addMany(extractUrlsFromText(html, 'frame-html', frameBase));
    }

    if (collector.check()) return;

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

    if (storageText) {
      collector.addMany(extractUrlsFromText(storageText, 'browser-storage', frameBase));
    }

    if (collector.check()) return;
  }
}

async function clickPossiblePlayers(page, found, targetUrl, collector) {
  const selectors = [
    'video',
    '.jw-icon-playback',
    '.vjs-big-play-button',
    '.plyr__control',
    "[aria-label*='play' i]",
    "[class*='play' i]",
    "[id*='play' i]",
    "[role='button']",
    'button'
  ];

  await page.mouse.click(640, 360).catch(() => {});
  await page.keyboard.press('Space').catch(() => {});
  await page.waitForTimeout(150).catch(() => {});

  if (collector.check()) return;

  for (const frame of page.frames()) {
    for (const selector of selectors) {
      if (collector.check()) return;

      const loc = frame.locator(selector).first();
      const count = await loc.count().catch(() => 0);

      if (!count) continue;

      await loc
        .click({
          timeout: 250,
          force: true
        })
        .catch(() => {});

      await page.waitForTimeout(80).catch(() => {});
    }
  }

  await dumpFrameContent(page, targetUrl, found, collector).catch(() => {});
}

function cached(movieId) {
  const item = cache.get(movieId);

  if (!item) {
    return null;
  }

  if (Date.now() - item.savedAt > CACHE_TTL_MS) {
    cache.delete(movieId);
    return null;
  }

  return item.data;
}

async function tryStaticFetch(targetUrl, found, collector) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STATIC_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(targetUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    const text = await response.text().catch(() => '');

    if (text) {
      collector.addMany(extractUrlsFromText(text, 'static-fetch', targetUrl));
    }
  } catch {
    // Chromium scan handles it.
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveMovie(movieId) {
  const targetUrl = `https://embed.filmu.in/movie/${encodeURIComponent(movieId)}`;
  const found = [];
  const responseTasks = new Set();
  const collector = createProxyCollector(found);

  let page;

  const direct = parseFoundUrl(targetUrl, 'input-url', targetUrl);

  if (direct && looksUseful(direct.url)) {
    collector.add(direct);
  }

  await tryStaticFetch(targetUrl, found, collector);

  let first = collector.check();

  if (first) {
    return {
      ok: true,
      movieId,
      sourceUrl: targetUrl,
      result: first,
      mode: 'static-fetch'
    };
  }

  try {
    const context = await getSharedContext();
    page = await context.newPage();

    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    page.setDefaultTimeout(3000);

    function addUrl(url, source, extra = {}) {
      if (!url || !looksUseful(url)) return;

      const item = parseFoundUrl(url, source, targetUrl);

      if (item) {
        collector.add({
          ...item,
          ...extra
        });
      }
    }

    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = request.url();
      const type = request.resourceType();

      addUrl(url, 'network-route', {
        method: request.method(),
        resourceType: type
      });

      // Capture URLs, then block heavy downloads.
      // Do NOT block script/xhr/fetch because those usually reveal the proxy.
      if (
        type === 'image' ||
        type === 'font' ||
        type === 'stylesheet' ||
        type === 'media'
      ) {
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
      collector.addMany(extractUrlsFromText(msg.text(), 'console', targetUrl));
    });

    page.on('request', (request) => {
      const url = request.url();

      addUrl(url, 'network-request', {
        method: request.method(),
        resourceType: request.resourceType()
      });

      const postData = request.postData();

      if (postData && looksUseful(postData)) {
        collector.addMany(extractUrlsFromText(postData, 'request-post-data', targetUrl));
      }
    });

    page.on('response', (response) => {
      const task = (async () => {
        const url = response.url();
        const headers = response.headers();
        const contentType = headers['content-type'] || '';

        addUrl(url, 'network-response', {
          status: response.status(),
          contentType
        });

        // Save time. Only scan response body if we still have not found proxy-video.
        if (collector.check()) return;

        if (shouldReadResponseBody(url, contentType, headers)) {
          const text = await response.text().catch(() => '');

          if (text) {
            collector.addMany(extractUrlsFromText(text, 'response-body', url));
          }
        }
      })()
        .catch(() => {})
        .finally(() => responseTasks.delete(task));

      responseTasks.add(task);
    });

    const safeTargetUrl = addHttpsToBareUrl(repairBrokenProtocol(targetUrl));

    const navPromise = page
      .goto(safeTargetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT_MS
      })
      .catch(() => null);

    // This is the speed boost:
    // it returns immediately when any request/console/response reveals proxy-video.
    first = await Promise.race([
      collector.promise,
      navPromise.then(() => null),
      page.waitForTimeout(FIRST_PASS_WAIT_MS).then(() => null)
    ]);

    first = first || collector.check();

    if (first) {
      return {
        ok: true,
        movieId,
        sourceUrl: targetUrl,
        result: first,
        mode: 'instant-network'
      };
    }

    await dumpFrameContent(page, targetUrl, found, collector).catch(() => {});

    first = collector.check();

    if (first) {
      return {
        ok: true,
        movieId,
        sourceUrl: targetUrl,
        result: first,
        mode: 'frame-dump'
      };
    }

    await clickPossiblePlayers(page, found, targetUrl, collector);

    first = await Promise.race([
      collector.promise,
      page.waitForTimeout(AFTER_CLICK_WAIT_MS).then(() => null)
    ]);

    first = first || collector.check();

    if (first) {
      return {
        ok: true,
        movieId,
        sourceUrl: targetUrl,
        result: first,
        mode: 'after-click'
      };
    }

    await Promise.race([
      Promise.allSettled([...responseTasks]),
      page.waitForTimeout(300).catch(() => {})
    ]).catch(() => {});

    first = collector.check();

    return {
      ok: Boolean(first),
      movieId,
      sourceUrl: targetUrl,
      result: first,
      mode: 'browser-final'
    };
  } finally {
    await page?.close().catch(() => {});
  }
}

async function resolveMovieCached(movieId, refresh = false) {
  if (!refresh) {
    const hit = cached(movieId);

    if (hit) {
      return {
        ...hit,
        cached: true
      };
    }
  }

  if (pending.has(movieId)) {
    return pending.get(movieId);
  }

  const job = resolveMovie(movieId)
    .then((data) => {
      if (data.ok && data.result) {
        cache.set(movieId, {
          savedAt: Date.now(),
          data
        });
      }

      return {
        ...data,
        cached: false
      };
    })
    .finally(() => pending.delete(movieId));

  pending.set(movieId, job);

  return job;
}

app.get('/', (_req, res) => {
  res
    .type('text/plain')
    .send(
      'MovieResolver API\n\nUse: GET /movie/{number}\nExample: /movie/1726\nRefresh: /movie/1726?refresh=1\n'
    );
});

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true
  });
});

app.get('/movie/:id', async (req, res) => {
  const movieId = String(req.params.id || '').trim();

  if (!/^\d+$/.test(movieId)) {
    return jsonError(res, 400, 'Movie id must be a number. Example: /movie/1726');
  }

  const startedAt = Date.now();

  try {
    const scan = await resolveMovieCached(movieId, req.query.refresh === '1');

    if (!scan.ok || !scan.result) {
      return jsonError(res, 404, 'No proxy-video URL found.', {
        movieId,
        sourceUrl: scan.sourceUrl,
        cached: Boolean(scan.cached),
        ms: Date.now() - startedAt,
        mode: scan.mode || null
      });
    }

    return res.json({
      ok: true,
      movieId,
      cached: Boolean(scan.cached),
      ms: Date.now() - startedAt,
      mode: scan.mode || null,
      sourceUrl: scan.sourceUrl,
      proxyVideo: scan.result.workingUrl || scan.result.encodedProxyUrl || scan.result.url,
      encodedProxyUrl: scan.result.encodedProxyUrl || scan.result.workingUrl || scan.result.url,
      decodedVideoUrl: scan.result.decodedVideoUrl || null,
      referer: scan.result.referer || null,
      origin: scan.result.origin || null,
      foundIn: scan.result.source || null
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
    .then(() => console.log('Chromium context warmed up'))
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
