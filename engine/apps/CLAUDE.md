# engine/apps

## Purpose
The owner's other local-LLM projects (a game, a screenplay tool, a pay-equity service) start model servers of their own, and the owner asked CynCo to figure out what those are and manage them: "they are more or less aspects of the same cynco system just different use cases". This package is the one rule for that: when CynCo needs the GPU and an app's model server holds CynCo's model port, CynCo names the app, stops that server, and starts it again when its own work is done. A chat turn and a daemon one-shot both go through it. Design, survey of the apps and the decisions made: `docs/decisions/2026-11-11-local-llm-apps.md`. It must never stop a server it has not identified on CynCo's own port, never start a script that was not demonstrably running that server, and never leave an app that is in use without its server.

## Key files
| File | Role |
|---|---|
| `registry.ts` | `~/.cynco/apps.json`: the apps CynCo knows (`LocalApp`: folder, launch script, how to start it, `manage`), read tolerantly, written atomically. |
| `portTree.ts` | The process on a port with its ancestors and their command lines (`readPortTree`), and the whole process list (`listProcesses`); PowerShell + CIM, Windows only, bounded. |
| `identify.ts` | `identifyPortHolder`: engine, app, foreign or unknown. Finds the launcher script in the ancestors (`launcherOf`), matches it to the registry (`matchApp`), and otherwise looks for it in the owner's project folders (`discoverApp`, `projectDirs`) and registers what it found with the evidence. |
| `displace.ts` | `displaceApp` (stop the server, say which app, write down what is owed in `~/.cynco/displaced-apps.json`), `appInUse`, `restoreDisplacedApps` (start again what is owed), `launchOutsideJob`. |
| `gpu.ts` | The rule wired for its callers: `lazyAppDeps` for `ProcessManager.ensureRunningLazy`, `takeGpuForOneShot` for the daemon's `TaskRunner`, `giveGpuBack` for both. |

## Important types & functions
- **`LocalApp`** (`registry.ts:18`), **`loadApps`** (`registry.ts:44`), **`saveApp`** (`registry.ts:65`) — an entry is written by discovery or by hand; `"manage": false` makes CynCo treat that app's server as any server that is not its own (F202: stopped by a chat turn, deferred behind by a one-shot).
- **`readPortTree`** (`portTree.ts:70`) — the listener first, then its ancestors, nearest first; the chain stops at a parent pid that belongs to a later process (Windows reuses pids). **`listProcesses`** (`portTree.ts:98`) throws when the list cannot be read, so nobody decides on an empty one.
- **`launcherOf`** (`identify.ts:73`) — the nearest ancestor that is a shell or interpreter running a script file: `bash x.sh`, `cmd /c x.cmd`, `powershell -File x.ps1`, `python x.py`, `node x.js`. `normalizeScript` (`identify.ts:63`) drops `./` and `../` and turns Git Bash's `/c/…` into `C:/…`.
- **`discoverApp`** (`identify.ts:115`) — exactly one of the project folders has the launcher's script, and the script's text starts a model server: that folder is the app, named after it, launched by the interpreter that was actually running (its full path, so a bare `bash` never becomes the WSL launcher, F160). Two candidates, or a script that starts no model server, is not guessed.
- **`identifyPortHolder`** (`identify.ts:169`) — a CynCo engine's server is recognised first, exactly as `engine/llama/portOwner.ts` does; an app comes from the registry or from discovery (which saves it); the rest is `foreign`, and an unreadable port is `unknown`.
- **`appInUse`** (`displace.ts:55`) — some process outside the launcher's own tree has the app's folder in its command line or executable path. The launcher's ancestors are not part of that tree: the terminal that ran the launcher usually ran the app too.
- **`displaceApp`** (`displace.ts:78`) — in use: the debt is recorded before the server is stopped, and the notice says the app is answered by CynCo's server meanwhile when the stopped listener was a llama-server (same port, same API). Not in use: a leftover, stopped and not owed anything. A process list that cannot be read counts as in use.
- **`restoreDisplacedApps`** (`displace.ts:128`) — for each debt: older than `MAX_DISPLACED_AGE_MS` (`displace.ts:29`, 24 h) is dropped; a one-shot holding the GPU or anything on the port leaves it owed; an app no longer running is dropped and said; otherwise the launcher is started with `launchOutsideJob` (`displace.ts:184`) and the debt cleared. A failed start stays owed. Never throws.
- **`lazyAppDeps`** (`gpu.ts:69`), **`takeGpuForOneShot`** (`gpu.ts:108`), **`giveGpuBack`** (`gpu.ts:128`).

## Data flow
1. A lazy chat engine needs the model and finds a healthy server on its port: `ensureRunningLazy` asks `portOwner`, which is `lazyAppDeps(port).portOwner` (`engine/bootstrapProvider.ts`), which is `identifyPortHolder`.
2. `app`: `takeFromApp` runs `displaceApp`, which says which app on the lazy wait's notice channel (`ProcessManager.onWaiting` → `governance.alert` → a `model:` line in the chat, desk and phone) and in the log. The engine then loads its model on the freed port; the app's next request is answered by it.
3. A daemon one-shot: `TaskRunner.run` calls `takeGpu` before its busy check (`engine/daemon/main.ts` wires `takeGpuForOneShot`), so an app's server no longer defers the run; what the daemon did is logged and sent to the phone through the daemon's ntfy channel.
4. CynCo is done: the lazy engine's idle unload and its shutdown (`engine/main.ts`), and the end of every one-shot, call `giveGpuBack`. An engine or daemon that starts also calls it, for a debt left by one that died.

## Switched on by
Nothing to set: it acts only when a server that is not a CynCo engine's holds the model port. With no registry entry and no launcher that can be found, the behaviour is F202's. `"manage": false` in `~/.cynco/apps.json` switches it off per app; deleting `~/.cynco/displaced-apps.json` forgets what is owed. Nothing else depends on this package; `engine/llama` only knows the fourth answer `app` and an optional `takeFromApp`.

## Gotchas
- A process's working directory cannot be read from the process list, which is why an app is found by looking for its launcher script and not by asking where the launcher ran.
- A restarted server must not be the engine's child: the engine sits in a kill-on-close job (F131), so `launchOutsideJob` has the WMI service create the process (`Win32_Process.Create`). It gets the owner's profile environment, not the engine's: a launcher that needs a variable set only in one shell will not find it.
- Only the listener is stopped (`stopProcess`, `gpu.ts:23`), not its tree: an app's launcher script must be left to run its own exit handler (dndai's stops its embeddings server).
- Apps that use Ollama (screenplayer, wagetheory, Gilded) never hold CynCo's port and are not managed here yet; a mission dispatch still kills an app's server by path without restoring it. Both are in `docs/NOW.md`.
- Pinned by `engine/__tests__/apps/identify.test.ts`, `displace.test.ts`, `gpu.test.ts` and `standIn.test.ts`; the last runs the whole path with real processes on Windows (a launcher script, the server it starts, a client in the app's folder, the real reader, stop and out-of-job start).
