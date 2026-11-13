@echo off
rem Chenxi CLI launcher (source-controlled). The build artifact bin\chenxi.mjs is gitignored.
rem Keep this file ASCII-only: cmd.exe parses .cmd using the console code page, so
rem multi-byte comments would be mis-decoded and break parsing on non-UTF-8 consoles.
rem
rem Default CHENXI_HOME = <repo>\.chenxi (%~dp0..\.chenxi), i.e. always on the repo's drive.
rem An CHENXI_HOME already set in the environment wins and is never overwritten.
setlocal
if "%CHENXI_HOME%"=="" set "CHENXI_HOME=%~dp0..\.chenxi"
node "%~dp0chenxi.mjs" %*
