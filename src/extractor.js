function repairBrokenProtocol(value = '') {
  return String(value)
    .replace(/^ttps:\/\//i, 'https://')
    .replace(/^hhttps:\/\//i, 'https://');
}

function addHttpsToBareUrl(value = '') {
  const text = String(value).trim();

  if (/^https?:\/\//i.test(text)) return text;
  if (/^\/\//.test(text)) return `https:${text}`;

  if (/^[a-z0-9.-]+\.[a-z]{2,}\//i.test(text)) {
    return `https://${text}`;
  }

  return text;
}

function cleanText(text = '') {
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/')
    .replace(/%5Cu0026/gi, '%26');
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

function toAbsoluteUrl(raw, baseUrl) {
  if (!raw) return null;

  let candidate = trimUrl(cleanText(raw));
  candidate = repairBrokenProtocol(candidate);

  if (/^https%3A%2F%2F/i.test(candidate)) {
    candidate = safeDecode(candidate);
  }

  if (candidate.startsWith('//')) {
    candidate = `https:${candidate}`;
  }

  try {
    return new URL(candidate, baseUrl || undefined).toString();
  } catch {
    return null;
  }
}

function isApiProxyUrl(url) {
  try {
    const parsed = new URL(addHttpsToBareUrl(repairBrokenProtocol(url)));
    const decoded = safeDecode(parsed.toString()).toLowerCase();

    return (
      parsed.pathname === '/api/proxy' &&
      parsed.searchParams.has('path') &&
      decoded.includes('/api/proxy?path=')
    );
  } catch {
    return false;
  }
}

function extractApiProxyUrlsFromText(text = '', baseUrl = '') {
  const cleaned = cleanText(text);
  const results = [];
  const seen = new Set();

  const patterns = [
    /(?:https?:\/\/|ttps:\/\/|\/\/)[^\s"'<>`]+/gi,
    /https%3A%2F%2F[^\s"'<>`]+/gi,
    /\/api\/proxy\?path=[^\s"'<>`]+/gi,
    /api\/proxy\?path=[^\s"'<>`]+/gi,
    /["']([^"']*\/api\/proxy\?path=[^"']+)["']/gi
  ];

  for (const pattern of patterns) {
    for (const match of cleaned.matchAll(pattern)) {
      const raw = match[1] || match[0];
      const absolute = toAbsoluteUrl(raw, baseUrl);

      if (!absolute) continue;
      if (!isApiProxyUrl(absolute)) continue;
      if (seen.has(absolute)) continue;

      seen.add(absolute);
      results.push(absolute);
    }
  }

  return results;
}

function extractAssetUrls(text = '', baseUrl = '', max = 40) {
  const cleaned = cleanText(text);
  const urls = [];
  const seen = new Set();

  const patterns = [
    /<script[^>]+src=["']([^"']+)["']/gi,
    /<iframe[^>]+src=["']([^"']+)["']/gi,
    /<source[^>]+src=["']([^"']+)["']/gi,
    /<(?:link|a)[^>]+href=["']([^"']+)["']/gi,
    /["']([^"']+\.(?:js|json|m3u8)(?:\?[^"']*)?)["']/gi,
    /["'](\/[^"']*(?:api|proxy|scrape|vidrock|movie|player|embed)[^"']*)["']/gi,
    /(?:fetch|open)\(\s*["']([^"']+)["']/gi
  ];

  for (const pattern of patterns) {
    for (const match of cleaned.matchAll(pattern)) {
      const raw = match[1] || match[0];
      const absolute = toAbsoluteUrl(raw, baseUrl);

      if (!absolute) continue;

      const lower = absolute.toLowerCase();

      const useful =
        lower.includes('/api/proxy') ||
        lower.includes('vidrock') ||
        lower.includes('scrape') ||
        lower.includes('player') ||
        lower.includes('embed') ||
        lower.includes('/movie') ||
        lower.includes('.js') ||
        lower.includes('.json') ||
        lower.includes('.m3u8');

      if (!useful) continue;
      if (seen.has(absolute)) continue;

      seen.add(absolute);
      urls.push(absolute);

      if (urls.length >= max) return urls;
    }
  }

  return urls;
}

function findSourcesDeep(value, output = []) {
  if (!value || typeof value !== 'object') return output;

  if (Array.isArray(value)) {
    for (const item of value) {
      findSourcesDeep(item, output);
    }

    return output;
  }

  if (Array.isArray(value.sources)) {
    output.push(...value.sources);
  }

  for (const item of Object.values(value)) {
    findSourcesDeep(item, output);
  }

  return output;
}

function normalizeStreamSource(source, apiProxyUrl, foundIn) {
  if (!source || typeof source !== 'object') return null;

  const url = source.url || source.file || source.src;

  if (!url || !String(url).includes('.m3u8')) return null;

  return {
    name: source.name || 'Unknown',
    url,
    quality: source.quality || null,
    type: source.type || 'm3u8',
    headers: source.headers || {},
    apiProxyUrl,
    foundIn
  };
}

function parseM3u8FromApiResponse(text = '', apiProxyUrl = '', foundIn = 'api-response') {
  const cleaned = cleanText(text);

  try {
    const json = JSON.parse(cleaned);
    const sources = findSourcesDeep(json);

    const m3u8 = sources
      .map((source) => normalizeStreamSource(source, apiProxyUrl, foundIn))
      .find(Boolean);

    if (m3u8) return m3u8;
  } catch {
    // Fallback below.
  }

  const directMatch = cleaned.match(/https?:\/\/[^\s"'<>`]+\.m3u8[^\s"'<>`]*/i);

  if (directMatch) {
    return {
      name: 'Direct m3u8',
      url: trimUrl(directMatch[0]),
      quality: null,
      type: 'm3u8',
      headers: {},
      apiProxyUrl,
      foundIn
    };
  }

  return null;
}

module.exports = {
  repairBrokenProtocol,
  addHttpsToBareUrl,
  cleanText,
  safeDecode,
  trimUrl,
  toAbsoluteUrl,
  isApiProxyUrl,
  extractApiProxyUrlsFromText,
  extractAssetUrls,
  parseM3u8FromApiResponse
};
