# tax-happiness-chain — author notes

## What the task exercises
Wire the taxation chain in CivKings so that, in the turn loop:
1. higher tax rate -> more gold income (already present), AND lower happiness scaled by
   how far the rate is above the neutral rate (50),
2. sustained low happiness -> lower stability,
all while respecting the existing 0-100 happiness clamp.

## Files / sites touched by the reference
- `game.py`, `Game.process_turn`, in the "2. Happiness & Stability" block
  (right after `self.happiness_system.update_city_count(len(self.cities))`,
  around line 635). Two wiring lines are added:
  - `self.happiness_system.tax_penalty = self.tax_system.happiness_penalty`
  - if `current_happiness < 50`: `self.stability_system.apply_change(-(50 - current_happiness) * 0.5)`

No changes were needed inside `tax_system.py`, `happiness_system.py`, or
`stability_system.py` — they already expose everything required:
- `TaxSystem.happiness_penalty` scales with `(tax_rate - 50) * HAPPINESS_PENALTY_RATE`
  (neutral rate = 50; penalty is 0 at/below 50).
- `TaxSystem.process_tax_income(cities)` already scales gold with `gold_multiplier`.
- `HappinessSystem.tax_penalty` is a settable property; `current_happiness`
  subtracts `int(tax_penalty)` and clamps to 0-100.
- `StabilitySystem.apply_change(amount)` clamps stability to 0-100.

## What green (03b4032) already did vs what the patch adds
GREEN already satisfies:
- (a) gold income rises with tax rate — `process_tax_income` uses `gold_multiplier`,
  which increases with the rate. This path is deterministic and event-free.
- (d) the 0-100 happiness clamp — `current_happiness` already clamps. On green the
  tax penalty is never applied so happiness simply stays at its bonus value, still
  inside the clamp.

GREEN does NOT satisfy (the genuinely-missing links the patch adds):
- (b) higher tax -> lower happiness. On green `happiness_system.tax_penalty` is never
  set from `tax_system.happiness_penalty`, so `current_happiness` is identical at
  every tax rate (100 at both 50% and 100%). The patch sets it each turn.
- (c) sustained low happiness -> lower stability. On green nothing ever lowers
  stability from happiness (stays 80 regardless). The patch erodes stability while
  happiness is below the neutral line of 50.

## Tests (4 independent, continuous scoring)
- `test_higher_tax_yields_more_gold_income` — TaxSystem.process_tax_income at 80% > 20%.
  (already green)
- `test_higher_tax_lowers_happiness` — after a seeded `process_turn`, happiness at
  100% tax < happiness at neutral 50%. (missing on green)
- `test_sustained_low_happiness_lowers_stability` — five seeded turns with a flooded
  (overextended, hence low-happiness) empire end with stability below the
  high-happiness baseline; also asserts the flooded empire is genuinely lower-happiness.
  (missing on green)
- `test_extreme_tax_respects_happiness_clamp` — extreme tax stacked on heavy
  overextension keeps happiness within 0-100. (already green; guards the reference)

## Determinism / headless
- `random.seed(0)` before each `process_turn` makes the loop deterministic; the
  HappinessSystem / StabilitySystem objects are only mutated by `update_city_count`
  and (on the reference) the two new wiring lines, so seeding fully pins the chain.
  The "Effect:"/event lines printed during a turn touch a separate legacy
  `self.happiness` dict and `self.gold`, not the HappinessSystem object, so they do
  not perturb the assertions.
- Headless: `game.py` imports no pygame/GUI at module load; tests run under
  `SDL_VIDEODRIVER=dummy`.
- Low happiness is induced through the *existing* overextension penalty (extra
  player-owned cities), not by poking private state, so the test reflects real
  gameplay state that the wiring must respond to.

## Gate scores (scratch clone, checkout 03b4032)
- GREEN: `SDL_VIDEODRIVER=dummy python -m pytest hidden_test.py -q` -> 2 passed, 2 failed (2/4).
- REFERENCE (`git apply reference_solution.patch`): 4 passed (4/4). Patch passes
  `git apply --check` from clean green.

## Assumptions
- Neutral rate = 50 (matches `TaxSystem.happiness_penalty`, which is 0 at/below 50).
- "Sustained low happiness lowers stability" is implemented as a per-turn stability
  decrease proportional to the shortfall below a happiness of 50. The tests only
  assert the *direction* (low-happiness stability strictly below a high-happiness
  baseline), so an agent's reasonable variant of the rule still scores.
