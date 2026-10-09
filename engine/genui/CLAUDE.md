# engine/genui

## Purpose
Generative UI for the 9161 dashboard: the model draws tables, plans, charts, key facts, forms and buttons in the chat pane through one tool call, `RenderUI`, and the page's clicks come back to it as its next user turn. This package owns the component vocabulary (`catalog.ts`), the validator that turns whatever the model wrote into something the page can draw (`spec.ts`), the prompt section that teaches the tool (`prompt.ts`), the progressive parse of a half-streamed call (`partial.ts`), the click → user-turn formatter (`actions.ts`) and the tool itself (`renderUiTool.ts`). The conversation loop (`engine/bridge/conversationLoop.ts`) emits the `ui.render` frames and accepts the `ui.action` command; the page (`engine/dashboard/index.html`) renders with vanilla DOM. It must never throw on model input, never present a cut-off spec as final, never leave a partially drawn surface without a terminal frame, and never let a model-authored string reach the page unescaped. The format, vocabulary and prompt rules were adopted from OpenUI, json-render and A2UI (see `CREDITS.md`); none of their renderers could be used (React/Lit, no no-build bundle), which is why the page's renderer is hand-written.

## Key files
| File | Role |
|---|---|
| `catalog.ts` | `GENUI_CATALOG`: 42 components in seven groups with typed props, children policy, description and example — the single source the validator, the prompt and the dashboard tests read. |
| `spec.ts` | `validateSpec`: name resolution, field relocation, shape coercion, limits, reachability, Button/Form and Tabs rules; lenient `partial` mode for streaming frames. |
| `prompt.ts` | `genuiPromptSection`: the static `<RENDER_UI>` section (call shape, nine rules, a worked example, grouped signatures), built once from the catalog. |
| `partial.ts` | `parsePartialSpec`: jsonrepair + partial validation over the streaming tool-call buffer; `PARTIAL_FRAME_INTERVAL_MS`. |
| `actions.ts` | `formatUiAction` / `uiActionEcho`: the user turn a click becomes, bounded per section. |
| `renderUiTool.ts` | `renderUiTool` (`RenderUI`): the envelope `inputSchema` the server turns into a grammar, and the result text that lists what could not be drawn. |

## Important types & functions
- **`GENUI_CATALOG`** (`catalog.ts:62`) — the component table; `GENUI_COMPONENT_NAMES` (`catalog.ts:387`) and `GENUI_GROUPS` (`catalog.ts:390`) derive from it; `resolveComponentName` (`catalog.ts:397`) resolves a model's spelling case-insensitively.
- **`validateSpec`** (`spec.ts:383`) — `(raw, { partial? }) → { spec | null, errors, count }`; never throws. Strict mode reports every lossy decision for the model; partial mode skips silently (design A3).
- **`LIMITS`** (`spec.ts:19`) — 300 elements, 500 array items, 8k chars per string, depth 24, id pattern; `isSurfaceId` (`spec.ts:46`) is the surface-name check the loop and the page share.
- **`genuiPromptSection`** (`prompt.ts:90`) — byte-stable section; `genuiExampleCall` (`prompt.ts:95`) is the worked example the tests and the page demo reuse.
- **`parsePartialSpec`** (`partial.ts:19`) — null until a root exists; carries `surface` only once it is complete and valid.
- **`formatUiAction`** (`actions.ts:34`) / **`uiActionEcho`** (`actions.ts:26`) — the structured body and the echo line; `UI_ACTION_SECTION_CAP` (`actions.ts:14`).
- **`renderUiTool`** (`renderUiTool.ts:59`) — `core: false` (loadable in a coding session), always in `PROJECT_TOOL_NAMES` (`engine/projects/profile.ts:15`); `RENDER_UI_INPUT_SCHEMA` (`renderUiTool.ts:20`) declares `surface` before `spec` so partial frames can carry it.
- **`ConversationLoop.handleUiAction`** (`engine/bridge/conversationLoop.ts:914`) — idle: the click is the next user turn; busy: queued in `pendingUiActions` and drained at the turn's natural end (`engine/bridge/conversationLoop.ts:3910`) or re-dispatched from `runTurn`'s finally (`engine/bridge/conversationLoop.ts:1340`).
- **`ConversationLoop.emitFinalUiRender`** (`engine/bridge/conversationLoop.ts:949`) — the one final frame per call, before `tool.complete`; `closePendingUiSurfaces` (`engine/bridge/conversationLoop.ts:936`) owes every partial surface a terminal frame.

## Data flow
1. A turn that offers `RenderUI` (every project chat; a coding session after `load_tools`) gets the `<RENDER_UI>` section appended to its prompt (`engine/bridge/conversationLoop.ts:1906`).
2. The model calls `RenderUI({ surface, spec })`. While the arguments stream, the loop feeds the `input_json_delta` chunks to `parsePartialSpec` at most every `PARTIAL_FRAME_INTERVAL_MS` and emits `ui.render { partial: true, surfaceId: toolId }` frames.
3. `executeOneTool` runs the tool (validate, answer with count + issues). Before `tool.complete`, `emitFinalUiRender` validates once more, appends ` (surface: <id>)` to the result and emits `ui.render { partial: false }` under the surface the model named (or the toolId). A refused, malformed or errored call gets `spec: null` with the reason; a jsonrepair-closed or `max_tokens` spec is drawn but reported as cut off.
4. The page renders the surface; a click sends `ui.action` (bounded at the socket by `commandSchema.ts`), which `main.ts` routes to `handleUiAction` → `formatUiAction` → a user turn; the model answers and may re-render the same surface id.

## Gotchas
- Partial frames ALWAYS use `surfaceId === toolId`; only the final frame carries the model's surface id. The page keys on `data-tool-id` first and re-labels on the final frame, else every named surface would render twice (design A1; pinned by `engine/__tests__/bridge/uiRenderWiring.test.ts`).
- Partial emission is gated on `offeredToolNames.has('RenderUI')`: a model that remembers the tool from history without it being offered is refused before the executor, and a partial surface for a refused call would have no final frame. Every path that opens a surface closes it — the batch loop after `executeOneTool` and `runTurn`'s finally — so an abort, halt or refusal still sends `spec: null` (design A2).
- `validateSpec` is lenient on purpose: it coerces `"2"` → 2, string option lists, `data: [{label,value}]` charts, row objects, nested trees and A2UI/OpenUI action objects, and reports only what it dropped. An unknown component becomes a visible error `Callout` AND an issue line — a silent drop is the OpenUI failure mode the design rejected.
- The tool returns `isError` only when nothing is drawable; a cosmetic issue must not trip the per-tool circuit breaker on the one tool whose output the user is looking at.
- The prompt section is static text and is pushed only when the tool is offered — the same condition that already rewrites the tool list, so the prefix-cache rule (`engine/engine/CLAUDE.md`) holds.
- `ui.action` is bounded twice: the socket refuses ids over 128 chars, text over 2k and objects over 8 KB (`commandSchema.ts`), and `formatUiAction` truncates each section at 4 KB — a read-scoped page must not be able to push a multi-megabyte user turn into the model.
- A click that lands while a turn runs is never handed to the busy guard (which drops interactive messages): it waits in `pendingUiActions` and is delivered at the natural end or re-dispatched after any other exit. In a coding session it skips DoD contract auto-create (`TaskOpts.uiAction`) — a form submit is not a task.
- A turn whose only tool was `RenderUI` gets no "summarize what you did" follow-up: narrating a card under the card is noise.
- Whether llama-server streams tool arguments in many deltas is not measured in this repo (the stream probe checks only that the whole buffer parses); if it sends them in one or two chunks, partial frames simply never fire and the final path is unaffected.
