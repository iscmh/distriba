/**
 * Pulls the video URLs out of a Facebook Ads Library ad.
 *
 * The Ad Library page ships the ad payload as JSON inside the HTML, so a plain
 * HTTP fetch is usually enough. When Facebook decides to gate the page behind
 * JS, `resolveAd` falls back to a headless browser (optional, see README).
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const ALLOWED_HOST = /(^|\.)(fbcdn\.net|facebook\.com|fbsbx\.com)$/i;

/** Hosts we are willing to stream bytes from, so the proxy is not an open relay. */
export function isAllowedMediaUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && ALLOWED_HOST.test(u.hostname);
  } catch {
    return false;
  }
}

/** Accepts a full Ads Library URL, a bare ad id, or a direct fbcdn video link. */
export function parseInput(input) {
  const raw = String(input || '').trim();
  if (!raw) return { kind: 'empty' };

  if (/^\d{6,}$/.test(raw)) return { kind: 'ad', adId: raw };

  let url;
  try {
    url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  } catch {
    return { kind: 'unknown' };
  }

  if (isAllowedMediaUrl(url.href) && /\.mp4(\?|$)/i.test(url.pathname + url.search)) {
    return { kind: 'video', videoUrl: url.href };
  }

  const id = url.searchParams.get('id');
  if (id && /^\d+$/.test(id)) return { kind: 'ad', adId: id };

  const inPath = url.pathname.match(/\/ads\/library\/(\d{6,})/);
  if (inPath) return { kind: 'ad', adId: inPath[1] };

  return { kind: 'unknown' };
}

export function adLibraryUrl(adId) {
  return `https://www.facebook.com/ads/library/?id=${adId}`;
}

async function fetchAdHtml(adId, { cookie } = {}) {
  const res = await fetch(adLibraryUrl(adId), {
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'upgrade-insecure-requests': '1',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      ...(cookie ? { cookie } : {}),
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Facebook returned HTTP ${res.status} for ad ${adId}`);
  return res.text();
}

/**
 * Reads every `"key":"value"` string literal for `key` out of a blob of text.
 * Hand-rolled instead of JSON.parse because the payload is a soup of scripts.
 */
function scanStrings(text, key) {
  const out = [];
  const needle = `"${key}":"`;
  let i = 0;
  while ((i = text.indexOf(needle, i)) !== -1) {
    let j = i + needle.length;
    let raw = '';
    while (j < text.length) {
      const c = text[j];
      if (c === '\\') {
        raw += text[j] + text[j + 1];
        j += 2;
        continue;
      }
      if (c === '"') break;
      raw += c;
      j += 1;
    }
    try {
      out.push(JSON.parse(`"${raw}"`));
    } catch {
      /* truncated literal, skip it */
    }
    i = j + 1;
  }
  return out;
}

/** Same scan, but tolerant of payloads that were escaped one extra time. */
function scanAll(text, key) {
  const direct = scanStrings(text, key);
  if (direct.length) return direct;
  const unescaped = text.replace(/\\"/g, '"').replace(/\\\\\//g, '\\/');
  return scanStrings(unescaped, key);
}

/** Same asset re-signed with different tokens shows up twice; path is the identity. */
function assetKey(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function uniqueByAsset(urls) {
  const seen = new Set();
  const out = [];
  for (const url of urls) {
    const key = assetKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

export function extractFromHtml(html) {
  const hd = uniqueByAsset(scanAll(html, 'video_hd_url'));
  const sd = uniqueByAsset(scanAll(html, 'video_sd_url'));
  const posters = uniqueByAsset([
    ...scanAll(html, 'video_preview_image_url'),
    ...scanAll(html, 'preview_image_url'),
  ]);

  const count = Math.max(hd.length, sd.length);
  const videos = [];
  for (let i = 0; i < count; i += 1) {
    videos.push({
      hd: hd[i] || null,
      sd: sd[i] || null,
      poster: posters[i] || posters[0] || null,
    });
  }

  const pick = (key) => scanAll(html, key).find((v) => v && v.trim()) || null;

  return {
    videos,
    pageName: pick('page_name'),
    title: pick('title'),
    caption: pick('caption'),
    linkUrl: pick('link_url'),
    ctaText: pick('cta_text'),
  };
}

/** Optional headless-browser pass for ads the static fetch cannot see. */
async function extractWithBrowser(adId) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error(
      'No video found in the page HTML. Install the optional browser fallback with ' +
        '`npm i playwright && npx playwright install chromium`, then try again.'
    );
  }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ userAgent: UA, locale: 'en-US' });
    const sniffed = [];
    page.on('response', (res) => {
      const url = res.url();
      if (/\.mp4/i.test(url) && isAllowedMediaUrl(url)) sniffed.push(url);
    });

    await page.goto(adLibraryUrl(adId), { waitUntil: 'networkidle', timeout: 45_000 });
    await page.waitForTimeout(1500);

    const result = extractFromHtml(await page.content());
    if (!result.videos.length && sniffed.length) {
      result.videos = uniqueByAsset(sniffed).map((url) => ({ hd: url, sd: null, poster: null }));
    }
    return result;
  } finally {
    await browser.close();
  }
}

/**
 * Main entry point: input string -> `{ adId, pageName, videos: [...] }`.
 * `videos[i].hd` / `.sd` are direct fbcdn mp4 links.
 */
export async function resolveAd(input, { cookie = process.env.FB_COOKIE, browser = 'auto' } = {}) {
  const parsed = parseInput(input);

  if (parsed.kind === 'empty') throw new Error('Paste an Ads Library link first.');
  if (parsed.kind === 'video') {
    return {
      adId: null,
      source: 'direct',
      pageName: null,
      videos: [{ hd: parsed.videoUrl, sd: null, poster: null }],
    };
  }
  if (parsed.kind !== 'ad') {
    throw new Error(
      "That does not look like an Ads Library link. Expected something like " +
        'https://www.facebook.com/ads/library/?id=1703936547635791'
    );
  }

  const { adId } = parsed;

  if (browser !== 'always') {
    const html = await fetchAdHtml(adId, { cookie });
    const result = extractFromHtml(html);
    if (result.videos.length) return { adId, source: 'html', ...result };
    if (browser === 'never') {
      throw new Error(
        `No video found for ad ${adId}. It may be an image-only ad, or Facebook served a ` +
          'login wall — see the README for the FB_COOKIE and browser-fallback options.'
      );
    }
  }

  const viaBrowser = await extractWithBrowser(adId);
  if (!viaBrowser.videos.length) {
    throw new Error(`No video found for ad ${adId}. It is probably an image-only ad.`);
  }
  return { adId, source: 'browser', ...viaBrowser };
}

export function suggestFilename(adId, index, quality) {
  const base = adId ? `fb-ad-${adId}` : 'fb-ad';
  const suffix = index > 0 ? `-${index + 1}` : '';
  return `${base}${suffix}-${quality}.mp4`;
}

export { UA };
