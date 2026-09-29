@echo off
rem agent-harness: runs the agent-harness of the version the service state below
rem names active, with the arguments it was given. Written by
rem "agent-harness service install"; "agent-harness service uninstall" removes it.
setlocal EnableExtensions DisableDelayedExpansion
set "DATA_DIR=C:\Users\david\AppData\Local\agent-harness"
set "VERSION="
if exist "%DATA_DIR%\service-state.json" for /f "usebackq tokens=2 delims={:, " %%V in (`findstr /l /c:"activeVersion" "%DATA_DIR%\service-state.json"`) do if not defined VERSION set "VERSION=%%~V"
if not defined VERSION goto no_version
if not exist "%DATA_DIR%\versions\%VERSION%\.complete" goto not_complete
"%DATA_DIR%\versions\%VERSION%\node\node.exe" "%DATA_DIR%\versions\%VERSION%\packages\cli\dist\main.js" %*
exit /b %ERRORLEVEL%
:no_version
1>&2 echo agent-harness: the service state in "%DATA_DIR%" names no active version; "agent-harness service install" writes it.
exit /b 1
:not_complete
1>&2 echo agent-harness: the active version "%VERSION%" is not complete in "%DATA_DIR%\versions".
exit /b 1
