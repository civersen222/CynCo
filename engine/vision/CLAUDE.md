# engine/vision

## Purpose
CynCo's eyes: a photo attached in a project chat is looked at once by the vision model on the image box (the 4070 Ti Super's Ollama), and what it read — visible text first, then the state of lights, ports and selections, then a description — reaches both the next turn and the project's knowledge. The 5090's chat model stays text-only; the lazy/cold-GPU design is untouched. Design: `docs/decisions/2026-11-08-image-box-design.md`.

## Key files
| File | Role |
|---|---|
| `settings.ts` | `visionSettings`: the one read site of `LOCALCODE_VISION_URL` / `LOCALCODE_VISION_MODEL` (default `qwen3-vl:8b-instruct`); unset URL = no vision. |
| `lookClient.ts` | `LookClient.look`: one Ollama `/api/chat` call with the image as base64 and `LOOK_INSTRUCTION`; `parseLook` splits the reply by `TEXT:` / `STATE:` / `DESCRIPTION:`; 60 s deadline; every failure is a reason string. |
| `lookRunner.ts` | `LookRunner`: looks run behind the upload — `start` (one per `<slug>/<rel>`, never doubled), `pending` (the loop waits, bounded by the client), `recent` (a small LRU the turn and a rescan read instead of asking again); `PENDING_REASON` is the record the upload route writes first. |

## Important types & functions
- **`visionSettings`** (`settings.ts:19`) — `{ url: string | null; model }`; `DEFAULT_VISION_MODEL` (`settings.ts:17`). Set the two variables as permanent user variables on the PC so the desk engine and the headless phone engine see the same box.
- **`LOOK_INSTRUCTION`** (`lookClient.ts:19`) — asks for the three labelled sections in order; the order is the diagnostic use case ("which line do I pick", "is this light meant to be red"), so the look needs no aiming by the user's question and one look per photo serves the turn and the index alike.
- **`parseLook`** (`lookClient.ts:33`) — a missing label is `''`, never a failure; a section reading `none` is `''`.
- **`LookClient`** (`lookClient.ts:47`), **`look`** (`lookClient.ts:62`) — plain `fetch` (never `fetchGuarded`, which refuses 192.168/16); `keep_alive: '10m'`; `LOOK_TIMEOUT_MS` (`lookClient.ts:29`) = 60 000, cold load included; refusals: `image box did not answer: <error>`. **`makeLookClient`** (`lookClient.ts:90`) — null when no URL is set.
- **`LookRunner`** (`lookRunner.ts:25`): **`start`** (`lookRunner.ts:34`), **`pending`** (`lookRunner.ts:58`), **`recent`** (`lookRunner.ts:62`); `finish` is the ingest, bound by `makeProjectsDeps` (`engine/projects/api.ts`). **`PENDING_REASON`** (`lookRunner.ts:20`) = `looking at the picture…`. **`imageMime`** (`lookRunner.ts:78`).

## Data flow
1. The phone's Attach uploads a picture → `addKnowledgeApi` (`engine/projects/api.ts:106`) writes the bytes, records `indexed: false, reason: PENDING_REASON`, answers 201 at once, and calls `LookRunner.start`.
2. The runner asks the image box; on the answer `finish` runs `ingestFile(..., { lookInput })` (`engine/projects/ingest.ts`): `extractFile` → `imageSegments` (`engine/projects/extract/image.ts:13`) → chunks embedded by the CynCo embed server → `indexed: true, chunks: n` → `project.ingest` to the page (the Attach row turns from "kept, looking…" to indexed, the chat says "Looked at <file>") and to `ConversationLoop.noteProjectIngest` (`engine/bridge/conversationLoop.ts:1275`).
3. The next turn: `injectProjectRetrieval` (`engine/bridge/conversationLoop.ts:1281`) reads the pictures out of `IngestNotes.takeEvents` through `attachedImages` (`engine/projects/retrieval.ts:98`), waits on `pending` if the look is still in flight, and puts `formatLookBlock` (`engine/projects/retrieval.ts:114`) — `[Attached image] knowledge/<name> — text / state / description` — at the top of the per-turn `[Project knowledge]` block. The chat line names the look or the refusal (`sayVision`, `engine/bridge/conversationLoop.ts:1267`, on the `governance.alert` info channel).
4. A rescan re-looks an image through the runner (`rescanOne`, `engine/projects/ingest.ts:220`): a recent look is reused; otherwise a look is started and awaited.

## Switched on by
`LOCALCODE_VISION_URL` (and `_MODEL`). Absent: `makeLookClient` is null, `ProjectsDeps.looks` is null, the extractor answers `no vision model configured`, the turn says so once per picture and continues text-only. Nothing else depends on this package.

## Gotchas
- One look per photo, at upload, in the background: an upload that waited on a cold 16 GB box would hold the phone's Attach for up to a minute, and a second aimed look per turn would double the cost (builder-check call in the design record).
- A failed look (`image box did not answer: …`) is recorded like a failed embedding: the file stays, the record carries the reason, a rescan retries.
- `recent` is in-memory: after an engine restart the turn falls back to the retrieval search (the chunks are in `project.db`), and a rescan re-looks.
- Pinned by `engine/__tests__/vision/{settings,lookClient,lookRunner}.test.ts`, `engine/__tests__/projects/{extract,ingest,api,retrieval}.test.ts` (image cases), `engine/__tests__/dashboard/chatAttach*.test.ts`.
