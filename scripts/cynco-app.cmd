@echo off
rem The one launcher for the owner's local-LLM apps: a Desktop icon runs this with an app's id
rem (docs\decisions\2026-11-11-local-llm-apps.md, decision 7; the icons are made by
rem `bun scripts\cynco-apps.mjs icons`). It reads the app's "start" section in
rem %USERPROFILE%\.cynco\apps.json, starts what is not running, opens the app, and stays:
rem closing this window stops what it started. It does not need the engine to be running.
title %~1 - CynCo
cd /d "%~dp0.."
rem `call`: bun may be a .cmd shim, and a .cmd run from a .cmd without it never comes back here.
call bun scripts\cynco-apps.mjs start %*
if errorlevel 1 (
  echo.
  echo %~1 was not started. The lines above say why.
  pause
)
