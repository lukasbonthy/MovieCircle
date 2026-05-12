function cleanText(text = '') {
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/');
}

function trimUrl(url = '') {
  return String(url)
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[),.;"'<>`\]}]+$/g, '');
}

function toAbsolute(raw, baseUrl) {
  if (!raw) return null;

  let value = trimUrl(cleanText(raw));

  if (value.startsWith('ttps://')) value = `h${value}`;
  if (value.startsWith('//')) value = `https:${value}`;

  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
}

function isApiProxy(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname === '/api/proxy' && parsed.searchParams.has('path');
  } catch {
    return false;
  }
}

function extractApiProxyUrls(text = '', baseUrl = '') {
  const cleaned = cleanText(text);
  const urls = [];
  const seen = new Set();

  const patterns = [
    /https?:\/\/[^\s"'<>`]+\/api\/proxy\?path=[^\s"'<>`]+/gi,
    /\/\/[^\s"'<>`]+\/api\/proxy\?path=[^\s"'<>`]+/gi,
    /\/api\/proxy\?path=[^\s"'<>`]+/gi,
    /["']([^"']*\/api\/proxy\?path=[^"']+)["']/gi
  ];

  for (const pattern of patterns) {
    for (const match of cleaned.matchAll(pattern)) {
      const raw = match[1] || match[0];
      const absolute = toAbsolute(raw, baseUrl);

      if (!absolute) continue;
      if (!isApiProxy(absolute)) continue;
      if (seen.has(absolute)) continue;

      seen.add(absolute);
      urls.push(absolute);
    }
  }

  return urls;
}

function extractAssetUrls(text = '', baseUrl = '') {
  const cleaned = cleanText(text);
  const urls = [];
  const seen = new Set();

  const patterns = [
    /<script[^>]+src=["']([^"']+)["']/gi,
    /<iframe[^>]+src=["']([^"']+)["']/gi,
    /["']([^"']+\.js(?:\?[^"']*)?)["']/gi,
    /["']([^"']*api[^"']*)["']/gi,
    /["']([^"']*proxy[^"']*)["']/gi
  ];

  for (const pattern of patterns) {
    for (const match of cleaned.matchAll(pattern)) {
      const absolute = toAbsolute(match[1], baseUrl);

      if (!absolute) continue;

      const lower = absolute.toLowerCase();

      if (
        !lower.includes('/api/proxy') &&
        !lower.includes('.js') &&
        !lower.includes('proxy') &&
        !lower.includes('api')
      ) {
        continue;
      }

      if (seen.has(absolute)) continue;

      seen.add(absolute);
      urls.push(absolute);
    }
  }

  return urls.slice(0, 60);
}

function findSourcesDeep(value, output = []) {
  if (!value || typeof value !== 'object') return output;

  if (Array.isArray(value)) {
    for (const item of value) findSourcesDeep(item, output);
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

function findFirstM3u8(text = '', apiProxyUrl = '') {
  const cleaned = cleanText(text);

  try {
    const json = JSON.parse(cleaned);
    const sources = findSourcesDeep(json);

    const m3u8 = sources.find((source) => {
      return source && source.url && String(source.url).includes('.m3u8');
    });

    if (m3u8) {
      return {
        name: m3u8.name || null,
        url: m3u8.url,
        quality: m3u8.quality || null,
        type: m3u8.type || 'm3u8',
        headers: m3u8.headers || {},
        apiProxyUrl
      };
    }
  } catch {}

  const match = cleaned.match(/https?:\/\/[^\s"'<>`]+\.m3u8[^\s"'<>`]*/i);

  if (match) {
    return {
      name: null,
      url: trimUrl(match[0]),
      quality: null,
      type: 'm3u8',
      headers: {},
      apiProxyUrl
    };
  }

  return null;
}

module.exports = {
  cleanText,
  isApiProxy,
  extractApiProxyUrls,
  extractAssetUrls,
  findFirstM3u8
};
