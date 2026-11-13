@echo off
rem Chenxi desktop launcher (source-controlled). Requires the built desktop main + the Electron binary
rem that already lives in node_modules (D drive).
rem Keep this file ASCII-only: cmd.exe parses .cmd using the console code page.
rem
rem Default CHENXI_HOME = <repo>\.chenxi (%~dp0..\.chenxi), i.e. always on the repo's drive.
rem An CHENXI_HOME already set in the environment wins and is never overwritten.
rem
rem NEVER touches PATH and never runs setx (project rule: zero system changes).
setlocal
if "%CHENXI_HOME%"=="" set "CHENXI_HOME=%~dp0..\.chenxi"
if not exist "%~dp0..\packages\desktop\dist\app\main.mjs" (
  echo chenxi-desktop: desktop app not built - run: npm run desktop-app
  exit /b 1
)
if not exist "%~dp0..\node_modules\electron\dist\electron.exe" (
  echo chenxi-desktop: Electron binary missing - see README "Desktop (experimental)" for the offline-friendly install steps
  exit /b 1
)
node "%~dp0..\node_modules\electron\cli.js" "%~dp0..\packages\desktop\dist\app\main.mjs" %*
