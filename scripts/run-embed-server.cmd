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
"%USERPROFILE%\.cynco\bin\llama-server.exe" --embeddings -m "%CYNCO_EMBED_MODEL%" --host 127.0.0.1 --port 9165 --pooling mean -c 2048 -b 2048 -ub 2048 -ngl 0 --threads 4 --no-webui >> "%USERPROFILE%\.cynco\embed-server.log" 2>&1
