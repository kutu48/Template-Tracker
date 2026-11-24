@echo off
setlocal enabledelayedexpansion

REM ============================================================================
REM CNC Template Tracker — Launcher Mandiri PC (Offline-First, Tanpa Node/Server)
REM Membuka public\index.html dalam mode aplikasi Edge/Chrome dengan profil
REM browser (IndexedDB + sesi) tersimpan di folder browser-data di dalam folder ini.
REM ============================================================================

set "APP_DIR=%~dp0"
set "HTML_PATH=%APP_DIR%public\index.html"
set "DATA_DIR=%APP_DIR%browser-data"

if not exist "%HTML_PATH%" (
    echo [ERROR] File "%HTML_PATH%" tidak ditemukan!
    echo Pastikan Jalankan.bat berada di folder utama project bersama folder public\.
    pause
    exit /b 1
)

if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"

REM Konversi path lokal ke URL file:/// (slash & spasi)
set "FILE_URL=%HTML_PATH:\=/%"
set "FILE_URL=!FILE_URL: =%%20!"
set "FILE_URL=file:///!FILE_URL!"

REM Cari Microsoft Edge atau Google Chrome
set "BROWSER="
for %%P in (
    "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
    "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
    "%LocalAppData%\Microsoft\Edge\Application\msedge.exe"
    "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
    "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
    "%LocalAppData%\Google\Chrome\Application\chrome.exe"
) do (
    if not defined BROWSER if exist %%~P set "BROWSER=%%~P"
)

if defined BROWSER (
    start "" "%BROWSER%" --app="!FILE_URL!" --user-data-dir="%DATA_DIR%" --no-first-run --disable-default-apps
    exit /b 0
)

echo [INFO] Microsoft Edge / Google Chrome tidak ditemukan di lokasi standar.
echo Membuka aplikasi di browser bawaan sistem...
start "" "%HTML_PATH%"
exit /b 0
