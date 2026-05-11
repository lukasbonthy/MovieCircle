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

const FIRST_PASS_WAIT_MS = Number(process.env.FIRST_PASS_WAIT_MS || 3000);
const AFTER_CLICK_WAIT_MS = Number(process.env.AFTER_CLICK_WAIT_MS || 3500);
const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS || 35000);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const RESPONSE_BODY_LIMIT_BYTES = Number(process.env.RESPONSE_BODY_LIMIT_BYTES || 4 * 1024 * 1024);
const BLOCK_IMAGES_FONTS = process.env.BLOCK_IMAGES_FONTS !== '0';

const cache = new Map();
const pending = new Map();
let browserPromise = null;

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function jsonError(res, status, message, extra = {}) {
  return res.status(status).json({ ok: false, error: message, ...extra });
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
          '--autoplay-policy=no-user-gesture-required'
        ]
      })
      .then((browser) => {
        browser.on('disconnected', () => {
          browserPromise = null;
        });
        return browser;
      })
      .catch((error) => {
        browserPromise = null;
        throw error;
      });
  }

  const browser = await browserPromise;
  if (!browser.isConnected()) {
    browserPromise = null;
    return getBrowser();
  }

  return browser;
}

async function dumpFrameContent(page, baseUrl, found) {
  for (const frame of page.frames()) {
    const frameUrl = frame.url();
    const frameBase = frameUrl && frameUrl !== 'about:blank' ? frameUrl : baseUrl;

    const html = await frame.content().catch(() => '');
    if (html) found.push(...extractUrlsFromText(html, 'frame-html', frameBase));

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

    if (storageText) found.push(...extractUrlsFromText(storageText, 'browser-storage', frameBase));
  }
}

async function waitForFirst(page, found, baseUrl, ms, responseTasks) {
  const end = Date.now() + ms;
  let lastDump = 0;

  while (Date.now() < end) {
    const first = firstProxyVideoOnly(found);
    if (first) return first;

    const now = Date.now();

    if (now - lastDump > 900) {
      lastDump = now;

      await dumpFrameContent(page, baseUrl, found).catch(() => {});

      const afterDump = firstProxyVideoOnly(found);
      if (afterDump) return afterDump;
    }

    if (responseTasks.size) {
      await Promise.race([
        Promise.allSettled([...responseTasks]),
        page.waitForTimeout(120).catch(() => {})
      ]).catch(() => {});
    } else {
      await page.waitForTimeout(180).catch(() => {});
    }
  }

  return firstProxyVideoOnly(found);
}

async function clickPossiblePlayers(page, found, targetUrl) {
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

  await page.mouse.click(683, 384).catch(() => {});
  await page.keyboard.press('Space').catch(() => {});
  await page.waitForTimeout(450).catch(() => {});

  if (firstProxyVideoOnly(found)) return;

  for (const frame of page.frames()) {
    for (const selector of selectors) {
      if (firstProxyVideoOnly(found)) return;

      const loc = frame.locator(selector).first();
      const count = await loc.count().catch(() => 0);

      if (!count) continue;

      await loc.click({ timeout: 550, force: true }).catch(() => {});
      await page.waitForTimeout(250).catch(() => {});
    }
  }

  await dumpFrameContent(page, targetUrl, found).catch(() => {});
}

function cached(movieId) {
  const item = cache.get(movieId);

  if (!item) return null;

  if (Date.now() - item.savedAt > CACHE_TTL_MS) {
    cache.delete(movieId);
    return null;
  }

  return item.data;
}

async function tryStaticFetch(targetUrl, found) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);

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
    if (text) found.push(...extractUrlsFromText(text, 'static-fetch', targetUrl));
  } catch {
    // Browser scan below is the real fallback.
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveMovie(movieId) {
  const targetUrl = `https://embed.filmu.in/movie/${encodeURIComponent(movieId)}`;
  const found = [];
  const responseTasks = new Set();

  const direct = parseFoundUrl(targetUrl, 'input-url', targetUrl);
  if (direct && looksUseful(direct.url)) found.push(direct);

  await tryStaticFetch(targetUrl, found);

  let first = firstProxyVideoOnly(found);

  if (first) {
    return {
      ok: true,
      movieId,
      sourceUrl: targetUrl,
      result: first,
      mode: 'static-fetch'
    };
  }

  let context;

  try {
    const browser = await getBrowser();

    context = await browser.newContext({
      viewport: { width: 1365, height: 768 },
      javaScriptEnabled: true,
      bypassCSP: true,
      ignoreHTTPSErrors: true,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    const page = await context.newPage();

    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    page.setDefaultTimeout(6500);

    if (BLOCK_IMAGES_FONTS) {
      await context.route('**/*', async (route) => {
        const request = route.request();
        const url = request.url();
        const type = request.resourceType();

        if (looksUseful(url)) {
          const item = parseFoundUrl(url, 'network-route', targetUrl);
          if (item) found.push({ ...item, method: request.method(), resourceType: type });
        }

        if (type === 'image' || type === 'font') {
          return route.abort().catch(() => {});
        }

        return route.continue().catch(() => {});
      });
    }

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
      found.push(...extractUrlsFromText(msg.text(), 'console', targetUrl));
    });

    page.on('request', (request) => {
      const url = request.url();

      if (looksUseful(url)) {
        const item = parseFoundUrl(url, 'network-request', targetUrl);
        if (item) found.push({ ...item, method: request.method(), resourceType: request.resourceType() });
      }

      const postData = request.postData();

      if (postData && looksUseful(postData)) {
        found.push(...extractUrlsFromText(postData, 'request-post-data', targetUrl));
      }
    });

    page.on('response', (response) => {
      const task = (async () => {
        const url = response.url();
        const headers = response.headers();
        const contentType = headers['content-type'] || '';

        if (
          looksUseful(url) ||
          String(contentType).includes('video') ||
          String(contentType).includes('mpegurl')
        ) {
          const item = parseFoundUrl(url, 'network-response', targetUrl);
          if (item) found.push({ ...item, status: response.status(), contentType });
        }

        if (shouldReadResponseBody(url, contentType, headers)) {
          const text = await response.text().catch(() => '');
          if (text) found.push(...extractUrlsFromText(text, 'response-body', url));
        }
      })()
        .catch(() => {})
        .finally(() => responseTasks.delete(task));

      responseTasks.add(task);
    });

    const safeTargetUrl = addHttpsToBareUrl(repairBrokenProtocol(targetUrl));

    await page.goto(safeTargetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT_MS
    }).catch(() => {});

    first = await waitForFirst(page, found, targetUrl, FIRST_PASS_WAIT_MS, responseTasks);

    if (first) {
      return {
        ok: true,
        movieId,
        sourceUrl: targetUrl,
        result: first,
        mode: 'browser-fast-pass'
      };
    }

    await clickPossiblePlayers(page, found, targetUrl);

    first = await waitForFirst(page, found, targetUrl, AFTER_CLICK_WAIT_MS, responseTasks);

    if (first) {
      return {
        ok: true,
        movieId,
        sourceUrl: targetUrl,
        result: first,
        mode: 'browser-after-click'
      };
    }

    await Promise.race([
      Promise.allSettled([...responseTasks]),
      page.waitForTimeout(900).catch(() => {})
    ]).catch(() => {});

    first = firstProxyVideoOnly(found);

    return {
      ok: Boolean(first),
      movieId,
      sourceUrl: targetUrl,
      result: first,
      mode: 'browser-final'
    };
  } finally {
    await context?.close().catch(() => {});
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

  if (pending.has(movieId)) return pending.get(movieId);

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
    .send('MovieResolver API\n\nUse: GET /movie/{number}\nExample: /movie/1726\nRefresh: /movie/1726?refresh=1\n');
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

  getBrowser()
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
