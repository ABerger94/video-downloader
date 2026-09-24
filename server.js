// video-downloader — single-service Node/Express app.
// Paste a video-page URL, pick a quality, download it, then stream or save it to your phone.
// Backend: yt-dlp does the fetching and downloading. Frontend: static files in public/.

const express = require('express');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

const MAX_CONCURRENT = 2; // downloads running at once; extras queue
const MAX_FILESIZE = '2G'; // refuse anything bigger
const FILE_TTL_MS = 24 * 60 * 60 * 1000; // delete files older than 24h
const INFO_TIMEOUT_MS = 90000;

// ---------------------------------------------------------------------------
// yt-dlp resolution: prefer `python3 -m yt_dlp`, fall back to `yt-dlp` on PATH.
// ---------------------------------------------------------------------------
function pickYtDlp() {
  const r1 = spawnSync('python3', ['-m', 'yt_dlp', '--version'], { timeout: 20000, encoding: 'utf8' });
  if (r1.status === 0) return { cmd: 'python3', prefix: ['-m', 'yt_dlp'] };
  const r2 = spawnSync('yt-dlp', ['--version'], { timeout: 20000, encoding: 'utf8' });
  if (r2.status === 0) return { cmd: 'yt-dlp', prefix: [] };
  return null;
}
const YTDLP = pickYtDlp();
if (!YTDLP) {
  console.error('FATAL: yt-dlp not found. Install it with: pip install yt-dlp');
  process.exit(1);
}
console.log('yt-dlp:', [YTDLP.cmd, ...YTDLP.prefix].join(' '));

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

function newJob(url, formatId, title) {
  const id = crypto.randomBytes(8).toString('hex');
  const job = {
    id, url, formatId, title: title || null,
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
  job.status = 'downloading';
  const outTpl = path.join(DOWNLOADS_DIR, '%(title).80s [%(id)s].%(ext)s');
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
// API
// ---------------------------------------------------------------------------

// POST /api/info {url} -> video metadata + curated format list
app.post('/api/info', (req, res) => {
  const { url } = req.body || {};
  if (!validUrl(url)) return res.status(400).json({ error: 'Give me a valid http(s) URL.' });

  const child = spawnYtDlp(
    ['--dump-single-json', '--no-playlist', '--no-warnings', url],
    { stdio: ['ignore', 'pipe', 'pipe'], timeout: INFO_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }
  );

  let out = '', err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  child.on('error', (e) => res.status(500).json({ error: 'Could not run yt-dlp: ' + e.message }));
  child.on('close', (code) => {
    if (res.headersSent) return;
    if (code !== 0) {
      const msg = (err.match(/^ERROR:\s*(.+)$/m) || [])[1] || 'yt-dlp could not read that URL.';
      return res.status(422).json({ error: msg.trim() });
    }
    let data;
    try {
      data = JSON.parse(out);
    } catch {
      return res.status(500).json({ error: 'Could not parse video info.' });
    }
    res.json({
      id: data.id || null,
      title: data.title || 'Untitled',
      thumbnail: data.thumbnail || null,
      duration: data.duration ? fmtDuration(data.duration) : null,
      uploader: data.uploader || data.channel || null,
      webpage_url: data.webpage_url || url,
      formats: curateFormats(data.formats || []),
    });
  });
});

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

// POST /api/download {url, format_id, title?} -> {job_id}
app.post('/api/download', (req, res) => {
  const { url, format_id, title } = req.body || {};
  if (!validUrl(url)) return res.status(400).json({ error: 'Give me a valid http(s) URL.' });
  if (!format_id || typeof format_id !== 'string' || !/^[A-Za-z0-9_+\-\[\]().,= ]+$/.test(format_id)) {
    return res.status(400).json({ error: 'Pick a quality first.' });
  }
  const job = newJob(url, format_id.trim(), typeof title === 'string' ? title.slice(0, 200) : null);
  res.json({ job_id: job.id, status: job.status });
});

// GET /api/jobs/:id -> job status (poll this)
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Unknown job.' });
  const { id, status, percent, speed, eta, title, filename, error, createdAt } = job;
  res.json({ id, status, percent, speed, eta, title, filename, error, createdAt });
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
