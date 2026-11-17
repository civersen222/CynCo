# Triage: the CynCo work order of 2026-11-17

Source: `CynCo_Work_Order.pdf` (27 pages, 29 missions in six parts, plus section 9), handed over
by the owner on 2026-11-17 with the instruction to be skeptical, not to implement what would
harm, and to plan and do what makes sense. The order says it was verified against main
`ca6cbc7a`. This record re-checks every mission against main `61d1510a` (2026-11-17, after
PR #255) by reading the code path it names. Nothing here was taken from the order's own
"verified" notes.

Verdicts: **do** (as written), **do differently** (the problem is real, the prescribed fix is
not the right one here), **already done**, **wrong** (the claim does not hold), **hold**
(needs the owner, or another mission first), **don't** (doing it as written would break
something the owner relies on). The last column says where it went.

## What the order gets right, and where it is unreliable

Its inventory of what is open is mostly accurate, and its sequencing instinct (nets before
surgery, cheap security first) is sound. It is unreliable in three ways, and each recurs:

1. **"Verified by grep" claims that a grep refutes.** A1 says no `chmod` exists anywhere
   (`engine/security/localToken.ts:145` sets `0o600` and :156 runs `icacls`), that the `-p`
   path gives no start command (`tui/localcode_tui/bridge.py:67-71` gives two, pinned by
   `tui/tests/test_bridge.py`), and section 9 says ledger rotation does not exist
   (`scripts/cynco-ledger-shards.mjs:37`, four shards on disk).
2. **Prescriptions that ignore a decision already made.** B2 would break decision 3 of
   `docs/decisions/2026-11-11-local-llm-apps.md`; D2 proposes as new what that record
   already does; D4's pairing item says "at any address", which the phone-access record
   exists to forbid.
3. **Acceptance checks that cannot be met.** C1's "zero test edits", C3's "under 4,000
   lines", A3's "one green run with `CYNCO_INTEGRATION=1`" (which on this PC means a run
   with the live-service guard off).

## Part A: quick wins

| # | Verdict | What the code says | Where it went |
|---|---|---|---|
| A1a `-p` gives no start command | **already done** | `bridge.py:67-71`: "Could not connect to engine on port … Start one: `python -m localcode_tui.app` … or run `bun engine/main.ts`". Pinned by `test_bridge.py:39-52`. The handler is `app.py:83-90`, not `project_picker.py`. | nothing to do |
| A1b home directory permissions | **do differently** | `tokens.json` is already `0600` plus an `icacls` ACL on Windows. The home directory itself gets no mode. On POSIX `0700` is right and harmless. On Windows the home is under the user profile, whose ACL is already the user's; `icacls /inheritance:r` on a folder holding the models, the binaries and the scheduled tasks' state is an untested way to lock something out. | POSIX only, this batch |
| A1c README "returning after a break" | **do differently** | `README.md:200` already has the line and points at `AGENTS.md` and `docs/NOW.md`. The order wants "which command resumes"; a sentence is added only if a resume path exists in the code. | this batch |
| A2 `CYNCO.md` → `CONVENTIONS.md`, audit moved | **do** | The architecture section is stale as well as redundant: it lists `tui/app.py`, `tui/bridge.py`, `tui/screens/` (the package is `tui/localcode_tui/`) and `LOCALCODE_MODEL=qwen3.6`. `CLAUDE.md:3` imports it as `@CYNCO.md`, so the rename moves that import in the same commit. | this batch |
| A3 integration run and CI job | **don't, as written; do differently** | `engine/__tests__/setup/noLiveServices.ts:61`: any value of `CYNCO_INTEGRATION` removes the fetch guard for the whole run, every file. On this PC that lets the suite reach 9160, 9161, 8081, 9165 and 11434: F206, the reason the guard exists. The 13 files it gates use scripted providers and need no live service; the fix (already step 5 of the 2026-11-06 triage) is to take the gate off those files so they run in the ordinary suite, guard on, in CI too. | this batch, per file |

## Part B: security

| # | Verdict | What the code says | Where it went |
|---|---|---|---|
| B1 WebFetch resolves before it connects | **do** | True: `validateUrl` parses, nothing resolves. The refused set already exists for literal addresses (`webFetch.ts:112-119`: loopback, RFC 1918, link-local, 100.64/10, multicast; IPv6 loopback, unique-local, link-local, v4-mapped), the tool says "Only allows public HTTP/HTTPS URLs", and the services that need a LAN address bypass it on purpose (`imagegen/client.ts`, `vision/lookClient.ts`). So there is no new range to decide: a name that resolves to an address the tool already refuses is refused. `fetchGuarded` also serves `AddToKnowledge`. | this batch |
| B2 `--api-key` on the managed llama-server | **don't** | It breaks a decided capability. Decision 3 of the local-LLM apps record: "the app's next request is answered by CynCo's model"; `engine/apps/displace.ts:171` tells the owner so. dndai sends no key and its files are not CynCo's to change. It also breaks callers that are not the provider: `conversationLoop.ts` side queries, the box reporter (a separate process: `/props`, `/slots`), the activation tap (`/activations`, which would read as "tap down"), slot save and restore. The server binds 127.0.0.1 only. | owner sheet, recommendation: no |
| B3 management token rotation | **hold** | Real, small in value, and with a trap the order does not see: `tokenFor(scope)` returns the first record holding the scope and the page is served `tokenFor('inference')`; a rotation that reorders the records hands the page the management secret. Several engines also share the file and each writes its whole list. The token is printed at every engine start (`main.ts:363`), so "appears exactly once" is not true today either. | owner sheet |
| B4 debug dumps, console.log ratchet | **wrong in part; do differently** | There are no "http/sse debug dumps" and no "structured logger": neither exists in `engine/`. The real noise is one line: `main.ts:452` prints `[localcode] Emitting: <type>` for every event, including every streamed token. A ratchet on `console.log` would work against the repo: the engine log is the diagnostic record (`loopWatch.ts`, `logTail.ts`, `dispatch-mission.sh` and `taskRunner.ts` read named lines from it). | the per-token line, this batch; no ratchet |

## Part C: structure

| # | Verdict | What the code says | Where it went |
|---|---|---|---|
| C1 group the loop's fields | **don't** | 108 fields, not 96; `this.` on 1,002 lines. "Zero test edits" cannot hold: 16 test files reach 22 private fields through `(loop as any).X`, 76 times (`callsSinceCommit` 18 times). After a mechanical `this.x` → `this.state.x`, a test that injects a stub writes a dead property and can pass while testing nothing. The type-check does not see it: these are `any` casts. A rewrite that silently hollows out its own net is the opposite of the order's stated staging law. | owner sheet, recommendation: no |
| C2 extract `executeOneTool` | **hold** | About 1,090 lines touching 48 members of `this`. Nothing in this order needs it: MCP tools (D1) registered in the tool registry reach it as it is. `AGENTS.md`: extract "when it has one responsibility and a testable seam — not because a file is long". | when a change needs the seam |
| C3 four extractions | **wrong** | All four are already modules: `bridge/commitPressure.ts`, `engine/bestOfN/*`, `engine/genui/*`, `engine/training/*`. What is inline is glue: about 130, 150, 130 and 75 lines. "Under 4,000 lines after C3d" cannot come from 485 lines. | nothing to do |
| C4 `main.ts` | **hold; one real finding** | Three flags, one slash-command switch. `ProviderType` is already a union, so a typo in code is a compile error. The real gap is at run time: `config.ts:227` casts the configured value unchecked, and `bootstrapProvider.ts` sends every provider but `llama-cpp` to the Ollama client, so `openai-compat`, `vllm` and `lmstudio` never reach `createProvider`. | finding to NOW.md |
| C5 dashboard ES-module split | **hold** | The owner's condition (`docs/NOW.md`: "a split is justified only by a concrete change that it blocks") is not met: neither D2 nor D4 is blocked by the single file. 20 test files lift code from it by text, each with its own copy of the helper, and module files would have to join the token-less routes on the tailnet listener. | unchanged |
| C6 one taxonomy, verdict schema | **wrong in part; hold** | `toolRegistryDrift.test.ts` already holds the S5 vocabulary to the registry (`ALL_TOOL_NAMES` is derived from it). The two taxonomies that disagree are `classifyCall` (`vsm/missionInvariants.ts`) and `classifyTool` (`scripts/cynco-ledger.mjs`): the 2026-11-06 triage, A5. `s5-weights.json` is not in the repo. | owner sheet (F4 c, g) |
| C7 boot test | **hold** | Only as the net for C4. A test that boots a second engine has taken the live one down before (F224). | with C4 |
| C8 reducer tests under jsdom | **hold** | `handleEvent` (310 lines, 31 cases) mutates a global and draws; it is not the pure reducer the order assumes. The one bug it names (the reconnect intervals) is pinned in this batch in the page's existing test style. | with C5 |

## Part D: new functionality

| # | Verdict | What the code says | Where it went |
|---|---|---|---|
| D1 MCP client | **do, as its own change; one fix now** | True: discovery only. And the discovery lies: `main.ts:89` reports every entry that is not disabled as `connected`, which the TUI shows in green, with nothing ever connected. A client that starts configured commands is new autonomous authority (`AGENTS.md` review trigger) and gets a decision record and a PR of its own. | the false status, this batch; the client, its own session |
| D2 OpenAI-compatible serve surface | **don't, as written; one fix later** | The premise is false: displaced apps are already answered by CynCo's server (decision 3), and only dndai runs a llama-server at all. The server has one slot (`--parallel 1`): app traffic through it evicts the owner's KV cache and queues the owner's turn. A token-authenticated inference route on the tailnet listener for clients that are not paired phones widens the boundary `AGENTS.md` names. The real gap is NOW.md's item (f): an app's requests are not counted as activity, so the model can unload under a game in play. | owner sheet; (f) next batch |
| D3 vitest suite gate and mutation sweep | **do, as its own change** | True, with risks the order omits: a new gate's variables must join `SUITE_GATE_ENV_KEYS` or the model's Bash holds the baseline path, and `noteLines` redacts only the pytest-shaped block, so a vitest gate of another shape leaks baseline ids into the note the model reads. `cynco-verify.mjs:54` already grades a vitest `markerCheck`. Sealed-gate work: rule 11 applies. | its own session |
| D4e reconnect interval leak | **do** | Worse than stated: `fetchSessionState` starts five intervals per reconnect, not three (`pollGovernance`, the tool-feed tick, `pollMission`, `pollCampaign`, `fetchTrainingData`), none stored or cleared. | this batch |
| D4 pairing code from the desk | **do differently** | "At any address" is the remote layout: the server cannot tell the desk on its tailnet address from a phone, and a paired phone could then mint more devices. What the owner asked for (NOW.md: "A desk page should be able to show the code without a token hunt") is met by letting a local client read the current code with the token the local page already holds: the code grants nothing its reader does not have. | this batch |
| D4f silence on the dashboard | **hold** | True. `StreamWatchdog` is private to a request; nothing reaches `/api/session`. Engine and page change together. | next batch |
| D4g Missions history on Away | **hold** | True. The phone already has a Missions tab (schedules); the ledger panel is a second thing with the same name. | next batch |

## Part E: harness follow-ups

| # | Verdict | What the code says | Where it went |
|---|---|---|---|
| E1 first real mission after F235 to F237 | **hold (owner's go)** | The restart it names has happened (the phone engine was started 2026-11-15 on `ca6cbc7a`). The run itself takes the GPU and stops the phone engine for its length. | owner sheet |
| E2 a stalled stream resumes once | **hold (after E1)** | The probe path cannot carry it as written: `shouldProbe` fires only for a landed marker, and campaign waves pass no probe command. The driver tells a stall from a crash only by the text "(F235)". | after E1 |
| E3 Ollama stall clock | **do** | True. `StreamWatchdog` is not exported and takes a real timer; the Ollama stream reads with the caller's signal only. | this batch |
| E4 marker note leads with FAIL lines | **hold (owner; six missions of GPU)** | As NOW.md says: a measured instrument, "a decision of its own". | owner sheet |
| E5 the phone engine's seat | **hold (owner)** | Memo. | owner sheet |
| E6 campaign leftovers | **hold** | (c) needs a casino brief nobody here can write; (d) NOW.md itself warns that restarting the phone engine between waves "would skip ideation every wave", and it waits on E5; (h) changes the numbers of the supervision-economics instrument. | (h) next batch |

## Part F and section 9

| # | Verdict | What the code says | Where it went |
|---|---|---|---|
| F1 evidence index with a generator and a guard | **do differently** | 82 dated documents, 67 of them plans and specs. A guard that fails on every new record adds a step and no information: the directory is the index. | a short table in `docs/README.md` |
| F2 `fix-doc-line-pins.mjs` | **do** | True for the nearest-occurrence choice (`:65-71`). The baseline half is misdescribed: the script never writes a baseline; `misplacedRefs()` hands it baselined refs and it moves them. | this batch, first |
| F3 two flaky tests | **do** | Both as NOW.md records them. | this batch |
| F4 the twelve wire-or-remove calls | **do** | Twelve, (a) to (l). | owner sheet |
| S9 ledger rotation "urgent" | **wrong** | Built: 40 MB shards, four on disk (173 MB, 287 rows). "166 MB across 194 rows" adds all four files' size to the first file's row count. | nothing to do |
| S9 monthly tag and CHANGELOG | **hold** | The failure log and the merged PRs are that record already. | owner sheet |

## The order of work

**This batch, one pull request, one commit per mission:** F2 (the line-pin tool, because the
rest shifts lines), F3, the per-token log line (B4), the reconnect intervals (D4e), the
Ollama stall clock (E3), WebFetch resolution (B1), the MCP status (D1), the home directory
mode and README sentence (A1), the renames (A2), the pairing code for a local page (D4), the
integration gate taken off the files that need no live service (A3), the records table (F1),
and the owner sheet (F4, E5, and every "hold" above that is the owner's).

**Next batch:** app traffic as activity (the kernel of D2), silence on the dashboard (D4f),
the Missions history on Away (D4g), the economics classifier (E6h).

**Their own sessions:** the MCP client (D1) and the vitest gate (D3).

**Not without the owner:** B2, B3, C1 to C8, D2 as a serve surface, E1, E2, E4, E5, E6c, E6d,
the tag and CHANGELOG. `docs/reviews/2026-11-17-owner-decisions.md` puts each on one line
with a recommendation.
