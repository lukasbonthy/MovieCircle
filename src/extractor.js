function cleanCandidate(candidate) {
  if (!candidate) return '';
  let s = String(candidate)
    .replace(/\\u0026/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/\\\//g, '/')
    .replace(/\"/g, '"')
    .replace(/^['"`]+|['"`]+$/g, '')
    .trim();

  // Trim characters commonly attached by HTML/JS/markdown punctuation.
  s = s.replace(/[),.;\]}]+$/g, '');

  if (s.startsWith('ttps://')) s = `h${s}`;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;

  return s;
}

function safeDecode(value) {
  if (value == null) return null;
  let v = String(value);
  for (let i = 0; i < 3; i++) {
    try {
      const decoded = decodeURIComponent(v);
      if (decoded === v) break;
      v = decoded;
    } catch (_) {
      break;
    }
  }
  return v;
}

function appendQueryParam(url, key, value) {
  if (!value) return url;
  if (new RegExp(`[?&]${key}=`).test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${key}=${value}`;
}

function parseProxyUrl(rawCandidate) {
  const originalCapturedUrl = cleanCandidate(rawCandidate);
  let parsed;

  try {
    parsed = new URL(originalCapturedUrl);
  } catch (_) {
    return null;
  }

  if (!/\/proxy\/video$/i.test(parsed.pathname)) return null;

  let decodedVideoUrl = parsed.searchParams.get('url');
  if (!decodedVideoUrl) return null;
  decodedVideoUrl = safeDecode(decodedVideoUrl);

  // If the captured URL was broken/raw, t/sign may have leaked into the outer query.
  const leakedSign = parsed.searchParams.get('sign');
  const leakedT = parsed.searchParams.get('t');
  decodedVideoUrl = appendQueryParam(decodedVideoUrl, 'sign', leakedSign);
  decodedVideoUrl = appendQueryParam(decodedVideoUrl, 't', leakedT);

  const apikey = safeDecode(parsed.searchParams.get('apikey'));
  const referer = safeDecode(parsed.searchParams.get('referer'));
  const origin = safeDecode(parsed.searchParams.get('origin'));

  const params = new URLSearchParams();
  params.set('url', decodedVideoUrl);
  if (apikey) params.set('apikey', apikey);
  if (referer) params.set('referer', referer);
  if (origin) params.set('origin', origin);

  const workingEncodedProxyUrl = `${parsed.origin}${parsed.pathname}?${params.toString()}`;

  return {
    type: 'proxy-video',
    workingEncodedProxyUrl,
    originalCapturedUrl,
    decodedProxyUrl: safeDecode(originalCapturedUrl),
    decodedVideoUrl,
    apikey,
    referer,
    origin
  };
}

function extractFirstProxyVideo(input) {
  if (!input) return null;

  const normalized = String(input)
    .replace(/\\u0026/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/\\\//g, '/')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t');

  const regex = /(?:(?:https?:|ttps:)\/\/)?[a-z0-9.-]+(?::\d+)?\/proxy\/video\?url=[^\s"'<>`\\]+/gi;
  const matches = normalized.match(regex) || [];

  for (const match of matches) {
    const parsed = parseProxyUrl(match);
    if (parsed) return parsed;
  }

  return null;
}

module.exports = {
  extractFirstProxyVideo,
  parseProxyUrl
};
