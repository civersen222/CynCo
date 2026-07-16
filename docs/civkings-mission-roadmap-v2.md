# CivKings Mission Roadmap v2 — Implementation Plan (2026-07-16)

> **For agentic workers:** This plan is executed via the CynCo mission-brief workflow, NOT by
> direct code edits. Each task's deliverable is an authored Appendix-B brief at
> `C:/tmp/cynco-missionNN-brief.txt`; CynCo executes it; the planner verifies. The planning
> assistant NEVER edits CivKings game source. Checkbox (`- [ ]`) syntax tracks missions.

**Goal:** Implement `civkings-character-society-spec.md` (character/dynasty/political-economy/
intrigue/events) on top of the `civkings-deep-systems-spec.md` economy foundation, turning
CivKings into the full dynasty-capitalism game.

**Architecture:** Evolve the existing substrate, don't rewrite. The live character stack
(simulation.py `Character`/`Dynasty`, realms.py, character_ai.py, relationships.py,
marriages.py, court.py, plots.py — all wired via game.py:820-830 except PlotManager) is
extended mission-by-mission: 4 stats → 6 attributes, binary traits → drifting spectrums,
scalar wealth → shares, medieval court → industrial org chart. New systems (event engine,
political economy, schemes) land as new modules wired into `process_turn`.

**Tech stack:** Existing Python/pygame codebase; data-driven content (template pools, chains,
tech tree) as Python data modules; CynCo (local Qwen) executes all code changes from briefs.

**This document supersedes Part 7 (mission sequence) of `civkings-deep-systems-spec.md`.**
Old M34-M47 (Waves C/D) are cancelled and replaced below. M18-M33 (Waves A/B) survive.

---

## Ground truth (verified 2026-07-16)

Key wiring facts every brief must respect (refresh line numbers at authoring time):

- `Character` simulation.py:50-145 — fields: id, name, base_stats{diplomacy,martial,
  stewardship,intrigue}, traits, parent_ids, children_ids, is_alive, gold_reserve, age,
  gender, stress(0-300), age_progress, lifestyle. Methods incl. age_up, get_effective_stat,
  add_stress, get_stress_level.
- `Dynasty` simulation.py:147-191; `generate_child` simulation.py:202-230 (stat blend +
  30% trait inheritance); succession laws + `execute_succession` simulation.py:265-383.
- `Realm` realms.py:14-21 (civ_name, ruler, dynasty, court, characters) — every civ has one.
- `Court` court.py:18-93 — MARSHAL/SPYMASTER/CHANCELLOR/STEWARD/CHAPLAIN, appoint/get_bonus.
- Wired ticks: game.py:820 `tick_realms`, :825 `tick_relationships`, :830 `tick_marriages`.
- Orphaned: `PlotManager.process_plots/process_spies` (plots.py:106,133) — only called from
  dead `game_manager.py`. Plots actually advance via relationships.py:162-215.
- Character→economy wire: tax_system.py:127-128 stewardship multiplier (game.py:637-639).
- CK events: `CKEvent` game.py:83-119; `pending_ck_event` set game.py:839, consumed
  pygame_app/screens/game_screen.py:323-326; log = `state.turn_events` (game.py:74).
- Cities have scalar `population` only (city.py:38-58). No named pops.
- `process_turn` order: game.py:486+ (aging/succession 496-530 → AI 538 → happiness →
  events 569 → era 577 → eurekas → gold/tax 625-640 → trade → production/research →
  character ticks 820-830).
- File sizes: game.py 1703, simulation.py 524, city.py 578, relationships.py 231.

---

## Execution protocol (every mission)

Standard loop — steps for each `M-NN` below:

1. **Author brief** (planner): read the exact current code for every anchor; write
   `C:/tmp/cynco-missionNN-brief.txt` in Appendix-B form — WHY (symptom/root-cause/file:line),
   FILES YOU MAY EDIT (explicit list + do-not-touch list), per-edit ENTIRE verbatim OLD→NEW
   blocks with grep-verified unique anchors, VERIFICATION (ast.parse all edited files +
   `python -m pytest -q` no-new-failures + a smoke script printing OK), exact commit message.
2. **Dispatch** to CynCo (user runs the mission).
3. **Verify** (planner): re-run the smoke, run `python -m pytest -q`, spot-read the diff.
4. **Mark the mission checkbox** and update this doc if scope shifted.

Brief-sizing rule: one brief ≤ ~4 files and ≤ ~6 verbatim edit blocks. If a mission below
exceeds that at authoring time, split it into `Ma/Mb` parts (as M18/M18b did).

Testing rule: every mission's smoke script constructs a real `Game` headlessly (pattern:
`C:/tmp/civ_probe.py`), drives the new system through public APIs, and asserts observable
state — no mocks, no stdout-parsing.

---

## File structure (target)

New modules (each one responsibility, kept small):

| File | Responsibility |
|---|---|
| `dispositions.py` | Spectrum definitions (3 families, ~30 pairs), threshold→label logic, drift application |
| `population.py` | Tier-0 bulk simulation (aging/mortality/births for all characters), relevance set, promotion |
| `shares.py` | Enterprise + shareholding data model, dividends, transfer/dower/raid operations |
| `event_engine.py` | Situation→template-pool renderer, choice generation |
| `event_content/` (pkg) | Template pools + signature chains (pure data modules, many small files) |
| `labor.py` | Extraction dial effects, accidents, unrest crystallization, movements + leaders |
| `ideology.py` | Global tide tracker, legitimacy meter, revolution + transformation |
| `schemes.py` | Scheme framework (evolves plots.py concepts): expose/blackmail/sabotage/sway/takeover/assassination |

Modified throughout: simulation.py (Character/Dynasty/succession), court.py, marriages.py,
relationships.py, character_ai.py, realms.py, game.py (process_turn wiring), city.py
(Director hooks), tax_system.py (dividends), game_data.py (setting/tech), pygame_app/** (UI).

---

## Wave A — Economy foundation (M18-M28) — SURVIVES UNCHANGED

Per deep-systems spec Part 0-1. Prerequisite for everything: the extraction dial (Wave PE)
modifies yields that must first exist.

- [ ] **M18** Victory gating (brief ALREADY AUTHORED at C:/tmp/cynco-mission18-brief.txt) — dispatch + verify
- [ ] **M18b** Scaled clock: `pace`/`turn_budget`/`min_victory_turn` on GameState; replace M18's literal 60
- [ ] **M19** Tile terrain/feature/resource yields actually read
- [ ] **M20** Yield pipeline (base→flat→multipliers→government→golden-age→speed)
- [ ] **M21** Citizen assignment + culture border growth
- [ ] **M22** Growth curve + housing
- [ ] **M23** Settler cost escalation + pop consumption
- [ ] **M24** Empire happiness (per-city penalty)
- [ ] **M25** Distance-scaled maintenance
- [ ] **M26** Tall/wide tech-cost scaling
- [ ] **M27** Buildings table (flat + multiplicative %)
- [ ] **M28** Production curve + overflow

## Wave CC — Character core (M34-M40)

- [ ] **M34 Six attributes.** Migrate `Character.base_stats` from
  {diplomacy,martial,stewardship,intrigue} → {statecraft,command,industry,intrigue,science,
  resolve} with a compat mapping (diplomacy→statecraft, martial→command, stewardship→industry;
  science/resolve seeded from traits+jitter). Update every reader: court.py stat mapping,
  tax_system.py:127 (stewardship→industry), game_data.py:669 starting_stats 4-tuples,
  simulation.py generate_child/elective succession, character_ai/relationships stat refs.
  *Files:* simulation.py, court.py, tax_system.py, game_data.py (+game.py refs). Likely
  splits into M34a (model+compat property) / M34b (callers). *Smoke:* new Game; every living
  character has 6 attrs; tax bonus still applies; elective succession still picks.
- [ ] **M35 Disposition spectrums.** New `dispositions.py`: PAIRS table (15 Temperament,
  9 Conviction, 6 Bloodline pairs per character-society spec §3.3), −100..+100 values,
  labels at ±50/±80. `Character.dispositions` dict initialized on creation (random-normal,
  Bloodline from parents later); `Character.traits` becomes a derived-label property (compat
  for all existing trait readers). *Files:* dispositions.py (new), simulation.py. *Smoke:*
  value 60 on cruel_compassionate yields "Compassionate"; −85 yields extreme label; traits
  property returns labels.
- [ ] **M36 Bloodline genetics.** `generate_child` blends parents' Bloodline spectrums with
  mutation jitter; Temperament/Conviction seeded near 0 (childhood shapes them). *Files:*
  simulation.py, dispositions.py. *Smoke:* two Brilliant parents → child bloodline mean near
  parents' with variance.
- [ ] **M37 Tiered population.** New `population.py`: Tier-0 bulk pass (age/mortality/
  fertility for ALL realm characters each turn, cheap loops over packed lists); relevance
  set (rulers, heirs, council, Directors, Commanders, scheme participants, player court);
  `promote(char)` wakes full logic. Rewire character_ai.py:36-41 aging through it. Grow each
  Realm's courtier pool to spec scale. *Files:* population.py (new), character_ai.py,
  realms.py, game.py (wire in process_turn beside :820). *Smoke:* 500+ characters simulate
  100 turns < 2s; births/deaths occur; promotion preserves state.
- [ ] **M38 Drift engine.** `dispositions.apply_drift(char, pair, amount, reason)` +
  witness-drift helper; wire existing life events (succession grievances
  relationships.py:98-131, ruler actions character_ai.py:113-132, CK event choices
  game.py:83-119) to push spectrums; drift crossings logged to turn_events ("X has become
  Callous"). *Files:* dispositions.py, relationships.py, character_ai.py, game.py. *Smoke:*
  scripted event pushes a character across ±50; label change + log entry appear.
- [ ] **M39 Stress 2.0 + breaks.** Stress accrues when actions contradict Temperament OR
  Conviction (contradiction check in dispositions.py); at existing stress thresholds
  (simulation.py get_stress_level) fire mental break → coping-vice label (drink/gambling/
  cruelty/seclusion) with attribute penalties. *Files:* dispositions.py, simulation.py,
  character_ai.py. *Smoke:* force contradictory acts → stress climbs → break fires → vice
  present.
- [ ] **M40 Persona & secrets.** Per-character `persona` (public spectrum estimate) vs
  private values; `Secret` objects (kind, subject, holders, potency) created by vice breaks,
  affairs (marriages.py), sabotage/crimes later; discovery chance scales with observer
  Intrigue. *Files:* dispositions.py, simulation.py, relationships.py. *Smoke:* character
  with hidden vice has persona≠private; a high-Intrigue courtier discovers the Secret within
  N turns.

## Wave EV — Event engine (M41-M42)

- [ ] **M41 Situation renderer.** New `event_engine.py` + `event_content/` package:
  `Situation` (type, actors, cause, state-delta already applied) → pick template from pool →
  fill slots (names/traits/history) → emit to turn_events or as pending_ck_event with
  generated choices (choices built from what those characters can do). Wire 3 existing
  situation types through it: mental break (M39), death/succession (game.py:496-530), plot
  resolution (relationships.py:162-215). *Files:* event_engine.py (new),
  event_content/core_pools.py (new), game.py, relationships.py. *Smoke:* same situation
  twice → different template text, same state effect; choice list matches actor capability.
- [ ] **M42 Template content pack 1.** Data-only brief: ≥4 variants per situation type
  covered so far. *Files:* event_content/*. *Smoke:* every pool ≥4 variants, all render
  without KeyError across 200 simulated turns.

## Wave DC — Dynasty & capital (M43-M45)

- [ ] **M43 Shares.** New `shares.py`: `Enterprise` (house, sector, city links, base yield)
  + shareholding ledger (char_id→pct); dividends pay into holders' gold_reserve during the
  gold step (beside tax_system call at game.py:637); House founding grants each Great House
  starting enterprises over its cities. *Files:* shares.py (new), game.py, realms.py.
  *Smoke:* dividends flow each turn; ledger sums to 100% per enterprise.
- [ ] **M44 Succession 2.0 — partition.** Extend `execute_succession`
  (simulation.py:268-383): title follows law (unchanged); shares partition among heirs by
  law + testament weighting; non-inheriting heirs become shareholder rivals (opinion hit via
  modify_opinion + rival flag consumed by relationships.py plot logic). *Files:*
  simulation.py, shares.py, relationships.py. *Smoke:* ruler with 3 children dies → heir has
  title, siblings hold shares, at least one rival registered.
- [ ] **M45 Marriage as merger.** Extend marriages.py `_maybe_arrange_match` + add
  player-facing contract: terms = alliance, dowry (gold or shares pct), matrilineal flag
  (children's House), board-seat pledge; AI valuation from Bloodline quality + House power;
  courtship pressure = existing sway/scandal hooks modify asking price (full verbs land in
  Wave IN). *Files:* marriages.py, shares.py, realms.py. *Smoke:* arranged marriage moves
  shares per contract; matrilineal children register to the correct House.

## Wave B — Military wiring (M29-M33) — SURVIVES, runs here

Per deep-systems spec Part 3. Positioned before Commanders (M48) need it.

- [ ] **M29** Wire `resolve_combat` (combat.py:142-289) to replace RNG duel (military.py:180-239)
- [ ] **M30** Unit HP persistence + siege
- [ ] **M31** City capture
- [ ] **M32** Strategic resources gate units
- [ ] **M33** War declaration/peace + AI war usage

## Wave OC — Org chart (M46-M49)

- [ ] **M46 Council reflavor + real effects.** court.py positions → Board Chairman
  (statecraft), Chief Engineer (science), Head of Security (command), Master of the Press
  (intrigue), Chief Steward (industry); `get_bonus` outputs applied as realm modifiers in
  process_turn (research %, unrest, tax, army morale) — today only the Steward path has a
  live wire. *Files:* court.py, game.py, character_ai.py. *Smoke:* appointing a
  high-science Chief Engineer measurably raises research output.
- [ ] **M47 Directors.** Per-city `director` slot (city.py): Industry attr scales city
  production %, Convictions trade unrest vs profit vs accident-rate (accident hooks live in
  Wave PE, land as coefficients now); vacant = neutral. Enfeoffment: cities beyond domain
  cap require a Director who takes a shares salary. *Files:* city.py, realms.py, game.py,
  shares.py. *Smoke:* high-Industry Director raises production; Reformist lowers unrest and
  profit vs Callous.
- [ ] **M48 Commanders.** Per-army `commander`: Command attr multiplies combat strength in
  resolve_combat (M29); defeat/glory events push stress + drift. *Files:* military.py,
  combat.py, simulation.py. *Smoke:* identical stacks, Command 18 beats Command 4 majority
  of resolutions; loser gains stress.
- [ ] **M49 Loyalty.** Directors/Commanders/council carry loyalty (from opinion + treatment
  + Conviction alignment); low loyalty → embezzlement (skim dividends), defection during
  takeovers (Wave IN hook), or handing a city to revolutionaries (Wave PE hook). *Files:*
  realms.py, relationships.py, city.py, shares.py. *Smoke:* mistreated Director's loyalty
  decays; embezzlement event fires and gold actually moves.

## Wave GR — Growth (M50-M51)

- [ ] **M50 Guardians & education.** Child slots: guardian (traits/convictions rub off via
  drift each turn) + education track (one of 6 attributes); graduation quality from guardian
  skill + Bloodline. *Files:* simulation.py, dispositions.py, character_ai.py. *Smoke:*
  child raised by Radical guardian drifts Labor-ward; education track yields attribute bump
  at adulthood.
- [ ] **M51 Focus.** One Focus per adult (6, one per attribute): small passive, themed
  event stream (via event_engine), slow attribute growth; switching resets progress.
  Replaces character_deepening.py `LifestyleProgression` (delete after migration). *Files:*
  simulation.py, character_deepening.py, event_content/. *Smoke:* Focus grants passive;
  attribute grows over 20 turns; switch resets.

## Wave ST — Setting shift (M52-M54)

- [ ] **M52 Fictional-1900 reframe.** game_data.py: civs → Great Houses (names/colors/
  flavor), calendar = 1900 + turn×~1.5yr, era names → industrial-century phases; UI strings.
  *Files:* game_data.py, game.py, pygame_app strings. *Smoke:* new game shows House names +
  1900-era dates.
- [ ] **M53 Tech tree rebuild (data).** ~56 techs across the fictional industrial century
  (electrification → mass production → radio → flight → atomic...), per deep-spec Part 2
  cost curve. Data-only. *Files:* game_data.py. *Smoke:* tree loads, no orphan prereqs,
  era counts ≥3 each.
- [ ] **M54 Era/victory rewiring.** Point era checks + M18 victory gates at the new tree;
  Science victory = complete final era; retire anachronisms (deep-spec spaceship victory is
  CANCELLED — ideological/economic victory design lands with Wave PE). *Files:* tech.py,
  game.py. *Smoke:* victory fires only per new gates over a 300-turn autoplay.

## Wave PE — Political economy (M55-M61)

- [ ] **M55 Extraction dial.** Per-city (per-enterprise) dial 0-100 (wages/safety):
  production & dividends scale up with dial; unrest + accident-risk scale up too; rival AI
  Houses set dials from ruler dispositions. *Files:* labor.py (new), city.py, shares.py,
  ai.py. *Smoke:* dial 90 outproduces dial 30 but accrues multiples of its unrest.
- [ ] **M56 Accidents & the grind.** Accident events from dial×population×(1−safety):
  kill population, sometimes maim a character; witnesses drift (Callous or Reformist);
  signing suppression/cover-ups stresses the signer (ruler complicity per spec §5.1).
  *Files:* labor.py, event_engine.py, event_content/. *Smoke:* high-dial city suffers
  accidents; ruler stress rises after cover-up choice.
- [ ] **M57 Labor movements.** Unrest crystallizes into unions/strikes/sabotage; movements
  have leader characters (Tier-1 promoted) who can be swayed/bought/framed/martyred —
  martyrdom regionalizes the movement. Strikes halt city production. *Files:* labor.py,
  population.py, city.py. *Smoke:* sustained squeeze → strike fires, production zeroes;
  martyred leader spreads movement to a neighbor city.
- [ ] **M58 Ideological tide.** Global tracker rising over the century; every atrocity by
  ANY House accelerates it; tide scales movement growth + Conviction drift pressure
  world-wide. *Files:* ideology.py (new), labor.py, game.py. *Smoke:* atrocity-heavy run's
  tide outpaces a gentle run's by turn 100.
- [ ] **M59 Legitimacy.** Per-House meter (from happiness, scandal, atrocities, tide);
  feeds victory gates and revolution risk. *Files:* ideology.py, game.py. *Smoke:* scandal +
  atrocities visibly drain legitimacy.
- [ ] **M60 Revolution.** Legitimacy floor + movement peak → uprising (city defections,
  worker militias); loss = expropriation = game over. *Files:* ideology.py, labor.py,
  game.py. *Smoke:* engineered collapse ends in revolution game-over.
- [ ] **M61 Transformation.** Ruler with genuine Labor-ward Convictions (private value
  checked, not persona) may break with the Houses: concede enterprises, arm strikers →
  survive as People's Chairman (shares → political capital, Houses → class enemies, distinct
  win condition). *Files:* ideology.py, shares.py, game.py. *Smoke:* Reformist ruler
  transforms and survives the same collapse that killed the Callous control run.

## Wave IN — Intrigue (M62-M66)

- [ ] **M62 Scheme framework.** New `schemes.py` (evolves plots.py concepts; retire dead
  game_manager.py path): scheme = agent+target+type+progress+discovery-risk, advanced in
  process_turn; agents from court; discovery → Secret + scandal. relationships.py plot
  logic migrates onto it. *Files:* schemes.py (new), relationships.py, plots.py, game.py.
  *Smoke:* scheme advances, resolves, and can be discovered.
- [ ] **M63 Expose & blackmail.** Spend a held Secret: Expose (tabloids — Master of the
  Press potency) craters target persona/legitimacy/marriage value; Blackmail extorts
  shares/votes/favors with refusal-and-expose branch. *Files:* schemes.py, dispositions.py,
  shares.py. *Smoke:* exposé drops persona+legitimacy; blackmail transfers shares.
- [ ] **M64 Sabotage, sway, seduce, compromise.** Sabotage = deniable accident at a rival
  work (kills THEIR workers, feeds tide — the machine grinds as a weapon); sway/seduce
  build opinion/affair leverage; compromise manufactures a Secret. These also implement the
  marriage courtship-pressure hooks (M45). *Files:* schemes.py, labor.py, marriages.py.
  *Smoke:* each verb runs end-to-end with discovery risk.
- [ ] **M65 Hostile takeover.** Multi-turn scheme buying a rival House's shares via
  disloyal holders (siblings, widows, rivals from M44/M49); >50% = you own the House's
  enterprises; the House survives as characters but loses its base. *Files:* schemes.py,
  shares.py, realms.py. *Smoke:* takeover of an engineered-fractious House completes; yields
  transfer.
- [ ] **M66 Assassination conspiracy.** Requires recruited co-conspirators (each a per-turn
  betrayal risk), high cost, staged-accident method; exposure = nuclear scandal (legitimacy
  collapse, all-House hostility, trial event). *Files:* schemes.py, ideology.py,
  event_content/. *Smoke:* success kills target; forced betrayal produces the full scandal
  cascade.

## Wave UI — Interface (M67-M71) — interleave after each wave lands

- [ ] **M67** Character sheet + dynasty tree screen (after Wave CC)
- [ ] **M68** Board/shares panel + marriage contract popup (after DC)
- [ ] **M69** Appointments UI: council/Director/Commander with candidate compare (after OC)
- [ ] **M70** Enterprise/extraction-dial controls + labor overview (after PE)
- [ ] **M71** Scheme menu + Secrets ledger (after IN)

## Wave SC — Signature content (M72+, open-ended)

- [ ] **M72+** Authored signature chains in data-only briefs of 5-10 chains each, priority
  order: mine-disaster inquiry, heir radicalization, tabloid war, revolution ultimatum,
  succession vultures, coping-vice spirals. Target 50-100 chains total (spec §7).

## Wave AI — AI competence (M73-M76)

Replaces old Wave D scope (old M41-M47 cancelled; tech-tree items moved to ST).

- [ ] **M73** AI expansion: lift 6-city cap (ai.py:158), settle per deep-spec curves
- [ ] **M74** AI economy/tech: dial-setting, research targeting, building choices
- [ ] **M75** AI military: wars of conquest using Wave B, Commander assignment
- [ ] **M76** AI character play: marriages-as-mergers, schemes, takeovers vs player

---

## Dependency graph (wave level)

```
A ──► CC ──► EV ──► DC ──► B ──► OC ──► GR ──► ST ──► PE ──► IN ──► AI
                                  │                     ▲
UI missions land after their wave─┘      SC (content) anytime after EV
```

Strict prerequisites: CC before everything character-touching; A before PE (dial needs real
yields); B before M48; DC before M65; EV before M56; ST before PE (tide is period-framed).

## Risks & guards

- **Perf (full population):** M37's smoke enforces a hard budget (500 chars × 100 turns
  < 2s Tier-0). If missed, briefs may not "optimize later" — the mission fails and is
  re-authored.
- **CynCo drift:** briefs stay ≤4 files/≤6 blocks; verbatim OLD blocks are re-read from
  disk the day the brief is authored, never from this doc's line numbers.
- **Compat breaks:** M34/M35 keep `get_effective_stat` and `traits` working as facades so
  untouched callers survive; facades are removed only by a dedicated cleanup mission at the
  end of Wave CC.
- **game_manager.py** is a dead parallel manager — M62 retires its plot path; nothing new
  may reference it.
