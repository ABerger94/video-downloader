// deepfetch.js — "deep fetch" extraction for JS-heavy streaming sites.
// Launches headless Chromium via Playwright, watches network traffic for
// stream URLs (.m3u8 / .mp4 / .m4s), checks <video> elements in the DOM,
// and attempts a single click-to-play when nothing is found yet.
//
// Exports: deepFetch(pageUrl) -> Promise<{ title, thumbnail, candidates }>
//   candidates: [{ url, type: 'hls' | 'mp4', label }]

const { chromium } = require('playwright-chromium');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const STREAM_RE = /\.(m3u8|mp4|m4s)(\?|#|$)/i;
const HLS_CT = /mpegurl/i;
const MP4_CT = /^video\/mp4/i;

// Build a Playwright proxy config from the environment (https_proxy /
// HTTPS_PROXY), or null when none is set. Some sandboxes only reach the
// public internet through an egress proxy — without this, Chromium's direct
// connection can get empty/reset responses from bot-sensitive hosts while
// curl (which honors the proxy) works fine.
function proxyFromEnv() {
  const raw = process.env.https_proxy || process.env.HTTPS_PROXY ||
              process.env.http_proxy || process.env.HTTP_PROXY;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const proxy = { server: u.protocol + '//' + u.host };
    if (u.username) {
      proxy.username = decodeURIComponent(u.username);
      proxy.password = decodeURIComponent(u.password);
    }
    return proxy;
  } catch {
    return null;
  }
}

// Serialize deep fetches: one headless browser at a time (memory safety on
// small containers). Calls queue behind the in-flight one.
let deepChain = Promise.resolve();
function queuedDeepFetch(pageUrl) {
  const run = deepChain.then(() => deepFetchOnce(pageUrl));
  // Keep the chain alive even if this run rejects.
  deepChain = run.catch(() => {});
  return run;
}

async function deepFetchOnce(pageUrl) {
  // CHROME_EXECUTABLE_PATH lets deployments use a system Chrome / Chrome for
  // Testing instead of Playwright's downloaded Chromium (e.g. when the
  // Playwright CDN is unreachable). On Railway the build phase installs
  // Playwright's own Chromium, so this stays unset there.
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--mute-audio',
    ],
  });

  const found = new Map(); // url -> { url, type, label }
  const addCandidate = (url, type) => {
    if (!url || !/^https?:\/\//i.test(url)) return;
    // VidEasy-style proxy wrapper: p1.netocdn.site/proxy?url=<inner>&...
    // The wrapper 403s non-browser clients; the inner URL is the real
    // stream and works directly. Prefer the inner URL.
    try {
      const pu = new URL(url);
      if (pu.hostname.includes('netocdn.site') && pu.searchParams.get('url')) {
        const inner = pu.searchParams.get('url');
        if (inner && /^https?:\/\//i.test(inner)) url = inner;
      }
    } catch { /* keep original */ }
    if (found.has(url)) return;
    // Skip tiny junk: analytics pixels, thumbnails, ad beacons.
    if (/\.(png|jpe?g|gif|webp|svg|ico|css|js|woff2?)(\?|#|$)/i.test(url)) return;
    const label = type === 'hls' ? 'HLS stream' : 'MP4 direct';
    found.set(url, { url, type, label });
  };

  let context;
  try {
    // Playwright rejects `proxy: null` ("expected object, got null"), so
    // only pass the option when a proxy is actually configured. On Alek's
    // laptop there is no proxy env var -> direct connection.
    const contextOpts = {
      userAgent: UA,
      viewport: { width: 1280, height: 720 },
      locale: 'en-US',
      javaScriptEnabled: true,
      // DEEP_FETCH_INSECURE_TLS=1 accepts the egress proxy's MITM cert in
      // sandboxes that TLS-intercept browser traffic. Never set in production.
      ignoreHTTPSErrors: process.env.DEEP_FETCH_INSECURE_TLS === '1',
    };
    const proxy = proxyFromEnv();
    if (proxy) contextOpts.proxy = proxy;
    context = await browser.newContext(contextOpts);
    // Close popup tabs these sites love to spawn on click — but never the
    // main page itself ('page' fires for it too).
    const page = await context.newPage();
    context.on('page', (p) => {
      if (p !== page) p.close().catch(() => {});
    });

    page.on('response', async (resp) => {
      try {
        const url = resp.url();
        const ct = (resp.headers()['content-type'] || '').toLowerCase();
        if (STREAM_RE.test(url) || HLS_CT.test(ct) || MP4_CT.test(ct)) {
          if (/\.m3u8(\?|#|$)/i.test(url) || HLS_CT.test(ct)) addCandidate(url, 'hls');
          else addCandidate(url, 'mp4');
        }
      } catch { /* ignore */ }
    });

    // 'commit' returns as soon as the response arrives; 'domcontentloaded' can
    // hang behind slow third-party subresources on these ad-heavy pages.
    await page.goto(pageUrl, { waitUntil: 'commit', timeout: 45000 })
      .catch(() => {});
    // Let the page settle: players lazy-load after JS runs.
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(3000);

    await harvestVideoTags(page, addCandidate);

    if (found.size === 0) {
      // 5movies.cc (and lookalikes): the watch page holds an empty
      // #iframe-embed; its player script POSTs /ajax_tv {id, season, eps,
      // types} to resolve the real player URL per server (VidPlay,
      // MovietoPlay, VidEasy). Do the same POSTs from inside the page
      // (inherits cookies + proxy) and walk each embed until one yields
      // streams.
      const embeds = await resolve5moviesEmbeds(page, pageUrl);
      for (const embedUrl of embeds) {
        if (found.size > 0) break;
        await page.goto(embedUrl, { waitUntil: 'commit', timeout: 45000 }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(3000);
        await harvestVideoTags(page, addCandidate);
        if (found.size === 0) {
          const clicked = await tryClickPlay(page);
          if (clicked) {
            await page.waitForTimeout(5000);
            await harvestVideoTags(page, addCandidate);
          }
        }
      }
    }

    if (found.size === 0) {
      // Attempt a single click-to-play: these players lazy-load the stream.
      const clicked = await tryClickPlay(page);
      if (clicked) {
        await page.waitForTimeout(5000);
        await harvestVideoTags(page, addCandidate);
      }
    }

    const title = await page.title().catch(() => '');
    const thumbnail = await page.evaluate(() => {
      const og = document.querySelector('meta[property="og:image"]');
      return og ? og.getAttribute('content') : null;
    }).catch(() => null);

    return {
      title: title || 'Deep fetch result',
      thumbnail,
      candidates: rankCandidates([...found.values()]),
    };
  } finally {
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// 5movies.cc-style embed resolver: POST /ajax_tv from inside the page for
// each server type and return the distinct player URLs, in server order.
async function resolve5moviesEmbeds(page, pageUrl) {
  const m = pageUrl.match(/[?&]id=(\d+)/);
  if (!/5movies\.cc\/watch/i.test(pageUrl) || !m) return [];
  const out = [];
  for (const type of ['VidPlay', 'MovietoPlay', 'VidEasy']) {
    try {
      const embed = await page.evaluate(async ({ id, type }) => {
        const datas = document.querySelector('#datas');
        const params = new URLSearchParams({
          id,
          season: (datas && datas.dataset.season) || '1',
          eps: (datas && datas.dataset.ep) || '1',
          types: type,
        });
        const r = await fetch('/ajax_tv', { method: 'POST', body: params });
        if (!r.ok) return null;
        const txt = (await r.text()).trim();
        return /^https?:\/\//i.test(txt) ? txt : null;
      }, { id: m[1], type });
      if (embed && !out.includes(embed)) out.push(embed);
    } catch { /* try next server type */ }
  }
  return out;
}

// Pull src/currentSrc from any <video> elements currently in the DOM.
async function harvestVideoTags(page, addCandidate) {
  const srcs = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('video').forEach((v) => {
      if (v.currentSrc) out.push(v.currentSrc);
      if (v.src) out.push(v.src);
      v.querySelectorAll('source').forEach((s) => {
        if (s.src) out.push(s.src);
      });
    });
    return out;
  }).catch(() => []);
  for (const s of srcs) {
    if (/\.m3u8(\?|#|$)/i.test(s)) addCandidate(s, 'hls');
    else addCandidate(s, 'mp4');
  }
}

// One best-effort click on the player / play button. Returns true if something was clicked.
async function tryClickPlay(page) {
  const selectors = [
    '.vjs-big-play-button',
    'button[class*="play" i]',
    'div[class*="play-button" i]',
    '[aria-label*="play" i]',
    '#player',
    '.player',
    '#video-player',
    '.jwplayer',
    'video',
  ];
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      const box = await el.boundingBox().catch(() => null);
      if (!box || box.width < 2 || box.height < 2) continue;
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await el.click({ timeout: 4000 }).catch(() => {});
      return true;
    } catch { /* try next */ }
  }
  // Fallback: click the center of the largest iframe (embed players).
  try {
    const box = await page.evaluate(() => {
      let best = null;
      document.querySelectorAll('iframe').forEach((f) => {
        const r = f.getBoundingClientRect();
        const area = r.width * r.height;
        if (r.width > 50 && r.height > 50 && (!best || area > best.area)) {
          best = { x: r.x + r.width / 2, y: r.y + r.height / 2, area };
        }
      });
      return best;
    }).catch(() => null);
    if (box) {
      await page.mouse.click(box.x, box.y);
      return true;
    }
  } catch { /* nothing clickable */ }
  return false;
}

// Prefer HLS master playlists and same-host mp4s; drop obvious ad/tracker hosts last.
function rankCandidates(cands) {
  const score = (c) => {
    let s = 0;
    try {
      const host = new URL(c.url).hostname.toLowerCase();
      if (/doubleclick|googlesyndication|google-analytics|facebook|hotjar/.test(host)) s -= 10;
    } catch { /* ignore */ }
    if (c.type === 'hls') s += 2; // HLS is usually the real stream on these sites
    if (/master|playlist|index/i.test(c.url)) s += 1;
    return s;
  };
  return cands.sort((a, b) => score(b) - score(a)).slice(0, 10);
}

module.exports = { deepFetch: queuedDeepFetch };
