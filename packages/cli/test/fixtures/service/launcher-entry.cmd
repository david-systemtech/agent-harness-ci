@echo off
rem The agent-harness launcher entry. Written by "agent-harness service install";
rem "agent-harness service uninstall" removes it. The logon task runs it, and it
rem starts the launcher of the version the launcher version file names, again 5
rem seconds after each non-zero exit (a crash, or a handover to a newer launcher),
rem since Task Scheduler restarts a task only when it could not start it. With no
rem such version it exits. The launcher's lines go to the service log. The line
rem that runs the launcher ends in its own exits, since cmd reads this file by
rem offset and install may replace it while the launcher runs.
setlocal EnableExtensions DisableDelayedExpansion
set "DATA_DIR=C:\Users\david\AppData\Local\agent-harness"
set "LOG=%DATA_DIR%\logs\service.log"
:start
set "VERSION="
if exist "%DATA_DIR%\launcher-version" for /f "usebackq delims=" %%V in ("%DATA_DIR%\launcher-version") do if not defined VERSION set "VERSION=%%V"
if not defined VERSION goto no_version
if not exist "%DATA_DIR%\versions\%VERSION%\.complete" goto not_complete
"%DATA_DIR%\versions\%VERSION%\node\node.exe" "%DATA_DIR%\versions\%VERSION%\packages\cli\dist\main.js" launch --data-dir C:\Users\david\AppData\Local\agent-harness --port 7433 --name ^"David's desk^" >>"%LOG%" 2>&1 && exit /b 0 || goto restart
:restart
>>"%LOG%" echo launcher entry: the launcher exited with code %ERRORLEVEL%, so it starts again in 5 s.
ping -n 6 127.0.0.1 >nul
goto start
:no_version
>>"%LOG%" echo launcher entry: "%DATA_DIR%\launcher-version" names no version, so no launcher starts; "agent-harness service install" writes it.
exit /b 0
:not_complete
>>"%LOG%" echo launcher entry: "%VERSION%" is not complete in "%DATA_DIR%\versions", so no launcher starts; "agent-harness service install" puts a version there.
exit /b 0
