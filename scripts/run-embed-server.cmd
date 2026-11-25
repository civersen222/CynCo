@echo off
rem CynCo embedding server (Task Scheduler, at logon): our own llama-server serving the
rem nomic-embed-text GGUF on 127.0.0.1:9165 for every engine's project/code index
rem (LOCALCODE_EMBED_BASE_URL=http://127.0.0.1:9165, LOCALCODE_EMBED_API=openai,
rem LOCALCODE_EMBED_MODEL=nomic-embed-text as permanent user variables). CPU only (-ngl 0):
rem a 137M-parameter model needs no GPU, and the GPU must stay cold while the box idles
rem (docs/decisions/2026-11-08-wakefulness-design.md). Replaces Ollama on this PC, which
rem served nothing else (docs/decisions/2026-11-08-embeddings-own-llama-server.md, F187).
rem Registered/started/stopped by scripts\cynco-services.ps1 (service name: embed).
rem The models folder: LOCALCODE_MODELS_DIR when it is set, else .cynco\models under the user profile.
rem The engine's own rule (modelsDir in engine\paths.ts) also follows CYNCO_HOME; this script does not:
rem it serves the logon task, which has none. The value is quoted wherever it is set or used (a folder
rem name may hold & or ^), and one that is not a full path below a drive letter is refused, as the
rem engine refuses it. The embedding GGUF sits in the root of that folder.
rem Wave 15: the rotation's own refusal or failure line goes to embed-server.rotate.log; Task Scheduler drops
rem standard error, and redirecting it to the log itself would hold the log open so it is never rotated.
call "%~dp0rotate-log.cmd" "%USERPROFILE%\.cynco\embed-server.log" 2>> "%USERPROFILE%\.cynco\embed-server.rotate.log"
if not defined LOCALCODE_MODELS_DIR set "LOCALCODE_MODELS_DIR=%USERPROFILE%\.cynco\models"
if not "%LOCALCODE_MODELS_DIR:~1,2%"==":\" goto not_full
set "CYNCO_EMBED_MODEL=%LOCALCODE_MODELS_DIR%\nomic-embed-text-v1.5.f16.gguf"
if exist "%CYNCO_EMBED_MODEL%" goto model_ok
echo [embed] REFUSING to start: "%CYNCO_EMBED_MODEL%" does not exist. LOCALCODE_MODELS_DIR names the models folder; unset means .cynco\models under the user profile. >> "%USERPROFILE%\.cynco\embed-server.log"
exit /b 1
:not_full
echo [embed] REFUSING to start: LOCALCODE_MODELS_DIR "%LOCALCODE_MODELS_DIR%" is not a full path below a drive letter. >> "%USERPROFILE%\.cynco\embed-server.log"
exit /b 1
:model_ok
echo [embed] model "%CYNCO_EMBED_MODEL%" >> "%USERPROFILE%\.cynco\embed-server.log"
rem F242: with the prompt cache on (default 8192 MiB) every embedding request printed the whole
rem cache list, 12,059 lines a request by the time this log reached 26 GB. An embedding server has
rem no use for that cache, so it is off (--cache-ram 0); -lv 2 keeps warnings and errors.
rem F91 (--ctx-size, --ctx-checkpoints and --cache-ram are one decision) governs the chat server;
rem this server has no checkpoints, so 0 here is not a hand-set budget.
"%USERPROFILE%\.cynco\bin\llama-server.exe" --embeddings -m "%CYNCO_EMBED_MODEL%" --host 127.0.0.1 --port 9165 --pooling mean -c 2048 -b 2048 -ub 2048 -ngl 0 --threads 4 --no-webui --cache-ram 0 -lv 2 >> "%USERPROFILE%\.cynco\embed-server.log" 2>&1
