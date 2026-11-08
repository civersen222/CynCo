@echo off
rem CynCo headless phone engine (Task Scheduler, at logon): the dashboard behind the doorman.
rem Starts COLD — the model loads on the first message and unloads after 15 min idle
rem (docs/decisions/2026-11-08-wakefulness-design.md, slice 2). LOCALCODE_DASHBOARD_HOST is the
rem permanent user variable (127.0.0.1,<tailscale ip>), so the phone listener binds too.
rem Registered/started/stopped by scripts\cynco-services.ps1 (service name: engine).
set LOCALCODE_PROVIDER=llama-cpp
set LOCALCODE_LLAMA_LAZY=true
if "%LOCALCODE_LLAMA_IDLE_UNLOAD_MS%"=="" set LOCALCODE_LLAMA_IDLE_UNLOAD_MS=900000
cd /d C:\Users\civer\localcode
bun engine\main.ts >> "%USERPROFILE%\.cynco\engine-headless.log" 2>&1
