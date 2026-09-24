@echo off
setlocal
title video-downloader setup
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install the LTS version from https://nodejs.org , then run this again.
  pause
  exit /b 1
)

echo --- Installing Node packages ---
call npm install
if errorlevel 1 (
  echo [ERROR] npm install failed. Check your internet connection and try again.
  pause
  exit /b 1
)

if not exist bin mkdir bin

if not exist "bin\yt-dlp.exe" (
  echo --- Downloading yt-dlp ---
  powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' -OutFile 'bin\yt-dlp.exe'"
) else (
  echo --- yt-dlp already present, skipping ---
)
if not exist "bin\yt-dlp.exe" (
  echo [ERROR] yt-dlp download failed.
  pause
  exit /b 1
)

if not exist "bin\ffmpeg.exe" (
  echo --- Downloading ffmpeg ---
  powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile '%TEMP%\ffmpeg-dl.zip'"
  powershell -NoProfile -Command "Expand-Archive -Path '%TEMP%\ffmpeg-dl.zip' -DestinationPath '%TEMP%\ffmpeg-dl' -Force"
  powershell -NoProfile -Command "$d = Get-ChildItem '%TEMP%\ffmpeg-dl' -Directory | Select-Object -First 1; Copy-Item (Join-Path $d.FullName 'bin\ffmpeg.exe') 'bin\ffmpeg.exe' -Force; Copy-Item (Join-Path $d.FullName 'bin\ffprobe.exe') 'bin\ffprobe.exe' -Force"
  del "%TEMP%\ffmpeg-dl.zip" 2>nul
  rmdir /s /q "%TEMP%\ffmpeg-dl" 2>nul
) else (
  echo --- ffmpeg already present, skipping ---
)
if not exist "bin\ffmpeg.exe" (
  echo [ERROR] ffmpeg download failed.
  pause
  exit /b 1
)

echo --- Installing headless browser for deep fetch (one-time, ~170 MB) ---
call npx playwright-chromium install chromium
if errorlevel 1 (
  echo [WARN] Browser install hit an issue. Normal downloads will work; deep fetch may not.
)

echo.
echo === Setup done! Double-click start-windows.bat to run the app. ===
echo     Downloads will save to E:\video-downloads by default.
echo     You can change the folder anytime in the app under Library ^> Change.
pause
