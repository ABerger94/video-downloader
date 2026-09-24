@echo off
title video-downloader
cd /d "%~dp0"

if not exist "bin\yt-dlp.exe" (
  echo [ERROR] Not set up yet. Double-click setup-windows.bat first.
  pause
  exit /b 1
)

echo Starting video-downloader...
echo.
echo   On this laptop:  http://localhost:3000
echo   On your phone ^(same WiFi^): http://YOUR_LAPTOP_IP:3000
echo   (Find the IP by running  ipconfig  and looking for IPv4 Address)
echo.
echo Keep this window open while you use the app. Close it to stop.
echo.
node server.js
pause
