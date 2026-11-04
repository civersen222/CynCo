@echo off
rem CynCo desk widget (status + start/stop for CynCo and Fantasyman). Double-click, or pin to the taskbar / Startup folder.
start "" /min powershell -STA -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0cynco-widget.ps1"
