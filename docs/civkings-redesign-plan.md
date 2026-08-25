# CivKings Redesign Implementation Plan — Five Campaigns

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the CivKings simulation into a game per `docs/civkings-redesign-spec.md`, via five long-horizon CynCo campaigns, each with a self-authored success contract encoded 1:1 in a sealed, calibrated gate.

**Architecture:** LocalCode dispatches CynCo against `C:\Users\civer\civkings` (CynCo-only scope: we never hand-edit the game). Each campaign = one destination-sized mission brief + one sealed gate. The gate is the only checkpoint; between dispatch and gate verdict there are **no user round-trips**. Each brief publishes the contract (required API surface + assertions) so the gate can be written *before* the features exist.

**Tech Stack:** `scripts/dispatch-mission.sh` → `bun engine/main.ts` + `scripts/cynco-mission-driver.mjs`; gates are Python probes in `~/.cynco/heldout/civkings-redesign/`; ledger `benchmark/cynco-ledger/missions.NNNN.jsonl`; game probed headless via `SDL_VIDEODRIVER=dummy` + `gilded.ui.app.new_app_state(seed=N)`.

---

## Operating model (applies to every campaign)

1. **Contract first.** I author "success looks like" as numbered assertions (`G<c>.<n>`), each a runnable command. The brief quotes the contract verbatim; the sealed gate implements it 1:1 plus **undisclosed seeds** (brief tests seed 7 publicly; gate also runs seed 11).
2. **Calibrate before dispatch** (Rule 11): run the gate on the pinned BASE (must FAIL cleanly — every check prints `FAIL`, zero crashes/false-passes) and on a **cheat-stub perturbation** (trivial fake implementations — the discriminating sub-checks must still FAIL). Record both outputs in the campaign log before dispatching.
3. **Dispatch long:** `LOCALCODE_MAX_ITERATIONS=2400`, timeout 43200 s (12 h), gate as check-cmd.
4. **Wave policy (autonomous):** if the gate MISSes, write a cut brief quoting the gate's FAIL lines **verbatim** (F89), commit it, redispatch. Max 2 cuts (3 waves total) per campaign. After 3 MISSes: failure-log entry (F-format) + stop and present the verdict — that is the only user touchpoint besides playing the build.
5. **Verdict:** ledger row must show `outcome==="landed" && verified===true`; append campaign entry to `docs/cynco-failure-log.md` only on failure; record gate SHA256 in the campaign log either way. Run the composite regression gate (all prior campaigns) after each campaign lands.
6. **CynCo betterment is in-scope:** every stall/failure gets a root-cause + harness improvement logged (F-format), not a smaller slice.

**Campaign order & dependencies:** C1 (visible sim) → C2 (stake; needs C1 beats+ladder) → C3 (Orders; needs C2 agenda surface) → C4 (one UI; needs C1–C3 content) → C5 (scale; regression over all).

---

### Task 0: Scaffolding

**Files:**
- Create: `~/.cynco/heldout/civkings-redesign/` (gate home, outside the repo — sealed)
- Create: `docs/civkings-redesign-briefs/` (tracked briefs; brief-authoring rule: commit after each cut)
- Create: `docs/civkings-redesign-briefs/campaign-log.md` (per-campaign: BASE commit, gate sha256, calibration outputs, wave history, verdict)

- [ ] **Step 0.1: Create directories and log skeleton**

```bash
mkdir -p ~/.cynco/heldout/civkings-redesign/{c1,c2,c3,c4,c5}
mkdir -p /c/Users/civer/localcode/docs/civkings-redesign-briefs
```

`campaign-log.md` starts as:

```markdown
# CivKings Redesign — Campaign Log
| campaign | BASE commit | gate sha256 | calib BASE | calib STUB | waves | verdict |
|---|---|---|---|---|---|---|
```

- [ ] **Step 0.2: Pin BASE**

```bash
cd /c/Users/civer/civkings && git rev-parse --short HEAD
```

Record as `BASE_C1` in campaign-log.md. Re-pin at the start of every campaign (CynCo will have moved HEAD).

- [ ] **Step 0.3: Commit scaffolding** (branch + PR per web flow)

```bash
cd /c/Users/civer/localcode && git checkout -b civkings-campaigns && git add docs/civkings-redesign-briefs && git commit -m "campaigns: scaffolding + campaign log"
```

---

### Task 1: Campaign C1 — "The sim becomes visible" (ladder + consequence beats + provenance)

**Spec sections:** §3.1 ladder, §8 beats, seeds §1 registries.
**Files:**
- Create: `~/.cynco/heldout/civkings-redesign/c1/gate_c1.py` (sealed)
- Create: `~/.cynco/heldout/civkings-redesign/c1/perturb_c1.py`
- Create: `docs/civkings-redesign-briefs/c1-wave1.txt`

**Success contract (the brief quotes this verbatim):**

Required API surface (CynCo builds it; the gate consumes it):
- `game.ladder.standings() -> list[(house:str, rank:int, axes:dict[str,float])]` — all houses, ranks a total order 1..N, from the four `endings.py` axes.
- `game.beats.log -> list[Beat]`, `Beat` has `.kind` ∈ {"signature","season","inquiry","deflection"}, `.turn:int`, `.text:str`, `.face:str|None`, `.provenance:Attributed|None`.
- `game.beats.deltas(turn) -> list[(label:str, att:Attributed)]` — **every** player-visible numeric delta for that turn.
- `game.beats.inquire(label, turn) -> Attributed` — the "why?" chain.
- `gilded.ui.registry.DATA: dict[datum_id -> screen_id]` and `gilded.ui.registry.VERBS: dict[verb_id -> {"what":str,"why_now":str,"serves":str}]` — seeded for everything C1 adds.

| id | assertion (seed 7 public; gate adds seed 11) |
|---|---|
| G1.1a | after each of 20 `end_turn()`: `standings()` covers exactly `game.houses` |
| G1.1b | ranks each turn are exactly `1..N` (total order, no ties unbroken) |
| G1.1c | the rank ordering changes at least once across the 20 turns |
| G1.2a | for every turn, every delta in `beats.deltas(t)` has `att.check(1e-6) == True` |
| G1.2b | count of player-visible deltas lacking an `Attributed` == 0 (contract: `deltas()` IS the display source — Ledger/Gazette render from it) |
| G1.3a | ≥1 beat of each of the 4 kinds over the run; the signature beat is provoked by the gate performing one honest player act (set an enterprise dial) |
| G1.3b | every `deflection` beat has non-empty `.face` and `.text` naming the thwarted act |
| G1.3c | `inquire(label, t)` on a gate-chosen delta returns an `Attributed` with ≥1 `Cause` and `.check(1e-6)` |
| G1.4a | every `VERBS` entry has all three fields non-empty; every `DATA` datum maps to exactly one screen |

- [ ] **Step 1.1: Measure base + write gate**

Measure first (F89: print `base:` beside every numeric requirement):

```bash
cd /c/Users/civer/civkings && SDL_VIDEODRIVER=dummy python - <<'EOF'
from gilded.ui.app import new_app_state
s = new_app_state(seed=7); g = s.game
print("base: houses", len(list(g.houses)), "| has ladder:", hasattr(g,"ladder"), "| has beats:", hasattr(g,"beats"))
EOF
```

Expected base: `has ladder: False | has beats: False`. Gate (complete file):

```python
# gate_c1.py — sealed. Contract C1: the sim becomes visible.
import os, sys, hashlib
os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
sys.path.insert(0, r"C:\Users\civer\civkings")
FAILS = []
def check(name, cond, detail=""):
    print(f"{name}: {'PASS' if cond else 'FAIL'} {detail}")
    if not cond: FAILS.append(name)

def run(seed):
    from gilded.ui.app import new_app_state
    s = new_app_state(seed=seed); g = s.game
    try:
        lad0 = g.ladder.standings()
    except Exception as e:
        check(f"s{seed}.G1.1", False, f"no ladder surface: {e!r}"); return
    orders, kinds = [], set()
    # one honest player act -> must produce a signature beat
    try:
        ent = next(iter(g.enterprises.values())) if hasattr(g.enterprises, "values") else g.enterprises[0]
        g.beats_probe_act = True
        ent_dial_before = getattr(ent, "dial", None)
        from gilded.society.labor import clamp_dial
        ent.dial = clamp_dial(75.0)  # via honest surface if brief defines one; contract: any player act suffices
    except Exception as e:
        check(f"s{seed}.G1.3sig-setup", False, repr(e))
    for t in range(20):
        g.end_turn()
        lad = g.ladder.standings()
        names = sorted(h for h, r, ax in lad)
        ranks = sorted(r for h, r, ax in lad)
        check(f"s{seed}.G1.1a.t{t}", names == sorted(g.houses), f"{names}")
        check(f"s{seed}.G1.1b.t{t}", ranks == list(range(1, len(names) + 1)), f"{ranks}")
        orders.append(tuple(sorted((h, r) for h, r, ax in lad)))
        ds = g.beats.deltas(g.turn)
        bad = [lbl for lbl, att in ds if att is None or not att.check(1e-6)]
        check(f"s{seed}.G1.2.t{t}", not bad, f"unproven deltas: {bad[:5]}")
    check(f"s{seed}.G1.1c", len(set(orders)) > 1, "rank order never changed in 20 turns")
    for b in g.beats.log:
        kinds.add(b.kind)
        if b.kind == "deflection":
            check(f"s{seed}.G1.3b", bool(b.face) and bool(b.text), f"face={b.face!r}")
    for k in ("signature", "season", "inquiry", "deflection"):
        check(f"s{seed}.G1.3a.{k}", k in kinds, f"kinds seen: {sorted(kinds)}")
    ds = g.beats.deltas(g.turn) or g.beats.deltas(g.turn - 1)
    if ds:
        lbl, _ = ds[0]
        att = g.beats.inquire(lbl, g.turn if g.beats.deltas(g.turn) else g.turn - 1)
        check(f"s{seed}.G1.3c", att is not None and len(att.causes) >= 1 and att.check(1e-6), lbl)
    from gilded.ui import registry
    check(f"s{seed}.G1.4a.verbs", all(v.get("what") and v.get("why_now") and v.get("serves")
                                      for v in registry.VERBS.values()) and registry.VERBS, f"{len(registry.VERBS)} verbs")
    check(f"s{seed}.G1.4a.data", len(registry.DATA) == len(set(registry.DATA.keys())) and registry.DATA,
          f"{len(registry.DATA)} data")

for seed in (7, 11):
    try: run(seed)
    except Exception as e: check(f"s{seed}.harness", False, repr(e))
print("GATE:", "PASS" if not FAILS else f"MISS ({len(FAILS)} fails)")
sys.exit(0 if not FAILS else 1)
```

- [ ] **Step 1.2: Calibrate — BASE must FAIL cleanly**

```bash
python ~/.cynco/heldout/civkings-redesign/c1/gate_c1.py
```

Expected: `s7.G1.1: FAIL no ladder surface: ...`, `GATE: MISS`, exit 1, **no traceback**. Paste output into campaign-log.md.

- [ ] **Step 1.3: Calibrate — cheat stub must still FAIL the discriminators**

`perturb_c1.py` (complete): installs trivial fakes, then runs the gate in-process:

```python
# perturb_c1.py — cheat stubs: constant ranks, empty-cause provenance, no deflection.
import os, sys, types
os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
sys.path.insert(0, r"C:\Users\civer\civkings")
from gilded.ui import app as APP
from gilded.provenance import Attributed
_real = APP.new_app_state
def new_app_state(seed):
    s = _real(seed=seed); g = s.game
    houses = sorted(g.houses)
    g.ladder = types.SimpleNamespace(standings=lambda: [(h, i + 1, {}) for i, h in enumerate(houses)])
    beat = types.SimpleNamespace(kind="signature", turn=1, text="x", face=None, provenance=None)
    g.beats = types.SimpleNamespace(log=[beat],
        deltas=lambda t: [("stub", Attributed(value=1.0, previous=1.0, causes=[]))],
        inquire=lambda lbl, t: Attributed(value=1.0, previous=1.0, causes=[]))
    return s
APP.new_app_state = new_app_state
sys.argv = ["gate"]
exec(open(os.path.expanduser("~/.cynco/heldout/civkings-redesign/c1/gate_c1.py")).read())
```

```bash
python ~/.cynco/heldout/civkings-redesign/c1/perturb_c1.py
```

Expected FAILs (the discriminators): `G1.1c` (constant ranks), `G1.3a.season/inquiry/deflection` (missing kinds), `G1.3c` (zero causes). If any of those PASS, tighten the gate before dispatch. Record output + `sha256sum gate_c1.py` in campaign-log.md.

- [ ] **Step 1.4: Write brief + commit**

`docs/civkings-redesign-briefs/c1-wave1.txt` — structure (real text, base values inline):

```text
MISSION C1 — THE SIM BECOMES VISIBLE (long-horizon; run until the gate passes)
Repo: C:\Users\civer\civkings   BASE: <BASE_C1>   base: has ladder: False | has beats: False
Read docs/civkings-redesign-spec.md sections 3.1 and 8 in the LocalCode repo copy provided below. [paste §3.1+§8 verbatim]
DESTINATION: a player watching seed 7 can see who is winning and why anything changed.
CONTRACT (the sealed gate asserts exactly this, plus an undisclosed seed):
  [paste the G1.* table verbatim, including required API surface]
RULES: honest levers only; provenance .check() must hold; ship tests for every new module;
  wire-check: every new symbol imported and called (grep proof in your final commit message).
DONE WHEN: all G1.* hold on seed 7 via the probe commands above, then commit with marker:
  "campaign c1 complete"
```

```bash
cd /c/Users/civer/localcode && git add docs/civkings-redesign-briefs/ && git commit -m "c1: contract, calibration record, wave1 brief"
```

- [ ] **Step 1.5: Dispatch**

```bash
cd /c/Users/civer/localcode && LOCALCODE_MAX_ITERATIONS=2400 scripts/dispatch-mission.sh \
  docs/civkings-redesign-briefs/c1-wave1.txt "campaign c1 complete" 'C:\Users\civer\civkings' 43200 \
  "python C:/Users/civer/.cynco/heldout/civkings-redesign/c1/gate_c1.py"
```

Run with `run_in_background`; 15+ min patience rule applies; no user check-ins.

- [ ] **Step 1.6: Wave loop (autonomous, max 3 waves)**

On MISS: `c1-wave2.txt` = wave1 brief + a `GATE SAID:` section quoting the FAIL lines verbatim + `base:` re-measured on the new HEAD. Commit, redispatch (same command, new brief). After wave 3 MISS: F-entry in `docs/cynco-failure-log.md` (F-format: Date/Context/How it failed/Why/Harness improvement) and stop for user verdict.

- [ ] **Step 1.7: Verdict + record**

```bash
tail -1 benchmark/cynco-ledger/missions.0002.jsonl | python -c "import json,sys; r=json.load(sys.stdin); print(r['missionId'], r['outcome'], r['verified'])"
```

Expected: `... landed True`. Fill campaign-log.md row; push branch + PR + merge (web flow); verify the game visually — render Powers frames at seed 7 and confirm the ladder and a Gazette beat are on screen (party-visibility rule: gameplay evidence, not just check-cmds).

---

### Task 2: Campaign C2 — "The player has a stake" (ambitions + wants + Court in Session)

**Spec sections:** §3.2, §4. **BASE:** re-pin after C1 merge.
**Files:** Create `~/.cynco/heldout/civkings-redesign/c2/gate_c2.py`, `perturb_c2.py`, `docs/civkings-redesign-briefs/c2-wave1.txt`.

**Success contract:**

Required surface: `game.set_ambition(house, family, target)` valid for the 7 `agenda.py` families; wants via `realm.characters[i].want -> {"text":str, "disposition":str, "stance":str}` with stance ∈ {"backs","wary","opposes"}; House screen render surface `gilded.ui.house.court_cards(game, house) -> list[card]` where card has `traits:list[str]`, `stance:str`, `want_text:str`; ambition banner surface `gilded.ui.house.banner(game, house) -> {"family":str,"target":str,"clock":"turn X of 10"}`.

| id | assertion |
|---|---|
| G2.1a | `set_ambition(player, "Buyout", <real rival>)` → `game.agendas[player]` holds a Goal with `commit_turns == 10` |
| G2.1b | a rival with tier-3 intel on the player reports `"Pursuing Buyout"` through the existing `intel.report()` path (fog symmetry) |
| G2.2a | every adult member of the player realm has a `want` whose `disposition` key exists in their dispositions dict |
| G2.2b | deterministic: two fresh `new_app_state(seed=7)` runs yield identical wants/stances |
| G2.2c | non-degenerate: across seeds 7, 11, 13 all three stances occur at least once |
| G2.3a | forcing ambition completion moves the matching ladder axis by Δ>0, and `beats.deltas` carries an `Attributed` whose causes include a Cause labelled with the ambition |
| G2.4a | `court_cards` returns one card per adult; every card's `traits` match the character's generated traits; stance badge == computed stance |
| G2.4b | `banner` clock string matches `turn X of 10` with X = turns since `set_ambition` |
| G2.4c | C1 composite gate still passes (regression) |

- [ ] **Step 2.1:** Measure base (`hasattr(g,'set_ambition')` expected False; `realm.characters[0].want` expected AttributeError) and write `gate_c2.py` following the `check()/run(seed)` pattern of `gate_c1.py`, implementing exactly the table above; chain C1: `exec(open(...c1/gate_c1.py...))` guarded to aggregate FAILS.
- [ ] **Step 2.2:** Calibrate: BASE run → all G2.* FAIL cleanly, exit 1, no traceback. Stub run (`perturb_c2.py`: wants all `"backs"` with first disposition key; banner constant `"turn 1 of 10"`) → G2.2c and G2.4b must FAIL. Record outputs + sha256 in campaign-log.md.
- [ ] **Step 2.3:** Brief `c2-wave1.txt` (same skeleton as 1.4: paste §3.2+§4 verbatim, contract table verbatim, `base:` lines, marker `"campaign c2 complete"`). Commit.
- [ ] **Step 2.4:** Dispatch (same command shape as 1.5, check-cmd `gate_c2.py`). Wave loop per 1.6. Verdict per 1.7 + visual check: render the House screen, confirm ambition banner + stance badges on real portraits.

---

### Task 3: Campaign C3 — "The world pushes back" (the Four Orders)

**Spec section:** §6. **BASE:** re-pin after C2.
**Files:** Create `~/.cynco/heldout/civkings-redesign/c3/gate_c3.py`, `perturb_c3.py`, `docs/civkings-redesign-briefs/c3-wave1.txt`.

**Success contract:**

Required surface: `game.orders -> dict[name -> Order]` for exactly {"Combine","Bank","Church","Gazette"}; Order has `.treasury:float`, `.reach:set`, `.head` (a Character with the full 30-key dispositions), `.goal` (agenda.py `Goal` shape, `family` from that order's family list per spec §6 table); `intel.report()` accepts an order name; `game.hold_seat(house, order_name)`; deflections surface through the C1 `beats` API with `.face` = the order's head name and `.text` naming the crossed goal.

| id | assertion |
|---|---|
| G3.1a | 4 orders exist with treasury ≥ 0, non-empty reach, head with exactly the 30 disposition keys |
| G3.2a | each order's `goal.family` is drawn from its own family list (spec §6 table) with `commit_turns == 10` |
| G3.2b | `intel.report(game, viewer, "Combine")` at tier 0 yields the unknown-intentions string; with an informant placed it yields `"Pursuing <family>"` |
| G3.3a | over 40 turns (seed 7) each order performs ≥1 lever action recorded in `beats.log` with provenance |
| G3.4a | scripted collision (player Buyout of X while Bank goal is Receivership of X) → the takeover is thwarted AND a deflection beat exists with `.face` == Bank head's name and `.text` containing `"Receivership"` and the commit turn |
| G3.5a | `hold_seat` for each order changes a measured quantity vs. a no-seat control run of the same seed (assert the two runs diverge on the order's domain metric; Δ≠0) |
| G3.6 | C1+C2 composite still passes |

- [ ] **Step 3.1:** Measure base (`hasattr(g,'orders')` False) and write `gate_c3.py` per the table (same pattern; the collision scenario is constructed via `set_ambition` from C2 + forcing the Bank goal through the order's own honest surface, which the contract requires to be settable in tests via seedable determinism, not a debug hook).
- [ ] **Step 3.2:** Calibrate: BASE → clean FAILs. Stub (`perturb_c3.py`: orders present but inert — no lever actions, no deflection) → G3.3a and G3.4a must FAIL. Record.
- [ ] **Step 3.3:** Brief `c3-wave1.txt` (paste §6 verbatim incl. the Orders table; marker `"campaign c3 complete"`). Commit.
- [ ] **Step 3.4:** Dispatch / wave loop / verdict + visual: Powers screen shows 4 Order dossiers with heads and fog-gated goals.

---

### Task 4: Campaign C4 — "One living UI" (Banknote chassis + Atlas + consolidation + Clarity Law)

**Spec sections:** §1, §2, §5, §7, §9. **BASE:** re-pin after C3.
**Files:** Create `~/.cynco/heldout/civkings-redesign/c4/gate_c4.py`, `perturb_c4.py`, `docs/civkings-redesign-briefs/c4-wave1.txt`.

**Success contract:**

Required surface: `gilded.ui.registry.SCREENS == ["House","Powers","Atlas"]`; `registry.DATA` covers every rendered datum (contract: render code may only draw data through the registry); `registry.GLYPHS: dict[mechanic -> {"tier": "continent"|"region"|"parish"}]` for at least {city, regiment, battle, strike, train, ship, informant}; `registry.ACCENTS(screen) -> {"vermillion":int,"gold_nonplayer":int}`; palette constants module exporting the 11 Banknote inks + reserved river `#6f93ad`; fonts `BodoniModa*.ttf`, `EBGaramond*.ttf` in repo assets and referenced by the UI font loader.

| id | assertion |
|---|---|
| G4.1a | `SCREENS` is exactly the 3 spines; grep gate: no tab registration for Docket/Briefing/War-as-tab remains (`rg -n "Docket|Briefing" gilded/ui/` returns no tab-registry hits) |
| G4.2a | every glyph class has exactly one full-draw tier; no province fill color equals `#6f93ad` |
| G4.3a | for rendered frames at seeds 7 and 11, `ACCENTS(screen)["vermillion"] <= 5` and `gold_nonplayer == 0` for every screen |
| G4.4a | every datum in `DATA` has exactly one owner screen; every verb in `VERBS` has non-empty what/why_now/serves (now covering ALL verbs, not just new ones) |
| G4.5a | both font families present as TTF and loaded by the font loader (headless probe: loader returns them, no fallback) |
| G4.6 | C1+C2+C3 composite still passes; ladder/beats/court/orders all render inside the 3 spines (frame text probes find ladder strip on Powers, ambition banner on House, desk strip on Atlas) |

- [ ] **Step 4.1:** Measure base (current tab list; current palette constants) and write `gate_c4.py` per the table (registry + grep + frame-text probes; frame probes render headless via the existing dummy-driver screenshot path used in the diagnosis session).
- [ ] **Step 4.2:** Calibrate: BASE → clean FAILs (SCREENS missing). Stub (`perturb_c4.py`: registry claims 3 screens but old tabs still registered; one glyph in two tiers) → G4.1a and G4.2a must FAIL. Record.
- [ ] **Step 4.3:** Brief `c4-wave1.txt` (paste §1, §2 table, §7, §9 verbatim — the Clarity Law is the headline; marker `"campaign c4 complete"`). Commit.
- [ ] **Step 4.4:** Dispatch / wave loop / verdict + **user visual review**: this is the campaign where the user cold-opens the build and tries to guess every control (the Clarity Law's human test — the one gate a script can't fully seal).

---

### Task 5: Campaign C5 — "The world is big" (tiered scale)

**Spec section:** §10. **BASE:** re-pin after C4.
**Files:** Create `~/.cynco/heldout/civkings-redesign/c5/gate_c5.py`, `perturb_c5.py`, `docs/civkings-redesign-briefs/c5-wave1.txt`.

**Success contract:**

| id | assertion |
|---|---|
| G5.1a | for seeds 7, 11, 13: great houses ∈ [6,8], minor gentry ∈ [20,30], provinces ∈ [150,250] (base: 7 houses / 50 provinces / 20 characters) |
| G5.2a | gentry run light sim: over 60 turns ≥1 gentry share/board/marriage event in `beats.log` per seed; in ≥1 of 3 seeds a gentry rises to great or falls out |
| G5.3a | performance: `end_turn()` wall time at full scale ≤ T where T = 3× the C4-scale median measured in Step 5.1 (threshold set from measurement per F89 — never invented) |
| G5.4a | full composite: C1–C4 gates pass unchanged at the new scale on all 3 seeds |

- [ ] **Step 5.1:** Measure base end_turn median at C4 scale (`python -m timeit`-style probe, 20 turns, record ms) and write `gate_c5.py` + `perturb_c5.py` (stub: counts in range but zero gentry events → G5.2a must FAIL).
- [ ] **Step 5.2:** Calibrate BASE + stub; record.
- [ ] **Step 5.3:** Brief `c5-wave1.txt` (paste §10 verbatim; marker `"campaign c5 complete"`). Commit.
- [ ] **Step 5.4:** Dispatch / wave loop / verdict.

---

### Task 6: Close-out

- [ ] **Step 6.1:** Final composite gate run (all 5 files, seeds 7/11/13) — paste summary into campaign-log.md.
- [ ] **Step 6.2:** Update memory (`project_civkings_winnable.md` / redesign memory) with shipped state; failure-log entries for anything OPEN.
- [ ] **Step 6.3:** Push branch, PR, merge (web flow). User plays the build — the real gate.

---

## Self-review notes

- **Spec coverage:** §0 diagnosis (no task — context only), §1→C1 seed + C4 full, §2→C4, §3→C1+C2, §4→C2, §5→C1+C3+C4, §6→C3, §7→C4, §8→C1(+C3 deflection), §9→C4, §10→C5, §11 ordering → campaign order. Covered.
- **Known judgment call:** gates for not-yet-existing features FAIL (not PASS) on BASE — calibration therefore checks *clean failure* + *stub discrimination* rather than base-pass. This inverts the F89 base-pass rule deliberately; recorded here so nobody "fixes" it.
- **C3 G3.5a divergence check** is the weakest assertion (Δ≠0 could be noise); the gate must compare seeded deterministic runs so any divergence is attributable to the seat. Determinism is already a repo norm (market clearing is deterministic).
