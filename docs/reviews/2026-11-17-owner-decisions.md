# Decisions for the owner (2026-11-17)

Everything the 2026-11-17 work order left that is the owner's to decide, on one sheet, so it
can be gone through in one sitting. Each row says what a yes costs, what a no costs, and what
is recommended. The evidence for each is in `docs/reviews/2026-11-17-work-order-triage.md`
and, for the last table, in `docs/NOW.md` under F233. Nothing on this sheet has been built.

Answer a row by its number; a bare "as recommended" for the whole sheet is an answer too.

## From the work order

| # | Decision | If yes | If no | Recommended |
|---|---|---|---|---|
| 1 | **B2.** Give the managed llama-server an `--api-key`. | dndai stops being answered by CynCo's server while CynCo holds the GPU (decision 3 of the local-LLM apps record), and the box reporter, the activation tap, side queries and slot save/restore all need the key plumbed to them. | The server stays open to any process on this PC, as now. It binds 127.0.0.1 only. | **No.** A local process that can reach the port can already read `~/.cynco`. |
| 2 | **B3.** A route that rotates the management token. | Two hours, with one trap to pin first: the page is served the first token that holds the `inference` scope, so a rotation that reorders the records hands the page the management secret. | To rotate today, delete `tokens.json`: every paired phone pairs again. | **Yes, later.** Small value, and the token is printed at every engine start anyway. |
| 3 | **C1 to C3.** Regroup the loop's 108 fields and extract four subsystems. | 1,000 changed lines in one file while other sessions work in it; 16 test files reach private fields by name and would pass while testing nothing; the four subsystems are already modules. | The file stays 6,094 lines. | **No.** Extract a seam when a change needs it (`AGENTS.md`, rule 4). |
| 4 | **C4.** Which provider names are supported. Today every name but `llama-cpp` runs the Ollama client; `openai-compat`, `vllm` and `lmstudio` are never built. | Route them to `createProvider`, check the name at load, give that provider the stall clock: half a day. | Take the three names out of `ProviderType` so a profile cannot ask for them: an hour. | **Take them out**, unless one of those servers is in use. |
| 5 | **C5, C8.** Split the dashboard page into modules. | 20 test files that lift code from the page by text are rewritten; module files join the routes served without a token. | Nothing changes. | **No**, until a change is blocked by the single file (the owner's own condition). |
| 6 | **D1.** An MCP client: connect to configured servers and offer their tools. | A new subsystem that starts commands named in a config file. Its tools go through the same approval, fencing and truncation as native ones. Two to three days with a decision record. | MCP servers stay listed as `configured` and unused. | **Yes, as its own change.** Say which servers first. |
| 7 | **D2.** An OpenAI-compatible endpoint on the dashboard server for other apps. | Token-authenticated inference for clients that are not paired phones, on the tailnet listener: a wider boundary. One slot: an app's request evicts the owner's cache and queues the owner's turn. | Apps keep being answered by CynCo's llama-server on 8081 while CynCo holds the GPU, as decided on 2026-11-11. | **No.** Fix the real gap instead: an app's requests do not count as activity, so the model can unload under a game in play (next batch). |
| 8 | **D3.** A vitest suite gate and a TypeScript mutation sweep for campaigns outside Python. | Two to three days of sealed-gate work, rule 11 applying; the baseline path and its ids must stay out of the model's reach. | A repo without pytest is graded by its marker check alone, which already reads vitest's FAIL lines. | **Yes, as its own change**, when a non-Python campaign is next planned. |
| 9 | **D4.** Let the page at `127.0.0.1:9161` show the pairing code with the token it already has, without the management token. | A local page can read the code. The code grants a device token of `inference` scope, which that page already holds. The work order's "at any address" is not this and stays refused. | The code is read from the engine log, as now. | **Yes.** It is a scope change, so it waits for this answer. |
| 10 | **E1.** The first real dispatched mission since the F235 to F237 fixes. | The phone engine stops for the length of the run and the GPU is taken, about an hour. A brief and a repository are needed. | The four fixes of 2026-11-14 stay proven with stand-ins only. | **Yes**, at a time of the owner's choosing; E2 and E4 wait on it. |
| 11 | **E2.** After a stall, re-prompt once and carry on. | A wave that stalls at hour one keeps its budget. The re-prompt pays a model reload. | A stall ends the mission, as now. | **Yes, after E1.** |
| 12 | **E4.** The marker note leads with the first FAIL lines. | Six missions of GPU for the A/B, then a change to what every mission reads. | A gate whose FAIL lines come early tells the model nothing of them. | **Yes to the A/B**, after E1; decide on its numbers. |
| 13 | **E5.** What the phone engine does while a mission holds its seat: (a) stays stopped until the mission's end step, as now; (b) waits and re-enters when the seat frees; (c) answers on the fallback box meanwhile. | (b) a long-lived waiter and one more thing that can hold the PC awake; (c) the phone works during missions on the 14B model, and the fallback box must be on. | (a) the phone is dark for the length of every mission. | **(c)** if the phone matters during missions, else (a). Not (b). |
| 14 | **E6c.** A gate author for repositories other than CivKings. | Someone who knows the casino writes its brief; then a `--roadmap` flag. | Gates for other repositories are written by hand. | **Yes, when the brief exists.** |
| 15 | **E6h.** The supervision-economics classifier reads repo roots from campaign config. | The paper's numbers gain the casino's supervision; old totals stay as they were. | A campaign outside CivKings is invisible in the economics. | **Yes** (next batch), with row 27 answered first. |
| 16 | **S9.** A monthly annotated tag, and a CHANGELOG. | One command a month. | "What was running on a date" is answered from merge commits. | **Tag, yes. CHANGELOG, no:** the failure log and the pull requests are that record. |
| 17 | **B1 follow-up.** Refuse NAT64, 6to4 and site-local IPv6 forms of a private address in `WebFetch`. | Three more ranges, an hour. | They pass, as they always did; this PC has no NAT64 route. | **Yes.** |

## From the README audit (F233): wire it or remove it

| # | Mechanism | To wire | To remove | Recommended |
|---|---|---|---|---|
| 18 | (a) **W2**, the model-switch rule, cannot fire: one model is ever offered. | Name a second model and build a switch that reloads it (ten seconds and the KV cache each time). | Delete the rule and its test. | **Leave it, labelled a hypothesis**, until a second model is really on the box. |
| 19 | (b) **C1** waits for a `halted` status that is never reported. | Have the report return it. | Delete C1; the algedonic kill switch does the job. | **Remove.** |
| 20 | (c) The **S5 rule weights** are written and never read. | A reader in rule evaluation, which changes a measured instrument. | Stop writing the file. | **Remove**, and fix the dismissal signal's key when weights are wanted. |
| 21 | (d) **W3's revert** is recommended and never executed. | Show the recommendation on the dashboard (advise). Executing it is authority to change files. | Delete W3. | **Wire the display only.** |
| 22 | (e) Every **sub-agent is read-only**; the researcher has no web tools. | Give the researcher `WebSearch` and `WebFetch` (small); build the writing tiers (large). | Nothing to remove: the README already says so. | **Web tools for the researcher; the rest stays unbuilt.** |
| 23 | (f) A **profile's launch knobs beat the environment**, the reverse of the documented order. | Make the environment win, one line per knob. | Document the order as it is. | **Environment wins**, as documented. |
| 24 | (g) **No S5 rows** in `rule-verdicts.json`, so every S5 decision reads as advisory. | Re-run the extraction; make the writer refuse a malformed row. | Accept that S5 authority is never earned. | **Re-run and look**: half an hour says whether the script or the data is short. |
| 25 | (h) The **training defaults** name Qwen2.5 bases. | Name the Qwen3.8 base when a training run is planned. | Say in the training doc that the defaults are stale. | **Say so now; change at the next run.** |
| 26 | (i) The default **embedding model** is not in Ollama's library, so every session falls back and one pull fails. | Make `nomic-embed-text` the default (it is what runs) and jina opt-in. | Keep the failed pull. | **Wire.** |
| 27 | (k) The campaign log's **supervising spend fell** from $4,295.55 to $2,995.57 with no explanation. | An hour or two to find the discontinuity. | The economics stay unexplained. | **Find it before the numbers are used again.** |
| 28 | (j) The **Brain lens** was computed for Qwen3.6; the model is 3.8. | Recompute it (GPU hours). | Label the Brain tab with the model the lens is for. | **Label now; recompute when Brain work resumes.** |
| 29 | (l) The **guided screen** drops the mode it was asked for. | Pass the mode through: one line and a test. | Remove the mode argument. | **Wire.** |
