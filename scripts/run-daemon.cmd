@echo off
rem CynCo liveness daemon (Task Scheduler, at logon): triggers, one-shots, phone commands, and the
rem hourly page for an oversized service log. It loads no model itself (engine\daemon\main.ts).
rem The daemon requires CYNCO_NTFY_URL: the doorman's address unless already set. A token, when the
rem server needs one, is the permanent user variable CYNCO_NTFY_TOKEN and is never written here.
rem Registered/started/stopped by scripts\cynco-services.ps1 (service name: daemon).
rem What it can touch besides starting the daemon: scripts\rotate-log.cmd renames daemon.log to
rem daemon.log.1 in the same folder when it is over 50 MiB (F242), and nothing else.
if "%CYNCO_NTFY_URL%"=="" set CYNCO_NTFY_URL=http://100.110.117.10:8090
set LOCALCODE_PROVIDER=llama-cpp
cd /d "%~dp0.."
call "%~dp0rotate-log.cmd" "%USERPROFILE%\.cynco\daemon.log"
bun engine\daemon\main.ts >> "%USERPROFILE%\.cynco\daemon.log" 2>&1
