@echo off
REM Double-click this to open the science feed in your browser.
cd /d "%~dp0"
echo Starting the feed... a browser tab will open.
echo Keep this black window open while you use it. Close it to stop.
start "" http://localhost:5173
node serve.js
pause
