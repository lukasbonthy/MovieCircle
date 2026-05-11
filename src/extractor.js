function repairBrokenProtocol(value = '') {
  return String(value)
    .replace(/^ttps:\/\//i, 'https://')
    .replace(/^http:\/\//i, 'http://')
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

  for (let i = 0; i < 4; i++) {
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
    .replace(/[),.;\]}]+$/g, '')
    .replace(/^["'`]+|["'`]+$/g, '');
}

function looksUseful(value = '') {
  const text = safeDecode(cleanText(value)).toLowerCase();

  return (
    text.includes('/proxy/video?url=') ||
    text.includes('/video?url=') ||
    text.includes('/highscool/video?url=') ||
    text.includes('/highschool/video?url=') ||
    text.includes('.mp4') ||
    text.includes('.m3u8') ||
    text.includes('.webm') ||
    text.includes('bcdnxw.')
  );
}

function getRawUrlParam(originalUrl = '') {
  const text = cleanText(originalUrl);

  const match = text.match(/[?&]url=([\s\S]*?)(?=&(?:apikey|referer|origin)=|$)/i);

  if (!match) return null;

  return match[1];
}

function buildEncodedProxyUrl(parsedUrl, originalUrl) {
  const rawInner = getRawUrlParam(originalUrl);
  if (!rawInner) return null;

  let decodedVideoUrl = safeDecode(rawInner);
  decodedVideoUrl = addHttpsToBareUrl(repairBrokenProtocol(decodedVideoUrl));

  const apikey = parsedUrl.searchParams.get('apikey') || '';
  const referer = parsedUrl.searchParams.get('referer') || '';
  const origin = parsedUrl.searchParams.get('origin') || '';

  const params = [];

  params.push(`url=${encodeURIComponent(decodedVideoUrl)}`);

  if (apikey) params.push(`apikey=${encodeURIComponent(apikey)}`);
  if (referer) params.push(`referer=${encodeURIComponent(referer)}`);
  if (origin) params.push(`origin=${encodeURIComponent(origin)}`);

  return {
    encodedProxyUrl: `${parsedUrl.origin}${parsedUrl.pathname}?${params.join('&')}`,
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

  let urlForParsing = original;

  if (/^https%3A%2F%2F/i.test(urlForParsing)) {
    urlForParsing = safeDecode(urlForParsing);
  }

  urlForParsing = addHttpsToBareUrl(repairBrokenProtocol(urlForParsing));

  let parsed;

  try {
    parsed = new URL(urlForParsing, baseUrl || undefined);
  } catch {
    return null;
  }

  const fullUrl = parsed.toString();
  const lower = safeDecode(fullUrl).toLowerCase();

  const isProxyVideo =
    lower.includes('/proxy/video?url=') ||
    lower.includes('/video?url=') ||
    lower.includes('/highscool/video?url=') ||
    lower.includes('/highschool/video?url=');

  if (isProxyVideo) {
    const rebuilt = buildEncodedProxyUrl(parsed, fullUrl);

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

  const isDirectMedia =
    lower.includes('.mp4') ||
    lower.includes('.m3u8') ||
    lower.includes('.webm');

  if (isDirectMedia) {
    return {
      type: 'direct-media',
      source,
      url: fullUrl,
      workingUrl: fullUrl,
      encodedProxyUrl: null,
      decodedVideoUrl: fullUrl,
      apikey: null,
      referer: null,
      origin: null
    };
  }

  return null;
}

function extractUrlsFromText(text = '', source = 'unknown', baseUrl = '') {
  const cleaned = cleanText(text);
  const results = [];
  const seen = new Set();

  const patterns = [
    /(?:https?:\/\/|ttps:\/\/|\/\/)[^\s"'<>`]+/gi,
    /(?:[a-z0-9-]+\.)?lemonforest-[a-z0-9.-]+\.azurecontainerapps\.io\/[^\s"'<>`]+/gi,
    /https%3A%2F%2F[^\s"'<>`]+/gi
  ];

  for (const pattern of patterns) {
    const matches = cleaned.match(pattern) || [];

    for (const match of matches) {
      const candidate = trimUrl(match);

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
