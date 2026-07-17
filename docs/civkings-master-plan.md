# CivKings Master Plan

**From 65%-wired prototype to a sellable Steam game — a CynCo-driven production plan**

*Date: 2026-07-13. Author: Claude (orchestrator) synthesizing: (1) deep codebase audit + independent wiring verification, (2) Civilization-series mechanics research, (3) CK3/Old World mechanics research, (4) indie 4X Steam market research. Implementer: CynCo (local agent, Qwen3.6-27B NVFP4) via the proven mission-brief pattern; every mission verified and recorded in `benchmark/cynco-ledger/missions.jsonl`.*

---

## Table of Contents

- **Part I — Executive Summary & Honest Calibration**
- **Part II — Codebase Reality** (what actually exists, corrected audit)
- **Part III — Product Definition & Design Pillars**
- **Part IV — The Civ Layer** (the map game)
- **Part V — The CK Layer** (the character game)
- **Part VI — The Interaction Layer** (the differentiator)
- **Part VII — Event Architecture & Content Plan**
- **Part VIII — AI Design**
- **Part IX — Pacing, Anti-Snowball & Session Design**
- **Part X — UX, UI, Audio & Polish** (incl. X.9 local generative audio & content stack)
- **Part XI — Technical & Shipping Reality**
- **Part XII — Production Roadmap: CynCo Mission Waves**
- **Part XIII — Verification & Quality Infrastructure**
- **Part XIV — Market & Launch Strategy**
- **Part XV — Risk Register**
- **Appendix A — Formula Cheat Sheet**
- **Appendix B — CynCo Mission Brief Template & Checklist**
- **Appendix C — Event Data Schema**
- **Appendix D — Backlog Index (every mission, one line each)**

---

# Part I — Executive Summary & Honest Calibration

## I.1 What we are building

**CivKings**: a turn-based hex 4X where the map game (cities, tech, war — Civilization's loop) is ruled by mortal characters (traits, opinions, schemes, succession — Crusader Kings' loop), and the two layers feed each other every turn. One campaign = one dynasty arc in 2–4 hours.

The codebase already exists: **31,401 lines of Python** across 121 files, with a working hex map, fog of war, cities with districts/adjacency, production, 25-tech tree with eurekas, combat with flanking and terrain, six victory conditions, save/load, a functional pygame UI, and — crucially — a real character layer: rulers with 4 CK stats, traits, stress, aging, death, succession laws, marriages, courts, and dynasties. Ten CynCo missions have already hardened it (research wiring, event effects, golden ages, stewardship-taxation, AI movement, CK event feedback).

## I.2 The honest market calibration

The market research is unambiguous and this plan refuses to lie to you:

- $1M gross ≈ **55–70k units** at $14.99–19.99 realized pricing. Roughly **1.5% of Steam releases** clear $1M in a year. The median indie grosses **$249**.
- **Old World already owns the phrase "Civ meets CK."** Built by Civ IV's lead designer with a funded 15-person studio and 3,000+ launch events, it grossed ~$4.4M on Steam — a success, but no goldrush. At the Gates — famous solo designer, same genre — was a commercial failure.
- The path to the $1M tail exists but has hard gates: **30–50k launch wishlists**, Very Positive reviews, a Next Fest demo that converts, a streamer-legible hook, probably a publisher (Hooded Horse class), and possibly an engine port before 1.0.

**Therefore this plan is staged around evidence, not hope:**

| Stage | Target | Gate to next stage |
|---|---|---|
| S1: Playable & fun | Free/itch demo, 20 external playtesters say "one more turn" unprompted | Retention signal + Very Positive-quality feedback |
| S2: Steam page + demo + Next Fest | 7–10k wishlists (Popular Upcoming threshold) | Wishlist velocity after Next Fest |
| S3: Early Access at $14.99–19.99 | $50–250k gross — **the planned success case** | 30k+ wishlists / breakout demo signal |
| S4: The $1M chase | Publisher pitch, possible Godot port, content x3, localization | Only if S3 gates pass |

The design decision that gives us any right to compete: **dynasty-first, not map-first.** Old World's most consistent criticism is that its characters are shallower than CK's; CK's most consistent criticism is that its map/war game is a chore. The open lane is a game where **the map serves the family drama** — and short (2–4 hour, "one generation per session") campaigns, which simultaneously cure the genre's late-game disease and make the game streamable. That is the pitch, the trailer, and the Steam capsule. Not "Civ meets CK" — that phrase is taken. Ours: **"Every empire dies of natural causes. A 4X where your greatest enemy is your own heir."**

## I.3 Why we can produce this at all (the CynCo advantage)

A solo human cannot write 300 events, 40 techs, 30 traits, an AI, a tutorial, and balance passes. But this project's production system is not a solo human — it is a human orchestrator + CynCo running locally at zero marginal cost, with a **proven mission pattern** (10 landed missions, ledger-verified, single-digit-minute median) and a growing failure log ensuring we never fail the same way twice. Content production (events, traits, techs as *data*) is exactly what this pipeline is best at: verbatim data blocks + schema validators + smoke checks. Part XII structures the entire build as ~120 missions across 11 waves, each wave gated by automated verification.

## I.4 The five commandments (from all three research reports at once)

1. **Traits are constraints, not stat bags.** Stress when the player acts against character is the single best CK mechanic — it makes characters *matter*. (CK research §1)
2. **Opinion is the single currency every system reads and writes.** Then every event automatically has political consequences. (CK research §2)
3. **Something must finish every 1–3 turns**, and decisions-per-turn stay flat (3–6) as the game ages. (Civ research §1)
4. **The AI must be competent-looking, not smart.** Avoid 1UPT, use behavior rules + agendas + open economic bonuses. Weak AI is the #1 named killer of indie 4X. (Civ §7, Market §6)
5. **Short campaigns are the product**, not a compromise. 150–250 turns, 2–4 hours, one dynasty generation per session. (Civ §8, Market §3)

---

# Part II — Codebase Reality

## II.1 Corrected systems audit

A deep audit agent surveyed all 121 files; I then independently re-verified its claims against `game.py`'s actual `process_turn` (389 lines) because several of its "critical gaps" were stale. **Corrected truth table:**

| System | Audit said | Verified reality (2026-07-13) |
|---|---|---|
| Tax income | "dormant" | **WIRED** — `game.py:616` calls `tax_system.process_tax_income(self.cities, ruler)` with stewardship bonus (mission 10, d58830b) |
| Production queue | "never called, game unplayable" | **WIRED** — process_turn processes `city.process_production(...)`, completes buildings/units/wonders |
| City growth | "not wired" | **WIRED** — `city.grow()` called per turn, growth events logged |
| Religion spread | "not called" | **WIRED** — `_process_religion_spread()` called in process_turn |
| Tile improvements | "orphaned" | **WIRED** — `improvement_manager.process_turn(...)` called |
| Great people | "dormant" | **WIRED** — `great_people_manager.process_turn(self)` called |
| Market simulation | "no active mechanics" | **WIRED** — `market.update_all_prices()` per turn |
| Stability | "not called" | **WIRED** — `stability_system.calculate_unrest()/calculate_revolt_risk()` per turn |
| Trade routes | "not invoked" | **WIRED** — `process_trade_routes()` per turn, food/gold cargo applied |
| Happiness, war weariness, golden ages, eras, victory | wired | **Confirmed wired** |
| Government bonuses | "not applied" | **CONFIRMED GAP** — zero `government` references in process_turn; GOVERNMENTS data + popup exist but bonuses never touch yields |
| Plot execution | "not written" | **CONFIRMED GAP** — PlotManager instantiated (`game.py:203`); plots never progress or resolve in the loop |
| Diplomacy acceptance | — | **CONFIRMED GAP** — `propose_peace`/`propose_alliance` auto-accept unconditionally (mission 11 brief already written, ready to dispatch) |
| Audio | "disconnected" | **CONFIRMED GAP** — music_manager/sound_manager never called |
| Settings / tutorial / pause menu | missing | **CONFIRMED GAP** |
| Faction system | "dormant" | **PARTIAL** — faction effects (stability, conflict) ARE read in process_turn; faction *events* pool is empty (0 events) |

**Lesson encoded in the failure log (F8 practice):** never trust a single audit pass; verify wiring by reading the live call path. The plan below only schedules work against *verified* gaps.

## II.2 Latent bugs found by verification (Wave 0 fodder)

1. **`city.py:483` — building faith is always 0.** `sum(2 for b in self.buildings if hasattr(b, 'name') and b.name in ("Temple", ...))` iterates a `Dict[str, BuildingType]`, yielding key *strings*; `hasattr(str, 'name')` is False. Temples/shrines silently produce no faith. Same container-type bug class as F8.
2. **Two parallel event systems** (legacy `events.py` Event + `game.py` CKEvent) with different schemas — a architecture debt that Part VII resolves.
3. **Dead code:** `empire_manager.collect_taxes` is a dead duplicate of the live tax path (verified during mission 10 prep).
4. **`COMPLETION_PLAN.md`** in repo root is stale (claims religion/victory unwired; both wired) — superseded by this document; delete after user sign-off.

## II.3 Content inventory (the real deficit)

| Content type | CivKings now | Genre reference | v1.0 target |
|---|---|---|---|
| Civilizations | 12 | Civ VI: 20+; Old World: 7 | 8 (curated, with leader dynasties) |
| Techs | 25 (6/6/4/4/2/3 per era) | Civ VI: 67; Polytopia: 24 | 40 across 5 eras |
| Buildings | 15 | Civ VI: ~90 | 30 |
| Districts | 7 | Civ VI: 13 | 7 (keep, deepen adjacency) |
| Units | 16 | Civ VI: ~100 | 24 |
| Wonders | 5 | Civ VI: ~35 | 12 |
| Random events | 13 | Old World: 3,000; CK3: ~2,000 | — (absorbed into unified system) |
| CK events | 5 | — | **250–300 unified events** |
| Traits | 8 | CK3: ~75 core | 32 (16 opposed pairs) |
| Succession laws | 4 | CK3: ~6 | 3 (cut to what matters) |
| Governments | 4 | — | 4 (finally wired) |

**The verdict:** the *engine* is ~80% present and much healthier than the audit claimed. The commercial gap is **(a) content volume — above all events and traits, (b) the interaction layer that makes the two games one game, (c) AI competence, (d) onboarding/audio/polish, (e) balance.** That is what Parts IV–XII schedule.

## II.4 Existing test & verification assets

- `test_civkings.py`: 24 passing tests (game creation, tech, diplomacy, AI, events, trade).
- Proven CynCo verification stack: `ast.parse` gate → pytest gate → per-mission smoke check (executable Python asserting the new behavior end-to-end) → orchestrator full-diff review vs brief → ledger row with governance signals.
- Headless `Game` object runs 40+ turns in tests today — the foundation for the autoplay balance harness (Part XIII).

---

# Part III — Product Definition & Design Pillars

## III.1 The elevator pitch

> **CivKings** — a fast 4X where your civilization is a *family*. Build cities and armies like Civ; but your ruler is mortal, opinionated, and surrounded by ambitious relatives. Win before your dynasty eats itself. One campaign, one evening.

## III.2 Product parameters (locked)

| Parameter | Value | Rationale |
|---|---|---|
| Campaign length | **150–250 turns, 2–4 hours** | Civ research §8; market research: session length is a hook, not a cut |
| Map | ~34×34 hex, 4–6 civs | Small enough for Python turn times, big enough for 3 wars |
| Eras | 5 (Ancient → Classical → Medieval → Renaissance → Industrial); cut "Modern" | One fewer era of art/units/balance; Old World proved single-era works, we keep breadth but trim the tail |
| Price | $14.99 launch EA → $19.99 at 1.0 | Market §3 |
| Platform | Windows first (pygame), Steam; port gate at S3→S4 | Market §4 |
| Player count | Single-player only | Multiplayer is a different company |
| Moddability | Events/traits/techs as JSON data files | CK longevity is mod-driven; also *our own content pipeline* (CynCo writes data, validator gates it) |
| Art | Consistent readable 2D hex + character portraits (commissioned/generated batch, one style pass) | "Distinct readable art style" — market §3 |

## III.3 The five design pillars (tie-breakers for every future decision)

1. **The Dynasty IS the run.** Roguelike framing: your dynasty is the persistent thing; rulers are lives. Succession is the boss fight. Victory conditions are dynastic.
2. **Traits gate, stress taxes.** Every event option can be trait-gated or trait-stressful. The player *feels* who their ruler is.
3. **One ledger to rule them all.** Character opinion (−100..+100, decaying timed modifiers) is read by taxes, levies, plots, elections, diplomacy, and events. No parallel reputation systems.
4. **Every turn, something finishes.** Staggered cadences (1–3 turn builds, 10–20 turn wonders/wars, 100+ turn victory). Decision density flat at 3–6/turn.
5. **The AI must never look stupid.** Rules over cleverness; agendas over neutrality; open bonuses over hidden cheats.

## III.4 What we explicitly cut (YAGNI, from the research)

- 1UPT tactical combat (AI can't handle it — keep current tile-stacks + flanking).
- Espionage as a separate system (folded into schemes).
- Tourism-style culture victory math (replaced by Legacy victory, Part VI).
- Naval-focused gameplay, city-states, world congress, climate systems.
- Perk/lifestyle trees for characters at v1 (CK research: cuttable; stress is not).
- Multiplayer, achievements-at-launch, localization-at-launch (S4 items).

---

# Part IV — The Civ Layer (the map game)

The map game exists. This part specifies the deltas that take each system from "works" to "genre-correct," with the exact formulas to adopt (all sourced from the Civ research report; they are compact, tunable, and battle-tested — do not invent new ones).

## IV.1 Yields & growth

**Current:** 2 gold/citizen tax (stewardship-boosted, mission 10); city.calculate_yields sums terrain + buildings; growth via `city.grow()` (threshold logic in city_growth.py).

**Target:**
- Six yields: Food, Production, Gold, Science, Faith, **Legitimacy** (replaces Culture — see Part VI; it is the CK-flavored sixth yield). Gold and Faith are bankable stocks; the rest are flows.
- **Growth formula (adopt Civ VI):** food to grow = `15 + 8(n−1) + (n−1)^1.5`, each citizen eats 2 food/turn, only surplus accumulates. Makes food tiles strategic; soft-caps city size on our small maps.
- **Cost scaling:** production costs roughly double per era (unit line: 40 → 90 → 240-class); tech costs from 25 (Ancient) to ~1,200 (Industrial cap — we cut the eras that cost more).
- **District cost by global progress (adopt Civ VI):** `60 × (1 + 9P)`, P = fraction of tech tree researched. One line, kills early-builder lock-in.
- **Anti-snowball tax (adopt Civ V, pick "tall"):** each city beyond capital = +5% tech costs. We *want* tall-ish empires: fewer cities = fewer decisions = flat decision density, and the dynasty layer is the wide-game replacement.

## IV.2 Tech tree & eras

**Current:** 25 techs, 6 eras, eureka tracker exists, era advancement triggers golden ages (mission 9).

**Target:**
- 40 techs across 5 eras (8/era), mostly-forward DAG, 1–3 prereqs, 3–5 beeline paths (military / economy / faith / statecraft / expansion).
- **Every tech gets a eureka** (40% cost boost) tied to a gameplay verb — this is the highest-value mechanic in the entire Civ research ("converts research from passive drip into quest-driven play"). Eureka conditions must be *achievable in our systems* (e.g., "win a battle with a flanking bonus," "have 3 trade routes," "marry into a foreign dynasty" — note the CK crossovers).
- Era advancement: keep the 3-techs-of-next-era rule; keep golden age on advance; add **unit obsolescence** per era to force military refresh.

## IV.3 Cities, districts, buildings

**Current:** 7 districts with adjacency scan (`city.calculate_adjacency`), 15 buildings adding yields additively (`city.py:234`), pop-based logic partial.

**Target (the "minimum viable district puzzle" from the research):**
- Keep 7 districts; give each **one legible adjacency rule** (mountain→science, river→gold, hills→production, temple-district→faith per adjacent forest, etc.). +2 major / +1 standard, no fractional bonuses.
- **District slots = 1 per 3 population.** Forces specialization ("science city / faith city"), creates settle-spot decisions.
- 30 buildings, 2–3 per district, each building's bonus must be *verified applied* in calculate_yields (Wave 0 fixes the faith bug first).
- Gold purchase of production items as the late-game overflow valve.

## IV.4 Combat

**Current:** stack-per-tile with flanking (+5/extra attacker), terrain defense (−30% hills/forest), counter bonuses, XP/promotions, martial stat bonus (combat.py:166).

**Target:**
- **Adopt the Civ VI damage curve:** `damage = 30 × e^(ΔS/25) × rand(0.75–1.25)` on 100 HP; wounded units fight at up to −33% strength. Compact and tunable; +17 strength ≈ 4:1.
- Keep small stacks (2–3 units/tile max) — explicitly NOT 1UPT (AI competence pillar).
- Unit triangle: melee (captures) / ranged (no retaliation, can't capture) / cavalry (flank ×1.5) / anti-cavalry / siege (vs walls). 24 units = this triangle × 5 eras minus gaps.
- **War weariness (adopt Civ VI shape):** battle = EraBase pts (×2 abroad), unit death = 3×EraBase, every 400 pts = −1 happiness; decay 50/turn at war, 200 at peace, −2000 on peace treaty. Already partially present — finish the loop so it feeds happiness and *ruler stress* (Part VI).

## IV.5 Victory conditions

**Current (all wired):** Conquest, Domination (12 cities), Science (reach Modern), Culture (1000 pts), Religion (60% followers), Dynasty (1500 prestige).

**Target — cut to 4, each with a visible race track (Civ research: "every victory needs a number and the rival's number"):**
1. **Conquest** — hold all original capitals.
2. **Faith** — your religion majority in every living civ (spread now wired; missionary verb needed).
3. **Legacy** (replaces Science+Culture) — complete 3 era-capstone "Dynasty Works" projects (wonder-class builds with character requirements: e.g., needs a ruler with stewardship 15+). This is the "project race with counterplay."
4. **Dynasty** — prestige threshold **or survive 8 generations with your dynasty on the throne** — the flavor victory for the character game.
- New **World Rankings panel**: per-victory leaderboard, "you: 3/5 capitals, Rome: 4/5." One popup, four numbers per row.

---

# Part V — The CK Layer (the character game)

The skeleton is unusually good: Character (4 stats, traits, stress 0–300, aging, death), Dynasty, Court positions, succession laws, marriages ticking cross-civ, CK events with choices. This part upgrades it to the minimum emergent-story kit the CK research identified.

## V.1 Character model v2

- **Stats:** keep Diplomacy / Martial / Stewardship / Intrigue (0–20 practical range). Add **Prowess later only if duels enter** (backlog). Every stat now has a verified mechanical home:
  - Diplomacy → alliance/peace acceptance (mission 11), opinion baseline, event options
  - Martial → combat bonus (wired), levy size, army maintenance discount
  - Stewardship → tax (wired, mission 10), build cost discount, district slots +1 at 15+
  - Intrigue → scheme success/secrecy, plot detection (partially referenced; Wave 4 wires it)
- **Traits: 32 in 16 opposed pairs** (Brave/Craven, Generous/Greedy, Calm/Wrathful, Honest/Deceitful, Ambitious/Content, Zealous/Cynical, Gregarious/Shy, Diligent/Slothful...). Trait footprint (CK research §1): ±1–3 to 1–2 stats + one opinion effect + **stress rules** + **event-option gating**. Each character: exactly 3 personality traits.
- **Congenital line (1 slot):** Quick/Intelligent/Genius (+1/+3/+5 all) mirrored by Slow/Stupid (−2/−4); Beautiful/Hideous (±opinion). 50% tier-upgrade chance when both parents share the trait — the eugenics minigame, nearly free to implement on top of existing `generate_child`.
- **Stress (upgrade existing 0–300 meter):** thresholds at 100/200/300 trigger **mental break events** — the player chooses a coping trait (Drunkard, Irritable, Reclusive: each gives +stress-relief but a permanent cost) or eats consequences. Stress is *gained when an event choice contradicts a trait* (the golden rule). Level penalties: fertility −10/−30/−50%, health −1/−2; level 3 can kill or force abdication.

## V.2 The opinion ledger (the single most important new system)

One table: `opinion[a][b] = Σ static modifiers + Σ timed modifiers (each with decay ~1/turn toward 0) + relationship bonuses`.

- Static: trait compatibility (same trait +10, opposed −10), same dynasty +5, faith difference −10/−20, diplomacy stat of b (−8..+12).
- Timed: every event/action writes one ("Imprisoned my brother −20 (decays)", "Granted me a court position +15").
- **Consumers (all must actually read it — wire-check enforced):** vassal/court tax & levy contribution, plot eligibility & agent recruitment, elective succession votes, AI diplomacy acceptance (stacks with mission 11's relation check at the civ level), event weighting, faction unrest.
- Existing `relationships.py` + `diplomacy_manager.relations` (civ↔civ) remain; the ledger is character↔character and *feeds* civ relations (ruler opinion of ruler = ±25% of civ relation drift per turn).

## V.3 Relations: friend / rival / lover / nemesis

Four scripted relation types events can create and test (CK research §8): Friend +60 opinion, Rival −60, Lover +60/+fertility, escalations (Best Friend/Nemesis/Soulmate ±120). Mechanical teeth: councilor efficiency ±20%, **+10 ruler stress when a friend/lover dies, −35 stress when your nemesis dies**, rivals generate scheme/duel events, lovers generate affair/bastard events. Implementation: a `relations: Dict[char_id, RelationType]` on Character + event hooks. This is what turns event chains into Reddit sagas.

## V.4 Schemes (plots v2)

Replace the dormant PlotManager execution gap with the CK-minimal model:
- **Two schemes at v1:** Murder (hostile) and Sway (personal). Murder: progress bar; success% = f(schemer intrigue vs target intrigue + agents), capped 95; per-turn discovery roll (discovery → −40 opinion with target's realm, casus belli, possible rival relation); on success — death, succession fires, "the game remembered" moment. Sway: +2 opinion/turn while active.
- Agents recruited from *target's* court via opinion checks (the ledger pays off).
- Honest/Compassionate schemers pay +stress for murder — traits tax villainy (pillar 2).
- UI: one Schemes tab in the existing dynasty popup; list, progress, risk.

## V.5 Succession as the boss fight

**Current:** primogeniture-style heir promotion on death, 4 laws defined.
**Target:**
- 3 laws: **Partition** (default, painful: non-capital cities split to siblings who become AI-adjacent vassal-rivals with opinions), **Primogeniture** (unlocked by Renaissance tech + high Legitimacy), **Elective** (court votes by opinion — the ledger again).
- On succession: play continues as heir; inherit treasury/armies; fresh timed opinion penalties ("short reign −20, decays over 10 turns"); each living sibling gets a rival-flavored event chance. **A succession should cost the player something every time** — it is the anti-snowball (Civ research complaint #2, our unique cure).
- Regency events when heir is a child; game-over only when the dynasty has no living member (defeat screen: "House Palaiologos ends with you").

## V.6 Marriage & alliances

**Current:** cross-civ auto-marriages tick, blood-tie relation drift, alliance at relation 50+.
**Target:** make marriage a *player verb*: propose match (child/sibling ↔ foreign court) → acceptance = opinion + rank check → **alliance flag (call-to-war both ways)**, children average parents' stats ± noise, congenital inheritance %. Betrothals lock deals early. Matrilineal toggle. One popup, huge strategic surface — diplomacy, eugenics, and succession planning in one verb (CK research §5).

---

# Part VI — The Interaction Layer (the differentiator)

This is the part neither Civ nor CK has, the part Old World only half-built, and the reason someone pays $15 for CivKings instead of a Civ VI sale. **Rule: every CK number must move a Civ number, and every Civ number must move a CK number.** The wire-check memory applies doubly here — each mapping below ships with a test proving both directions.

## VI.1 Legitimacy — the sixth yield (the Old World steal, CK-flavored)

A per-civ 0–100 meter, the political health of your ruler:
- **Sources:** ruler diplomacy/turn drip, won wars, completed Dynasty Works, honored alliances, coronation/marriage events, golden ages.
- **Drains:** lost wars, broken truces, high stress breaks, tyranny (executions/imprisonments), succession (−20 fresh ruler), unfulfilled agendas.
- **Reads (map-side):** city happiness modifier (±10), levy size %, **anarchy risk** (Legitimacy < 20 → revolt events; the existing stability/revolt system finally gets its driver), vassal/court tax contribution %.
- **Reads (character-side):** event weighting (low legitimacy → coup/faction events), elective votes, AI civs' respect (relation drift).

Old World proved "ruler standing = action economy" is the cleanest CK×Civ bridge; we implement the light version (no order caps — our maps are small enough) but keep the identity: **who your ruler is determines what your empire can do.**

## VI.2 The stat→map mappings (each one mission, each falsifiable)

| Character fact | Map effect | Status |
|---|---|---|
| Stewardship | +1%/pt tax income | ✅ SHIPPED (mission 10) |
| Diplomacy | alliance/peace acceptance threshold | 📄 BRIEF READY (mission 11) |
| Martial | combat strength bonus | ✅ wired (combat.py:166) |
| Martial | +levy size %, −unit upkeep | Wave 4 |
| Intrigue | scheme success; enemy plot detection | Wave 4 |
| Ruler trait Zealous | +2 faith/city, −10 relation with other-faith civs | Wave 4 |
| Ruler trait Greedy | +10% tax, −10 court opinion | Wave 4 |
| Ruler stress level | −5% all yields per level (a stressed ruler mismanages) | Wave 4 |
| Ruler age > 60 | event pool shifts (regency prep, deathbed) | Wave 5 |
| Golden age | +10% gold/science | ✅ wired |
| Era advance | golden age + legitimacy +10 | ✅/Wave 4 |

## VI.3 The map→character mappings (the reverse direction — this is what Old World underbuilt)

| Map fact | Character effect |
|---|---|
| War declared on you | ruler +stress/turn while at war if trait Craven or Calm; Wrathful rulers *lose* stress |
| City lost | −15 Legitimacy, timed opinion hit from court ("weak king"), rival event chance |
| Wonder/Dynasty Work completed | +prestige, +Legitimacy, courtier opinion +10, possible Content→Ambitious trait event for heir |
| Famine/plague event in city | ruler stress +, Zealous ruler gets "divine punishment" event chain |
| Tech era advance | heir education event (choose heir's 3rd trait — player shapes the next run) |
| Long peace (20+ turns) | Ambitious courtiers start factions; "idle swords" events |
| Treasury > 1000 | Greedy relatives demand gifts; theft schemes spawn |

## VI.4 Agendas — AI personality from character traits (free flavor, Civ research §7)

Every AI ruler's **agenda IS its trait set** — no separate system. Wrathful AI: attacks when relation < 0, respects martial > 12. Zealous AI: −20 relation with other faiths, +20 same faith. Greedy AI: always accepts trade, demands tribute when stronger. Content AI: never expands past 3 cities, hates warmongers. Agendas displayed on the diplomacy screen ("Basileus Andronikos is Wrathful and Zealous — he respects strength and shares your faith"). Diplomacy becomes a legible puzzle; AI "personality coherence" is the thing players actually praise.

## VI.5 The generational rhythm (session design)

A campaign is 2–4 generations. Each generation is a mini-arc with its own opening (succession pain → consolidate), middle (your ruler's traits shape strategy: a Genius Stewardship ruler is your economy window; a Brave Martial ruler is your conquest window), and end (aging events, heir prep, death). **The strategic meta-game is sequencing: what do I do with THIS ruler while they live?** That is the sentence a streamer says in minute one, and no other 4X delivers it.

---

# Part VII — Event Architecture & Content Plan

## VII.1 Unify the two event systems

Legacy `events.py` (13 resource events, weighted pool) and `game.py` CKEvent (5 choice events) merge into **one data-driven system** with the CK3/Old World architecture (CK research §3, §7):

- **Nothing fires spontaneously.** Events fire from **on_action hooks**: `on_turn_pulse` (weighted random deck, per-civ), `on_birth`, `on_death`, `on_succession`, `on_marriage`, `on_war_declared`, `on_war_ended`, `on_city_captured`, `on_city_founded`, `on_wonder_complete`, `on_era_advance`, `on_stress_threshold`, `on_scheme_discovered`, `on_golden_age`, `on_ruler_aged_60`.
- **Event = JSON record** (full schema in Appendix C): id, hook, trigger conditions (tests against game state), subjects (Old World-style slot-filling with tests: "adult courtier who is NOT heir and IS Ambitious"), weight factors (by trait/state), title/desc templates with `{subject}` interpolation, 2–4 options each with: costs/effects in **different currencies** (gold vs stress vs opinion vs trait vs legitimacy), optional trait gate ("[Brave] Fight him yourself"), optional trait-stress ("choosing this as Honest: +30 stress"), `ai_chance` weights, and optional `chain` (fire event X in 3–8 turns) + `memory` (write a flag/timed modifier later events test).
- Python engine: `EventEngine.fire(hook, context)` — one class, ~300 lines, replaces both systems. Legacy 13 events become 13 JSON records on `on_turn_pulse`.

## VII.2 What makes an event good (the content bar — every event PR is reviewed against this)

From CK dev commentary + Soren Johnson (CK research §3): a good event **(a)** is triggered by state the player caused, **(b)** names specific characters and their traits, **(c)** offers options with costs in different currencies, **(d)** has at least one trait-gated or trait-stressful option, **(e)** can leave a persistent marker later events test. Filler ("+50 gold or +50 prestige") is rejected at review.

## VII.3 Content targets & the CynCo content pipeline

**Target: 250–300 events at 1.0** (CK research: "with ~150–300 well-tested events over those hooks, players will start writing sagas — the systems do the storytelling"). Distribution:

| Hook family | Count | Examples |
|---|---|---|
| Turn pulse (ambient, trait-driven) | 80 | Drunkard ruler feast disaster; Greedy treasurer skims |
| Succession/death/regency | 35 | partition disputes, sibling rivals, regent loyalty |
| War/peace/conquest | 40 | war weariness protests, captured-city mercy choice (trait-gated) |
| Marriage/lover/bastard | 30 | affair discovery, betrothal politics, matrilineal negotiations |
| Scheme/rival/nemesis | 30 | murder fallout, duel challenges, blackmail |
| Stress/mental break | 15 | coping trait choices at 100/200/300 |
| Faith/zealotry | 25 | conversion demands, heresy, pilgrimage |
| Economy/building/wonder | 25 | wonder rivalries, famine relief (Generous gate) |
| Era/golden age/legacy | 20 | era transition dynastic moments, heir education |

**Pipeline (this is where CynCo shines):** events are *data*, so production is: (1) I write 3 exemplar events per hook family by hand (the quality bar), (2) each CynCo content mission = "add 10 events to family X" with the JSON schema + exemplars + a **schema validator** (`tools/validate_events.py`: schema check, id uniqueness, subject-test references exist, currency diversity check ≥2, trait-gate presence check) as the smoke gate, (3) I review each batch against VII.2 before commit. 30 content missions ≈ 300 events. The validator makes filler mechanically detectable (option effect sets that differ only in magnitude are flagged).

## VII.4 Writing quality

Event text is player-facing prose; local-model text needs a human pass. Budget: I (orchestrator) edit every event title/desc at batch review; tone guide (short, concrete, second person, dry wit; 40–80 words per desc) lives in `events/STYLE.md`. No lorem-ipsum ships.

---

# Part VIII — AI Design

The #1 named killer of indie 4X (At the Gates: "passive AI ruins a refreshing 4X experiment"). Our budget answer, from Civ research §7 — rules and personality, not cleverness:

1. **Difficulty = open economic multipliers** (+0/25/50/80% yields) + free starting units. Players accept this; it's the genre standard. Never hidden.
2. **Scripted opening build orders** per civ (first 15 turns: scout→warrior→settler-class sequencing). Fixes the most visible AI weakness for the cost of a data table.
3. **Hard behavior rules (the "never look stupid" list):**
   - Never declare war unless local strength ≥ 1.5× defender's (existing ai.py threat eval extends).
   - Sue for peace after losing N units or a city (war weariness readout).
   - Never leave capital ungarrisoned; always finish a started wonder if ≥60% done; never settle < 4 hexes from a foreign capital.
4. **Agenda diplomacy** (VI.4): relation drift table per trait; AI acceptance of proposals = civ relation + ruler opinion + agenda modifiers (mission 11 is the first brick).
5. **Strategic layer:** keep the existing priority-weight AIPlayer, add **one grand-strategy enum per AI ruler derived from best stat** (Martial→conquest, Stewardship→economy, Diplomacy→alliances, Intrigue→schemes) biasing all weights — the Civ V flavor-vector trick at 1% of the cost.
6. **AI uses the character layer:** AI rulers run Sway/Murder schemes against player courts (rate-limited), arrange marriages, and their succession crises are *player opportunities* (an AI partition = your invasion window). AI-side dynastic chaos is content for free.
7. **Turn-time budget:** AI turn ≤ 2s at map size (Python risk, Civ research complaint #5). Profile in the autoplay harness (Part XIII); hard perf gate per wave.

---

# Part IX — Pacing, Anti-Snowball & Session Design

- **Turn structure (pillar 4):** resolve phase (queued completions, events fire) → decision phase (2–5 prompts surfaced by a **"needs attention" queue**: idle city, idle unit, research done, event pending — clicking through them IS the turn) → end turn. First 50 turns tuned so something completes every 1–3 turns.
- **Speed knob:** one global cost multiplier (0.5× Quick / 1× Standard) — build it into the yield pipeline day one (trivial now, painful later).
- **Anti-snowball stack:** succession pain (V.5, the star), +5%/city tech tax, district cost by progress, war weariness, partition law until late-game. **Rubber-band via drama, not cheats:** the leader attracts scheme events, coalition agendas, and heir troubles — thematically coherent catch-up.
- **Endgame:** victory races resolve *fast* once triggered (Legacy needs 3 projects but each is 10–15 turns and announced world-wide — a race, not a countdown); turn cap 250 → score screen with dynasty chronicle (see X.4).
- **Decision density audit:** the autoplay harness logs decisions-prompted-per-turn; balance gate keeps the median in 3–6 through all eras.

---

# Part X — UX, UI, Audio & Polish

Civ VII shipped to Mostly Negative *largely on UI*. Indie forgiveness is lower. Scope, in priority order:

1. **Onboarding (the market's #5 killer):** guided first 20 turns as contextual tooltips tied to the needs-attention queue ("Your city can build — here's what production means"), not a separate tutorial mode. A `?` hotkey legend. Advisor summaries on the four victory tracks every era.
2. **The Dynasty screen is the flagship UI** — this is the differentiator, so it gets the polish budget: family tree with portraits, traits/opinions on hover, heir designation, marriage/scheme verbs, dynasty chronicle timeline. (Existing dynasty popup is the seed.)
3. **Needs-attention queue** (IX) — the single biggest busywork killer.
4. **End-of-game dynasty chronicle:** auto-generated timeline of the campaign's events ("Turn 34: Queen Irene murdered her rival... Turn 88: the realm split between three sons") — shareable screenshot = free marketing (streamer legibility).
5. **Audio:** wire the existing music_manager/sound_manager (era-shifting music beds ×5, ~25 SFX: end turn, battle, build complete, event sting, succession bell). Licensed/commissioned packs — do not compose. **But the audio library itself can be produced at near-zero cost by a local generative stack — see X.9, which turns "a solo dev can't afford 300 voiced event lines" into a batch job.**
6. **Settings screen:** volume, resolution/fullscreen, autosave cadence, speed, difficulty. Pause menu (save/load/settings/quit). These are Steam-review table stakes.
7. **Portraits & map art pass:** one consistent style (batch-commissioned or curated gen + human cleanup), trait icons, district icons. Placeholder art is allowed until Wave 9, then a single style unification pass.
8. **Copy-editing pass** over every player-facing string (I do this; local model text does not ship raw).

## X.9 The local generative audio & content stack (openmoss · thinksound.cpp · Lemonade)

*Added 2026-07-15 after evaluating three repos the user flagged. The unifying property — and the reason they matter to CivKings specifically — is that all three are **pure C++/GGML, single self-contained binary, fully offline** inference engines. This is the exact shape of dependency a $15 offline Steam game can actually ship. Cloud TTS/SFX/LLM cannot: they cost money per player, require an internet connection, need per-user API keys, and leak player data. A local GGML binary bundled in the install directory has none of those problems. This is the I.3 "CynCo advantage" argument applied to audio and flavor content.*

**The three engines:**

| Repo | What it is | What it gives CivKings |
|---|---|---|
| [`pwilkin/openmoss`](https://github.com/pwilkin/openmoss) | Standalone C++/GGML port of MOSS-TTS (Qwen3-8B backbone + RVQ codec) — `moss-tts-cli` (one-shot) + `moss-tts-server` (HTTP), **voice cloning**, Vulkan/ROCm/CUDA/CPU. ~10 s speech in ~4 s on a 16 GB GPU. | **Text→speech.** Voiced event narration, ruler/advisor lines, the dynasty chronicle read aloud. Voice cloning → a distinct, consistent voice per advisor/leader dynasty. |
| [`pwilkin/thinksound.cpp`](https://github.com/pwilkin/thinksound.cpp) | Standalone C++/GGML runtime for ThinkSound (NeurIPS 2025) — `ts-generate` / `ts-server`, **text→sound-effect**, 44.1 kHz stereo, BF16/Q8 GGUF. Also a Dasheng-AudioGen text→audio path. | **Text→SFX / ambience.** Event stings, battle/city/era soundscapes, per-event bespoke effects generated from the event's own description text. |
| [`lemonade-sdk/lemonade`](https://github.com/lemonade-sdk/lemonade) | Local AI server (AMD-optimized, but Vulkan/GPU/NPU/CPU); OpenAI/Anthropic/Ollama-compatible; multi-modal (chat, **speech gen**, image gen, embeddings); **"Embeddable Lemonade" = a portable binary you package into your app that auto-optimizes for the player's PC.** Already lists `openmoss` as a backend. | **The runtime host.** One embeddable binary that hosts TTS (openmoss), SFX, and an optional flavor-text LLM, auto-detecting the player's NPU/GPU/CPU and degrading gracefully. |

**Two deployment modes — the honest split that keeps this plan-consistent:**

- **Mode A — Build-time audio foundry (CORE, low-risk, recommended).** Run openmoss + thinksound on the *developer's* box (or a batch pipeline, same as the CynCo content pipeline in VII.3) to mass-produce the shipping audio library as ordinary compressed WAV/OGG assets: a voiced line for every one of the ~300 events, distinct cloned advisor/leader voices, five era ambience beds, and a far larger, more varied SFX set than a solo dev could license. The game ships **plain audio files — no model weights, no GPU requirement, no runtime dependency, no added system requirements.** This is a *production tool*, not a runtime feature, and it directly attacks the real deficit (II.3 content volume) the same way CynCo attacks the code and event deficit. Every generated clip still passes the VII.4 human editorial/quality bar before it ships (voice output is reviewed exactly like event prose is).

- **Mode B — Runtime local generation via Embeddable Lemonade (OPTIONAL, S4-gated differentiator).** Bundle Lemonade's portable binary; on capable NPU/GPU PCs, generate *truly per-run* content at play time — the dynasty chronicle (X.4) read aloud in an advisor's cloned voice, event flavor text authored by a local LLM and then voiced, event-specific SFX from thinksound — auto-optimized to the player's hardware, with **graceful fallback to the Mode-A pre-baked assets on any PC that can't run it.** This is the streamer/"wow" hook ("every game narrates its own dynasty's saga, out loud, differently"), but it is strictly additive: it never gates the core game and it lives behind an explicit post-S3 gate, honoring pillar 5 (no scope creep into the critical path).

**CivKings-specific payoffs (both modes read the systems we already have):**
- The **dynasty chronicle** (X.4) is already the shareable, streamer-legible artifact and the trailer storyboard (Part XIV). Reading it aloud — Mode A pre-bakes the stock lines; Mode B narrates the actual run — is the single highest-leverage use, because it amplifies the exact thing the market strategy is built on.
- Events already carry `title`/`desc` prose (Appendix C); that same text is the TTS prompt (voice) and the thinksound caption (SFX), so voiced-and-scored events are a *derivation* of content we're already producing, not new content.
- Voice cloning gives each of the 8 curated leader dynasties (Part VIII/III.2) a consistent voice — cheap character identity that reinforces the dynasty-first pillar.
- Bonus alignment: Lemonade is Anthropic/OpenAI/Ollama-compatible and already ships a Claude Code / Copilot integration, so the *same local-inference muscle that builds the game* (CynCo) can host its runtime content — the "an AI agent built this, and local AI runs inside it" dev-log angle (XIV) becomes literally true, two audiences one stack.

**Honest gates and costs (do not skip):**
- **Model licensing is a hard shipping gate.** Commercial redistribution of the underlying MOSS-TTS and ThinkSound weights (and any Lemonade-hosted model) must be license-verified *before* Mode A output ships in a paid product. Treat this as a blocking task, not a formality — it is the first mission of any audio-foundry work.
- Mode A adds **zero** runtime footprint but adds asset size (compressed audio) — budget it like any voiced game's audio bundle.
- Mode B needs a capable GPU/NPU and ships model weights (gigabytes) as an *optional* download, never in the base install; it must detect-and-degrade, never crash, on unsupported hardware.
- Quality is not free: local TTS/SFX gets the same human review pass as local text (VII.4). Nothing ships raw.

**Roadmap placement:** Mode A folds into **Wave 9** as an "audio foundry" batch (produce → editorial review → ship as assets), replacing the "licensed packs" assumption in X.5 with a near-zero-marginal-cost internal pipeline — but the licensing-verification mission gates it. Mode B is an **S4-gated experimental track** (post the S3 revenue signal), consistent with I.2's staged-on-evidence discipline and the Part XI port-gate philosophy.

---

# Part XI — Technical & Shipping Reality

- **Stay pygame through Early Access.** Precedent exists (DaFluffyPotato, Ren'Py commercial titles); players don't care about engines, they care about snappiness and crashes. **Port gate:** if S3 wishlist/revenue signals justify the $1M chase, port to Godot before 1.0 — turn-based hex logic and all JSON content transfer; the expensive assets (design, events, AI, balance) are engine-agnostic by construction.
- **Performance discipline:** map ≤ 34×34, AI ≤ 2s/turn, dirty-rect rendering or ModernGL if profiling demands; perf test in CI harness.
- **Packaging:** PyInstaller `--onedir` + Inno Setup installer + code signing (the `--onefile` antivirus false-positive trap is documented — avoid it). Test on a clean Windows VM.
- **Steamworks:** steamworks-py for overlay + cloud saves; achievements deferred to 1.0. Budget real integration time (bindings are patchy).
- **Save compatibility:** versioned save schema from Wave 1 (`"save_version": N` + migration functions); every wave's harness loads a previous-wave save.
- **Repo hygiene:** civkings stays its own repo (already gitignored from localcode); events/traits/techs move to `data/*.json`; delete stale COMPLETION_PLAN.md (user sign-off pending); dead `empire_manager.collect_taxes` removed in Wave 0 (evidence: live path is game.py:616; removal-evidence-first rule honored).

---

# Part XII — Production Roadmap: CynCo Mission Waves

The whole build is ~120 CynCo missions in 11 waves. Ground rules, from 10 landed missions and the failure log:

- **One mission = one focused change**, brief-pattern (whole-method verbatim replacements, single-line grep-verified anchors, backwards-compatible signatures, ast.parse + pytest + smoke + exact commit message). Fresh engine per mission (F7). Container types verified before freezing brief code (F8). Driver: `scripts/cynco-mission-driver.mjs`, forward-slash brief paths (F5 note).
- **Every mission** → ledger row in `benchmark/cynco-ledger/missions.jsonl` with governance signals, `verified` patched only after my independent diff+test+smoke review. This doubles as the governance falsification dataset (30–50 labeled missions unlocks step 2).
- **Every wave** ends with an **integration mission + wire-check**: grep every new symbol, prove it's called; run the autoplay harness; a human (user) plays one session. No wave starts while the previous wave's gate is red. (Memory: integration-verification and wire-check are BLOCKING.)
- Content missions (JSON data) may batch 10 records; code missions never batch.

## Wave 0 — Foundation fixes (8 missions) *— starts now; mission 11 is first*
1. **M11 (brief ready):** diplomacy stat gates alliance/peace acceptance.
2. Fix `city.py:483` building-faith container bug (+ regression test).
3. Wire government bonuses into calculate_yields + anarchy turns on change.
4. Wonder queue integration (wonders buildable via normal production UI path).
5. Remove dead `empire_manager.collect_taxes` (+ any other verified-dead paths, evidence-first).
6. Save-version field + loader migration scaffold.
7. Global speed multiplier plumbed through all cost/yield sites.
8. **Gate:** integration wire-check; 24→30 tests; user smoke session.

## Wave 1 — Verification infrastructure (5 missions) *— the harness pays for every later wave*
1. `tools/autoplay.py`: headless N-turn campaign runner, seeded, JSON telemetry (yields/era/decisions-prompted/AI timing per turn).
2. Telemetry assertions library ("no civ bankrupt by turn 50", "era 2 by turn 60±20", "AI turn <2s").
3. `tools/validate_events.py` schema validator (pre-built for Wave 5).
4. pytest suite expansion to ~60 tests (combat math, growth, succession, opinion stubs).
5. **Gate:** 200-turn autoplay completes green on 3 seeds.

## Wave 2 — Civ layer correctness (10 missions)
Growth formula; district cost formula + slots per pop; adjacency rules (one per district); +5%/city tech tax; combat damage curve + wounded penalty; unit triangle rebalance (data); war weariness completion (→happiness+stress); gold purchase; victory cut to 4 + Legacy projects; World Rankings panel. **Gate:** autoplay pacing telemetry in band; user session.

## Wave 3 — Character model v2 (10 missions)
32 traits (data + effects); trait event-gating engine hooks; congenital line + inheritance upgrade; stress thresholds → mental break events; opinion ledger core; ledger consumers (tax/levy/plots/votes); relations (friend/rival/lover/nemesis) + mechanical teeth; heir education on era advance; character UI v2 (tree, hovers). **Gate:** opinion round-trip tests; user session.

## Wave 4 — Interaction layer (12 missions)
Legitimacy yield (sources/drains/reads); stat→map mappings table (VI.2 rows not yet shipped); map→character mappings (VI.3, ~7 missions of one-row-each); stress→yield penalty; agenda system from traits; succession pain v2 (partition costs, sibling rivals, short-reign penalties); marriage as player verb. **Gate:** every VI.2/VI.3 row has a falsifiable test proving BOTH directions; user session.

## Wave 5 — Event engine unification (8 missions)
EventEngine + on_action hooks; JSON schema + loader; migrate 13 legacy + 5 CK events to data; chains + memory flags; subject slot-filling with tests; event UI polish (portraits in event popup); Murder + Sway schemes on the new engine; scheme UI tab. **Gate:** validator green; all hooks fire in autoplay; 40+ events live.

## Wave 6 — AI competence (8 missions)
Difficulty multipliers (open); scripted openings per civ; the never-look-stupid rule set (3 missions); grand-strategy enum from ruler stats; AI schemes/marriages vs player; AI turn perf pass. **Gate:** autoplay: AI wins ≥30% of 6-civ games at equal difficulty; zero "stupid rule" violations logged.

## Wave 7 — Content sprint I (15 missions, batched data)
Tech tree 25→40 with eurekas for all; buildings 15→30; units→24; wonders→12; events to 150 (pulse/succession/war families). Each batch: validator + my editorial review. **Gate:** content bar review; autoplay with full content.

## Wave 8 — Content sprint II (15 missions)
Events 150→300 (remaining families); civs curated to 8 with leader dynasties + agendas; trait icon/text pass; STYLE.md conformance edit. **Gate:** two full user campaigns, chronicle output reviewed.

## Wave 9 — UX/audio/polish (12 missions)
Needs-attention queue; onboarding tooltips (first-20-turns script); dynasty screen flagship pass; chronicle screen + screenshot export; audio wiring + **audio foundry** (Mode-A pre-baked voiced-event + SFX assets via openmoss/thinksound — license-verification mission first, X.9); settings + pause menu; art style unification; copy edit. **Gate:** a stranger plays 30 minutes with zero verbal help (the real tutorial test). *(Runtime generative narration = Mode B, S4-gated track, X.9 — not in this wave.)*

## Wave 10 — Balance & pacing (8 missions + play cycles)
Autoplay sweeps across seeds/difficulties; decision-density tuning; snowball metrics (leader yield share over time); victory timing tuning (all 4 paths land turns 120–220); difficulty curve; 100-turn crash-free soak ×20 seeds. **Gate:** telemetry bands green; 5 external playtesters.

## Wave 11 — Ship prep (8 missions)
PyInstaller onedir + installer + clean-VM test; Steamworks integration; demo build (80-turn cap, 4 civs); Steam page assets (chronicle-driven trailer script, capsule brief); wishlist instrumentation; Next Fest checklist; EA roadmap doc; save-compat final audit. **Gate:** S2 launch (page + demo live).

**Cadence reality check:** at the demonstrated 3–6 missions/day with verification, ~120 missions ≈ 5–8 weeks of mission time; content review and play-gates are the human bottleneck, not CynCo throughput. Waves 2/3 can interleave (different files) — but never two missions in flight at once (single engine, F7).

---

# Part XIII — Verification & Quality Infrastructure

- **Per mission:** ast.parse → full pytest → mission-specific smoke script (mandatory in every brief — it's what converts brief bugs into CynCo self-repairs, F8) → orchestrator full-diff review classifying deviations (cosmetic | fix | drift) → ledger row.
- **Per wave:** wire-check (grep every new symbol for a caller), autoplay harness green on 3+ seeds, save-load round-trip from previous wave, user play session with notes filed as issues.
- **Continuous:** failure log discipline (every CynCo failure gets an F-entry with harness improvement); ledger labeling toward the 30–50-mission governance falsification threshold; test count target ~150 by Wave 10.
- **Balance telemetry bands (the falsifiable pacing spec):** median decisions/turn 3–6 all eras; ≥1 completion per 1–3 turns through turn 50; era timing 60±20/110±25/160±30; leader yield share < 40% at turn 150 in 4-way autoplay; AI turn < 2s.

---

# Part XIV — Market & Launch Strategy

- **Positioning:** "Every empire dies of natural causes." Dynasty-first 4X, one-evening campaigns. Never pitch as "Civ meets CK" (Old World owns it); pitch *against* Old World's known gap: real CK-depth characters on a deliberately simple map.
- **Steam page (Wave 11):** capsule shows a *character over a map* (not a map); 6 screenshots: dynasty tree, event choice with trait-gated option visible, war, chronicle, rankings, city. Trailer = one dynasty's story in 60 seconds (chronicle screen is the storyboard).
- **Demo + Next Fest:** the single most reliable wishlist engine for strategy. Demo = 80 turns / 1 generation — ends exactly at the first succession (the hook cliffhanger).
- **Wishlist ladder (Zukowski/GameDiscoverCo benchmarks):** 7–10k = Popular Upcoming = S2 gate passed; first-week ≈ 12–27% of wishlists; year-one ≈ 2–4× launch week. 30–50k = publisher conversation (Hooded Horse-class) + port decision.
- **Early Access playbook (Against the Storm pattern):** enter EA only when the loop is demonstrably fun (Wave 10 gate); visible biweekly updates (our mission cadence makes this trivially sustainable — publish the changelog straight from the ledger); community event modding opened early (JSON events = free content flywheel + the CK-mod-community draw).
- **Content marketing:** the dynasty chronicle screenshot is the shareable artifact; dev-log angle "an AI agent is building this game, every change verified" is itself a story for the LocalCode audience — two audiences, one build.
- **Timing:** Civ VII's Mostly Negative reception has left 4X players visibly hungry (market §6) — the 2026–27 window is genuinely open.
- **Revenue framing (repeat of I.2 so it can't be unseen):** plan for $50–250k (top decile of seriously-marketed indie strategy); treat $1M as the funded tail behind explicit S3 gates.

---

# Part XV — Risk Register

| # | Risk | Likelihood | Mitigation |
|---|---|---|---|
| 1 | AI looks stupid at launch | High (genre base rate) | Wave 6 rule set + agendas; autoplay win-rate gate; avoid 1UPT entirely |
| 2 | Event content reads as filler/AI-slop | Medium | VII.2 bar + validator + human editorial pass on every batch; exemplars first |
| 3 | Python perf on big late-game turns | Medium | Small maps, perf gates, ModernGL fallback, port gate |
| 4 | PyInstaller antivirus false positives | High if --onefile | --onedir + installer + signing, clean-VM test (known trap, pre-mitigated) |
| 5 | Scope creep past the 5 pillars | High (it's us) | Pillar tie-break rule; III.4 cut list is a contract; waves are closed sets |
| 6 | CynCo mission quality regression | Low-Medium | Failure log discipline; fresh-engine rhythm; verification stack unchanged |
| 7 | Orchestrator (human-review) bottleneck | Medium | Content batching, validator automation; accept cadence limit — quality IS the product |
| 8 | "Old World already exists" positioning failure | Medium | Dynasty-first differentiation, session length, price point, moddability |
| 9 | Interaction layer feels like two bolted games | Medium | VI's both-directions rule with falsifiable tests per mapping; user play gates every wave |
| 10 | $1M expectation vs 1.5% base rate | — | Staged gates (I.2); success case honestly defined as $50–250k |
| 11 | Generative-audio model licensing blocks commercial ship | Medium | X.9 licensing-verification is a *blocking* first mission before any foundry output ships; Mode A ships only plain reviewed WAV/OGG assets; fall back to licensed packs if weights aren't commercially clearable |
| 12 | Runtime local generation (Mode B) hurts perf / fails on weak PCs | Low (it's optional) | Mode B is S4-gated, ships as optional download, auto-detects NPU/GPU/CPU and degrades to Mode-A pre-baked assets; core game never depends on it |

---

# Appendix A — Formula Cheat Sheet (adopt verbatim, tune constants only)

```
growth_food_needed(n)   = 15 + 8*(n-1) + (n-1)**1.5        # n = current pop
citizen_food_upkeep     = 2 / citizen / turn
district_cost           = 60 * (1 + 9*P)                    # P = researched fraction of tech tree
tech_cost_penalty       = 1 + 0.05 * (num_cities - 1)
combat_damage           = 30 * exp(dStrength/25) * uniform(0.75, 1.25)   # of 100 HP
wounded_penalty         = up to -33% strength at low HP
flanking                = +2..+5 per adjacent friendly (keep existing +5/extra attacker)
war_weariness           = battle: EraBase*(1|2 home/abroad); death: 3*EraBase;
                          -1 happiness / 400 pts; decay 50/turn war, 200/turn peace; -2000 on peace
eureka_boost            = 0.40 * tech_cost
opinion(a,b)            = Σ static (traits ±10..20, dynasty +5, faith -10/-20, diplomacy -8..+12)
                        + Σ timed (decay ~1/turn to 0) + relations (friend +60, rival -60, x2 escalated)
scheme_success          = clamp(base + schemer_intrigue*2 - target_intrigue*2 + agents*5, 5, 95)
stress_thresholds       = 100 / 200 / 300 → mental break events; fertility -10/-30/-50%
legitimacy              = 0..100; succession -20; lost city -15; won war +10; era advance +10
speed_multiplier        = one global scalar on all food/production/science costs
```

# Appendix B — CynCo Mission Brief Template & Checklist

```
1. One-paragraph WHY (player-visible symptom + root cause + file:line).
2. Per edit: file, ENTIRE method/block replacement, single-line unique anchor
   (grep-verified 1 occurrence), verbatim final code.
3. "Do not change anything else." + explicit do-NOT-edit file list (protect callers).
4. Verification: ast.parse command; pytest command + expected count;
   smoke script (python -c) asserting the new behavior end-to-end, printing OK.
5. Exact commit command/message (marker string for the driver).
Author checklist before dispatch:
[ ] every container type in new code verified against its annotation (F8)
[ ] anchors grep'd unique; forward-slash brief path (F5)
[ ] default-arg signatures protect untouched callers
[ ] fresh engine, zombies killed AND verified dead (llama-server survives bun)
[ ] marker + 900s timeout in driver invocation
After landing: full-diff review (cosmetic|fix|drift), patch ledger verified:true.
```

# Appendix C — Event Data Schema (v1)

```json
{
  "id": "succ.partition_dispute_01",
  "hook": "on_succession",
  "trigger": {"law": "partition", "living_siblings_gte": 2},
  "subjects": {
    "rival_sib": {"pool": "ruler_siblings", "tests": ["is_adult", "not_heir", "trait:Ambitious|Greedy"]}
  },
  "weight": {"base": 100, "mult": [{"if": "ruler.trait:Content", "x": 0.5}]},
  "title": "The Inheritance of {rival_sib}",
  "desc": "Your {rival_sib.trait_adj} sibling {rival_sib} demands the city of {city}...",
  "options": [
    {"text": "Grant it. Blood is blood.", "effects": {"lose_city_to": "rival_sib", "opinion": {"rival_sib": 30}, "legitimacy": -5}},
    {"text": "[Diplomacy 12+] Offer gold and a council seat instead.", "gate": {"stat": "diplomacy", "gte": 12},
     "effects": {"gold": -200, "court_appoint": "rival_sib", "memory": {"flag": "bought_off_{rival_sib}", "decay": 40}}},
    {"text": "Refuse. Let them scheme.", "effects": {"opinion": {"rival_sib": -40}, "relation": {"rival_sib": "rival"},
     "stress_if_trait": {"Craven": 30}, "chain": {"id": "succ.sibling_plot_01", "turns": [5, 12]}}}
  ],
  "ai_chance": [40, 40, 20]
}
```

Validator enforces: schema, id uniqueness, referenced tests/effects exist, ≥2 distinct effect currencies across options, ≥1 gated or trait-stressful option per event (VII.2 bar, mechanically checked).

# Appendix D — Backlog Index

Wave 0: M11 diplomacy-acceptance · building-faith bug · government bonuses · wonder queue · dead-code removal · save versioning · speed knob · W0 integration gate.
Wave 1: autoplay harness · telemetry asserts · event validator · test expansion · W1 gate.
Wave 2: growth · district cost/slots · adjacency ×7 · tech tax · combat curve · unit triangle · war weariness · gold purchase · victory-4 + Legacy · rankings panel · W2 gate.
Wave 3: traits-32 · trait gating · congenital · stress breaks · opinion core · opinion consumers · relations · heir education · character UI · W3 gate.
Wave 4: legitimacy · stat→map ×4 · map→char ×7 · stress-yield · agendas · succession-pain · marriage verb · W4 gate.
Wave 5: EventEngine · schema/loader · migration · chains/memory · subjects · event UI · schemes ×2 · scheme UI · W5 gate.
Wave 6: difficulty · openings · rules ×3 · grand strategy · AI schemes · perf · W6 gate.
Waves 7–8: content batches (techs, buildings, units, wonders, events ×~20 batches, civs-8, style pass) · gates.
Wave 9: attention queue · onboarding · dynasty screen · chronicle · audio wiring · audio foundry (license check → openmoss/thinksound pre-baked assets, X.9) · settings/pause · art pass · copy edit · W9 gate. (Mode-B runtime generation = separate S4 track.)
Wave 10: balance sweeps ×6 · soak · external playtest · W10 gate.
Wave 11: packaging · Steamworks · demo · page assets · trailer · Next Fest · EA roadmap · save audit · S2 launch.

---

*End of master plan. Supersedes civkings/COMPLETION_PLAN.md. Living document: wave gates update this file; the ledger is the ground truth for what actually shipped.*



