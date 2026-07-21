# CivKings — Deep Systems Specification (the "why it's shallow, here's the real design")

**Status:** design source-of-truth. Every CynCo mission brief (M18+) is generated from a
section here. Companion to `civkings-master-plan.md` — where the master plan says *what*,
this says *exactly how*, with numbers.

**Prime directive from the owner:** "Same as Civilization. Length depends on map size and
number of AI. Focus on expanding. Go far deeper than you'd ever think to."

**Root failure this document fixes:** the audit proved the game is a skeleton — cities emit
three hardcoded yields (`city.py:204-211`), tile resources are generated but never read
(`game.py:159`), settlers cost a flat 100 forever (`game_data.py:504`), the good combat
formula is orphaned (`combat.py:resolve_combat` only called from GUI), and the whole
Crusader-Kings layer is decorative. None of it is *gated* or *wired together*. That is why a
game ends by turn 11-28. Depth is not decoration — depth is the set of interacting costs and
feedback loops that make each turn a decision.

---

## PART 0 — THE SCALING MODEL (map size × civ count → game length)

Civilization's genius: the *clock* is set by the map, the *economy* is set by per-city and
per-population curves. We copy that split exactly. Map size sets how long the game runs and
how much room there is to expand; the economic curves (growth cost, tech cost, maintenance)
are per-entity and therefore self-scale with whatever empire you actually build.

### 0.1 Map presets (width × height, ~65% land)

| Preset    | Dims   | Tiles | Land ≈ | Civs | Expected total cities |
|-----------|--------|-------|--------|------|-----------------------|
| Duel      | 16×16  | 256   | 166    | 2    | ~7                    |
| Tiny*     | 24×24  | 576   | 374    | 3    | ~15                   |
| Small     | 32×32  | 1024  | 666    | 4    | ~27                   |
| Standard  | 40×40  | 1600  | 1040   | 6    | ~42                   |
| Large     | 52×52  | 2704  | 1758   | 8    | ~70                   |
| Huge      | 64×64  | 4096  | 2662   | 10   | ~106                  |

\*Tiny (576 tiles, 3 civs) is the **reference profile** used to anchor all constants.
"Expected total cities" = `land_tiles / TILES_PER_CITY`, with `TILES_PER_CITY = 25`
(a city with min-spacing 4 effectively controls ~25 land tiles once borders settle).

### 0.2 The clock: derive turn budget from area

```
reference_area = 576
pace           = sqrt(map_area / reference_area)      # Tiny = 1.0
turn_budget    = round(250 * pace)                    # the full-game length
```

| Preset | pace | turn_budget |
|--------|------|-------------|
| Duel   | 0.67 | 167 |
| Tiny   | 1.00 | 250 |
| Small  | 1.33 | 333 |
| Standard | 1.67 | 417 |
| Large  | 2.17 | 542 |
| Huge   | 2.67 | 667 |

**Derived clock constants (all computed once at `Game.__init__`, stored on `GameState`):**
```
game.pace              = pace
game.turn_budget       = turn_budget
game.min_victory_turn  = round(0.30 * turn_budget)    # earliest any victory may fire
```
- `min_victory_turn`: Tiny=75, Standard=125, Huge=200. (M18 currently hardcodes 60 — M18b
  replaces that literal with `self.state.min_victory_turn`.)
- At `turn == turn_budget` with no winner, a **Score victory** fires for the highest-score
  civ (Civ's guaranteed terminator). Score = weighted sum (see §6.3).

### 0.3 What scales with the map vs. what scales with the empire

- **Scales with MAP (the clock):** `min_victory_turn`, `turn_budget`, Score-victory turn,
  number of AI, amount of land to fill. Everything time-related.
- **Scales with the EMPIRE (the economy — per-city / per-pop, so auto-scaling):** food-to-grow
  cost, tech/civic cost multiplier from city count, gold maintenance, settler cost escalation,
  border-expansion culture cost, happiness pressure. These do **not** read map size directly —
  they read *your* city count and population, which is exactly how Civ keeps a Huge map and a
  Duel map both balanced with one rule set.

This resolves the owner's requirement cleanly: **you never hand-tune per map size.** You tune
one reference profile; the split makes every map correct.

---

## PART 1 — THE EXPANSION CORE  *(deepest section; this is the game)*

Expansion in a 4X is not "press settle." It is the loop: **evaluate a site → pay an escalating
settler cost that shrinks a city → found → the city works tiles bounded by population →
population grows on a rising food curve → borders creep outward on culture → each new city
raises maintenance, unhappiness, and the cost of every tech.** Every one of those is a brake or
an accelerator. Ours currently has none of them.

### 1.1 Tiles: terrain, features, resources, improvements

The map tile is the atom of the economy. Every tile yields a vector
`(food, production, gold, science, culture, faith)`. Today `city.calculate_yields` never
reads tiles at all — this is the single biggest hole.

**Base terrain yields** (food / prod / gold):

| Terrain     | F | P | G | Notes |
|-------------|---|---|---|-------|
| Grassland   | 2 | 0 | 0 | growth land |
| Plains      | 1 | 1 | 0 | balanced |
| Tundra      | 1 | 0 | 0 | poor |
| Desert      | 0 | 0 | 0 | dead unless river/oasis/resource |
| Snow        | 0 | 0 | 0 | dead |
| Coast       | 1 | 0 | 1 | worked from a coastal city |
| Ocean       | 1 | 0 | 0 | |
| Mountain    | – | – | – | impassable; +adjacency (see wonders/districts) |
| Lake        | 2 | 0 | 1 | fresh water |

**Terrain modifiers**
- **Hills**: +1 P, and set minimum defensive terrain bonus (see §3). A grassland-hill = 2/1/0.
- **River adjacency**: +1 G to the tile and grants **fresh water** to a city founded on it
  (raises food/housing).
- **Fresh water** (river/lake/oasis adjacency): enables early Farms and higher housing cap.

**Features** (sit on terrain, alter yields and movement):

| Feature       | Δ yield | Notes |
|---------------|---------|-------|
| Forest        | +1 P    | choppable for one-time production; blocks farm until cleared |
| Jungle        | +1 F (later +science w/ tech) | slows movement |
| Floodplains   | +2 F    | desert-on-river only |
| Oasis         | +3 F +1 G | desert only, cannot improve |
| Marsh         | −1 F    | drainable |

**Resources** (three classes; a resource multiplies a tile's value and gates content):

- **Bonus** (Wheat, Cattle, Sheep, Deer, Fish, Bananas, Stone): +1–2 to a yield when the
  matching improvement is built (Wheat+Farm → +1F; Cattle+Pasture → +1F; Stone+Quarry → +1P;
  Fish+Fishing Boats → +2F/+1G).
- **Luxury** (Wine, Silk, Spices, Incense, Dyes, Furs, Ivory, Gold-ore, Silver, Pearls, Gems):
  +2–3 G **and** grant empire **Amenities/Happiness** — each *distinct* luxury type you control
  = **+4 happiness, counted once** (§1.6). This is the core reason to expand toward luxuries.
- **Strategic** (Horses, Iron, Coal, Niter, Oil, Uranium): required to *build or upgrade*
  specific units/buildings; consumed/reserved per unit. Gates the military tech ladder to the
  map (you must expand or trade to wage certain wars). Store as `game.strategic_stock[civ]`.

**Improvements** (built by Workers, add yields on top of terrain/feature/resource):
Farm (+1F, +1F more with fresh water at Civil Service; +1F at Fertilizer), Mine (+1P on
hills/resource; +1P at later techs), Pasture/Camp/Plantation/Quarry/Fishing-Boats (activate the
matching resource), Lumber Mill (+1P on forest), Trading Post (+1G, +1 more at later civics),
Road (movement + trade-route gold). Improvements are gated by tech.

**Data wiring:** these belong in `game_data.py` as three tables — `TERRAIN_YIELDS`,
`FEATURE_YIELDS`, `RESOURCE_DEFS` (class, activating improvement, yield delta, amenity value,
strategic flag) — and a per-tile record `Tile{terrain, feature, resource, improvement, river,
fresh_water, owner_city}`. The map generator (`game.py:159` region) must populate
feature/resource/river, not just a flat 20%-chance resource string.

### 1.2 City sites & the cost of founding

**Minimum city spacing:** a new city center must be **≥ 4 tiles** (hex distance) from any
existing city. `_find_safe_tile` must enforce this (today `min_dist=3` is passed ad hoc and
there is no enforcement in `found_city`).

**Settler cost escalation** (kills the turn-11 spam directly):
```
settler_production_cost = 100 * (1 + 0.30 * settlers_produced_by_civ)   # +30% each
```
So settlers cost 100, 130, 160, 190… per civ. Track `civ.settlers_produced`.

**Settlers consume population** (Civ V rule — the deepest single brake): producing a Settler
reduces the founding city's population by **1** (or the build cannot complete if pop would drop
below 1). This means every expansion *directly* trades away worked tiles and growth. This one
rule is what makes "settle a 4th city" a genuine decision instead of a free win.

**Founding cost:** `−`(one-time) does not need extra gold; the pop + production cost is the
real price. New city starts at **population 1** on its center tile (not 3), so a fresh city is
weak and must grow — you cannot instantly convert land into a 12-city empire.

**City-site evaluation (for the founding UI hint and the AI, §5):** score a candidate tile:
```
site_score = fresh_water_bonus(6 if adjacent river/lake else 0)
           + sum(best-2-tiles food potential) * 2
           + adjacent_luxury_count * 8
           + adjacent_strategic_count * 5
           + coastal_bonus(3)
           - crowding_penalty(2 per existing city within 5 tiles)
```

### 1.3 Working tiles: citizens, radius, ownership

- **Workable radius:** a city can work tiles within **radius 3** (its "fat cross"). Tiles must
  be **owned** by that city (borders, §1.7) and not worked by another city.
- **Citizens:** the city auto-works its **center tile** for free, then assigns **one citizen
  per population** to the best available owned tile *or* to a **specialist slot** in a building.
- **Tile assignment algorithm** (`City.assign_citizens`): greedily place each citizen on the
  unworked owned tile with the highest weighted yield, weights configurable per "focus"
  (default balanced; focuses = Food / Production / Gold / Science). Recompute whenever pop,
  borders, or improvements change.
- **Specialists:** buildings provide specialist slots (e.g., Library → 1 Scientist slot). A
  specialist yields fixed output (Scientist +3 science) instead of a tile, and generates
  Great-Person points (future system). Specialists are how a *tall* city keeps scaling after it
  runs out of good tiles.

This replaces the flat `population * 0.5 science` etc. with **output = Σ worked-tile yields +
Σ specialist yields**, then modified by buildings/government (§1.10, §1.4).

### 1.4 The yield pipeline (authoritative order of operations)

`City.calculate_yields()` must compute, in this exact order, per yield type:
```
1. base   = center-tile yield + Σ(worked owned tiles) + Σ(specialists)
2. flat   = base + Σ(building flat adds)               # e.g. Granary +2 food
3. total  = flat * Π(building %-multipliers)           # e.g. Library +25% science
4. total *= government multiplier (§ government)         # e.g. Republic +? science
5. total *= golden-age / legitimacy modifiers (§4)
6. total *= game.speed_multiplier                        # global tuning knob (already exists)
```
Percentages are multiplicative on the post-flat subtotal (Civ V order), so buildings that add
%-yields are *worth more in bigger cities* — the fundamental tall-city reward.

**Illustrative city** (pop 6, grassland+river start, Library+Granary+Market, no specialists):
worked tiles → 8F/5P/3G/0S; Library adds +25% S on the science from specialists/tiles (needs a
science source, e.g., a Jungle+tech or specialist), Granary +2F flat, Market +25% G. Result is
a *earned* number that varies by *where* you settled — which is the entire point.

### 1.5 Growth: the food curve that makes size 12 hard

- **Consumption:** each citizen eats **2 food/turn**. `consumption = 2 * population`.
- **Surplus** = `food_yield − consumption`. Surplus fills the growth basket.
- **Food to grow to next pop** (the anti-shallow curve, Civ V):
  ```
  food_to_grow(n) = 15 + 8*(n-1) + (n-1)^1.5        # n = current population
  ```
  n=1→15, n=5→~54, n=10→~124, n=15→~165. Growth *decelerates hard*; going from 10→11 takes many
  turns of surplus, so a size-12 city is a mid/late-game achievement, not a turn-20 default.
- **Starvation:** if surplus < 0, drain the basket; at empty basket, lose 1 population.
- **Housing / food cap** (soft cap on growth so tall isn't infinite): `housing = base(2) +
  fresh_water(+3) + buildings(Granary+2, Aqueduct+4, Sewer+2) + improved-tiles/2`. When
  `population >= housing − 1`, growth slows ×0.5; at `population >= housing`, growth halts.
  Housing forces you to *invest* (buildings/improvements) to keep a city growing — depth.
- Replaces the current flat `consumption = population * 1.5` and unconditional +1 pop.

### 1.6 Happiness / Amenities — the hard brake on WIDE expansion

Empire-wide happiness (Civ V model, simplest strong brake):
```
happiness =  palace_base(9)
          +  Σ distinct luxuries * 4
          +  Σ happiness buildings (Colosseum +3, Temple +2, ...)
          +  government / policy bonuses
unhappiness = Σ over cities of ( CITY_BASE(3) + population * UNHAPPY_PER_POP(1) )
            + occupied/annexed-city penalty
net = happiness − unhappiness
```
Effects of `net`:
- `net >= 0`: normal.
- `-1 .. -9` (Unhappy): city **growth ×0.25**, combat −? .
- `<= -10` (Very Unhappy): growth **halts empire-wide**, production penalty, revolt risk.
This is the reason you *can't* found 12 cities early: each city is +3 base +N/pop unhappiness,
and you have no luxuries yet. You must expand *toward luxuries* and *build* happiness — trade
off wide vs. stable. This is the missing soul of expansion.

### 1.7 Borders & culture-driven tile ownership

- A new city owns its center + the **6 adjacent tiles** (radius 1).
- The city accumulates **culture**; when the basket fills it **claims the highest-value
  unowned tile within radius 3**, expanding borders one tile at a time.
  ```
  culture_to_claim(t) = 10 + 6 * (tiles_owned_beyond_first)^1.1
  ```
- Tiles can also be **bought with gold** (`buy_tile_cost = 50 + 5 * tiles_owned`).
- Borders create **contested space** between civs (the reason wars start), and gate which tiles
  a city may work (§1.3). Today there is no tile ownership at all — cities are points.

### 1.8 City maintenance — gold upkeep that punishes over-expansion

```
per_city_maint(i) = BASE(2) + distance_from_capital(i) * 0.15
empire_city_maint = Σ per_city_maint  (roughly super-linear because distant cities cost more)
building_maint    = Σ building.gold_maintenance
unit_maint        = Σ unit.gold_maintenance      (already exists, game.py:625-634)
net_gold_per_turn = Σ city gold yields + taxes − (city + building + unit maint)
```
If treasury hits 0 and net is negative, **disband** the most expensive unit or sell a building
(Civ's bankruptcy rule). Distant sprawl now *costs* — the Civ IV lesson the audit flagged as
entirely missing (cities cost 0/turn today).

### 1.9 Tall vs. wide — cost scaling with city count

Two civ-count taxes make WIDE a real trade-off, not a strict win:
```
tech_cost_multiplier  = 1 + 0.05 * (num_cities - 1)      # +5% per extra city (master plan)
civic_cost_multiplier = 1 + 0.05 * (num_cities - 1)
```
Applied in `TechManager.get_cost` and the culture/civic system. A 10-city empire researches each
tech at 1.45×, so wide must out-*produce* its own tax. Combined with §1.6 happiness and §1.8
maintenance, this yields the classic **tall (few strong cities) vs. wide (many, taxed) vs.
forward-settle-for-luxuries** strategic triangle. That triangle *is* 4X depth.

### 1.10 Buildings — multiplicative, maintained, gated

Rework building effects from "flat add" to the layered model (§1.4):

| Building | Effect | Maint | Tech gate |
|----------|--------|-------|-----------|
| Granary  | +2 F flat, +2 housing | 1 | Pottery |
| Library  | +25% S, 1 Scientist slot | 1 | Writing |
| Market   | +25% G | 0 | Currency |
| Temple   | +2 Faith, +2 happiness | 1 | (faith tech) |
| Aqueduct | +4 housing | 1 | Engineering |
| Workshop | +25% P | 1 | (metal tech) |
| University | +33% S, 2 Scientist slots | 2 | Education |
| Bank     | +25% G (stacks after Market) | 2 | Banking |
| Colosseum | +3 happiness | 1 | Construction |
| Factory  | +50% P | 3 | Industrialization |

**Wonders** must give *ongoing* effects, not the current one-time lump (`city.py:506-514`):
e.g., Pyramids → +25% worker build speed empire-wide; Great Library → +1 Scientist slot +free
tech; Hanging Gardens → +6 housing +1 growth. One of each per game, globally.

### 1.11 Production — costs scale by era, with overflow

- **Cost curve:** unit/building base costs **roughly double per era** (unit line 40 → 90 →
  180 → 360 → 720). `production_cost_effective = base * era_factor` where era_factor doubles
  per era after the unit's home era, so an Ancient unit stays cheap late but is obsolete.
- **Overflow:** leftover production when an item completes **carries to the next item**
  (capped at that item's cost) — no waste. Today production resets to 0 (waste).
- **Purchasing:** allow gold-buying a build at `gold = 4 * remaining_production` (Civ V), gated
  by a building/market — a sink for the gold economy.

### 1.12 Districts (optional deeper layer, Wave D)

For full Civ VI parity later: specialized tiles (Campus/Commercial/Industrial/Holy/Theater)
with **adjacency bonuses** (Campus +science next to Mountains/Jungle) and cost that scales with
tech progress `60 * (1 + 9*fraction_of_tree_researched)`. This makes *where* you place buildings
matter. Spec'd here; sequenced last because it presupposes tiles+yields (§1.1-1.4) exist.

---

## PART 2 — TECH & RESEARCH DEPTH

- **Tree size:** grow from ~25 techs to **~56 techs, 8 per era across 7 eras** (Ancient →
  Information), a real prerequisite DAG (each tech 1–3 prereqs), so beelining trades breadth for
  depth. Data lives in `game_data.py:TECHNOLOGIES`.
- **Cost curve:** costs ~double per era; Modern techs cost ~15–20× an Ancient tech. Science
  income (from population/specialists/Libraries, §1.3-1.4) is the throttle — you cannot outrun
  the curve without a real economy.
- **Era = the coarse clock:** `get_current_era` = highest era with **≥ 3 techs researched**
  (not "any one tech"). This makes "reaching Medieval" a milestone, gating victories (§6) and
  content.
- **Science victory** already fixed in M18 to require `completed_era(MODERN)` (the *entire*
  Modern tier). Extend later to add a multi-turn **Spaceship project** (build parts → launch →
  N-turn flight) so even completing the tree is a visible late-game arc, not an instant flip.
- **Eurekas:** keep, but each triggerable once; they shave ~30–50% off *one* tech, meaningful
  but not game-breaking (audit noted they're currently too easy to farm — tie each to a
  genuinely era-appropriate action).

---

## PART 3 — MILITARY & COMBAT DEPTH

The sophisticated formula already exists (`combat.py:resolve_combat`) and is **orphaned**. Wave B
wires it in and adds the two missing pillars: real HP attrition and city capture.

### 3.1 Units
- **Categories** with a rock-paper-scissors triangle: **Melee, Anti-cavalry (spear), Ranged,
  Cavalry, Siege, Naval, Recon, Support(Settler/Worker/Medic)**. Fill the gaps the audit found
  (no clean anti-cav line; only 16 units).
- **Era ladder & obsolescence:** each combat role has one unit per era (Warrior→Swordsman→
  Man-at-Arms→Musketman→Infantry→…). Building the newer unlocks *upgrading* the old for gold.
- **Stats:** `strength, ranged_strength, range, movement, hp(100), maintenance, req_tech,
  req_strategic_resource`.

### 3.2 Combat resolution (wire `resolve_combat` into the turn/action loop)
- **Melee vs melee:** compare `strength * Π(modifiers)`; damage to each ∝ strength *difference*;
  **both take damage** (no instant delete). Modifiers: terrain (hills/forest +defense),
  fortify (+25% first turn, +50% after), flanking (+10% per adjacent friendly), ruler **martial**
  (`1 + martial/100`, already in the formula), promotions, counter bonuses (spear vs cav +100%,
  etc.).
- **Ranged:** attacker `ranged_strength` vs defender `strength`, **no retaliation**, cannot
  capture.
- **HP & healing:** units heal +10/turn in friendly territory, +5 neutral, when not attacking.
- **Delete the primitive duel** in `military.py:180-239`; all combat routes through
  `resolve_combat`, both in player actions and AI turns.

### 3.3 City capture (the missing Domination pillar)
- Cities have **combat strength** (scales with pop, era, Walls) and their own **HP** and a
  ranged attack. You **grind city HP with ranged/siege**, then **enter the tile with a melee
  unit to capture** (never with ranged). Walls add HP tiers (Ancient/Medieval/Renaissance).
- On capture: ownership flips, population drops, buildings partially destroyed, city is
  **occupied** (extra unhappiness until you annex/raze/puppet). This makes Domination a
  multi-turn campaign per city, exactly the pacing the reference model requires.

### 3.4 War
- Declaring war costs diplomatic capital and **legitimacy** if unprovoked; wars generate **war
  weariness** (already partially present) that drains happiness over time — a natural end
  pressure. Peace deals cede cities/gold. AI evaluates war by power ratio + opinion (§5).

---

## PART 4 — THE CRUSADER-KINGS LAYER (make it load-bearing, not theater)

The audit's harshest finding: rich character objects exist but exactly **one** wire is live
(stewardship→tax). This part connects the dynasty to the map so the "CK half" actually plays.

### 4.1 Legitimacy — the political-health spine (currently nonexistent)
A per-civ `0–100` meter on `GameState`.
- **Gains:** +ruler.diplomacy/5 per turn (natural drift toward `50 + diplomacy`), wars won,
  Dynasty Works, coronations, golden ages, completing an Ambition (§4.6).
- **Losses:** −20 on each succession (decays back over ~15 turns), −15 per city lost, −10 for
  unprovoked war, high stress.
- **Reads:** city happiness (+/− up to ±3), **levy size %** (`levy = base * legitimacy/100`),
  anarchy/revolt risk (`legitimacy < 20` → revolt events + production penalty), and a small
  global yield modifier (§1.4 step 5). Legitimacy makes *the ruler's political standing* a
  resource you spend and defend.

### 4.2 Opinion ledger (defined at `simulation.py:194`, never used)
Single table `opinion[a][b] = Σ static modifiers (traits, same-faith, same-culture) + Σ timed
modifiers (recent slights/gifts, decaying) + relationship bonus (§4.4)`. **Consumers:** vassal
tax compliance, levy contribution, plot resistance (§4.3), marriage acceptance, AI diplomacy.
Wire it into the turn loop so opinions actually update and are actually read.

### 4.3 Plots / schemes (instantiated at `game.py:204`, never called)
Wire `PlotManager.process_turn` into `Game.process_turn`. Scheme types: **Murder, Sway,
Fabricate-Claim, Abduct.**
```
scheme_progress/turn = base + schemer.intrigue - target.intrigue + Σ agents.intrigue
success_chance       = clamp(50 + (schemer.intrigue - target.intrigue)*3 + agents, 5, 95)
```
Discovery raises target's opinion-hostility and can trigger war. AI rulers run schemes too (§5).

### 4.4 Relationships & stress with teeth
- **Relationship types:** Friend (+60 opinion), Rival (−60), Lover (+60), Nemesis (−90), with
  event-driven escalation. Mechanical teeth: councilor efficiency ±20%, ruler **+10 stress when a
  friend/lover dies, −35 when a nemesis dies**.
- **Stress:** already tracked with thresholds 100/200/300 but inert. Add: acting **against a
  trait** in an event adds stress; crossing a threshold fires a **mental-break event** (gain a
  coping trait: Drunkard/Reclusive/etc.) and applies **−5% to all yields** while Overwhelmed.
  Stress makes character personality a real constraint on which event choices are "free."

### 4.5 Succession = the boss fight
On ruler death (`_handle_succession`, `game.py:1298-1359`) add real consequence beyond −25
stability:
- **−20 legitimacy** (decaying), **short-reign opinion penalty** on the heir from vassals.
- **Partition** (gavelkind) already splits cities — add **sibling-rival events** and, if the heir
  is a child, **regency** (a regent's stats stand in; regency events test loyalty).
- **Dynasty end-state:** if no living dynasty member remains, that civ is **game-over** (or
  AI-absorbed). This is the CK "one more generation" hook.

### 4.6 Character ↔ map integration (the whole point of the fusion)
Wire ruler/character stats into the 4X systems:
- **Stewardship → tax/domain income** (live already).
- **Martial → levy size and the combat bonus** (formula exists; wire levy + ensure combat path
  uses it, §3.2).
- **Diplomacy → base opinion & AI-relation drift & legitimacy drift** (§4.1-4.2).
- **Learning → +% research** in the capital / empire.
- **Intrigue → scheme power & plot resistance** (§4.3).
- **Governors:** assign a courtier to a city; their skill adds that city's matching yield
  (a Steward-governor +% gold, a Learning-governor +% science). **Generals:** assign a Martial
  character to an army for the combat bonus. Characters now *sit on the map* (the Old World
  binding the reference model calls the model to copy).
- **Ambitions:** each ruler picks a goal (found N cities, win a war, build a wonder); completing
  it grants legitimacy + prestige, tying dynastic achievement to the 4X action economy.

---

## PART 5 — AI DEPTH (currently a punching bag capped at 6 cities)

- **Remove the 6-city cap** (`ai.py:158`); AI expands via the §1.2 site-evaluation until land,
  happiness, and maintenance say stop — same rules as the player.
- **Tech:** beeline toward a chosen victory/strategy (not random), respecting prereqs and
  eurekas.
- **Economy:** build settlers/workers/buildings on a priority model that reads its own
  happiness/gold/food, not fixed weights.
- **Military:** actually build an army proportional to threat, move via `resolve_combat`,
  besiege and capture cities (§3.3), sue for peace when losing.
- **Character-driven:** AI rulers have Character objects; run schemes, arrange marriages, and let
  **opinion/legitimacy** drive diplomacy (§4). Difficulty = handicaps on yields + aggression +
  scheme frequency.
- **The point:** a real opponent means there is a *race to lose*, which is what makes the
  gated victories meaningful instead of a solo speedrun.

---

## PART 6 — VICTORY DEPTH (map/civ-scaled)

- **Turn/era floors:** all victories gated by `state.min_victory_turn` (§0.2) and era (M18 +
  M18b to replace the literal 60 with the scaled value).
- **Conquest/Domination:** own **≥ 60% of all cities AND ≥ 2× the next civ** (relative → auto
  map-scales), plus hold your **original capital**; or eliminate all rivals. Requires real city
  capture (§3.3).
- **Science:** complete the Modern tree (M18) → later the multi-stage Spaceship (§2).
- **Culture:** relative **tourism vs. others' domestic culture** (Civ VI model) rather than a flat
  1000 — scales with civ count automatically. Interim: `1000 * pace` with the era gate.
- **Religion:** predominant faith in **≥ 60% of all cities** (not civs), requiring sustained
  missionary pressure.
- **Dynasty:** prestige threshold **scaled** `1500 * pace`, era-gated, and only while the dynasty
  is unbroken (§4.5).
- **Score fallback** at `turn_budget` (§0.2): weighted `score = 3*cities + 2*techs + pop +
  wonders*5 + prestige/50 + culture/50 + military_power/10`.

---

## PART 7 — THE MISSION SEQUENCE (dependency-ordered CynCo briefs)

Each mission is one Appendix-B brief (WHY + verbatim edits w/ grep-verified anchors + do-not-edit
list + ast/pytest/smoke verification + exact commit message). **M18 is authored** as the template.
Order respects data dependencies: you cannot compute yields before tiles exist, etc.

**WAVE A — Expansion & economy (the focus; makes it a game):**
- **M18 ✅** Victory turn/era gates; Science = full Modern tree; Domination = dominate-map. *(done)*
- **M18b** Replace M18's literal `MIN_VICTORY_TURN=60` and flat thresholds with the §0 scaled
  clock (`state.pace/turn_budget/min_victory_turn` computed in `Game.__init__`); add Score
  fallback at `turn_budget`.
- **M19** Tile model + map-gen: real `Tile{terrain,feature,resource,improvement,river}` tables
  in `game_data.py`; populate in map generation. *(no behavior change yet — data foundation)*
- **M20** Yield pipeline: `City.calculate_yields` reads worked tiles (§1.4) — replaces the three
  hardcoded constants. Depends on M19.
- **M21** Citizen assignment + workable radius + tile ownership/borders (§1.3, §1.7). Depends M20.
- **M22** Growth curve + housing + starvation (§1.5). Depends M20.
- **M23** Settler cost escalation + settler-consumes-pop + min-spacing + pop-1 founding (§1.2).
- **M24** Happiness/Amenities empire model + luxuries (§1.6).
- **M25** City gold maintenance + distance + bankruptcy (§1.8).
- **M26** Tall/wide tech & civic cost multipliers (§1.9).
- **M27** Buildings reworked to layered multiplicative model + maintenance (§1.10); wonders →
  ongoing effects.
- **M28** Production era cost curve + overflow + gold-purchase (§1.11).

**WAVE B — Military & war real:**
- **M29** Wire `resolve_combat` into player+AI turns; delete the `military.py` duel stub (§3.2).
- **M30** HP attrition, fortify, flanking, terrain, healing verified end-to-end (§3.2).
- **M31** City combat strength + Walls + siege + **melee capture / occupation** (§3.3).
- **M32** Strategic resources gate unit building; upgrades; obsolescence (§3.1).
- **M33** War weariness → happiness; peace deals (§3.4).

**WAVE C — CK layer load-bearing:**
- **M34** Legitimacy meter: state, sources, reads (levy/happiness/anarchy/yield) (§4.1).
- **M35** Opinion ledger wired to consumers (§4.2).
- **M36** Plots/schemes execution loop + AI schemes (§4.3).
- **M37** Stress teeth: trait-gated event costs, mental-break events, yield penalty (§4.4).
- **M38** Relationships (Friend/Rival/Lover/Nemesis) + councilor/stress effects (§4.4).
- **M39** Succession drama: legitimacy drain, sibling-rival + regency events, dynasty end-state
  (§4.5).
- **M40** Character↔map: governors, generals, Learning→research, Ambitions (§4.6).

**WAVE D — AI, tech breadth, districts (parity polish):**
- **M41** AI expansion uncapped + site evaluation (§5).
- **M42** AI tech beeline + economic priority model (§5).
- **M43** AI military + siege + peace logic; character-driven AI diplomacy (§5).
- **M44** Tech tree expansion to ~56 techs / 7 eras + cost curve (§2).
- **M45** Spaceship multi-stage Science project (§2, §6).
- **M46** Tourism-based Culture victory (§6).
- **M47** Districts + adjacency (§1.12) *(optional, Civ VI parity)*.

**Ordering rule for CynCo:** never start a mission whose §-dependencies aren't merged. Within a
wave, M-numbers are the merge order. Each brief must keep the pytest baseline green and ship its
own smoke script proving the new behavior (e.g., M20's smoke asserts two differently-sited cities
produce *different* yields; M23's smoke asserts settler #3 costs more than #1 and founding drops
pop).

---

## Appendix — the reference yardsticks (so no one re-litigates "how deep")

- Game is a **long gated accumulation**, ~0.6–0.9 × `turn_budget` to a win; nothing wins early.
- Every yield traces to **worked tiles × population × food**; no flat numbers.
- Expansion is **self-taxing**: settler cost ↑, pop −1, happiness −, maintenance ↑, tech cost ↑.
- Combat is **strength × modifiers with HP attrition**; cities are **multi-turn siege objectives**.
- Characters are **stat modifiers + map agents + a mortality/succession loop**, not flavor text.
- Every subsystem **feeds back into the numbers the player optimizes** — that feedback *is* depth.
```
