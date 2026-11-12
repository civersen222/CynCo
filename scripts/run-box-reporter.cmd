@echo off
rem CynCo box reporter (Task Scheduler, at logon): this PC tells the watcher on the doorman what
rem it is doing: awake and asleep with what woke it, each GPU, what model is loaded and whether
rem anything uses it, who holds the GPU, which services answer, the owner's idle time, job runs.
rem It is a process of its own, not part of the engine; it listens on nothing and changes nothing
rem (docs/decisions/2026-11-11-metasystem-design.md, slice 1; engine\power\CLAUDE.md).
rem The watcher's address: LOCALCODE_WATCHER_URL, the doorman's tailnet address unless already set.
rem Registered/started/stopped by scripts\cynco-services.ps1 (service name: watch).
if "%LOCALCODE_WATCHER_URL%"=="" set LOCALCODE_WATCHER_URL=http://100.110.117.10:9171
cd /d C:\Users\civer\localcode
bun engine\power\reporter\main.ts >> "%USERPROFILE%\.cynco\box-reporter.log" 2>&1
