# CivKings Redesign — Campaign Log

Plan: `docs/civkings-redesign-plan.md` · Spec: `docs/civkings-redesign-spec.md`
Gates (sealed, outside repo): `~/.cynco/heldout/civkings-redesign/c<N>/`

| campaign | BASE commit | gate sha256 | calib BASE | calib STUB | waves | verdict |
|---|---|---|---|---|---|---|
| C1 — the sim becomes visible | 2092b0c | f2dd97feb5db182f | clean MISS (8 surface fails, exit 1, no traceback) | discriminators FAIL both seeds: G1.1c, G1.3a.season/inquiry/deflection, G1.3c, G1.4a.verbs | wave 1 MISS (ledger c1-wave1-1787631354668: landed, verified False, markerSeen False; gate: acts+registry missing ×2 seeds; ladder/beats landed as methods with domain beat kinds — substance real, shape wrong) · wave 2 dispatched (adapt-shape brief c1-wave2.txt, BASE 185e9ec) | **PASS** — wave 2 (ledger c1-wave2-1787667568006, 784 turns): driver verify PASS 7166ms; hand re-run exit 0, 149 checks 0 fails; marker exact in a418d49 with wire-check proof; frames rendered (Briefing ladder + Gazette headlines, seed 7 t8); sweep 4/25 killed (record #236) — 15/21 survivors sit in the committed `_c1_selfcheck.py` probe, not game logic; real-logic survivors: acts.py:25/:41, beats.py:139/189/199/201 (thin-tests residual, carried to close-out) |
| C2 — the player has a stake | a418d49 | 1f6b4bc6ca740b5b | clean MISS (13 fails: 9 surface + 4 derived; 150 PASS incl. the full C1 chain green; exit 1, no traceback) | discriminators FAIL all 3 seeds: G2.4b.t4 ×3, G2.2c, G2.3.failable; 180 checks PASS | wave 1 MISS (ledger c2-wave1-1787691757144: landed, verified False, 659 turns; exactly one gate fail — G2.2b `AttributeError("'Character' object has no attribute 'want'")`, wants only derived inside set_ambition, absent at boot; CynCo misdiagnosed the sealed command as MSYS backslash-stripping and self-stopped at marker 79e0bca; sweep 0/25 killed (record #237) — all 25 sampled mutants sat in the `_c2_grid.py` scratch probe (25-cap sampled alphabetically; 298 available), so it measures probe pollution, not game logic — the probes wave 2 deleted) · wave 2 (adapt-shape brief c2-wave2.txt quoting the fail verbatim, BASE 79e0bca) | **PASS** — wave 2 (ledger c2-wave2-1787700776646, 40 turns): driver verify PASS 22846ms; hand re-run exit 0, 335 PASS 0 FAIL incl. G2.4c "0 C1 regressions"; marker exact in 9c4b773 (wants from boot: vs-agenda if one exists, else neutral from strongest disposition; committed gilded/tests/test_c2_contract.py; all 7 scratch probes removed incl. `_c1_selfcheck.py`); House frames render (banner family/why/clock "turn 4 of 10" + court cards with stance/want per adult, seed 7); sweep 2/8 killed (record #238) — 6 survivors all in ambitions.py:291-302 boot-want derivation (age-threshold + cmp mutants; thin-tests residual, same class as C1's) |
| C3 — the world pushes back | 9c4b773 | 9c0a6fbd4027a7c2 (hardened; was 90fa086ac43242e5) | clean MISS (hardened gate: 6 fails, independent surface prongs; exit 1, no traceback) | inert-orders stub FAILs exactly the 9 discriminators: G3.3a ×4 (no head-faced beats), G3.4a.deflection, G3.5a ×4 (seat run identical to control); 46 anatomy/fog checks PASS — re-verified post-hardening in a BASE worktree | wave 1 MISS (shape divergence: keys Church/Crown/Guilds/Treasury, no hold_seat; 8 fails, 336 PASS); wave 2 MISS (contract inversion F128 — root cause superseded by F129, IDENTICAL 8 fails, 440 turns spent improving the invented world); wave 3 run 1 VOID (engine defect F129: compaction destroyed the brief; 217 tool calls, 2-line diff, not chargeable to the wave budget); wave 3 re-run post-fix | **PASS** — wave 3 re-run (ledger c3-wave3-1787773124818, 581 turns, 88 min): driver verify PASS 58735ms; hand re-run exit 0, full C1+C2+C3 chain green incl. G3.6 "0 C1+C2 regressions"; marker exact in 4c67cae; 0/558 tool calls touched grading apparatus; 9 compactions survived with the brief pinned (F129 fix validated: same brief+model+base that produced a 2-line rename now landed the campaign); Powers frames render: 4 Orders fogged at t8, informant on Combine opens "Pursuing Purge Scabs" while others stay fogged (C4 warts: "House " prefix on Order rows, last-two-row overlap); sweeps — wave1 15/25 killed (survivors: orders.py:48-51 head-stat consts + 2 ambitions bools), wave2 8/23 (survivors: orders.py lever consts), final 5/25 (16 of 20 survivors = ambitions.py:50-65 Order-family disposition weights, ±1.0→2.0 keeps ordering; thin-tests residual, pin in C4); void-run sweep UNMEASURED and itself the finding: no test files delivered to own the change |
| C4 — one living UI | 4c67cae | 05ea014c667311c7 | clean MISS (surface fails only, chain green) | claims-vs-pixels discriminators FAIL (TABS mutants + one-tier hedge) | wave 1 MISS (206 turns, head a731d57) · wave 2 VOID (harness failure F130) · wave 3 LANDED at the 1200-iteration budget | **PASS** — wave 3 (ledger c4-wave3-1787791284792): driver verify PASS all four sections at 3fc2de9; supervisor re-run identical; perturb MISS via G4.2a.one_tier; markerSeen:false is bookkeeping (budget landed during post-green polish); F131 filed (engine undead 7.3h post-verdict); first measured tokenStats (32:1 cached:prefill); sweep 7/25 killed (record #245, 18 UI-draw survivors, thin-UI-tests class) |
| C5 — the world is big | 3fc2de9 | 0c4e6b30c2178a22 | clean MISS (10 fails, all C5-only: gentry ×3, provinces ×3, events ×3, mobility; houses/perf green, C1-C4 chain green) | counts-only cheat stub: s*.G5.1a.gentry/provinces PASS as designed, MISS (4 fails) via s*.G5.2a.events ×3 + G5.2a.mobility — the gate cannot be passed by counts | wave 1 MISS (ledger c5-wave1-1787844497777, 685 turns, 6h timeout, head 35050f9: whole C5 surface GREEN — 194-201 provinces, 24 gentry, 56-58 gentry beats/seed, mobility in all 3 seeds, perf 11.7ms/30.6 — but head not self-contained (F132: GENTRY_SURNAMES uncommitted, clean checkout dies on ImportError) and ONE chain regression G3.4a.deflection seed 3) · wave 2 dispatched (c5-wave2.txt, BASE 35050f9: commit the stranded definition + restore the Bank's deflection beat) | — |

## Calibration transcripts

### C1 (2026-08-24, BASE 2092b0c, gate f2dd97feb5db182f)

BASE run (expect clean FAIL — features absent):

```
s7.surface.ladder: FAIL game.ladder missing
s7.surface.beats: FAIL game.beats missing
s7.surface.acts: FAIL game.acts missing
s7.surface.registry: FAIL gilded.ui.registry missing
s11.surface.ladder: FAIL game.ladder missing
s11.surface.beats: FAIL game.beats missing
s11.surface.acts: FAIL game.acts missing
s11.surface.registry: FAIL gilded.ui.registry missing
GATE: MISS (8 fails)   exit 1, no traceback
```

Cheat-stub run (perturb_c1.py — constant ranks, empty-cause provenance,
signature-only beats, hollow registry; discriminators must FAIL):

```
s7/s11.G1.1c: FAIL rank order never changed across 20 turns
s7/s11.G1.3a.season|inquiry|deflection: FAIL kinds seen: ['signature']
s7/s11.G1.3c: FAIL inquire('stub')
s7/s11.G1.4a.verbs: FAIL 1 verbs
GATE: MISS (12 fails)  — stub cannot pass; gate discriminates.
```

Known accepted residual: a delta list containing only trivial self-consistent
Attributeds could satisfy G1.2; countered by G1.3c (causes>=1), the brief's
"deltas() IS the render source" contract (asserted structurally in C4), and
mutation sweep at verdict.

### C2 (2026-08-25, FINAL — re-calibrated on post-C1 BASE a418d49; the
### provisional pre-C1 run gave identical discriminators. gate 1f6b4bc6ca740b5b)

BASE run on a418d49 (full gate incl. C1 chain): identical C2 fails to the
transcript below, plus 150 PASS — the entire C1 regression chain runs green
inside the C2 gate. Stub run on a418d49: identical to the transcript below
(perturb updated to piggyback the real C1 beats facade, which chassis's
end_turn_close call now requires).

Original provisional BASE run (pre-C1 tree, `CYNCO_GATE_SKIP_C1=1`; expect clean
FAIL — features absent):

```
s7/s11/s13.surface.set_ambition: FAIL game.set_ambition missing
s7/s11/s13.surface.ambitions: FAIL game.ambitions missing
s7/s11/s13.surface.ui.house: FAIL gilded.ui.house missing
G2.2b: FAIL AttributeError("'Character' object has no attribute 'want'")
G2.2c: FAIL stances across seeds: []
G2.3.achievable: FAIL no ambition ever fulfilled: []
G2.3.failable: FAIL no ambition ever failed: []
GATE: MISS (13 fails)  exit 1, no traceback
```

Cheat-stub run (perturb_c2.py — every want "backs" with first disposition key,
banner clock frozen at "turn 1 of 10", ambitions always fulfilled; skips the C1
regression chain via `CYNCO_GATE_SKIP_C1`; discriminators must FAIL):

```
s7.G2.4b.t4: FAIL banner={'family': 'Consolidation', 'clock': 'turn 1 of 10'}
s11.G2.4b.t4: FAIL banner={'family': 'Glory', 'clock': 'turn 1 of 10'}
s13.G2.4b.t4: FAIL banner={'family': 'Buyout', 'clock': 'turn 1 of 10'}
G2.2c: FAIL stances across seeds: ['backs']
G2.3.failable: FAIL no ambition ever failed: [True, True, True]
GATE: MISS (5 fails), 180 checks PASS — stub cannot pass; gate discriminates.
```

Stub notes: real `intel.report` runs unmodified against the stubbed agenda
(tier-3 path reads `goal.why`); `gilded.provenance.Cause(label, amount, source)`.
Known accepted residuals: G2.2a cannot tell a genuinely disposition-derived want
from a want that merely name-drops a disposition key — countered by G2.2c
(stance diversity across seeds must emerge from the derivation) and mutation
sweep at verdict. G2.3.achievable/failable need both outcomes across the
3-seed grid; a degenerate coin-flip implementation could satisfy them but would
break G2.2b determinism and the honest-levers rule.

### C3 (2026-08-25, BASE 9c4b773, gate 90fa086ac43242e5)

BASE run (expect clean FAIL — features absent):

```
s7.surface.orders: FAIL game.orders missing
s7.surface.hold_seat: FAIL game.hold_seat missing
s11.surface.orders: FAIL game.orders missing
s11.surface.hold_seat: FAIL game.hold_seat missing
G3.4a: FAIL game.orders missing
GATE: MISS (5 fails)   exit 1, no traceback; 336 checks PASS (full C1+C2 chain)
```

Cheat-stub run (perturb_c3.py — orders with correct anatomy but INERT: no
lever beats, no deflection, hold_seat a no-op; Bank goal rotates so the
collision scan finds a fresh Receivership; discriminators must FAIL):

```
s7.G3.3a.Combine|Bank|Church|Gazette: FAIL 0 beats faced by [head], 0 with provenance, over 40 turns
G3.4a.deflection: FAIL seed 3: no deflection beat with face='Stub Head of the Bank', 'Receivership' and the commit clock ('of 10') in text
s11.G3.5a.Combine|Bank|Church|Gazette: FAIL seat trajectory identical to no-seat control over 20 turns
GATE: MISS (9 fails), 46 checks PASS — stub cannot pass; gate discriminates.
```

Known accepted residuals: G3.5a is the weakest assertion (plan self-review
agrees) — any real divergence satisfies it, so a hold_seat that directly
credits treasury would pass; countered by the honest-levers rule in the brief
and mutation sweep at verdict. The G3.5a.det guard (two no-seat runs must be
byte-identical) makes divergence attributable to the seat. G3.4a's seed scan
(seeds 3–18, 16 turns) requires deterministic goal selection to reach
Receivership somewhere in that window — the brief states this explicitly.
G3.4a.thwarted passed under the stub (seed-3 buyout failed naturally);
the deflection beat is the real discriminator, as designed.

#### C3 wave 1 — MISS (ledger c3-wave1-1787708879995, 388 turns, head 52c90ca)

Shape divergence, the C1-wave-1 failure class again: CynCo built real Order
machinery (gilded/orders.py, committed tests in gilded/tests/test_c3_orders.py
— F127 held, no scratch probes) but invented its own world — orders keyed
`['Church', 'Crown', 'Guilds', 'Treasury']` instead of the spec §6 table's
Combine/Bank/Church/Gazette, and no `hold_seat` at all. Probing the head
(seed 7, 1 end_turn) shows the divergence runs deeper than keys: order goals
draw from the C2 HOUSE families (`Crown: Dominion, Treasury: Buyout, Guilds:
Consolidation, Church: Intrigue`), not the spec's order-specific family
lists; `.reach` is an int (`5505`), not a set; treasuries sit at 0.0. Real
substance exists (Order class with head Characters — "Corbin Crown",
"Maren Treasury" — goal objects with commit_turns=10, tick_orders wired into
chassis.end_turn, intel order path, committed tests), so wave 2 is a
remap-plus-behaviour wave, not a rebuild — but not a rename-only either.

ContractAssertPass economics worked live: CynCo tried to self-mark the gate
assertion passed; the engine checked the repo and denied it ("Assertion 0 was
NOT marked passed — the repository contradicts it"), and CynCo kept working.
0/358 tool calls touched the grading apparatus.

CodeIndex adoption negative result: this 388-turn exploratory run was the real
test of the steering changes, and CodeIndex was called **0** times (Grep 60,
Read 108, Bash 145, total 358). C2-wave-2's single call remains the only use.

Gate hardening (sha 90fa086ac43242e5 → 9c0a6fbd4027a7c2): the original gate
crashed with `KeyError: 'Combine'` on the wave-1 head — it checked
`hasattr(g, "orders")` but then indexed by canonical names, and surface_ok's
early return on missing hold_seat hid the names-mismatch report. Fixes:
`orders_shaped()` guard before any by-name indexing (fog/levers/collision/
seats now emit clean FAILs on wrong-shape trees), and independent surface
prongs. Contract semantics unchanged — only guard/reporting paths. Rule 11
re-run in a worktree at BASE 9c4b773 (path-swapped calibration copies, only
the sys.path line differs): BASE clean MISS (6 fails — one per guarded
section, exit 1, no traceback); cheat stub MISS with the same 9
discriminators. NEW CALIBRATION LESSON: the perturb suite must include a
wrong-shape variant (orders present, wrongly keyed), not just an inert one —
that variant would have caught the KeyError before dispatch.

Wave-1 verbatim fails (hardened gate on head 52c90ca — the wave-2 contract):

```
s7.surface.hold_seat: FAIL game.hold_seat missing
s7.surface.names: FAIL orders = ['Church', 'Crown', 'Guilds', 'Treasury']
s11.surface.hold_seat: FAIL game.hold_seat missing
s11.surface.names: FAIL orders = ['Church', 'Crown', 'Guilds', 'Treasury']
s7.G3.2b: FAIL orders dict absent or wrongly keyed — fog unreadable
s7.G3.3a: FAIL orders dict absent or wrongly keyed — no lever beats to find
G3.4a: FAIL orders dict absent or wrongly keyed — no Bank to collide with
s11.G3.5a: FAIL orders dict absent/wrongly keyed or hold_seat missing — no seats to test
GATE: MISS (8 fails)   336 prior-chain checks PASS
```

#### C3 wave 2 — MISS (ledger c3-wave2-1787715373980, 440 turns, head 17646bc)

Contract inversion — logged as **F128** in docs/cynco-failure-log.md. The
brief quoted all 8 fails verbatim and numbered the divergences (1. KEYS,
2. FAMILIES, 3. ANATOMY, plus hold_seat); the run fixed none of them and the
gate fails the IDENTICAL 8 checks at its head as at its base. It instead
finished its own wave-1 plan: levers now move real deterministic quantities
(Crown +0.5 unrest on target border, Treasury collects a 100-gold tax share,
Guilds −0.5 unrest, Church +0.25 on the target capital), press beats carry
the head's face and causes, deflection beat fixed, rng stream protected via
A/B/C worktree experiments, suite 2027 passed / 0 failed. All real, all
reusable, all on a world the contract rejects. Failure signatures: committed
test_c3_contract.py in "adapted shape" (test bent to code), and a self-
imposed design constraint the contract forbids ("House treasuries are never
touched" vs G3.5a seat divergence). C1+C2 chain stayed fully green both runs.
Hygiene: 0/413 tool calls touched grading apparatus; no scratch probes;
1 untracked file (the mid-run-delivered wave-1 brief, F-rule 15).

Wave 3 (final under the 3-wave budget): rename-first brief — Cut 1 is the
literal remap (keys/families/reach/hold_seat) with surface checks as the
immediate measurement, DO-NOT list covering wave-2's landed work, and the
sealed-contract sentence: when your tests and the contract disagree, your
code moves, never the test.

### C3 wave 3 run 1: VOID — engine defect F129, not chargeable to the wave budget

Run 1 of wave 3 (BASE 17646bc, 217 tool calls, exitReason
engine_closed_the_turn, markerSeen false) delivered a 2-line window-title
rename and nothing else. Session-transcript forensics proved the cause was
the ENGINE, not the model: the 12,407-char brief arrived intact, the first
compaction (8.5 min in) garbled it, and by the third compaction the surviving
goal statement was "rename the window title". `selectVerbatimAnchors` pinned
only the last 6 user messages (all bare tool_results in an unattended
mission) and the driver's 200-char contract slice — nothing of the ask
survived verbatim. Stale scratch (`.cynco-plan.md` from June,
wave 2's `.cynco-state.md`) was injected as system context and misdirected
re-grounding. Retro-diagnosis: the SAME defect explains wave 1's invented
world (compaction turned anatomy attrs into institution names) and wave 2's
refusal to rename (compaction 1 enshrined "(Crown/Treasury/Guilds/Church)" as
the goal). All three C3 waves failed on one engine bug; the sealed gate
caught every one. Full account: docs/cynco-failure-log.md F129.

Fixes landed in localcode before re-dispatch: compressor pins the first user
message verbatim as `[Pinned original task]` through every compaction
(engine/context/compressor.ts + regression tests), and the driver purges
untracked `.cynco-plan.md`/`.cynco-state.md` at dispatch
(scripts/cynco-workspace.mjs `purgeStaleAgentState`). Ruling: the void run
does not consume the final wave; the unchanged c3-wave3.txt brief is
re-dispatched at the new BASE.

### C3 wave 3 re-run: PASS — campaign complete

Re-dispatched at BASE a866d7d with the brief amended only to clean up the
void run's debris (false wave-3 completion doc added to the git-rm list).
Both F129 fixes verified live in the driver log: the agent-state purge
removed `.cynco-plan.md` + `.cynco-state.md` before dispatch. Run: 581 turns,
5,301s, 558 tool calls (292 Bash / 164 Read / 50 Grep / 37 Edit), 0/558
touched the grading apparatus. Commit chain: 3e3c6e7 seal the contract test →
9d90035 cut1+cut2 (seat levers, wants fix, powers dossiers, registry verbs) →
57aba50 target semantics (Bank→richest, Church→player, else strongest; seat
levers spare the target) → 4c67cae marker "campaign c3 complete".

Verdict evidence: driver verify PASS (exit 0, 58.7s); hand re-run of the
sealed gate PASS — C1 chain green, C2 chain green ("G2.4c: PASS 0 C1
regressions"), C3 green ("G3.6: PASS 0 C1+C2 regressions"). Probe
`sorted(s.game.orders)` prints `['Bank', 'Church', 'Combine', 'Gazette']`,
`hold_seat` True.

F129 fix validated under load: 9 compactions in 88 minutes, each collapsing
to 12-14 messages, and the goal never drifted — the same brief, model, and
BASE that produced a 2-line title rename without the pin landed the whole
campaign with it. (Observability gap noted: injected anchors are spliced
in-memory and not logged to the session jsonl; add a log line before C4.)

Visual check (frames at C:/tmp/c3-visual/): Powers tab seed 7 t8 lists the 4
Orders fogged ("Their intentions are unknown", informant buttons per Order);
placing an informant on Combine flips its row to "informant in place /
Pursuing Purge Scabs" while the other three stay fogged. C4 requirements
harvested: Order rows carry a wrong "House " prefix; Powers table overflows
so the last two rows overlap; dossier surface (engraved head, intel-gated
goal) still model-only — C4 asserts the wiring.

Supervision economics at C3 close (scripts/supervision-economics.mjs, window
since 2026-08-24): frontier $316.96 real spend vs ~$464.00 displaced
generation (ratio 1.46, up from 1.30 pre-wave-3) + $1.24 electricity for
13.8 local hours. Frontier side still conflates engine-dev (F129) with pure
supervision; ledger still lacks local token counts (task #31).

### C4 (2026-08-26, BASE 4c67cae, gate 05ea014c667311c7)

One Living UI: the 11 broadsheet tabs dissolve into three spines (House ·
Powers · Atlas) carried by the Banknote art system — 11 pinned inks, shipped
fonts, a vermillion accent law read off rendered pixels via
`gilded.ui.probe.render_screen`. Sealed gate re-runs the full C1+C2+C3 chain
as regression (G4.6). Calibration: BASE clean-FAIL on the C4 assertions with
C1-C3 green; gate + perturb sealed at
`~/.cynco/heldout/civkings-redesign/c4/` (sha256 05ea014c667311c7).

#### C4 wave 1 — MISS (ledger c4-wave1-1787784262451, 206 turns, head a731d57)

3,430s, 208 tool calls (Bash 110 / Read 44 / Grep 27 / Edit 18 / Write 4 /
CodeIndex 1), 1 commit, exit engine_closed_the_turn, 0/208 probes on the
grading apparatus. Delivered the foundations: `palette.py`, registry
SCREENS/GLYPHS/FONTS/DATA/VERBS, widget font routing. Gate: MISS, 4 fails —
G4.1a.tabs (TABS still the 11 old tabs), G4.1a.old_tabs (broadsheet.py:76
still registers 8 dissolved tabs), s7.G4.3 + s11.G4.3
(ModuleNotFoundError: gilded.ui.probe). G4.2a glyph coverage, G4.4a verb
coverage, and the whole C1+C2+C3 regression chain PASS. CodeIndex usage:
1 of 208 calls. Mutation sweep: UNMEASURED by construction — the wave
delivered 3 source files (palette.py, registry.py, widgets.py) and zero test
files, which the sweep script names as itself the finding ("nothing was
delivered to own the change"). `mutationSweep` stays null on the row.

#### C4 wave 2 — VOID, harness failure F130 (ledger c4-wave2-1787788357499)

Not chargeable to the model (F129 precedent). 1,465s of a 12h budget, 63 tool
calls, exit `engine_error`: the SUPERVISOR's session executed `main.ts` via a
mistaken `bun -e` smoke test while the mission ran; the stray engine's
zombie-server sweep killed the mission's llama-server on port 8081, and
`callModel`'s 30s retry ladder lost to the ~3.2-minute model reload
(4× HTTP 503 "Loading model"). The run committed its adoption step first —
ad934c5 (fonts + OFL licences committed, type-scale tests adapted to font
routing, root scratch probes deleted) — and was actively triaging the TABS
front when killed. Hand re-run of the sealed gate at ad934c5: same 4 fails as
wave 1, everything else green. Ruling: ad934c5 is kept as the new BASE; the
void run does not consume a wave; remaining fronts (TABS dissolution,
`gilded.ui.probe` + ACCENTS) re-dispatch as the wave-2 re-run. The
"driver kills on first commit" hypothesis this produced was investigated and
falsified — see F130. CodeIndex usage: 1 of 63 calls. Mutation sweep:
UNMEASURED — ad934c5 changed fonts, licences and test files only, no
non-test source to mutate; the sweep script rules "do not record". Untracked
`.wt_base/` `.wt_c3/` worktree litter noted for the re-run brief.

#### C4 wave 3 — LANDED, gate PASS (ledger c4-wave3-1787791284792, 1200 turns, head 3fc2de9)

25,449s (~7.1h), stopped by the 1,200-iteration budget, exit
engine_closed_the_turn. The driver's own verify ran the sealed gate at 3fc2de9:
exit 0, all four sections green — C4 PASS plus G2.4c/G3.6/G4.6 zero
regressions across the whole C1+C2+C3 chain. The cap landed during post-green
polish (atlas war-panel full-width rect shadowing province centroids —
"All 190 pass" in the stream log ~iteration 1180), so the marker commit was
never made; markerSeen:false is bookkeeping, not a miss. Supervisor gate
re-run at 09:02: PASS, identical. Perturb cheat-stub: MISS via G4.2a.one_tier
(the hedged two-tier "city" claim); the two G4.1a TABS discriminators are moot
at a compliant tree — their mutation premise (the 11 old tabs) no longer
exists, and the claims-vs-pixels check still discriminates. Post-run defect
F131: the engine process never exited after writing the landed row — watcher
muted 7.3h until hand-killed at 09:05. Untracked scratch probes left in the
repo root (.probe_*.py, _atlasdiff.py, .base_*) despite the brief's scratch
ban — hygiene residual for the C5 brief.

1,071 tool calls, 151 errors (Bash 374 / Read 348 / Grep 220 / Edit 91 /
Write 19 / CodeIndex 4 / Glob 4 / Git 4 / ReplaceFunction 3 / ContractCreate 2
/ ContractStatus 1 / MultiEdit 1 / Ls 1). Grader probes: 2 of 1,071 flagged
(pattern "bytecode"), both plain `gilded.ui.app` boot probes — benign.
CodeIndex usage: 4 of 1,071 calls (0.4%) — adoption unchanged and dismal;
this wave ran PRE-merge of the symbol-first index (PR #104 landed mid-run),
so it is the last wave on the old retrieval. FIRST fully-measured tokenStats
row: prefill 1,600,743 / cached 51,744,186 / decode 520,129 across 1200/1200
measured turns — the cache-to-prefill ratio (32:1) is the number the
economics model has been waiting for.

Derived sweep (record #245): 7/25 killed over the ad934c5..3fc2de9 diff. All
18 survivors sit in UI rendering paths the pytest suite cannot see —
actions.py:1280/1285 spine-layout constants, atlas_view.py:414-440
glyph-tier/ACCENTS draw conditionals, broadsheet.py:868-888 panel-order
conditionals. Same thin-UI-tests residual class as C1-C3 (constants and draw
predicates with no pixel-level assertion); the C4 probe/ACCENTS gate checks
claims-vs-pixels at specific coordinates, which is why the killed 7 are the
ones that shift geometry it measures. Carried as known debt — the C5 residual
test (war-panel hit-test over every centroid) bites exactly this class.

### C5 (2026-08-27, BASE 3fc2de9, gate 0c4e6b30c2178a22)

Perf baseline measured at BASE per F89: end_turn() median over 20 turns —
seed 7: 10.2ms, seed 11: 9.8ms, seed 13: 11.1ms → cap T = 3x the 10.2ms
median-of-medians = 30.6ms. BASE calibration: GATE: MISS (10 fails), every
fail C5-only (s*.G5.1a.gentry "g.gentry missing" ×3, s*.G5.1a.provinces
50/53/58 ×3, s*.G5.2a.events ×3, G5.2a.mobility), houses + perf green and
"G5.4a: PASS 0 C1+C2+C3+C4 regressions" — the whole prior chain survives at
BASE. Perturb stub (counts without a sim: 25 fake gentry names, provinces
dict padded to 180 by re-aliasing Province objects): all count checks PASS
as designed, GATE: MISS (4 fails) via the liveness discriminators —
s7/s11/s13.G5.2a.events + G5.2a.mobility. Counts a gate would take at face
value are caught by the checks that watch the world move.

#### C5 wave 1 — MISS (ledger c5-wave1-1787844497777, 685 turns, head 35050f9)

6h wall-clock timeout (exitReason timeout), marker never committed, 4 commits
landed: atlas 144x144 grid / ~200 provinces via bounded-ring Voronoi
(claimed bit-identical to naive scan), rule-4 glyph tests re-pinned to the
tiered world, war drawer out of the map field (C4 residual: rule-6
all-centroid click + war verbs reachable, test_c5_residuals committed),
test_c5_contract committed verbatim, gentry on a dedicated rng stream
(seed ^ 0x5C5) to keep the pre-C5 sim bit-identical.

The verdict has two defects and one triumph. Triumph: the ENTIRE C5 surface
is green at the delivered state — s7/s11/s13 G5.1a 194/195/201 provinces +
24 gentry each, G5.2a 56/56/58 share/board/marriage beats over 60 turns,
mobility (falls + rise/fall beats) in ALL THREE seeds (gate needs one),
G5.3a end_turn median 11.7ms against the 30.6 cap at full scale. Defect 1
(F132): the head does not stand alone — chassis.py (committed) imports
GENTRY_SURNAMES from world.py where it exists only as an uncommitted
working-tree edit; a clean checkout of 35050f9 dies on ImportError. Both the
driver verify and the supervisor hand re-run graded tree-state; the stash +
boot probe caught it. Driver fixed same-day: verify now quarantines tracked
changes (preserve to patch → reset → grade the commit) and records
verify.dirtyAtVerify. Defect 2: sealed gate MISS (3 fails), root is exactly
one chain regression — G3.4a.deflection seed 3: the Buyout-vs-Receivership
collision still THWARTS (G3.4a.thwarted passes) but no deflection beat with
face='Maren Bank', 'Receivership' and the 'of 10' clock appears: the world
pushes back silently at the new scale, which is the Clarity Law violation C3
exists to forbid. G4.6/G5.4a fails are the cascade of that one check.

618 tool calls, 79 errors (Bash 236 / Read 174 / Grep 129 / Edit 35 /
Write 21 / CodeIndex 14 / Glob 4 / MultiEdit 3 / Ls 1 / Git 1). Grader
probes: 0/618. CodeIndex: 14/618 (2.3%) — first wave on the symbol-first
index (PR #104), up 6x from wave C4w3's 0.4% but still marginal; #39
(crawl-tool restriction) stays open, decide on wave-2 data. tokenStats:
prefill 904,330 / cached 22,603,979 / decode 416,003 over 685/685 measured
turns (25:1 cached:prefill). Wave 2 dispatched from BASE 35050f9
(c5-wave2.txt): commit the stranded definition, restore the Bank's
deflection beat, committed reproduction test, marker.
