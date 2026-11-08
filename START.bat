@echo off
setlocal
cd /d "%~dp0"
title QuizControl

 echo [1/4] Checking Python...
where python >nul 2>nul
if errorlevel 1 (
  echo Python was not found. Install Python 3.11+ and enable Add Python to PATH.
  echo https://www.python.org/downloads/windows/
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo [2/4] Creating virtual environment...
  python -m venv .venv
  if errorlevel 1 goto error
) else (
  echo [2/4] Virtual environment already exists.
)

echo [3/4] Installing required packages...
.venv\Scripts\python.exe -m pip install --disable-pip-version-check -r requirements.txt
if errorlevel 1 goto error

echo [4/4] Starting QuizControl...
where tuna >nul 2>nul
if errorlevel 1 (
  echo Tuna CLI was not found. Local mode will start without a public link.
  echo Install Tuna CLI and run tuna login to enable phone access outside your Wi-Fi.
) else (
  start "QuizControl Tuna" cmd /k "tuna http 8080"
)

start "QuizControl Browser" cmd /c "timeout /t 3 /nobreak >nul & start http://127.0.0.1:8080/admin"
.venv\Scripts\python.exe -m uvicorn app:app --host 0.0.0.0 --port 8080

echo QuizControl server stopped.
pause
exit /b 0

:error
echo Startup failed. Check the error messages above.
pause
exit /b 1
