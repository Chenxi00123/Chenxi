@echo off
rem Aster desktop launcher (source-controlled). Requires the built desktop main + the Electron binary
rem that already lives in node_modules (D drive).
rem Keep this file ASCII-only: cmd.exe parses .cmd using the console code page.
rem
rem Default ASTER_HOME = <repo>\.aster (%~dp0..\.aster), i.e. always on the repo's drive.
rem An ASTER_HOME already set in the environment wins and is never overwritten.
rem
rem NEVER touches PATH and never runs setx (project rule: zero system changes).
setlocal
if "%ASTER_HOME%"=="" set "ASTER_HOME=%~dp0..\.aster"
if not exist "%~dp0..\packages\desktop\dist\app\main.mjs" (
  echo aster-desktop: desktop app not built - run: node "C:\dev\node-v22.23.2-win-x64\node_modules\npm\bin\npm-cli.js" run desktop-app
  exit /b 1
)
if not exist "%~dp0..\node_modules\electron\dist\electron.exe" (
  echo aster-desktop: Electron binary missing - see README "Desktop (experimental)" for the offline-friendly install steps
  exit /b 1
)
node "%~dp0..\node_modules\electron\cli.js" "%~dp0..\packages\desktop\dist\app\main.mjs" %*
