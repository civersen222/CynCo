# gold-deficit-aggregation

## Subsystem
`gold_management.py` — `GoldManagement` class.

## Function / behavior targeted
`GoldManagement.process_monthly_expenses(income)` — the monthly expense
aggregation that totals all expense sources and computes the surplus/deficit.

The asserted behavior requires real aggregation logic (not a getter):
- unit maintenance summed from per-unit lookup (`calculate_unit_maintenance`)
- tribute = conquered_cities * TRIBUTE_PER_CITY (`calculate_tribute`)
- standing bribery cost (`bribery_total`)
- `total_expenses` = maintenance + tribute + bribery
- `surplus_deficit` = income - total_expenses

Test fixture: Knight(3.0) + Archer(1.0) = 4.0 maintenance, 3 conquered
cities = 30.0 tribute, 5.0 bribery, income 100 -> total_expenses 39.0,
surplus_deficit 61.0. Fully deterministic, no randomness in the path.

## What setup.patch removes
Drops the `tribute` term from the `total_expenses` sum:

    total_expenses = unit_maintenance + tribute + self.bribery_total
  ->
    total_expenses = unit_maintenance + self.bribery_total

Tribute is still computed and reported in the breakdown dict, but it no
longer flows into total_expenses or the surplus, so the surplus is
overstated whenever conquered cities exist. With the patch the test sees
total_expenses 9.0 instead of 39.0.

## Verification gate (temp clone of pinned 03b4032, headless)
Clean (03b4032):
    1 passed in 0.02s
Patched (git apply setup.patch):
    assert 9.0 == 39.0
    FAILED hidden_test.py::test_monthly_surplus_subtracts_all_expense_sources
    1 failed in 0.04s
