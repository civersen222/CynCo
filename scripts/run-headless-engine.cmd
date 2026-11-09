@echo off
rem CynCo headless phone engine (Task Scheduler, at logon): the dashboard behind the doorman.
rem Starts COLD — the model loads on the first message and unloads after 15 min idle
rem (docs/decisions/2026-11-08-wakefulness-design.md, slice 2). LOCALCODE_DASHBOARD_HOST is the
rem permanent user variable (127.0.0.1,<tailscale ip>), so the phone listener binds too.
rem Registered/started/stopped by scripts\cynco-services.ps1 (service name: engine).
set LOCALCODE_PROVIDER=llama-cpp
set LOCALCODE_LLAMA_LAZY=true
rem No brain sidecar / activation tap on the phone engine (nobody watches the Brain tab from a phone).
set LOCALCODE_BRAIN=off
if "%LOCALCODE_LLAMA_IDLE_UNLOAD_MS%"=="" set LOCALCODE_LLAMA_IDLE_UNLOAD_MS=900000
rem While a daemon one-shot owns the 5090, answer on the 4070 Ti Super box's Ollama (slice 2b).
if "%LOCALCODE_FALLBACK_URL%"=="" set LOCALCODE_FALLBACK_URL=http://192.168.0.47:11434
if "%LOCALCODE_FALLBACK_MODEL%"=="" set LOCALCODE_FALLBACK_MODEL=qwen3:14b
cd /d C:\Users\civer\localcode
bun engine\main.ts >> "%USERPROFILE%\.cynco\engine-headless.log" 2>&1
