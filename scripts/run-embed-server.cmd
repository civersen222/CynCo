@echo off
rem CynCo embedding server (Task Scheduler, at logon): our own llama-server serving the
rem nomic-embed-text GGUF on 127.0.0.1:9165 for every engine's project/code index
rem (LOCALCODE_EMBED_BASE_URL=http://127.0.0.1:9165, LOCALCODE_EMBED_API=openai,
rem LOCALCODE_EMBED_MODEL=nomic-embed-text as permanent user variables). CPU only (-ngl 0):
rem a 137M-parameter model needs no GPU, and the GPU must stay cold while the box idles
rem (docs/decisions/2026-11-08-wakefulness-design.md). Replaces Ollama on this PC, which
rem served nothing else (docs/decisions/2026-11-08-embeddings-own-llama-server.md, F187).
rem Registered/started/stopped by scripts\cynco-services.ps1 (service name: embed).
set CYNCO_EMBED_MODEL=%USERPROFILE%\.cynco\models\nomic-embed-text-v1.5.f16.gguf
"%USERPROFILE%\.cynco\bin\llama-server.exe" --embeddings -m "%CYNCO_EMBED_MODEL%" --host 127.0.0.1 --port 9165 --pooling mean -c 2048 -b 2048 -ub 2048 -ngl 0 --threads 4 --no-webui >> "%USERPROFILE%\.cynco\embed-server.log" 2>&1
