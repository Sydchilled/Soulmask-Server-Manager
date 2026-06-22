@echo off
title ChillWithSyd - Stopping
cd /d "%~dp0"

set CWS_PORT=3000
if exist "%~dp0config.env" (
    for /f "tokens=1,2 delims==" %%a in ('type "%~dp0config.env" ^| findstr /i "CWS_PORT"') do (
        set %%a=%%b
    )
)

echo Stopping ChillWithSyd Manager...

:: Kill by PID file (cleanest method)
if exist "%~dp0.pid" (
    set /p PID=<"%~dp0.pid"
    taskkill /PID %PID% /F >nul 2>&1
    del "%~dp0.pid" >nul 2>&1
    echo Stopped PID %PID%
) else (
    :: Fallback - kill by port
    for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":%CWS_PORT% "') do (
        taskkill /PID %%a /F >nul 2>&1
    )
    echo Stopped process on port %CWS_PORT%
)

if exist "%~dp0launch_helper.vbs" del "%~dp0launch_helper.vbs" >nul 2>&1

echo Done.
timeout /t 2 /nobreak >nul
