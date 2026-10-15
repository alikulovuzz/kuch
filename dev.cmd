@echo off
rem Runs dev.sh (API + Vite dev server) from PowerShell or cmd on Windows:  .\dev.cmd
rem
rem A plain `bash` there is usually WSL's launcher, not Git Bash, and fails without a Linux distro.
rem This finds the Git Bash that ships with Git for Windows and hands dev.sh to it. Variables work
rem as with dev.sh:  $env:WEB_PORT=5174; .\dev.cmd
setlocal

set "GITBASH="
for /f "delims=" %%G in ('where git 2^>nul') do if not defined GITBASH if exist "%%~dpG..\bin\bash.exe" set "GITBASH=%%~dpG..\bin\bash.exe"
if not defined GITBASH if exist "%ProgramFiles%\Git\bin\bash.exe" set "GITBASH=%ProgramFiles%\Git\bin\bash.exe"
if not defined GITBASH (
  echo Git Bash not found. Install Git for Windows: https://git-scm.com/download/win 1>&2
  exit /b 1
)

rem Forward slashes: dev.sh finds its own folder with dirname, which doesn't split on backslashes.
set "SCRIPT=%~dp0dev.sh"
set "SCRIPT=%SCRIPT:\=/%"
"%GITBASH%" "%SCRIPT%" %*
