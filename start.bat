@echo off
title LogiSense 360 - Frontend Static Server
color 0A

echo.
echo  ============================================================
echo    LOGISENSE 360 - Frontend Static Server
echo  ============================================================
echo.
echo    Serves: Static files (HTML/CSS/JS + ChatBot)
echo    URL:    http://localhost:3000
echo.
echo    IMPORTANT: Backend must be running first!
echo    Run ..\backend\start.bat in a separate window.
echo  ============================================================
echo.

:: ── Change to frontend directory ───────────────────────────────────────────────
cd /d "%~dp0"

:: ── Add common Node.js install paths to PATH ─────────────────────────────────
set "PATH=%PATH%;C:\Program Files\nodejs;%APPDATA%\npm;%ProgramFiles%\nodejs"

:: ── Check Node.js is installed ────────────────────────────────────────────────
node --version >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Node.js not found.
    echo  Install from https://nodejs.org  ^(LTS version recommended^)
    echo  After install, close and re-open this window.
    pause
    exit /b 1
)

:: ── Verify config.js exists ───────────────────────────────────────────────────
if not exist "config.js" (
    echo  [WARNING] config.js not found. Creating default...
    echo window.FLEET_API_BASE = 'http://localhost:1995'; > "config.js"
)

:: ── Install / ensure http-server is available via npx ────────────────────────
echo  [1/2] Ensuring http-server is available...
call npx --yes http-server --version >nul 2>&1
echo        Done.

echo  [2/2] Starting static file server on http://localhost:3000
echo.
echo  ============================================================
echo    Frontend ready at:   http://localhost:3000
echo    ChatBot at:          http://localhost:3000/Customer_ChatBot/
echo.
echo    To point to a different backend, edit:
echo      config.js  ^(in the frontend folder^)
echo  ============================================================
echo.
echo  Press Ctrl+C to stop.
echo.

:: ── Open browser in background after server is ready (4 second delay) ─────────
start /b cmd /c "timeout /t 4 /nobreak >nul && start http://localhost:3000"

:: ── Start http-server from the current directory (no trailing-backslash issue) ─
:: We already cd'd to the frontend folder above, so use . as the path
npx --yes http-server . -p 3000 --cors -c-1

pause
