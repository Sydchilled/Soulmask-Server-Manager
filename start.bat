@echo off
title ChillWithSyd Server Manager
cd /d "%~dp0"

echo.
echo  ==========================================
echo   ChillWithSyd  --  Server Manager  v1.1
echo  ==========================================
echo.

:: ── Load port from config.env ─────────────────────────────────────────────
set CWS_PORT=3000
if exist "%~dp0config.env" (
    for /f "tokens=1,2 delims==" %%a in ('type "%~dp0config.env" ^| findstr /i "CWS_PORT"') do (
        set %%a=%%b
    )
)

:: ── Check Node.js ──────────────────────────────────────────────────────────
where node >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Node.js is not installed or not found in PATH.
    echo.
    echo  Download the LTS version from: https://nodejs.org/en/download
    echo.
    choice /C YN /M "Open the Node.js download page now?"
    if errorlevel 2 goto :node_abort
    start "" "https://nodejs.org/en/download"
    :node_abort
    pause
    exit /b 1
)

:: ── Check Node version 16+ ────────────────────────────────────────────────
for /f "tokens=1 delims=." %%v in ('node -e "process.stdout.write(process.version.slice(1))"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 16 (
    echo  [WARNING] Node.js v%NODE_MAJOR% detected. Version 16+ recommended.
    echo.
)

:: ── Check server.js exists ────────────────────────────────────────────────
if not exist "%~dp0server.js" (
    echo  [ERROR] server.js not found in this folder.
    pause
    exit /b 1
)

:: ── Kill any existing instance ────────────────────────────────────────────
if exist "%~dp0.pid" (
    set /p OLD_PID=<"%~dp0.pid"
    taskkill /PID %OLD_PID% /F >nul 2>&1
    del "%~dp0.pid" >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":%CWS_PORT% "') do (
    taskkill /PID %%a /F >nul 2>&1
)

:: ── Launch Node via PowerShell (hidden, no window, survives start.bat closing)
echo  Starting Server Manager on port %CWS_PORT%...
powershell -NoProfile -WindowStyle Hidden -Command ^
    "$env:CWS_PORT='%CWS_PORT%'; " ^
    "$p = Start-Process -FilePath 'node' -ArgumentList '\"%~dp0server.js\"' -WorkingDirectory '%~dp0' -WindowStyle Hidden -PassThru; " ^
    "$p.Id | Out-File -Encoding ascii '%~dp0.pid'"

:: Wait for backend to start
timeout /t 3 /nobreak >nul

:: Verify
if exist "%~dp0.pid" (
    set /p PID=<"%~dp0.pid"
    echo  Manager started - PID %PID% - port %CWS_PORT%
) else (
    echo  [WARNING] Could not confirm manager started.
    echo  Try running manually: node "%~dp0server.js"
)

:: Open browser
start "" "http://localhost:%CWS_PORT%"

echo.
echo  Dashboard: http://localhost:%CWS_PORT%
echo  To stop:   run stop.bat
echo.
