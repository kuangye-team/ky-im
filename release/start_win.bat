@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0"
if errorlevel 1 exit /b 1

if not exist ".env" (
  copy /y ".env.example" ".env" >nul
  if errorlevel 1 exit /b 1
)
rem Use literal KEY=value entries; preserve empty values and ignore # comments.
for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do set "%%A=%%B"
if not defined STATIC_DIR set "STATIC_DIR=.\dist"

if not exist "bin\server_windows_amd64.exe" (
  echo Missing server binary. Extract the complete release archive. >&2
  exit /b 1
)
if not exist "%STATIC_DIR%\index.html" (
  echo Missing frontend assets. Extract the complete release archive. >&2
  exit /b 1
)
"%~dp0bin\server_windows_amd64.exe"
exit /b %errorlevel%
