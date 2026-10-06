# engine/projects

## Purpose
Projects mode: a non-code project (a diorama, a cookbook) as a plain folder under a projects home, independent of `cyncoHome` and of the engine loop. `layout.ts` owns the folder shape — `project.json`, `instructions.md`, `knowledge/`, `chats/`, `artifacts/`, `plan.md`, `inbox/`, `journal.md` — plus the file indexes and the append-only journal that every later feature (ingestion, search, chat, tools, `/api/projects/*`) reads and writes. `registry.ts` keeps a `registry.json` cache of every project under a home so the TUI/dashboard can list projects without walking the filesystem each time, but treats that cache as disposable: any staleness rebuilds it from the folders. `history.ts` puts a git repo under each project folder and commits after writes, invisibly — a user never runs git, and a commit failure is reported and journaled, never thrown. This package never imports from `engine/bridge/`; later tasks wire it into the engine from the other direction.

## Key files
| File | Role |
|---|---|
| `layout.ts` | Folder shape, slugs, `project.json`/`instructions.md`/file-index/journal read-write, `isInside` path guard, `sha256Of`. |
| `registry.ts` | `registry.json` cache over a projects home: read-with-rebuild-if-stale, full rebuild from disk, upsert, `touchOpened`. |
| `history.ts` | Invisible per-project git: `ensureHistory` inits once, `commitHistory` stages and commits named paths, serialised per directory. |
| `profile.ts` | `assembleProjectPrompt`: the project-chat system prompt — governance/memory kept verbatim, code-shaped sections dropped, a `<PROJECT>` block added. |
| `chat.ts` | One JSONL transcript per chat: `newChatFile`/`appendTranscript`/`readTranscript`/`listChats`/`renameChat`, plus `turnsOf` for indexing. |
| `tools.ts` | `ProjectSearch`/`SaveArtifact`/`AddToKnowledge` tool implementations and the module-state `ProjectToolContext` the loop sets per session. |

## Important types & functions
- **`ProjectMeta`** (`layout.ts:14`) — the `project.json` shape; `schema: 1` is checked on every read so a future schema bump can't be silently misread.
- **`createProject`** (`layout.ts:70`) — lays out every file/folder a fresh project needs (`knowledge/`, `chats/`, `artifacts/`, `inbox/`, `.cynco/index/`, the two index.json, `plan.md`, `.gitignore`, `journal.md`) and appends the `created` journal line.
- **`isInside`** (`layout.ts:55`) — case-folded on win32, accepts the root itself; later tasks use it to refuse a knowledge/artifact path that escapes the project folder.
- **`appendJournal`** (`layout.ts:136`) — appends one journal line per event.
- **`readJournal`** (`layout.ts:140`) — reads those lines back newest first.
- **`readRegistry`** (`registry.ts:84`) — returns the cached registry plus whether it had to rebuild; the cache is never trusted past one `isFresh` check against the folders on disk, unless called with `{ heal: false }`, which returns the cache as written (still rebuilding when it is missing or unparsable) — used by `engine/projects/search.ts`'s fan-out so a vanished project stays in the list long enough for its own `existsSync` check to produce a `skipped` entry.
- **`rebuildRegistry`** (`registry.ts:29`) — the only place a `RegistryEntry` is derived from a folder's `project.json`; preserves `lastOpenedAt` from the previous cache across a rebuild.
- **`ensureHistory`** (`history.ts:37`) — `git init` once per project folder (idempotent on `.git` already existing), sets a local `user.email`/`user.name` so commits never depend on global git config.
- **`commitHistory`** (`history.ts:47`) — stages exactly the given paths, treats `git diff --cached --quiet` exit 0 as "nothing to record" (not a failure), and only runs `git commit` when something is staged.
- **`assembleProjectPrompt`** (`profile.ts:36`) — builds the project-chat system prompt array (same shape as `assembleBasePrompt`); byte-identical for identical input so the prefix cache holds.
- **`newChatFile`** (`chat.ts:24`) — names a chat file `<timestamp>-<title slug>.jsonl` and writes its header as line 1.
- **`turnsOf`** (`chat.ts:83`) — pairs each text-only user message with the following assistant text for chat ingestion; skips a user message that is a tool result.
- **`setProjectToolContext`** (`tools.ts:23`) — sets the module-state `ProjectToolContext` (home/slug/embed client/emit) the three tools below read; `null` outside a project session.
- **`projectSearchTool`** (`tools.ts:37`), **`saveArtifactTool`** (`tools.ts:66`), **`addToKnowledgeTool`** (`tools.ts:97`) — the `ProjectSearch`/`SaveArtifact`/`AddToKnowledge` `ToolImpl`s; each refuses by name when `ProjectToolContext` is unset, and every write stays inside the project folder (`isInside`) and is followed by `ensureHistory`+`commitHistory`.

## Data flow
1. A caller (a later task's API handler or tool) calls `createProject` (`layout.ts:70`) with a name and optional description/instructions/tags; the returned `ProjectMeta` is the slug every other call keys off.
2. The caller registers the new project with `upsertRegistry` (`registry.ts:91`) so `readRegistry` (`registry.ts:84`) lists it without a rebuild; any later read that finds the cache stale (a hand-deleted folder, a corrupt file) silently calls `rebuildRegistry` (`registry.ts:29`) instead of surfacing the mismatch.
3. Every mutating write under the project folder is followed by `ensureHistory` (`history.ts:37`, once) then `commitHistory` (`history.ts:47`) with the paths that changed; a git failure is journaled via `appendJournal(dir, 'history.failed', ...)` (`layout.ts:136`) and returned as `{ ok: false, reason }` rather than thrown, so the write itself is never rolled back by a history problem.

## Gotchas
- The registry is a cache, never the truth: `readRegistry` rebuilds whenever the on-disk folder set and the cached slug set disagree (missing folder, extra folder, unparsable JSON, wrong `version`) — never hand-edit `registry.json` and expect it to stick past the next read.
- A history commit must never block or fail the caller's actual write: `ensureHistory`/`commitHistory` always resolve (never reject) and a git failure becomes a `history.failed` journal entry plus `{ ok: false, reason }`, never a thrown exception — see the "never throws" test in `engine/__tests__/projects/history.test.ts`.
- `git diff --cached --quiet` exit 0 means nothing is staged (ok, nothing to record); exit 1 means something is staged and should be committed — do not invert this when touching `commitHistory`.
- Commits for one project directory are serialised through a per-dir promise queue (`queues` in `history.ts`) so two concurrent writes to the same project can't race `git add`/`git commit`; this package uses `execFile` (async), never `spawnSync`, per F155.
- `.cynco/` under a project is git-ignored by the `.gitignore` every `createProject` writes — it holds the local index/db, never history.
