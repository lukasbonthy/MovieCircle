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
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/[),.;'"<>`\]}]+$/g, '');
}

function normalizeUrl(raw = '', baseUrl = '') {
  if (!raw) return null;

  let value = trimUrl(cleanText(raw));

  if (value.startsWith('ttps://')) value = `h${value}`;
  if (value.startsWith('//')) value = `https:${value}`;

  if (/^https%3A%2F%2F/i.test(value)) {
    value = safeDecode(value);
  }

  try {
    return new URL(value, baseUrl || undefined).toString();
  } catch {
    return null;
  }
}

function isApiProxy(url = '') {
  try {
    const parsed = new URL(normalizeUrl(url) || url);
    return parsed.pathname === '/api/proxy' && parsed.searchParams.has('path');
  } catch {
    return false;
  }
}

function isM3u8Url(url = '') {
  return safeDecode(cleanText(url)).toLowerCase().includes('.m3u8');
}

function extractApiProxyUrls(text = '', baseUrl = '') {
  const cleaned = cleanText(text);
  const out = [];
  const seen = new Set();

  const patterns = [
    /https?:\/\/[^\s'"<>`]+\/api\/proxy\?path=[^\s'"<>`]+/gi,
    /\/\/[^\s'"<>`]+\/api\/proxy\?path=[^\s'"<>`]+/gi,
    /\/api\/proxy\?path=[^\s'"<>`]+/gi,
    /api\/proxy\?path=[^\s'"<>`]+/gi,
    /['"]([^'"]*\/api\/proxy\?path=[^'"]+)['"]/gi,
    /['"]([^'"]*api\/proxy\?path=[^'"]+)['"]/gi
  ];

  for (const pattern of patterns) {
    for (const match of cleaned.matchAll(pattern)) {
      const raw = match[1] || match[0];
      const absolute = normalizeUrl(raw, baseUrl);

      if (!absolute) continue;
      if (!isApiProxy(absolute)) continue;
      if (seen.has(absolute)) continue;

      seen.add(absolute);
      out.push(absolute);
    }
  }

  return out;
}

function extractAssetUrls(text = '', baseUrl = '', max = 80) {
  const cleaned = cleanText(text);
  const out = [];
  const seen = new Set();

  const patterns = [
    /<script[^>]+src=['"]([^'"]+)['"]/gi,
    /<iframe[^>]+src=['"]([^'"]+)['"]/gi,
    /<(?:link|a)[^>]+href=['"]([^'"]+)['"]/gi,
    /['"]([^'"]+\.(?:js|json)(?:\?[^'"]*)?)['"]/gi,
    /['"]([^'"]*(?:api|proxy|scrape|embed|player|movie)[^'"]*)['"]/gi,
    /(?:fetch|open)\(\s*['"]([^'"]+)['"]/gi
  ];

  for (const pattern of patterns) {
    for (const match of cleaned.matchAll(pattern)) {
      const absolute = normalizeUrl(match[1], baseUrl);
      if (!absolute) continue;

      const lower = absolute.toLowerCase();
      const useful =
        lower.includes('/api/proxy') ||
        lower.includes('.js') ||
        lower.includes('.json') ||
        lower.includes('api') ||
        lower.includes('proxy') ||
        lower.includes('scrape') ||
        lower.includes('embed') ||
        lower.includes('player') ||
        lower.includes('movie');

      if (!useful) continue;
      if (seen.has(absolute)) continue;

      seen.add(absolute);
      out.push(absolute);

      if (out.length >= max) return out;
    }
  }

  return out;
}

function findFirstM3u8Object(value, apiProxyUrl = '', foundIn = 'unknown') {
  if (!value) return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstM3u8Object(item, apiProxyUrl, foundIn);
      if (found) return found;
    }
    return null;
  }

  if (typeof value === 'object') {
    const possibleUrl = value.url || value.file || value.src || value.link;

    if (possibleUrl && isM3u8Url(possibleUrl)) {
      return {
        name: value.name || value.label || null,
        url: String(possibleUrl),
        quality: value.quality || value.resolution || null,
        type: 'm3u8',
        headers: value.headers || value.requestHeaders || {},
        apiProxyUrl,
        foundIn
      };
    }

    // Important: preserve original order. sources first because the wanted JSON uses sources[].
    if (Array.isArray(value.sources)) {
      for (const source of value.sources) {
        const found = findFirstM3u8Object(source, apiProxyUrl, foundIn);
        if (found) return found;
      }
    }

    for (const nested of Object.values(value)) {
      const found = findFirstM3u8Object(nested, apiProxyUrl, foundIn);
      if (found) return found;
    }
  }

  return null;
}

function findFirstM3u8(text = '', apiProxyUrl = '', foundIn = 'unknown') {
  const cleaned = cleanText(text);

  try {
    const parsed = JSON.parse(cleaned);
    const fromJson = findFirstM3u8Object(parsed, apiProxyUrl, foundIn);
    if (fromJson) return fromJson;
  } catch {}

  const match = cleaned.match(/https?:\/\/[^\s'"<>`]+?\.m3u8[^\s'"<>`]*/i);

  if (match) {
    return {
      name: null,
      url: trimUrl(match[0]),
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
  cleanText,
  safeDecode,
  normalizeUrl,
  isApiProxy,
  isM3u8Url,
  extractApiProxyUrls,
  extractAssetUrls,
  findFirstM3u8
};
