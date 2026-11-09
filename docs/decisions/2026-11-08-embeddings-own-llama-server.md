# Embeddings on CynCo's own llama-server; Ollama leaves the PC

**Date:** 2026-11-08 · **Status:** built and live · **Owner's decision:** "Let's just do the --embeddings route, no reason to do this [repair Ollama] if we're just ripping out later." · **Closes:** the third fault of F187.

## Problem
Project and code search embed with `nomic-embed-text`. On the GPU PC that model was served by Ollama, which the engine otherwise does not use (chat runs on CynCo's own llama-server). Ollama's self-update was interrupted on 2026-11-03 and left its install without runner binaries; every embedding failed for five days, and a docx attached from the phone was unsearchable (F187). An Ollama repair would have restored a dependency that exists for one small model.

## Decision
A second, tiny llama-server — the same binary the engine already resolves (`~/.cynco/bin/llama-server.exe`) — serves the nomic GGUF with `--embeddings` on `127.0.0.1:9165`, CPU only. It is a logon task like the other CynCo services:

- `scripts/run-embed-server.cmd` — the one command line (`--embeddings --pooling mean -c 2048 -b 2048 -ub 2048 -ngl 0 --threads 4 --no-webui`), log `~/.cynco/embed-server.log`.
- `scripts/cynco-services.ps1` row `embed` (task "CynCo embed server"; `register embed` creates it).
- The model file is Ollama's own blob copied out of its store (`~/.cynco/models/nomic-embed-text-v1.5.f16.gguf`, a plain GGUF, 274 MB); nothing was downloaded.
- Every engine finds it through three permanent user variables: `LOCALCODE_EMBED_BASE_URL=http://127.0.0.1:9165`, `LOCALCODE_EMBED_API=openai`, `LOCALCODE_EMBED_MODEL=nomic-embed-text`. The model name is kept so every existing project store (`embed_model` = `nomic-embed-text`) is reused, not rebuilt.

## The six questions
- **Problem:** embeddings depended on a second runtime (Ollama) with its own updater and failure modes. **Why the existing thing is insufficient:** the chat llama-server runs one model; it cannot also embed. **What it adds:** one more process on the PC (a Task Scheduler task), one port (9165), one model file; no engine code. **Verified:** `/health` and `/v1/embeddings` answer (768 dims); the engine indexed the phone's docx on rescan with no `[embed]` failure; `engine/__tests__/guards/embedServiceScript.test.ts` pins the command line and the services row. **Disabled / removed:** `cynco-services.ps1 stop embed`, unregister the task, unset the three variables — the engine falls back to today's probe order. **Maintained by:** `engine/llama` (binary) and `scripts/` (service), as for the headless engine.

## Why CPU
A 137M-parameter model embeds a chunk in milliseconds on the CPU; on the GPU it would hold VRAM and count as activity against the wakefulness design's cold-GPU-when-idle rule, and the lazy path's "is the GPU free" reading would have to learn to ignore it.

## Not done
Ollama is still installed on the PC (broken, unused). Removing it is the owner's step; nothing of CynCo's points at it any more. The 4070 Ti Super box's Ollama is unaffected — it is the slice-2b fallback and lives on another machine.

## Found on the way (NOW.md backlog)
`POST /api/projects/:slug/rescan` exceeds Bun.serve's default 10 s `idleTimeout` on a project with a few files; the work completes server-side but the client sees the connection drop.
