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
    .replace(/[)"'<>\]}]+$/g, '');
}

function looksUseful(value = '') {
  const decoded = safeDecode(cleanText(value)).toLowerCase();

  return decoded.includes('/proxy/video?');
}

function getRawUrlParam(originalUrl = '') {
  const text = cleanText(originalUrl);

  const match = text.match(/[?&]url=([\s\S]*?)(?=&(?:apikey|referer|origin|key|token)=|$)/i);

  if (!match) return null;

  return match[1];
}

function isProxyVideoUrl(parsedUrl, fullUrl) {
  const decoded = safeDecode(fullUrl).toLowerCase();

  return (
    decoded.includes('/proxy/video?') &&
    parsedUrl.searchParams.has('url')
  );
}

function buildWorkingEncodedProxyUrl(parsedUrl, originalUrl) {
  const rawInner = getRawUrlParam(originalUrl);

  if (!rawInner) return null;

  let decodedVideoUrl = safeDecode(rawInner);
  decodedVideoUrl = addHttpsToBareUrl(repairBrokenProtocol(decodedVideoUrl));

  const apikey = parsedUrl.searchParams.get('apikey') || '';
  const referer = parsedUrl.searchParams.get('referer') || '';
  const origin = parsedUrl.searchParams.get('origin') || '';

  const params = new URLSearchParams();

  params.set('url', decodedVideoUrl);

  if (apikey) params.set('apikey', apikey);
  if (referer) params.set('referer', referer);
  if (origin) params.set('origin', origin);

  return {
    encodedProxyUrl: `${parsedUrl.origin}${parsedUrl.pathname}?${params.toString()}`,
    decodedVideoUrl,
    apikey,
    referer,
    origin
  };
}

function parseFoundUrl(input, source = 'unknown', baseUrl = '') {
  if (!input) return null;

  let original = trimUrl(cleanText(input));
  original = repairBrokenProtocol(original);

  if (original.startsWith('//')) {
    original = `https:${original}`;
  }

  if (/^https%3A%2F%2F/i.test(original)) {
    original = safeDecode(original);
  }

  original = addHttpsToBareUrl(original);

  let parsed;

  try {
    parsed = new URL(original, baseUrl || undefined);
  } catch {
    return null;
  }

  const fullUrl = parsed.toString();

  // Required rule:
  // The returned result MUST contain /proxy/video?
  if (!isProxyVideoUrl(parsed, fullUrl)) {
    return null;
  }

  const rebuilt = buildWorkingEncodedProxyUrl(parsed, fullUrl);

  if (!rebuilt) return null;

  return {
    type: 'proxy-video',
    source,
    url: fullUrl,
    workingUrl: rebuilt.encodedProxyUrl,
    encodedProxyUrl: rebuilt.encodedProxyUrl,
    decodedVideoUrl: rebuilt.decodedVideoUrl,
    apikey: rebuilt.apikey || null,
    referer: rebuilt.referer || null,
    origin: rebuilt.origin || null
  };
}

function extractUrlsFromText(text = '', source = 'unknown', baseUrl = '') {
  const cleaned = cleanText(text);
  const results = [];
  const seen = new Set();

  const patterns = [
    // Normal full URLs
    /(?:https?:\/\/|ttps:\/\/|\/\/)[^\s"'<>`]+/gi,

    // Encoded full URLs
    /https%3A%2F%2F[^\s"'<>`]+/gi,

    // Bare Azure URLs
    /[a-z0-9.-]+\.azurecontainerapps\.io\/[^\s"'<>`]+/gi,

    // Any relative path that contains /proxy/video?url=
    /\/[^\s"'<>`]*proxy\/video\?url=[^\s"'<>`]+/gi,

    // Any quoted proxy video URL/path
    /["']([^"']*\/proxy\/video\?url=[^"']+)["']/gi,

    // Encoded proxy/video pattern
    /[^\s"'<>`]*%2Fproxy%2Fvideo%3Furl%3D[^\s"'<>`]+/gi
  ];

  for (const pattern of patterns) {
    for (const match of cleaned.matchAll(pattern)) {
      const raw = match[1] || match[0];
      const candidate = trimUrl(raw);

      if (!looksUseful(candidate)) continue;
      if (seen.has(candidate)) continue;

      seen.add(candidate);

      const parsed = parseFoundUrl(candidate, source, baseUrl);

      if (parsed) {
        results.push(parsed);
      }
    }
  }

  return results;
}

module.exports = {
  extractUrlsFromText,
  parseFoundUrl,
  looksUseful,
  repairBrokenProtocol,
  addHttpsToBareUrl
};
