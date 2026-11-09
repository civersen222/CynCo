# The image box: CynCo's eyes and sketchpad on the 4070 Ti Super

**Date:** 2026-11-08 · **Status:** approved; all three parts BUILT 2026-11-08 — A vision (`engine/vision/CLAUDE.md`), C wake together (doorman `with`/`health`), B transforms (`engine/imagegen/CLAUDE.md`); live checks pending the owner steps · **Owner's words:** "the 4070 I think is the image box … use the existing comfyui functionality for larger image work"; "the only thing I use image generation for is brainstorming things I'm trying to make IRL … take a picture I've taken and turn it into outlines for a watercolor painting"; "we should just always wake the 4070 pc when we do the main one."

Companion records: `docs/decisions/2026-11-08-wakefulness-design.md` (the boxes, the doorman, slice 2b), the owner's `pc-wakefulness/knowledge/tiering-preview.md` (the tier map this refines), `engine/imagegen/CLAUDE.md` (the ComfyUI client this extends), `engine/projects/CLAUDE.md` (attachments, ingest, the per-turn knowledge block).

## Intent and the why

Every picture the owner has handed an assistant — about twenty, across the NAS, fantasyman and wakefulness sessions — was the same move: *here is what I see; tell me what it means and what to do next.* A NAS front with its LEDs, a modem's ports, a Pi's red light, a switch with no link light, a UEFI boot menu, two installer error screens, a login prompt mistaken for a hang, a router's device list, the dashboard itself. Today a photo attached from the phone is refused by the extractor ("images are captioned in sub-project 3") and the chat model, text-only on the 5090, cannot see it at all.

Generation is a smaller need and a different one: not text-to-image, but **transforming the owner's own photos** — a thing they want to make, varied toward an idea, for brainstorming real-world builds; and a photo turned into clean outlines to paint from.

The 4070 Ti Super box (16 GB, Windows, LAN `192.168.0.47`, tailnet host `THUNDERPUSSY`) already runs Ollama (the slice-2b busy fallback, `qwen3:14b`) and ComfyUI (the engine's picture painter). It becomes **the image box**: the one place CynCo sees and sketches. In the VSM frame it is an S1 operational unit with a specialist variety — vision — that the 5090's text engine lacks; the doorman (S2) wakes it, the daemon (S3) accounts for it, and every look it takes is a logged, gradeable act the metasystem box can read later.

## Goals

1. **See in the moment.** A photo attached in a project chat is understood in that same turn: the model answers about *this* picture.
2. **See for later.** The same photo is captioned and its visible text transcribed into the project's knowledge, searchable like a docx, replacing the refusal.
3. **Read screens, not just scenes.** Small text in a phone photo of a monitor (a boot menu, an error dialog, a device list) is transcribed faithfully; LED colours, port states and labels are named.
4. **Transform the owner's photos.** Two named transforms on ComfyUI, from an attached photo: *vary* (brainstorm variants toward a described idea) and *outline* (clean line art to paint from). Results land in the project's `images/` with their settings, like generated pictures today.
5. **Wake together.** When the doorman wakes the 5090 (knock or schedule) it wakes the 4070 box too; the engine never waits on a box nobody woke.
6. **Degrade audibly.** If the image box is asleep, cold or not answering, the chat says so in plain words and continues text-only; nothing guesses at a picture it did not see.

## Non-goals

- Text-to-image generation as a feature of its own (the existing RenderUI `Image` `prompt` path stays as it is; nothing is removed).
- Video, live camera, or OCR of scanned documents at archive scale.
- A vision model on the 5090. The 27B stays text-only; the lazy/cold-GPU design is untouched.
- Moving the image box's own sleep decisions into the engine (it sleeps by Windows policy like the 5090; later "tiers" work may refine this).

## Anti-goals (a failure even if it works)

- The model describing a picture it was never shown — a silent fallback to guessing from the filename or the user's words.
- A second image pipeline beside ComfyUI. Transforms go through the existing `ComfyClient` and workflow-file mechanism.
- Vision calls that hold the 5090 or block the turn for minutes when the box is asleep. Bounded waits, said aloud.
- Pictures or captions leaving the tailnet/LAN. Both boxes are on the switch; nothing goes to a cloud API.

## Constraints

- 16 GB on the box, shared between the 14B fallback and the vision model. Ollama swaps models on demand; a swap costs ~20 s. The vision model is the box's main job and stays resident when both are wanted; the fallback loads when the 5090 is busy (slice 2b).
- The box is Windows; no SSH today. Steps on the box are the owner's (documented, short).
- Attachments already arrive through `POST /api/projects/:slug/knowledge` from the chat's Attach button, bound to the chat's project; a turn is a separate `user.message`. The design keeps that split and adds only the reference from one to the other.
- Downloads need the owner's approval (standing rule): the vision model pull on the box is an owner step.
- AGENTS.md review triggers this design hits, named so the plan carries design notes: two environment variables, a new network dependency on another box for a turn's content, a new doorman target with a `with` list, a background job inside the upload route. No protocol change: the loop learns of an attached photo through `IngestNotes`, which already carries every file added to the bound project since its last turn.

## The parts, as decided

### 1. Where things run

| Piece | Box | Serves | Notes |
|---|---|---|---|
| Vision model | 4070, Ollama `192.168.0.47:11434` | `/api/chat` with `images` | **My call: `qwen3-vl:8b-instruct`** — the consensus pick for OCR and screenshots in the 16 GB class ([Qwen3-VL 8B guide](https://codersera.com/blog/qwen3-vl-8b-instruct-vs-qwen3-vl-8b-thinking-2025-guide), [vision models by VRAM tier](https://intelligibberish.pages.dev/articles/2026-03-17-best-local-vision-models-2026-vram-tier-comparison)); Gemma 3 12B is the named alternative if its screen-text reading disappoints in the live check. Owner pulls it on the box (`ollama pull qwen3-vl:8b-instruct`, ~6 GB). |
| 14B busy fallback | 4070, same Ollama | slice 2b | unchanged |
| ComfyUI | 4070, `:8188` | vary / outline transforms, and today's `prompt` pictures | **Broken today from the PC**: TCP accepts, HTTP never answers (every engine start logs "not ready"). Owner step: start ComfyUI with `--listen` on the LAN address (or `0.0.0.0` on that box only — it is not on the tailnet path) and allow 8188 in that box's firewall; then `GET /system_stats` from the PC answers. |
| Engine side | 5090 (and any engine) | `engine/vision/` (new, small): the look client, the caption extractor, the attachment context block; `engine/imagegen`: upload + two transform workflows | |
| Wake | doorman | `targets.json`: new target `image` (the 4070 box's MAC, its dashboardless health URL = Ollama `/api/version`), and `main.with = ["image"]` so a burst for `main` bursts `image` too; `/status` reports both | Owner steps: read the 4070 box's wired MAC, enable wake-on-magic-packet in its NIC/BIOS, and prove the wake the way the main PC's was (Power-Troubleshooter event). |

### 2. Seeing in the moment (the turn)

- **Attach, then send.** The chat page uploads a picked file to the bound project's `knowledge/` as today; nothing new is sent with the message. The loop already receives every file added to the bound project since its last turn through `IngestNotes` (F187); an image-typed entry in that list is the attached photo. (Builder-check call: a protocol field `attachments` was considered and dropped — it bought only the distinction between a photo attached to *this* message and one added from the Projects tab, and both deserve a look. A photo attached and sent two turns later is in knowledge with its text and description, and `ProjectSearch` finds it.)
- **One look per photo.** The look runs once, at upload, in the background (section 3), with one fixed instruction that asks for three things in order: *visible text, transcribed faithfully (menus, errors, labels, numbers)*; *the state of things (lights and their colours, cables and ports, what is selected or highlighted)*; *a one-paragraph description*. That order is the diagnostic use case itself, so the description needs no aiming by the user's question. (Builder-check call: an aimed second look per turn was considered and dropped — two looks per photo on a 16 GB box that may be cold is the slow path, and the text-first archival result answers "which line do I pick" as well as an aimed one would.)
- **Tell the model.** When the turn starts, the look for each image added since the last turn is either done — its text, state and description go into the per-turn system block the loop already rebuilds (`RETRIEVAL_TAG`, beside `IngestNotes` and the retrieved passages) as `[Attached image] knowledge/<name> — <text> / <state> / <description>` — or still in flight, and the turn waits for it, bounded by the look's own 60 s deadline (cold load included). Never written to the transcript; rebuilt per turn like the rest of the block.
- **Say what happened.** The chat line under the turn names the look: "looked at <name> on the image box (qwen3-vl, 4.2 s)", or the refusal: "the image box did not answer (asleep or cold) — answering without the picture". Same channel as the busy notice (`governance.alert` info → `alertChatLine`).
- **Config.** `LOCALCODE_VISION_URL` (an Ollama base URL) and `LOCALCODE_VISION_MODEL` (default `qwen3-vl:8b-instruct`), read in one place in `engine/vision/`. Set as **permanent user variables** on the PC, like the embedding variables, so the desk engine the TUI launches and the headless phone engine see the same box; vision is not gated on the lazy engine (the busy fallback is, for its own reason). Unset: looks are refused with "no vision model configured" and the turn proceeds text-only. The look sends `keep_alive: 10m` so the model stays resident across a conversation.

### 3. Seeing for later (ingest)

- **The upload answers at once.** `addKnowledgeApi` writes the bytes and records the file as `indexed: false, reason: 'looking at the picture…'`, answers the POST, and runs the look in the background; the chat's Attach row shows "kept, looking…". When the look finishes, `ingestFile` runs with the result: segments `[{ heading: [name, 'text'], text }, { heading: [name, 'description'], text }]` (state folded into the description), chunked, embedded by the CynCo embed server and stored like any prose file; the record becomes `indexed: true, chunks: n` and the `project.ingest` event tells the page and `IngestNotes`. (Builder-check call: a synchronous look inside the upload route would hold the phone's Attach for up to a minute on a cold box.)
- `extractFile` gains an image extractor for `IMAGE_EXTS` that takes the look result as its input (it never calls the network itself): the look client is injected through `IngestDeps` (a seam like `removeStore`); with no client configured the extractor returns `{ ok: false, reason: 'no vision model configured' }` — the refusal keeps its shape, only the words change.
- A look that fails (box asleep) records `indexed: false, reason: 'image box did not answer: …'` and a rescan retries, exactly as an embedding failure does today. One look per image per sha; the sha is already in the file record.
- Cost control: images over a size cap (my call: 12 MP / 20 MB) are downscaled client-side before upload — the page already has the bytes — not refused.

### 4. Transforming (ComfyUI)

- **Two named transforms**, each a workflow file with placeholders in the existing `LOCALCODE_COMFYUI_WORKFLOW` format plus one new placeholder, `{{image}}`, the uploaded input's ComfyUI filename:
  - `vary`: `LoadImage → VAEEncode → KSampler(denoise {{denoise}}, default 0.55) → VAEDecode → SaveImage` with the user's idea as the positive prompt; the SDXL checkpoint picked as today.
  - `outline`: a line-art preprocessor (`AnyLineArt`/lineart family from `comfyui_controlnet_aux`) producing the outline directly; **my call: the preprocessor's output *is* the deliverable** (clean black lines on white, sized to the photo), with an optional ControlNet-refined variant left to a later request. SDXL has no native lineart ControlNet — the usual route is Canny ([SDXL caveat](https://lilys.ai/notes/tr/comfyui-20260202/comfyui-image-to-line-art-tutorial)) — so the preprocessor-only outline avoids a model-family mismatch and gives the painter what they asked for.
- **Upload.** `ComfyClient` gains `uploadImage(bytes, name)` → `POST /upload/image` (multipart), returning the stored name used in `{{image}}`. The input is the project's own file (`knowledge/<name>` or `images/<key>.png`), read by the engine, never a path the model types.
- **Asking for one.** The RenderUI `Image` element gains `source` (a project-relative image path, validated by the existing `projectImagePath` rule) and `transform: 'vary' | 'outline'`; `prompt` stays the idea text (`vary`) or is omitted (`outline`). The validator, the catalog and the prompt section say so; the image store records `source` and `transform` in the sidecar with the other settings so the History tab and a reopened chat show what was done to what.
- **Node check.** The service's startup probe (which already checks the built-in workflow's nodes) checks the two transform workflows' nodes too and says which custom node pack is missing by name.
- **VRAM.** After each transform job the engine calls ComfyUI's `/free` with `unload_models` so SDXL (~6.5 GB) does not sit beside the vision model (~6 GB) and the 14B fallback (9.3 GB) on a 16 GB card; the look's `keep_alive` is Ollama's to manage. (Builder-check call.)

### 5. Wake together

- `targets.json` grows `"image": { "mac": "<4070 wired MAC>", "health": "http://192.168.0.47:11434/api/version", "iface": "enp1s0" }` and `"main": { …, "with": ["image"] }`. `knock(main)` and a scheduled burst for `main` start a burst for every name in `with` as well (one lock, never doubled); `/status` lists both targets' probe and burst state; the front page's "waking" line names both. A target without a dashboard uses `health` for its probe.
- The daemon's wake publisher keeps sending `target: main`; nothing changes on the engine side.

### 6. What is recorded (so the metasystem box can learn later)

Every look and every transform is one engine-log line with the file, duration and outcome (`ok | timeout | refused`), and the image store's sidecar already records a transform's settings. No counter and no new store: `toolStats` is computed from mission runs by `scripts/cynco-ledger.mjs`, and a phone chat writes no ledger row, so a counter there would never show these. Where this data lives for S4 to read is the metasystem box design's question, not this one's. (Builder-check call.)

## Verification (the plan's acceptance)

Unit and guard tests pin: the loop's reading of image-typed `IngestNotes` entries into the block, and its bounded wait on an in-flight look; the upload route answering before the look and the deferred `project.ingest`; the look client's request shape, `keep_alive` and deadline; the `/free` call after a transform; the image extractor's segments and its refusal shapes; the `{{image}}` placeholder and `uploadImage`; the `Image` element's new props through `validateSpec`; the doorman `with` burst (`test_doorman.py`: knock main → both bursts, never doubled); env read sites in the README inventory.

Live, with the owner on the phone, each once: (1) a photo of the switch's lights → the answer names the lit and dark ports; (2) a photo of a boot menu → the lines come back transcribed and the chosen one named; (3) a lineup screenshot attached, then two turns later "what did my lineup look like?" → found through search; (4) a yard photo with "add a pergola" via `vary` → a picture in `images/` with its sidecar; (5) a photo via `outline` → black-on-white lines; (6) the 4070 box asleep: the look refuses in under a minute and the turn continues, the chat line says so; (7) the doorman's knock wakes both boxes (both event logs).

## Left to the builder

- The exact look instruction wording (two variants: in-turn, archival) and the archival chunk headings.
- Where in `engine/vision/` the client, extractor and block builder sit, and their test seams.
- How the in-flight look is tracked per engine (my call: an in-memory map keyed by project slug + sha, dropped on completion; a restart loses it and a rescan redoes the look).
- The two workflow files' node graphs, checked against the box's installed nodes at the time of building.
- Downscale parameters for large photos.

## Owner steps (outside the repo)

1. On the 4070 box: `ollama pull qwen3-vl:8b-instruct`; start ComfyUI with `--listen` on its LAN address and open 8188 in its firewall; install the `comfyui_controlnet_aux` node pack if the node check asks for it.
2. Read the box's wired MAC, enable wake on magic packet (NIC property + BIOS), give the MAC for `targets.json`, prove the wake once. **Answered by the owner 2026-11-08:** the box is already on Wi-Fi (the house network, `192.168.0.47`, where Ollama, ComfyUI and the health probe live) and wired to the doorman's switch island, the same shape as the main PC; the wake packet goes to the wired port's MAC.
3. Phone: nothing new; Attach already exists.

## Costs to keep

One more model to keep updated on the box; one more network dependency for a project turn's content (bounded, audible); two environment variables; one protocol field; two workflow files that drift with ComfyUI's node packs (the node check names the drift). Removal: unset `LOCALCODE_VISION_URL`/`_MODEL` and the engine is back to text-only with the old refusal wording; drop the `image` target and the doorman wakes `main` alone.

## Builder check — how its questions were settled

A fresh reviewer read this document as a builder. Five of its six questions are settled above as my calls, marked "(Builder-check call)": no `attachments` protocol field (IngestNotes already carries the fact); one look per photo, run at upload in the background, the turn waiting bounded on an in-flight one; the vision variables as permanent user variables so the desk engine sees the box too, not gated on the lazy engine; no counter store, the engine log line is the record; `/free` after a transform. The sixth — the box's network shape — the owner answered: Wi-Fi for the house network plus a wired port on the island, like the main PC.
