@echo off
rem The agent-harness launcher entry. Written by "agent-harness service install";
rem "agent-harness service uninstall" removes it. The logon task runs it, and it
rem starts the launcher of the version the launcher version file names, again 5
rem seconds after each non-zero exit (a crash, or a handover to a newer launcher),
rem since Task Scheduler restarts a task only when it could not start it. With no
rem such version it exits. The launcher writes the service log itself, which
rem AGENT_HARNESS_SERVICE_LOG names: cmd holds a file it redirects to for itself
rem alone, so a second launcher could not start while one ran, nor say why. Its
rem restart line it tries again for a few seconds while another holds the log,
rem then leaves the code in AGENT_HARNESS_UNLOGGED_EXIT for the next launcher to write.
rem The line that runs the launcher ends in its own exits, since cmd reads this file by
rem offset and install may replace it while the launcher runs. It counts the
rem starts of a launcher handed over to until that launcher confirms, and after
rem 3 unconfirmed starts names the launcher that handed over again.
setlocal EnableExtensions DisableDelayedExpansion
set "DATA_DIR=C:\Users\david\AppData\Local\agent-harness"
set "LOG=%DATA_DIR%\logs\service.log"
set "AGENT_HARNESS_SERVICE_LOG=%LOG%"
:start
set "VERSION="
if exist "%DATA_DIR%\launcher-version" findstr /r "[^0-9A-Za-z.+-]" "%DATA_DIR%\launcher-version" >nul && goto no_version
if exist "%DATA_DIR%\launcher-version" for /f "usebackq delims=" %%V in ("%DATA_DIR%\launcher-version") do if not defined VERSION set "VERSION=%%V"
if not defined VERSION goto no_version
set "FROM="
set "TO="
if exist "%DATA_DIR%\launcher-handover" findstr /r "[^0-9A-Za-z.+-]" "%DATA_DIR%\launcher-handover" >nul || for /f "usebackq delims=" %%L in ("%DATA_DIR%\launcher-handover") do if not defined FROM (set "FROM=%%L") else if not defined TO set "TO=%%L"
if not defined TO goto run
if not "%TO%"=="%VERSION%" goto run
set "STARTS=0"
if exist "%DATA_DIR%\launcher-handover-starts" findstr /r "[^0-9]" "%DATA_DIR%\launcher-handover-starts" >nul || for /f "usebackq delims=" %%N in ("%DATA_DIR%\launcher-handover-starts") do set /a "STARTS=%%N"
if %STARTS% GEQ 3 goto fall_back
set /a "STARTS+=1"
>"%DATA_DIR%\.launcher-handover-starts.tmp" echo %STARTS%
move /y "%DATA_DIR%\.launcher-handover-starts.tmp" "%DATA_DIR%\launcher-handover-starts" >nul
goto run
:fall_back
>>"%LOG%" echo launcher entry: the launcher of %TO% was started %STARTS% times without confirming that its child passed the gate, so the launcher of %FROM% starts again.
>"%DATA_DIR%\.launcher-version.tmp" echo %FROM%
move /y "%DATA_DIR%\.launcher-version.tmp" "%DATA_DIR%\launcher-version" >nul
set "VERSION=%FROM%"
:run
if not exist "%DATA_DIR%\versions\%VERSION%\.complete" goto not_complete
"%DATA_DIR%\versions\%VERSION%\node\node.exe" "%DATA_DIR%\versions\%VERSION%\packages\cli\dist\main.js" launch --data-dir C:\Users\david\AppData\Local\agent-harness --port 7433 --name ^"David's desk^" && exit /b 0 || goto restart
:restart
set "CODE=%ERRORLEVEL%"
set "TRIES=0"
set "AGENT_HARNESS_UNLOGGED_EXIT="
:restart_line
set /a "TRIES+=1"
(>>"%LOG%" echo launcher entry: the launcher exited with code %CODE%, so it starts again in 5 s.) 2>nul || (if %TRIES% LSS 5 (ping -n 2 127.0.0.1 >nul & goto restart_line) else set "AGENT_HARNESS_UNLOGGED_EXIT=%CODE%")
ping -n 6 127.0.0.1 >nul
goto start
:no_version
>>"%LOG%" echo launcher entry: "%DATA_DIR%\launcher-version" names no version, so no launcher starts; "agent-harness service install" writes it.
exit /b 0
:not_complete
>>"%LOG%" echo launcher entry: "%VERSION%" is not complete in "%DATA_DIR%\versions", so no launcher starts; "agent-harness service install" puts a version there.
exit /b 0
