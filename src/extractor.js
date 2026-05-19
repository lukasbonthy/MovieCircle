function cleanText(text = '') {
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => {
      try {
        return String.fromCharCode(parseInt(hex, 16));
      } catch {
        return _;
      }
    })
    .replace(/\\\//g, '/');
}

function safeDecode(value = '') {
  let output = String(value);

  for (let i = 0; i < 5; i++) {
    try {
      const decoded = decodeURIComponent(output);
      if (decoded === output) break;
      output = decoded;
    } catch {
      break;
    }
  }

  return output;
}

function trimUrl(url = '') {
  return String(url)
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[),.;"'<>`\]}]+$/g, '');
}

function normalizeUrl(raw = '', baseUrl = '') {
  if (!raw) return null;

  let value = trimUrl(cleanText(raw));

  if (value.startsWith('ttps://')) value = `h${value}`;
  if (value.startsWith('//')) value = `https:${value}`;

  if (/^https%3A%2F%2F/i.test(value)) {
    value = safeDecode(value);
  }

  if (/^[a-z0-9.-]+\.[a-z]{2,}\//i.test(value)) {
    value = `https://${value}`;
  }

  try {
    return new URL(value, baseUrl || undefined).toString();
  } catch {
    return null;
  }
}

function isMediaUrl(url = '') {
  const decoded = safeDecode(cleanText(url)).toLowerCase();

  return (
    decoded.includes('.m3u8') ||
    decoded.includes('.mp4') ||
    decoded.includes('.webm') ||
    decoded.includes('.m4v') ||
    decoded.includes('.mov')
  );
}

function mediaType(url = '', fallback = '') {
  const decoded = safeDecode(cleanText(url)).toLowerCase();

  if (decoded.includes('.m3u8')) return 'm3u8';
  if (decoded.includes('.mp4')) return 'mp4';
  if (decoded.includes('.webm')) return 'webm';
  if (decoded.includes('.m4v')) return 'm4v';
  if (decoded.includes('.mov')) return 'mov';

  return fallback || 'media';
}

function isApiProxy(url = '') {
  try {
    const parsed = new URL(url);
    return parsed.pathname === '/api/proxy' && parsed.searchParams.has('path');
  } catch {
    return false;
  }
}

function isCrawlCandidate(url = '') {
  const decoded = safeDecode(cleanText(url)).toLowerCase();

  return (
    isMediaUrl(decoded) ||
    decoded.includes('/api/proxy') ||
    decoded.includes('/api/') ||
    decoded.includes('/scrape/') ||
    decoded.includes('proxy') ||
    decoded.includes('embed') ||
    decoded.includes('player') ||
    decoded.includes('movie') ||
    decoded.includes('stream') ||
    decoded.includes('source') ||
    decoded.includes('vidrock') ||
    decoded.includes('.js') ||
    decoded.includes('.json') ||
    decoded.includes('.m3u8')
  );
}

function normalizeSource(rawSource, baseUrl = '', foundIn = 'unknown') {
  if (!rawSource) return null;

  let rawUrl = null;
  let name = null;
  let quality = null;
  let type = null;
  let headers = {};

  if (typeof rawSource === 'string') {
    rawUrl = rawSource;
  } else if (typeof rawSource === 'object') {
    rawUrl =
      rawSource.url ||
      rawSource.file ||
      rawSource.src ||
      rawSource.link ||
      rawSource.workerProxyUrl ||
      null;

    name = rawSource.name || rawSource.label || rawSource.server || null;
    quality = rawSource.quality || rawSource.resolution || null;
    type = rawSource.type || null;
    headers = rawSource.headers || rawSource.requestHeaders || {};
  }

  const url = normalizeUrl(rawUrl, baseUrl);
  if (!url) return null;

  if (!isMediaUrl(url) && !isMediaUrl(safeDecode(url)) && type !== 'm3u8') {
    return null;
  }

  return {
    name,
    url,
    type: mediaType(url, type),
    quality,
    headers,
    foundIn
  };
}

function findSourcesDeep(value, baseUrl, foundIn, output = []) {
  if (!value) return output;

  if (Array.isArray(value)) {
    for (const item of value) {
      findSourcesDeep(item, baseUrl, foundIn, output);
    }

    return output;
  }

  if (typeof value === 'object') {
    const direct = normalizeSource(value, baseUrl, foundIn);
    if (direct) output.push(direct);

    if (Array.isArray(value.sources)) {
      for (const source of value.sources) {
        const parsed = normalizeSource(source, baseUrl, foundIn);
        if (parsed) output.push(parsed);
        findSourcesDeep(source, baseUrl, foundIn, output);
      }
    }

    for (const nested of Object.values(value)) {
      findSourcesDeep(nested, baseUrl, foundIn, output);
    }
  }

  return output;
}

function extractPlaylistSources(text = '', baseUrl = '', foundIn = 'playlist') {
  const cleaned = cleanText(text);
  const lines = cleaned.split(/\r?\n/);

  if (!cleaned.includes('#EXTM3U')) return [];

  const sources = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) continue;

    const url = normalizeUrl(trimmed, baseUrl);
    if (!url) continue;

    if (isMediaUrl(url)) {
      sources.push({
        name: null,
        url,
        type: mediaType(url),
        quality: null,
        headers: {},
        foundIn
      });
    }
  }

  return sources;
}

function extractSourcesFromText(text = '', baseUrl = '', foundIn = 'text') {
  const cleaned = cleanText(text);
  const sources = [];

  try {
    const json = JSON.parse(cleaned);
    sources.push(...findSourcesDeep(json, baseUrl, foundIn));
  } catch {}

  sources.push(...extractPlaylistSources(cleaned, baseUrl, foundIn));

  const patterns = [
    /https?:\/\/[^\s"'<>`]+?(?:\.m3u8|\.mp4|\.webm|\.m4v|\.mov)(?:[^\s"'<>`]*)?/gi,
    /https%3A%2F%2F[^\s"'<>`]+?(?:m3u8|mp4|webm|m4v|mov)[^\s"'<>`]*/gi,
    /["']([^"']+?(?:\.m3u8|\.mp4|\.webm|\.m4v|\.mov)(?:\?[^"']*)?)["']/gi
  ];

  for (const pattern of patterns) {
    for (const match of cleaned.matchAll(pattern)) {
      const raw = match[1] || match[0];
      const source = normalizeSource(raw, baseUrl, foundIn);

      if (source) sources.push(source);
    }
  }

  return dedupeSources(sources);
}

function extractUrlsFromText(text = '', baseUrl = '') {
  const cleaned = cleanText(text);
  const urls = [];
  const seen = new Set();

  const patterns = [
    /https?:\/\/[^\s"'<>`]+/gi,
    /ttps:\/\/[^\s"'<>`]+/gi,
    /\/\/[^\s"'<>`]+/gi,
    /https%3A%2F%2F[^\s"'<>`]+/gi,
    /\/api\/proxy\?path=[^\s"'<>`]+/gi,
    /\/[^\s"'<>`]*?(?:api|proxy|scrape|embed|player|movie|stream|source)[^\s"'<>`]*/gi,
    /<script[^>]+src=["']([^"']+)["']/gi,
    /<iframe[^>]+src=["']([^"']+)["']/gi,
    /<(?:source|video|a|link)[^>]+(?:src|href)=["']([^"']+)["']/gi,
    /(?:fetch|open)\(\s*["']([^"']+)["']/gi,
    /["']([^"']+\.(?:js|json|m3u8|mp4)(?:\?[^"']*)?)["']/gi,
    /["']([^"']*(?:api|proxy|scrape|embed|player|movie|stream|source)[^"']*)["']/gi
  ];

  for (const pattern of patterns) {
    for (const match of cleaned.matchAll(pattern)) {
      const raw = match[1] || match[0];
      const url = normalizeUrl(raw, baseUrl);

      if (!url) continue;
      if (!isCrawlCandidate(url)) continue;
      if (seen.has(url)) continue;

      seen.add(url);
      urls.push(url);
    }
  }

  return urls.sort((a, b) => crawlPriority(b) - crawlPriority(a));
}

function crawlPriority(url = '') {
  const lower = safeDecode(url).toLowerCase();

  if (lower.includes('.m3u8')) return 100;
  if (lower.includes('/api/proxy')) return 90;
  if (lower.includes('.mp4')) return 85;
  if (lower.includes('/scrape/')) return 80;
  if (lower.includes('.json')) return 70;
  if (lower.includes('.js')) return 60;
  if (lower.includes('player')) return 55;
  if (lower.includes('embed')) return 50;

  return 10;
}

function sourceScore(source) {
  const type = String(source.type || '').toLowerCase();
  const quality = String(source.quality || '');

  let score = 0;

  if (type === 'm3u8') score += 1000;
  if (type === 'mp4') score += 700;
  if (source.url && source.url.includes('.m3u8')) score += 200;
  if (source.url && source.url.includes('.mp4')) score += 100;

  const qualityNumber = Number((quality.match(/\d+/) || [0])[0]);
  score += qualityNumber;

  return score;
}

function dedupeSources(sources = []) {
  const seen = new Set();
  const output = [];

  for (const source of sources) {
    if (!source || !source.url) continue;

    const key = `${source.url}|${JSON.stringify(source.headers || {})}`;
    if (seen.has(key)) continue;

    seen.add(key);
    output.push(source);
  }

  return output.sort((a, b) => sourceScore(b) - sourceScore(a));
}

module.exports = {
  cleanText,
  safeDecode,
  normalizeUrl,
  isMediaUrl,
  mediaType,
  isApiProxy,
  isCrawlCandidate,
  extractSourcesFromText,
  extractUrlsFromText,
  dedupeSources,
  sourceScore
};
