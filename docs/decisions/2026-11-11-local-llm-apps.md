# CynCo knows and manages the owner's local-LLM apps

Date: 2026-11-11. Status: built (slices 1 to 6 below); live proof against the real apps is a step for the owner's sitting.

## What was asked

Asked whether an unattended CynCo job may stop a model server that is not CynCo's, the owner said: "i think most of these servers are essentially things i'm doing with local llms. these are things like screenplayer, dndai, fantasyman, wagetheory, etc. I think Cynco should be able to handle figuring out what those are and managing those as well. I'm realizing they are more or less aspects of the same cynco system just different use cases." A plan that only let the daemon stop such a server with a notice was rejected as too conservative.

## What the owner can do afterwards

- Leave dndai's model server running, send CynCo a message or let a scheduled job fire, and read in the chat (desk and phone) and the engine log **which app** held the GPU, not "a server that is not CynCo's".
- Keep playing: while CynCo holds the GPU its own server answers dndai on the same port, and when CynCo is done dndai's own server is started again. If dndai itself was not running, its leftover server is stopped and not started again.
- Get the same behaviour from a chat turn and from an unattended one-shot.

## Survey (read-only, 2026-11-11)

| app | folder | model server | starts it? | port | found by |
|---|---|---|---|---|---|
| dndai | `C:\Users\civer\dndai` | CynCo's own `~/.cynco/bin/llama-server.exe` | yes: `bash scripts/start-llm.sh` (or `npm run llm` in `web\`): chat `Qwen3.6-27B-Q6_K` on 8081 in the foreground, embeddings on 8082 in the background; an exit trap stops the embeddings server | 8081, 8082 | `scripts/start-llm.sh:13-74` |
| screenplayer | `C:\Users\civer\screenplayer` | Ollama, `/v1/chat/completions`, `qwen3.6:27b` | no, connects (from the NAS over the tailnet to this PC's Ollama) | 11434 | `documents/ai/backend.py:26-27` |
| wagetheory | `C:\Users\civer\wagetheory` | Ollama, `llama3.2` / `deepseek-r1` | no, connects | 11434 | `wagetheory_ai/config/settings.py` |
| civkings (Gilded) | `C:\Users\civer\civkings` | an OpenAI-shaped endpoint at 11434 (Ollama), `qwen3.6`; falls back to a templated narrator | no, connects | 11434 | `gilded/saga/narrator.py:35-37` |
| fantasyman | `C:\Users\civer\fantasyman` | none of its own: it runs CynCo (the daemon and `--run-task`) | no | CynCo's | `dynasty/ops/run_cynco_daemon.cmd` |

So there are two shapes. **A server on CynCo's model port** (dndai): it collides with CynCo directly. **Models loaded in Ollama** (screenplayer, wagetheory, Gilded): they hold VRAM without holding the port. fantasyman is already CynCo.

## What existed

`engine/llama/portOwner.ts` called the holder of the model port `engine`, `foreign` or `unknown`. A lazy chat engine stopped a `foreign` server once and took the port (F202) and never started it again. The daemon (`isGpuBusy`) treated any healthy server on the port as busy and deferred a one-shot for as long as it stayed. A mission dispatch killed it by path.

## The mechanism

One rule, used by a chat turn and by a one-shot: **when CynCo needs the GPU and an app's model server holds CynCo's port, CynCo takes the port, says which app, and gives it back.**

1. **Identify** (`engine/apps/identify.ts`). One process read gives the listener on the port and its ancestors with their command lines. A CynCo engine's server is still recognised first (parent is a running `bun`, as before). Otherwise the nearest ancestor that is a shell or interpreter running a script (`bash scripts/start-llm.sh`, `cmd /c x.cmd`, `powershell -File`, `python x.py`, `node x.js`) is the **launcher**. An app in the registry whose launch script that is, is the answer. If none is, CynCo **figures it out**: it looks in the owner's project folders (the children of the home folder and of `CYNCO-PROJECTS`) for that script; when exactly one folder has it and the script's text starts a model server, that folder is the app, named after the folder, and it is written to the registry with the evidence. No match, or more than one, stays `foreign` and is handled as before (F202).
2. **Take** (`engine/apps/displace.ts`). CynCo checks whether the app is in use: some process outside the model server's own tree runs from the app's folder (dndai's Next.js server does). It stops the listener and says what it did. In use: the displacement is written to `~/.cynco/displaced-apps.json`. Not in use: the server was a leftover (the F202 case) and nothing is recorded.
3. **Serve meanwhile.** Nothing to build: the app's server was on CynCo's port and speaks the same OpenAI-shaped API as CynCo's llama-server, so the app's next request is answered by CynCo's model. The notice says so only when the stopped listener was a llama-server.
4. **Give back.** When CynCo's work is done (the lazy engine's model unloads after its idle time or the engine stops; the one-shot ends), each displaced app that is still in use, whose port is free and whose server is not already back, is started again with its own launcher, in its own folder, outside the engine's kill-on-close job (`Win32_Process.Create`; a process the engine spawned directly would die with the engine, F131). An engine or daemon that starts and finds a record left by one that died does the same. A record older than 24 hours is dropped.

### What it adds, and the six questions

**The registry `~/.cynco/apps.json`** (owner-editable; `manage: false` on an entry turns management off for that app).
- *Problem*: "foreign" told the owner nothing and gave CynCo nothing to restart.
- *Why the existing thing is insufficient*: `portOwner` knows who started a server, not what it is for or how to start it again; a process's working directory cannot be read from the process list, so the folder has to be found and remembered.
- *State, dependencies, failure modes*: one JSON file. Missing or malformed reads as empty and is logged; a wrong entry can at worst start the wrong script, which is why discovery requires a live ancestor that names the script and exactly one folder that has it, and records the evidence in `source`.
- *Verified*: `engine/__tests__/apps/identify.test.ts` (fake trees, a temp home) and `standIn.test.ts` (real processes).
- *Disabled, recovered, removed*: delete the file or set `manage: false`; with no entry and no discoverable launcher the behaviour is exactly F202.
- *Maintained by*: `engine/apps/CLAUDE.md` is its document.

**The displacement record `~/.cynco/displaced-apps.json`.**
- *Problem*: the engine that takes the GPU and the process that later gives it back are not always the same one (a one-shot's child, an engine that crashed).
- *Why the existing thing is insufficient*: `gpu-busy.json` says who holds the GPU now, not what is owed afterwards.
- *State and failure modes*: a small list, written atomically. A stale entry (older than 24 h, or its app no longer in use) is dropped, never acted on. Two processes giving back at once can both read the entry: the second finds the port bound and drops it.
- *Verified*: `displace.test.ts`, `standIn.test.ts`.
- *Disabled or removed*: delete the file; nothing else reads it.
- *Maintained by*: the same package.

**New authority**: CynCo stops a process it identified as an app's model server, and starts a script it found in the owner's project folder. Both are a widening of what F202 already did (stop a foreign server), bounded by: only the listener on CynCo's own model port; only a launcher that was demonstrably running that server; only while the app is in use; said every time.

### Decisions made on the owner's behalf, and what each costs if wrong

1. **CynCo takes the GPU from an app at once, for a chat turn and for a one-shot alike.** The owner's game is interrupted for the length of CynCo's work. Softened by 3 (CynCo's server answers the game meanwhile). If wrong: turn it off per app with `manage: false`, which returns that app to F202 (stopped, said, not restarted) for chat turns and to deferral for one-shots.
2. **An app whose own processes are gone is a leftover**: its server is stopped and not started again ("if it's not being used the models should not be loaded"). If wrong: the owner starts the app's server by hand, as today.
3. **"In use" means a process running from the app's folder.** An editor or a Claude session open in that folder counts as in use. If wrong: a server is restarted that nobody is playing with, and it stays until the next time CynCo needs the GPU.
4. **Discovery writes the registry without asking**, with the evidence, because the owner asked CynCo to figure out what these servers are. If wrong: an entry names the wrong folder; it is visible in the notice and editable in the file.
5. **Apps on Ollama: CynCo asks Ollama to unload, and gives nothing back** (slice 4, F218). When CynCo's pre-spawn check finds the card short of VRAM, and before every one-shot, it reads Ollama's `/api/ps` and sends each loaded model one `POST /api/generate` with `keep_alive: 0`, the request Ollama documents for unloading. Ollama's HTTP API is the whole interface: its installation, files, service and settings are never touched. **Giving back is nothing CynCo does**: Ollama loads the model again by itself on the app's next request, so no debt is recorded. What that costs: the app's next request pays a model load, and if it arrives while CynCo's model is still on the card the two share it (Ollama then fits what it can and spills the rest to system memory, slowly). CynCo does not stop that request; it only says, each time, what it unloaded and for whom. A chat turn asks only when its own model would not fit; a one-shot asks always, because the daemon's busy check reads any large GPU user as busy. If wrong: `"ollama": { "manage": false }` in `~/.cynco/apps.json` turns it off as a whole, and `"manage": false` on an app keeps that app's models loaded.
   - *Which app a model belongs to* is figured out as a server's is: the registry (`ollamaApps`), else the owner's project folders are searched for a source or config file that names the model beside `ollama` or `11434` (four folders deep, 1,500 files a project, no dependencies), and what is found is registered with the evidence. Two apps that use one model are both named. A model no project names is still unloaded and said by its own name. The "in use" rule (a process running from the app's folder) is not used here: screenplayer runs on the NAS and has no process on this PC, and Ollama does not say who asked.
6. **A mission dispatch still kills an app's server by path and does not restore it** (`scripts/cynco-llama-sweep.mjs`). Missions are started by the owner at the desk; bringing them under the same rule is in the backlog.

## Slices

1. Identify and say: registry, discovery, the notice on the lazy path names the app.
2. Take and give back for the lazy chat engine: displacement record, in-use check, restore on unload, on shutdown and at start.
3. The same rule for daemon one-shots: the one-shot no longer defers behind an app's server; it takes the port and the daemon gives it back after the run.
4. Apps on Ollama: `engine/apps/ollama.ts` (decision 5).

Each is tested with stand-in servers; `standIn.test.ts` runs the whole path with real processes on a spare port (a launcher script, a server it starts, a client process in the app's folder, the real process reader, the real kill and the real out-of-job start).

## The live sitting

With dndai running (`bash scripts/start-llm.sh` and the web app): send a message from the phone. Expect the chat line `model: dndai's model server held port 8081 … CynCo stopped it to load its own model …`, an answer, dndai still answering turns, and about 15 minutes after CynCo goes idle `dndai's model server is started again`. Then the same with `fantasy-digest` fired from the Missions tab.
