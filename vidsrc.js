// vidsrc.js — direct (no-browser) stream resolution for the vidsrc player
// chain used by 5movies.cc's VidPlay server (vidsrcme.ru embeds).
//
// The headless-browser walk could load these player pages but never saw a
// stream: the player only fetches its sources after a play click, and the
// source API returns them ChaCha20-encrypted. This module replays the
// player's own API chain over plain HTTPS:
//
//   embed page HTML -> data-api="/vs_src.php?..." -> {"src": "<cloud host>/embed/..."}
//     -> page HTML -> window.CFG.playerUrl -> /embed/player/...
//     -> page HTML -> window.CONFIG.streamBase
//     -> {streamBase}&season=&episode=&stream_urls
//        -> {"data":{"stream_urls":"<base64 nonce||ciphertext>"},"vs":{"wasm_url":"..."}}
//     -> fetch the WASM decryptor, ChaCha20-decrypt -> newline-separated URLs
//
// Those URLs are HLS master playlists on rotating hosts. Playback additionally
// needs a short-lived IP-bound token from <stream-host>/generate.php stamped
// onto the playlist URL (?token= or __TOKEN__). The player fetches that token
// lazily "at the moment we're about to request the playlist" — so the token
// is stamped at download time, not at resolve time.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function isVidsrcEmbed(url) {
  return /vidsrcme\.ru\/embed\/(tv|movie)\//i.test(url || '');
}

async function fetchText(url, { headers = {}, timeoutMs = 30000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, ...headers },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`vidsrc: HTTP ${r.status} for ${url}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

async function fetchBytes(url, referer, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = { 'User-Agent': UA };
    if (referer) headers.Referer = referer;
    const r = await fetch(url, { headers, signal: ctrl.signal });
    if (!r.ok) throw new Error(`vidsrc: HTTP ${r.status} for ${url}`);
    return Buffer.from(await r.arrayBuffer());
  } finally {
    clearTimeout(t);
  }
}

// WASM decryptor modules are keyed by 5-minute window; cache by URL.
const wasmModuleCache = new Map();
async function getWasmModule(wasmUrl, referer) {
  if (!wasmModuleCache.has(wasmUrl)) {
    const bytes = await fetchBytes(wasmUrl, referer);
    wasmModuleCache.set(wasmUrl, WebAssembly.compile(bytes));
  }
  return wasmModuleCache.get(wasmUrl);
}

// Decrypt base64(nonce||ciphertext) with the window's WASM module.
// Mirrors vsdec.js: alloc(len), copy in, decrypt(ptr, len) -> outLen,
// plaintext at ptr+12.
async function decryptStreamUrls(wasmUrl, encB64, referer) {
  const mod = await getWasmModule(wasmUrl, referer);
  const inst = await WebAssembly.instantiate(mod, {});
  const ex = inst.exports;
  const enc = Buffer.from(encB64, 'base64');
  const ptr = ex.alloc(enc.length);
  new Uint8Array(ex.memory.buffer, ptr, enc.length).set(enc);
  const outLen = ex.decrypt(ptr, enc.length);
  const txt = Buffer.from(
    ex.memory.buffer.slice(ptr + 12, ptr + 12 + outLen)
  ).toString('utf8');
  return txt.split('\n').map((s) => s.trim()).filter(Boolean);
}

// resolveVidsrcStreams(embedUrl) ->
//   { title, urls }  (urls are raw HLS playlist URLs, token NOT yet stamped)
async function resolveVidsrcStreams(embedUrl) {
  // 1. Embed page -> data-api path for vs_src.php.
  const embedHtml = await fetchText(embedUrl, { headers: { Accept: 'text/html' } });
  const apiM = embedHtml.match(/data-api="([^"]+)"/i);
  if (!apiM) throw new Error('vidsrc: no data-api on embed page');
  const apiUrl = new URL(
    apiM[1].replace(/&amp;/g, '&'),
    'https://vidsrcme.ru'
  ).toString();

  // 2. vs_src.php -> second-level player page URL.
  const srcJson = JSON.parse(
    await fetchText(apiUrl, {
      headers: { Referer: embedUrl, Accept: 'application/json' },
    })
  );
  if (!srcJson || !srcJson.src || !/^https?:\/\//i.test(srcJson.src)) {
    throw new Error('vidsrc: vs_src.php returned no player src');
  }

  // 3. Player landing page -> window.CFG.playerUrl (real player iframe).
  const srcHtml = await fetchText(srcJson.src, { headers: { Referer: embedUrl } });
  const puM = srcHtml.match(/"playerUrl":"([^"]+)"/);
  if (!puM) throw new Error('vidsrc: no playerUrl in embed page');
  const playerUrl = new URL(JSON.parse(`"${puM[1]}"`), srcJson.src).toString();

  // 4. Real player page -> window.CONFIG with the streamBase API root.
  const playerHtml = await fetchText(playerUrl, { headers: { Referer: srcJson.src } });
  const cfgM = playerHtml.match(/window\.CONFIG\s*=\s*(\{.*?\});/s);
  if (!cfgM) throw new Error('vidsrc: no window.CONFIG in player page');
  const cfg = JSON.parse(cfgM[1]);
  if (!cfg.streamBase) throw new Error('vidsrc: no streamBase in player CONFIG');

  // 5. Stream-data API. TV needs season/episode; movies don't.
  let streamApi = cfg.streamBase;
  const isTv = cfg.tv || /[?&]type=tv\b/i.test(cfg.streamBase);
  if (isTv) {
    streamApi +=
      '&season=' + encodeURIComponent(cfg.season ?? 1) +
      '&episode=' + encodeURIComponent(cfg.episode ?? 1);
  }
  streamApi += '&stream_urls';
  const data = JSON.parse(
    await fetchText(streamApi, {
      headers: { Referer: playerUrl, Accept: 'application/json' },
    })
  );
  const code = String(data.status_code || data.status || '');
  if ((code && code !== '200') || !data.data || !data.data.stream_urls) {
    throw new Error('vidsrc: stream API returned no sources (status ' + (code || '?') + ')');
  }

  // 6. stream_urls is either a plain array or an encrypted string + WASM URL.
  let urls = data.data.stream_urls;
  if (typeof urls === 'string') {
    const wasmUrl = data.vs && data.vs.wasm_url;
    if (!wasmUrl) throw new Error('vidsrc: encrypted sources but no wasm_url');
    urls = await decryptStreamUrls(wasmUrl, urls, playerUrl);
  }
  urls = (Array.isArray(urls) ? urls : []).filter((u) => /^https?:\/\//i.test(u));
  if (!urls.length) throw new Error('vidsrc: empty source list after decrypt');

  return { title: data.data.title || null, urls };
}

// parseToken: mirrors the player's parseToken() — the /generate.php body is
// either a bare token string or JSON carrying it.
function parseTokenText(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return '';
  if (t[0] === '{' || t[0] === '[') {
    try {
      const j = JSON.parse(t);
      if (typeof j === 'string') return j;
      if (j && typeof j === 'object') return j.token || j.data || j.string || j.result || '';
    } catch { /* fall through to raw text */ }
  }
  return t;
}

// stampVidsrcToken(rawUrl) -> playlist URL with a fresh IP-bound token.
// Called at download time (tokens are short-lived). Never throws: on any
// failure the raw URL is returned, same as the player playing tokenless.
async function stampVidsrcToken(rawUrl) {
  try {
    const origin = new URL(rawUrl).origin;
    const tok = parseTokenText(
      await fetchText(origin + '/generate.php', { timeoutMs: 15000 })
    );
    if (!tok) return rawUrl;
    if (rawUrl.includes('__TOKEN__')) return rawUrl.split('__TOKEN__').join(tok);
    return rawUrl + (rawUrl.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(tok);
  } catch {
    return rawUrl;
  }
}

module.exports = { isVidsrcEmbed, resolveVidsrcStreams, stampVidsrcToken };
