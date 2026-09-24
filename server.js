// video-downloader — single-service Node/Express app.
// Paste a video-page URL, pick a quality, download it, then stream or save it to your phone.
// Backend: yt-dlp does the fetching and downloading. Frontend: static files in public/.

const express = require('express');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { deepFetch } = require('./deepfetch');
const { stampVidsrcToken } = require('./vidsrc');
// episode-meta.js lives in public/ (it doubles as a browser <script>).
// If it's missing, fall back to no-op parsing so the server still runs.
let parseEpisodeMeta, formatEpisodeTag, cleanNum;
try {
  ({ parseEpisodeMeta, formatEpisodeTag, cleanNum } = require('./public/episode-meta'));
} catch {
  parseEpisodeMeta = () => ({ season: null, episode: null });
  formatEpisodeTag = () => null;
  cleanNum = () => null;
  console.log('episode-meta.js not found in public/ — season/episode URL parsing disabled.');
}

const app = express();
app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------------------
// Config: config.json (next to server.js, gitignored) < env vars.
// config.json is where this machine's choices live: save folder, port.
// ---------------------------------------------------------------------------
const CONFIG_PATH = path.join(__dirname, 'config.json');
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}
const fileConfig = loadConfig();

const PORT = process.env.PORT || fileConfig.port || 3000;
// Where finished videos land. Change it any time from the web UI (Library >
// Change) or with the DOWNLOAD_DIR env var. On Windows it defaults to
// E:\video-downloads — exactly where Alek wants them.
const defaultDir = process.platform === 'win32'
  ? 'E:\\video-downloads'
  : path.join(__dirname, 'downloads');
let DOWNLOADS_DIR = path.resolve(process.env.DOWNLOAD_DIR || fileConfig.downloadDir || defaultDir);
fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

const MAX_CONCURRENT = 2; // downloads running at once; extras queue
const MAX_FILESIZE = '2G'; // refuse anything bigger
const MAX_DEEP_BYTES = 2 * 1024 * 1024 * 1024; // same 2 GB cap for deep-fetch downloads
const FILE_TTL_MS = 24 * 60 * 60 * 1000; // delete files older than 24h
const INFO_TIMEOUT_MS = 90000;

// ---------------------------------------------------------------------------
// Binary resolution: explicit env override > bundled Windows exe (bin\) >
// whatever is on PATH. The Windows setup script drops yt-dlp.exe /
// ffmpeg.exe / ffprobe.exe into bin\ so no Python install is needed.
// ---------------------------------------------------------------------------
function pickYtDlp() {
  const exe = process.env.YTDLP_PATH ||
    (process.platform === 'win32' ? path.join(__dirname, 'bin', 'yt-dlp.exe') : null);
  if (exe && fs.existsSync(exe)) {
    const r = spawnSync(exe, ['--version'], { timeout: 20000, encoding: 'utf8' });
    if (r.status === 0) return { cmd: exe, prefix: [] };
  }
  const r1 = spawnSync('python3', ['-m', 'yt_dlp', '--version'], { timeout: 20000, encoding: 'utf8' });
  if (r1.status === 0) return { cmd: 'python3', prefix: ['-m', 'yt_dlp'] };
  const r2 = spawnSync('yt-dlp', ['--version'], { timeout: 20000, encoding: 'utf8' });
  if (r2.status === 0) return { cmd: 'yt-dlp', prefix: [] };
  return null;
}
const YTDLP = pickYtDlp();
if (!YTDLP) {
  console.error('FATAL: yt-dlp not found. On Windows run setup-windows.bat; elsewhere: pip install yt-dlp');
  process.exit(1);
}
console.log('yt-dlp:', [YTDLP.cmd, ...YTDLP.prefix].join(' '));

function pickBin(name) {
  // name: 'ffmpeg' | 'ffprobe'
  const override = process.env[name.toUpperCase() + '_PATH'] ||
    (process.platform === 'win32' ? path.join(__dirname, 'bin', name + '.exe') : null);
  if (override && fs.existsSync(override)) return override;
  return name; // on PATH
}
const FFMPEG = pickBin('ffmpeg');
const FFPROBE = pickBin('ffprobe');
console.log('ffmpeg:', FFMPEG, '| ffprobe:', FFPROBE);

function spawnYtDlp(args, opts = {}) {
  return spawn(YTDLP.cmd, [...YTDLP.prefix, ...args], opts);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function validUrl(u) {
  try {
    const p = new URL(String(u));
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch {
    return false;
  }
}

// Resolve a requested filename strictly inside the downloads dir (no traversal).
function safeFilePath(name) {
  const base = path.basename(String(name || ''));
  if (!base || base === '.' || base === '..') return null;
  const resolved = path.resolve(DOWNLOADS_DIR, base);
  if (resolved !== DOWNLOADS_DIR && !resolved.startsWith(DOWNLOADS_DIR + path.sep)) return null;
  if (resolved === DOWNLOADS_DIR) return null;
  return resolved;
}

function fmtBytes(n) {
  if (!n || n <= 0) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
}

function fmtDuration(sec) {
  if (!sec && sec !== 0) return '';
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}

// Positive int or null — for season/episode values off the wire.
function numOr(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 && n < 1000 ? n : null;
}

// ---------------------------------------------------------------------------
// Jobs (in-memory). MAX_CONCURRENT run at once; the rest queue.
// ---------------------------------------------------------------------------
const jobs = new Map(); // id -> job
const queue = []; // job ids waiting for a slot

function activeCount() {
  let n = 0;
  for (const j of jobs.values()) if (j.status === 'downloading') n++;
  return n;
}

function pumpQueue() {
  while (queue.length > 0 && activeCount() < MAX_CONCURRENT) {
    const id = queue.shift();
    const job = jobs.get(id);
    if (job && job.status === 'queued') startDownload(job);
  }
}

function newJob({ url, formatId, title, kind = 'ytdlp', streamUrl, streamType, tokenize, season, episode, referer }) {
  const id = crypto.randomBytes(8).toString('hex');
  const job = {
    id, url: url || null, formatId: formatId || null, title: title || null,
    kind, streamUrl: streamUrl || null, streamType: streamType || null,
    tokenize: tokenize || null,
    referer: referer || null,
    season: numOr(season), episode: numOr(episode),
    status: 'queued', percent: 0, speed: null, eta: null,
    filename: null, error: null, createdAt: Date.now(),
  };
  jobs.set(id, job);
  queue.push(id);
  pumpQueue();
  return job;
}

const RE_PROGRESS = /^\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+\s*\w*)\s+at\s+([\d.]+\s*\w+\/s)\s+ETA\s+([\d:]+)/;
const RE_DEST = /^\[download\]\s+Destination:\s+(.+)$/;
const RE_ALREADY = /has already been downloaded/;
const RE_ERROR = /^(?:ERROR|error):\s*(.+)/;

function startDownload(job) {
  if (job.kind === 'deep') return startDeepDownload(job);
  job.status = 'downloading';
  // Bake S01E05-style tags into the filename when we know them.
  const tag = formatEpisodeTag(job.season, job.episode);
  const outTpl = path.join(DOWNLOADS_DIR, '%(title).80s' + (tag ? ' ' + tag : '') + ' [%(id)s].%(ext)s');
  const args = [
    '--newline', '--progress',
    '--no-playlist', '--no-warnings',
    '--max-filesize', MAX_FILESIZE,
    '--restrict-filenames',
    '-f', job.formatId,
    '-o', outTpl,
    job.url,
  ];
  const child = spawnYtDlp(args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let lastError = null;
  let destPath = null;
  let buf = '';

  const onLine = (line) => {
    line = line.trim();
    if (!line) return;
    let m;
    if ((m = line.match(RE_PROGRESS))) {
      job.percent = parseFloat(m[1]);
      job.speed = m[3].trim();
      job.eta = m[4].trim();
    } else if ((m = line.match(RE_DEST))) {
      destPath = m[1].trim();
      job.filename = path.basename(destPath);
    } else if ((m = line.match(RE_ERROR))) {
      lastError = m[1].trim();
    } else if (RE_ALREADY.test(line) && destPath) {
      job.filename = path.basename(destPath);
    }
  };

  const pump = (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
  };
  child.stdout.on('data', pump);
  child.stderr.on('data', pump);

  child.on('error', (err) => {
    job.status = 'error';
    job.error = 'Failed to launch yt-dlp: ' + err.message;
    pumpQueue();
  });

  child.on('close', (code) => {
    onLine(buf); buf = '';
    if (code === 0) {
      // If we never caught a Destination line (e.g. merge step renamed it),
      // fall back to the newest file in the downloads dir from this job's window.
      if (!job.filename) {
        const newest = newestFileSince(DOWNLOADS_DIR, job.createdAt - 5000);
        if (newest) job.filename = newest;
      }
      job.status = 'done';
      job.percent = 100;
      job.speed = null;
      job.eta = null;
    } else {
      job.status = 'error';
      job.error = lastError || ('yt-dlp exited with code ' + code);
    }
    pumpQueue();
  });
}

function newestFileSince(dir, sinceMs) {
  try {
    let best = null, bestT = sinceMs;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      if (st.isFile() && st.mtimeMs >= bestT) { best = f; bestT = st.mtimeMs; }
    }
    return best;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Deep downloads: stream URLs sniffed by headless Chromium (deepfetch.js).
// HLS -> ffmpeg -c copy into mp4; direct mp4 -> streamed HTTP download.
// ---------------------------------------------------------------------------
function sanitizeTitle(t) {
  const s = String(t || 'video').replace(/[^\w.\- ]+/g, '_').trim().slice(0, 80);
  return s || 'video';
}

function uniqueOutPath(base) {
  let p = path.join(DOWNLOADS_DIR, base + '.mp4');
  if (!fs.existsSync(p)) return p;
  p = path.join(DOWNLOADS_DIR, base + '-' + Date.now().toString(36) + '.mp4');
  return p;
}

function startDeepDownload(job) {
  // Hold the concurrency slot immediately; the vidsrc token (short-lived,
  // IP-bound) is stamped on just before ffmpeg/ffprobe run.
  job.status = 'downloading';
  const tag = formatEpisodeTag(job.season, job.episode);
  const outPath = uniqueOutPath(sanitizeTitle(job.title) + (tag ? ' ' + tag : ''));
  job.filename = path.basename(outPath);
  const ready = (job.tokenize === 'vidsrc')
    ? stampVidsrcToken(job.streamUrl).then((u) => { job.streamUrl = u; }).catch(() => {})
    : Promise.resolve();
  ready.then(() => {
    if (job.streamType === 'hls') startHlsDownload(job, outPath);
    else startHttpDownload(job, outPath);
  });
}

// ffmpeg/ffprobe don't read proxy env vars natively; pass -http_proxy when
// one is set (no-op in normal deployments like Railway).
function ffmpegProxyArgs() {
  const p = process.env.https_proxy || process.env.HTTPS_PROXY ||
            process.env.http_proxy || process.env.HTTP_PROXY;
  return p ? ['-http_proxy', p] : [];
}

// Merge the base64 `data`-param headers with the job's Referer (the player
// embed page the stream was discovered on) into a single ffmpeg -headers
// arg. Stream hosts on the 7reels embeds 403/404 without a Referer.
function deepHeadersArgs(job) {
  const lines = [];
  try {
    const data = new URL(job.streamUrl).searchParams.get('data');
    if (data) {
      const decoded = Buffer.from(data, 'base64').toString('utf8');
      for (const part of decoded.split('|')) {
        const eq = part.indexOf('=');
        if (eq > 0) {
          const k = part.slice(0, eq).trim(), v = part.slice(eq + 1).trim();
          if (/^(origin|referer)$/i.test(k) && /^https?:\/\//i.test(v)) {
            lines.push(`${k}: ${v}`);
          }
        }
      }
    }
  } catch { /* keep going */ }
  if (job.referer && /^https?:\/\//i.test(job.referer) &&
      !lines.some((l) => /^referer:/i.test(l))) {
    lines.push(`Referer: ${job.referer}`);
  }
  if (job.cookies && typeof job.cookies === 'string' && job.cookies.length < 4096 &&
      !lines.some((l) => /^cookie:/i.test(l))) {
    lines.push(`Cookie: ${job.cookies}`);
  }
  if (!lines.length) return [];
  return ['-headers', lines.map((h) => h + '\r\n').join('')];
}

function ffprobeDuration(job) {
  const url = job.streamUrl;
  return new Promise((resolve) => {
    const child = spawn(FFPROBE, [
      '-v', 'error', ...ffmpegProxyArgs(), ...deepHeadersArgs(job),
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', url,
    ], { timeout: 30000 });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('close', () => {
      const d = parseFloat(out.trim());
      resolve(Number.isFinite(d) && d > 0 ? d : null);
    });
    child.on('error', () => resolve(null));
  });
}

const RE_FFMPEG_TIME = /time=(\d+):(\d+):([\d.]+)/;

// Quick pre-flight: fetch just the response headers of the stream URL.
// When a provider hands back an HTML error page (expired/blocked link)
// instead of a playlist, fail fast with a plain message instead of
// ffmpeg's cryptic "Invalid data found when processing input".
function probeStreamHeaders(job) {
  return new Promise((resolve) => {
    const mod = job.streamUrl.startsWith('https:') ? https : http;
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
    if (job.referer && /^https?:\/\//i.test(job.referer)) headers.Referer = job.referer;
    if (job.cookies && typeof job.cookies === 'string' && job.cookies.length < 4096) headers.Cookie = job.cookies;
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const req = mod.get(job.streamUrl, { headers, timeout: 15000 }, (res) => {
      const ct = String(res.headers['content-type'] || '').toLowerCase();
      res.resume();
      res.on('end', () => finish({ status: res.statusCode, contentType: ct }));
      res.on('close', () => finish({ status: res.statusCode, contentType: ct }));
    });
    req.on('timeout', () => { req.destroy(); finish({ status: 0, contentType: '' }); });
    req.on('error', () => finish({ status: 0, contentType: '' }));
  });
}

async function startHlsDownload(job, outPath) {
  const probe = await probeStreamHeaders(job);
  if (probe.status !== 200) {
    job.status = 'error';
    job.error = 'Stream server returned HTTP ' + probe.status + '. The link may have expired — re-run the deep fetch and download right away.';
    pumpQueue();
    return;
  }
  if (/text\/html/.test(probe.contentType)) {
    job.status = 'error';
    job.error = 'Stream link returned a web page instead of video (expired or blocked). Re-run the deep fetch and download right away — if it persists, try a different stream in the list.';
    pumpQueue();
    return;
  }
  const duration = await ffprobeDuration(job);
  const args = [
    '-hide_banner', '-y',
    ...ffmpegProxyArgs(),
    ...deepHeadersArgs(job),
    '-rw_timeout', '15000000', // 15s stall timeout (microseconds)
    '-i', job.streamUrl,
    '-c', 'copy', '-bsf:a', 'aac_adtstoasc',
    outPath,
  ];
  const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '', lastError = null, tooBig = false;

  // HLS has no reliable upfront size: watch the growing file and kill ffmpeg
  // if it crosses the 2 GB cap.
  const sizeWatch = setInterval(() => {
    try {
      if (fs.statSync(outPath).size > MAX_DEEP_BYTES) {
        tooBig = true;
        child.kill('SIGKILL');
      }
    } catch { /* file may not exist yet */ }
  }, 5000);

  child.stderr.on('data', (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\r')) >= 0 || (idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      const m = line.match(RE_FFMPEG_TIME);
      if (m && duration) {
        const t = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
        job.percent = Math.min(99, (t / duration) * 100);
        job.speed = 'stream copy';
        job.eta = null;
      } else if (/error|failed|invalid/i.test(line) && !/^\s*$/.test(line)) {
        lastError = line.slice(0, 300);
      }
    }
  });
  child.on('error', (err) => {
    clearInterval(sizeWatch);
    job.status = 'error';
    job.error = 'Could not launch ffmpeg: ' + err.message;
    pumpQueue();
  });
  child.on('close', (code) => {
    clearInterval(sizeWatch);
    if (tooBig) {
      job.status = 'error';
      job.error = 'Stream exceeds the 2 GB limit.';
      try { fs.unlinkSync(outPath); } catch { /* ignore partial */ }
    } else if (code === 0 && fs.existsSync(outPath)) {
      job.status = 'done';
      job.percent = 100;
      job.speed = null;
    } else {
      job.status = 'error';
      job.error = lastError || ('ffmpeg exited with code ' + code);
      try { fs.unlinkSync(outPath); } catch { /* ignore partial */ }
    }
    pumpQueue();
  });
}

function startHttpDownload(job, outPath) {
  const mod = job.streamUrl.startsWith('https:') ? https : http;
  const file = fs.createWriteStream(outPath);
  const started = Date.now();
  let received = 0, total = null, lastTick = 0;

  const fail = (msg) => {
    if (job.status === 'error' || job.status === 'done') return; // idempotent
    try { file.destroy(); } catch { /* ignore */ }
    try { fs.unlinkSync(outPath); } catch { /* ignore */ }
    job.status = 'error';
    job.error = msg;
    pumpQueue();
  };

  const dlHeaders = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
  if (job.referer && /^https?:\/\//i.test(job.referer)) dlHeaders.Referer = job.referer;
  if (job.cookies && typeof job.cookies === 'string' && job.cookies.length < 4096) dlHeaders.Cookie = job.cookies;
  const req = mod.get(job.streamUrl, {
    headers: dlHeaders,
    timeout: 30000,
  }, (res) => {
    // Follow one redirect level (CDNs love these).
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      job.streamUrl = new URL(res.headers.location, job.streamUrl).toString();
      file.close();
      try { fs.unlinkSync(outPath); } catch { /* ignore */ }
      return startHttpDownload(job, outPath);
    }
    if (res.statusCode !== 200) {
      res.resume();
      return fail('Stream server returned HTTP ' + res.statusCode);
    }
    const len = parseInt(res.headers['content-length'], 10);
    if (Number.isFinite(len) && len > 0) total = len;
    if (Number.isFinite(len) && len > MAX_DEEP_BYTES) {
      res.resume();
      return fail('Stream exceeds the 2 GB limit.');
    }

    res.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_DEEP_BYTES) {
        req.destroy();
        return fail('Stream exceeds the 2 GB limit.');
      }
      const now = Date.now();
      if (now - lastTick < 250) return;
      lastTick = now;
      const elapsed = Math.max(0.1, (now - started) / 1000);
      const bps = received / elapsed;
      job.speed = fmtBytes(bps) + '/s';
      if (total) {
        job.percent = Math.min(99, (received / total) * 100);
        const remain = total - received;
        job.eta = bps > 0 ? fmtEta(remain / bps) : null;
      } else {
        job.percent = 0;
        job.eta = null;
      }
    });
    res.on('end', () => {
      file.end(() => {
        job.status = 'done';
        job.percent = 100;
        job.speed = null;
        job.eta = null;
        pumpQueue();
      });
    });
    res.on('error', (e) => fail('Download interrupted: ' + e.message));
    res.pipe(file);
  });
  req.on('timeout', () => { req.destroy(new Error('connection timed out')); });
  req.on('error', (e) => fail('Could not reach stream: ' + e.message));
}

function fmtEta(sec) {
  sec = Math.round(sec);
  if (!Number.isFinite(sec) || sec < 0) return null;
  const m = Math.floor(sec / 60), s = sec % 60;
  return (m > 0 ? m + 'm ' : '') + s + 's';
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

// POST /api/info {url} -> single-video metadata + curated format list,
// or a playlist listing {playlist:true, items:[...]} when the URL holds many videos.
app.post('/api/info', (req, res) => {
  const { url } = req.body || {};
  if (!validUrl(url)) return res.status(400).json({ error: 'Give me a valid http(s) URL.' });

  // Step 1: cheap flat lookup — tells a playlist apart from a single video.
  runYtDlpJson(['--dump-single-json', '--flat-playlist', '--no-warnings', url], (flatErr, flat) => {
    if (flatErr) return res.status(422).json({ error: flatErr });
    const entries = Array.isArray(flat.entries) ? flat.entries.filter(Boolean) : [];
    if ((flat._type === 'playlist' || entries.length > 1) && entries.length > 1) {
      return res.json(playlistPayload(flat, entries, url));
    }
    // Single video: full info (formats, thumbnail) for the quality picker.
    runYtDlpJson(['--dump-single-json', '--no-playlist', '--no-warnings', url], (err, data) => {
      if (err) return res.status(422).json({ error: err });
      // yt-dlp often knows the season/episode itself; fall back to parsing
      // the page URL and title for sites where it doesn't.
      const fromUrl = parseEpisodeMeta((data.webpage_url || url) + ' ' + (data.title || ''));
      const season = numOr(data.season_number) || fromUrl.season;
      const episode = numOr(data.episode_number) || fromUrl.episode;
      res.json({
        id: data.id || null,
        title: data.title || 'Untitled',
        thumbnail: data.thumbnail || null,
        duration: data.duration ? fmtDuration(data.duration) : null,
        uploader: data.uploader || data.channel || null,
        webpage_url: data.webpage_url || url,
        season, episode,
        episode_tag: formatEpisodeTag(season, episode),
        formats: curateFormats(data.formats || []),
      });
    });
  });
});

// Run yt-dlp and parse its --dump-single-json output. cb(errMsg, data).
function runYtDlpJson(args, cb) {
  let done = false;
  const finish = (err, data) => { if (!done) { done = true; cb(err, data); } };
  const child = spawnYtDlp(
    args,
    { stdio: ['ignore', 'pipe', 'pipe'], timeout: INFO_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }
  );
  let out = '', err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  child.on('error', (e) => finish('Could not run yt-dlp: ' + e.message));
  child.on('close', (code) => {
    if (code !== 0) {
      const msg = (err.match(/^ERROR:\s*(.+)$/m) || [])[1] || 'yt-dlp could not read that URL.';
      return finish(msg.trim());
    }
    try {
      finish(null, JSON.parse(out));
    } catch {
      finish('Could not parse video info.');
    }
  });
}

// Shape a flat-playlist dump into a pickable item list (cap 200, note the total).
function playlistPayload(data, entries, url) {
  const extractor = data.extractor_key || data.extractor || '';
  const items = [];
  entries.slice(0, 200).forEach((e, i) => {
    const pageUrl = entryPageUrl(e, extractor);
    const em = parseEpisodeMeta((pageUrl || '') + ' ' + (e.title || ''));
    items.push({
      index: i,
      id: e.id || null,
      title: e.title || ('Video ' + (i + 1)),
      duration: e.duration ? fmtDuration(e.duration) : null,
      uploader: e.uploader || e.channel || null,
      page_url: pageUrl,
      season: numOr(e.season_number) || em.season,
      episode: numOr(e.episode_number) || em.episode,
    });
  });
  return {
    playlist: true,
    title: data.title || 'Playlist',
    uploader: data.uploader || data.channel || null,
    count: items.length,
    total_count: entries.length,
    webpage_url: data.webpage_url || url,
    items,
  };
}

// Resolve a per-video page URL from a flat playlist entry.
function entryPageUrl(e, extractorKey) {
  for (const cand of [e.webpage_url, e.url]) {
    if (cand && validUrl(cand)) return String(cand);
  }
  const id = e.id ? String(e.id) : null;
  if (id) {
    const key = String(extractorKey || '').toLowerCase();
    if (key.includes('youtube')) return 'https://www.youtube.com/watch?v=' + id;
    if (key.includes('vimeo')) return 'https://vimeo.com/' + id;
  }
  return null;
}

// Keep the list small and useful: combined mp4s at a few heights, best audio, and "best" fallback.
function curateFormats(formats) {
  const sane = formats.filter((f) =>
    f && f.format_id && f.url && !/storyboard/i.test(String(f.format_id))
  );
  const out = [];
  const seen = new Set();

  const push = (id, label, size, height) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, label, size: size ? fmtBytes(size) : null, height: height || null });
  };

  push('best', 'Best available (auto)', null, null);

  for (const h of [2160, 1440, 1080, 720, 480, 360, 240]) {
    const cands = sane.filter((f) =>
      f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' &&
      f.ext === 'mp4' && f.height === h
    );
    if (!cands.length) continue;
    cands.sort((a, b) => (b.tbr || 0) - (a.tbr || 0));
    const f = cands[0];
    push(f.format_id, 'MP4 ' + h + 'p', f.filesize || f.filesize_approx, h);
  }

  // Best audio-only: prefer m4a, then anything with audio.
  const audio = sane.filter((f) => (!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none');
  const m4a = audio.filter((f) => f.ext === 'm4a');
  const pool = m4a.length ? m4a : audio;
  if (pool.length) {
    pool.sort((a, b) => (b.abr || 0) - (a.abr || 0));
    push(pool[0].format_id, 'Audio only' + (pool[0].abr ? ' (~' + Math.round(pool[0].abr) + 'k)' : ''), pool[0].filesize || pool[0].filesize_approx, null);
  }

  return out;
}

// POST /api/download {url, format_id, title?, season?, episode?} -> {job_id}
app.post('/api/download', (req, res) => {
  const { url, format_id, title, season, episode } = req.body || {};
  if (!validUrl(url)) return res.status(400).json({ error: 'Give me a valid http(s) URL.' });
  // format_id is passed as a single argv element (no shell), so yt-dlp
  // format-selector syntax (*, <, >, /, !, ?, ~, ^, $, |) is safe here.
  if (!format_id || typeof format_id !== 'string' || !/^[A-Za-z0-9_+\-\[\]().,= *<>\/!?~^$|]+$/.test(format_id)) {
    return res.status(400).json({ error: 'Pick a quality first.' });
  }
  const job = newJob({
    url,
    formatId: format_id.trim(),
    title: typeof title === 'string' ? title.slice(0, 200) : null,
    season, episode,
  });
  res.json({ job_id: job.id, status: job.status });
});

// POST /api/deep-info {url} -> render the page in headless Chromium and sniff stream URLs
app.post('/api/deep-info', async (req, res) => {
  const { url } = req.body || {};
  if (!validUrl(url)) return res.status(400).json({ error: 'Give me a valid http(s) URL.' });
  try {
    const result = await deepFetch(url);
    if (!result.candidates.length) {
      return res.status(422).json({ error: 'Deep fetch found no playable streams on that page.' + (result.note ? ' ' + result.note : '') });
    }
    const em = parseEpisodeMeta(url + ' ' + (result.title || ''));
    res.json({ ...result, season: em.season, episode: em.episode, episode_tag: formatEpisodeTag(em.season, em.episode) });
  } catch (e) {
    res.status(500).json({ error: 'Deep fetch failed: ' + (e.message || 'browser error') });
  }
});

// POST /api/deep-download {streamUrl, type: 'hls'|'mp4', title?, tokenize?, season?, episode?, referer?, cookies?} -> {job_id}
app.post('/api/deep-download', (req, res) => {
  const { streamUrl, type, title, tokenize, season, episode, referer, cookies } = req.body || {};
  if (!validUrl(streamUrl)) return res.status(400).json({ error: 'Bad stream URL.' });
  if (type !== 'hls' && type !== 'mp4') return res.status(400).json({ error: 'Unknown stream type.' });
  const job = newJob({
    kind: 'deep',
    streamUrl,
    streamType: type,
    title: typeof title === 'string' ? title.slice(0, 200) : null,
    season, episode,
    referer: typeof referer === 'string' && validUrl(referer) ? referer : null,
    cookies: typeof cookies === 'string' && cookies.length < 4096 ? cookies : null,
    // tokenize: 'vidsrc' — stamp a fresh short-lived token at download time.
    tokenize: tokenize === 'vidsrc' ? 'vidsrc' : null,
  });
  res.json({ job_id: job.id, status: job.status });
});

// GET /api/jobs -> list all jobs (newest first) for multi-download UI
app.get('/api/jobs', (req, res) => {
  const list = [...jobs.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((j) => ({
      id: j.id, status: j.status, percent: j.percent, speed: j.speed,
      eta: j.eta, title: j.title, filename: j.filename, error: j.error,
      season: j.season, episode: j.episode, createdAt: j.createdAt,
    }));
  res.json({ jobs: list });
});

// GET /api/jobs/:id -> job status (poll this)
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Unknown job.' });
  const { id, status, percent, speed, eta, title, filename, error, season, episode, createdAt } = job;
  res.json({ id, status, percent, speed, eta, title, filename, error, season, episode, createdAt });
});

// GET /api/files -> completed downloads
app.get('/api/files', (req, res) => {
  let files = [];
  try {
    for (const f of fs.readdirSync(DOWNLOADS_DIR)) {
      if (f.startsWith('.')) continue;
      const p = path.join(DOWNLOADS_DIR, f);
      const st = fs.statSync(p);
      if (st.isFile()) files.push({ name: f, size: st.size, size_h: fmtBytes(st.size), mtime: st.mtimeMs });
    }
  } catch (e) {
    return res.status(500).json({ error: 'Could not list downloads.' });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  res.json({ files });
});

const EXT_MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.mov': 'video/quicktime',
  '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.opus': 'audio/opus', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
};

// GET /api/file/:name -> stream the file as an attachment (phones can save it)
app.get('/api/file/:name', (req, res) => {
  const p = safeFilePath(req.params.name);
  if (!p || !fs.existsSync(p)) return res.status(404).json({ error: 'File not found.' });
  const mime = EXT_MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(path.basename(p)));
  fs.createReadStream(p).pipe(res);
});

// DELETE /api/file/:name
app.delete('/api/file/:name', (req, res) => {
  const p = safeFilePath(req.params.name);
  if (!p || !fs.existsSync(p)) return res.status(404).json({ error: 'File not found.' });
  try {
    fs.unlinkSync(p);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Could not delete file.' });
  }
});

// GET /api/settings -> { downloadDir, port, platform }
app.get('/api/settings', (req, res) => {
  res.json({ downloadDir: DOWNLOADS_DIR, port: PORT, platform: process.platform });
});

// POST /api/settings {downloadDir} -> move the save folder; persists to config.json
app.post('/api/settings', (req, res) => {
  const { downloadDir } = req.body || {};
  if (typeof downloadDir !== 'string' || !downloadDir.trim()) {
    return res.status(400).json({ error: 'Give me a folder path.' });
  }
  const raw = downloadDir.trim();
  // Check the raw input: path.resolve() always returns an absolute path,
  // so validating the resolved value would accept "relative/path" too.
  if (!path.isAbsolute(raw)) {
    return res.status(400).json({ error: 'Use a full path, e.g. E:\\video-downloads' });
  }
  const resolved = path.resolve(raw);
  try {
    fs.mkdirSync(resolved, { recursive: true });
    fs.accessSync(resolved, fs.constants.W_OK);
  } catch {
    return res.status(400).json({ error: 'Cannot write to that folder.' });
  }
  DOWNLOADS_DIR = resolved;
  try {
    saveConfig({ ...loadConfig(), downloadDir: resolved });
  } catch { /* non-fatal: keeps working for this run */ }
  res.json({ downloadDir: DOWNLOADS_DIR });
});

// ---------------------------------------------------------------------------
// Housekeeping: delete files older than 24h (Railway disk is ephemeral anyway)
// ---------------------------------------------------------------------------
function sweepOldFiles() {
  const cutoff = Date.now() - FILE_TTL_MS;
  try {
    for (const f of fs.readdirSync(DOWNLOADS_DIR)) {
      const p = path.join(DOWNLOADS_DIR, f);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && st.mtimeMs < cutoff) {
          fs.unlinkSync(p);
          console.log('Swept old file:', f);
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}
sweepOldFiles();
setInterval(sweepOldFiles, 60 * 60 * 1000);

// ---------------------------------------------------------------------------
// Static frontend
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log('video-downloader listening on port ' + PORT);
});
