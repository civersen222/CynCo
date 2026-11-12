# CynCo knows and manages the owner's local-LLM apps

Date: 2026-11-11. Status: built (slices 1 to 7 below); live proof against the real apps is a step for the owner's sitting.

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
   - *Which app a model belongs to* cannot be read: Ollama does not say who asked. The registry (`ollamaApps`) answers first. Otherwise the owner's project folders are searched for a source or config file that names the model beside `ollama` or `11434` (four folders deep, 1,500 files a project, no dependencies, no checkout of CynCo, four seconds at most, every read awaited), and that is treated as evidence, not as the answer (F220): the notice lists the projects that name the model, and one of them is registered as a managed app only when it is the single one with a process running from its folder on this PC. What a finished search found is remembered in `apps.json` (`ollamaFindings`) for a week, so the folders are read once per model and not at every model load. A model no project names is still unloaded and said by its own name. The first version registered every project that named the model; measured on the owner's folders that took 31 seconds inside the engine and registered CynCo itself, scratch copies and three worktrees of one game. If wrong: an app that runs somewhere else (screenplayer, on the NAS) is never registered by itself and so has no row on the dashboard and no `manage` switch until the owner adds it by hand: `"ollamaApps": [{ "id": "screenplayer", "name": "screenplayer", "root": "C:\\Users\\civer\\screenplayer", "models": ["qwen3.6:27b"], "manage": true, "source": "by hand" }]`. Its model is unloaded and it is listed in the notice either way.
6. **A mission follows the same rule** (slice 5, F219). `scripts/dispatch-mission.sh` asks `scripts/cynco-apps.mjs take` before its own kill sweep: an app's server on the model port is named, stopped and owed its server back, and Ollama is asked to unload. The mission engine gives the GPU back as it exits (`engine/main.ts`), and the driver does it after a teardown that ended in the hand kill. Two things had to change with it. The eager start (`ProcessManager.ensureRunning`, which every mission engine and one-shot uses) cleared its port blind; it now asks the app module first. And the engine the dispatch boots after a mission, so the dashboard keeps answering, was eager: it would have taken the GPU straight back from the app the mission had just restored. It is lazy now (`LOCALCODE_LLAMA_LAZY=true`, 15 minutes idle unload). If wrong: the first message after a mission waits for a model load, where the model used to be warm.

7. **CynCo starts an app, from a Desktop icon** (slice 7, F222). In the live sitting the documented `bash scripts/start-llm.sh`, typed in PowerShell, ran inside WSL; the owner: "I need some sort of launch icon on the desktop for these apps". How an app starts is a `start` section on its entry in `~/.cynco/apps.json`: the things that must run, in order, and the address to open. One launcher reads it (`engine/apps/start.ts` is the rule, `engine/apps/desk.ts` runs it with real processes; `bun scripts/cynco-apps.mjs start <id>` through `scripts/cynco-app.cmd`), and each icon is a shortcut to that launcher with the app's id. Nothing is added to an app's own folder.
   - *A step* has a name, how to tell it is running (`port`, or `url` for what listens before it can answer, or `check`, a command that exits 0), and how to start it (`exe`, `args`, `cwd` under the app's folder). Running already: left alone. Not running and startable: started and waited for (`waitSeconds`, default 60). Not running with no `exe`: the start stops there and says so. `keep: true` marks what stays when the window is closed (Docker Desktop, `docker compose up -d`).
   - *The model server* is a step with `"model": true`: it is the entry's own `launch`, through Git's wrapper bash and never a bare `bash`. If CynCo's own server holds the port, the app is answered by it and its own server is not started beside it; another app's or an unknown server is left alone and named. While the window is open it looks at the port every five seconds: when the port has stayed free it starts the app's own server, and when CynCo took the port from the app (decision 1) it takes over the debt, so the engine does not start a second server that has no window.
   - *The window is the app.* What the launcher starts are its own children, each owned as a tree when it is started (`engine/processTree.ts`), with their output in `~/.cynco/app-logs/`. Closing the window stops them, and the window ends by itself when they have all stopped. That is a decision, not a side effect: a process started the way the engine restarts a server (`Win32_Process.Create`) has no window at all (measured: session 1, window handle 0), so an app started that way could only be stopped from Task Manager, and its web app running from the app's folder would count as "in use" for ever (decision 3), keeping a 20 GB model loaded.
   - *The icons* are made by `bun scripts/cynco-apps.mjs icons --repo <checkout>`: one `<app name>.lnk` per entry that has a `start` section, on the Desktop Windows reports (here `C:\Users\civer\OneDrive\Desktop`). Each runs `cmd /c if exist <launcher> (<launcher> <id>) else (echo why & pause)`, so an icon whose checkout does not have the launcher yet says that instead of doing nothing. A shortcut of the same name that is not one of these is left alone. The launcher does not talk to the running engine: an icon works with the engine down and needs no engine restart.
   - *What was established for each app* (read-only survey, 2026-11-11), and so which got an icon:

     | app | how it is really started | icon |
     |---|---|---|
     | dndai | Postgres in Docker on 5433 (`db/docker-compose.yml`; its handoffs call this the live database), the model servers by `scripts/start-llm.sh`, the web app by `npm run dev` in `web\`, opened at `http://localhost:3000` (`README.md`, `CLAUDE.md`, `web/package.json`) | yes: Docker Desktop, database, model server (ready when `/health` answers), web app, then the browser |
     | civkings | `python -m gilded` in the folder (`README.md`), a pygame-ce window; `C:\Python314\python.exe` is the interpreter that has pygame-ce 2.5.7 and pygame_gui | yes: the game. Not run by this work: whether the game starts cleanly with no Ollama answering was not established |
     | screenplayer | deployed with Docker on the NAS at port 8080 (`docker-compose.yml`), and runnable here with `uv run python -m screenplayer` at `http://localhost:8080` (`CLAUDE.md`, "Running") | no. The NAS's address is not in the project's files, and neither `192.168.0.165:8080` nor `100.101.69.46:8080` answered; the local database was last written 2026-09-16, so which of the two holds the owner's work could not be told |
     | wagetheory | several documented ways, all for WSL (`CLAUDE.md`: "Runs on WSL2", a Linux venv); the commits since 2026-10-29 are a ledger and an API with no page to open | no: no Windows launch could be established |
     | fantasyman | it is CynCo's own daemon (`dynasty/ops/run_cynco_daemon.cmd`, the logon task) and the CynCo project `fantasy-football`; its output is the digest page and phone notices | no: it has nothing of its own to start, and the registry has no kind for an app that holds no model |

   - *The two entries written to this PC's `~/.cynco/apps.json`* (by hand, on the owner's behalf; `launch.exe` is where Git's bash is on this PC):

     ```json
     { "apps": [{ "id": "dndai", "name": "dndai", "root": "C:\\Users\\civer\\dndai", "script": "scripts/start-llm.sh",
         "launch": { "exe": "C:\\Program Files\\Git\\bin\\bash.exe", "args": ["scripts/start-llm.sh"], "cwd": "C:\\Users\\civer\\dndai" },
         "manage": true, "source": "by hand 2026-11-11: ...",
         "start": { "steps": [
             { "name": "Docker Desktop", "check": { "exe": "docker", "args": ["info"] }, "exe": "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe", "args": [], "keep": true, "waitSeconds": 180 },
             { "name": "database", "port": 5433, "exe": "docker", "args": ["compose", "up", "-d"], "cwd": "db", "keep": true, "waitSeconds": 90 },
             { "name": "model server", "model": true, "port": 8081, "url": "http://127.0.0.1:8081/health", "waitSeconds": 240 },
             { "name": "web app", "port": 3000, "exe": "cmd.exe", "args": ["/c", "npm", "run", "dev"], "cwd": "web", "waitSeconds": 90 } ],
           "open": "http://localhost:3000", "icon": "web/src/app/favicon.ico" } }],
       "ollamaApps": [{ "id": "civkings", "name": "civkings", "root": "C:\\Users\\civer\\civkings", "models": ["qwen3.6"],
         "manage": true, "source": "by hand 2026-11-11: ...",
         "start": { "steps": [{ "name": "game", "exe": "C:\\Python314\\python.exe", "args": ["-m", "gilded"] }] } }] }
     ```

     For a screenplayer icon the owner adds an `ollamaApps` entry with one of these and runs `icons` again. On the NAS: `"start": { "steps": [], "open": "http://<the NAS>:8080" }`. On this PC: `"start": { "steps": [{ "name": "screenplayer", "port": 8080, "exe": "uv", "args": ["run", "python", "-m", "screenplayer"] }], "open": "http://localhost:8080" }`.
   - *The six questions.* Problem: a person had to type a command whose meaning depends on the shell, and nothing held how an app as a whole is started. Why the existing thing is insufficient: `launch` is the model server alone, and discovery can only see a server that is already running. State and failure modes: one more section on existing entries, read tolerantly (a step that is not one is dropped); a log folder `~/.cynco/app-logs/`, overwritten at each start; shortcuts on the Desktop. A recipe is the owner's own file telling CynCo what to run, so only an `http` address is ever opened. A step whose port something else already holds is taken as running, whoever holds it. Verified: `start.test.ts` (the rule), `desk.test.ts` (real processes, the real shortcut read back and run), `gitBash.test.ts`, and by hand a dndai-shaped stand-in through the real `.cmd` in a real console window, closed as a click on its X does: both stand-in servers and the launcher's whole tree were gone. Disabled or removed: delete the `.lnk`, or the `start` section. Maintained by: `engine/apps/CLAUDE.md`.
   - *Not built: starting an app from the dashboard's apps rows.* It does not fall out of the same code. A process the engine starts has no window, so the dashboard would need a Stop as well, and a record of what it started that survives an engine restart: a second way to own an app's processes beside the window. If wrong (the owner wants to start dndai from the phone or from the Missions tab): that record and a Stop are the work, and `startApp` already takes its processes through `StartDeps`.
   - If wrong: closing the window by accident stops the game's servers (start it again from the icon; the model reloads). An app whose web port is held by some other project is reported as already running and the browser opens that other project.

8. **An app started as administrator is named, not managed, and never waited behind** (F223, the first real hand-off). CynCo's engine is not elevated, so it can neither read the command line of an elevated server nor stop it. It still names the app, from the shell's name in the parent chain and the app's own processes that are not elevated (exactly one registered app of that launcher kind running, or exactly one running project folder with one such script that starts a model server on that port). It says the server *holds* the port, that it could not stop it and why, and what the owner can do; it does not record a debt, and it never says "stopped" before the port is free. The turn is then answered on the small-model fallback where that is set up, and refused at once where it is not: no wait is offered behind a server nothing will stop. CynCo does not ask for administrator rights to get its way. What that costs: a game started from an administrator window keeps the GPU for as long as its window is open, and CynCo's own model does not load on this PC meanwhile. If wrong (the owner wants CynCo to win there too): the engine's task would have to run elevated, which is a security decision for the owner, not a code change. The way that works is the Desktop icon (decision 7): it starts the app without administrator rights.

## Slices

1. Identify and say: registry, discovery, the notice on the lazy path names the app.
2. Take and give back for the lazy chat engine: displacement record, in-use check, restore on unload, on shutdown and at start.
3. The same rule for daemon one-shots: the one-shot no longer defers behind an app's server; it takes the port and the daemon gives it back after the run.
4. Apps on Ollama: `engine/apps/ollama.ts` (decision 5).
5. Missions: `scripts/cynco-apps.mjs`, the eager start, the lazy engine after a mission (decision 6).
6. The dashboard: the Missions tab lists the apps CynCo knows (name, how each serves its model, whether it holds the GPU now, managed or not, owed its server or not) and switches `manage` per app. Reading is the read scope, so the phone sees it; the switch is management scope, so it is desk-only (`engine/dashboard/appsApi.ts`, `GET /api/apps`, `PUT /api/apps/<id>`). It is on the Missions tab and not Config because that is the tab both the desk and the phone show, and it is where the GPU's claim is already shown.
7. Starting an app: the `start` recipe, the launcher, the Desktop icons, and Git's wrapper bash for every bash launcher (decision 7).

Each is tested with stand-in servers; `standIn.test.ts` runs the whole path with real processes on a spare port (a launcher script, a server it starts, a client process in the app's folder, the real process reader, the real kill and the real out-of-job start).

## The live sitting

With dndai started from its Desktop icon (never a `bash` typed in PowerShell, which is the WSL launcher: F222): send a message from the phone. Expect the chat line `model: dndai's model server held port 8081 … CynCo stopped it to load its own model …`, an answer, dndai still answering turns, and about 15 minutes after CynCo goes idle `dndai's model server is started again`. Then the same with `fantasy-digest` fired from the Missions tab.
