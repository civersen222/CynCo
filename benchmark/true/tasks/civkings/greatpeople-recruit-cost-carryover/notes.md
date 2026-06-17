# greatpeople-recruit-cost-carryover

## Subsystem
`great_people.py` — Great Person Point (GPP) accumulation and recruitment.

## Function / behavior targeted
`GreatPeopleManager.check_recruitment(civ_name)` (great_people.py:63-76).

When a GP type's accumulated points reach its `threshold`, the method records a
recruitment AND must deduct the threshold from the civ's point pool so the
surplus carries over and the GP isn't recruited again until points climb back
above the threshold.

The hidden test seeds `Great Scientist` points at `threshold + 50` (250), then:
- asserts exactly one recruitment this turn (`["Great Scientist"]`),
- asserts the recruited entry has the right type/civ,
- asserts the point pool carries over the surplus (`== 50`, i.e. 250 - 200),
- calls `check_recruitment` a second time and asserts NO further recruitment and
  unchanged points — verifying the cost was actually paid.

This requires the real subtraction + carryover logic, not a trivial getter.

## What the patch removes
Deletes line 69, the threshold deduction:
```
-                self.points[civ_name][person_type] -= info["threshold"]
```
With it gone the GP is still recruited, but points stay at 250 forever, so the
civ re-recruits the same Great Person every check (runaway free recruitment).

## Gate result (temp clone, pinned 03b4032, SDL_VIDEODRIVER=dummy)
- Clean:   `1 passed in 0.02s`
- Patched: `1 failed in 0.04s` — `assert 250 == 50` at hidden_test.py:22
