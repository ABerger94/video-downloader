# Video Downloader

Paste a video-page URL, pick a quality, download it, then stream it or save it to your phone. Single Node/Express service — no build step, no database, no env vars.

## How it works

- Frontend (`public/index.html`) — mobile-first dark UI. Paste URL → fetch info → pick quality → watch the progress bar → file lands in the Library, where you can Play (inline), Save (download to phone), or Delete.
- Backend (`server.js`) — Express API on top of `yt-dlp` (invoked as `python3 -m yt_dlp`, with `yt-dlp` on PATH as fallback):
  - `POST /api/info` — video title, thumbnail, duration, uploader + a curated quality list (combined MP4s at a few heights, best audio-only, "best" fallback).
  - `POST /api/download` — starts a download job (max 2 at once, extras queue).
  - `GET /api/jobs/:id` — poll for progress (percent, speed, ETA).
  - `GET /api/files` / `GET /api/file/:name` / `DELETE /api/file/:name` — manage completed downloads.
  - `GET /api/settings` / `POST /api/settings` — view or change the save folder from the UI (Library → Change). Persists to `config.json`.
- Guards: only http(s) URLs, `--no-playlist` always, 2 GB max file size, 2 concurrent downloads, filenames restricted to safe characters, files auto-deleted after 24h (Railway disk is ephemeral anyway).
- **Deep fetch** (`deepfetch.js`, Playwright + headless Chromium) — for JS-heavy streaming sites yt-dlp can't read. The frontend offers "Try deep fetch" automatically when `/api/info` reports an unsupported URL:
  - `POST /api/deep-info` — opens the page in a real headless browser, sniffs network traffic for `.m3u8`/`.mp4` streams, checks `<video>` tags, and tries one click-to-play if nothing shows up yet. Returns candidate streams.
  - `POST /api/deep-download` — downloads a sniffed stream: HLS via `ffmpeg -c copy` to MP4, direct MP4 via streamed HTTP download. Lands in the same Library as everything else.
  - Deep fetches run one browser at a time (memory safety on small containers).

## Run it locally

```bash
npm install
pip install -r requirements.txt   # needs python3 + ffmpeg on PATH
./node_modules/.bin/playwright install --with-deps chromium   # for deep fetch (needs sudo for the apt deps)
node server.js                     # listens on $PORT (default 3000)
```

## Run on your Windows laptop (no hosting needed)

You don't need Railway at all. The app runs on your laptop exactly like
MediaDash, and videos save straight to your E drive.

**First time (one click):**

1. Clone the repo somewhere on your laptop, e.g. `C:\apps\video-downloader`
   (or download the ZIP from GitHub and extract it).
2. Double-click **`setup-windows.bat`**. It installs the Node packages,
   downloads `yt-dlp.exe` + `ffmpeg.exe`/`ffprobe.exe` into `bin\` (no Python
   install needed), and installs the headless Chromium browser used by deep
   fetch. No admin rights needed — everything lives inside the project folder.

**Every time after that:**

1. Double-click **`start-windows.bat`**.
2. On the laptop open `http://localhost:3000`.
3. On your phone (same WiFi) open `http://<your-laptop-IP>:3000` — find the IP
   with `ipconfig` (look for IPv4 Address), same as MediaDash.
4. Keep the laptop awake and the window open while you download.

**Where files go:** `E:\video-downloads` by default on Windows. Change it any
time in the app under Library → Change — the choice is saved to `config.json`
(next to `server.js`, never committed to git) and survives restarts. You can
also edit `config.json` by hand, or override with the `DOWNLOAD_DIR` env var.

Power users: `config.json` accepts `{ "downloadDir": "E:\\video-downloads", "port": 3000 }` — see `config.example.json`. The `bin\` folder and `config.json` are gitignored.

## Deploy to Railway (3 steps)

1. Create a new project in [Railway](https://railway.app), choose **Deploy from GitHub repo**, and pick this repo.
2. Railway auto-detects `nixpacks.toml`, installs Node + Python + ffmpeg + yt-dlp, then installs Playwright's Chromium and its OS dependencies (via a dedicated `browser` build phase that runs `playwright install --with-deps chromium`, so the right Debian packages are picked automatically). Starts with `PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright node server.js`. No environment variables needed.
3. Open the public URL Railway gives you (add a domain under the service's Settings → Networking). Done.

Notes:

- Feel free to rename the repo later — nothing in the code depends on the name.
- This is a single-user tool with no login. If you want to put it on a public URL, add a simple password gate later (e.g. check a `PASSWORD` env var in an Express middleware).

## Honest caveats

- `yt-dlp` supports hundreds of sites, but some (YouTube especially) actively fight datacenter IPs and automated downloads — an occasional URL will just refuse. That's the site blocking you, not a bug in this app.
- Deep fetch is a best-effort path for streaming-aggregator sites: they rotate players, hosts, and anti-bot measures constantly, so a site that works today may need tweaks tomorrow. It also runs a full browser, so it's slower (~30–60s per fetch) and heavier than the yt-dlp path.
- Download only videos you have the right to download.
