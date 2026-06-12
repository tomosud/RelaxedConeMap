@echo off
setlocal
cd /d "%~dp0"
set PORT=8765

where python >nul 2>nul
if %errorlevel%==0 (
  start "" "http://localhost:%PORT%/"
  python -m http.server %PORT%
  goto :eof
)

where py >nul 2>nul
if %errorlevel%==0 (
  start "" "http://localhost:%PORT%/"
  py -m http.server %PORT%
  goto :eof
)

echo Python not found. Please install Python 3 from https://www.python.org/
pause
