@echo off
rem Aster CLI launcher (source-controlled). The build artifact bin\aster.mjs is gitignored.
rem Keep this file ASCII-only: cmd.exe parses .cmd using the console code page, so
rem multi-byte comments would be mis-decoded and break parsing on non-UTF-8 consoles.
rem
rem Default ASTER_HOME = <repo>\.aster (%~dp0..\.aster), i.e. always on the repo's drive.
rem An ASTER_HOME already set in the environment wins and is never overwritten.
setlocal
if "%ASTER_HOME%"=="" set "ASTER_HOME=%~dp0..\.aster"
node "%~dp0aster.mjs" %*
