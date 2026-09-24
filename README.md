# Video Downloader

Paste a video-page URL, pick a quality, download it, then stream it or save it to your phone. Single Node/Express service — no build step, no database, no env vars.

## How it works

- Frontend (`public/index.html`) — mobile-first dark UI. Paste URL → fetch info → pick quality → watch the progress bar → file lands in the Library, where you can Play (inline), Save (download to phone), or Delete.
- Backend (`server.js`) — Express API on top of `yt-dlp` (invoked as `python3 -m yt_dlp`, with `yt-dlp` on PATH as fallback):
  - `POST /api/info` — video title, thumbnail, duration, uploader + a curated quality list (combined MP4s at a few heights, best audio-only, "best" fallback).
  - `POST /api/download` — starts a download job (max 2 at once, extras queue).
  - `GET /api/jobs/:id` — poll for progress (percent, speed, ETA).
  - `GET /api/files` / `GET /api/file/:name` / `DELETE /api/file/:name` — manage completed downloads.
- Guards: only http(s) URLs, `--no-playlist` always, 2 GB max file size, 2 concurrent downloads, filenames restricted to safe characters, files auto-deleted after 24h (Railway disk is ephemeral anyway).

## Run it locally

```bash
npm install
pip install -r requirements.txt   # needs python3 + ffmpeg on PATH
node server.js                     # listens on $PORT (default 3000)
```

## Deploy to Railway (3 steps)

1. Create a new project in [Railway](https://railway.app), choose **Deploy from GitHub repo**, and pick this repo.
2. Railway auto-detects `nixpacks.toml`, installs Node + Python + ffmpeg + yt-dlp, and starts `node server.js`. No environment variables needed.
3. Open the public URL Railway gives you (add a domain under the service's Settings → Networking). Done.

Notes:

- Feel free to rename the repo later — nothing in the code depends on the name.
- This is a single-user tool with no login. If you want to put it on a public URL, add a simple password gate later (e.g. check a `PASSWORD` env var in an Express middleware).

## Honest caveats

- `yt-dlp` supports hundreds of sites, but some (YouTube especially) actively fight datacenter IPs and automated downloads — an occasional URL will just refuse. That's the site blocking you, not a bug in this app.
- Download only videos you have the right to download.
